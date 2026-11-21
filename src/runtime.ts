// Runtime controller: one microVM per person, run by microsandbox inside the gateway's own
// container. Each microVM boots the runtime image (built into the gateway image), mounts the
// person's home from the gateway's data volume, publishes its Happy bridge on the container's
// loopback only, and reaches the gateway's MCP proxy over a private vsock route.
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import type { Config } from "./config";
import { proxyToken, PROXY_TOKEN_ENV } from "./mcp";
import {
  egressRules,
  RUNTIME_TMPDIR,
  type EgressRules,
  type Posture,
} from "./security";

/** The Happy bridge inside each microVM (runtime/entrypoint.sh). */
export const BRIDGE_PORT = 24790;
/** Host ports for the bridges, on the gateway container's loopback only. */
export const BRIDGE_HOST_PORTS = { first: 41000, last: 48999 };
/** Inside each microVM the MCP proxy is this loopback port; the entrypoint forwards it over vsock. */
export const MCP_GUEST_PORT = 8790;
export const MCP_VSOCK_PORT = 8790;
const HOME = "/home/agent";
const TOKEN_PATH = `${HOME}/.happy/agent/token`;
const ENTRYPOINT = "/usr/local/bin/agent-runtime-entrypoint";
/** The runtime image's own user (runtime/Dockerfile). */
const AGENT_UID = 10001;
const EXEC_TIMEOUT_MS = 60_000;
/** States microsandbox passes through while a runtime boots or stops; how long to wait them out. */
const TRANSITIONAL = new Set(["starting", "draining"]);
const SETTLE_MS = 60_000;

/**
 * The daemon's runs and sign-ins, asked over its own socket inside the runtime: this answers also
 * when the gateway cannot reach the runtime's bridge. Read-only; the token goes through a shell
 * builtin to curl's standard input, never into a process's arguments.
 */
export const ACTIVITY_COMMAND = [
  "sh",
  "-c",
  't=$(cat /home/agent/.happy/agent/token) && for p in projects/chats provider-clis/claude provider-clis/codex provider-clis/grok; do echo "authorization: Bearer $t" | curl -sf -m 10 -H @- --unix-socket /home/agent/.happy/agent/server.sock "http://runtime/v0/$p" && echo || exit 1; done',
];

/**
 * Claude Code's names for its models ("Opus 5.5" for the `opus` alias), read from the person's own
 * signed-in Claude Code through its stream-json `initialize` request: no turn, nothing sent to a
 * model. Happy's catalog names only the aliases ("Claude Code · Opus").
 */
export const CLAUDE_MODELS_COMMAND = [
  "sh",
  "-c",
  `cd /tmp && echo '{"type":"control_request","request_id":"models","request":{"subtype":"initialize"}}' | timeout 20 claude -p --input-format stream-json --output-format stream-json --verbose 2>/dev/null | grep -m 1 '"control_response"'`,
];

/**
 * Whether Google accepts the person's Gemini API key: its free model list, asked from inside the
 * runtime. The key goes from its file to curl's standard input through a shell builtin, never into
 * a process's arguments. (Happy's provider check cannot vouch for the Antigravity account on an
 * API key: it looks for Antigravity's own sign-in.)
 */
export const GEMINI_KEY_COMMAND = [
  "sh",
  "-c",
  'k=$(cat /home/agent/.agent-runtime/gemini-api-key) && echo "x-goog-api-key: $k" | curl -sf -m 15 -o /dev/null -H @- "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1"',
];

/** Writes standard input to "$1/$2", owner-only, as the runtime's user: no content in argv. */
const WRITE_FILE_COMMAND = [
  "sh",
  "-c",
  'umask 077 && mkdir -p "$1" && cat > "$1/$2.tmp" && mv -f "$1/$2.tmp" "$1/$2"',
  "write-file",
];

export type ExecResult = { exitCode: number; stdout: string };

/** A running runtime as the gateway sees it. `token` is the daemon's owner token: memory only. */
export type RuntimeHandle = {
  key: string;
  url: string;
  token: string;
  startedAt: number;
};

export interface Runtime {
  /** Creates and starts the runtime when needed; resolves once its daemon token is readable. */
  ensure(key: string): Promise<RuntimeHandle>;
  stop(key: string): Promise<void>;
  restart(key: string): Promise<RuntimeHandle>;
  /** Keys of runtimes that are running now (rediscovery after a gateway restart). */
  listRunning(): Promise<string[]>;
  exec(key: string, cmd: string[]): Promise<ExecResult>;
  /** Writes one owner-only file into the running runtime's home without argv or environment. */
  writePrivateFile(
    key: string,
    dir: string,
    name: string,
    content: string,
  ): Promise<void>;
  /**
   * The daemon's project (GET /v0/projects/chats) and provider CLIs, read inside the runtime, also
   * when its bridge is unreachable. Null when the daemon does not answer.
   */
  activity?(key: string): Promise<{ project: any; clis: any[] } | null>;
  /** Which protections this host provides (detected once). */
  posture?(): Promise<Posture>;
  /**
   * The Unix socket the runtime's MCP proxy requests arrive on (its vsock route). The gateway
   * listens there before the runtime starts; a request on it can only come from this runtime.
   */
  mcpSocket?(key: string): string;
}

/** Deterministic, non-reversible runtime identity for a person. */
export function runtimeKey(secret: string, subject: string) {
  return createHmac("sha256", secret)
    .update(`subject:${subject}`)
    .digest("hex")
    .slice(0, 24);
}

/** The microsandbox calls the controller makes: the SDK, or a fake in tests. */
export type Msb = typeof import("microsandbox");

/** What a runtime is created with; any change recreates a stopped runtime (its home is kept). */
export type RuntimeSpec = {
  image: string;
  memoryMb: number;
  cpus: number;
  egress: EgressRules;
  port: number;
  socket: string;
};

export const specHash = (spec: RuntimeSpec) =>
  createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 16);

/** The first free bridge host port, or null when every one is taken. */
export function freePort(used: Set<number>): number | null {
  for (let p = BRIDGE_HOST_PORTS.first; p <= BRIDGE_HOST_PORTS.last; p++)
    if (!used.has(p)) return p;
  return null;
}

/** The image reference for a runtime image archive: its build-time digest (`<archive>.sha256`). */
export function imageRef(archive: string) {
  const sha = readFileSync(`${archive}.sha256`, "utf8").trim().split(/\s/)[0]!;
  if (!/^[0-9a-f]{64}$/.test(sha))
    throw new Error(`${archive}.sha256 does not hold a sha256 digest`);
  return `tandem-runtime:${sha.slice(0, 16)}`;
}

const notFound = (e: unknown) =>
  ["sandboxNotFound", "imageNotFound"].includes(
    (e as { code?: string })?.code ?? "",
  );

export class MicroVmRuntime implements Runtime {
  private msb: Promise<Msb>;
  private ready?: Promise<string>;
  private tokens = new Map<string, string>();
  private connected = new Map<string, Promise<any>>();
  /** One create/start/stop at a time per person, and one port choice at a time overall. */
  private queues = new Map<string, Promise<unknown>>();
  private portLock: Promise<unknown> = Promise.resolve();

  constructor(
    private cfg: Config,
    private log: (...args: unknown[]) => void = console.log,
    msb?: Msb,
  ) {
    this.msb = msb ? Promise.resolve(msb) : import("microsandbox");
  }

  private label = (name: string) => `${this.cfg.runtimePrefix}.${name}`;
  private name = (key: string) => `${this.cfg.runtimePrefix}-${key}`;
  private home = (key: string) => `${this.cfg.dataDir}/homes/${key}`;
  mcpSocket = (key: string) => `${this.cfg.dataDir}/run/${key}.sock`;

  posture(): Promise<Posture> {
    return this.setup().then(() => ({
      sandbox: "microvm",
      egress: this.cfg.egressMode,
      warnings: [],
    }));
  }

  /** Loads the runtime image into microsandbox once per image version; resolves to its reference. */
  private setup(): Promise<string> {
    return (this.ready ??= (async () => {
      const { Image } = await this.msb;
      for (const dir of ["homes", "run"])
        mkdirSync(`${this.cfg.dataDir}/${dir}`, {
          recursive: true,
          mode: 0o700,
        });
      const ref =
        this.cfg.runtimeImage || imageRef(this.cfg.runtimeImageArchive);
      const loaded = await Image.get(ref).then(
        () => true,
        (e) => {
          if (notFound(e)) return false;
          throw e;
        },
      );
      if (!loaded) {
        if (this.cfg.runtimeImage)
          throw new Error(
            `RUNTIME_IMAGE ${ref} is not in microsandbox's image store`,
          );
        const t0 = Date.now();
        this.log(`loading runtime image ${ref}`);
        await Image.load(this.cfg.runtimeImageArchive, { tag: ref });
        this.log(`runtime image ${ref} loaded in ${Date.now() - t0} ms`);
      }
      return ref;
    })().catch((e) => {
      this.ready = undefined; // a failed load must not stick
      throw e;
    }));
  }

  private serial<T>(key: string, job: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(key) ?? Promise.resolve()).then(job, job);
    const tail = run.then(
      () => {},
      () => {},
    );
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return run;
  }

  /** Every runtime of this instance, running or stopped. */
  private async all(): Promise<any[]> {
    const { Sandbox } = await this.msb;
    const out: any[] = [];
    let cursor: string | undefined;
    do {
      const page = await Sandbox.listWith((l: any) => {
        let b = l.label(this.label("runtime"), "1").limit(100);
        if (cursor) b = b.cursor(cursor);
        return b;
      });
      out.push(...page.sandboxes);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return out;
  }

  private async handleOf(key: string): Promise<any | null> {
    const { Sandbox } = await this.msb;
    return Sandbox.get(this.name(key)).catch((e: unknown) => {
      if (notFound(e)) return null;
      throw e;
    });
  }

  /**
   * The runtime once it is not between states: microsandbox reports `starting` and `draining`
   * while a boot or a stop (also one from outside the gateway) is under way.
   */
  private async settled(key: string): Promise<any | null> {
    for (const until = Date.now() + SETTLE_MS; ; await Bun.sleep(500)) {
      const h = await this.handleOf(key);
      if (!h || !TRANSITIONAL.has(h.status) || Date.now() > until) return h;
    }
  }

  /** A live connection to a running runtime, reused for exec. */
  private sandbox(key: string): Promise<any> {
    let c = this.connected.get(key);
    if (!c) {
      c = this.handleOf(key).then((h) => {
        if (h?.status !== "running") throw new Error("runtime is not running");
        return h.connect();
      });
      c.catch(() => this.connected.delete(key));
      this.connected.set(key, c);
    }
    return c;
  }

  /**
   * Runs `job` on the live connection; a failure drops that connection, so a runtime restarted
   * outside the gateway is reconnected on the next call instead of failing on a stale one.
   */
  private async use<T>(key: string, job: (sb: any) => Promise<T>): Promise<T> {
    try {
      return await job(await this.sandbox(key));
    } catch (e) {
      this.connected.delete(key);
      throw e;
    }
  }

  private forget(key: string) {
    this.connected.delete(key);
    this.tokens.delete(key);
  }

  async ensure(key: string): Promise<RuntimeHandle> {
    return this.serial(key, () => this.ensureNow(key));
  }

  private async ensureNow(key: string): Promise<RuntimeHandle> {
    const image = await this.setup();
    let h = await this.settled(key);
    if (h?.status === "running") {
      await this.startDaemon(key);
      return this.handle(key, h);
    }
    const labels = h?.config()?.labels ?? {};
    const port =
      Number(labels[this.label("port")]) || (await this.allocatePort());
    const spec: RuntimeSpec = {
      image,
      memoryMb: this.cfg.runtimeMemoryMb,
      cpus: this.cfg.runtimeCpus,
      egress: egressRules(this.cfg),
      port,
      socket: this.mcpSocket(key),
    };
    const hash = specHash(spec);
    // A stopped runtime is recreated whenever anything in its spec changed (image, limits, egress).
    // Its home is a separate directory, so nothing the person keeps is lost.
    if (h && labels[this.label("spec")] !== hash) {
      const { Sandbox } = await this.msb;
      await Sandbox.remove(this.name(key));
      h = null;
    }
    this.forget(key);
    if (h)
      await h.startDetached().catch(async (e: unknown) => {
        // Started meanwhile by someone else (msb, a crash recovery): use it.
        if ((await this.settled(key))?.status !== "running") throw e;
      });
    else await this.create(key, spec, hash);
    await this.startDaemon(key);
    return this.handle(key, await this.handleOf(key));
  }

  /** The lowest bridge host port no runtime of this instance holds (running or stopped). */
  private allocatePort(): Promise<number> {
    const run = this.portLock.then(async () => {
      const used = new Set(
        (await this.all()).map((h) =>
          Number(h.config()?.labels?.[this.label("port")]),
        ),
      );
      const port = freePort(used);
      if (port === null)
        throw new Error("no free bridge port: too many runtimes on this host");
      return port;
    });
    this.portLock = run.catch(() => {});
    return run;
  }

  private async create(key: string, spec: RuntimeSpec, hash: string) {
    const { Sandbox, NetworkPolicyBuilder } = await this.msb;
    const home = this.home(key);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const policy = buildPolicy(NetworkPolicyBuilder, spec.egress);
    let b = Sandbox.builder(this.name(key))
      .image(spec.image)
      .cpus(spec.cpus)
      .memory(spec.memoryMb)
      .user("agent")
      .label(this.label("runtime"), "1")
      .label(this.label("key"), key)
      .label(this.label("port"), String(spec.port))
      .label(this.label("spec"), hash)
      .volume(HOME, (m: any) => m.bind(home).owner(AGENT_UID, AGENT_UID))
      .port(spec.port, BRIDGE_PORT)
      .vsock(spec.socket, MCP_VSOCK_PORT)
      .detached(true);
    if (policy)
      b = b.network((n: any) => n.strict(false).policyFromBuilder(policy));
    await b.create();
  }

  /** Starts the Happy daemon (the runtime entrypoint) unless it already runs in this boot. */
  private startDaemon(key: string) {
    return this.use(key, (sb) => this.startDaemonOn(key, sb));
  }

  private async startDaemonOn(key: string, sb: any) {
    const running = await sb.execWith("pgrep", (b: any) =>
      b.args(["-x", "happy-agent"]).user("agent").timeout(EXEC_TIMEOUT_MS),
    );
    if (running.status?.code === 0) return;
    // The daemon writes a new owner token when it starts: the previous boot's must not be read.
    this.tokens.delete(key);
    await sb.execWith("rm", (b: any) =>
      b.args(["-f", TOKEN_PATH]).user("agent").timeout(EXEC_TIMEOUT_MS),
    );
    await sb.execDetachedWith(ENTRYPOINT, (b: any) =>
      b
        .user("agent")
        .env("HOME", HOME)
        .env("TMPDIR", RUNTIME_TMPDIR)
        .env("MCP_PROXY_URL", `http://127.0.0.1:${MCP_GUEST_PORT}/mcp/${key}`)
        .env("MCP_VSOCK_PORT", String(MCP_VSOCK_PORT))
        // The MCP proxy token only reaches the gateway's proxy, and only over this runtime's own
        // vsock route.
        .env(PROXY_TOKEN_ENV, proxyToken(this.cfg.serviceSecret, key)),
    );
  }

  private async handle(key: string, h: any): Promise<RuntimeHandle> {
    if (h?.status !== "running") throw new Error("runtime is not running");
    const port = Number(h.config()?.labels?.[this.label("port")]);
    return {
      key,
      url: `http://127.0.0.1:${port}`,
      token: await this.token(key),
      startedAt: h.updatedAt?.getTime?.() ?? Date.now(),
    };
  }

  /** Reads the daemon token once per runtime boot; kept only in memory. */
  private async token(key: string): Promise<string> {
    const cached = this.tokens.get(key);
    if (cached) return cached;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const r = await this.exec(key, ["cat", TOKEN_PATH]).catch(() => null);
      const token = r?.stdout.trim() ?? "";
      if (r?.exitCode === 0 && /^[A-Za-z0-9_-]{43}$/.test(token)) {
        this.tokens.set(key, token);
        return token;
      }
      await Bun.sleep(250); // a fresh home gets its token on the daemon's first start
    }
    throw new Error("runtime daemon token did not appear");
  }

  stop(key: string) {
    return this.serial(key, async () => {
      this.forget(key);
      const h = await this.settled(key);
      if (h?.status !== "running") return;
      const sb = await h.connect();
      // Graceful first, so the daemon can finish writing; a hung guest is killed.
      await sb.stopWithTimeout(30_000).catch(() => sb.kill());
    });
  }

  async restart(key: string) {
    await this.stop(key);
    return this.ensure(key);
  }

  async listRunning() {
    return (await this.all())
      .filter((h) => h.status === "running")
      .map((h) => h.config()?.labels?.[this.label("key")])
      .filter((k): k is string => typeof k === "string" && !!k);
  }

  /** Always as the runtime's own user. */
  exec(key: string, cmd: string[]): Promise<ExecResult> {
    const [file, ...args] = cmd;
    return this.use(key, async (sb) => {
      const o = await sb.execWith(file!, (b: any) =>
        b.args(args).user("agent").timeout(EXEC_TIMEOUT_MS),
      );
      return { exitCode: o.status?.code ?? -1, stdout: o.stdout() };
    });
  }

  async activity(key: string) {
    const r = await this.exec(key, ACTIVITY_COMMAND).catch(() => null);
    if (r?.exitCode !== 0) return null;
    try {
      const [project, ...clis] = r.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      return {
        project: project.project,
        clis: clis.map((c) => c.providerCli),
      };
    } catch {
      return null;
    }
  }

  async writePrivateFile(
    key: string,
    dir: string,
    name: string,
    content: string,
  ) {
    if (!dir.startsWith(`${HOME}/`) || !/^[A-Za-z0-9._-]+$/.test(name))
      throw new Error("writePrivateFile: path outside the runtime home");
    const [file, ...args] = WRITE_FILE_COMMAND;
    const o = await this.use<any>(key, (sb) =>
      sb.execWith(file!, (b: any) =>
        b
          .args([...args, dir, name])
          .user("agent")
          .stdinBytes(Buffer.from(content))
          .timeout(EXEC_TIMEOUT_MS),
      ),
    );
    if (o.status?.code !== 0) throw new Error(`writing ${name} failed`);
  }
}

/** The microsandbox network policy for these egress rules; null keeps its default (public only). */
export function buildPolicy(
  NetworkPolicyBuilder: Msb["NetworkPolicyBuilder"],
  rules: EgressRules,
) {
  if (rules.mode === "open" && !rules.ranges.length) return null;
  // Inbound traffic reaches a runtime only through its published bridge port.
  let p: any = new NetworkPolicyBuilder()
    .defaultIngress("allow")
    .defaultEgress("deny")
    // Name resolution through microsandbox's own DNS gateway on the host side.
    .egress((r: any) => r.udp().tcp().port(53).allowHost());
  if (rules.mode === "open") p = p.egress((r: any) => r.allowPublic());
  else {
    if (rules.exact.length)
      p = p.egress((r: any) =>
        r.tcp().ports([80, 443]).allowDomains(rules.exact),
      );
    if (rules.suffixes.length)
      p = p.egress((r: any) =>
        r.tcp().ports([80, 443]).allowDomainSuffixes(rules.suffixes),
      );
  }
  for (const cidr of rules.ranges)
    p = p.egress((r: any) => r.tcp().allow((d: any) => d.cidr(cidr)));
  return p;
}

