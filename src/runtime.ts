// Runtime controller: one sandbox per person, inside the one Tandem container. crun (an OCI runtime)
// runs each person's Happy Agent daemon as their own uid in their own PID, network, IPC, UTS,
// cgroup and mount namespaces over the read-only runtime filesystem, with only their home writable
// (src/security.ts). The gateway reaches the daemon over its Unix socket in the home; the sandbox
// reaches the outside only through the gateway's egress and MCP sockets.
import { createHmac } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import { proxyToken, PROXY_TOKEN_ENV } from "./mcp";
import {
  groupFile,
  passwdFile,
  RUNTIME_TMPDIR,
  sandboxSeccomp,
  sandboxSpec,
  SANDBOX_EGRESS_PORT,
  SANDBOX_MCP_PORT,
  type Posture,
} from "./security";

const HOME = "/home/agent";
const TOKEN_PATH = `${HOME}/.happy/agent/token`;
/** tini reaps orphans and forwards signals; the entrypoint then runs the daemon (runtime/). */
export const DAEMON_ARGS = [
  "/usr/bin/tini",
  "-s",
  "--",
  "/usr/local/bin/agent-runtime-entrypoint",
];
/** One-shot commands get the egress relay first (runtime/with-egress). */
export const WITH_EGRESS = "/usr/local/bin/with-egress";
const EXEC_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 30_000;
/** Each person's uid: from here up, one per person, recorded in DATA_DIR/uids.json. */
export const FIRST_UID = 100_000;

/**
 * The daemon's runs and sign-ins, asked over its own socket inside the runtime: this answers also
 * when the gateway cannot reach the daemon. Read-only; the token goes through a shell builtin to
 * curl's standard input, never into a process's arguments.
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
 * runtime through the egress proxy. The key goes from its file to curl's standard input through a
 * shell builtin, never into a process's arguments. (Happy's provider check cannot vouch for the
 * Antigravity account on an API key: it looks for Antigravity's own sign-in.)
 */
export const GEMINI_KEY_COMMAND = [
  "sh",
  "-c",
  'k=$(cat /home/agent/.agent-runtime/gemini-api-key) && echo "x-goog-api-key: $k" | curl -sf -m 15 -o /dev/null -H @- "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1"',
];

/** Writes standard input to "$1/$2", owner-only, as the person: no content in argv. */
const WRITE_FILE_COMMAND = [
  "sh",
  "-c",
  'umask 077 && mkdir -p "$1" && cat > "$1/$2.tmp" && mv -f "$1/$2.tmp" "$1/$2"',
  "write-file",
];

export type ExecResult = { exitCode: number; stdout: string };

/**
 * A running runtime as the gateway sees it: the daemon's HTTP API over its Unix socket (`unix`,
 * with `url` as the request base) or over TCP (`url` only, tests). `token` is the daemon's owner
 * token: memory only.
 */
export type RuntimeHandle = {
  key: string;
  url: string;
  unix?: string;
  token: string;
  startedAt: number;
};

export interface Runtime {
  /** Starts the runtime when needed; resolves once its daemon token is readable. */
  ensure(key: string): Promise<RuntimeHandle>;
  stop(key: string): Promise<void>;
  restart(key: string): Promise<RuntimeHandle>;
  /** Keys of runtimes that are running now (rediscovery after a gateway restart). */
  listRunning(): Promise<string[]>;
  /** Runs a command as the person, in a sandbox like theirs (their home, the egress proxy). */
  exec(key: string, cmd: string[]): Promise<ExecResult>;
  /** Writes one owner-only file into the person's home without argv or environment. */
  writePrivateFile(
    key: string,
    dir: string,
    name: string,
    content: string,
  ): Promise<void>;
  /**
   * The daemon's project (GET /v0/projects/chats) and provider CLIs, read inside the runtime, also
   * when its socket does not answer the gateway. Null when the daemon does not answer.
   */
  activity?(key: string): Promise<{ project: any; clis: any[] } | null>;
  /** Which protections this host provides (checked once). */
  posture?(): Promise<Posture>;
  /**
   * The Unix socket the runtime's MCP proxy requests arrive on (bind-mounted into its sandbox and
   * nowhere else). The gateway listens there before the runtime starts.
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

/**
 * Runs crun; the gateway's only use of it. Replaced by a fake in tests. `cgroups`: each sandbox gets
 * its own cgroup under the delegated tree (delegateCgroups), else crun leaves cgroups alone.
 */
export type Crun = (
  args: string[],
  opts?: { stdin?: Buffer; timeoutMs?: number; log?: string; cgroups?: boolean },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const crun: Crun = async (args, opts = {}) => {
  const manager = opts.cgroups ? "cgroupfs" : "disabled";
  const p = Bun.spawn(["crun", `--cgroup-manager=${manager}`, ...args], {
    stdin: opts.stdin ?? "ignore",
    stdout: opts.log ? Bun.file(opts.log) : "pipe",
    stderr: opts.log ? Bun.file(opts.log) : "pipe",
  });
  const timer = opts.timeoutMs
    ? setTimeout(() => p.kill("SIGKILL"), opts.timeoutMs)
    : undefined;
  const [stdout, stderr, code] = await Promise.all([
    opts.log ? "" : new Response(p.stdout as ReadableStream).text(),
    opts.log ? "" : new Response(p.stderr as ReadableStream).text(),
    p.exited,
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr };
};

/**
 * Makes this container's cgroup v2 tree writable and moves its own processes into a leaf, so every
 * sandbox can get its own cgroup with memory, CPU and process limits, the way Docker-in-Docker
 * does. Needs only the SYS_ADMIN and AppArmor settings the sandboxes need anyway. Resolves to null,
 * or to why the host cannot (cgroup v1, a controller missing).
 */
export async function delegateCgroups(
  root = "/sys/fs/cgroup",
): Promise<string | null> {
  if (!existsSync(join(root, "cgroup.controllers")))
    return "this host does not use cgroup v2";
  const have = readFileSync(join(root, "cgroup.controllers"), "utf8").split(/\s+/);
  const missing = ["memory", "pids", "cpu"].filter((c) => !have.includes(c));
  if (missing.length) return `the cgroup controllers ${missing.join(", ")} are not available`;
  const remount = Bun.spawnSync(["mount", "-o", "remount,rw", root]);
  if (remount.exitCode !== 0)
    return `cannot write ${root}: ${remount.stderr.toString().trim()}`;
  // Processes may not live in a cgroup whose children have controllers: move them to a leaf.
  mkdirSync(join(root, "gateway"), { recursive: true });
  const enable = "+memory +pids +cpu";
  for (let attempt = 0; ; attempt++) {
    for (const pid of readFileSync(join(root, "cgroup.procs"), "utf8").split("\n"))
      if (pid)
        try {
          writeFileSync(join(root, "gateway", "cgroup.procs"), pid);
        } catch {} // exited meanwhile
    try {
      writeFileSync(join(root, "cgroup.subtree_control"), enable);
      break;
    } catch (e) {
      if (attempt >= 5) return `cannot enable cgroup controllers: ${(e as Error).message}`;
    }
  }
  mkdirSync(join(root, "sandboxes"), { recursive: true });
  writeFileSync(join(root, "sandboxes", "cgroup.subtree_control"), enable);
  return null;
}

/** The first uid at or above FIRST_UID that no person holds. */
export function nextUid(taken: Iterable<number>): number {
  const used = new Set(taken);
  let uid = FIRST_UID;
  while (used.has(uid)) uid++;
  return uid;
}

export class SandboxRuntime implements Runtime {
  private ready?: Promise<void>;
  /** Per-sandbox cgroups available (delegateCgroups), and why not. */
  private cgroups = false;
  private warnings: string[] = [];
  private seccomp = sandboxSeccomp();
  private tokens = new Map<string, string>();
  private started = new Map<string, number>();
  private queues = new Map<string, Promise<unknown>>();
  private uidLock: Promise<unknown> = Promise.resolve();
  private seq = 0;

  constructor(
    private cfg: Config,
    private log: (...args: unknown[]) => void = console.log,
    private run: Crun = crun,
  ) {}

  private id = (key: string) => `${this.cfg.runtimePrefix}-${key}`;
  private home = (key: string) => join(this.cfg.dataDir, "homes", key);
  private runDir = (key: string) => join(this.cfg.dataDir, "run", key);
  private bundles = () => join(this.cfg.dataDir, "bundles");
  private tmp = (key: string) => join(this.cfg.dataDir, "tmp", key);
  mcpSocket = (key: string) => join(this.runDir(key), "mcp.sock");
  egressSocket = () => join(this.cfg.dataDir, "run", "egress.sock");
  daemonSocket = (key: string) =>
    join(this.home(key), ".happy", "agent", "server.sock");

  posture(): Promise<Posture> {
    return this.setup().then(() => ({
      sandbox: "namespaces",
      egress: this.cfg.egressMode,
      limits: this.cgroups,
      warnings: this.warnings,
    }));
  }

  /**
   * Checks once that this container can create sandboxes (compose.yaml grants it SYS_ADMIN and
   * NET_ADMIN and turns AppArmor off for it), with a throwaway sandbox that runs `true`.
   */
  private setup(): Promise<void> {
    return (this.ready ??= (async () => {
      for (const dir of ["homes", "run", "bundles", "tmp"])
        mkdirSync(join(this.cfg.dataDir, dir), {
          recursive: true,
          mode: 0o711,
        });
      chmodSync(join(this.cfg.dataDir, "run"), 0o711);
      if (
        !existsSync(join(this.cfg.runtimeRootfs, "usr/local/bin/happy-agent"))
      )
        throw new Error(`no runtime filesystem at ${this.cfg.runtimeRootfs}`);
      const why = await this.delegate();
      this.cgroups = why === null;
      if (why)
        this.warnings.push(
          `no per-person memory, CPU and process limits: ${why}. Limit the whole container instead.`,
        );
      const probe = await this.oneShot("probe", FIRST_UID - 1, ["true"], {
        home: null,
      });
      if (probe.code !== 0)
        throw new Error(
          `this container cannot create sandboxes (${probe.stderr.trim().slice(0, 200)}). ` +
            "Give it cap_add SYS_ADMIN and NET_ADMIN and security_opt apparmor=unconfined (compose.yaml).",
        );
    })().catch((e) => {
      this.ready = undefined;
      throw e;
    }));
  }

  /** Overridden in tests, which run without a cgroup tree. */
  protected delegate() {
    return delegateCgroups();
  }

  /** crun with this runtime's cgroup setting. */
  private crun(args: string[], opts: Parameters<Crun>[1] = {}) {
    return this.run(args, { ...opts, cgroups: this.cgroups });
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

  /** The person's uid, allocated once and kept in DATA_DIR/uids.json. */
  private uidOf(key: string): Promise<number> {
    const run = this.uidLock.then(() => {
      const file = join(this.cfg.dataDir, "uids.json");
      const uids: Record<string, number> = existsSync(file)
        ? JSON.parse(readFileSync(file, "utf8"))
        : {};
      if (uids[key]) return uids[key]!;
      uids[key] = nextUid(Object.values(uids));
      writeFileSync(`${file}.tmp`, JSON.stringify(uids, null, 1), {
        mode: 0o600,
      });
      renameSync(`${file}.tmp`, file);
      return uids[key]!;
    });
    this.uidLock = run.catch(() => {});
    return run;
  }

  /** Home, passwd/group and the MCP socket's owner, before the person's sandbox starts. */
  private async prepare(key: string, uid: number) {
    const home = this.home(key);
    if (!existsSync(home)) mkdirSync(home, { mode: 0o700 });
    if (lstatSync(home).uid !== uid) {
      // A home from another uid (moved from an older Tandem): hand it over. chown -R does not
      // follow symbolic links.
      const p = Bun.spawn(["chown", "-R", `${uid}:${uid}`, home]);
      if ((await p.exited) !== 0) throw new Error(`cannot chown ${home}`);
    }
    chmodSync(home, 0o700);
    const run = this.runDir(key);
    mkdirSync(run, { recursive: true, mode: 0o711 });
    writeFileSync(join(run, "passwd"), passwdFile(uid), { mode: 0o644 });
    writeFileSync(join(run, "group"), groupFile(uid), { mode: 0o644 });
    // A fresh temporary directory for this start (the last start's unpacked files are gone).
    this.freshTmp(key, uid);
    // The gateway listens on it (listenMcp) before the start; only the person may connect.
    if (existsSync(this.mcpSocket(key))) {
      chownSync(this.mcpSocket(key), uid, uid);
      chmodSync(this.mcpSocket(key), 0o600);
    }
  }

  /** An empty temporary directory for the person, owner-only. rmSync does not follow links. */
  private freshTmp(key: string, uid: number) {
    const tmp = this.tmp(key);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { mode: 0o700 });
    // Only root can hand a directory to another user (the gateway runs as root in its container).
    if (process.getuid?.() === 0) chownSync(tmp, uid, uid);
  }

  /** The person's sandbox spec (sandbox `name`), for their daemon or a one-shot command. */
  private spec(
    name: string,
    key: string | null,
    uid: number,
    args: string[],
    daemon: boolean,
  ) {
    return sandboxSpec({
      uid,
      rootfs: this.cfg.runtimeRootfs,
      home: key ? this.home(key) : join(this.cfg.dataDir, "run", "probe-home"),
      tmp: key ? this.tmp(key) : join(this.cfg.dataDir, "run", "probe-home"),
      seccomp: this.seccomp,
      cgroup: this.cgroups
        ? {
            path: `/sandboxes/${name}`,
            memoryMb: this.cfg.runtimeMemoryMb,
            cpus: this.cfg.runtimeCpus,
          }
        : undefined,
      passwd: key ? join(this.runDir(key), "passwd") : "/etc/passwd",
      group: key ? join(this.runDir(key), "group") : "/etc/group",
      egressSocket: this.egressSocket(),
      mcpSocket:
        key && daemon && existsSync(this.mcpSocket(key))
          ? this.mcpSocket(key)
          : undefined,
      args,
      pids: this.cfg.runtimePids,
      env: {
        HOME,
        TMPDIR: RUNTIME_TMPDIR,
        DISABLE_AUTOUPDATER: "1",
        AGY_CLI_DISABLE_AUTO_UPDATE: "true",
        // Every connection out goes through the egress relay to the gateway's Smokescreen.
        HTTPS_PROXY: `http://127.0.0.1:${SANDBOX_EGRESS_PORT}`,
        HTTP_PROXY: `http://127.0.0.1:${SANDBOX_EGRESS_PORT}`,
        https_proxy: `http://127.0.0.1:${SANDBOX_EGRESS_PORT}`,
        http_proxy: `http://127.0.0.1:${SANDBOX_EGRESS_PORT}`,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
        ...(key && daemon
          ? {
              MCP_PROXY_URL: `http://127.0.0.1:${SANDBOX_MCP_PORT}/mcp/${key}`,
              // Only useful on this person's own MCP socket (src/mcp.ts).
              [PROXY_TOKEN_ENV]: proxyToken(this.cfg.serviceSecret, key),
            }
          : {}),
      },
    });
  }

  private writeBundle(name: string, spec: object) {
    const dir = join(this.bundles(), name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "config.json"), JSON.stringify(spec), {
      mode: 0o600,
    });
    return dir;
  }

  /** A command in a throwaway sandbox of the person (or of nobody, `home: null`); stdout back. */
  private async oneShot(
    key: string,
    uid: number,
    cmd: string[],
    opts: { home?: null; stdin?: Buffer } = {},
  ) {
    const name = `${this.cfg.runtimePrefix}-x${process.pid}-${++this.seq}`;
    const real = opts.home !== null;
    if (!real)
      mkdirSync(join(this.cfg.dataDir, "run", "probe-home"), {
        recursive: true,
      });
    else if (!existsSync(this.tmp(key))) this.freshTmp(key, uid);
    const bundle = this.writeBundle(
      name,
      this.spec(name, real ? key : null, uid, [WITH_EGRESS, ...cmd], false),
    );
    try {
      return await this.crun(
        ["run", "--no-pivot", "--no-new-keyring", "--bundle", bundle, name],
        { stdin: opts.stdin, timeoutMs: EXEC_TIMEOUT_MS },
      );
    } finally {
      await this.crun(["delete", "-f", name]).catch(() => {});
      rmSync(bundle, { recursive: true, force: true });
    }
  }

  private async status(key: string): Promise<string | null> {
    const r = await this.crun(["state", this.id(key)]);
    if (r.code !== 0) return null;
    try {
      return JSON.parse(r.stdout).status ?? null;
    } catch {
      return null;
    }
  }

  ensure(key: string): Promise<RuntimeHandle> {
    return this.serial(key, () => this.ensureNow(key));
  }

  private async ensureNow(key: string): Promise<RuntimeHandle> {
    await this.setup();
    const uid = await this.uidOf(key);
    if ((await this.status(key)) !== "running") {
      // A sandbox that stopped (crashed, or stopped outside the gateway) leaves its state behind.
      await this.crun(["delete", "-f", this.id(key)]).catch(() => {});
      await this.prepare(key, uid);
      // The daemon writes a new owner token when it starts: the previous one must not be read.
      this.tokens.delete(key);
      await this.oneShot(key, uid, ["rm", "-f", TOKEN_PATH]);
      const bundle = this.writeBundle(
        this.id(key),
        this.spec(this.id(key), key, uid, DAEMON_ARGS, true),
      );
      const log = join(this.runDir(key), "daemon.log");
      const r = await this.crun(
        [
          "run",
          "--detach",
          "--no-pivot",
          "--no-new-keyring",
          "--bundle",
          bundle,
          this.id(key),
        ],
        { log },
      );
      if (r.code !== 0) {
        const tail = existsSync(log)
          ? readFileSync(log, "utf8").slice(-300)
          : "";
        throw new Error(`runtime did not start: ${tail.trim()}`);
      }
      this.started.set(key, Date.now());
    }
    return this.handle(key, uid);
  }

  private async handle(key: string, uid: number): Promise<RuntimeHandle> {
    const token = await this.token(key, uid);
    const socket = this.daemonSocket(key);
    // The socket lives in the person's home, so it is theirs: refuse anything else at that path.
    for (const deadline = Date.now() + 120_000; ; await Bun.sleep(100)) {
      const st = existsSync(socket) ? lstatSync(socket) : null;
      if (st?.isSocket() && st.uid === uid) break;
      if (st && !st.isSocket())
        throw new Error("the daemon socket is not a socket");
      if (Date.now() > deadline)
        throw new Error("the daemon socket did not appear");
    }
    return {
      key,
      url: "http://runtime",
      unix: socket,
      token,
      startedAt: this.started.get(key) ?? Date.now(),
    };
  }

  /** Reads the daemon token once per start, as the person; kept only in memory. */
  private async token(key: string, uid: number): Promise<string> {
    const cached = this.tokens.get(key);
    if (cached) return cached;
    for (const deadline = Date.now() + 120_000; Date.now() < deadline;) {
      const r = await this.oneShot(key, uid, ["cat", TOKEN_PATH]).catch(
        () => null,
      );
      const token = r?.stdout.trim() ?? "";
      if (r?.code === 0 && /^[A-Za-z0-9_-]{43}$/.test(token)) {
        this.tokens.set(key, token);
        return token;
      }
      if ((await this.status(key)) !== "running")
        throw new Error("runtime stopped before its daemon was ready");
      await Bun.sleep(150);
    }
    throw new Error("runtime daemon token did not appear");
  }

  stop(key: string) {
    return this.serial(key, async () => {
      this.tokens.delete(key);
      this.started.delete(key);
      const id = this.id(key);
      if ((await this.status(key)) === "running") {
        // Graceful first (tini passes SIGTERM to the daemon), then killed.
        await this.crun(["kill", id, "TERM"]);
        for (
          const until = Date.now() + STOP_TIMEOUT_MS;
          Date.now() < until && (await this.status(key)) === "running";
          await Bun.sleep(250)
        );
        if ((await this.status(key)) === "running")
          await this.crun(["kill", "--all", id, "KILL"]);
      }
      await this.crun(["delete", "-f", id]).catch(() => {});
      rmSync(join(this.bundles(), id), { recursive: true, force: true });
      // The unpacked Claude Code and other temporary files take disk only while it runs.
      rmSync(this.tmp(key), { recursive: true, force: true });
    });
  }

  async restart(key: string) {
    await this.stop(key);
    return this.ensure(key);
  }

  async listRunning() {
    const r = await this.crun(["list", "--format", "json"]);
    if (r.code !== 0) return [];
    const prefix = `${this.cfg.runtimePrefix}-`;
    let list: { id: string; status: string }[] = [];
    try {
      list = JSON.parse(r.stdout || "[]") ?? [];
    } catch {}
    return list
      .filter((c) => c.status === "running" && c.id.startsWith(prefix))
      .map((c) => c.id.slice(prefix.length))
      .filter((k) => /^[0-9a-f]{24}$/.test(k));
  }

  async exec(key: string, cmd: string[]): Promise<ExecResult> {
    await this.setup();
    const r = await this.oneShot(key, await this.uidOf(key), cmd);
    return { exitCode: r.code, stdout: r.stdout };
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
    await this.setup();
    const [file, ...args] = WRITE_FILE_COMMAND;
    const r = await this.oneShot(
      key,
      await this.uidOf(key),
      [file!, ...args, dir, name],
      { stdin: Buffer.from(content) },
    );
    if (r.code !== 0) throw new Error(`writing ${name} failed`);
  }
}
