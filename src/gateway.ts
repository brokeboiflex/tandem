// Tandem gateway: authenticates people and exposes only the /v1 façade. Conversations, messages and
// settings live in the gateway's own store (./store.ts); every vendor program runs through an agent
// (./agents/) in the person's sandboxes (./runtime.ts). Reads answer from the store and never
// start a process.
import { mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { devToken, verifier, type Principal } from "./auth";
import type { Config } from "./config";
import * as M from "./mcp";
import * as P from "./providers";
import { fail } from "./agents/failures";
import {
  HOME,
  WORKSPACE,
  type Agent,
  type Answers,
  type Failure,
  type McpServer,
  type ProviderId,
  type ProviderLive,
  type Sandboxes,
  type SignIn,
  type SignInStatus,
  type TurnEnd,
  type TurnSink,
  type VerifiesApiKeys,
} from "./agents/types";
import type { ConversationRow, MessageRow, Store } from "./store";
import { runtimeKey } from "./runtime";
import { sseComment, sseEncode } from "./sse";

/** What the gateway needs from the sandbox runtime beyond spawning processes. */
export type GatewayRuntime = Sandboxes & {
  /** The host path of the person's MCP socket, mounted into their sandboxes at /run/tandem/mcp.sock. */
  mcpSocket(key: string): string;
  /** Writes a file in the person's home as the person (standard input; never argv). */
  writePrivateFile(
    key: string,
    dir: string,
    name: string,
    content: string,
  ): Promise<void>;
  posture?(): Promise<{ egress: string }>;
};

export type GatewayDeps = {
  runtime: GatewayRuntime;
  agents: Agent[];
  signIns: SignIn[];
  store: Store;
  fetchImpl?: typeof fetch;
  log?: (...args: unknown[]) => void;
};

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail = "",
    /** Every value `detail` names, for clients that word the error themselves. */
    public params: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

type Client = (event: string, data: unknown) => void;

type PendingQuestion = {
  view: P.QuestionView;
  resolve(a: Answers | null): void;
};

type Turn = {
  runId: string;
  abort: AbortController;
  question: PendingQuestion | null;
};

/** What the gateway holds for one person in memory: live state only, nothing it must keep. */
class Person {
  clients = new Set<Client>();
  lastUsed = Date.now();
  /** The running turn of each conversation. */
  turns = new Map<string, Turn>();
  /** Each conversation's queue: a message sent during a turn runs after it. */
  queues = new Map<string, Promise<void>>();
  signIns = new Map<ProviderId, SignInStatus>();
  /** A pasted API key being checked: the provider shows `connecting`. */
  checking = new Set<ProviderId>();
  /** The last pasted API key the provider refused (the verdict only, never the key). */
  apiKeyFailures: Partial<Record<ProviderId, P.Connection>> = {};
  /** A turn failed for want of this sign-in: not connected until the person signs in again. */
  signinRequired = new Set<ProviderId>();
  refreshing = new Map<ProviderId, Promise<void>>();
  /** Agents to restart once idle, because the account they run on changed. */
  stale = new Set<Agent>();
  constructor(public key: string) {}
}

/** What the store remembers of a provider's live state. */
type CachedLive = ProviderLive & { method: "subscription" | "api_key" };

const ID = "[a-z][a-z0-9]{1,95}";
const QUESTION_ID = "[a-z0-9]{2,96}";
const newId = () => "m" + crypto.randomUUID().replaceAll("-", "").slice(0, 31);
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "cache-control": "no-store" } });
const noContent = () =>
  new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
/** Every /v1 error: clients translate `error` with `params`; `message` is the English fallback. */
const errorJson = (
  status: number,
  error: string,
  message: string,
  params: Record<string, unknown> = {},
) => json({ error, message, params }, status);
const UNAVAILABLE =
  "Your workspace isn't reachable right now. Try again in a moment.";
const MODEL_UNAVAILABLE =
  "This model isn't offered by the connected account. Pick another model.";
const NOT_FOUND = () => new HttpError(404, "not_found", "Not found.");
const MAX_TITLE = 200;
const MAX_TEXT = 100_000;
const MAX_QUERY = 200;
const MAX_INSTRUCTIONS = 64_000;
/** A live provider read older than this is read again when the person's stream opens. */
const REFRESH_MS = 15 * 60_000;
/** Live reads start vendor programs (Claude ~230 MiB for a moment): at most this many at once. */
const MAX_READS = 2;
const tooLong = (maxLength: number) =>
  new HttpError(
    400,
    "text_too_long",
    `This text is too long: at most ${maxLength} characters.`,
    {
      maxLength,
    },
  );
const iso = (ms: number) => new Date(ms).toISOString();

export function createGateway(cfg: Config, deps: GatewayDeps) {
  const { runtime, store } = deps;
  const people = new Map<string, Person>();
  const verify = verifier(cfg);
  const log = deps.log ?? ((...args: unknown[]) => console.log(...args));
  const person = (key: string) => {
    let p = people.get(key);
    if (!p) people.set(key, (p = new Person(key)));
    return p;
  };
  const emit = (p: Person, event: string, data: unknown) => {
    for (const client of p.clients) client(event, data);
  };
  const agentFor = (id: ProviderId) => {
    const a = deps.agents.find((x) => x.providers.includes(id));
    if (!a) throw new Error(`no agent for ${id}`);
    return a;
  };
  const signInFor = (id: ProviderId) =>
    deps.signIns.find((s) => s.provider === id) ?? null;
  // Application credentials for MCP servers live only inside the proxy, never in the store.
  const proxy = new M.McpProxy({
    secret: cfg.serviceSecret,
    servers: async (key) => serversOf(key),
    fetchImpl: deps.fetchImpl,
    log,
  });
  const mcpListeners = new Map<string, { stop(force?: boolean): void }>();
  let egress: string = cfg.egressMode;
  void runtime.posture?.().then(
    (p) => (egress = p.egress),
    () => {},
  );

  // Live reads, a few at a time across everyone.
  let reads = 0;
  const waitingReads: (() => void)[] = [];
  async function limited<T>(job: () => Promise<T>): Promise<T> {
    if (reads >= MAX_READS)
      await new Promise<void>((r) => waitingReads.push(r));
    reads++;
    try {
      return await job();
    } finally {
      reads--;
      waitingReads.shift()?.();
    }
  }

  // --- Providers --------------------------------------------------------------------------------

  /** How the person's account for this provider is set up, from what the gateway itself can see. */
  function credential(
    p: Person,
    id: ProviderId,
  ): "api_key" | "subscription" | null {
    if (P.takesApiKey(id) && store.apiKey(p.key, id)) return "api_key";
    if (signInFor(id)?.signedIn(p.key)) return "subscription";
    return null;
  }

  const signingIn = (p: Person, id: ProviderId) => {
    const s = p.signIns.get(id);
    return (
      p.checking.has(id) || s?.state === "starting" || s?.state === "waiting"
    );
  };

  function providerView(
    p: Person,
    id: ProviderId,
    now = Date.now(),
  ): P.ProviderView {
    const empty = { id, method: null, account: null, models: [] };
    if (signingIn(p, id))
      return { ...empty, status: "connecting", checkedAt: iso(now) };
    const method = credential(p, id);
    if (!method || p.signinRequired.has(id))
      return { ...empty, status: "not_connected", checkedAt: iso(now) };
    const cached = store.provider<CachedLive>(p.key, id);
    // Set up, but its account has not been read yet: clients show it as loading.
    if (!cached || cached.view.method !== method)
      return { ...empty, status: "unknown", checkedAt: null };
    if (!cached.view.signedIn)
      return {
        ...empty,
        status: "not_connected",
        checkedAt: iso(cached.checkedAt),
      };
    return {
      id,
      status: "connected",
      method,
      account:
        method === "api_key"
          ? { email: null, plan: "API key" }
          : cached.view.account,
      models: cached.view.models.map(P.modelView),
      checkedAt: iso(cached.checkedAt),
    };
  }

  function connection(p: Person, id: ProviderId): P.Connection | null {
    const flow = P.subscriptionFlow(id);
    const s = p.signIns.get(id);
    if (p.checking.has(id))
      return {
        ...P.apiKeyConnection("failed"),
        status: "waiting",
        error: null,
      };
    if (flow && (s?.state === "starting" || s?.state === "waiting"))
      return P.signInConnection(flow, s, null);
    const view = providerView(p, id);
    if (view.status === "connected")
      return P.connectedConnection(
        view.method === "api_key" ? "api_key" : (flow ?? "api_key"),
        view.account,
      );
    // Signed in, its account still being read: connected, account to follow.
    if (flow && s?.state === "succeeded" && view.status === "unknown")
      return P.connectedConnection(flow, null);
    if (p.apiKeyFailures[id]) return p.apiKeyFailures[id]!;
    if (flow && s && s.state !== "succeeded")
      return P.signInConnection(flow, s, null);
    return null;
  }

  const stateOf = (p: Person, id: ProviderId) => ({
    provider: providerView(p, id),
    connection: connection(p, id),
  });

  function publish(p: Person, id: ProviderId) {
    if (p.clients.size) emit(p, "provider.updated", stateOf(p, id));
  }

  /** Reads the account and models from the vendor; the answer arrives as `provider.updated`. */
  function refresh(p: Person, id: ProviderId, force = false): Promise<void> {
    const method = credential(p, id);
    if (!method) return Promise.resolve();
    const cached = store.provider<CachedLive>(p.key, id);
    const fresh =
      cached &&
      cached.view.method === method &&
      Date.now() - cached.checkedAt < REFRESH_MS;
    if (fresh && !force) return Promise.resolve();
    const running = p.refreshing.get(id);
    if (running) return running;
    const job = limited(() => agentFor(id).read(p.key, id))
      .then((live) => {
        // The account changed meanwhile: this answer is about the old one.
        if (credential(p, id) !== method) return;
        store.putProvider(
          p.key,
          id,
          { ...live, method } satisfies CachedLive,
          Date.now(),
        );
        if (live.signedIn) p.signinRequired.delete(id);
      })
      .catch((e) =>
        log(
          "provider_read_failed",
          id,
          String((e as Error)?.message ?? e).slice(0, 160),
        ),
      )
      .finally(() => {
        p.refreshing.delete(id);
        publish(p, id);
      });
    p.refreshing.set(id, job);
    return job;
  }

  /** The person's account for `id` changed: read it again, and restart its program once idle. */
  function accountChanged(p: Person, id: ProviderId) {
    p.signinRequired.delete(id);
    const agent = agentFor(id);
    p.stale.add(agent);
    releaseStale(p);
    void refresh(p, id, true);
    publish(p, id);
  }

  function releaseStale(p: Person) {
    if (p.turns.size) return; // after the running turns (a turn's end calls this again)
    for (const agent of p.stale) void agent.release(p.key).catch(() => {});
    p.stale.clear();
  }

  // --- MCP and instructions storage ---------------------------------------------------------------

  const serversOf = (key: string): M.McpServer[] =>
    store.setting<M.McpServer[]>(key, "mcpServers") ?? [];

  /** The person's registered servers as the agents reach them: through the MCP proxy. */
  function agentServers(p: Person): McpServer[] {
    const token = M.proxyToken(cfg.serviceSecret, p.key);
    return serversOf(p.key).map((s) => ({
      name: s.name,
      url: `http://127.0.0.1:8790/mcp/${p.key}/${s.name}`,
      headers: { Authorization: `Bearer ${token}` },
      enabledTools: s.enabledTools,
    }));
  }

  /**
   * Listens on the person's MCP socket, which is mounted into their sandboxes and nowhere else, so
   * the socket names the caller. Idempotent; it must exist before a sandbox starts.
   */
  function listenMcp(key: string) {
    if (mcpListeners.has(key)) return;
    const path = runtime.mcpSocket(key);
    mkdirSync(dirname(path), { recursive: true, mode: 0o711 });
    try {
      unlinkSync(path); // left behind by a previous gateway process
    } catch {}
    mcpListeners.set(
      key,
      Bun.serve({
        unix: path,
        fetch: (req, server) => mcpProxy(req, server, key),
      }),
    );
  }

  async function mcpProxy(
    req: Request,
    server: any,
    from: string,
  ): Promise<Response> {
    try {
      return await proxy.handle(req, server, from);
    } catch (e) {
      log("mcp_proxy_failed", (e as Error)?.name ?? "Error");
      return json({ error: "unavailable" }, 502);
    }
  }

  // --- Conversations and turns ------------------------------------------------------------------

  function conversationView(p: Person, c: ConversationRow) {
    const turn = p.turns.get(c.id);
    return {
      id: c.id,
      title: c.title ?? c.autoTitle,
      provider: c.provider,
      model: c.model,
      effort: c.effort,
      status: turn
        ? turn.question
          ? "waiting_for_answer"
          : "running"
        : "idle",
      pendingQuestionId: turn?.question?.view.id ?? null,
      createdAt: iso(c.createdAt),
      lastActivityAt: iso(c.lastActivityAt),
    };
  }

  const messageView = (m: MessageRow) => ({
    id: m.id,
    runId: m.runId,
    role: m.role,
    createdAt: iso(m.createdAt),
    text: m.text,
    tools: m.tools,
    failure: m.failure,
  });

  function conversationOf(p: Person, id: string) {
    const c = store.conversation(p.key, id);
    if (!c || c.archivedAt) throw NOT_FOUND();
    return c;
  }

  /**
   * The model and effort a conversation may use: one the connected account offers (read live
   * first when it has not been yet).
   */
  async function choose(
    p: Person,
    provider: ProviderId,
    model: unknown,
    effort: unknown,
    currentEffort: string | null = null,
  ) {
    let view = providerView(p, provider);
    if (view.status === "unknown") {
      await refresh(p, provider, true);
      view = providerView(p, provider);
    }
    if (view.status !== "connected")
      throw new HttpError(
        409,
        "signin_required",
        `Connect your ${P.vendorOf(provider)} account first.`,
        { provider },
      );
    const m = view.models.find((x) => x.id === model);
    if (!m) throw new HttpError(422, "model_unavailable", MODEL_UNAVAILABLE);
    if (effort !== undefined && effort !== null && typeof effort !== "string")
      throw new HttpError(400, "invalid_request", "effort must be a string");
    if (!m.efforts.length) {
      if (effort)
        throw new HttpError(
          422,
          "invalid_effort",
          "This model takes no effort.",
          { efforts: [] },
        );
      return { model: m.id, effort: null };
    }
    const chosen =
      (effort as string | undefined) ??
      (currentEffort && m.efforts.includes(currentEffort)
        ? currentEffort
        : m.defaultEffort);
    if (!chosen || !m.efforts.includes(chosen))
      throw new HttpError(
        422,
        "invalid_effort",
        `effort must be one of ${m.efforts.join(", ")}`,
        {
          efforts: m.efforts,
        },
      );
    return { model: m.id, effort: chosen };
  }

  /** Runs one queued turn of a conversation to its end, recording and announcing everything. */
  async function runTurn(
    p: Person,
    conversationId: string,
    runId: string,
    text: string,
  ) {
    const c = store.conversation(p.key, conversationId);
    if (!c) return;
    const turn: Turn = { runId, abort: new AbortController(), question: null };
    p.turns.set(c.id, turn);
    p.lastUsed = Date.now();
    const conv = () => ({ conversationId: c.id });
    const items = new Map<string, MessageRow>();
    const rowFor = (item: string) => {
      let m = items.get(item);
      if (!m) {
        m = {
          id: newId(),
          conversation: c.id,
          runId,
          role: "assistant",
          createdAt: Date.now(),
          text: "",
          tools: [],
          failure: null,
        };
        items.set(item, m);
        store.putMessage(p.key, m);
        emit(p, "conversation.message", { ...conv(), message: messageView(m) });
      }
      return m;
    };
    const save = (m: MessageRow) => {
      store.putMessage(p.key, m);
      emit(p, "conversation.message", { ...conv(), message: messageView(m) });
    };
    const sink: TurnSink = {
      session: (session) => store.updateConversation(p.key, c.id, { session }),
      delta: (item, append) => {
        if (!append) return;
        const m = rowFor(item);
        m.text += append;
        store.putMessage(p.key, m);
        emit(p, "conversation.delta", { ...conv(), messageId: m.id, append });
      },
      text: (item, text) => {
        const m = rowFor(item);
        if (m.text === text) return;
        m.text = text;
        save(m);
      },
      tool: (item, tool) => {
        const m = rowFor(item);
        const i = m.tools.findIndex((t) => t.id === tool.id);
        if (i < 0) m.tools.push(tool);
        else m.tools[i] = tool;
        save(m);
      },
      ask: (ask) =>
        new Promise<Answers | null>((resolve) => {
          if (turn.abort.signal.aborted) return resolve(null);
          const view: P.QuestionView = {
            id: newId(),
            status: "pending",
            ...ask,
          };
          turn.question = { view, resolve };
          emit(p, "conversation.question", { ...conv(), question: view });
        }),
      context: (context) => {
        store.updateConversation(p.key, c.id, { context });
        emit(p, "conversation.context", { ...conv(), context });
      },
      usage: (usage) => store.updateConversation(p.key, c.id, { usage }),
    };
    let end: TurnEnd;
    try {
      if (!credential(p, c.provider))
        end = { status: "failed", failure: fail.signinRequired(c.provider) };
      else {
        listenMcp(p.key);
        await proxy.settle(p.key, 5000);
        end = await agentFor(c.provider).turn(
          p.key,
          {
            conversationId: c.id,
            provider: c.provider,
            model: c.model,
            effort: c.effort,
            session: c.session,
            text,
            mcpServers: agentServers(p),
            permissionMode: cfg.permissionMode as any,
          },
          sink,
          turn.abort.signal,
        );
      }
    } catch (e) {
      log(
        "turn_failed",
        c.provider,
        String((e as Error)?.message ?? e).slice(0, 160),
      );
      end = turn.abort.signal.aborted
        ? { status: "aborted" }
        : { status: "failed", failure: fail.failed() };
    }
    if (turn.abort.signal.aborted && end.status === "failed")
      end = { status: "aborted" };
    const q = turn.question;
    if (q) {
      turn.question = null;
      q.resolve(null);
      emit(p, "conversation.question", {
        ...conv(),
        question: { id: q.view.id, status: "cancelled" },
      });
    }
    let failure: Failure | null = null;
    if (end.status === "failed") {
      failure = end.failure;
      const m: MessageRow = {
        id: newId(),
        conversation: c.id,
        runId,
        role: "error",
        createdAt: Date.now(),
        text: "",
        tools: [],
        failure,
      };
      save(m);
      if (failure.code === "signin_required") {
        p.signinRequired.add(c.provider);
        publish(p, c.provider);
      }
    } else if (end.status === "aborted") failure = fail.aborted();
    const now = Date.now();
    store.endRun(p.key, runId, end.status, failure, now);
    store.updateConversation(p.key, c.id, { lastActivityAt: now });
    p.turns.delete(c.id);
    p.lastUsed = now;
    emit(p, "conversation.run", {
      ...conv(),
      run: { id: runId, status: end.status, failure },
    });
    releaseStale(p);
  }

  // --- /v1 handlers -------------------------------------------------------------------------------

  type Ctx = {
    p: Person;
    req: Request;
    url: URL;
    params: string[];
    body: any;
    principal: Principal;
  };

  function listProviders({ p }: Ctx) {
    return json({ providers: P.PROVIDER_IDS.map((id) => providerView(p, id)) });
  }

  async function startConnect({ p, params, body }: Ctx) {
    const id = params[0] as ProviderId;
    if (body.method === "api_key") {
      if (!P.takesApiKey(id))
        throw new HttpError(
          400,
          "invalid_request",
          "Only Claude, OpenRouter and Gemini accept an API key.",
        );
      return json({ connection: await connectApiKey(p, id, body.apiKey) });
    }
    if (body.method !== undefined && body.method !== "subscription")
      throw new HttpError(
        400,
        "invalid_request",
        "method must be subscription or api_key",
      );
    const flow = P.subscriptionFlow(id);
    const signIn = signInFor(id);
    if (!flow)
      throw new HttpError(
        400,
        "invalid_request",
        "This provider connects with your own API key: send method api_key.",
      );
    if (!signIn) return json({ connection: P.unavailableConnection(id) });
    delete p.apiKeyFailures[id];
    await signIn.cancel(p.key).catch(() => {});
    p.signIns.set(id, { state: "starting" });
    publish(p, id);
    const onChange = (s: SignInStatus) => {
      if (p.signIns.get(id) === undefined) return; // cancelled and forgotten meanwhile
      p.signIns.set(id, s);
      if (s.state === "succeeded") {
        // The person chose their subscription: a key they configured before no longer applies.
        if (P.takesApiKey(id)) store.setApiKey(p.key, id, null);
        accountChanged(p, id);
      } else publish(p, id);
    };
    const first = await signIn.start(p.key, onChange).catch((e) => {
      log(
        "signin_start_failed",
        id,
        String((e as Error)?.message ?? e).slice(0, 160),
      );
      return { state: "failed", reason: "unavailable" } as SignInStatus;
    });
    onChange(first);
    return json({ connection: connection(p, id) });
  }

  async function connectApiKey(p: Person, id: ProviderId, apiKey: unknown) {
    const spec = P.apiKeySpec(id)!;
    const key = typeof apiKey === "string" ? apiKey.trim() : "";
    if (!/^[A-Za-z0-9_-]{20,512}$/.test(key))
      throw new HttpError(
        400,
        "invalid_api_key_format",
        `Paste the whole key. ${spec.hint}`,
        {
          provider: id,
        },
      );
    // Choosing a key replaces a subscription sign-in still waiting for this provider.
    const signIn = signInFor(id);
    if (signIn && p.signIns.has(id)) {
      await signIn.cancel(p.key).catch(() => {});
      p.signIns.delete(id);
    }
    delete p.apiKeyFailures[id];
    p.checking.add(id);
    publish(p, id);
    const agent = agentFor(id) as Agent & Partial<VerifiesApiKeys>;
    const verdict = await (
      agent.verifyApiKey?.(p.key, id, key) ??
      Promise.resolve("unreachable" as const)
    ).catch(() => "unreachable" as const);
    p.checking.delete(id);
    if (verdict === "ok") {
      // The key is kept by the gateway (DATA_DIR), never in the person's home.
      store.setApiKey(p.key, id as any, key);
      accountChanged(p, id);
      return P.apiKeyConnection("connected");
    }
    publish(p, id);
    return (p.apiKeyFailures[id] = P.apiKeyConnection(
      "failed",
      P.invalidApiKey(id),
    ));
  }

  const getConnect = ({ p, params }: Ctx) =>
    json({ connection: connection(p, params[0] as ProviderId) });

  async function submitCode({ p, params, body }: Ctx) {
    const id = params[0] as ProviderId;
    // The code is held only in this request's memory: never logged, stored or echoed.
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!code || code.length > 2048 || /[\u0000-\u001f\u007f]/.test(code))
      throw new HttpError(
        400,
        "invalid_code",
        "Paste the code shown on the sign-in page.",
      );
    const signIn = signInFor(id);
    const s = p.signIns.get(id);
    if (
      !signIn?.submitCode ||
      P.subscriptionFlow(id) !== "paste_code" ||
      s?.state !== "waiting"
    )
      throw new HttpError(
        409,
        "not_waiting_for_code",
        "This sign-in isn't waiting for a code.",
      );
    const next = await signIn.submitCode(p.key, code);
    // A device-code-style change may have finished the sign-in meanwhile; never undo that.
    const before = p.signIns.get(id);
    if (before?.state !== "succeeded") {
      p.signIns.set(id, next);
      if (next.state === "succeeded") {
        if (P.takesApiKey(id)) store.setApiKey(p.key, id, null);
        accountChanged(p, id);
      } else publish(p, id);
    }
    return json({ connection: connection(p, id) });
  }

  async function cancelConnect({ p, params }: Ctx) {
    const id = params[0] as ProviderId;
    const signIn = signInFor(id);
    if (signIn && signingIn(p, id)) {
      await signIn.cancel(p.key).catch(() => {});
      p.signIns.set(id, { state: "cancelled" });
      publish(p, id);
    }
    return json({ connection: connection(p, id) });
  }

  async function disconnect({ p, params }: Ctx) {
    const id = params[0] as ProviderId;
    const signIn = signInFor(id);
    if (signIn) {
      await signIn.cancel(p.key).catch(() => {});
      await signIn.signOut(p.key);
    }
    if (P.takesApiKey(id)) store.setApiKey(p.key, id, null);
    p.signIns.delete(id);
    p.signinRequired.delete(id);
    delete p.apiKeyFailures[id];
    // A running program must drop the old account: now, or after the running turns.
    p.stale.add(agentFor(id));
    releaseStale(p);
    publish(p, id);
    return json({ provider: providerView(p, id) });
  }

  /**
   * The person's live events. Its first `provider.updated` per provider comes at once; a provider
   * whose account has not been read recently is read from the vendor, and the answer follows.
   */
  function events({ p, req, principal }: Ctx) {
    let send: Client | undefined;
    let timers: Timer[] = [];
    const leave = () => {
      if (send) p.clients.delete(send);
      p.lastUsed = Date.now();
      timers.forEach(clearTimeout);
    };
    const close = (controller: ReadableStreamDefaultController) => {
      leave();
      try {
        controller.close();
      } catch {}
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        send = (event, data) => {
          try {
            controller.enqueue(sseEncode(event, data));
          } catch {}
        };
        p.clients.add(send);
        timers = [
          setInterval(
            () => send && controller.enqueue(sseComment("keepalive")),
            15_000,
          ),
          setTimeout(
            () => close(controller),
            Math.max(0, principal.expiresAt - Date.now()),
          ),
        ];
        req.signal.addEventListener("abort", () => close(controller));
        for (const id of P.PROVIDER_IDS) {
          send("provider.updated", stateOf(p, id));
          void refresh(p, id);
        }
      },
      cancel: leave,
    });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  }

  async function createConversation({ p, body }: Ctx) {
    const { provider, model, effort, title } = body;
    if (!P.PROVIDER_IDS.includes(provider) || typeof model !== "string")
      throw new HttpError(
        400,
        "invalid_request",
        "provider and model are required",
      );
    if (title !== undefined && title !== null && typeof title !== "string")
      throw new HttpError(400, "invalid_request", "title must be a string");
    const clean = typeof title === "string" ? title.trim() : "";
    if (clean.length > MAX_TITLE) throw tooLong(MAX_TITLE);
    const chosen = await choose(p, provider, model, effort);
    const c = store.createConversation(p.key, {
      id: newId(),
      provider,
      model: chosen.model,
      effort: chosen.effort,
      title: clean || null,
      createdAt: Date.now(),
    });
    return json({ conversation: conversationView(p, c) }, 201);
  }

  function listConversations({ p, url }: Ctx) {
    const limit = Math.min(
      200,
      Math.max(1, Number(url.searchParams.get("limit")) || 50),
    );
    const query = (url.searchParams.get("query") ?? "").trim();
    if (query.length > MAX_QUERY) throw tooLong(MAX_QUERY);
    const rawCursor = url.searchParams.get("cursor");
    const cursor = rawCursor ? P.decodeCursor(rawCursor, ID) : null;
    if (rawCursor && !cursor)
      throw new HttpError(400, "invalid_request", "cursor is not valid");
    const { rows, more } = store.listConversations(p.key, {
      limit,
      cursor,
      query,
    });
    const last = rows.at(-1);
    return json({
      conversations: rows.map((c) => conversationView(p, c)),
      nextCursor:
        more && last ? P.encodeCursor(last.lastActivityAt, last.id) : null,
    });
  }

  function renameConversation({ p, params, body }: Ctx) {
    const { title } = body;
    const clean = typeof title === "string" ? title.trim() : title;
    if (
      clean !== null &&
      (typeof clean !== "string" ||
        !clean ||
        /[\u0000-\u001f\u007f]/.test(clean))
    )
      throw new HttpError(
        400,
        "invalid_request",
        "title must be 1-200 characters, or null to use the generated title",
      );
    if (clean?.length > MAX_TITLE) throw tooLong(MAX_TITLE);
    const c = conversationOf(p, params[0]!);
    store.updateConversation(p.key, c.id, { title: clean });
    return json({ conversation: conversationView(p, conversationOf(p, c.id)) });
  }

  /** Archives: the history stays in the store, the conversation leaves every list and takes no messages. */
  function archiveConversation({ p, params }: Ctx) {
    const c = conversationOf(p, params[0]!);
    p.turns.get(c.id)?.abort.abort();
    store.updateConversation(p.key, c.id, { archivedAt: Date.now() });
    return noContent();
  }

  function getMessages({ p, params, url }: Ctx) {
    const c = conversationOf(p, params[0]!);
    const limit = Math.min(
      200,
      Math.max(1, Number(url.searchParams.get("limit")) || 50),
    );
    const before = url.searchParams.get("before");
    const page = store.page(p.key, c.id, {
      limit,
      before: before && new RegExp(`^${ID}$`).test(before) ? before : null,
    });
    const q = p.turns.get(c.id)?.question;
    return json({
      conversation: conversationView(p, c),
      messages: page.messages.map(messageView),
      runs: page.runs.map((r) => ({
        id: r.id,
        status: r.status,
        failure: r.failure,
      })),
      hasMore: page.hasMore,
      question: q ? q.view : null,
      context: c.context,
      usage: c.usage,
    });
  }

  async function sendMessage({ p, params, body }: Ctx) {
    const { text, model, effort } = body;
    if (typeof text !== "string" || !text.trim())
      throw new HttpError(
        400,
        "invalid_request",
        "text must be 1-100000 characters",
      );
    if (text.length > MAX_TEXT) throw tooLong(MAX_TEXT);
    const auth = parseMcpAuth(body.mcpAuth);
    const context = parseContext(body.context);
    let c = conversationOf(p, params[0]!);
    if (model !== undefined || effort !== undefined) {
      const chosen = await choose(
        p,
        c.provider,
        model ?? c.model,
        effort,
        c.effort,
      );
      store.updateConversation(p.key, c.id, chosen);
    } else {
      const view = providerView(p, c.provider);
      if (
        view.status === "connected" &&
        !view.models.some((m) => m.id === c.model)
      )
        throw new HttpError(422, "model_unavailable", MODEL_UNAVAILABLE);
    }
    // Before the turn starts: an MCP server waiting for this credential lists its tools then.
    if (auth) proxy.setCredentials(p.key, auth);
    const now = Date.now();
    const runId = newId();
    store.addRun(p.key, c.id, runId, now);
    const message: MessageRow = {
      id: newId(),
      conversation: c.id,
      runId,
      role: "user",
      createdAt: now,
      text,
      tools: [],
      failure: null,
    };
    store.putMessage(p.key, message);
    store.updateConversation(p.key, c.id, {
      lastActivityAt: now,
      ...(c.autoTitle ? {} : { autoTitle: P.autoTitle(text) }),
    });
    c = conversationOf(p, c.id);
    emit(p, "conversation.message", {
      conversationId: c.id,
      message: messageView(message),
    });
    emit(p, "conversation.run", {
      conversationId: c.id,
      run: { id: runId, status: "running", failure: null },
    });
    const prompt = P.withContext(text, context);
    const queued = (p.queues.get(c.id) ?? Promise.resolve()).then(() =>
      runTurn(p, c.id, runId, prompt).catch((e) =>
        log("turn_crashed", String((e as Error)?.message ?? e).slice(0, 160)),
      ),
    );
    p.queues.set(c.id, queued);
    void queued.then(() => {
      if (p.queues.get(c.id) === queued) p.queues.delete(c.id);
    });
    return json(
      { message: messageView(message), conversation: conversationView(p, c) },
      202,
    );
  }

  function abort({ p, params }: Ctx) {
    const c = conversationOf(p, params[0]!);
    p.turns.get(c.id)?.abort.abort();
    return json({ conversation: conversationView(p, c) }, 202);
  }

  function answer({ p, params, body }: Ctx) {
    const c = conversationOf(p, params[0]!);
    const turn = p.turns.get(c.id);
    const q = turn?.question;
    if (!turn || !q || q.view.id !== params[1])
      throw new HttpError(
        409,
        "question_not_pending",
        "This question isn't waiting for an answer any more.",
      );
    const answers = P.questionAnswers(q.view, body.answer);
    if (!answers)
      throw new HttpError(
        400,
        "invalid_answer",
        "answer must name an option or give text for every prompt",
      );
    turn.question = null;
    q.resolve(answers);
    const view = { ...q.view, status: "answered" as const };
    emit(p, "conversation.question", {
      conversationId: c.id,
      question: { id: view.id, status: view.status },
    });
    return json({ question: view });
  }

  /** `{ [server]: "Bearer …" | null }`: the Authorization value the proxy sends upstream. */
  function parseMcpAuth(raw: unknown): Record<string, string | null> | null {
    if (raw === undefined || raw === null) return null;
    const entries =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? Object.entries(raw)
        : null;
    if (
      !entries ||
      entries.length > M.MAX_SERVERS ||
      !entries.every(
        ([name, value]) =>
          M.isServerName(name) &&
          (value === null ||
            (typeof value === "string" &&
              value.length > 0 &&
              value.length <= M.MAX_CREDENTIAL &&
              /^[\x20-\x7e]+$/.test(value))),
      )
    )
      // Never echo the value: it is a credential.
      throw new HttpError(
        400,
        "invalid_request",
        "mcpAuth must map server names to Authorization header values (or null)",
      );
    return Object.fromEntries(entries) as Record<string, string | null>;
  }

  function parseContext(raw: unknown) {
    if (raw === undefined || raw === null || raw === "") return "";
    if (
      typeof raw !== "string" ||
      raw.length > P.MAX_CONTEXT ||
      raw.includes(P.CONTEXT_CLOSE)
    )
      throw new HttpError(
        400,
        "invalid_request",
        `context must be text of at most ${P.MAX_CONTEXT} characters`,
      );
    return raw;
  }

  // --- MCP servers and instructions -----------------------------------------------------------------

  const mcpView = (p: Person, s: M.McpServer) => ({
    ...s,
    hasCredential: proxy.hasCredential(p.key, s.name),
  });

  const listMcpServers = ({ p }: Ctx) =>
    json({ servers: serversOf(p.key).map((s) => mcpView(p, s)) });

  function putMcpServer({ p, params, body }: Ctx) {
    const parsed = M.parseServer(params[0]!, body, cfg.mcpAllowedOrigins);
    if (typeof parsed === "string")
      throw new HttpError(400, "invalid_request", parsed);
    const servers = serversOf(p.key);
    const created = !servers.some((s) => s.name === parsed.name);
    if (created && servers.length >= M.MAX_SERVERS)
      throw new HttpError(
        409,
        "too_many_servers",
        `At most ${M.MAX_SERVERS} MCP servers can be registered.`,
        {
          maxServers: M.MAX_SERVERS,
        },
      );
    store.setSetting(
      p.key,
      "mcpServers",
      [...servers.filter((s) => s.name !== parsed.name), parsed].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    );
    return json({ server: mcpView(p, parsed) }, created ? 201 : 200);
  }

  function deleteMcpServer({ p, params }: Ctx) {
    const name = params[0]!;
    const servers = serversOf(p.key);
    if (!servers.some((s) => s.name === name)) throw NOT_FOUND();
    store.setSetting(
      p.key,
      "mcpServers",
      servers.filter((s) => s.name !== name),
    );
    proxy.setCredentials(p.key, { [name]: null });
    return noContent();
  }

  const getInstructions = ({ p }: Ctx) =>
    json({ text: store.setting<string>(p.key, "instructions") ?? "" });

  /**
   * Standing instructions for every conversation. The store keeps the canonical copy; the chat
   * workspace gets it as AGENTS.md (Codex, agy, Grok Build, goose) and CLAUDE.md (Claude Code).
   */
  async function putInstructions({ p, body }: Ctx) {
    const { text } = body;
    if (typeof text !== "string")
      throw new HttpError(400, "invalid_request", "text must be a string");
    if (text.length > MAX_INSTRUCTIONS) throw tooLong(MAX_INSTRUCTIONS);
    if (!text.trim())
      await runtime.exec(p.key, [
        "rm",
        "-f",
        `${WORKSPACE}/AGENTS.md`,
        `${WORKSPACE}/CLAUDE.md`,
      ]);
    else
      for (const name of ["AGENTS.md", "CLAUDE.md"])
        await runtime.writePrivateFile(p.key, WORKSPACE, name, text);
    store.setSetting(p.key, "instructions", text.trim() ? text : null);
    return json({ text: text.trim() ? text : "" });
  }

  const PROVIDER = "(claude|codex|grok|openrouter|gemini)";
  const routes: [string, RegExp, (c: Ctx) => Response | Promise<Response>][] = [
    ["GET", /^\/v1\/providers$/, listProviders],
    ["POST", new RegExp(`^/v1/providers/${PROVIDER}/connect$`), startConnect],
    ["GET", new RegExp(`^/v1/providers/${PROVIDER}/connect$`), getConnect],
    [
      "POST",
      new RegExp(`^/v1/providers/${PROVIDER}/connect/code$`),
      submitCode,
    ],
    [
      "DELETE",
      new RegExp(`^/v1/providers/${PROVIDER}/connect$`),
      cancelConnect,
    ],
    ["DELETE", new RegExp(`^/v1/providers/${PROVIDER}$`), disconnect],
    ["GET", /^\/v1\/events$/, events],
    ["POST", /^\/v1\/conversations$/, createConversation],
    ["GET", /^\/v1\/conversations$/, listConversations],
    ["PATCH", new RegExp(`^/v1/conversations/(${ID})$`), renameConversation],
    ["DELETE", new RegExp(`^/v1/conversations/(${ID})$`), archiveConversation],
    ["GET", new RegExp(`^/v1/conversations/(${ID})/messages$`), getMessages],
    ["POST", new RegExp(`^/v1/conversations/(${ID})/messages$`), sendMessage],
    ["POST", new RegExp(`^/v1/conversations/(${ID})/abort$`), abort],
    [
      "POST",
      new RegExp(`^/v1/conversations/(${ID})/questions/(${QUESTION_ID})$`),
      answer,
    ],
    ["GET", /^\/v1\/mcp-servers$/, listMcpServers],
    ["PUT", new RegExp(`^/v1/mcp-servers/(${M.MCP_NAME})$`), putMcpServer],
    [
      "DELETE",
      new RegExp(`^/v1/mcp-servers/(${M.MCP_NAME})$`),
      deleteMcpServer,
    ],
    ["GET", /^\/v1\/instructions$/, getInstructions],
    ["PUT", /^\/v1\/instructions$/, putInstructions],
  ];

  async function readJson(req: Request) {
    const text = await req.text();
    if (text.length > 1_000_000)
      throw new HttpError(413, "too_large", "The request is too large.");
    if (!text) return {};
    try {
      const value = JSON.parse(text);
      if (value && typeof value === "object" && !Array.isArray(value))
        return value;
    } catch {}
    // Never echo the parser's message: it can quote the body, and bodies carry codes and keys.
    throw new HttpError(
      400,
      "invalid_json",
      "The request body must be a JSON object.",
    );
  }

  async function page() {
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const html = (
      await Bun.file(join(import.meta.dir, "../public/connect.html")).text()
    )
      .replaceAll("__NONCE__", nonce)
      .replace(
        "__DEV_TOKENS__",
        String(cfg.authMode === "dev" && cfg.devTokenRoute),
      );
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      },
    });
  }

  async function fetchHandler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    let name = "unmatched";
    try {
      if (req.method === "GET" && path === "/healthz")
        return json({ ok: true, egress });
      if (req.method === "GET" && path === "/connect") return await page();
      if (
        req.method === "POST" &&
        path === "/dev/token" &&
        cfg.authMode === "dev" &&
        cfg.devTokenRoute
      ) {
        const { subject } = await readJson(req);
        if (
          typeof subject !== "string" ||
          !/^[A-Za-z0-9._@-]{1,64}$/.test(subject)
        )
          throw new HttpError(
            400,
            "invalid_request",
            "subject: 1-64 letters, digits or ._@-",
          );
        return json({ token: await devToken(cfg.devSecret, subject) });
      }
      const route = routes.find(
        ([method, re]) => method === req.method && re.test(path),
      );
      if (!route) return errorJson(404, "not_found", "Not found.");
      name = `${route[0]} ${route[1].source}`;
      const principal = await verify(req);
      if (!principal)
        return errorJson(
          401,
          "unauthorized",
          "A valid service token is required.",
        );
      const p = person(runtimeKey(cfg.serviceSecret, principal.subject));
      p.lastUsed = Date.now();
      const body = ["POST", "PUT", "PATCH"].includes(req.method)
        ? await readJson(req)
        : {};
      const params = path.match(route[1])!.slice(1);
      return await route[2]({ p, req, url, params, body, principal });
    } catch (e) {
      if (e instanceof HttpError)
        return errorJson(e.status, e.code, e.detail || e.code, e.params);
      // Log the failure class only: never request bodies, vendor output or tokens.
      log(
        "request_failed",
        name,
        (e as Error)?.name ?? "Error",
        String((e as Error)?.message ?? "").slice(0, 160),
      );
      return errorJson(503, "runtime_unavailable", UNAVAILABLE);
    }
  }

  /**
   * Forgets what a person no longer needs in memory: MCP credentials (cleared when the person has
   * been idle, as README promises), and the person object itself once nothing of theirs runs.
   */
  function idleSweep(now = Date.now()) {
    for (const p of people.values()) {
      const quiet =
        !p.clients.size &&
        !p.turns.size &&
        !p.queues.size &&
        ![...p.signIns.values()].some(
          (s) => s.state === "starting" || s.state === "waiting",
        ) &&
        !deps.agents.some((a) => a.busy(p.key));
      if (!quiet || now - p.lastUsed < cfg.idleMs) continue;
      proxy.clear(p.key);
      mcpListeners.get(p.key)?.stop(true);
      mcpListeners.delete(p.key);
      people.delete(p.key);
    }
  }

  /** Before exiting: every running turn ends now. */
  async function shutdown() {
    for (const p of people.values())
      for (const t of p.turns.values()) t.abort.abort();
    await Promise.allSettled(
      [...people.keys()].flatMap((key) =>
        deps.agents.map((a) => a.release(key)),
      ),
    );
    for (const l of mcpListeners.values()) l.stop(true);
  }

  return { fetch: fetchHandler, idleSweep, shutdown, people, mcpProxy };
}

export { HOME };
