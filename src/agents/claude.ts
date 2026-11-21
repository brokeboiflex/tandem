// Claude Code through the Claude Agent SDK. The SDK runs in the gateway; Claude Code itself runs in
// the person's sandbox (`spawnClaudeCodeProcess`). One streaming-input query per conversation is
// kept while it is in use and for `idleMs` after its last turn; a later turn resumes the session.
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  query,
  type AccountInfo,
  type CanUseTool,
  type ModelInfo,
  type OnElicitation,
  type Options,
  type PermissionMode as SdkPermissionMode,
  type PermissionResult,
  type Query,
  type SDKAssistantMessageError,
  type SDKControlGetContextUsageResponse,
  type SDKControlInitializeResponse,
  type SDKMessage,
  type SDKRateLimitInfo,
  type SDKResultMessage,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { classifyText, fail } from "./failures";
import {
  WORKSPACE,
  type Account,
  type Agent,
  type Answers,
  type ApiKeys,
  type Ask,
  type ContextView,
  type Failure,
  type KeyVerdict,
  type McpServer,
  type Model,
  type PermissionMode,
  type ProviderId,
  type ProviderLive,
  type Sandboxes,
  type TurnEnd,
  type TurnInput,
  type TurnSink,
  type UsageView,
  type VerifiesApiKeys,
} from "./types";

/** Claude Code in the rootfs. Never the SDK's bundled copy (it is not installed). */
export const CLAUDE_EXECUTABLE = "/usr/local/bin/claude";
/** Where Claude Code keeps a subscription sign-in (Linux), relative to the person's home. */
export const CREDENTIALS_FILE = ".claude/.credentials.json";
const PROVIDER: ProviderId = "claude";
const ASKED_BY = "Claude Code";
const IDLE_MS = 2 * 60_000;
/** Claude Code retries a refused sign-in (it may be renewing it); this many refusals settle it. */
const AUTH_RETRIES = 3;
/** How long an interrupted turn may take to end before its process is stopped. */
const ABORT_GRACE_MS = 10_000;
const READ_TIMEOUT_MS = 30_000;
const CONTEXT_TIMEOUT_MS = 5_000;
/** Settings for Claude Code's own process (the rest is in the rootfs's managed settings). */
const PROCESS_ENV = {
  CLAUDE_CODE_TRANSCRIPT_LOCAL_GC: "1",
  CLAUDE_CODE_PROXY_RESOLVES_HOSTS: "1",
  CLAUDE_AGENT_SDK_CLIENT_APP: "tandem",
};
/** As Happy mapped Tandem's modes; full access needs Claude Code's own bypass. */
const MODES: Record<PermissionMode, SdkPermissionMode> = {
  read_only: "plan",
  workspace_write: "acceptEdits",
  auto: "auto",
  full_access: "bypassPermissions",
};
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];
export const ALLOW = "Allow once";
export const DENY = "Deny";
const PERMISSION_PROMPT = "permission";

// ---------------------------------------------------------------------------------------------
// Pure mappings (exported for tests)

/** `claude-code/opus` → `opus`; the default is Claude Code's own choice, so no model at all. */
export function modelAlias(model: string): string | undefined {
  const alias = model.startsWith("claude-code/")
    ? model.slice("claude-code/".length)
    : model;
  return alias && alias !== "default" ? alias : undefined;
}

export function effortOf(effort: string | null): Effort | undefined {
  return EFFORTS.find((e) => e === effort);
}

/**
 * The catalog from Claude Code's own model list, named as it names them: an alias by its display
 * name, the default by the model it resolves to ("Default (recommended)" is copy, not a name).
 * Claude Code resolves each model's default effort and compaction point itself, so those stay null.
 */
export function claudeModels(models: readonly ModelInfo[]): Model[] {
  const named = models.filter(
    (m) => typeof m?.value === "string" && typeof m.displayName === "string",
  );
  const nameOf = (resolved: string | undefined) =>
    resolved === undefined
      ? null
      : (named.find(
          (m) =>
            m.value !== "default" && (m.resolvedModel ?? m.value) === resolved,
        )?.displayName ?? null);
  const seen = new Set<string>();
  return named
    .filter((m) => !seen.has(m.value) && seen.add(m.value))
    .map((m) => ({
      id: `claude-code/${m.value}`,
      name: m.value === "default" ? nameOf(m.resolvedModel) : m.displayName,
      ...(m.value === "default" ? { default: true } : {}),
      efforts:
        m.supportsEffort === false ? [] : [...(m.supportedEffortLevels ?? [])],
      defaultEffort: null,
      contextLimit: null,
    }));
}

/** "max" → "Max", "team_premium" → "Team Premium" (Happy's displayPlan). */
const displayPlan = (plan: string | undefined) =>
  plan?.trim()
    ? plan
        .trim()
        .split(/[_\s-]+/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ")
    : null;

/** Who Claude Code says is signed in: an API key wins, as it does in Claude Code. */
export function claudeAccount(info: AccountInfo | undefined): {
  signedIn: boolean;
  account: Account | null;
} {
  if (info?.apiKeySource && info.apiKeySource !== "none")
    return { signedIn: true, account: { email: null, plan: "API key" } };
  if (info?.tokenSource && info.tokenSource !== "none")
    return {
      signedIn: true,
      account: {
        email: info.email ?? null,
        plan: displayPlan(info.subscriptionType),
      },
    };
  return { signedIn: false, account: null };
}

/** The conversation's size against the point where Claude Code compacts it automatically. */
export function claudeContext(
  usage: SDKControlGetContextUsageResponse | null | undefined,
): ContextView | null {
  if (!usage || typeof usage.totalTokens !== "number") return null;
  const limit =
    usage.isAutoCompactEnabled && usage.autoCompactThreshold
      ? usage.autoCompactThreshold
      : usage.maxTokens || usage.rawMaxTokens;
  if (!limit) return null;
  return {
    usedTokens: usage.totalTokens,
    limitTokens: limit,
    approximate: !usage.apiUsage,
  };
}

/**
 * The conversation's lifetime tokens on its main model. A result's `modelUsage` is cumulative
 * over the session (a resumed session continues from its saved totals); side calls on other
 * models (titles, compaction on another model) are not mixed in.
 */
export function claudeUsage(
  modelUsage: SDKResultMessage["modelUsage"] | undefined,
  model: string | null,
): UsageView | null {
  if (!modelUsage || !model) return null;
  const u =
    modelUsage[model] ??
    Object.values(modelUsage).find((v) => v.canonicalModel === model);
  if (!u) return null;
  return {
    input: u.inputTokens ?? 0,
    output: u.outputTokens ?? 0,
    cacheRead: u.cacheReadInputTokens ?? 0,
    cacheWrite: u.cacheCreationInputTokens ?? 0,
  };
}

/** What Claude Code reported while a turn failed. */
export type ClaudeEvidence = {
  /** The API error of Claude Code's synthetic assistant message. */
  error?: SDKAssistantMessageError | null;
  /** Its text (or the result's), written for people. */
  text?: string | null;
  /** HTTP status of the last retried request. */
  status?: number | null;
  rateLimit?: SDKRateLimitInfo | null;
};

/** A failed turn in the façade's terms: Claude Code's structured fields first, then its words. */
export function claudeFailure(
  e: ClaudeEvidence,
  model: string | null,
): Failure {
  const text = e.text ?? "";
  const rl = e.rateLimit;
  const resetSeconds = [rl?.resetsAt, rl?.overageResetsAt].filter(
    (s): s is number => typeof s === "number" && Number.isFinite(s) && s > 0,
  );
  const resetsAt = resetSeconds.length
    ? new Date(Math.min(...resetSeconds) * 1000)
    : null;
  if (
    e.error === "authentication_failed" ||
    e.error === "oauth_org_not_allowed" ||
    e.status === 401 ||
    /not logged in|please run \/login/i.test(text)
  )
    return fail.signinRequired(PROVIDER);
  // A spent subscription window: the limiter rejected the account and overage is not covering it.
  if (rl?.status === "rejected" && rl.isUsingOverage !== true)
    return fail.usageLimit(PROVIDER, resetsAt, text);
  if (
    e.error === "billing_error" ||
    rl?.overageDisabledReason === "out_of_credits"
  )
    return fail.usageLimit(PROVIDER, resetsAt, text);
  if (e.error === "rate_limit" || e.status === 429)
    return fail.rateLimited(PROVIDER, text);
  if (e.error === "model_not_found") return fail.modelUnavailable();
  if (/prompt is too long|input is too long/i.test(text))
    return fail.contextTooLong(model, text);
  if (
    e.error === "overloaded" ||
    e.error === "server_error" ||
    (typeof e.status === "number" && e.status >= 500)
  )
    return fail.providerUnavailable(PROVIDER, text);
  return classifyText(PROVIDER, text, model);
}

const clip = (s: string, n = 200) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

/** What a tool call does, as the end of "Allow …?". */
export function toolSummary(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const str = (k: string) =>
    typeof input[k] === "string" ? clip(input[k] as string) : null;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (mcp) return `${mcp[2]} (${mcp[1]})`;
  switch (toolName) {
    case "Bash":
      return str("command")
        ? `running \`${str("command")}\``
        : "running a command";
    case "Read":
      return `reading ${str("file_path") ?? "a file"}`;
    case "Write":
      return `writing ${str("file_path") ?? "a file"}`;
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return `editing ${str("file_path") ?? str("notebook_path") ?? "a file"}`;
    case "WebFetch":
      return `fetching ${str("url") ?? "a web page"}`;
    case "WebSearch":
      return str("query")
        ? `searching the web for "${str("query")}"`
        : "a web search";
    default:
      return str("description")
        ? `${toolName}: ${str("description")}`
        : toolName;
  }
}

/** A permission question for one tool call. */
export function permissionAsk(
  toolName: string,
  input: Record<string, unknown>,
  why: string | null = null,
): Ask {
  return {
    kind: "permission",
    askedBy: ASKED_BY,
    context: why,
    prompts: [
      {
        id: PERMISSION_PROMPT,
        header: toolName,
        question: `Allow ${toolSummary(toolName, input)}?`,
        multiSelect: false,
        options: [
          { label: ALLOW, description: null },
          { label: DENY, description: null },
        ],
      },
    ],
  };
}

type Question = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: { label: string; description?: string }[];
};

/** AskUserQuestion's questions as the person's prompts (one per question). */
export function questionAsk(input: Record<string, unknown>): Ask {
  const questions = (
    Array.isArray(input.questions) ? input.questions : []
  ) as Question[];
  return {
    kind: "question",
    askedBy: ASKED_BY,
    context: null,
    prompts: questions.map((q, i) => ({
      id: `q${i + 1}`,
      header: q.header ?? null,
      question: String(q.question ?? ""),
      multiSelect: !!q.multiSelect,
      options: (q.options ?? []).map((o) => ({
        label: String(o.label),
        description: o.description ?? null,
      })),
    })),
  };
}

/**
 * The tool input that carries the person's answers back, as the SDK documents: `answers` keyed by
 * each question's text, several choices joined with ", ".
 */
export function questionAnswers(
  input: Record<string, unknown>,
  answers: Answers,
): Record<string, unknown> {
  const questions = (
    Array.isArray(input.questions) ? input.questions : []
  ) as Question[];
  const out: Record<string, string> = {};
  questions.forEach((q, i) => {
    const chosen = answers[`q${i + 1}`];
    if (chosen?.length) out[q.question] = chosen.join(", ");
  });
  return { ...input, answers: out };
}

// ---------------------------------------------------------------------------------------------
// Claude Code in a sandbox

const credentialsIn = (home: string) => {
  try {
    lstatSync(join(home, CREDENTIALS_FILE));
    return true;
  } catch {
    return false;
  }
};

/** Whether the person's home holds a Claude subscription sign-in (existence only, never content). */
export const claudeSignedIn = (home: string) => credentialsIn(home);

/**
 * Whether Claude Code is renewing the sign-in kept in `home`: it holds a refresh lock it touches
 * every few seconds. Stopping it between spending the refresh token and saving the new one would
 * leave a spent token behind and sign the person out (Happy's spawnClaudeCodeChild).
 */
function renewing(home: string) {
  const fresh = (p: string) => {
    try {
      return Date.now() - lstatSync(p).mtimeMs < 10_000;
    } catch {
      return false;
    }
  };
  const dir = join(home, ".claude");
  if (fresh(join(dir, ".oauth_refresh.lock"))) return true;
  try {
    return fresh(`${realpathSync(dir)}.lock`);
  } catch {
    return false;
  }
}

async function afterRenewal(home: string, maxMs = 32_000) {
  for (const until = Date.now() + maxMs; Date.now() < until && renewing(home);)
    await Bun.sleep(100);
}

/** Only Claude Code's and the SDK's own variables cross into the sandbox. */
export function sandboxEnv(env: SpawnOptions["env"]): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (e): e is [string, string] =>
        typeof e[1] === "string" && /^(CLAUDE|ANTHROPIC)/.test(e[0]),
    ),
  );
}

/**
 * The SDK wants its process at once; a sandbox starts asynchronously. Streams are relayed once it
 * is up, and a stop that comes earlier is applied then.
 */
class SandboxedProcess extends EventEmitter implements SpawnedProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  #child: ChildProcess | null = null;
  #stop: NodeJS.Signals | null = null;
  #killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly exited: Promise<void>;

  constructor(
    started: Promise<ChildProcess>,
    private home: string,
    onStderr: (chunk: string) => void,
  ) {
    super();
    let done!: () => void;
    this.exited = new Promise((r) => (done = r));
    this.stdin.on("error", () => {});
    started.then(
      (child) => {
        this.#child = child;
        child.stdin?.on("error", () => {}); // a stopped sandbox's closed pipe
        this.stdin.pipe(child.stdin!);
        child.stdout!.pipe(this.stdout);
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", onStderr);
        child.once("exit", (code, signal) => {
          this.exitCode = code ?? (signal ? 128 : 1);
          this.signalCode = signal;
          done();
          this.emit("exit", code, signal);
        });
        child.once("error", (e) => this.emit("error", e));
        if (this.#stop) void this.#send(this.#stop);
      },
      (e: Error) => {
        this.exitCode = 1;
        this.stdout.end();
        done();
        this.emit("error", e);
        this.emit("exit", 1, null);
      },
    );
  }

  get killed() {
    return this.#killed;
  }

  kill(signal: NodeJS.Signals = "SIGTERM") {
    if (this.exitCode !== null) return false;
    const pending = this.#stop !== null;
    if (this.#stop !== "SIGKILL") this.#stop = signal;
    this.#killed = true;
    if (!pending && this.#child) void this.#send(signal);
    return true;
  }

  async #send(signal: NodeJS.Signals) {
    await afterRenewal(this.home);
    if (this.exitCode === null) this.#child?.kill(this.#stop ?? signal);
  }
}

// ---------------------------------------------------------------------------------------------
// The agent

/** Messages for a streaming query, pushed as turns come. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  #queue: SDKUserMessage[] = [];
  #wake: (() => void) | null = null;
  #closed = false;
  push(m: SDKUserMessage) {
    this.#queue.push(m);
    this.#wake?.();
  }
  close() {
    this.#closed = true;
    this.#wake?.();
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (this.#queue.length) yield this.#queue.shift()!;
      if (this.#closed) return;
      await new Promise<void>((r) => (this.#wake = r));
      this.#wake = null;
    }
  }
}

type Turn = {
  sink: TurnSink;
  aborted: boolean;
  /** A failure decided here, ending the turn through an interrupt. */
  forced: Failure | null;
  sessionSent: boolean;
  /** The assistant message streaming now. */
  streaming: string | null;
  texts: Map<string, string>;
  tools: Map<string, { item: string; name: string }>;
  evidence: ClaudeEvidence;
  end(end: TurnEnd): void;
};

type Conversation = {
  id: string;
  key: string;
  config: string;
  mode: PermissionMode;
  servers: McpServer[];
  query: Query;
  inbox: Inbox;
  session: string | null;
  /** The main model, from Claude Code's init. */
  model: string | null;
  turn: Turn | null;
  idle: ReturnType<typeof setTimeout> | null;
  ended: boolean;
  stderr: string;
  done: Promise<void>;
};

export type ClaudeAgentOptions = {
  sandboxes: Sandboxes;
  apiKeys: ApiKeys;
  /** How long a conversation's process stays after its last turn (default 2 min). */
  idleMs?: number;
  /** Claude Code inside the sandbox (default /usr/local/bin/claude). */
  executable?: string;
  /** Added to every Claude Code process's environment (tests: the mock's ANTHROPIC_BASE_URL). */
  env?: Record<string, string>;
};

const userMessage = (text: string): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
});

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out`)), ms).unref?.(),
    ),
  ]);

export class ClaudeAgent implements Agent, VerifiesApiKeys {
  readonly providers = ["claude"] as const;
  readonly #sandboxes: Sandboxes;
  readonly #apiKeys: ApiKeys;
  readonly #idleMs: number;
  readonly #executable: string;
  readonly #env: Record<string, string>;
  readonly #conversations = new Map<string, Conversation>();
  /** Every Claude Code process per person, for `busy` and `release`. */
  readonly #processes = new Map<string, Set<SandboxedProcess>>();
  #seq = 0;

  constructor(opts: ClaudeAgentOptions) {
    this.#sandboxes = opts.sandboxes;
    this.#apiKeys = opts.apiKeys;
    this.#idleMs = opts.idleMs ?? IDLE_MS;
    this.#executable = opts.executable ?? CLAUDE_EXECUTABLE;
    this.#env = opts.env ?? {};
  }

  busy(key: string) {
    return (this.#processes.get(key)?.size ?? 0) > 0;
  }

  async release(key: string) {
    const conversations = [...this.#conversations.values()].filter(
      (c) => c.key === key,
    );
    await Promise.all(conversations.map((c) => this.#close(c)));
    const left = [...(this.#processes.get(key) ?? [])];
    for (const p of left) p.kill("SIGTERM");
    await Promise.all(
      left.map((p) => withTimeout(p.exited, 45_000, "stop").catch(() => {})),
    );
  }

  async read(key: string, _provider: ProviderId): Promise<ProviderLive> {
    // Nothing to read without a sign-in or a key: no process at all.
    if (
      !credentialsIn(this.#sandboxes.homeOf(key)) &&
      !this.#apiKeys.get(key, "claude")
    )
      return { signedIn: false, account: null, models: [] };
    const live = [...this.#conversations.values()].find(
      (c) => c.key === key && !c.ended,
    );
    let init: SDKControlInitializeResponse;
    if (live) init = await live.query.initializationResult();
    else {
      // A process that is only asked how it starts: no prompt, so no request to Anthropic.
      const inbox = new Inbox();
      const started: SandboxedProcess[] = [];
      const q = query({
        prompt: inbox,
        options: this.#options(key, "read", {}, undefined, started),
      });
      try {
        init = await withTimeout(
          q.initializationResult(),
          READ_TIMEOUT_MS,
          "Claude Code",
        );
      } finally {
        inbox.close();
        q.close();
        // Let it go before answering: a read holds nothing afterwards.
        await Promise.all(
          started.map((p) => withTimeout(p.exited, 10_000, "exit").catch(() => {})),
        );
      }
    }
    const { signedIn, account } = claudeAccount(init.account);
    return {
      signedIn,
      account,
      models: signedIn ? claudeModels(init.models) : [],
    };
  }

  async verifyApiKey(
    key: string,
    _provider: ProviderId,
    apiKey: string,
  ): Promise<KeyVerdict> {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(apiKey)) return "refused";
    // The free model list, asked from the person's sandbox through its egress proxy. The key goes
    // in as a header file on standard input: never argv, never a file.
    const r = await this.#sandboxes
      .exec(
        key,
        [
          "curl",
          "-sS",
          "-m",
          "15",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          "-H",
          "@-",
          "-H",
          "anthropic-version: 2023-06-01",
          `${this.#env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"}/v1/models?limit=1`,
        ],
        { stdin: Buffer.from(`x-api-key: ${apiKey}\n`) },
      )
      .catch(() => null);
    const status = Number(r?.stdout.trim());
    if (status === 200) return "ok";
    if (status === 401 || status === 403) return "refused";
    return "unreachable";
  }

  async turn(
    key: string,
    input: TurnInput,
    sink: TurnSink,
    signal: AbortSignal,
  ): Promise<TurnEnd> {
    if (signal.aborted) return { status: "aborted" };
    const id = `${key}\n${input.conversationId}`;
    const config = this.#config(key, input);
    let c = this.#conversations.get(id);
    let session = input.session;
    // Another model, mode or MCP set needs a new process; the session carries the history over.
    if (c && (c.ended || (c.config !== config && !c.turn))) {
      session ??= c.session;
      await this.#close(c);
      c = undefined;
    }
    if (c?.turn) return { status: "failed", failure: fail.failed() };
    c ??= this.#open(id, key, { ...input, session }, config);
    const conv = c;
    if (conv.idle) clearTimeout(conv.idle);
    conv.idle = null;
    return new Promise<TurnEnd>((resolve) => {
      let abortTimer: ReturnType<typeof setTimeout> | null = null;
      const onAbort = () => {
        const t = conv.turn;
        if (!t || t.aborted) return;
        t.aborted = true;
        void conv.query.interrupt().catch(() => {});
        // Claude Code ends an interrupted turn with a result; if it does not, stop the process.
        abortTimer = setTimeout(() => void this.#close(conv), ABORT_GRACE_MS);
      };
      const turn: Turn = {
        sink,
        aborted: false,
        forced: null,
        sessionSent: false,
        streaming: null,
        texts: new Map(),
        tools: new Map(),
        evidence: {},
        end: (end) => {
          if (conv.turn !== turn) return;
          conv.turn = null;
          signal.removeEventListener("abort", onAbort);
          if (abortTimer) clearTimeout(abortTimer);
          if (!conv.ended)
            conv.idle = setTimeout(() => void this.#close(conv), this.#idleMs);
          resolve(end);
        },
      };
      conv.turn = turn;
      signal.addEventListener("abort", onAbort, { once: true });
      conv.inbox.push(userMessage(input.text));
    });
  }

  // --- conversations --------------------------------------------------------------------------

  /** What a running process was started with; a turn that differs needs a new one. */
  #config(key: string, input: TurnInput) {
    const apiKey = this.#apiKeys.get(key, "claude");
    return JSON.stringify([
      modelAlias(input.model) ?? null,
      effortOf(input.effort) ?? null,
      input.permissionMode,
      input.mcpServers,
      apiKey ? createHash("sha256").update(apiKey).digest("hex") : null,
    ]);
  }

  #open(
    id: string,
    key: string,
    input: TurnInput,
    config: string,
  ): Conversation {
    const inbox = new Inbox();
    const conv: Conversation = {
      id,
      key,
      config,
      mode: input.permissionMode,
      servers: input.mcpServers,
      inbox,
      session: input.session,
      model: null,
      turn: null,
      idle: null,
      ended: false,
      stderr: "",
      query: null!, // set below: its callbacks need this object first
      done: Promise.resolve(),
    };
    const mode = MODES[input.permissionMode];
    const options = this.#options(
      key,
      "turn",
      {
        model: modelAlias(input.model),
        effort: effortOf(input.effort),
        permissionMode: mode,
        ...(mode === "bypassPermissions"
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        ...(input.session ? { resume: input.session } : {}),
        ...mcpOptions(input.mcpServers),
        canUseTool: (name, toolInput, o) =>
          this.#canUseTool(conv, name, toolInput, o),
        onElicitation: (request, o) => this.#elicit(conv, request, o),
      },
      (d) => (conv.stderr = (conv.stderr + d).slice(-8000)),
    );
    conv.query = query({ prompt: inbox, options });
    conv.done = this.#pump(conv);
    this.#conversations.set(id, conv);
    return conv;
  }

  #options(
    key: string,
    label: string,
    extra: Partial<Options>,
    onStderr: (d: string) => void = () => {},
    started?: SandboxedProcess[],
  ): Options {
    const apiKey = this.#apiKeys.get(key, "claude");
    return {
      cwd: WORKSPACE,
      pathToClaudeCodeExecutable: this.#executable,
      // Never `process.env`: the gateway's own environment stays out of every sandbox.
      env: {
        ...PROCESS_ENV,
        ...this.#env,
        ...(apiKey && /^[A-Za-z0-9_-]+$/.test(apiKey)
          ? { ANTHROPIC_API_KEY: apiKey }
          : {}),
      },
      settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      includePartialMessages: true,
      ...extra,
      spawnClaudeCodeProcess: (o) => {
        const p = this.#spawn(key, label, o, onStderr);
        started?.push(p);
        return p;
      },
    };
  }

  #spawn(
    key: string,
    label: string,
    o: SpawnOptions,
    onStderr: (d: string) => void,
  ) {
    const started = this.#sandboxes.spawn(key, [o.command, ...o.args], {
      env: sandboxEnv(o.env),
      cwd: WORKSPACE,
      label: `claude-${label}-${++this.#seq}`.slice(0, 24),
    });
    const p = new SandboxedProcess(
      started,
      this.#sandboxes.homeOf(key),
      onStderr,
    );
    let set = this.#processes.get(key);
    if (!set) this.#processes.set(key, (set = new Set()));
    set.add(p);
    p.once("exit", () => {
      set.delete(p);
      if (!set.size && this.#processes.get(key) === set)
        this.#processes.delete(key);
    });
    // The SDK aborts this once its graceful close (stdin closed, a short wait) has run out.
    o.signal.addEventListener("abort", () => p.kill("SIGTERM"), { once: true });
    return p;
  }

  async #close(c: Conversation) {
    // A turn we stop (release, an interrupt that did not end) is aborted, not failed.
    if (c.turn) c.turn.aborted = true;
    if (this.#conversations.get(c.id) === c) this.#conversations.delete(c.id);
    if (c.idle) clearTimeout(c.idle);
    c.idle = null;
    c.inbox.close();
    c.query.close();
    await withTimeout(c.done, 45_000, "close").catch(() => {});
  }

  async #pump(c: Conversation) {
    try {
      for await (const m of c.query) this.#onMessage(c, m);
    } catch (e) {
      c.stderr = `${c.stderr}\n${String((e as Error)?.message ?? e)}`.slice(
        -8000,
      );
    }
    c.ended = true;
    if (this.#conversations.get(c.id) === c) this.#conversations.delete(c.id);
    if (c.idle) clearTimeout(c.idle);
    const t = c.turn;
    if (t)
      t.end(
        t.aborted
          ? { status: "aborted" }
          : {
              status: "failed",
              failure: t.forced ?? this.#failure(c, t.evidence),
            },
      );
  }

  /** Claude Code's structured report and its own words first; its stderr is only classified. */
  #failure(c: Conversation, e: ClaudeEvidence): Failure {
    return e.error || e.status || e.rateLimit || e.text
      ? claudeFailure(e, c.model)
      : classifyText(PROVIDER, c.stderr, c.model);
  }

  #onMessage(c: Conversation, m: SDKMessage) {
    const t = c.turn;
    if ("session_id" in m && typeof m.session_id === "string" && m.session_id) {
      c.session = m.session_id;
      if (t && !t.sessionSent) {
        t.sessionSent = true;
        t.sink.session(m.session_id);
      }
    }
    if (!t) return;
    // A subagent's own messages stay inside its Task call, as in Claude Code.
    if ("parent_tool_use_id" in m && m.parent_tool_use_id) return;
    switch (m.type) {
      case "system":
        if (m.subtype === "init") c.model = m.model;
        else if (m.subtype === "compact_boundary") t.sink.context(null);
        else if (m.subtype === "api_retry") {
          t.evidence.status = m.error_status;
          // A refused sign-in is retried for minutes; a few refusals in a row settle it.
          if (
            m.error === "authentication_failed" &&
            m.attempt >= AUTH_RETRIES &&
            !t.forced
          ) {
            t.forced = fail.signinRequired(PROVIDER);
            void c.query.interrupt().catch(() => {});
          }
        }
        break;
      case "rate_limit_event":
        t.evidence.rateLimit = m.rate_limit_info;
        break;
      case "auth_status":
        if (m.error) t.evidence.text = m.error;
        break;
      case "stream_event": {
        const ev = m.event;
        if (ev.type === "message_start") t.streaming = ev.message.id;
        else if (
          ev.type === "content_block_delta" &&
          ev.delta.type === "text_delta" &&
          t.streaming
        )
          t.sink.delta(t.streaming, ev.delta.text);
        break;
      }
      case "assistant": {
        const item = m.message.id;
        if (m.error) {
          // Claude Code's own error message (no model wrote it): it becomes the failure.
          t.evidence.error = m.error;
          t.evidence.text = m.message.content
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("")
            .trim();
          break;
        }
        for (const b of m.message.content) {
          if (b.type === "text") {
            const text = (t.texts.get(item) ?? "") + b.text;
            t.texts.set(item, text);
            t.sink.text(item, text);
          } else if (b.type === "tool_use" || b.type === "mcp_tool_use") {
            const name =
              b.type === "mcp_tool_use"
                ? `mcp__${b.server_name}__${b.name}`
                : b.name;
            t.tools.set(b.id, { item, name });
            t.sink.tool(item, { id: b.id, name, status: "running" });
          }
        }
        break;
      }
      case "user": {
        const content = m.message.content;
        if (!Array.isArray(content)) break;
        for (const b of content) {
          if (typeof b !== "object" || b.type !== "tool_result") continue;
          const tool = t.tools.get(b.tool_use_id);
          if (!tool) continue;
          t.tools.delete(b.tool_use_id);
          t.sink.tool(tool.item, {
            id: b.tool_use_id,
            name: tool.name,
            status: b.is_error ? "failed" : "completed",
          });
        }
        break;
      }
      case "result":
        void this.#finish(c, t, m);
        break;
    }
  }

  async #finish(c: Conversation, t: Turn, r: SDKResultMessage) {
    const usage = claudeUsage(r.modelUsage, c.model);
    if (usage) t.sink.usage(usage);
    let end: TurnEnd;
    if (t.aborted) end = { status: "aborted" };
    else if (t.forced) end = { status: "failed", failure: t.forced };
    else if (
      (r.subtype === "success" && !r.is_error) ||
      r.subtype === "error_max_turns"
    )
      end = { status: "completed" };
    else
      end = {
        status: "failed",
        failure: this.#failure(c, {
          ...t.evidence,
          text:
            t.evidence.text ||
            (r.subtype === "success" ? r.result : r.errors.join("\n")),
        }),
      };
    if (end.status === "completed") {
      const context = await withTimeout(
        c.query.getContextUsage({ detail: "summary" }),
        CONTEXT_TIMEOUT_MS,
        "context",
      ).catch(() => null);
      if (context) t.sink.context(claudeContext(context));
    }
    t.end(end);
  }

  // --- questions ------------------------------------------------------------------------------

  async #canUseTool(
    c: Conversation,
    toolName: string,
    input: Record<string, unknown>,
    o: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const t = c.turn;
    const deny = (message: string): PermissionResult => ({
      behavior: "deny",
      message,
    });
    if (!t) return deny("No one is here to answer.");
    if (toolName === "AskUserQuestion") {
      const answers = await this.#ask(t, questionAsk(input), o.signal);
      return answers
        ? { behavior: "allow", updatedInput: questionAnswers(input, answers) }
        : deny("The person did not answer.");
    }
    // Read only stays read only: the plan is the answer.
    if (toolName === "ExitPlanMode" && c.mode === "read_only")
      return deny(
        "This conversation is read only. Give the plan as your answer.",
      );
    const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
    const server = mcp && c.servers.find((s) => s.name === mcp[1]);
    if (server?.enabledTools && !server.enabledTools.includes(mcp![2]!))
      return deny(`The tool ${mcp![2]} is not enabled for this server.`);
    const answers = await this.#ask(
      t,
      permissionAsk(toolName, input, o.decisionReason ?? null),
      o.signal,
    );
    return answers?.[PERMISSION_PROMPT]?.[0] === ALLOW
      ? { behavior: "allow", updatedInput: input }
      : deny(
          answers ? "The person denied this." : "The person did not answer.",
        );
  }

  /** An MCP server's question mid-call: a plain confirmation is asked, anything else declined. */
  async #elicit(
    c: Conversation,
    request: Parameters<OnElicitation>[0],
    o: Parameters<OnElicitation>[1],
  ) {
    const t = c.turn;
    const props = (
      request.requestedSchema as { properties?: object } | undefined
    )?.properties;
    if (!t || request.mode === "url" || (props && Object.keys(props).length))
      return { action: "decline" as const };
    const answers = await this.#ask(
      t,
      {
        kind: "permission",
        askedBy: request.title ?? request.displayName ?? request.serverName,
        context: request.description ?? null,
        prompts: [
          {
            id: PERMISSION_PROMPT,
            header: request.serverName,
            question: request.message,
            multiSelect: false,
            options: [
              { label: ALLOW, description: null },
              { label: DENY, description: null },
            ],
          },
        ],
      },
      o.signal,
    );
    return {
      action:
        answers?.[PERMISSION_PROMPT]?.[0] === ALLOW
          ? ("accept" as const)
          : ("decline" as const),
      content: {},
    };
  }

  /** The person's answers, or null once Claude Code stops waiting (an interrupt). */
  #ask(t: Turn, ask: Ask, signal: AbortSignal): Promise<Answers | null> {
    if (signal.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(null), { once: true });
      t.sink.ask(ask).then(resolve, () => resolve(null));
    });
  }
}

/** The person's MCP servers through the gateway's proxy, headers over stdin (never argv). */
function mcpOptions(servers: McpServer[]): Partial<Options> {
  if (!servers.length) return {};
  return {
    mcpServers: Object.fromEntries(
      servers.map((s) => [
        s.name,
        { type: "http" as const, url: s.url, headers: s.headers },
      ]),
    ),
    mcpServersDelivery: "initialize",
    // The application chose these tools for the person; they run without asking.
    allowedTools: servers.flatMap((s) =>
      s.enabledTools
        ? s.enabledTools.map((t) => `mcp__${s.name}__${t}`)
        : [`mcp__${s.name}__*`],
    ),
  };
}
