// Tandem gateway: authenticates people, maps each one to their own runtime, and exposes only the
// /v1 façade. Everything Happy-specific lives in ./happy.ts; everything about the microVMs in ./runtime.ts.
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { devToken, verifier, type Principal } from "./auth";
import { loadConfig, type Config } from "./config";
import * as H from "./happy";
import * as M from "./mcp";
import {
  CLAUDE_MODELS_COMMAND,
  GEMINI_KEY_COMMAND,
  MicroVmRuntime,
  runtimeKey,
  type Runtime,
} from "./runtime";
import { sseComment, sseEncode, sseFrames } from "./sse";

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail = "",
    /** Every value `detail` names, for clients that word the error themselves. */
    public params: H.ErrorParams = {},
  ) {
    super(code);
  }
}

type Client = (event: string, data: unknown) => void;

/** Everything the gateway holds for one person, in memory only. */
class Person {
  daemon?: H.Daemon;
  starting?: Promise<H.Daemon>;
  stopping?: Promise<void>;
  restarting?: Promise<void>;
  /** The pending restart reloads vendor accounts (shown as `connecting`), not just config. */
  accountRestart = false;
  events?: AbortController;
  lastUsed = Date.now();
  clients = new Set<Client>();
  clis: Partial<Record<H.ProviderId, any>> = {};
  config?: any;
  memos: Partial<Record<H.ProviderId, H.CodeMemo>> = {};
  restartedOps = new Set<string>();
  /** The last API key a provider's account refused (until the next attempt): no key, only the verdict. */
  apiKeyFailures: Partial<Record<H.ProviderId, H.Connection>> = {};
  /**
   * The last settled provider views read from the running runtime, with when: what
   * /v1/providers shows while the runtime is stopped. Views only, never credentials.
   */
  known: Partial<
    Record<H.ProviderId, { view: H.ProviderView; checkedAt: number }>
  > = {};
  /**
   * Claude Code's own model names (H.claudeModelNames) for the account in `modelNamesFor`, read
   * once per account and runtime start; until the first read models keep Happy's names.
   */
  modelNames: H.ModelNames = {};
  modelNamesFor?: string;
  /** When (daemon time) a turn last failed for want of a provider's sign-in; a newer sign-in clears it. */
  signinRequired: Partial<Record<H.ProviderId, number>> = {};
  /** Registered MCP servers and title overrides, read once from the person's home. */
  mcpServers?: M.McpServer[];
  mcpWrites: Promise<unknown> = Promise.resolve();
  titles?: Record<string, string>;
  ctx: H.EventContext = {
    conversations: new Set(),
    blockTypes: new Map(),
    runFailures: new Map(),
    questions: new Map(),
  };
  constructor(public key: string) {}
}

const ID = "[a-z][a-z0-9]{1,95}";
// A new agent gets a workspace with the same ID, and Happy caps workspace IDs at 32 characters
// (a longer one fails as 500 internal), so IDs stay at 32.
const newId = () => "m" + crypto.randomUUID().replaceAll("-", "").slice(0, 31);
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "cache-control": "no-store" } });
/** Every /v1 error: clients translate `error` with `params`; `message` is the English fallback. */
const errorJson = (
  status: number,
  error: string,
  message: string,
  params: H.ErrorParams = {},
) => json({ error, message, params }, status);
const UNAVAILABLE =
  "Your workspace isn't reachable right now. Try again in a moment.";
const MODEL_UNAVAILABLE =
  "This model isn't offered by the connected account. Pick another model.";
/** The longest title, message and search query a person can write. */
const MAX_TITLE = 200;
const MAX_TEXT = 100_000;
const MAX_QUERY = 200;
/** Text the person wrote is longer than the request takes: they shorten it. */
const tooLong = (maxLength: number) =>
  new HttpError(
    400,
    "text_too_long",
    `This text is too long: at most ${maxLength} characters.`,
    { maxLength },
  );
/** How long a started runtime may take to report ready before the start counts as failed. */
const READY_TIMEOUT_MS = 300_000;

export function createGateway(
  cfg: Config,
  runtime: Runtime,
  opts: { fetchImpl?: typeof fetch; log?: (...args: unknown[]) => void } = {},
) {
  const people = new Map<string, Person>();
  const verify = verifier(cfg);
  const log = opts.log ?? ((...args: unknown[]) => console.log(...args));
  const person = (key: string) => {
    let p = people.get(key);
    if (!p) people.set(key, (p = new Person(key)));
    return p;
  };
  const emit = (p: Person, event: string, data: unknown) => {
    for (const client of p.clients) client(event, data);
  };
  // Application credentials for MCP servers live only inside the proxy, never on `Person`.
  const proxy = new M.McpProxy({
    secret: cfg.serviceSecret,
    servers: (key) => serversOf(person(key)),
    fetchImpl: opts.fetchImpl,
    log,
  });
  /** person key -> the listener on their runtime's MCP socket. */
  const mcpListeners = new Map<string, { stop(force?: boolean): void }>();
  // Detected protections (src/security.ts); /healthz reports the effective egress mode.
  let egress: string = cfg.egressMode;
  void runtime.posture?.().then(
    (p) => (egress = p.egress),
    () => {},
  );

  // --- Runtime lifecycle ----------------------------------------------------------------------

  function daemonFor(p: Person): Promise<H.Daemon> {
    p.lastUsed = Date.now();
    if (p.daemon) return Promise.resolve(p.daemon);
    return (p.starting ??= start(p, false).finally(
      () => (p.starting = undefined),
    ));
  }

  async function start(p: Person, restart: boolean) {
    const t0 = Date.now();
    await p.stopping;
    let d: H.Daemon;
    try {
      // The runtime's MCP requests arrive on its own socket: listen before it boots.
      listenMcp(p.key);
      const handle = await (restart ? runtime.restart(p.key) : runtime.ensure(p.key));
      d = new H.Daemon(handle, opts.fetchImpl);
      // A person's first start includes Happy unpacking Claude Code into their home.
      for (const until = Date.now() + READY_TIMEOUT_MS; ; await Bun.sleep(250)) {
        const health = await d.call("GET", "/v0/health").catch(() => null);
        if (health?.ready) break;
        if (Date.now() > until) throw new Error("runtime did not become ready");
      }
      await bootstrap(d, p);
    } catch (e) {
      log(`runtime start failed key=${p.key.slice(0, 8)}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      throw e;
    }
    p.daemon = d;
    // A new runtime may run another Claude Code: its model names are read again.
    p.modelNamesFor = undefined;
    subscribe(p, d);
    log(`runtime ready key=${p.key.slice(0, 8)} ms=${Date.now() - t0}`);
    return d;
  }

  /** Idempotent on every daemon start: no admin bot, and the one project conversations live in. */
  async function bootstrap(d: H.Daemon, p: Person) {
    const { bots } = await d.call("GET", "/v0/bots");
    for (const bot of bots)
      if (bot.status === "active")
        await d.call(
          "POST",
          `/v0/bots/${bot.id}/archive`,
          {},
          { "if-match": bot.version },
        );
    let project = await d
      .call("GET", `/v0/projects/${H.PROJECT_ID}`)
      .then((r) => r.project)
      .catch((e) =>
        e instanceof H.DaemonError && e.status === 404
          ? null
          : Promise.reject(e),
      );
    if (!project)
      project = (
        await d.call("POST", "/v0/projects", {
          path: H.PROJECT_PATH,
          projectId: H.PROJECT_ID,
        })
      ).project;
    for (
      const until = Date.now() + 30_000;
      project.initialization?.status !== "ready";
    ) {
      if (Date.now() > until) throw new Error("project did not initialize");
      await Bun.sleep(250);
      project = (await d.call("GET", `/v0/projects/${H.PROJECT_ID}`)).project;
    }
    for (const agent of project.agents ?? [])
      if (H.isConversationAgent(agent)) p.ctx.conversations.add(agent.id);
  }

  function subscribe(p: Person, d: H.Daemon) {
    p.events?.abort();
    const ac = (p.events = new AbortController());
    void (async () => {
      let last: string | undefined;
      while (!ac.signal.aborted && p.daemon === d) {
        try {
          const res = await d.stream(last, ac.signal);
          if (!res.ok || !res.body) throw new Error("stream refused");
          for await (const frame of sseFrames(res.body)) {
            if (frame.id) last = frame.id;
            if (frame.event !== "hello" && frame.data)
              onDaemonEvent(p, d, JSON.parse(frame.data));
          }
        } catch {}
        if (ac.signal.aborted || p.daemon !== d) return;
        // The stream ends at once when a runtime is stopped or dies outside the gateway's control.
        const alive = await d
          .call("GET", "/v0/health", undefined, {}, 3000)
          .then(
            (h) => h?.ready,
            () => false,
          );
        if (!alive) return forget(p, d, "went away");
        await Bun.sleep(1000);
      }
    })();
  }

  /**
   * Drops a runtime handle that no longer answers. An open event stream starts it again at once;
   * otherwise the next change or event stream does.
   */
  function forget(p: Person, d: H.Daemon, why: string) {
    if (p.daemon !== d) return;
    p.events?.abort();
    p.daemon = undefined;
    p.config = undefined;
    p.clis = {};
    proxy.clear(p.key);
    log(`runtime ${why} key=${p.key.slice(0, 8)}`);
    if (p.clients.size > 0 && !p.starting)
      // A restart, not a start: a runtime whose daemon just stopped answering can still be
      // shutting down, and only a restart waits for that. One that is gone is created again.
      void (p.starting = start(p, true)
        .catch(() => start(p, false))
        .finally(() => (p.starting = undefined))).then(
        () => H.PROVIDER_IDS.forEach((id) => void publish(p, id)),
        (e) => log("restart failed", (e as Error).message),
      );
  }

  function onDaemonEvent(
    p: Person,
    d: H.Daemon,
    ev: { type: string; payload: any },
  ) {
    if (ev.type === "provider_cli.updated") {
      const cli = ev.payload?.providerCli;
      if (!H.PROVIDER_IDS.includes(cli?.id)) return;
      sawCli(p, cli.id, cli);
      if (
        cli.operation?.kind === "sign_in" &&
        cli.operation.status === "succeeded"
      )
        void afterSignIn(p, d, cli).catch(() => {});
      void publish(p, cli.id);
    } else if (ev.type === "config.updated") {
      p.config = undefined;
      for (const id of H.PROVIDER_IDS) void publish(p, id);
    } else {
      // Happy keeps reporting an expired account as signed in; the failed turn is the evidence.
      const signout = H.signinFailure(ev);
      if (signout && signout.at >= d.handle.startedAt) {
        p.signinRequired[signout.provider] = signout.at;
        void publish(p, signout.provider);
      }
      for (const f of H.mapEvent(ev, p.ctx, p.config)) emit(p, f.type, f.data);
    }
  }

  async function isBusy(d: H.Daemon) {
    const { project } = await d.call("GET", `/v0/projects/${H.PROJECT_ID}`);
    const clis = [];
    for (const cli of H.CLI_IDS)
      clis.push((await d.call("GET", `/v0/provider-clis/${cli}`)).providerCli);
    return H.hasWork(project, clis);
  }

  /**
   * Restarts the runtime once it is idle, so harnesses reload credentials and the live model list
   * ("account"), or the daemon reads a changed MCP configuration ("config").
   */
  function restartRuntime(
    p: Person,
    maxWaitMs: number,
    reason: "account" | "config" = "account",
  ) {
    if (reason === "account") p.accountRestart = true;
    return (p.restarting ??= (async () => {
      try {
        for (const id of H.PROVIDER_IDS) void publish(p, id);
        for (
          const until = Date.now() + maxWaitMs;
          Date.now() < until;
          await Bun.sleep(2000)
        )
          if (!(await isBusy(await daemonFor(p)).catch(() => false))) break;
        p.events?.abort();
        p.daemon = undefined;
        p.config = undefined;
        p.clis = {};
        p.starting = start(p, true);
        await p.starting;
      } finally {
        p.starting = undefined;
        p.restarting = undefined;
        p.accountRestart = false;
        for (const id of H.PROVIDER_IDS) void publish(p, id);
      }
    })());
  }

  async function afterSignIn(p: Person, d: H.Daemon, cli: any) {
    const op = cli.operation;
    if (!cfg.restartAfterSignIn || p.restartedOps.has(op.id)) return;
    if (!(op.finishedAt >= d.handle.startedAt)) return; // finished before this daemon started
    p.restartedOps.add(op.id);
    await restartRuntime(p, 10 * 60_000);
  }

  async function stopRuntime(p: Person) {
    p.events?.abort();
    p.daemon = undefined;
    p.config = undefined;
    p.clis = {};
    proxy.clear(p.key); // credentials last only while the runtime runs
    p.stopping = runtime.stop(p.key).finally(() => (p.stopping = undefined));
    await p.stopping;
    closeMcp(p.key);
    log(`runtime stopped key=${p.key.slice(0, 8)} (idle)`);
  }

  /**
   * Stops runtimes unused for IDLE_MINUTES. An open event stream counts as use (closing it is the
   * last use), and so does a run or sign-in in progress.
   */
  async function idleSweep() {
    for (const p of people.values()) {
      if (
        !p.daemon ||
        p.starting ||
        p.restarting ||
        p.clients.size > 0 ||
        Date.now() - p.lastUsed < cfg.idleMs
      )
        continue;
      const busy = await isBusy(p.daemon).catch(() => false);
      if (busy) p.lastUsed = Date.now();
      else
        await stopRuntime(p).catch((e) =>
          log("runtime stop failed", (e as Error).message),
        );
    }
    // Adopt runtimes started outside the gateway (manual restart, crash recovery) so they idle out too.
    for (const key of await runtime.listRunning().catch(() => [])) {
      const p = person(key);
      if (!p.daemon && !p.starting && !p.stopping)
        void daemonFor(p).catch((e) =>
          log("adopt failed", (e as Error).message),
        );
    }
  }

  async function rediscover() {
    for (const key of await runtime.listRunning())
      void daemonFor(person(key)).catch((e) =>
        log("rediscovery failed", (e as Error).message),
      );
  }

  // --- Provider state ---------------------------------------------------------------------------

  /**
   * The person's daemon. With `start` false (reads) only one that is up or already starting:
   * nothing is started, and a stopped runtime is `409 runtime_stopped`.
   */
  function daemonOf(p: Person, start = true) {
    if (start || p.daemon || p.starting) return daemonFor(p);
    return Promise.reject(
      new HttpError(
        409,
        "runtime_stopped",
        "The workspace is stopped. Opening /v1/events starts it.",
      ),
    );
  }

  async function configOf(p: Person, start = true) {
    return (p.config ??= (
      await (await daemonOf(p, start)).call("GET", "/v0/config")
    ).config);
  }

  /** The provider's sign-in CLI; null for an account that takes only an API key. */
  async function cliOf(p: Person, id: H.ProviderId, start = true) {
    const d = await daemonOf(p, start);
    if (!H.CLI_IDS.includes(id)) return null;
    const { providerCli } = await d.call("GET", `/v0/provider-clis/${id}`);
    return sawCli(p, id, providerCli);
  }

  /** Every provider CLI state passes here: a sign-in finished after a failed turn clears its verdict. */
  function sawCli(p: Person, id: H.ProviderId, cli: any) {
    const op = cli?.operation;
    if (
      op?.kind === "sign_in" &&
      op.status === "succeeded" &&
      op.finishedAt >= (p.signinRequired[id] ?? Infinity)
    )
      delete p.signinRequired[id];
    return (p.clis[id] = cli);
  }

  function connectionFor(p: Person, id: H.ProviderId, cli: any, config: any) {
    const op = cli?.operation?.kind === "sign_in" ? cli.operation : null;
    const signingIn = op && ["running", "waiting"].includes(op.status);
    const signinRequired = id in p.signinRequired;
    if (H.apiKeyOf(id) && !signingIn) {
      if (H.usesApiKey(config, id) && !signinRequired)
        return H.apiKeyConnection("connected");
      if (p.apiKeyFailures[id]) return p.apiKeyFailures[id];
    }
    return H.connectionView(id, cli, p.memos[id], {
      restarting: !!p.restarting && p.accountRestart,
      signinRequired,
    });
  }

  async function state(
    p: Person,
    id: H.ProviderId,
    fresh = true,
    start = true,
  ) {
    const cli = fresh || !p.clis[id] ? await cliOf(p, id, start) : p.clis[id];
    const config = await configOf(p, start);
    const provider = H.providerView(id, cli, config, {
      restarting: !!p.restarting && p.accountRestart,
      signinRequired: id in p.signinRequired,
      names: id === "claude" ? p.modelNames : undefined,
    });
    if (id === "claude" && provider.status === "connected")
      readModelNames(p, provider);
    const checkedAt = Date.now();
    // Only settled views are remembered: a sign-in in progress ends with its runtime.
    if (provider.status !== "connecting")
      p.known[id] = { view: provider, checkedAt };
    return {
      provider: { ...provider, checkedAt: new Date(checkedAt).toISOString() },
      connection: connectionFor(p, id, cli, config),
    };
  }

  /**
   * Reads Claude Code's model names for a newly connected account in the background, then sends
   * the renamed models. Failing leaves Happy's names; the next account or runtime start retries.
   */
  function readModelNames(p: Person, provider: H.ProviderView) {
    const account = `${provider.method}:${provider.account?.email ?? ""}`;
    if (p.modelNamesFor === account) return;
    p.modelNamesFor = account;
    void runtime
      .exec(p.key, CLAUDE_MODELS_COMMAND)
      .then((r) => {
        const names = r.exitCode === 0 ? H.claudeModelNames(r.stdout) : {};
        if (p.modelNamesFor !== account || Object.keys(names).length === 0)
          return;
        p.modelNames = names;
        return publish(p, "claude");
      })
      .catch(() => {});
  }

  /**
   * The state remembered from the running runtime, marked with when it was read. Before the first
   * read since the gateway started it is `unknown`, with `checkedAt: null`.
   */
  function lastKnown(p: Person, id: H.ProviderId) {
    const known = p.known[id];
    if (!known)
      return {
        id,
        status: "unknown" as const,
        method: null,
        account: null,
        models: [],
        checkedAt: null,
      };
    return {
      ...known.view,
      checkedAt: new Date(known.checkedAt).toISOString(),
    };
  }

  /**
   * Sends the live state to the person's clients. Without a client it only refreshes the
   * last-known state from a runtime that is up: nothing is started just to remember it.
   */
  async function publish(p: Person, id: H.ProviderId) {
    const clients = p.clients.size > 0;
    const s = await state(p, id, false, clients).catch(() => null);
    if (s && clients) emit(p, "provider.updated", s);
  }

  async function waitOp(
    p: Person,
    id: H.ProviderId,
    done: (op: any) => boolean,
    ms: number,
  ) {
    let cli = await cliOf(p, id);
    for (
      const until = Date.now() + ms;
      !done(cli.operation ?? {}) && Date.now() < until;
    ) {
      await Bun.sleep(300);
      cli = await cliOf(p, id);
    }
    return cli;
  }

  // --- Files the gateway keeps in the person's home --------------------------------------------------

  /** One file from a running runtime; empty when it does not exist (cat exits 1). */
  async function readFile(p: Person, path: string) {
    const r = await runtime.exec(p.key, ["cat", path]);
    if (r.exitCode === 0) return r.stdout;
    if (r.exitCode === 1) return "";
    // Killed or never started (the runtime is restarting): never mistake that for an empty file,
    // which would drop the person's registrations.
    throw new Error(`reading a runtime file failed (exit ${r.exitCode})`);
  }

  async function serversOf(p: Person) {
    if (p.mcpServers) return p.mcpServers;
    const text = await readFile(p, `${M.MCP_DIR}/${M.REGISTRY_FILE}`);
    const servers = M.openRegistry(cfg.serviceSecret, p.key, text);
    if (!servers)
      log(
        `mcp registrations ignored (changed outside the gateway) key=${p.key.slice(0, 8)}`,
      );
    return (p.mcpServers = servers ?? []);
  }

  async function titlesOf(p: Person) {
    if (p.titles) return p.titles;
    let titles: Record<string, string> = {};
    try {
      const parsed = JSON.parse(
        (await readFile(p, `${H.RUNTIME_DIR}/${H.TITLES_FILE}`)) || "{}",
      );
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        titles = Object.fromEntries(
          Object.entries(parsed).filter(([, v]) => typeof v === "string"),
        ) as Record<string, string>;
    } catch {}
    return (p.titles = titles);
  }

  const view = async (p: Person, agent: any, mode: any) =>
    H.conversationView(agent, mode, (await titlesOf(p))[agent.id]);

  // --- /v1 handlers -------------------------------------------------------------------------------

  type Ctx = {
    p: Person;
    req: Request;
    url: URL;
    params: string[];
    body: any;
    principal: Principal;
  };

  /**
   * Never starts a runtime. A running one answers live (a restart is waited for); otherwise the
   * answer comes at once from the last-known state. Opening /v1/events starts the runtime and
   * delivers the live state as `provider.updated`.
   */
  async function listProviders({ p }: Ctx) {
    if (!p.daemon && !p.restarting)
      return json({
        providers: H.PROVIDER_IDS.map((id) => lastKnown(p, id)),
      });
    const states = await Promise.all(
      H.PROVIDER_IDS.map((id) => state(p, id, true, false)),
    );
    return json({ providers: states.map((s) => s.provider) });
  }

  async function startConnect({ p, params, body }: Ctx) {
    const id = params[0] as H.ProviderId;
    if (body.method === "api_key") {
      if (!H.apiKeyOf(id))
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
    const method = H.providerMethod(id);
    if (!method)
      throw new HttpError(
        400,
        "invalid_request",
        "This provider connects with your own API key: send method api_key.",
      );
    const d = await daemonFor(p);
    let cli = await cliOf(p, id);
    delete p.apiKeyFailures[id];
    delete p.memos[id];
    if (
      cli.installation?.status === "installed" &&
      cli.signIn?.methods?.includes(method)
    ) {
      await d.call("POST", `/v0/provider-clis/${id}/sign-in`, { method });
      cli = await waitOp(p, id, (op) => op.status !== "running", 30_000);
      const auth = cli.operation?.authorization;
      // A browser sign-in that cannot take a pasted code would finish only inside the runtime.
      if (
        cli.operation?.status !== "waiting" ||
        auth?.method !== "browser" ||
        auth.acceptsCode
      )
        return json({
          connection: connectionFor(p, id, cli, await configOf(p)),
        });
      await d.call("POST", `/v0/provider-clis/${id}/cancel`, {});
    }
    return json({ connection: H.unavailableConnection(id) });
  }

  async function connectApiKey(p: Person, id: H.ProviderId, apiKey: unknown) {
    const spec = H.apiKeyOf(id)!;
    const key = typeof apiKey === "string" ? apiKey.trim() : "";
    if (!/^[A-Za-z0-9_-]{20,512}$/.test(key))
      throw new HttpError(
        400,
        "invalid_api_key_format",
        `Paste the whole key. ${spec.hint}`,
        { provider: id },
      );
    const d = await daemonFor(p);
    // Choosing a key replaces any subscription sign-in still waiting for this person.
    if (H.CLI_IDS.includes(id))
      await d.call("POST", `/v0/provider-clis/${id}/cancel`, {});
    // The key goes straight into the person's own home (standard input: no argv, env or logs) and
    // becomes Happy's documented `api_key` for the provider's account on the next daemon start.
    await runtime.writePrivateFile(p.key, H.RUNTIME_DIR, spec.file, `${key}\n`);
    await restartRuntime(p, 2 * 60_000);
    // Happy checks its own accounts; it cannot check a Gemini key on the Antigravity account.
    const passed =
      id === "gemini"
        ? (await runtime.exec(p.key, GEMINI_KEY_COMMAND)).exitCode === 0
        : (
            await (await daemonFor(p))
              .call("POST", `/v0/providers/${id}/verify`, {
                level: "authentication",
              })
              .catch(() => null)
          )?.status === "passed";
    if (passed) {
      delete p.apiKeyFailures[id];
      delete p.signinRequired[id];
      void publish(p, id);
      return H.apiKeyConnection("connected");
    }
    await runtime.exec(p.key, ["rm", "-f", `${H.RUNTIME_DIR}/${spec.file}`]);
    await restartRuntime(p, 2 * 60_000);
    return (p.apiKeyFailures[id] = H.apiKeyConnection(
      "failed",
      H.invalidApiKey(id),
    ));
  }

  async function getConnect({ p, params }: Ctx) {
    return json({
      connection: (await state(p, params[0] as H.ProviderId, true, false))
        .connection,
    });
  }

  async function submitCode({ p, params, body }: Ctx) {
    const id = params[0] as H.ProviderId;
    // The code is held only in this request's memory: never logged, stored or echoed.
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!code || code.length > 2048 || /[\u0000-\u001f\u007f]/.test(code))
      throw new HttpError(
        400,
        "invalid_code",
        "Paste the code shown on the sign-in page.",
      );
    const d = await daemonFor(p);
    let cli = await cliOf(p, id);
    const op = cli?.operation;
    if (!(
      op?.kind === "sign_in" &&
      op.status === "waiting" &&
      op.authorization?.acceptsCode
    ))
      throw new HttpError(
        409,
        "not_waiting_for_code",
        "This sign-in isn't waiting for a code.",
      );
    const memo: H.CodeMemo = {
      opId: op.id,
      before: op.output ?? [],
      wrong: false,
    };
    p.memos[id] = memo;
    await d.call("POST", `/v0/provider-clis/${id}/sign-in/code`, { code });
    for (const until = Date.now() + 30_000; Date.now() < until;) {
      await Bun.sleep(400);
      try {
        cli = await cliOf(p, id);
      } catch {
        if (p.restarting) await p.restarting;
        continue;
      }
      const cur = cli.operation;
      if (cur?.id !== memo.opId) break;
      const rejected = H.codeRejection(
        H.newLines(memo.before, cur.output ?? []),
      );
      if (cur.status === "succeeded") {
        await afterSignIn(p, d, cli);
        cli = await cliOf(p, id);
        break;
      }
      if (rejected === "retry" && cur.status === "waiting") {
        memo.wrong = true;
        break;
      }
      if (rejected === "restart") {
        if (cur.status !== "failed") continue; // the CLI is still winding this attempt down
        // The CLI ended this attempt. Start a fresh one so the person can simply try again.
        await d.call("POST", `/v0/provider-clis/${id}/sign-in`, {
          method: H.providerMethod(id),
        });
        cli = await waitOp(p, id, (o) => o.status !== "running", 30_000);
        p.memos[id] = {
          opId: cli.operation.id,
          before: cli.operation.output ?? [],
          wrong: true,
          reissued: true,
        };
        break;
      }
      if (["failed", "cancelled"].includes(cur.status)) break;
    }
    return json({ connection: connectionFor(p, id, cli, await configOf(p)) });
  }

  /** Cancels a sign-in in progress; an account that takes only an API key has none. */
  async function cancelConnect({ p, params }: Ctx) {
    const id = params[0] as H.ProviderId;
    const d = await daemonFor(p);
    const providerCli = H.CLI_IDS.includes(id)
      ? sawCli(
          p,
          id,
          (await d.call("POST", `/v0/provider-clis/${id}/cancel`, {}))
            .providerCli,
        )
      : null;
    delete p.memos[id];
    return json({
      connection: connectionFor(p, id, providerCli, await configOf(p)),
    });
  }

  async function disconnect({ p, params }: Ctx) {
    const id = params[0] as H.ProviderId;
    const d = await daemonFor(p);
    if (H.CLI_IDS.includes(id))
      await d
        .call("POST", `/v0/provider-clis/${id}/cancel`, {})
        .catch(() => {});
    // Happy has no sign-out route: use the vendor CLI's own logout where it has one, then make
    // sure no credential file is left in the home.
    await runtime.exec(p.key, H.SIGN_OUT[id]);
    delete p.memos[id];
    delete p.signinRequired[id];
    delete p.apiKeyFailures[id];
    await restartRuntime(p, 2 * 60_000); // warm harness processes must drop the old sign-in
    return json({ provider: (await state(p, id)).provider });
  }

  /**
   * The person's live events. Opening the stream is what starts a stopped runtime (reads never do),
   * and an open stream keeps it from stopping when idle; its first `provider.updated` per provider
   * is the live state once the runtime is up.
   */
  function events({ p, req, principal }: Ctx) {
    let send: Client | undefined;
    let timers: Timer[] = [];
    // Leaving is the client's last use: the idle period starts then.
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
        for (const id of H.PROVIDER_IDS)
          void state(p, id).then(
            (s) => send?.("provider.updated", s),
            () => {},
          );
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

  async function conversationAgent(d: H.Daemon, p: Person, id: string) {
    const agent = await d
      .call("GET", `/v0/agents/${id}`)
      .then((r) => r.agent)
      .catch((e) =>
        e instanceof H.DaemonError && e.status === 404
          ? null
          : Promise.reject(e),
      );
    if (!H.isConversationAgent(agent))
      throw new HttpError(404, "not_found", "Not found.");
    p.ctx.conversations.add(id);
    return agent;
  }

  async function modeOf(d: H.Daemon, id: string) {
    const { mode } = await d.call("GET", `/v0/agents/${id}/mode`);
    if (mode) return mode;
    const { draft } = await d.call("GET", `/v0/agents/${id}/draft`);
    if (!draft?.value) return null;
    const { text: _text, ...draftMode } = draft.value;
    return draftMode;
  }

  async function createConversation({ p, body }: Ctx) {
    const { provider, model, effort, title } = body;
    if (!H.PROVIDER_IDS.includes(provider) || typeof model !== "string")
      throw new HttpError(
        400,
        "invalid_request",
        "provider and model are required",
      );
    if (title !== undefined && typeof title !== "string")
      throw new HttpError(400, "invalid_request", "title must be a string");
    if (title?.length > MAX_TITLE) throw tooLong(MAX_TITLE);
    const { provider: view } = await state(p, provider);
    if (view.status !== "connected")
      throw new HttpError(
        409,
        "signin_required",
        `Connect your ${H.vendorOf(provider)} account first.`,
        { provider },
      );
    const m = view.models.find((x) => x.id === model);
    if (!m) throw new HttpError(422, "model_unavailable", MODEL_UNAVAILABLE);
    const chosenEffort = effort ?? m.defaultEffort;
    if (!m.efforts.includes(chosenEffort))
      throw new HttpError(
        422,
        "invalid_effort",
        `effort must be one of ${m.efforts.join(", ")}`,
        { efforts: m.efforts },
      );
    const d = await daemonFor(p);
    const id = newId();
    const { agent } = await d.call("POST", "/v0/agents", {
      workspaceId: H.PROJECT_ID,
      id,
      ...(title ? { title } : {}),
    });
    const mode = {
      providerId: H.happyId(provider),
      modelId: model,
      effort: chosenEffort,
      serviceTier: null,
      permissionMode: cfg.permissionMode,
    };
    // The draft carries the conversation's model until its first message: no gateway database.
    await d.call("PUT", `/v0/agents/${id}/draft`, {
      draft: { text: "", ...mode },
    });
    p.ctx.conversations.add(id);
    return json({ conversation: H.conversationView(agent, mode) }, 201);
  }

  /** Newest activity first; `cursor` continues after the last item of the previous page. */
  async function listConversations({ p, url }: Ctx) {
    const limit = Math.min(
      200,
      Math.max(1, Number(url.searchParams.get("limit")) || 50),
    );
    const query = (url.searchParams.get("query") ?? "").trim().toLowerCase();
    if (query.length > MAX_QUERY) throw tooLong(MAX_QUERY);
    const rawCursor = url.searchParams.get("cursor");
    const cursor = rawCursor ? H.decodeCursor(rawCursor) : null;
    if (rawCursor && !cursor)
      throw new HttpError(400, "invalid_request", "cursor is not valid");
    const d = await daemonOf(p, false);
    const { project } = await d.call("GET", `/v0/projects/${H.PROJECT_ID}`);
    const titles = await titlesOf(p);
    const at = (a: any) => Number(a.lastActivityAt ?? a.createdAt) || 0;
    const agents = (project.agents ?? [])
      .filter(H.isConversationAgent)
      .filter(
        (a: any) =>
          !query ||
          String(titles[a.id] ?? a.title ?? "")
            .toLowerCase()
            .includes(query),
      )
      .sort((a: any, b: any) => at(b) - at(a) || (a.id < b.id ? -1 : 1))
      .filter(
        (a: any) =>
          !cursor ||
          at(a) < cursor.at ||
          (at(a) === cursor.at && a.id > cursor.id),
      );
    const page = agents.slice(0, limit);
    const views = await Promise.all(
      page.map(async (a: any) => view(p, a, await modeOf(d, a.id))),
    );
    const last = page.at(-1);
    return json({
      conversations: views,
      nextCursor:
        agents.length > limit && last
          ? H.encodeCursor(at(last), last.id)
          : null,
    });
  }

  async function renameConversation({ p, params, body }: Ctx) {
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
    const d = await daemonFor(p);
    const agent = await conversationAgent(d, p, params[0]!);
    // Happy has no rename: the gateway keeps the person's own titles in their home.
    const titles = { ...(await titlesOf(p)) };
    if (clean === null) delete titles[agent.id];
    else titles[agent.id] = clean;
    await runtime.writePrivateFile(
      p.key,
      H.RUNTIME_DIR,
      H.TITLES_FILE,
      `${JSON.stringify(titles)}\n`,
    );
    p.titles = titles;
    return json({
      conversation: await view(p, agent, await modeOf(d, agent.id)),
    });
  }

  /** Archives: Happy keeps the history, the conversation leaves every list and takes no messages. */
  async function archiveConversation({ p, params }: Ctx) {
    const d = await daemonFor(p);
    const agent = await conversationAgent(d, p, params[0]!);
    await d.call("POST", `/v0/agents/${agent.id}/archive`, {});
    p.ctx.conversations.delete(agent.id);
    return new Response(null, {
      status: 204,
      headers: { "cache-control": "no-store" },
    });
  }

  async function getMessages({ p, params, url }: Ctx) {
    const d = await daemonOf(p, false);
    const agent = await conversationAgent(d, p, params[0]!);
    const q = new URLSearchParams({
      limit: String(
        Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50)),
      ),
      omitToolData: "true",
    });
    const before = url.searchParams.get("before");
    if (before && new RegExp(`^${ID}$`).test(before)) q.set("before", before);
    const page = await d.call("GET", `/v0/agents/${agent.id}/messages?${q}`);
    const messages: H.ChatMessage[] = [];
    const runs = page.runs.map((run: any) => {
      let failure: H.Failure | null = null;
      for (const m of run.messages ?? []) {
        const n = H.normalizeMessage(m, run.id);
        if (n) messages.push(n);
        if (n?.failure) failure = n.failure;
      }
      return H.normalizeRun(run, failure);
    });
    const { question } = await d.call("GET", `/v0/agents/${agent.id}/question`);
    const report = await d.call("GET", `/v0/agents/${agent.id}/usage`);
    return json({
      conversation: await view(p, agent, await modeOf(d, agent.id)),
      messages,
      runs,
      hasMore: !!page.hasMore,
      question: question ? H.normalizeQuestion(question) : null,
      context: H.contextView(report.context, await configOf(p, false)),
      usage: H.usageView(report),
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
    // Before the runtime starts: a cold start's MCP connections then find the credential waiting.
    if (auth) proxy.setCredentials(p.key, auth);
    const d = await daemonFor(p);
    const agent = await conversationAgent(d, p, params[0]!);
    const current = await modeOf(d, agent.id);
    if (!current)
      throw new HttpError(
        409,
        "conversation_has_no_model",
        "This conversation has no model. Start a new conversation.",
      );
    let mode = {
      ...current,
      serviceTier: null,
      permissionMode: cfg.permissionMode,
    };
    if (model !== undefined || effort !== undefined) {
      const provider = H.providerOf(current.providerId);
      const names = provider === "claude" ? p.modelNames : undefined;
      const m = (
        provider ? H.liveModels(await configOf(p), provider, names) : []
      ).find((x) => x.id === (model ?? current.modelId));
      if (!m) throw new HttpError(422, "model_unavailable", MODEL_UNAVAILABLE);
      const e =
        effort ??
        (m.efforts.includes(current.effort) ? current.effort : m.defaultEffort);
      if (!m.efforts.includes(e))
        throw new HttpError(
          422,
          "invalid_effort",
          `effort must be one of ${m.efforts.join(", ")}`,
          { efforts: m.efforts },
        );
      mode = { ...mode, modelId: m.id, effort: e };
    }
    // A server that was waiting for this credential lists its tools before the turn starts.
    if (auth) await proxy.settle(p.key, 5000);
    const sent = await d
      .call("POST", `/v0/agents/${agent.id}/send`, {
        id: newId(),
        text: H.withContext(text, context),
        mode,
      })
      .catch((e) => {
        // The daemon checks the mode against the live model catalog.
        if (e instanceof H.DaemonError && e.status === 400)
          throw new HttpError(422, "model_unavailable", MODEL_UNAVAILABLE);
        throw e;
      });
    return json(
      {
        message: H.normalizeMessage(sent.message, null),
        conversation: await view(p, agent, mode),
      },
      202,
    );
  }

  async function abort({ p, params }: Ctx) {
    const d = await daemonFor(p);
    const agent = await conversationAgent(d, p, params[0]!);
    const r = await d.call("POST", `/v0/agents/${agent.id}/abort`, {});
    return json(
      {
        conversation: await view(
          p,
          r.agent ?? agent,
          await modeOf(d, agent.id),
        ),
      },
      202,
    );
  }

  async function answer({ p, params, body }: Ctx) {
    const d = await daemonFor(p);
    const agent = await conversationAgent(d, p, params[0]!);
    // Answered meanwhile (another client, a timeout, a stopped run) or never this conversation's.
    const notPending = () =>
      new HttpError(
        409,
        "question_not_pending",
        "This question isn't waiting for an answer any more.",
      );
    const { question } = await d.call("GET", `/v0/agents/${agent.id}/question`);
    if (!question || question.id !== params[1]) throw notPending();
    const answers = H.questionAnswers(question, body.answer);
    if (!answers)
      throw new HttpError(
        400,
        "invalid_answer",
        "answer must name an option or give text for every prompt",
      );
    const r = await d
      .call("POST", `/v0/agents/${agent.id}/question/${question.id}/answer`, {
        answers,
      })
      .catch((e) => {
        if (e instanceof H.DaemonError && e.status === 409) throw notPending();
        throw e;
      });
    return json({ question: H.normalizeQuestion(r.question) });
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
      raw.length > H.MAX_CONTEXT ||
      raw.includes(H.CONTEXT_CLOSE)
    )
      throw new HttpError(
        400,
        "invalid_request",
        `context must be text of at most ${H.MAX_CONTEXT} characters`,
      );
    return raw;
  }

  // --- MCP servers and instructions -----------------------------------------------------------------

  const mcpView = (p: Person, s: M.McpServer) => ({
    ...s,
    hasCredential: proxy.hasCredential(p.key, s.name),
  });

  async function listMcpServers({ p }: Ctx) {
    await daemonOf(p, false);
    return json({ servers: (await serversOf(p)).map((s) => mcpView(p, s)) });
  }

  /** Writes registrations and Happy's config template; restarts when idle if the template changed. */
  function changeServers(
    p: Person,
    change: (servers: M.McpServer[]) => M.McpServer[],
  ) {
    const write = p.mcpWrites.then(async () => {
      await daemonFor(p);
      const before = await serversOf(p);
      const after = change(before).sort((a, b) => a.name.localeCompare(b.name));
      await runtime.writePrivateFile(
        p.key,
        M.MCP_DIR,
        M.REGISTRY_FILE,
        M.sealRegistry(cfg.serviceSecret, p.key, after),
      );
      const template = M.renderMcpToml(after);
      await runtime.writePrivateFile(
        p.key,
        M.MCP_DIR,
        M.TEMPLATE_FILE,
        template,
      );
      p.mcpServers = after;
      // Happy reads mcp.toml when it starts; the entrypoint installs the template then.
      if (template !== M.renderMcpToml(before))
        void restartRuntime(p, 10 * 60_000, "config").catch((e) =>
          log("config restart failed", (e as Error).message),
        );
      return after;
    });
    p.mcpWrites = write.catch(() => {});
    return write;
  }

  async function putMcpServer({ p, params, body }: Ctx) {
    const parsed = M.parseServer(params[0]!, body, cfg.mcpAllowedOrigins);
    if (typeof parsed === "string")
      throw new HttpError(400, "invalid_request", parsed);
    let created = false;
    await changeServers(p, (servers) => {
      created = !servers.some((s) => s.name === parsed.name);
      if (created && servers.length >= M.MAX_SERVERS)
        throw new HttpError(
          409,
          "too_many_servers",
          `At most ${M.MAX_SERVERS} MCP servers can be registered.`,
          { maxServers: M.MAX_SERVERS },
        );
      return [...servers.filter((s) => s.name !== parsed.name), parsed];
    });
    return json({ server: mcpView(p, parsed) }, created ? 201 : 200);
  }

  async function deleteMcpServer({ p, params }: Ctx) {
    const name = params[0]!;
    await changeServers(p, (servers) => {
      if (!servers.some((s) => s.name === name))
        throw new HttpError(404, "not_found", "Not found.");
      return servers.filter((s) => s.name !== name);
    });
    proxy.setCredentials(p.key, { [name]: null });
    return new Response(null, {
      status: 204,
      headers: { "cache-control": "no-store" },
    });
  }

  async function getInstructions({ p }: Ctx) {
    await daemonOf(p, false);
    return json({
      text: await readFile(p, `${H.RUNTIME_DIR}/${H.INSTRUCTIONS_FILE}`),
    });
  }

  /**
   * Standing instructions for every conversation: AGENTS.md (Codex, Gemini's Antigravity CLI, and
   * Happy's own loop for Grok and OpenRouter) and CLAUDE.md (Claude Code).
   */
  async function putInstructions({ p, body }: Ctx) {
    const { text } = body;
    if (typeof text !== "string")
      throw new HttpError(400, "invalid_request", "text must be a string");
    if (text.length > H.MAX_INSTRUCTIONS) throw tooLong(H.MAX_INSTRUCTIONS);
    await daemonFor(p);
    const files: [string, string][] = [
      [H.RUNTIME_DIR, H.INSTRUCTIONS_FILE],
      [H.PROJECT_PATH, "AGENTS.md"],
      [H.PROJECT_PATH, "CLAUDE.md"],
    ];
    if (!text.trim())
      await runtime.exec(p.key, [
        "rm",
        "-f",
        ...files.map(([dir, name]) => `${dir}/${name}`),
      ]);
    else
      for (const [dir, name] of files)
        await runtime.writePrivateFile(p.key, dir, name, text);
    return json({ text: text.trim() ? text : "" });
  }

  const routes: [string, RegExp, (c: Ctx) => Response | Promise<Response>][] = [
    ["GET", /^\/v1\/providers$/, listProviders],
    ["POST", /^\/v1\/providers\/(claude|codex|grok|openrouter|gemini)\/connect$/, startConnect],
    ["GET", /^\/v1\/providers\/(claude|codex|grok|openrouter|gemini)\/connect$/, getConnect],
    ["POST", /^\/v1\/providers\/(claude|codex|grok|openrouter|gemini)\/connect\/code$/, submitCode],
    ["DELETE", /^\/v1\/providers\/(claude|codex|grok|openrouter|gemini)\/connect$/, cancelConnect],
    ["DELETE", /^\/v1\/providers\/(claude|codex|grok|openrouter|gemini)$/, disconnect],
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
      new RegExp(`^/v1/conversations/(${ID})/questions/(${H.QUESTION_ID})$`),
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
      const body = ["POST", "PUT", "PATCH"].includes(req.method)
        ? await readJson(req)
        : {};
      const params = path.match(route[1])!.slice(1);
      const ctx = { p, req, url, params, body, principal };
      const d = p.daemon;
      try {
        return await route[2](ctx);
      } catch (e) {
        // A runtime stopped behind the gateway's back: start it again and retry once.
        if (!(e instanceof H.DaemonUnreachable) || !d) throw e;
        forget(p, d, "unreachable");
        return await route[2](ctx);
      }
    } catch (e) {
      if (e instanceof HttpError)
        return errorJson(e.status, e.code, e.detail || e.code, e.params);
      if (e instanceof H.DaemonError) {
        if (e.status === 404) return errorJson(404, "not_found", "Not found.");
        if (e.status === 409)
          return errorJson(
            409,
            "conflict",
            "That changed meanwhile. Try again.",
          );
      }
      // Log the failure class only: never request bodies, daemon bodies or tokens.
      log(
        "request_failed",
        name,
        (e as Error)?.name ?? "Error",
        String((e as Error)?.message ?? "").slice(0, 160),
      );
      return errorJson(503, "runtime_unavailable", UNAVAILABLE);
    }
  }

  /** One MCP proxy request that arrived on runtime `from`'s own socket. */
  async function mcpProxy(req: Request, server: any, from: string): Promise<Response> {
    try {
      return await proxy.handle(req, server, from);
    } catch (e) {
      log("mcp_proxy_failed", (e as Error)?.name ?? "Error");
      return json({ error: "unavailable" }, 502);
    }
  }

  /**
   * Listens on a runtime's MCP socket, the host end of its private vsock route. Only that runtime
   * can connect to it, so the socket names the caller. Idempotent; kept while the runtime runs.
   */
  function listenMcp(key: string) {
    const path = runtime.mcpSocket?.(key);
    if (!path || mcpListeners.has(key)) return;
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

  function closeMcp(key: string) {
    mcpListeners.get(key)?.stop(true);
    mcpListeners.delete(key);
  }

  return { fetch: fetchHandler, mcpProxy, rediscover, idleSweep, people };
}

if (import.meta.main) {
  const cfg = loadConfig();
  const runtime = new MicroVmRuntime(cfg);
  // The runtime image is loaded and the hypervisor checked before serving: a host without KVM
  // stops the gateway here.
  const posture = await runtime.posture().catch((e) => {
    console.error(`startup failed: ${(e as Error).message}`);
    process.exit(1);
  });
  console.log(
    `security: sandbox=${posture.sandbox} egress=${posture.egress} ` +
      `limits=${cfg.runtimeMemoryMb}MiB/${cfg.runtimeCpus}cpu data=${cfg.dataDir}`,
  );
  for (const w of posture.warnings) console.warn(`WARNING: ${w}`);
  const gateway = createGateway(cfg, runtime);
  Bun.serve({
    hostname: cfg.host,
    port: cfg.port,
    fetch: gateway.fetch,
    idleTimeout: 255,
  });
  console.log(
    `tandem gateway on ${cfg.host}:${cfg.port} (auth ${cfg.authMode}, idle ${cfg.idleMs / 60_000} min, permission mode ${cfg.permissionMode})`,
  );
  await gateway
    .rediscover()
    .catch((e) => console.error("rediscovery failed", (e as Error).message));
  setInterval(() => void gateway.idleSweep(), 30_000);
  // The microVMs live in this container: shut them down cleanly before it stops.
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      const keys = await runtime.listRunning().catch(() => [] as string[]);
      console.log(`stopping ${keys.length} runtime(s)`);
      await Promise.allSettled(keys.map((k) => runtime.stop(k)));
      process.exit(0);
    });
}
