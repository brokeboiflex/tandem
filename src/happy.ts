// The one module that knows Happy Agent's API: an allowlisted daemon client plus the pure mappings
// from Happy objects to the gateway's /v1 façade. Pinned to Happy Agent 2026.11.6-preview.7.
import type { RuntimeHandle } from "./runtime";

export type ProviderId = "claude" | "codex";
export const PROVIDER_IDS: ProviderId[] = ["claude", "codex"];
export const PROJECT_ID = "chats";
export const PROJECT_PATH = "/home/agent/projects/chats";
/** The gateway's private folder in the person's volume (not the agents' workspace). */
export const RUNTIME_DIR = "/home/agent/.agent-runtime";
export const API_KEY_DIR = RUNTIME_DIR;
export const API_KEY_FILE = "anthropic-api-key";
export const INSTRUCTIONS_FILE = "instructions.md";
export const MAX_INSTRUCTIONS = 64_000;
export const TITLES_FILE = "titles.json";
/** Display name the runtime entrypoint gives the Claude account when an API key is configured. */
export const API_KEY_ACCOUNT_NAME = "Anthropic API key";

const PROVIDERS = {
  claude: { method: "browser", flow: "paste_code", vendor: "Claude" },
  codex: { method: "device", flow: "device_code", vendor: "ChatGPT" },
} as const;

// ---------------------------------------------------------------------------------------------
// Route allowlist. The daemon token is full owner authority (shutdown, drain, debug, config, bots,
// remote connections...). The gateway can only ever send these requests.
const ID = "[a-z][a-z0-9]{1,95}";
/** Question IDs are CUID2s, but a harness's permission question has a hex ID that may start with a digit. */
export const QUESTION_ID = "[a-z0-9]{2,96}";
const ALLOWED: [string, RegExp][] = [
  ["GET", /^\/v0\/health$/],
  ["GET", /^\/v0\/config$/],
  ["GET", /^\/v0\/provider-clis\/(claude|codex)$/],
  [
    "POST",
    /^\/v0\/provider-clis\/(claude|codex)\/(sign-in|sign-in\/code|cancel)$/,
  ],
  ["POST", /^\/v0\/providers\/claude\/verify$/],
  ["GET", /^\/v0\/bots$/],
  ["POST", new RegExp(`^/v0/bots/${ID}/archive$`)],
  ["POST", /^\/v0\/projects$/],
  ["GET", new RegExp(`^/v0/projects/${PROJECT_ID}$`)],
  ["POST", /^\/v0\/agents$/],
  ["GET", new RegExp(`^/v0/agents/${ID}(/(mode|draft|question|messages))?$`)],
  ["PUT", new RegExp(`^/v0/agents/${ID}/draft$`)],
  ["POST", new RegExp(`^/v0/agents/${ID}/(send|abort|archive)$`)],
  ["POST", new RegExp(`^/v0/agents/${ID}/question/${QUESTION_ID}/answer$`)],
  ["GET", /^\/v0\/events\/stream$/],
];

export function isAllowed(method: string, path: string) {
  const pathname = path.split("?")[0]!;
  return ALLOWED.some(([m, re]) => m === method && re.test(pathname));
}

export class DaemonError extends Error {
  constructor(
    public status: number,
    public code: string,
    /** Parsed error body, for internal decisions only. Never logged or returned to clients. */
    public body: any,
  ) {
    super(`daemon ${status} ${code}`);
  }
}

/** The runtime did not answer at all (stopped, crashed, restarting). */
export class DaemonUnreachable extends Error {}

export class Daemon {
  constructor(
    public handle: RuntimeHandle,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async call<T = any>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    timeoutMs = 30_000,
  ): Promise<T> {
    if (!isAllowed(method, path))
      throw new Error(
        `daemon route not allowed: ${method} ${path.split("?")[0]}`,
      );
    const res = await this.fetchImpl(this.handle.url + path, {
      method,
      headers: {
        authorization: `Bearer ${this.handle.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((e) => {
      throw new DaemonUnreachable((e as Error).name);
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new DaemonError(res.status, data?.code ?? "error", data);
    return data as T;
  }

  stream(after: string | undefined, signal: AbortSignal) {
    const path = "/v0/events/stream";
    if (!isAllowed("GET", path)) throw new Error("not allowed");
    return this.fetchImpl(
      this.handle.url +
        path +
        (after ? `?after=${encodeURIComponent(after)}` : ""),
      { headers: { authorization: `Bearer ${this.handle.token}` }, signal },
    );
  }
}

/**
 * Whether stopping the runtime now would cut work off: a run or a sign-in in progress and, unless
 * `waiting` is false, a question or a sign-in that waits for the person. `project` is
 * GET /v0/projects/chats, `clis` the providers' GET /v0/provider-clis/:id.
 */
export function hasWork(project: any, clis: any[], waiting = true) {
  if (
    project?.agents?.some((a: any) =>
      a.pendingQuestionId ? waiting : a.status !== "idle",
    )
  )
    return true;
  const busy = waiting ? ["running", "waiting"] : ["running"];
  return clis.some((c) => busy.includes(c?.operation?.status));
}

// ---------------------------------------------------------------------------------------------
// Providers and sign-in.

export type Model = {
  id: string;
  name: string;
  efforts: string[];
  defaultEffort: string;
};
export type ConnectionError = { code: string; message: string };
export type Connection = {
  status: "waiting" | "connected" | "failed" | "cancelled" | "expired";
  flow: "paste_code" | "device_code" | "api_key";
  url: string | null;
  userCode: string | null;
  expiresAt: string | null;
  error: ConnectionError | null;
  account: { email: string | null; plan: string | null } | null;
};

/** What the gateway remembers about a code it forwarded: never the code itself. */
export type CodeMemo = {
  opId: string;
  before: string[];
  wrong: boolean;
  reissued?: boolean;
};

export const COPY = {
  wrong_code:
    "That code didn't work. Copy the whole code from the Claude page and paste it again.",
  wrong_code_reissued:
    "That code wasn't accepted. Open the sign-in page again to get a new code, then paste it here.",
  expired: "The sign-in timed out. Start again when you're ready.",
  sign_in_failed: "Signing in didn't finish. Please try again.",
  interrupted: "The sign-in was interrupted. Please start again.",
  unavailable:
    "Sign-in isn't available right now. Please try again in a moment.",
  invalid_api_key:
    "Anthropic didn't accept that API key, or couldn't be reached. Check the key and try again.",
};

/** Models the signed-in account really offers: the daemon's live catalog (`config.models`). */
export function liveModels(config: any, provider: ProviderId): Model[] {
  const catalog = config?.models ?? {};
  const refs: any[] = config?.providers?.[provider]?.models ?? [];
  return refs
    .filter((r) => r.enabled && !r.hidden && catalog[r.id])
    .map((r) => ({
      id: r.id,
      name: catalog[r.id].name,
      efforts: catalog[r.id].efforts,
      defaultEffort: catalog[r.id].defaultEffort,
    }));
}

export function usesApiKey(config: any) {
  return config?.providers?.claude?.name === API_KEY_ACCOUNT_NAME;
}

/**
 * `signinRequired`: a turn has since failed for want of this sign-in (Happy keeps reporting the
 * account as signed in), so it counts as not connected until the person signs in again.
 */
export function providerView(
  id: ProviderId,
  cli: any,
  config: any,
  opts: { restarting?: boolean; signinRequired?: boolean } = {},
) {
  const op = cli?.operation?.kind === "sign_in" ? cli.operation : null;
  const apiKey = id === "claude" && usesApiKey(config);
  const signedIn = cli?.signIn?.status === "signed_in";
  let status: "connected" | "not_connected" | "connecting" = "not_connected";
  if (opts.restarting || (op && ["running", "waiting"].includes(op.status)))
    status = "connecting";
  else if ((apiKey || signedIn) && !opts.signinRequired) status = "connected";
  return {
    id,
    status,
    method: status !== "connected" ? null : apiKey ? "api_key" : "subscription",
    account:
      status !== "connected"
        ? null
        : apiKey
          ? { email: null, plan: "API key" }
          : {
              email: cli.signIn.account?.email ?? null,
              plan: cli.signIn.account?.plan ?? null,
            },
    models: status === "connected" ? liveModels(config, id) : [],
  };
}

export type ProviderView = ReturnType<typeof providerView>;

/** Lines the CLI printed since a snapshot. The output is a sliding window of the last 20 lines. */
export function newLines(before: string[], after: string[]): string[] {
  for (let d = 0; d <= before.length; d++) {
    const rest = before.slice(d);
    if (rest.every((line, i) => after[i] === line))
      return after.slice(rest.length);
  }
  return after;
}

/**
 * Claude Code's own words for a code it did not take. "Invalid code" is its local format check and
 * it keeps waiting ("retry"); a code the server refused ends the attempt ("restart").
 */
export function codeRejection(lines: string[]): "retry" | "restart" | null {
  if (lines.some((l) => /wasn't accepted|was not accepted|invalid_grant/i.test(l))) return "restart";
  if (lines.some((l) => /invalid code/i.test(l))) return "retry";
  return null;
}

export function connectionView(
  id: ProviderId,
  cli: any,
  memo: CodeMemo | undefined,
  opts: { restarting?: boolean; signinRequired?: boolean; now?: number } = {},
): Connection | null {
  const now = opts.now ?? Date.now();
  const op = cli?.operation?.kind === "sign_in" ? cli.operation : null;
  const base = {
    flow: PROVIDERS[id].flow,
    url: null,
    userCode: null,
    expiresAt: null,
    error: null,
    account: null,
  } as Omit<Connection, "status">;
  const account = () => ({
    email: cli.signIn?.account?.email ?? null,
    plan: cli.signIn?.account?.plan ?? null,
  });
  if (!op)
    return cli?.signIn?.status === "signed_in" && !opts.signinRequired
      ? { ...base, status: "connected", account: account() }
      : null;
  const wrong = memo && memo.opId === op.id && memo.wrong;
  const wrongError = wrong
    ? {
        code: "wrong_code",
        message: memo.reissued ? COPY.wrong_code_reissued : COPY.wrong_code,
      }
    : null;
  switch (op.status) {
    case "running":
      return { ...base, status: "waiting", error: wrongError };
    case "waiting": {
      const auth = op.authorization ?? {};
      if (auth.expiresAt && now > auth.expiresAt)
        return {
          ...base,
          status: "expired",
          error: { code: "expired", message: COPY.expired },
        };
      return {
        ...base,
        status: "waiting",
        url: auth.url ?? null,
        userCode: auth.userCode ?? null,
        expiresAt: auth.expiresAt
          ? new Date(auth.expiresAt).toISOString()
          : null,
        error: wrongError,
      };
    }
    case "succeeded":
      // Older than the failed turn that found this sign-in expired (newer ones clear the verdict).
      if (opts.signinRequired) return null;
      return opts.restarting
        ? { ...base, status: "waiting" }
        : { ...base, status: "connected", account: account() };
    case "cancelled":
      return { ...base, status: "cancelled" };
    default: {
      const code = op.error?.code;
      if (code === "expired")
        return {
          ...base,
          status: "expired",
          error: { code: "expired", message: COPY.expired },
        };
      if (["unavailable", "not_found", "install_failed"].includes(code))
        return {
          ...base,
          status: "failed",
          error: { code: "unavailable", message: COPY.unavailable },
        };
      return {
        ...base,
        status: "failed",
        error: {
          code: "sign_in_failed",
          message:
            code === "interrupted" ? COPY.interrupted : COPY.sign_in_failed,
        },
      };
    }
  }
}

export const apiKeyConnection = (
  status: "connected" | "failed",
  error: ConnectionError | null = null,
): Connection => ({
  status,
  flow: "api_key",
  url: null,
  userCode: null,
  expiresAt: null,
  error,
  account: status === "connected" ? { email: null, plan: "API key" } : null,
});

export const unavailableConnection = (id: ProviderId): Connection => ({
  status: "failed",
  flow: PROVIDERS[id].flow,
  url: null,
  userCode: null,
  expiresAt: null,
  error: { code: "unavailable", message: COPY.unavailable },
  account: null,
});

export const providerMethod = (id: ProviderId) => PROVIDERS[id].method;

// ---------------------------------------------------------------------------------------------
// Conversations, messages, failures.

export type Failure = {
  code: "signin_required" | "model_unavailable" | "aborted" | "failed";
  message: string;
};

const SIGNIN =
  /not logged in|please run \/login|\b401\b|unauthorized|missing bearer|invalid api key|invalid x-api-key|authentication_error|token (has )?expired|refresh token|invalid_grant|log ?in again|sign ?in again/i;
const MODEL =
  /issue with the selected model|model.{0,80}(not (found|supported|available)|does not exist|unavailable|no access|not have access)|unknown model|invalid model/i;

/**
 * Happy reports signed-out and expired accounts as kind "internal" with the vendor's raw text
 * (not the documented `signin_missing`), so classify by kind first, then by the vendor's words.
 */
export function classifyFailure(failure: any, providerId?: string): Failure {
  const text = `${failure?.message ?? ""} ${failure?.detail ?? ""}`;
  const vendor = providerId === "codex" ? "ChatGPT" : "Claude";
  if (failure?.kind === "signin_missing" || SIGNIN.test(text))
    return {
      code: "signin_required",
      message: `Your ${vendor} account isn't connected or its sign-in expired. Connect it again, then retry.`,
    };
  if (MODEL.test(text))
    return {
      code: "model_unavailable",
      message:
        "This model isn't available on your plan. Pick another model and try again.",
    };
  const safe = [
    "usage_limit",
    "rate_limited",
    "provider_unavailable",
    "network",
    "context_too_long",
  ];
  return {
    code: "failed",
    message:
      safe.includes(failure?.kind) && failure?.message
        ? String(failure.message).slice(0, 300)
        : "The assistant couldn't finish this reply. Please try again.",
  };
}

/**
 * The provider whose sign-in a turn just found missing or expired: a service message with a
 * `signin_required` failure, at the daemon's time. Null for every other event.
 */
export function signinFailure(ev: {
  type: string;
  payload: any;
}): { provider: ProviderId; at: number } | null {
  const m = ev.payload?.message;
  if (!["message.created", "message.updated"].includes(ev.type)) return null;
  if (m?.role !== "service" || !m.failure) return null;
  const provider = m.error?.mode?.providerId ?? m.failure?.provider?.id;
  if (!PROVIDER_IDS.includes(provider)) return null;
  if (classifyFailure(m.failure, provider).code !== "signin_required") return null;
  return { provider, at: Number(m.createdAt) || Date.now() };
}

const texts = (m: any) =>
  (m.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n\n");

// Per-message context from the application travels in front of the person's text, between these
// markers, and is cut off again wherever the gateway returns a user message.
export const CONTEXT_OPEN =
  '<app_context note="Supplied by the application for this message only. It describes the situation in the app; it was not written by the person.">';
export const CONTEXT_CLOSE = "</app_context>";
export const MAX_CONTEXT = 16_000;

export const withContext = (text: string, context: string) =>
  context ? `${CONTEXT_OPEN}\n${context}\n${CONTEXT_CLOSE}\n\n${text}` : text;

export function stripContext(text: string) {
  if (!text.startsWith(CONTEXT_OPEN)) return text;
  const end = text.indexOf(CONTEXT_CLOSE);
  return end < 0 ? "" : text.slice(end + CONTEXT_CLOSE.length).replace(/^\n\n?/, "");
}

export type ChatMessage = {
  id: string;
  runId: string | null;
  role: "user" | "assistant" | "error";
  createdAt: string;
  text: string;
  tools: { id: string; name: string; status: string }[];
  failure: Failure | null;
};

export function normalizeMessage(
  m: any,
  runId: string | null,
): ChatMessage | null {
  const common = {
    id: m.id,
    runId,
    createdAt: new Date(m.createdAt).toISOString(),
  };
  if (m.role === "user")
    return {
      ...common,
      role: "user",
      text: stripContext(texts(m)),
      tools: [],
      failure: null,
    };
  if (m.role === "agent")
    return {
      ...common,
      role: "assistant",
      text: texts(m),
      tools: (m.content ?? [])
        .filter((b: any) => b.type === "tool_call")
        .map((b: any) => ({ id: b.id, name: b.name, status: b.status })),
      failure: null,
    };
  if (m.role === "service" && m.failure)
    return {
      ...common,
      role: "error",
      text: "",
      tools: [],
      failure: classifyFailure(
        m.failure,
        m.error?.mode?.providerId ?? m.failure?.provider?.id,
      ),
    };
  return null; // configuration records, compaction, system notices: not chat content
}

export function normalizeRun(run: any, failure?: Failure | null) {
  const status =
    run.status === "aborted"
      ? run.reason === "steering"
        ? "completed"
        : "aborted"
      : (run.status as "running" | "completed" | "failed");
  return {
    id: run.id as string,
    status,
    failure:
      status === "aborted"
        ? { code: "aborted" as const, message: "Stopped." }
        : status === "failed"
          ? (failure ?? classifyFailure(null))
          : null,
  };
}

export function normalizeQuestion(q: any) {
  return {
    id: q.id as string,
    status: q.status as string,
    kind: q.permissionRequest ? "permission" : "question",
    askedBy: q.permissionRequest?.serverTitle ?? null,
    context: q.context ?? null,
    prompts: (q.questions ?? []).map((p: any) => ({
      id: p.id,
      header: p.header ?? null,
      question: p.question,
      multiSelect: !!p.multiSelect,
      options: (p.options ?? []).map((o: any) => ({
        label: o.label,
        description: o.description ?? null,
      })),
    })),
  };
}

/** Accepts a string, a list of strings, or a map of prompt id to either. */
export function questionAnswers(
  q: any,
  answer: unknown,
): Record<string, string[]> | null {
  const prompts: any[] = q.questions ?? [];
  const list = (v: unknown) =>
    typeof v === "string"
      ? [v]
      : Array.isArray(v) && v.every((s) => typeof s === "string")
        ? v
        : null;
  if (typeof answer === "string" || Array.isArray(answer)) {
    const values = list(answer);
    if (!values?.length || prompts.length !== 1) return null;
    return { [prompts[0].id]: values };
  }
  if (!answer || typeof answer !== "object") return null;
  const out: Record<string, string[]> = {};
  for (const p of prompts) {
    const values = list((answer as any)[p.id]);
    if (!values?.length) return null;
    out[p.id] = values;
  }
  return out;
}

export function conversationView(agent: any, mode: any, title?: string) {
  return {
    id: agent.id as string,
    title: title ?? agent.title ?? null,
    provider: (mode?.providerId ?? null) as ProviderId | null,
    model: mode?.modelId ?? null,
    effort: mode?.effort ?? null,
    status: agent.pendingQuestionId
      ? "waiting_for_answer"
      : agent.status === "idle"
        ? "idle"
        : "running",
    pendingQuestionId: agent.pendingQuestionId ?? null,
    createdAt: new Date(agent.createdAt).toISOString(),
    lastActivityAt: new Date(
      agent.lastActivityAt ?? agent.createdAt,
    ).toISOString(),
  };
}

/** Opaque list cursor: the last item's activity time and id. */
export const encodeCursor = (at: number, id: string) =>
  Buffer.from(`${at}.${id}`).toString("base64url");

export function decodeCursor(raw: string): { at: number; id: string } | null {
  const m = Buffer.from(raw, "base64url")
    .toString()
    .match(new RegExp(`^(\\d{1,16})\\.(${ID})$`));
  return m ? { at: Number(m[1]), id: m[2]! } : null;
}

export const isConversationAgent = (agent: any) =>
  agent?.workspaceId === PROJECT_ID &&
  !agent.parentAgentId &&
  !agent.archivedAt;

// ---------------------------------------------------------------------------------------------
// Daemon events -> façade events for one person's stream.

export type FacadeEvent = { type: string; data: unknown };
export type EventContext = {
  conversations: Set<string>;
  blockTypes: Map<string, string[]>;
  runFailures: Map<string, Failure>;
  /** question id -> conversation id, because `question.updated` names only the question. */
  questions: Map<string, string>;
};

function remember<K, V>(map: Map<K, V>, key: K, value: V, max = 500) {
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value as K);
}

export function mapEvent(
  ev: { type: string; payload: any },
  ctx: EventContext,
): FacadeEvent[] {
  const p = ev.payload ?? {};
  if (ev.type === "agent.created" && isConversationAgent(p.agent))
    ctx.conversations.add(p.agent.id);
  const conversationId: string | undefined =
    p.agentId ?? p.question?.agentId ?? ctx.questions.get(p.questionId);
  if (!conversationId || !ctx.conversations.has(conversationId)) return [];
  switch (ev.type) {
    case "message.created":
    case "message.updated": {
      const m = p.message;
      remember(
        ctx.blockTypes,
        m.id,
        (m.content ?? []).map((b: any) => b.type),
      );
      const message = normalizeMessage(m, p.runId ?? null);
      if (message?.failure && p.runId)
        remember(ctx.runFailures, p.runId, message.failure);
      return message
        ? [{ type: "conversation.message", data: { conversationId, message } }]
        : [];
    }
    case "message.delta":
      // Only assistant text; reasoning deltas stay private.
      return ctx.blockTypes.get(p.messageId)?.[p.blockIndex] === "text"
        ? [
            {
              type: "conversation.delta",
              data: {
                conversationId,
                messageId: p.messageId,
                append: p.append,
              },
            },
          ]
        : [];
    case "run.started":
      return [
        {
          type: "conversation.run",
          data: { conversationId, run: normalizeRun(p.run) },
        },
      ];
    case "run.boundary":
      return [p.finishedRun, p.startedRun].map((run) => ({
        type: "conversation.run",
        data: {
          conversationId,
          run: normalizeRun(run, ctx.runFailures.get(run.id)),
        },
      }));
    case "run.finished":
      if (p.run?.kind === "standalone") return [];
      return [
        {
          type: "conversation.run",
          data: {
            conversationId,
            run: normalizeRun(p.run, ctx.runFailures.get(p.run.id)),
          },
        },
      ];
    case "question.created":
      remember(ctx.questions, p.question.id, conversationId);
      return [
        {
          type: "conversation.question",
          data: { conversationId, question: normalizeQuestion(p.question) },
        },
      ];
    case "question.updated":
      return [
        {
          type: "conversation.question",
          data: {
            conversationId,
            question: { id: p.questionId, status: p.changes?.status ?? null },
          },
        },
      ];
    default:
      return [];
  }
}
