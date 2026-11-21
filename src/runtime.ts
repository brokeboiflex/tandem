// The person's sandboxes, inside the one Tandem container. Every vendor process runs in a sandbox of
// its own: crun (an OCI runtime) runs it as the person's own uid in its own PID, network, IPC, UTS,
// cgroup and mount namespaces over the read-only runtime filesystem, with only the person's home and
// temporary directory writable (src/security.ts). All of a person's sandboxes are children of the
// person's cgroup, which holds their limits. A sandbox reaches the outside only through the gateway's
// egress and MCP sockets.
import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import type { SandboxSpawnOptions, Sandboxes } from "./agents/types";
import type { Config } from "./config";
import {
  GATEWAY_CGROUP,
  groupFile,
  passwdFile,
  personCgroupLimits,
  RUNTIME_TMPDIR,
  sandboxSeccomp,
  sandboxSpec,
  SANDBOX_EGRESS_PORT,
  type Posture,
} from "./security";

const HOME = "/home/agent";
/** In the runtime filesystem (runtime/agent-run): the relays, then the program. */
export const AGENT_RUN = "/usr/local/bin/agent-run";
/**
 * Every sandbox starts with tini (reaps orphans, passes signals on), then agent-run with the
 * working directory, then the program.
 */
export const SANDBOX_INIT = ["/usr/bin/tini", "-s", "--", AGENT_RUN];
const EXEC_TIMEOUT_MS = 60_000;
/** How long a stopped sandbox may take to end after SIGTERM before it is killed. */
export const STOP_GRACE_MS = 5_000;
/** Each person's uid: from here up, one per person, recorded in DATA_DIR/uids.json. */
export const FIRST_UID = 100_000;
const CONTROLLERS = "+memory +pids +cpu";

const KEY_RE = /^[0-9a-f]{24}$/;
const LABEL_RE = /^[a-z0-9-]{1,24}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Writes standard input to "$1/$2", owner-only, as the person: no content in argv. */
const WRITE_FILE_COMMAND = [
  "sh",
  "-c",
  'umask 077 && mkdir -p "$1" && cat > "$1/$2.tmp" && mv -f "$1/$2.tmp" "$1/$2"',
  "write-file",
];

/** Deterministic, non-reversible runtime identity for a person. */
export function runtimeKey(secret: string, subject: string) {
  return createHmac("sha256", secret)
    .update(`subject:${subject}`)
    .digest("hex")
    .slice(0, 24);
}

type CrunResult = { code: number; stdout: string; stderr: string };

/** The only environment crun itself gets: it never needs the gateway's (and must not pass it on). */
const crunEnv = () => ({
  PATH:
    process.env.PATH ||
    "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
});

/**
 * Makes this container's cgroup v2 tree writable and moves its own processes into a leaf, so every
 * person can get a cgroup with memory and process limits, the way Docker-in-Docker does. Needs only
 * the SYS_ADMIN and AppArmor settings the sandboxes need anyway. Resolves to null, or to why the host
 * cannot (cgroup v1, a controller missing).
 */
export async function delegateCgroups(
  root = "/sys/fs/cgroup",
): Promise<string | null> {
  if (!existsSync(join(root, "cgroup.controllers")))
    return "this host does not use cgroup v2";
  const have = readFileSync(join(root, "cgroup.controllers"), "utf8").split(
    /\s+/,
  );
  const missing = ["memory", "pids", "cpu"].filter((c) => !have.includes(c));
  if (missing.length)
    return `the cgroup controllers ${missing.join(", ")} are not available`;
  const remount = Bun.spawnSync(["mount", "-o", "remount,rw", root]);
  if (remount.exitCode !== 0)
    return `cannot write ${root}: ${remount.stderr.toString().trim()}`;
  // Processes may not live in a cgroup whose children have controllers: move them to a leaf.
  mkdirSync(join(root, "gateway"), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    for (const pid of readFileSync(join(root, "cgroup.procs"), "utf8").split(
      "\n",
    ))
      if (pid)
        try {
          writeFileSync(join(root, "gateway", "cgroup.procs"), pid);
        } catch {} // exited meanwhile
    try {
      writeFileSync(join(root, "cgroup.subtree_control"), CONTROLLERS);
      break;
    } catch (e) {
      if (attempt >= 5)
        return `cannot enable cgroup controllers: ${(e as Error).message}`;
    }
  }
  // Where the kernel offers them; the gateway works without.
  writeCgroupFiles(join(root, "gateway"), GATEWAY_CGROUP, () => true);
  mkdirSync(join(root, "sandboxes"), { recursive: true });
  writeFileSync(join(root, "sandboxes", "cgroup.subtree_control"), CONTROLLERS);
  return null;
}

function writeCgroupFiles(
  dir: string,
  files: Record<string, string>,
  optional: (name: string) => boolean,
) {
  for (const [name, value] of Object.entries(files))
    try {
      writeFileSync(join(dir, name), value);
    } catch (e) {
      if (!optional(name)) throw e;
    }
}

/** The first uid at or above FIRST_UID that no person holds. */
export function nextUid(taken: Iterable<number>): number {
  const used = new Set(taken);
  let uid = FIRST_UID;
  while (used.has(uid)) uid++;
  return uid;
}

export type RuntimeOptions = {
  log?: (...args: unknown[]) => void;
  /** The crun program (tests: a stand-in). */
  crun?: string;
  /** The cgroup v2 tree of this container (tests: a plain directory). */
  cgroupRoot?: string;
  /**
   * Delete the sandboxes and cgroups of this prefix that are still there at setup (a previous
   * gateway run). The gateway does; operator commands next to it (src/cli.ts) must not.
   */
  sweep?: boolean;
  /** STOP_GRACE_MS (tests). */
  stopGraceMs?: number;
};

/** A sandbox this runtime started and that is not gone yet. */
type Box = {
  key: string;
  id: string;
  /** Its cgroup (a child of the person's), when cgroups are delegated. */
  cgroup?: string;
  /** crun runs for it; its own kill, for a sandbox crun has not created yet. */
  killCrun?: (signal: NodeJS.Signals) => void;
  exited: boolean;
  stopRequested: boolean;
  stopTimer?: ReturnType<typeof setTimeout>;
  released?: Promise<void>;
  /** Resolves once the sandbox is deleted and the person's state is updated. */
  gone: Promise<void>;
  done(): void;
};

export class SandboxRuntime implements Sandboxes {
  private ready?: Promise<void>;
  /** Per-person cgroups available (delegateCgroups). */
  private cgroups = false;
  private warnings: string[] = [];
  private seccomp = sandboxSeccomp();
  /** Sandboxes started by this runtime that are not gone yet, by person. */
  private boxes = new Map<string, Map<string, Box>>();
  private queues = new Map<string, Promise<unknown>>();
  private uidLock: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private closed = false;
  private log: (...args: unknown[]) => void;
  private crunBin: string;
  private cgroupRoot: string;
  private sweep: boolean;
  private grace: number;

  constructor(
    private cfg: Config,
    opts: RuntimeOptions = {},
  ) {
    this.log = opts.log ?? console.log;
    this.crunBin = opts.crun ?? "crun";
    this.cgroupRoot = opts.cgroupRoot ?? "/sys/fs/cgroup";
    this.sweep = opts.sweep ?? true;
    this.grace = opts.stopGraceMs ?? STOP_GRACE_MS;
  }

  private prefix = () => `${this.cfg.runtimePrefix}-`;
  private home = (key: string) => join(this.cfg.dataDir, "homes", key);
  private runDir = (key: string) => join(this.cfg.dataDir, "run", key);
  private bundles = () => join(this.cfg.dataDir, "bundles");
  private tmp = (key: string) => join(this.cfg.dataDir, "tmp", key);
  private probeHome = () => join(this.cfg.dataDir, "run", "probe-home");
  /** The person's cgroup, as a path under the cgroup root. */
  private personCgroup = (key: string) => `/sandboxes/${this.prefix()}${key}`;
  mcpSocket = (key: string) => join(this.runDir(key), "mcp.sock");
  egressSocket = () => join(this.cfg.dataDir, "run", "egress.sock");

  homeOf(key: string) {
    return this.home(checkKey(key));
  }

  posture(): Promise<Posture> {
    return this.setup().then(() => ({
      sandbox: "namespaces",
      egress: this.cfg.egressMode,
      limits: this.cgroups,
      warnings: this.warnings,
    }));
  }

  /**
   * Once: the directories, the cgroup tree, what a previous gateway run left, and a check that this
   * container can create sandboxes (compose.yaml grants it SYS_ADMIN and NET_ADMIN and turns AppArmor
   * off for it), with a throwaway sandbox that runs `true`.
   */
  private setup(): Promise<void> {
    return (this.ready ??= (async () => {
      for (const dir of ["homes", "run", "bundles", "tmp"])
        mkdirSync(join(this.cfg.dataDir, dir), {
          recursive: true,
          mode: 0o711,
        });
      chmodSync(join(this.cfg.dataDir, "run"), 0o711);
      if (!existsSync(join(this.cfg.runtimeRootfs, AGENT_RUN)))
        throw new Error(`no runtime filesystem at ${this.cfg.runtimeRootfs}`);
      const why = await this.delegate();
      this.cgroups = why === null;
      if (why)
        this.warnings.push(
          `no per-person memory and process limits: ${why}. Limit the whole container instead.`,
        );
      if (this.sweep) await this.sweepLeftovers();
      const probe = await this.oneShot(null, ["true"]);
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

  /** Overridden in tests, which have no cgroup tree to delegate. */
  protected delegate() {
    return delegateCgroups(this.cgroupRoot);
  }

  /** crun with this runtime's cgroup setting; output collected. `box`: the one-shot it runs. */
  private async crun(
    args: string[],
    opts: { stdin?: Buffer; timeoutMs?: number; box?: Box } = {},
  ): Promise<CrunResult> {
    const p = Bun.spawn([this.crunBin, this.manager(), ...args], {
      stdin: opts.stdin ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: crunEnv(),
    });
    if (opts.box) this.started(opts.box, (signal) => p.kill(signal));
    const timer = opts.timeoutMs
      ? setTimeout(() => p.kill("SIGKILL"), opts.timeoutMs)
      : undefined;
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    clearTimeout(timer);
    return { code, stdout, stderr };
  }

  /** With delegated cgroups crun creates each sandbox's cgroup; otherwise it leaves cgroups alone. */
  private manager() {
    return `--cgroup-manager=${this.cgroups ? "cgroupfs" : "disabled"}`;
  }

  private serial<T>(key: string, job: () => Promise<T> | T): Promise<T> {
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

  /** Home, passwd/group, temporary directory, MCP socket owner and cgroup, before a sandbox starts. */
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
    // Running sandboxes have these mounted: rewriting one would show them an empty file meanwhile.
    for (const [name, text] of [
      ["passwd", passwdFile(uid)],
      ["group", groupFile(uid)],
    ] as const) {
      const file = join(run, name);
      if (!existsSync(file) || readFileSync(file, "utf8") !== text)
        writeFileSync(file, text, { mode: 0o644 });
    }
    // Shared by the person's sandboxes; removed when the last one ends (release).
    const tmp = this.tmp(key);
    if (!existsSync(tmp)) {
      mkdirSync(tmp, { mode: 0o700 });
      // Only root can hand a directory to another user (the gateway runs as root in its container).
      if (process.getuid?.() === 0) chownSync(tmp, uid, uid);
    }
    // The gateway listens on it (listenMcp) before the start; only the person may connect.
    if (existsSync(this.mcpSocket(key))) {
      if (process.getuid?.() === 0) chownSync(this.mcpSocket(key), uid, uid);
      chmodSync(this.mcpSocket(key), 0o600);
    }
    this.ensurePersonCgroup(key);
  }

  /** The person's cgroup with their limits, created with their first sandbox. */
  private ensurePersonCgroup(key: string) {
    if (!this.cgroups) return;
    const dir = join(this.cgroupRoot, this.personCgroup(key));
    if (existsSync(dir)) return;
    mkdirSync(dir, { recursive: true });
    writeCgroupFiles(
      dir,
      personCgroupLimits(this.cfg.runtimeMemoryMb, this.cfg.runtimePids),
      (name) => name === "memory.swap.max", // only with swap accounting
    );
    writeFileSync(join(dir, "cgroup.subtree_control"), CONTROLLERS);
  }

  /**
   * Removes a cgroup, children first. `kill`: ends whatever still runs in it (leftovers, stopAll);
   * otherwise a cgroup that is still in use (a sandbox of another process, src/cli.ts) is left.
   */
  private async removeCgroup(dir: string, kill: boolean): Promise<void> {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    for (const e of entries)
      if (e.isDirectory()) await this.removeCgroup(join(dir, e.name), kill);
    if (kill)
      try {
        writeFileSync(join(dir, "cgroup.kill"), "1");
      } catch {
        // Kernels before 5.14 have no cgroup.kill.
        for (const pid of readFileSync(join(dir, "cgroup.procs"), "utf8").split("\n"))
          if (pid) process.kill(Number(pid), "SIGKILL");
      }
    for (const until = Date.now() + (kill ? 5_000 : 1_000); ; await Bun.sleep(20)) {
      try {
        return rmdirSync(dir);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return;
        // cgroupfs answers EBUSY while processes remain; only a plain directory (tests) is ENOTEMPTY.
        if (code === "ENOTEMPTY") return rmSync(dir, { recursive: true, force: true });
        if (code !== "EBUSY") throw e;
        if (Date.now() > until) {
          if (kill) throw e;
          return;
        }
      }
    }
  }

  /** Records a new sandbox of `key` (inside its serial job, so the person's state stays). */
  private hold(key: string, label: string): Box {
    if (this.closed) throw new Error("the sandboxes are shutting down");
    const name = `${label}-${process.pid}-${++this.seq}`;
    let done!: () => void;
    const gone = new Promise<void>((resolve) => (done = resolve));
    const box: Box = {
      key,
      id: `${this.prefix()}${key}-${name}`,
      cgroup: this.cgroups ? `${this.personCgroup(key)}/${name}` : undefined,
      exited: false,
      stopRequested: false,
      gone,
      done,
    };
    let mine = this.boxes.get(key);
    if (!mine) this.boxes.set(key, (mine = new Map()));
    mine.set(box.id, box);
    return box;
  }

  /**
   * After the sandbox's crun exited: delete it (crun run deletes its own; this catches a killed
   * crun's), and when it was the person's last, remove their temporary files and their cgroup.
   */
  private release(box: Box): Promise<void> {
    return (box.released ??= (async () => {
      box.exited = true;
      clearTimeout(box.stopTimer);
      await this.crun(["delete", "-f", box.id]).catch(() => {});
      rmSync(join(this.bundles(), box.id), { recursive: true, force: true });
      await this.serial(box.key, async () => {
        const mine = this.boxes.get(box.key);
        mine?.delete(box.id);
        if (mine?.size) return;
        this.boxes.delete(box.key);
        await this.forget(box.key, false);
      });
      box.done();
    })());
  }

  /** No sandbox of the person runs: their temporary directory and cgroup go. */
  private async forget(key: string, kill: boolean) {
    rmSync(this.tmp(key), { recursive: true, force: true });
    if (this.cgroups)
      await this.removeCgroup(join(this.cgroupRoot, this.personCgroup(key)), kill).catch(
        (e) => this.log(`cannot remove the cgroup of ${key}: ${(e as Error).message}`),
      );
  }

  /** The sandbox's spec: `key` null is the setup probe (nobody's home). */
  private spec(
    key: string | null,
    uid: number,
    box: Box,
    args: string[],
    opts: { env?: Record<string, string>; cwd?: string; mcp: boolean },
  ) {
    const mcp = key !== null && opts.mcp && existsSync(this.mcpSocket(key));
    return sandboxSpec({
      uid,
      rootfs: this.cfg.runtimeRootfs,
      home: key ? this.home(key) : this.probeHome(),
      tmp: key ? this.tmp(key) : this.probeHome(),
      seccomp: this.seccomp,
      cgroup: box.cgroup ? { path: box.cgroup } : undefined,
      passwd: key ? join(this.runDir(key), "passwd") : "/etc/passwd",
      group: key ? join(this.runDir(key), "group") : "/etc/group",
      egressSocket: this.egressSocket(),
      mcpSocket: mcp ? this.mcpSocket(key!) : undefined,
      // agent-run makes the working directory as the person (the home always exists).
      args: [...SANDBOX_INIT, opts.cwd ?? HOME, ...args],
      cwd: HOME,
      pids: this.cfg.runtimePids,
      // Only this: never the gateway's own environment.
      env: {
        HOME,
        TMPDIR: RUNTIME_TMPDIR,
        // Every connection out goes through the egress relay to the gateway's Smokescreen;
        // loopback (the MCP relay) must not.
        HTTPS_PROXY: `http://127.0.0.1:${SANDBOX_EGRESS_PORT}`,
        HTTP_PROXY: `http://127.0.0.1:${SANDBOX_EGRESS_PORT}`,
        https_proxy: `http://127.0.0.1:${SANDBOX_EGRESS_PORT}`,
        http_proxy: `http://127.0.0.1:${SANDBOX_EGRESS_PORT}`,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
        ...opts.env,
      },
    });
  }

  private writeBundle(id: string, spec: object) {
    const dir = join(this.bundles(), id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "config.json"), JSON.stringify(spec), {
      mode: 0o600,
    });
    return dir;
  }

  /** A sandbox for `args` with stdio piped; see Sandboxes.spawn. */
  async spawn(
    key: string,
    args: string[],
    opts: SandboxSpawnOptions = {},
  ): Promise<ChildProcess> {
    checkKey(key);
    checkCommand(args, opts.env, opts.cwd);
    const label = opts.label ?? "proc";
    if (!LABEL_RE.test(label))
      throw new Error(`invalid sandbox label "${label}"`);
    await this.setup();
    const uid = await this.uidOf(key);
    const box = await this.serial(key, async () => {
      await this.prepare(key, uid);
      return this.hold(key, label);
    });
    let child: ChildProcess;
    try {
      const bundle = this.writeBundle(
        box.id,
        this.spec(key, uid, box, args, {
          env: opts.env,
          cwd: opts.cwd,
          mcp: true,
        }),
      );
      child = spawnProcess(
        this.crunBin,
        [
          this.manager(),
          "run",
          "--no-pivot",
          "--no-new-keyring",
          "--bundle",
          bundle,
          box.id,
        ],
        { stdio: ["pipe", "pipe", "pipe"], env: crunEnv() },
      );
      const killCrun = child.kill.bind(child);
      this.started(box, (signal) => void killCrun(signal));
      await new Promise<void>((resolve, reject) =>
        child.once("spawn", resolve).once("error", reject),
      );
    } catch (e) {
      await this.release(box);
      throw e;
    }
    this.adopt(box, child);
    return child;
  }

  /**
   * Makes crun's process stand for the sandbox: kill() stops the sandbox, and `exit`, `close`,
   * exitCode and signalCode appear once it is gone.
   */
  private adopt(box: Box, child: ChildProcess) {
    let gone = false;
    let exitCode: number | null = null;
    let signalCode: NodeJS.Signals | null = null;
    for (const [name, set] of [
      ["exitCode", (v: number | null) => (exitCode = v)],
      ["signalCode", (v: NodeJS.Signals | null) => (signalCode = v)],
    ] as const)
      Object.defineProperty(child, name, {
        configurable: true,
        enumerable: true,
        get: () =>
          gone ? (name === "exitCode" ? exitCode : signalCode) : null,
        set,
      });
    const emit = child.emit.bind(child);
    const held: (string | symbol)[] = [];
    child.emit = ((event: string | symbol, ...rest: unknown[]) => {
      if (gone || (event !== "exit" && event !== "close"))
        return emit(event, ...rest);
      held.push(event);
      void this.release(box).then(() => {
        if (gone) return;
        gone = true;
        for (const e of held) emit(e, exitCode, signalCode);
      });
      return true;
    }) as typeof child.emit;
    child.kill = ((signal?: NodeJS.Signals | number) => {
      if (box.exited) return false;
      if (signal === 0) return true; // only asks whether it runs
      const name = signalName(signal);
      (child as { killed: boolean }).killed = true;
      if (name === "KILL") void this.killNow(box);
      else if (name === "TERM") void this.stop(box);
      else void this.crun(["kill", box.id, name]);
      return true;
    }) as typeof child.kill;
  }

  /** crun now runs for `box`: a stop asked for meanwhile starts now. */
  private started(box: Box, killCrun: (signal: NodeJS.Signals) => void) {
    box.killCrun = killCrun;
    if (box.stopRequested) void this.stop(box);
  }

  /**
   * TERM to the sandbox (tini passes it to the program), KILL after STOP_GRACE_MS. TERM is repeated
   * while crun has not created the sandbox yet (a stop right after the start).
   */
  private stop(box: Box): Promise<void> {
    box.stopRequested = true;
    if (box.killCrun && !box.exited && !box.stopTimer) {
      box.stopTimer = setTimeout(() => void this.killNow(box), this.grace);
      void (async () => {
        for (const until = Date.now() + this.grace; !box.exited && Date.now() < until; ) {
          if ((await this.crun(["kill", box.id, "TERM"])).code === 0) return;
          await Bun.sleep(50);
        }
      })();
    }
    return box.gone;
  }

  /** KILL to the sandbox's init ends its whole PID namespace. */
  private async killNow(box: Box) {
    if (box.exited) return;
    const r = await this.crun(["kill", box.id, "KILL"]);
    // crun has not created it yet (or refused): end crun; deleting the sandbox ends the rest.
    if (r.code !== 0 && !box.exited) box.killCrun?.("SIGKILL");
  }

  /** One command in a throwaway sandbox of the person (`key` null: the setup probe), output back. */
  private async oneShot(
    key: string | null,
    args: string[],
    opts: { env?: Record<string, string>; cwd?: string; stdin?: Buffer } = {},
  ) {
    const uid = key ? await this.uidOf(key) : FIRST_UID - 1;
    const owner = key ?? "probe";
    const box = await this.serial(owner, async () => {
      if (key) await this.prepare(key, uid);
      else {
        mkdirSync(this.probeHome(), { recursive: true });
        this.ensurePersonCgroup(owner);
      }
      return this.hold(owner, key ? "exec" : "check");
    });
    try {
      const bundle = this.writeBundle(
        box.id,
        this.spec(key, uid, box, args, {
          env: opts.env,
          cwd: opts.cwd,
          mcp: false,
        }),
      );
      return await this.crun(
        ["run", "--no-pivot", "--no-new-keyring", "--bundle", bundle, box.id],
        { stdin: opts.stdin, timeoutMs: EXEC_TIMEOUT_MS, box },
      );
    } finally {
      await this.release(box);
    }
  }

  async exec(
    key: string,
    args: string[],
    opts: { env?: Record<string, string>; stdin?: Buffer; cwd?: string } = {},
  ) {
    checkKey(key);
    checkCommand(args, opts.env, opts.cwd);
    await this.setup();
    const r = await this.oneShot(key, args, opts);
    return { exitCode: r.code, stdout: r.stdout, stderr: r.stderr };
  }

  async writePrivateFile(
    key: string,
    dir: string,
    name: string,
    content: string,
  ) {
    if (!dir.startsWith(`${HOME}/`) || !/^[A-Za-z0-9._-]+$/.test(name))
      throw new Error("writePrivateFile: path outside the runtime home");
    const r = await this.exec(key, [...WRITE_FILE_COMMAND, dir, name], {
      stdin: Buffer.from(content),
    });
    if (r.exitCode !== 0) throw new Error(`writing ${name} failed`);
  }

  /** Sandboxes of this instance that crun knows of, running or not. */
  async list(): Promise<{ id: string; key: string | null; status: string }[]> {
    const r = await this.crun(["list", "--format", "json"]);
    if (r.code !== 0) return [];
    let all: { id: string; status: string }[] = [];
    try {
      all = JSON.parse(r.stdout || "[]") ?? [];
    } catch {}
    const prefix = this.prefix();
    return all
      .filter((c) => c.id.startsWith(prefix))
      .map((c) => {
        const key = c.id.slice(prefix.length, prefix.length + 24);
        return {
          id: c.id,
          key:
            KEY_RE.test(key) && c.id[prefix.length + 24] === "-" ? key : null,
          status: c.status,
        };
      });
  }

  /** Sandboxes crun knows of whose id starts with `start` and that this runtime did not start. */
  private async strays(start: string) {
    const mine = new Set(
      [...this.boxes.values()].flatMap((m) => [...m.keys()]),
    );
    return (await this.list())
      .map((c) => c.id)
      .filter((id) => id.startsWith(start) && !mine.has(id));
  }

  /** A sandbox started elsewhere (another process): TERM, then deleted (KILL) after the grace. */
  private async stopStray(id: string) {
    await this.crun(["kill", id, "TERM"]);
    for (
      const until = Date.now() + this.grace;
      Date.now() < until;
      await Bun.sleep(100)
    ) {
      const r = await this.crun(["state", id]);
      if (r.code !== 0 || !r.stdout.includes('"running"')) break;
    }
    await this.crun(["delete", "-f", id]).catch(() => {});
  }

  /** Stops every sandbox of the person (sign-out, an operator's stop); their cgroup goes with them. */
  async stopAll(key: string) {
    checkKey(key);
    await this.setup();
    const mine = [...(this.boxes.get(key)?.values() ?? [])];
    const strays = await this.strays(`${this.prefix()}${key}-`);
    await Promise.all([
      ...mine.map((b) => this.stop(b)),
      ...strays.map((id) => this.stopStray(id)),
    ]);
    await this.serial(key, async () => {
      if (!this.boxes.get(key)?.size) await this.forget(key, true);
    });
  }

  /** Shutdown: stops every sandbox of this instance and starts no more. */
  async stopEverything() {
    this.closed = true;
    if (
      !this.ready ||
      !(await this.ready.then(
        () => true,
        () => false,
      ))
    )
      return;
    const mine = [...this.boxes.values()].flatMap((m) => [...m.values()]);
    const strays = await this.strays(this.prefix());
    await Promise.all([
      ...mine.map((b) => this.stop(b)),
      ...strays.map((id) => this.stopStray(id)),
    ]);
    await this.removePersonCgroups();
  }

  /** What a gateway that was killed left: its sandboxes, their cgroups, bundles and temporary files. */
  private async sweepLeftovers() {
    const left = (await this.list()).map((c) => c.id);
    await Promise.all(
      left.map((id) => this.crun(["delete", "-f", id]).catch(() => {})),
    );
    await this.removePersonCgroups();
    for (const dir of [this.bundles(), join(this.cfg.dataDir, "tmp")])
      for (const name of readdirSync(dir))
        rmSync(join(dir, name), { recursive: true, force: true });
    if (left.length)
      this.log(`removed ${left.length} sandbox(es) left from an earlier run`);
  }

  private async removePersonCgroups() {
    if (!this.cgroups) return;
    const sandboxes = join(this.cgroupRoot, "sandboxes");
    if (!existsSync(sandboxes)) return;
    for (const e of readdirSync(sandboxes, { withFileTypes: true }))
      if (e.isDirectory() && e.name.startsWith(this.prefix()))
        await this.removeCgroup(join(sandboxes, e.name), true).catch((err) =>
          this.log(
            `cannot remove the cgroup ${e.name}: ${(err as Error).message}`,
          ),
        );
  }
}

function checkKey(key: string) {
  if (!KEY_RE.test(key)) throw new Error("invalid runtime key");
  return key;
}

function checkCommand(
  args: string[],
  env: Record<string, string> = {},
  cwd?: string,
) {
  if (
    !args.length ||
    args.some((a) => typeof a !== "string" || a.includes("\0"))
  )
    throw new Error("invalid sandbox command");
  for (const [k, v] of Object.entries(env))
    if (!ENV_NAME_RE.test(k) || typeof v !== "string" || v.includes("\0"))
      throw new Error(`invalid environment variable "${k}"`);
  if (cwd !== undefined && (!cwd.startsWith("/") || cwd.includes("\0")))
    throw new Error("the sandbox working directory must be an absolute path");
}

/** "TERM" for undefined, "SIGTERM", 15. */
function signalName(signal?: NodeJS.Signals | number): string {
  if (signal === undefined) return "TERM";
  const name =
    typeof signal === "number"
      ? Object.entries(constants.signals).find(([, n]) => n === signal)?.[0]
      : signal;
  if (!name || !(name in constants.signals))
    throw new Error(`unknown signal ${signal}`);
  return name.replace(/^SIG/, "");
}
