// Codex through `codex app-server`, the JSON-RPC API the Codex apps use (protocol types:
// codex-rs/app-server-protocol/schema/typescript/v2 at rust-v0.160.1, the image's version).
//
// One app-server per person while they use it, one Codex thread per conversation. Codex's own
// sandbox (bubblewrap) cannot create namespaces inside Tandem's sandbox, so every turn runs with
// `externalSandbox`: Tandem's sandbox and egress proxy are the boundary, and Codex only decides
// what to ask the person first.
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { classifyText, fail } from "./failures";
import { JsonRpc, ProcessEnded, RpcError } from "./jsonrpc";
import {
  WORKSPACE,
  type Account,
  type Agent,
  type Answers,
  type Ask,
  type ContextView,
  type Failure,
  type McpServer,
  type Model,
  type PermissionMode,
  type Prompt,
  type ProviderId,
  type ProviderLive,
  type Sandboxes,
  type ToolView,
  type TurnEnd,
  type TurnInput,
  type TurnSink,
} from "./types";

export const MODEL_PREFIX = "codex-cli/";
/** Codex's sign-in, relative to the person's home (`cli_auth_credentials_store = "file"`). */
export const AUTH_FILE = ".codex/auth.json";
const ASKED_BY = "Codex";

/**
 * Settings every Codex process runs with, as `-c` overrides. The image bakes the same into
 * /etc/codex/config.toml; passing them here as well keeps a stock rootfs safe. Sign-in stays a
 * file in the home (a container has no keyring); plugins, apps (connectors), analytics and
 * feedback uploads are off.
 */
export const CODEX_SETTINGS = [
  'cli_auth_credentials_store="file"',
  "features.plugins=false",
  "features.apps=false",
  "analytics.enabled=false",
  "feedback.enabled=false",
];

/**
 * Who decides before Codex acts. Under `externalSandbox` Codex runs every ordinary command and
 * in-workspace edit without asking in `on-request`, and asks only before its dangerous commands
 * (`rm -f`, `git reset --hard`, …) and MCP tools that are not read-only. `untrusted` asks before
 * every command and every file change, the closest Codex comes to read-only without its own
 * sandbox. `workspace_write` is `on-request` too: Tandem's sandbox already limits writes to the
 * person's own home. `never` asks nothing (Codex still refuses its dangerous commands).
 */
export function approvalPolicy(
  mode: PermissionMode,
): "untrusted" | "on-request" | "never" {
  if (mode === "read_only") return "untrusted";
  if (mode === "full_access") return "never";
  return "on-request";
}

const SANDBOX_POLICY = { type: "externalSandbox", networkAccess: "enabled" };

/** Notifications Tandem never uses: reasoning (never shown), command output, raw items. */
const OPT_OUT = [
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/plan/delta",
  "turn/diff/updated",
  "remoteControl/status/changed",
];

// ---------------------------------------------------------------------------------------------
// MCP servers as `-c` overrides. Tokens and header values go into the process environment
// (`bearer_token_env_var`, `env_http_headers`), never onto argv where `ps` would show them.

const SERVER_NAME = /^[a-z][a-z0-9_]{0,31}$/;

/** A TOML basic string (JSON's escapes are TOML's, except that DEL must be escaped too). */
export const tomlString = (s: string) =>
  JSON.stringify(s).replace(/\u007f/g, "\\u007f");

export function mcpOverrides(servers: McpServer[]): {
  args: string[];
  env: Record<string, string>;
} {
  const args: string[] = [];
  const env: Record<string, string> = {};
  for (const s of servers) {
    if (!SERVER_NAME.test(s.name)) continue; // the gateway's names; anything else cannot be a TOML key here
    const base = `mcp_servers.${s.name}`;
    const prefix = `TANDEM_MCP_${s.name.toUpperCase()}`;
    args.push("-c", `${base}.url=${tomlString(s.url)}`);
    const headers: Record<string, string> = {};
    let bearer = false;
    Object.entries(s.headers).forEach(([name, value], i) => {
      const token = /^authorization$/i.test(name)
        ? /^Bearer\s+(\S+)$/i.exec(value)?.[1]
        : undefined;
      if (token && !bearer) {
        bearer = true;
        env[`${prefix}_TOKEN`] = token;
        args.push("-c", `${base}.bearer_token_env_var="${prefix}_TOKEN"`);
      } else {
        env[`${prefix}_H${i}`] = value;
        headers[name] = `${prefix}_H${i}`;
      }
    });
    if (Object.keys(headers).length)
      args.push(
        "-c",
        `${base}.env_http_headers={ ${Object.entries(headers)
          .map(([k, v]) => `${tomlString(k)} = "${v}"`)
          .join(", ")} }`,
      );
    if (s.enabledTools)
      args.push(
        "-c",
        `${base}.enabled_tools=[${s.enabledTools.map(tomlString).join(", ")}]`,
      );
  }
  return { args, env };
}

/** The server set as one string, to see whether a running app-server has the right one. */
const mcpKey = (servers: McpServer[]) =>
  JSON.stringify(
    [...servers]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => [
        s.name,
        s.url,
        s.enabledTools,
        Object.entries(s.headers).sort(),
      ]),
  );

// ---------------------------------------------------------------------------------------------
// What Codex reports, in Tandem's terms.

export const codexModel = (id: string) =>
  id.startsWith(MODEL_PREFIX) ? id.slice(MODEL_PREFIX.length) : id;

/**
 * Where Codex compacts automatically. It reports the usable window (95 % of the model's context
 * window, `effective_context_window_percent`) and compacts at 90 % of the full window
 * (`ModelInfo::auto_compact_token_limit`; the 0.160.1 catalog sets no lower per-model limit).
 */
export const autoCompactLimit = (modelContextWindow: number) =>
  Math.floor((modelContextWindow * 90) / 95);

const PLANS: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  promax: "Pro Max",
  team: "Team",
  business: "Business",
  self_serve_business_prolite: "Business",
  self_serve_business_usage_based: "Business",
  enterprise: "Enterprise",
  ent26: "Enterprise",
  enterprise_cbp_automation: "Enterprise",
  enterprise_cbp_usage_based: "Enterprise",
  edu: "Edu",
  edu_plus: "Edu Plus",
  edu_pro: "Edu Pro",
};

export function accountOf(read: any): {
  signedIn: boolean;
  account: Account | null;
} {
  const a = read?.account;
  if (a?.type === "chatgpt")
    return {
      signedIn: true,
      account: { email: a.email ?? null, plan: PLANS[a.planType] ?? null },
    };
  if (a?.type === "apiKey")
    return { signedIn: true, account: { email: null, plan: "API key" } };
  // A provider that needs no OpenAI sign-in (only a custom model provider does) counts as signed in.
  return { signedIn: !!a || read?.requiresOpenaiAuth === false, account: null };
}

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

/**
 * The reset time in Codex's usage-limit text ("… try again at Jan 1st, 2030 1:00 AM." or "Try
 * again at 4:05 PM."), which it writes in local time: Codex runs with TZ=UTC, so this is UTC.
 */
export function resetFromText(text: string, now = Date.now()): Date | null {
  const m =
    /try again at (?:([A-Za-z]{3}) (\d{1,2})(?:st|nd|rd|th)?, (\d{4}) )?(\d{1,2}):(\d{2}) ?([AP]M)/i.exec(
      text,
    );
  if (!m) return null;
  let hour = Number(m[4]) % 12;
  if (m[6]!.toUpperCase() === "PM") hour += 12;
  const today = new Date(now);
  if (m[1]) {
    const month = MONTHS.indexOf(m[1].toLowerCase());
    if (month < 0) return null;
    return new Date(
      Date.UTC(Number(m[3]), month, Number(m[2]), hour, Number(m[5])),
    );
  }
  let at = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
    hour,
    Number(m[5]),
  );
  if (at < now) at += 24 * 3600_000; // a time of day that already passed today is tomorrow's
  return new Date(at);
}

type Windows = { primary: any; secondary: any };

/** The latest reset among the exhausted rate-limit windows, from `account/rateLimits/updated`. */
export function resetFromLimits(limits: Windows | null): Date | null {
  const resets = [limits?.primary, limits?.secondary]
    .filter((w) => w && w.usedPercent >= 100 && typeof w.resetsAt === "number")
    .map((w) => w.resetsAt as number);
  return resets.length ? new Date(Math.max(...resets) * 1000) : null;
}

const statusOf = (info: any): number | null => {
  if (!info || typeof info !== "object") return null;
  const inner: any = Object.values(info)[0];
  return typeof inner?.httpStatusCode === "number"
    ? inner.httpStatusCode
    : null;
};

/** A failed turn's `error` (`TurnError`) as a Failure: its `codexErrorInfo` first, then its text. */
export function failureOf(
  error: any,
  model: string | null,
  limits: Windows | null = null,
  provider: ProviderId = "codex",
): Failure {
  const info = error?.codexErrorInfo ?? null;
  const message: string =
    typeof error?.message === "string" ? error.message : "";
  const kind = typeof info === "string" ? info : info && Object.keys(info)[0];
  const status = statusOf(info);
  switch (kind) {
    case "unauthorized":
      return fail.signinRequired(provider);
    case "usageLimitExceeded":
      // Codex's own text, written for people (plan, upgrade link, reset time).
      return fail.usageLimit(
        provider,
        resetFromLimits(limits) ?? resetFromText(message),
        message,
      );
    case "rateLimitExceeded":
      return fail.rateLimited(provider);
    case "contextWindowExceeded":
      return fail.contextTooLong(model);
    case "serverOverloaded":
    case "internalServerError":
    case "flexUnavailable":
      return fail.providerUnavailable(provider, message);
    case "httpConnectionFailed":
    case "responseStreamConnectionFailed":
    case "responseStreamDisconnected":
    case "responseTooManyFailedAttempts":
      if (status === 401) return fail.signinRequired(provider);
      if (status === 429) return fail.rateLimited(provider);
      if (status !== null && status >= 500)
        return fail.providerUnavailable(provider);
      if (status === null) return fail.network(provider);
      break;
  }
  return classifyText(provider, message, model);
}

/** Codex's tools by the names it gives them; MCP tools as `mcp__<server>__<tool>`. */
export function toolOf(item: any): ToolView | null {
  const name =
    item.type === "commandExecution"
      ? "exec_command"
      : item.type === "fileChange"
        ? "apply_patch"
        : item.type === "mcpToolCall"
          ? `mcp__${item.server}__${item.tool}`
          : item.type === "webSearch"
            ? "web_search"
            : item.type === "imageView"
              ? "view_image"
              : item.type === "imageGeneration"
                ? "image_generation"
                : item.type === "dynamicToolCall" ||
                    item.type === "collabAgentToolCall"
                  ? String(item.tool ?? item.type)
                  : null;
  if (!name || typeof item.id !== "string") return null;
  const s = String(item.status ?? "");
  const status =
    s === "inProgress" || s === "running"
      ? "running"
      : s === "failed" ||
          s === "declined" ||
          item.error ||
          item.success === false
        ? "failed"
        : "completed";
  return { id: item.id, name, status };
}

// ---------------------------------------------------------------------------------------------
// Questions. Permission questions follow types.ts: header = the tool, "Allow <what>?", and
// "Allow once" / "Allow always" (where Codex offers it) / "Deny".

export const ALLOW_ONCE = "Allow once";
export const ALLOW_ALWAYS = "Allow always";
export const DENY = "Deny";
const PERMISSION = "permission";

const clip = (s: string, n = 400) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

function permission(
  askedBy: string | null,
  header: string,
  question: string,
  context: string | null,
  always: boolean,
): Ask {
  return {
    kind: "permission",
    askedBy,
    context,
    prompts: [
      {
        id: PERMISSION,
        header,
        question,
        multiSelect: false,
        options: [
          { label: ALLOW_ONCE, description: null },
          ...(always ? [{ label: ALLOW_ALWAYS, description: null }] : []),
          { label: DENY, description: null },
        ],
      },
    ],
  };
}

/** The label chosen for a permission question; null when nobody answered. */
const chosen = (answers: Answers | null) =>
  answers ? (answers[PERMISSION]?.[0] ?? DENY) : null;

/** How Tandem asks about one server request (null: answered without asking), and answers Codex. */
export type Question = {
  ask: Ask | null;
  answer(answers: Answers | null): unknown;
};

/** The command a person reads: Codex's parsed actions, without the `/bin/sh -lc '…'` wrapper. */
const commandText = (p: any) =>
  Array.isArray(p.commandActions) && p.commandActions.length
    ? p.commandActions.map((a: any) => String(a.command ?? "")).join(" && ")
    : String(p.command ?? "").replace(/^\S*\/(?:ba|z)?sh -l?c '(.*)'$/s, "$1");

export function commandQuestion(p: any): Question {
  const decisions: any[] = Array.isArray(p.availableDecisions)
    ? p.availableDecisions
    : [];
  // Allow always: for this session where Codex offers it, else its exec-policy rule for the command.
  const always =
    decisions.find((d) => d === "acceptForSession") ??
    decisions.find(
      (d) => d && typeof d === "object" && "acceptWithExecpolicyAmendment" in d,
    );
  return {
    ask: permission(
      ASKED_BY,
      "exec_command",
      `Allow running \`${clip(commandText(p))}\`?`,
      p.reason ?? null,
      always !== undefined,
    ),
    answer: (answers) => {
      const c = chosen(answers);
      return {
        decision:
          c === null
            ? "cancel"
            : c === ALLOW_ONCE
              ? "accept"
              : c === ALLOW_ALWAYS && always !== undefined
                ? always
                : "decline",
      };
    },
  };
}

export function fileChangeQuestion(p: any, paths: string[]): Question {
  return {
    ask: permission(
      ASKED_BY,
      "apply_patch",
      paths.length
        ? `Allow editing ${clip(paths.join(", "))}?`
        : "Allow editing files?",
      p.reason ?? null,
      true,
    ),
    answer: (answers) => {
      const c = chosen(answers);
      return {
        decision:
          c === null
            ? "cancel"
            : c === ALLOW_ONCE
              ? "accept"
              : c === ALLOW_ALWAYS
                ? "acceptForSession"
                : "decline",
      };
    },
  };
}

const display = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/**
 * `mcpServer/elicitation/request`: Codex's own approval of an MCP tool call
 * (`_meta.codex_approval_kind = "mcp_tool_call"`), or a question the MCP server itself asks.
 */
export function elicitationQuestion(
  p: any,
  runningTool: string | null,
): Question {
  const meta = p._meta && typeof p._meta === "object" ? p._meta : {};
  const server = String(p.serverName ?? "mcp");
  const decline = { action: "decline", content: null, _meta: null };
  const cancel = { action: "cancel", content: null, _meta: null };
  if (meta.codex_approval_kind === "mcp_tool_call") {
    const tool = /run tool "([^"]+)"/.exec(String(p.message ?? ""))?.[1];
    const persist = [meta.persist].flat();
    const params = Array.isArray(meta.tool_params_display)
      ? meta.tool_params_display
          .map((x: any) => `${x.display_name ?? x.name}: ${display(x.value)}`)
          .join("\n")
      : meta.tool_params
        ? display(meta.tool_params)
        : null;
    return {
      ask: permission(
        ASKED_BY,
        tool ? `mcp__${server}__${tool}` : `mcp__${server}`,
        String(p.message || `Allow the ${server} MCP server to run a tool?`),
        params ? clip(params, 2000) : null,
        persist.includes("session"),
      ),
      answer: (answers) => {
        const c = chosen(answers);
        if (c === null) return cancel;
        if (c === ALLOW_ONCE)
          return { action: "accept", content: {}, _meta: null };
        if (c === ALLOW_ALWAYS && persist.includes("session"))
          return {
            action: "accept",
            content: {},
            _meta: { persist: "session" },
          };
        return decline;
      },
    };
  }
  // A link to open (an OAuth page, say) cannot be shown here: decline it.
  if (p.mode !== "form") return { ask: null, answer: () => decline };
  const props: [string, any][] = Object.entries(
    p.requestedSchema?.properties ?? {},
  );
  const message = String(p.message ?? "");
  if (!props.length)
    // A confirmation without fields: the server's own yes or no, asked like a permission.
    return {
      ask: permission(
        server,
        runningTool ?? server,
        message || "Allow this?",
        null,
        false,
      ),
      answer: (answers) => {
        const c = chosen(answers);
        return c === null
          ? cancel
          : c === ALLOW_ONCE
            ? { action: "accept", content: {}, _meta: null }
            : decline;
      },
    };
  const fields = props.map(([key, s]) => elicitationField(key, s ?? {}));
  return {
    ask: {
      kind: "question",
      askedBy: server,
      context: message || null,
      prompts: fields.map((f) => f.prompt),
    },
    answer: (answers) => {
      if (!answers) return cancel;
      const content: Record<string, unknown> = {};
      for (const f of fields) {
        const v = f.value(answers[f.prompt.id] ?? []);
        if (v !== undefined) content[f.prompt.id] = v;
      }
      return { action: "accept", content, _meta: null };
    },
  };
}

/** One field of an MCP form as a prompt, and its answer back in the field's type. */
function elicitationField(
  key: string,
  s: any,
): { prompt: Prompt; value(a: string[]): unknown } {
  const header = typeof s.title === "string" ? s.title : key;
  const question = typeof s.description === "string" ? s.description : header;
  const prompt = (
    multiSelect: boolean,
    options: { label: string; value: unknown; description?: string }[],
  ) => ({
    prompt: {
      id: key,
      header,
      question,
      multiSelect,
      options: options.map((o) => ({
        label: o.label,
        description: o.description ?? null,
      })),
    },
    value: (a: string[]) => {
      const values = a
        .map((l) => options.find((o) => o.label === l)?.value)
        .filter((v) => v !== undefined);
      return multiSelect ? values : values[0];
    },
  });
  const choices = (list: any[], names?: any[]) =>
    list.map((o, i) =>
      typeof o === "object" && o
        ? { label: String(o.title ?? o.const), value: o.const }
        : { label: String(names?.[i] ?? o), value: o },
    );
  if (Array.isArray(s.oneOf)) return prompt(false, choices(s.oneOf));
  if (Array.isArray(s.enum)) return prompt(false, choices(s.enum, s.enumNames));
  if (s.type === "array" && Array.isArray(s.items?.anyOf))
    return prompt(true, choices(s.items.anyOf));
  if (s.type === "array" && Array.isArray(s.items?.enum))
    return prompt(true, choices(s.items.enum));
  if (s.type === "boolean")
    return prompt(false, [
      { label: "Yes", value: true },
      { label: "No", value: false },
    ]);
  // Free text; a number field takes the number written.
  return {
    prompt: { id: key, header, question, multiSelect: false, options: [] },
    value: (a: string[]) => {
      const text = a.join(" ").trim();
      if (!text) return undefined;
      if (s.type === "number" || s.type === "integer") {
        const n = Number(text);
        return Number.isFinite(n) ? n : undefined;
      }
      return text;
    },
  };
}

/** Codex's own `request_user_input` tool (its questions keep Codex's ids and labels). */
export function userInputQuestion(p: any): Question {
  const questions: any[] = Array.isArray(p.questions) ? p.questions : [];
  return {
    ask: {
      kind: "question",
      askedBy: ASKED_BY,
      context: null,
      prompts: questions.map((q) => ({
        id: String(q.id),
        header: q.header ?? null,
        question: String(q.question ?? ""),
        multiSelect: false,
        options: (q.options ?? []).map((o: any) => ({
          label: String(o.label),
          description: o.description ?? null,
        })),
      })),
    },
    answer: (answers) => ({
      answers: Object.fromEntries(
        questions.map((q) => [q.id, { answers: answers?.[q.id] ?? [] }]),
      ),
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// The agent.

type Run = {
  threadId: string;
  turnId: string | null;
  sink: TurnSink;
  model: string;
  /** Agent message texts of this turn, in order; the turn is one façade message. */
  parts: Map<string, string>;
  /** File changes Codex announced, by item id (their paths, for an approval). */
  files: Map<string, string[]>;
  /** The MCP tool each server is running, for a question that server asks mid-call. */
  mcpTools: Map<string, string>;
  abort: boolean;
  ended: Promise<void>;
  end(): void;
  completed: Promise<any>;
  complete(turn: any): void;
};

type Server = {
  key: string;
  rpc: JsonRpc;
  mcp: string;
  /** Threads loaded in this process (started or resumed). */
  threads: Set<string>;
  /** Running turns by thread id. */
  runs: Map<string, Run>;
  /** Sub-agent thread -> the thread that started it, so their questions reach that turn. */
  parents: Map<string, string>;
  limits: Windows;
  /** Turns and reads using it; the idle timer runs only at 0. */
  users: number;
  idle: ReturnType<typeof setTimeout> | null;
  stopping: boolean;
};

export type CodexAgentOptions = {
  /** How long a person's app-server stays after its last turn or read (default 2 min). */
  idleMs?: number;
  /** The program inside the sandbox (default `codex`, on PATH in the rootfs). */
  command?: string;
  /** More `-c` overrides after Tandem's own (tests: a scripted model provider). */
  config?: string[];
  /** More environment for the app-server (tests). */
  env?: Record<string, string>;
  /** The chat workspace inside the sandbox (default WORKSPACE; tests without a sandbox). */
  workspace?: string;
  log?: (line: string) => void;
};

export class CodexAgent implements Agent {
  readonly providers = ["codex"] as const;
  #servers = new Map<string, Server>();
  #locks = new Map<string, Promise<unknown>>();
  /** Each person's latest MCP servers, so a read starts the app-server a turn will want. */
  #mcp = new Map<string, McpServer[]>();
  /** Where each model compacts, as measured in a turn (model/list does not say). */
  #limits = new Map<string, number>();
  readonly #idleMs: number;
  readonly #workspace: string;

  constructor(
    private sandboxes: Sandboxes,
    private opts: CodexAgentOptions = {},
  ) {
    this.#idleMs = opts.idleMs ?? 2 * 60_000;
    this.#workspace = opts.workspace ?? WORKSPACE;
  }

  #log(line: string) {
    this.opts.log?.(`[codex] ${line}`);
  }

  busy(key: string) {
    return this.#servers.has(key);
  }

  /** Whether the person's home holds a Codex sign-in (never reads it: the home is theirs). */
  signedInFile(key: string) {
    try {
      return lstatSync(join(this.sandboxes.homeOf(key), AUTH_FILE)).isFile();
    } catch {
      return false;
    }
  }

  async release(key: string) {
    const s = this.#servers.get(key);
    if (s) await this.#stop(s);
  }

  async read(key: string, _provider: ProviderId): Promise<ProviderLive> {
    if (!this.signedInFile(key))
      return { signedIn: false, account: null, models: [] };
    const s = await this.#acquire(key, null);
    try {
      const { signedIn, account } = accountOf(
        await s.rpc.request("account/read", { refreshToken: false }, 30_000),
      );
      if (!signedIn) return { signedIn, account: null, models: [] };
      let models: Model[] = [];
      try {
        models = await this.#models(s.rpc);
      } catch (e: any) {
        this.#log(`model/list failed: ${e?.message ?? e}`);
      }
      return { signedIn, account, models };
    } finally {
      this.#releaseUse(s);
    }
  }

  async #models(rpc: JsonRpc): Promise<Model[]> {
    const out: Model[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const res: any = await rpc.request(
        "model/list",
        cursor ? { cursor } : {},
        30_000,
      );
      for (const m of res?.data ?? []) {
        if (m.hidden) continue;
        out.push({
          id: MODEL_PREFIX + m.model,
          name: m.displayName || null,
          efforts: (m.supportedReasoningEfforts ?? []).map(
            (e: any) => e.reasoningEffort,
          ),
          defaultEffort: m.defaultReasoningEffort ?? null,
          contextLimit: this.#limits.get(m.model) ?? null,
        });
      }
      cursor = res?.nextCursor ?? null;
      if (!cursor) break;
    }
    return out;
  }

  async turn(
    key: string,
    input: TurnInput,
    sink: TurnSink,
    signal: AbortSignal,
  ): Promise<TurnEnd> {
    if (signal.aborted) return { status: "aborted" };
    this.#mcp.set(key, input.mcpServers);
    const model = codexModel(input.model);
    let s: Server;
    try {
      s = await this.#acquire(key, input.mcpServers);
    } catch (e: any) {
      this.#log(`app-server did not start: ${e?.message ?? e}`);
      return { status: "failed", failure: fail.failed() };
    }
    let run: Run | null = null;
    const onAbort = () => {
      if (!run || run.abort) return;
      run.abort = true;
      void this.#interrupt(s, run);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const threadId = await this.#thread(s, input, model);
      sink.session(threadId);
      run = newRun(threadId, sink, model);
      s.runs.set(threadId, run);
      if (signal.aborted) return { status: "aborted" };
      const effort = input.effort ?? undefined;
      const started: any = await s.rpc.request(
        "turn/start",
        {
          threadId,
          input: [{ type: "text", text: input.text, text_elements: [] }],
          cwd: this.#workspace,
          approvalPolicy: approvalPolicy(input.permissionMode),
          approvalsReviewer: "user",
          sandboxPolicy: SANDBOX_POLICY,
          model,
          ...(effort ? { effort } : {}),
        },
        60_000,
      );
      run.turnId ??= started?.turn?.id ?? null;
      if (signal.aborted) onAbort(); // aborted before the turn had an id
      const turn = await Promise.race([
        run.completed,
        s.rpc.exited.then(() => null),
      ]);
      if (run.abort || s.stopping) return { status: "aborted" };
      if (!turn) {
        this.#log(`app-server ended mid-turn: ${s.rpc.stderr.slice(-500)}`);
        return { status: "failed", failure: fail.failed() };
      }
      if (turn.status === "completed") return { status: "completed" };
      if (turn.status === "interrupted" && !turn.error?.codexErrorInfo)
        return { status: "aborted" };
      return {
        status: "failed",
        failure: failureOf(turn.error, MODEL_PREFIX + model, s.limits),
      };
    } catch (e: any) {
      if (signal.aborted || s.stopping) return { status: "aborted" };
      this.#log(`turn failed: ${e?.message ?? e}`);
      if (e instanceof RpcError)
        return {
          status: "failed",
          failure: classifyText("codex", e.message, MODEL_PREFIX + model),
        };
      return { status: "failed", failure: fail.failed() };
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (run) {
        if (s.runs.get(run.threadId) === run) s.runs.delete(run.threadId);
        run.end();
      }
      this.#releaseUse(s);
    }
  }

  /** The conversation's thread in this process: already loaded, resumed, or new. */
  async #thread(s: Server, input: TurnInput, model: string): Promise<string> {
    const approval = approvalPolicy(input.permissionMode);
    if (input.session && s.threads.has(input.session)) return input.session;
    if (input.session) {
      try {
        const r: any = await s.rpc.request(
          "thread/resume",
          {
            threadId: input.session,
            cwd: this.#workspace,
            approvalPolicy: approval,
            excludeTurns: true,
          },
          60_000,
        );
        s.threads.add(r.thread.id);
        return r.thread.id;
      } catch (e) {
        // A thread Codex no longer has (its home was reset): the conversation goes on in a new one.
        if (
          !(e instanceof RpcError) ||
          !/no rollout|not found|no thread|does not exist/i.test(e.message)
        )
          throw e;
        this.#log(
          `thread ${input.session} is gone (${e.message}); starting a new one`,
        );
      }
    }
    const r: any = await s.rpc.request(
      "thread/start",
      { cwd: this.#workspace, model, approvalPolicy: approval },
      60_000,
    );
    s.threads.add(r.thread.id);
    return r.thread.id;
  }

  async #interrupt(s: Server, run: Run) {
    // The turn id comes with turn/start's answer; an abort before it waits for it.
    for (let i = 0; !run.turnId && i < 100 && !s.rpc.ended; i++)
      await Bun.sleep(50);
    if (run.turnId)
      await s.rpc
        .request(
          "turn/interrupt",
          { threadId: run.threadId, turnId: run.turnId },
          15_000,
        )
        .catch(() => {});
    // Codex ends an interrupted turn at once; one that does not is ended with its process.
    const done = await Promise.race([
      run.completed.then(() => true),
      Bun.sleep(15_000).then(() => false),
    ]);
    if (!done) await this.#stop(s);
  }

  // -------------------------------------------------------------------------------------------
  // Processes

  /** Serialises starting and restarting a person's app-server. */
  async #locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.#locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.#locks.get(key) === next) this.#locks.delete(key);
    }
  }

  /**
   * The person's app-server, started if needed and marked in use. `mcp` null (a read) takes any
   * running one; a turn whose MCP servers differ restarts it once the other turns have ended.
   */
  #acquire(key: string, mcp: McpServer[] | null): Promise<Server> {
    return this.#locked(key, async () => {
      let s = this.#servers.get(key);
      if (s?.rpc.ended) s = undefined;
      const want = mcpKey(mcp ?? this.#mcp.get(key) ?? []);
      if (s && mcp && s.mcp !== want) {
        while (s.runs.size)
          await Promise.race([...s.runs.values()].map((r) => r.ended));
        await this.#stop(s);
        s = undefined;
      }
      if (!s) s = await this.#start(key, mcp ?? this.#mcp.get(key) ?? []);
      s.users++;
      if (s.idle) clearTimeout(s.idle);
      s.idle = null;
      return s;
    });
  }

  #releaseUse(s: Server) {
    s.users = Math.max(0, s.users - 1);
    if (s.users || s.stopping || this.#servers.get(s.key) !== s) return;
    if (s.idle) clearTimeout(s.idle);
    s.idle = setTimeout(() => void this.#stop(s), this.#idleMs);
  }

  async #start(key: string, mcp: McpServer[]): Promise<Server> {
    const { args, env } = mcpOverrides(mcp);
    const child = await this.sandboxes.spawn(
      key,
      [
        this.opts.command ?? "codex",
        "app-server",
        ...CODEX_SETTINGS.flatMap((c) => ["-c", c]),
        ...args,
        ...(this.opts.config ?? []).flatMap((c) => ["-c", c]),
      ],
      {
        // TZ=UTC: Codex words a usage limit's reset in local time (see resetFromText).
        env: { TZ: "UTC", RUST_LOG: "warn", ...env, ...this.opts.env },
        label: "codex",
      },
    );
    const rpc = new JsonRpc(child);
    const s: Server = {
      key,
      rpc,
      mcp: mcpKey(mcp),
      threads: new Set(),
      runs: new Map(),
      parents: new Map(),
      limits: { primary: null, secondary: null },
      users: 0,
      idle: null,
      stopping: false,
    };
    this.#servers.set(key, s);
    void rpc.exited.then(() => {
      if (this.#servers.get(key) === s) this.#servers.delete(key);
      if (s.idle) clearTimeout(s.idle);
      if (!s.stopping && s.runs.size === 0)
        this.#log(`app-server for ${key} exited: ${rpc.stderr.slice(-300)}`);
    });
    this.#wire(s);
    try {
      await rpc.request(
        "initialize",
        {
          clientInfo: { name: "tandem", title: "Tandem", version: "1" },
          capabilities: {
            experimentalApi: false,
            requestAttestation: false,
            optOutNotificationMethods: OPT_OUT,
          },
        },
        60_000,
      );
      rpc.notify("initialized");
    } catch (e) {
      await this.#stop(s);
      throw e instanceof ProcessEnded
        ? new Error(`codex app-server ended: ${rpc.stderr.slice(-500)}`)
        : e;
    }
    return s;
  }

  async #stop(s: Server) {
    s.stopping = true;
    if (s.idle) clearTimeout(s.idle);
    if (this.#servers.get(s.key) === s) this.#servers.delete(s.key);
    await s.rpc.close();
  }

  // -------------------------------------------------------------------------------------------
  // Notifications and requests

  /** The running turn a thread's request belongs to: its own, its parent's, or the only one. */
  #route(s: Server, threadId: unknown): Run | null {
    let id = typeof threadId === "string" ? threadId : "";
    for (
      let depth = 0;
      depth < 16 && !s.runs.has(id) && s.parents.has(id);
      depth++
    )
      id = s.parents.get(id)!;
    const run = s.runs.get(id);
    if (run) return run;
    return s.runs.size === 1 ? [...s.runs.values()][0]! : null;
  }

  async #ask(s: Server, threadId: unknown, build: (run: Run) => Question) {
    const run = this.#route(s, threadId);
    if (!run) return build(newRun("", NO_SINK, "")).answer(null);
    const q = build(run);
    if (!q.ask) return q.answer(null);
    // Unanswered when the turn ends: Codex is told no (cancel) instead of waiting forever.
    const answers = await Promise.race([
      run.sink.ask(q.ask).catch(() => null),
      run.ended.then(() => null),
    ]);
    return q.answer(answers);
  }

  #wire(s: Server) {
    const { rpc } = s;
    rpc.handle("item/commandExecution/requestApproval", (p) =>
      this.#ask(s, p?.threadId, () => commandQuestion(p)),
    );
    rpc.handle("item/fileChange/requestApproval", (p) =>
      this.#ask(s, p?.threadId, (run) =>
        fileChangeQuestion(p, run.files.get(p?.itemId) ?? []),
      ),
    );
    rpc.handle("mcpServer/elicitation/request", (p) =>
      this.#ask(s, p?.threadId, (run) =>
        elicitationQuestion(p, run.mcpTools.get(p?.serverName) ?? null),
      ),
    );
    rpc.handle("item/tool/requestUserInput", (p) =>
      this.#ask(s, p?.threadId, () => userInputQuestion(p)),
    );
    // More sandbox access cannot be granted inside Tandem's sandbox: nothing to ask about.
    rpc.handle("item/permissions/requestApproval", () => ({
      permissions: {},
      scope: "turn",
    }));
    rpc.onNotification((method, p) => this.#note(s, method, p ?? {}));
  }

  #note(s: Server, method: string, p: any) {
    if (method === "account/rateLimits/updated") {
      // Sparse updates: a missing window keeps the last one seen.
      const r = p.rateLimits ?? {};
      if (r.primary) s.limits.primary = r.primary;
      if (r.secondary) s.limits.secondary = r.secondary;
      return;
    }
    const threadId = p.threadId ?? p.thread?.id;
    const item = p.item;
    // Remember which thread started a sub-agent's thread.
    if (typeof threadId === "string" && item) {
      if (
        item.type === "subAgentActivity" &&
        typeof item.agentThreadId === "string"
      )
        s.parents.set(item.agentThreadId, threadId);
      if (item.type === "collabAgentToolCall")
        for (const t of item.receiverThreadIds ?? [])
          s.parents.set(t, threadId);
      if (s.parents.size > 1000)
        s.parents.delete(s.parents.keys().next().value!);
    }
    // A sub-agent's own messages and tools stay inside the call that started it.
    const run = typeof threadId === "string" ? s.runs.get(threadId) : undefined;
    if (!run) return;
    const turnId: string | null = p.turnId ?? p.turn?.id ?? null;
    if (run.turnId && turnId && turnId !== run.turnId) return; // a previous turn's late news
    switch (method) {
      case "turn/started":
        run.turnId ??= turnId;
        return;
      case "item/agentMessage/delta": {
        const id = String(p.itemId);
        const key = turnId ?? run.threadId;
        if (!run.parts.has(id)) {
          if ([...run.parts.values()].some(Boolean))
            run.sink.delta(key, "\n\n");
          run.parts.set(id, "");
        }
        run.parts.set(id, run.parts.get(id)! + String(p.delta ?? ""));
        run.sink.delta(key, String(p.delta ?? ""));
        return;
      }
      case "item/started":
      case "item/completed": {
        if (!item) return;
        const key = turnId ?? run.threadId;
        if (item.type === "agentMessage") {
          if (method === "item/completed" || item.text) {
            run.parts.set(String(item.id), String(item.text ?? ""));
            run.sink.text(
              key,
              [...run.parts.values()].filter(Boolean).join("\n\n"),
            );
          }
          return;
        }
        if (item.type === "fileChange")
          run.files.set(
            item.id,
            (item.changes ?? []).map((c: any) => String(c.path)),
          );
        if (item.type === "mcpToolCall") {
          if (method === "item/started")
            run.mcpTools.set(
              String(item.server),
              `mcp__${item.server}__${item.tool}`,
            );
          else run.mcpTools.delete(String(item.server));
        }
        if (item.type === "contextCompaction" && method === "item/completed") {
          run.sink.context(null);
          return;
        }
        const tool = toolOf(item);
        if (tool)
          run.sink.tool(
            key,
            method === "item/started" ? { ...tool, status: "running" } : tool,
          );
        return;
      }
      case "thread/compacted":
        run.sink.context(null);
        return;
      case "thread/tokenUsage/updated": {
        const u = p.tokenUsage ?? {};
        const total = u.total ?? {};
        const n = (v: unknown) => (typeof v === "number" && v > 0 ? v : 0);
        if (
          typeof u.modelContextWindow === "number" &&
          u.modelContextWindow > 0
        ) {
          const limit = autoCompactLimit(u.modelContextWindow);
          this.#limits.set(run.model, limit);
          const context: ContextView = {
            usedTokens: n(u.last?.totalTokens),
            limitTokens: limit,
            approximate: false,
          };
          run.sink.context(context);
        }
        // Codex counts cached input inside input; Tandem's input is the uncached part.
        run.sink.usage({
          input: Math.max(0, n(total.inputTokens) - n(total.cachedInputTokens)),
          output: n(total.outputTokens),
          cacheRead: n(total.cachedInputTokens),
          cacheWrite: n(total.cacheWriteInputTokens),
        });
        return;
      }
      case "turn/completed":
        run.complete(p.turn ?? {});
        return;
    }
  }
}

const NO_SINK: TurnSink = {
  session() {},
  delta() {},
  text() {},
  tool() {},
  ask: async () => null,
  context() {},
  usage() {},
};

function newRun(threadId: string, sink: TurnSink, model: string): Run {
  let end!: () => void;
  let complete!: (t: any) => void;
  const ended = new Promise<void>((r) => (end = r));
  const completed = new Promise<any>((r) => (complete = r));
  return {
    threadId,
    turnId: null,
    sink,
    model,
    parts: new Map(),
    files: new Map(),
    mcpTools: new Map(),
    abort: false,
    ended,
    end,
    completed,
    complete,
  };
}
