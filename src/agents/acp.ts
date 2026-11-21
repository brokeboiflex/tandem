// A generic Agent Client Protocol client: one vendor agent process per person while it is in use,
// one ACP session per conversation, and the vendor-neutral `Agent` contract on top. Each vendor
// (src/agents/acp-vendors.ts) only says how to start its program, how its models and modes are
// named, and what it does differently. Schema: agentclientprotocol.com, protocol version 1.
import type { ChildProcess } from "node:child_process";
import { classifyText, fail } from "./failures";
import { JsonRpc, ProcessEnded, RpcError } from "./jsonrpc";
import {
  WORKSPACE,
  type Account,
  type Agent,
  type Answers,
  type ContextView,
  type ApiKeys,
  type Ask,
  type Failure,
  type KeyVerdict,
  type McpServer,
  type Model,
  type PermissionMode,
  type ProviderId,
  type ProviderLive,
  type Sandboxes,
  type ToolView,
  type TurnEnd,
  type TurnInput,
  type TurnSink,
  type UsageView,
  type VerifiesApiKeys,
} from "./types";

/** What an agent advertised for a session (session/new, load, resume, set_config_option). */
export type Advertised = {
  configOptions: ConfigOption[] | null;
  /** The older ACP model state some agents still send (`availableModels`, `currentModelId`). */
  models: {
    currentModelId?: string;
    availableModels: { modelId: string; name?: string; _meta?: any }[];
  } | null;
  modes: {
    currentModeId?: string;
    availableModes: { id: string; name?: string }[];
  } | null;
};

export type ConfigOption = {
  id: string;
  name?: string;
  category?: string | null;
  type?: string;
  currentValue?: string | boolean;
  options?: any[];
};

/** One change to a session's configuration, applied before a prompt. */
export type SessionChange =
  | { method: "session/set_config_option"; configId: string; value: string }
  | { method: "session/set_model"; modelId: string }
  | { method: "session/set_mode"; modeId: string }
  /** The effort, on the agent's thought-level option once the model is set (if it offers it). */
  | { method: "effort"; value: string };

/** A catalog model and how to select it at an effort. */
export type CatalogModel = Model & {
  select(effort: string | null): SessionChange[];
};

export type ToolCallInfo = {
  toolCallId: string;
  name?: string | null;
  title?: string | null;
  kind?: string | null;
  status?: string | null;
  rawInput?: unknown;
  locations?: { path: string }[] | null;
  _meta?: any;
};

/** Everything that differs between ACP agents. */
export type AcpVendor = {
  provider: ProviderId;
  /** The agent's product name, for questions it asks (`Ask.askedBy`). */
  label: string;
  /** The program and its arguments (no secrets: those go in `env`). */
  command: string[];
  /**
   * The vendor process's own environment, or null when the person has no credential for it (a
   * missing API key or sign-in): then nothing is started and the provider reads as signed out.
   */
  env(key: string): Record<string, string> | null;
  /** The agent's session modes for a permission mode, most preferred first. */
  modes: Record<PermissionMode, string[]>;
  /** The agent takes `session/set_mode` with these ids though it advertises no modes (Grok). */
  unadvertisedModes?: boolean;
  /** The models a session advertises, as catalog models. */
  models(adv: Advertised): CatalogModel[];
  /**
   * Models known without starting the agent (OpenRouter: Tandem's own list); then `read` never
   * starts it, and turns select models with `select` from this list.
   */
  catalog?(): Promise<CatalogModel[]>;
  /** The account behind the credential, read from the running agent where it can tell. */
  account?(rpc: JsonRpc, init: any): Promise<Account | null>;
  /** The account when the agent cannot tell (an API key's). */
  defaultAccount: Account;
  /** Extra fields for session/new (vendor `_meta`), and the MCP servers in the vendor's form. */
  newSession?(servers: McpServer[]): {
    mcpServers?: unknown[];
    _meta?: unknown;
  };
  /** Pass HTTP MCP servers even though the agent does not advertise them (agy takes them). */
  mcpWithoutAdvert?: boolean;
  /** The tool's own name (`ToolView.name`, a permission question's header). */
  toolName?(call: ToolCallInfo): string | null;
  /**
   * Whether PromptResponse.usage counts the whole session (goose) or only that turn (agy); the
   * latter is added to the conversation's earlier usage.
   */
  usage: "session" | "turn" | "none";
  /**
   * Usage and context from the prompt's answer where the agent reports them its own way (Grok:
   * `_meta`), instead of PromptResponse.usage and usage_update.
   */
  report?(
    response: any,
    model: Model,
  ): { usage: any; context: ContextView | null } | null;
  /** Failure from an error the vendor reports in its own shape, before `classifyText`. */
  failure?(e: RpcError, model: string | null): Failure | null;
  /** `_meta` of the client capabilities in `initialize` (opting in to vendor extensions). */
  clientMeta?: Record<string, unknown>;
  /** Usage or context from a vendor's own notification, for the live turn of its session. */
  notification?(
    method: string,
    params: any,
  ): { sessionId: string; usage?: UsageView; context?: ContextView } | null;
  /**
   * Assistant text that is the agent reporting its own failure (agy shows API errors as text and
   * ends the turn normally): held back, and the turn fails with it if nothing follows.
   */
  errorText?: RegExp;
  /** The vendor's failure text classified its own way first (else `classifyText`). */
  classify?(text: string, model: string | null): Failure | null;
  /** The pasted API key check (VerifiesApiKeys), from a one-shot sandbox. */
  verifyApiKey?(
    sandboxes: Sandboxes,
    key: string,
    apiKey: string,
  ): Promise<KeyVerdict>;
};

export type AcpOptions = {
  sandboxes: Sandboxes;
  apiKeys: ApiKeys;
  /** How long a person's agent process stays after its last turn (default 2 minutes). */
  idleMs?: number;
};

const INIT_TIMEOUT_MS = 60_000;
const OPEN_TIMEOUT_MS = 120_000;
const SET_TIMEOUT_MS = 30_000;
/** How long a cancelled prompt gets to end before its process is stopped. */
const CANCEL_GRACE_MS = 5_000;
const MAX_CONTEXT_CHARS = 4_000;
/** Tool kinds `read_only` lets through without asking (ACP ToolKind). */
const READ_KINDS = new Set(["read", "search", "think"]);

type OpenSession = {
  id: string;
  adv: Advertised;
  /** What was applied: config id / "model" / "mode" → value. */
  applied: Map<string, string>;
  /** The MCP servers it was opened with. */
  mcp: string;
};

type Proc = {
  key: string;
  rpc: JsonRpc;
  init: any;
  /** Open sessions by conversation. */
  sessions: Map<string, OpenSession>;
  /** The running turn of each session. */
  live: Map<string, LiveTurn>;
  /** Sessions being loaded: their replayed history is not news. */
  replaying: Set<string>;
  turns: number;
  idle: ReturnType<typeof setTimeout> | null;
  /** Ended on purpose (release, idle, abort): running turns end as aborted. */
  closing: boolean;
};

const ask = (o: unknown) => (o && typeof o === "object" ? (o as any) : {});

export class AcpAgent implements Agent, VerifiesApiKeys {
  readonly providers: readonly ProviderId[];
  /** Each person's process, starting or running. */
  #procs = new Map<string, Promise<Proc>>();
  #running = new Map<string, Proc>();
  #idleMs: number;

  constructor(
    readonly vendor: AcpVendor,
    private o: AcpOptions,
  ) {
    this.providers = [vendor.provider];
    this.#idleMs = o.idleMs ?? 2 * 60_000;
  }

  busy(key: string) {
    return this.#procs.has(key);
  }

  async release(key: string) {
    const p = this.#procs.get(key);
    if (!p) return;
    this.#procs.delete(key);
    const proc = await p.catch(() => null);
    if (!proc) return;
    this.#forget(proc);
    await this.#close(proc);
  }

  async verifyApiKey(key: string, provider: ProviderId, apiKey: string) {
    if (provider !== this.vendor.provider || !this.vendor.verifyApiKey)
      throw new Error(`${provider} takes no API key here`);
    return this.vendor.verifyApiKey(this.o.sandboxes, key, apiKey);
  }

  async read(key: string, provider: ProviderId): Promise<ProviderLive> {
    void provider;
    const v = this.vendor;
    const signedOut = { signedIn: false, account: null, models: [] };
    if (!v.env(key)) return signedOut;
    if (v.catalog)
      return {
        signedIn: true,
        account: v.defaultAccount,
        models: (await v.catalog()).map(plain),
      };
    const proc = await this.#use(key);
    try {
      // Any session already open says which models the account has; otherwise one that is never
      // prompted, removed again where the agent can.
      let adv = [...proc.sessions.values()][0]?.adv;
      if (!adv) {
        const r = await proc.rpc.request(
          "session/new",
          this.#newParams([]),
          OPEN_TIMEOUT_MS,
        );
        adv = advertised(r);
        const caps = proc.init?.agentCapabilities?.sessionCapabilities ?? {};
        const drop = caps.delete
          ? "session/delete"
          : caps.close
            ? "session/close"
            : null;
        if (drop)
          await proc.rpc
            .request(drop, { sessionId: r.sessionId }, SET_TIMEOUT_MS)
            .catch(() => {});
      }
      const account =
        (await v.account?.(proc.rpc, proc.init).catch(() => null)) ??
        v.defaultAccount;
      return { signedIn: true, account, models: v.models(adv).map(plain) };
    } catch (e) {
      if (e instanceof RpcError && isAuth(e)) return signedOut;
      throw e;
    } finally {
      this.#done(proc);
    }
  }

  async turn(
    key: string,
    input: TurnInput,
    sink: TurnSink,
    signal: AbortSignal,
  ): Promise<TurnEnd> {
    const v = this.vendor;
    if (signal.aborted) return { status: "aborted" };
    if (!v.env(key))
      return { status: "failed", failure: fail.signinRequired(v.provider) };
    let proc: Proc;
    try {
      proc = await this.#use(key);
    } catch (e) {
      return { status: "failed", failure: this.#failure(e, null, input.model) };
    }
    let live: LiveTurn | null = null;
    try {
      const s = await this.#open(proc, input, sink);
      if (signal.aborted) return { status: "aborted" };
      const model = await this.#configure(proc, s, input);
      if (!model) return { status: "failed", failure: fail.modelUnavailable() };
      if (signal.aborted) return { status: "aborted" };
      live = new LiveTurn(this, s.id, input, sink);
      proc.live.set(s.id, live);
      const prompt = proc.rpc.request("session/prompt", {
        sessionId: s.id,
        prompt: [{ type: "text", text: input.text }],
      });
      let onAbort = () => {};
      const cancelled = new Promise<"aborted">((resolve) => {
        onAbort = () => {
          live!.end();
          proc.rpc.notify("session/cancel", { sessionId: s.id });
          resolve("aborted");
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
      const r = await Promise.race([prompt, cancelled]).finally(() =>
        signal.removeEventListener("abort", onAbort),
      );
      if (r === "aborted") {
        // The agent gets a moment to end the prompt and save its session. Agents can leave the
        // cancelled command running, so the process ends too unless another conversation is
        // using it; the next turn resumes the session in a new one.
        await settle(prompt, CANCEL_GRACE_MS);
        live.finish("failed");
        if (proc.turns === 1) this.#drop(proc);
        return { status: "aborted" };
      }
      const held = live.heldError;
      live.finish(held ? "failed" : "completed");
      if (held) {
        const failure =
          v.classify?.(held, input.model) ?? classifyText(v.provider, held, input.model);
        if (failure.code === "signin_required") this.#drop(proc);
        return { status: "failed", failure };
      }
      const own = v.report?.(r, model);
      if (own?.context) sink.context(own.context);
      this.#usage(own ? own.usage : r?.usage, input, sink);
      // Cancelled without our session/cancel: the agent ended the turn itself (Grok does when a
      // tool call is denied), which is an answer, not a stop.
      if (r?.stopReason === "cancelled" && signal.aborted) return { status: "aborted" };
      if (r?.stopReason === "refusal")
        return { status: "failed", failure: fail.failed() };
      return { status: "completed" };
    } catch (e) {
      live?.finish("failed");
      if (proc.closing || signal.aborted) return { status: "aborted" };
      const failure = this.#failure(e, proc, input.model);
      // A refused credential: the next turn starts the agent again with whatever the person
      // connects next (a new key is in the environment of a new process only).
      if (failure.code === "signin_required") this.#drop(proc);
      return { status: "failed", failure };
    } finally {
      if (live && proc.live.get(live.sessionId) === live)
        proc.live.delete(live.sessionId);
      this.#done(proc);
    }
  }

  /** The agent's own name for a tool call. */
  toolName(call: ToolCallInfo) {
    return (
      this.vendor.toolName?.(call) ??
      call.name ??
      call.title ??
      call.kind ??
      "tool"
    );
  }

  // -------------------------------------------------------------------------------------------
  // Processes

  #ensure(key: string): Promise<Proc> {
    const cur = this.#running.get(key);
    if (cur && (cur.rpc.ended || cur.closing)) this.#forget(cur);
    const have = this.#procs.get(key);
    if (have) return have;
    const p = this.#start(key).then((proc) => {
      if (this.#procs.get(key) === p) this.#running.set(key, proc);
      return proc;
    });
    this.#procs.set(key, p);
    p.catch(() => {
      if (this.#procs.get(key) === p) this.#procs.delete(key);
    });
    return p;
  }

  /** The person's process for one more turn or read (not one that is being stopped). */
  async #use(key: string): Promise<Proc> {
    for (;;) {
      const proc = await this.#ensure(key);
      if (proc.closing || proc.rpc.ended) {
        this.#forget(proc);
        continue;
      }
      proc.turns++;
      if (proc.idle) clearTimeout(proc.idle);
      proc.idle = null;
      return proc;
    }
  }

  #forget(proc: Proc) {
    if (this.#running.get(proc.key) !== proc) return;
    this.#running.delete(proc.key);
    this.#procs.delete(proc.key);
  }

  async #start(key: string): Promise<Proc> {
    const env = this.vendor.env(key);
    if (!env) throw new Error("no credential");
    const child: ChildProcess = await this.o.sandboxes.spawn(
      key,
      this.vendor.command,
      { env, cwd: WORKSPACE, label: this.vendor.provider },
    );
    const rpc = new JsonRpc(child);
    const proc: Proc = {
      key,
      rpc,
      init: null,
      sessions: new Map(),
      live: new Map(),
      replaying: new Set(),
      turns: 0,
      idle: null,
      closing: false,
    };
    rpc.onNotification((method, params) => {
      if (method !== "session/update") {
        const own = this.vendor.notification?.(method, params);
        if (own) proc.live.get(own.sessionId)?.report(own);
        return;
      }
      const sid = params?.sessionId;
      if (proc.replaying.has(sid)) return;
      const update = params?.update;
      if (update?.sessionUpdate === "config_option_update")
        for (const s of proc.sessions.values())
          if (s.id === sid && Array.isArray(update.configOptions))
            s.adv.configOptions = update.configOptions;
      proc.live.get(sid)?.update(update);
    });
    rpc.handle("session/request_permission", async (p) => {
      const live = proc.live.get(p?.sessionId);
      return live ? live.permission(p) : { outcome: { outcome: "cancelled" } };
    });
    void rpc.exited.then(() => {
      this.#forget(proc);
      if (proc.idle) clearTimeout(proc.idle);
      for (const l of proc.live.values()) l.end();
    });
    try {
      proc.init = await rpc.request(
        "initialize",
        {
          protocolVersion: 1,
          // The agent works on the files with its own tools, inside the person's sandbox.
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            ...(this.vendor.clientMeta ? { _meta: this.vendor.clientMeta } : {}),
          },
        },
        INIT_TIMEOUT_MS,
      );
      return proc;
    } catch (e) {
      await rpc.close();
      throw e;
    }
  }

  /** A turn or read ended: the process stays `idleMs` after the last one. */
  #done(proc: Proc) {
    proc.turns--;
    if (proc.turns > 0 || proc.rpc.ended || proc.closing) return;
    if (proc.idle) clearTimeout(proc.idle);
    proc.idle = setTimeout(() => this.#drop(proc), this.#idleMs);
    proc.idle.unref?.();
  }

  /** Ends a process now; the person's next turn starts another. */
  #drop(proc: Proc) {
    this.#forget(proc);
    void this.#close(proc);
  }

  async #close(proc: Proc) {
    proc.closing = true;
    if (proc.idle) clearTimeout(proc.idle);
    for (const l of proc.live.values()) l.end();
    await proc.rpc.close();
  }

  // -------------------------------------------------------------------------------------------
  // Sessions

  #mcp(proc: Proc, servers: McpServer[]): McpServer[] {
    const http = proc.init?.agentCapabilities?.mcpCapabilities?.http === true;
    if (!http && !this.vendor.mcpWithoutAdvert) return [];
    // A server with no tool left to offer is not offered at all.
    return servers.filter(
      (s) => s.enabledTools === null || s.enabledTools.length > 0,
    );
  }

  #newParams(servers: McpServer[]) {
    const extra = this.vendor.newSession?.(servers) ?? {};
    return {
      cwd: WORKSPACE,
      mcpServers: extra.mcpServers ?? servers.map(acpServer),
      ...(extra._meta === undefined ? {} : { _meta: extra._meta }),
    };
  }

  async #open(
    proc: Proc,
    input: TurnInput,
    sink: TurnSink,
  ): Promise<OpenSession> {
    const servers = this.#mcp(proc, input.mcpServers);
    const mcp = JSON.stringify(servers.map(acpServer));
    const rpc = proc.rpc;
    const caps = proc.init?.agentCapabilities ?? {};
    let s = proc.sessions.get(input.conversationId);
    if (s && input.session && s.id !== input.session) s = undefined;
    if (s && s.mcp === mcp) return s;
    // Open with other MCP servers than before: closed and opened again with the new ones.
    if (s && caps.sessionCapabilities?.close)
      await rpc
        .request("session/close", { sessionId: s.id }, SET_TIMEOUT_MS)
        .catch(() => {});
    proc.sessions.delete(input.conversationId);
    let opened: OpenSession | null = null;
    // The stored session, or the one this process had open for the conversation.
    const stored = input.session ?? s?.id ?? null;
    if (stored) {
      const params = {
        sessionId: stored,
        cwd: WORKSPACE,
        mcpServers: servers.map(acpServer),
      };
      try {
        let r: any = null;
        if (caps.sessionCapabilities?.resume)
          r = await rpc.request("session/resume", params, OPEN_TIMEOUT_MS);
        else if (caps.loadSession) {
          // Loading replays the whole conversation, which the gateway already has.
          proc.replaying.add(stored);
          try {
            r = await rpc.request("session/load", params, OPEN_TIMEOUT_MS);
          } finally {
            proc.replaying.delete(stored);
          }
        }
        if (r !== null)
          opened = {
            id: stored,
            adv: advertised(r),
            applied: new Map(),
            mcp,
          };
      } catch (e) {
        // A refused sign-in or a dead agent ends the turn; a session the agent no longer has
        // becomes a new one (its earlier context is gone, the conversation goes on).
        if (!(e instanceof RpcError) || isAuth(e)) throw e;
      }
    }
    if (!opened) {
      const r = await rpc.request(
        "session/new",
        this.#newParams(servers),
        OPEN_TIMEOUT_MS,
      );
      if (typeof r?.sessionId !== "string")
        throw new Error("session/new: no sessionId");
      opened = { id: r.sessionId, adv: advertised(r), applied: new Map(), mcp };
    }
    proc.sessions.set(input.conversationId, opened);
    sink.session(opened.id);
    return opened;
  }

  /** Applies the conversation's model, effort and permission mode; false: model not offered. */
  async #configure(proc: Proc, s: OpenSession, input: TurnInput) {
    const v = this.vendor;
    const models = v.catalog ? await v.catalog() : v.models(s.adv);
    const m = models.find((x) => x.id === input.model);
    if (!m) return false;
    const effort =
      input.effort && m.efforts.includes(input.effort)
        ? input.effort
        : m.defaultEffort;
    const changes = [
      ...m.select(effort),
      ...modeChanges(s.adv, v.modes[input.permissionMode], !!v.unadvertisedModes),
    ];
    for (let c of changes) {
      if (c.method === "effort") {
        // Resolved now: the model just set decides which efforts the option offers.
        const wanted = c.value;
        const level = option(s.adv, "thought_level");
        if (!level || !level.values.some((x) => x.value === wanted)) continue;
        c = { method: "session/set_config_option", configId: level.id, value: wanted };
      }
      const [slot, value] =
        c.method === "session/set_config_option"
          ? [c.configId, c.value]
          : c.method === "session/set_model"
            ? ["model", c.modelId]
            : ["mode", c.modeId];
      if (s.applied.get(slot) === value) continue;
      const { method, ...rest } = c;
      let r: any;
      try {
        r = await proc.rpc.request(method, { sessionId: s.id, ...rest }, SET_TIMEOUT_MS);
      } catch (e) {
        // The agent refused the model itself: the account does not offer it (any more).
        if (e instanceof RpcError && slot === "model" && e.code === -32602) return false;
        throw e;
      }
      if (Array.isArray(r?.configOptions)) s.adv.configOptions = r.configOptions;
      s.applied.set(slot, value);
    }
    return m;
  }

  #usage(raw: any, input: TurnInput, sink: TurnSink) {
    if (this.vendor.usage === "none" || !raw || typeof raw !== "object") return;
    const turn: UsageView = {
      input: num(raw.inputTokens),
      output: num(raw.outputTokens),
      cacheRead: num(raw.cachedReadTokens),
      cacheWrite: num(raw.cachedWriteTokens ?? raw.cacheCreationTokens),
    };
    const before = this.vendor.usage === "turn" ? input.usage : null;
    sink.usage(
      before
        ? {
            input: before.input + turn.input,
            output: before.output + turn.output,
            cacheRead: before.cacheRead + turn.cacheRead,
            cacheWrite: before.cacheWrite + turn.cacheWrite,
          }
        : turn,
    );
  }

  #failure(e: unknown, proc: Proc | null, model: string | null): Failure {
    const p = this.vendor.provider;
    if (e instanceof RpcError) {
      if (isAuth(e)) return fail.signinRequired(p);
      const own = this.vendor.failure?.(e, model);
      if (own) return own;
      const text = rpcText(e);
      return this.vendor.classify?.(text, model) ?? classifyText(p, text, model);
    }
    // The agent ended mid-turn: its last words say why, if anything does.
    if (e instanceof ProcessEnded && proc)
      return classifyText(p, proc.rpc.stderr, model);
    if (e instanceof Error && /ENOENT|spawn/i.test(e.message))
      return fail.providerUnavailable(p);
    return fail.failed();
  }

  /** The policy that answers before the person is asked (see README: permission modes). */
  autoAnswer(
    mode: PermissionMode,
    call: ToolCallInfo,
  ): "allow" | "deny" | "ask" {
    if (mode === "full_access") return "allow";
    if (mode === "read_only")
      return call.kind && READ_KINDS.has(call.kind) ? "allow" : "deny";
    if (mode === "workspace_write" && call.kind === "edit") {
      const paths = (call.locations ?? []).map((l) => l?.path);
      if (
        paths.length > 0 &&
        paths.every((x) => typeof x === "string" && inside(x))
      )
        return "allow";
    }
    return "ask";
  }
}

/**
 * One prompt in flight: maps the session's updates to the sink and its permission requests to
 * questions. Assistant text after a tool call starts a new item, as a new assistant message.
 */
class LiveTurn {
  #seq = 0;
  #item: string | null = null;
  #afterTool = false;
  #messageId: string | null = null;
  #tools = new Map<
    string,
    { item: string; view: ToolView; call: ToolCallInfo }
  >();
  #ended = false;
  #onEnd = new Set<() => void>();
  /** The agent's own failure text, held back from the person (AcpVendor.errorText). */
  #held: string | null = null;
  readonly #prefix = crypto.randomUUID().slice(0, 8);

  constructor(
    private agent: AcpAgent,
    readonly sessionId: string,
    private input: TurnInput,
    private sink: TurnSink,
  ) {}

  #newItem() {
    this.#item = `${this.#prefix}-${++this.#seq}`;
    this.#afterTool = false;
    return this.#item;
  }

  update(u: any) {
    if (this.#ended || !u) return;
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const text = u.content?.type === "text" ? u.content.text : null;
        if (typeof text !== "string" || !text) return;
        const err = this.agent.vendor.errorText;
        if (err?.test(text)) {
          this.#held = (this.#held ? `${this.#held}\n` : "") + text;
          return;
        }
        // Text after the agent's failure report: it recovered (a retry worked).
        this.#held = null;
        const mid = typeof u.messageId === "string" ? u.messageId : null;
        if (
          !this.#item ||
          this.#afterTool ||
          (mid && this.#messageId && mid !== this.#messageId)
        )
          this.#newItem();
        if (mid) this.#messageId = mid;
        this.sink.delta(this.#item!, text);
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        const id = u.toolCallId;
        if (typeof id !== "string") return;
        const known = this.#tools.get(id);
        const call: ToolCallInfo = {
          ...known?.call,
          ...strip(u),
          toolCallId: id,
        };
        const item = known?.item ?? this.#item ?? this.#newItem();
        const view: ToolView = {
          id,
          // A tool keeps the name it started with (later updates may carry only a title).
          name: known?.view.name ?? this.agent.toolName(call),
          status: toolStatus(u.status ?? known?.call.status),
        };
        this.#tools.set(id, { item, view, call });
        this.#afterTool = true;
        this.sink.tool(item, view);
        return;
      }
      case "usage_update": {
        const used = num(u.used),
          size = num(u.size);
        if (size > 0)
          this.sink.context({
            usedTokens: used,
            limitTokens: size,
            approximate: false,
          });
        return;
      }
      default:
        // Reasoning (agent_thought_chunk) is never shown; plans, commands and titles are not
        // part of the façade.
        return;
    }
  }

  async permission(p: any) {
    const id = String(p?.toolCall?.toolCallId ?? "");
    const call: ToolCallInfo = {
      ...this.#tools.get(id)?.call,
      ...strip(p?.toolCall ?? {}),
      toolCallId: id,
    };
    const options: { optionId: string; kind: string }[] = Array.isArray(
      p?.options,
    )
      ? p.options
      : [];
    const pick = (kinds: string[]) => {
      for (const k of kinds) {
        const o = options.find((x) => x.kind === k);
        if (o)
          return { outcome: { outcome: "selected", optionId: o.optionId } };
      }
      return { outcome: { outcome: "cancelled" } };
    };
    const ALLOW_ONCE = ["allow_once", "allow_always"];
    const DENY = ["reject_once", "reject_always"];
    const policy = this.agent.autoAnswer(this.input.permissionMode, call);
    if (policy === "allow") return pick(ALLOW_ONCE);
    if (policy === "deny") return pick(DENY);
    if (this.#ended) return pick([]);
    const labels: [string, string[]][] = [
      ["Allow once", ["allow_once"]],
      ["Allow always", ["allow_always"]],
      ["Deny", DENY],
    ];
    const offered = labels.filter(([, kinds]) =>
      options.some((o) => kinds.includes(o.kind)),
    );
    const name = this.#tools.get(id)?.view.name ?? this.agent.toolName(call);
    const detail = describe(call.rawInput);
    // What it would do: its command where it has one, else the agent's title for the call.
    const what = oneLine(command(call.rawInput)) || oneLine(call.title) || name;
    const question: Ask = {
      kind: "permission",
      askedBy: this.agent.vendor.label,
      context: detail && detail !== what ? detail : null,
      prompts: [
        {
          id: "permission",
          header: name,
          question: `Allow ${what}?`,
          multiSelect: false,
          options: offered.map(([label]) => ({ label, description: null })),
        },
      ],
    };
    const ended = new Promise<null>((r) => this.#onEnd.add(() => r(null)));
    const answers: Answers | null = await Promise.race([
      this.sink.ask(question).catch(() => null),
      ended,
    ]);
    if (this.#ended || !answers) return pick([]);
    const label = answers.permission?.[0];
    const chosen = offered.find(([l]) => l === label);
    return chosen ? pick(chosen[1]) : pick([]);
  }

  /** Usage or context the agent reported in its own notification. */
  report(r: { usage?: UsageView; context?: ContextView }) {
    if (this.#ended) return;
    if (r.context) this.sink.context(r.context);
    if (r.usage) this.sink.usage(r.usage);
  }

  /** The agent's own failure report the turn ended with, if any. */
  get heldError() {
    return this.#held;
  }

  /** Nobody waits for answers any more: open questions resolve as cancelled. */
  end() {
    if (this.#ended) return;
    this.#ended = true;
    for (const fn of this.#onEnd) fn();
    this.#onEnd.clear();
  }

  /** The prompt ended: tools that never reported their end take the turn's. */
  finish(status: "completed" | "failed") {
    this.end();
    for (const { item, view } of this.#tools.values())
      if (view.status === "running") this.sink.tool(item, { ...view, status });
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers

/** The parts of a model the façade knows (`select` is the agent's own business). */
function plain(m: CatalogModel): Model {
  const { select: _, ...rest } = m;
  return rest;
}

export function advertised(r: any): Advertised {
  return {
    configOptions: Array.isArray(r?.configOptions) ? r.configOptions : null,
    models: Array.isArray(r?.models?.availableModels) ? r.models : null,
    modes: Array.isArray(r?.modes?.availableModes) ? r.modes : null,
  };
}

/** A select option by ACP category (or id), with its values flattened out of groups. */
export function option(
  adv: Advertised,
  category: string,
  ids: string[] = [category],
) {
  const o =
    adv.configOptions?.find((x) => x.category === category) ??
    adv.configOptions?.find((x) => ids.includes(x.id));
  if (!o || o.type !== "select") return null;
  const values: { value: string; name: string }[] = [];
  for (const e of o.options ?? [])
    if (Array.isArray(e?.options)) values.push(...e.options);
    else if (typeof e?.value === "string") values.push(e);
  return { id: o.id, current: o.currentValue, values };
}

function modeChanges(adv: Advertised, wanted: string[], unadvertised: boolean): SessionChange[] {
  const opt = option(adv, "mode");
  const have = opt
    ? opt.values.map((v) => v.value)
    : (adv.modes?.availableModes ?? []).map((m) => m.id);
  if (unadvertised && !opt && !adv.modes)
    return wanted[0] ? [{ method: "session/set_mode", modeId: wanted[0] }] : [];
  const mode = wanted.find((m) => have.includes(m));
  if (!mode) return [];
  return opt
    ? [{ method: "session/set_config_option", configId: opt.id, value: mode }]
    : [{ method: "session/set_mode", modeId: mode }];
}

export function acpServer(s: McpServer) {
  return {
    type: "http",
    name: s.name,
    url: s.url,
    headers: Object.entries(s.headers).map(([name, value]) => ({
      name,
      value,
    })),
  };
}

const isAuth = (e: RpcError) =>
  e.code === -32000 || /auth(entication)?[_ ]required/i.test(e.message);

/** An RPC error's whole text: ACP agents put the vendor's own error in `data`. */
export function rpcText(e: RpcError) {
  const d: any = e.data;
  const data =
    typeof d === "string"
      ? d
      : typeof d?.details === "string"
        ? d.details
        : typeof d?.message === "string"
          ? d.message
          : d === undefined || d === null
            ? ""
            : JSON.stringify(d);
  return `${e.message} ${data}`.trim();
}

function toolStatus(s: unknown): ToolView["status"] {
  return s === "completed"
    ? "completed"
    : s === "failed"
      ? "failed"
      : "running";
}

function strip(u: any): Partial<ToolCallInfo> {
  const out: Partial<ToolCallInfo> = {};
  for (const k of [
    "name",
    "title",
    "kind",
    "status",
    "rawInput",
    "locations",
    "_meta",
  ] as const)
    if (u?.[k] !== undefined && u[k] !== null) (out as any)[k] = u[k];
  return out;
}

const num = (x: unknown) =>
  typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0;

function inside(path: string) {
  const norm = path.replace(/\/+$/, "");
  return (
    (norm === WORKSPACE || norm.startsWith(`${WORKSPACE}/`)) &&
    !/(^|\/)\.\.(\/|$)/.test(norm)
  );
}

function oneLine(s: unknown) {
  if (typeof s !== "string") return "";
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
}

function command(raw: unknown): string | null {
  const r = ask(raw);
  const cmd = [r.command, r.cmd, r.CommandLine].find(
    (x) => typeof x === "string" || Array.isArray(x),
  );
  return typeof cmd === "string" ? cmd : Array.isArray(cmd) ? cmd.join(" ") : null;
}

/** What a tool call would do, for the person: its command, else its input. */
function describe(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const r = ask(raw);
  const cmd = [r.command, r.cmd, r.CommandLine].find(
    (x) => typeof x === "string" || Array.isArray(x),
  );
  const text =
    typeof raw === "string"
      ? raw
      : typeof cmd === "string"
        ? cmd
        : Array.isArray(cmd)
          ? cmd.join(" ")
          : JSON.stringify(raw, null, 2);
  return text.length > MAX_CONTEXT_CHARS
    ? `${text.slice(0, MAX_CONTEXT_CHARS)}…`
    : text;
}

async function settle(p: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    p.catch(() => {}),
    new Promise((r) => (timer = setTimeout(r, ms))),
  ]);
  clearTimeout(timer);
}
