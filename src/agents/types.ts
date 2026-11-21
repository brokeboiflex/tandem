// The contract between the gateway and each vendor's agent. The gateway owns the conversation
// store, the /v1 façade, sign-in state and idle handling; an agent only runs the vendor's own
// program in the person's sandboxes and reports what happens in vendor-neutral terms.
import type { ChildProcess } from "node:child_process";

export type ProviderId = "claude" | "codex" | "grok" | "openrouter" | "gemini";
export const PROVIDER_IDS: ProviderId[] = [
  "claude",
  "codex",
  "grok",
  "openrouter",
  "gemini",
];

/** The chat workspace every agent works in (inside the sandbox). */
export const WORKSPACE = "/home/agent/projects/chats";
/** The home inside the sandbox. */
export const HOME = "/home/agent";

/** How much the agent may do without asking (`PERMISSION_MODE`). */
export type PermissionMode =
  "read_only" | "workspace_write" | "auto" | "full_access";

// ---------------------------------------------------------------------------------------------
// Sandboxes

export type SandboxSpawnOptions = {
  /** Added to the sandbox's base environment (PATH, HOME, TMPDIR, the egress proxy, NO_PROXY). */
  env?: Record<string, string>;
  /** Working directory inside the sandbox; default HOME. */
  cwd?: string;
  /** Short name for logs and the sandbox id, `[a-z0-9-]{1,24}`. */
  label?: string;
};

/**
 * The person's sandboxes. Every process runs in a sandbox of its own (own PID and network
 * namespace, the person's uid and home, no capabilities, seccomp), inside the person's cgroup,
 * which holds their memory, CPU and process limits. Inside, 127.0.0.1:4750 is the egress proxy
 * (HTTPS_PROXY) and 127.0.0.1:8790 is the person's MCP proxy. The gateway's own environment never
 * reaches a sandbox.
 */
export interface Sandboxes {
  /**
   * Starts `args` with stdio piped. The returned process's `kill()` stops the sandbox (TERM, then
   * KILL after a grace period), and `exit` fires once the sandbox is gone.
   */
  spawn(
    key: string,
    args: string[],
    opts?: SandboxSpawnOptions,
  ): Promise<ChildProcess>;
  /** One short command; output collected. Times out like every one-shot command. */
  exec(
    key: string,
    args: string[],
    opts?: { env?: Record<string, string>; stdin?: Buffer; cwd?: string },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** The person's home on the gateway's own disk, for reading files the vendors keep there. */
  homeOf(key: string): string;
}

// ---------------------------------------------------------------------------------------------
// What an agent reports

export type Model = {
  /** Stable catalog id the client sends back, e.g. `claude-code/opus`, `codex-cli/gpt-6-luna`. */
  id: string;
  /** The vendor's name for it ("Opus 5.5"), or null while unknown. */
  name: string | null;
  /** The vendor's default model (Claude's `claude-code/default`); at most one per provider. */
  default?: boolean;
  efforts: string[];
  defaultEffort: string | null;
  /** Tokens at which the agent compacts automatically, else its context window; null if unknown. */
  contextLimit: number | null;
};

export type Account = { email: string | null; plan: string | null };

/** What an agent read from the vendor for one person's account. */
export type ProviderLive = {
  /** False when the vendor says the account is signed out or the key is refused. */
  signedIn: boolean;
  account: Account | null;
  models: Model[];
};

export type ContextView = {
  usedTokens: number;
  limitTokens: number;
  approximate: boolean;
};
export type UsageView = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type ToolView = {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
};

export type Prompt = {
  id: string;
  header: string | null;
  question: string;
  multiSelect: boolean;
  options: { label: string; description: string | null }[];
};

/**
 * A question the agent waits on. Permission questions carry `header` = the tool's name, `question`
 * = "Allow <what>?" and the options "Allow once", "Deny" (plus "Allow always" where the vendor has
 * it); `askedBy` is the agent's product name ("Claude Code", "Codex", …) or an MCP server's title.
 */
export type Ask = {
  kind: "permission" | "question";
  askedBy: string | null;
  context: string | null;
  prompts: Prompt[];
};

/** Answers by prompt id, each a list of option labels (or free text for an open prompt). */
export type Answers = Record<string, string[]>;

/** Why a run failed (README: Error codes). */
export type Failure =
  | {
      code:
        "signin_required" | "rate_limited" | "provider_unavailable" | "network";
      message: string;
      params: { provider: ProviderId | null };
    }
  | {
      code: "usage_limit";
      message: string;
      params: { provider: ProviderId | null; resetsAt: string | null };
    }
  | {
      code: "context_too_long";
      message: string;
      params: { model: string | null };
    }
  | {
      code: "model_unavailable" | "aborted" | "failed";
      message: string;
      params: Record<string, never>;
    };

// ---------------------------------------------------------------------------------------------
// Turns

export type McpServer = {
  name: string;
  /** Inside the sandbox: http://127.0.0.1:8790/mcp/<key>/<name> */
  url: string;
  /** The proxy's own token; the application's credential is added by the proxy on the way out. */
  headers: Record<string, string>;
  /** Only these tools may be offered; null = all the server lists. */
  enabledTools: string[] | null;
};

export type TurnInput = {
  conversationId: string;
  provider: ProviderId;
  model: string;
  effort: string | null;
  /** The vendor's own session/thread id from an earlier turn, or null for the first turn. */
  session: string | null;
  /** The person's text, with the application's hidden context already in front of it. */
  text: string;
  mcpServers: McpServer[];
  permissionMode: PermissionMode;
};

/**
 * Everything a turn reports, as it happens. `item` ids are the vendor's own ids of one assistant
 * message (any stable string); the gateway maps them to façade message ids. A tool belongs to the
 * assistant message whose item id it names.
 */
export interface TurnSink {
  /** The vendor's session/thread id, as soon as it is known (store it for the next turn). */
  session(id: string): void;
  /** Streamed assistant text (reasoning never). */
  delta(item: string, append: string): void;
  /** An assistant message's full text so far (replaces what deltas built). */
  text(item: string, text: string): void;
  /** A tool call started or changed. */
  tool(item: string, tool: ToolView): void;
  /** Asks the person; resolves with their answers, or null when the turn ends unanswered. */
  ask(ask: Ask): Promise<Answers | null>;
  /** The latest measured context size; null right after compaction. */
  context(context: ContextView | null): void;
  /** The conversation's lifetime tokens on the measured model (cumulative, not a delta). */
  usage(usage: UsageView): void;
}

export type TurnEnd =
  | { status: "completed" }
  | { status: "aborted" }
  | { status: "failed"; failure: Failure };

/** One vendor agent (Claude Code, Codex, an ACP agent). */
export interface Agent {
  readonly providers: readonly ProviderId[];
  /**
   * Reads the account and its models from the vendor. Starts what it needs and lets it go again
   * (or reuses a running process). Throws only when the vendor's program cannot run at all.
   */
  read(key: string, provider: ProviderId): Promise<ProviderLive>;
  /**
   * Runs one turn to its end. `signal` aborts it (resolve `{ status: "aborted" }`). The agent may
   * keep its process for the next turn; `release` ends it.
   */
  turn(
    key: string,
    input: TurnInput,
    sink: TurnSink,
    signal: AbortSignal,
  ): Promise<TurnEnd>;
  /** True while the agent holds a process for this person. */
  busy(key: string): boolean;
  /** Ends every process this agent holds for the person (idle, sign-out, shutdown). */
  release(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// API keys and sign-in

/**
 * The person's own API keys. The gateway keeps them in DATA_DIR, outside the person's home: a file
 * in the home is writable from the person's sandbox and could be a symlink to another person's key,
 * so nothing reads a secret from a home. An agent puts the key into the environment of that one
 * vendor process only (never argv, never a file it reads back).
 */
export type ApiKeyProvider = "claude" | "openrouter" | "gemini";
export interface ApiKeys {
  get(key: string, provider: ApiKeyProvider): string | null;
}

export type KeyVerdict = "ok" | "refused" | "unreachable";

/** Optional on an Agent: checks a pasted key from inside the person's sandbox, cheaply. */
export interface VerifiesApiKeys {
  verifyApiKey(key: string, provider: ProviderId, apiKey: string): Promise<KeyVerdict>;
}

export type SignInStatus =
  | { state: "starting" }
  | {
      state: "waiting";
      url: string;
      userCode: string | null;
      /** Unix ms, when the vendor said. */
      expiresAt: number | null;
      /** The last pasted code was refused: still waiting for it, or a new sign-in replaced it. */
      codeError: "wrong_code" | "wrong_code_reissued" | null;
    }
  | { state: "succeeded" }
  | { state: "failed"; reason: "expired" | "sign_in_failed" | "unavailable" }
  | { state: "cancelled" };

/** A vendor CLI's own sign-in, run in the person's sandbox as long as it waits. */
export interface SignIn {
  readonly provider: ProviderId;
  readonly flow: "paste_code" | "device_code";
  /** Starts it; resolves once the page is known (`waiting`) or it ended. `onChange` gets every later status. */
  start(key: string, onChange: (s: SignInStatus) => void): Promise<SignInStatus>;
  /** paste_code only: resolves once the CLI took the code (`succeeded`) or refused it (`waiting` + codeError). */
  submitCode?(key: string, code: string): Promise<SignInStatus>;
  cancel(key: string): Promise<void>;
  /** Cheap: whether the person's home holds this vendor's sign-in (a file on the gateway's disk). */
  signedIn(key: string): boolean;
  /** The vendor CLI's own sign-out where it has one, then no credential file is left. */
  signOut(key: string): Promise<void>;
}
