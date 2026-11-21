// What keeps people apart: the configuration, the egress proxy's ACL, the sandbox spec, and the
// sandbox controller (src/runtime.ts) against a fake crun that reads the bundles it is given.
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config";
import { smokescreenArgs } from "../src/egress";
import { proxyToken, PROXY_TOKEN_ENV } from "../src/mcp";
import {
  DAEMON_ARGS,
  FIRST_UID,
  nextUid,
  SandboxRuntime,
  WITH_EGRESS,
  type Crun,
} from "../src/runtime";
import {
  allowedHosts,
  RUNTIME_TMPDIR,
  sandboxSeccomp,
  sandboxSpec,
  SANDBOX_EGRESS_SOCKET,
  SANDBOX_MCP_SOCKET,
  smokescreenAcl,
} from "../src/security";

const BASE_ENV = {
  AUTH_MODE: "dev",
  DEV_AUTH_SECRET: "d".repeat(32),
  SERVICE_SECRET: "s".repeat(32),
};

/** loadConfig() with exactly these variables (plus the required secrets). */
function configWith(vars: Record<string, string> = {}): Config {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env))
    if (/^(RUNTIME_|EGRESS_|DATA_DIR|MCP_)/.test(k)) delete process.env[k];
  Object.assign(process.env, BASE_ENV, vars);
  try {
    return loadConfig();
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

const work = mkdtempSync("/tmp/tsec-");
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("configuration", () => {
  test("defaults: allowlist egress, 512 processes per person, data in /var/lib/tandem", () => {
    expect(configWith()).toMatchObject({
      egressMode: "allowlist",
      runtimePids: 512,
      dataDir: "/var/lib/tandem",
      runtimeRootfs: "/opt/tandem/rootfs",
    });
  });

  test("invalid values stop the gateway with the variable's name", () => {
    for (const [vars, message] of [
      [{ EGRESS_MODE: "off" }, "EGRESS_MODE"],
      [{ EGRESS_ALLOW_RANGES: "10.0.0.0" }, "EGRESS_ALLOW_RANGES"],
      [{ RUNTIME_PIDS: "8" }, "RUNTIME_PIDS"],
      [{ RUNTIME_ROOTFS: "rootfs" }, "RUNTIME_ROOTFS"],
      [{ DATA_DIR: "relative/path" }, "DATA_DIR"],
      [{ DATA_DIR: `/${"x".repeat(45)}` }, "DATA_DIR"],
      [{ RUNTIME_PREFIX: "Has.Dots" }, "RUNTIME_PREFIX"],
    ] as const)
      expect(() => configWith(vars)).toThrow(message);
  });
});

describe("egress proxy (Smokescreen)", () => {
  test("allowlist: the shipped list plus EGRESS_ALLOW_DOMAINS, enforced", () => {
    const acl = smokescreenAcl(
      configWith({
        EGRESS_ALLOW_DOMAINS: "registry.npmjs.org, *.Internal.Example",
      }),
    );
    expect(acl).toContain("action: enforce");
    for (const host of [
      "anthropic.com",
      "*.anthropic.com",
      "openrouter.ai",
      "registry.npmjs.org",
      "*.internal.example",
    ])
      expect(acl).toContain(`- "${host}"`);
    expect(acl).not.toContain('example.com"');
  });

  test("open: any public host; private ranges only when listed", () => {
    const cfg = configWith({
      EGRESS_MODE: "open",
      EGRESS_ALLOW_RANGES: "10.20.0.0/16",
    });
    expect(smokescreenAcl(cfg)).toContain("action: open");
    const args = smokescreenArgs(cfg, "/x");
    expect(args).toContain("127.0.0.1"); // the container's loopback, which no sandbox reaches
    expect(args.slice(args.indexOf("--allow-range"))).toEqual([
      "--allow-range",
      "10.20.0.0/16",
    ]);
    expect(smokescreenArgs(configWith(), "/x")).not.toContain("--allow-range");
  });

  test("hostnames are validated", () => {
    expect(() => allowedHosts("", ["exa mple.com"])).toThrow("not a hostname");
    expect(() => allowedHosts("http://x.com\n", [])).toThrow("not a hostname");
    expect(
      allowedHosts("# comment\nA.com\n\n*.b.org # trailing\n", []),
    ).toEqual(["*.b.org", "a.com"]);
  });
});

describe("the sandbox spec", () => {
  test("its own cgroup: memory, CPU and process limits, and the seccomp filter", () => {
    expect((spec.linux as any).cgroupsPath).toBe("/sandboxes/tandem-abc");
    expect((spec.linux as any).resources).toEqual({
      memory: { limit: 1024 * 1024 * 1024 },
      cpu: { quota: 150_000, period: 100_000 },
      pids: { limit: 512 },
    });
    expect((spec.linux as any).seccomp).toEqual({ marker: "seccomp" });
  });

  test("the seccomp filter is Docker's default for a process without capabilities", () => {
    for (const arch of ["x64", "arm64"]) {
      const f = sandboxSeccomp(undefined, arch, "6.8.0-134-generic");
      expect(f.defaultAction).toBe("SCMP_ACT_ERRNO");
      const allowed = new Set(
        f.syscalls.filter((r: any) => r.action === "SCMP_ACT_ALLOW" && !r.args).flatMap((r: any) => r.names),
      );
      for (const name of ["read", "write", "openat", "execve", "connect"])
        expect(allowed.has(name)).toBe(true);
      // socket() per address family: Unix and IPv4 (below 3) and IPv6 (10) among them.
      const families = f.syscalls
        .filter((r: any) => r.names.length === 1 && r.names[0] === "socket" && r.action === "SCMP_ACT_ALLOW")
        .map((r: any) => `${r.args?.[0]?.op}:${r.args?.[0]?.value}`);
      expect(families).toContain("SCMP_CMP_LT:3");
      expect(families).toContain("SCMP_CMP_EQ:10");
      // Allowed to the Tandem container (SYS_ADMIN), never to a sandbox.
      for (const name of ["mount", "umount2", "unshare", "setns", "bpf", "keyctl", "pivot_root"])
        expect(allowed.has(name)).toBe(false);
    }
    expect(sandboxSeccomp(undefined, "x64").architectures[0]).toBe("SCMP_ARCH_X86_64");
    expect(() => sandboxSeccomp(undefined, "ppc64")).toThrow("no seccomp profile");
  });

  const spec = sandboxSpec({
    uid: 100_007,
    rootfs: "/opt/tandem/rootfs",
    home: "/data/homes/abc",
    passwd: "/data/run/abc/passwd",
    group: "/data/run/abc/group",
    tmp: "/data/tmp/abc",
    egressSocket: "/data/run/egress.sock",
    mcpSocket: "/data/run/abc/mcp.sock",
    args: ["/bin/true"],
    env: { HOME: "/home/agent" },
    pids: 512,
    seccomp: { marker: "seccomp" },
    cgroup: { path: "/sandboxes/tandem-abc", memoryMb: 1024, cpus: 1.5 },
  });

  test("the person's own uid, no capabilities, no new privileges, a read-only system", () => {
    expect(spec.process.user).toEqual({
      uid: 100_007,
      gid: 100_007,
      additionalGids: [],
    });
    for (const set of Object.values(spec.process.capabilities))
      expect(set).toEqual([]);
    expect(spec.process.noNewPrivileges).toBe(true);
    expect(spec.root).toEqual({ path: "/opt/tandem/rootfs", readonly: true });
    expect(spec.process.rlimits).toContainEqual({
      type: "RLIMIT_NPROC",
      hard: 512,
      soft: 512,
    });
  });

  test("its own PID, network (loopback only), IPC, UTS, cgroup and mount namespaces", () => {
    expect(spec.linux.namespaces.map((n) => n.type).sort()).toEqual([
      "cgroup",
      "ipc",
      "mount",
      "network",
      "pid",
      "uts",
    ]);
    expect(spec.linux.maskedPaths).toContain("/proc/kcore");
    expect(spec.linux.readonlyPaths).toContain("/proc/sys");
  });

  test("the only host paths inside: the person's home (writable), their passwd/group, the two sockets", () => {
    const binds = spec.mounts.filter((m) => m.type === "bind");
    expect(
      binds.map((m) => [m.source, m.destination, m.options.includes("rw")]),
    ).toEqual([
      ["/data/homes/abc", "/home/agent", true],
      ["/data/tmp/abc", RUNTIME_TMPDIR, true],
      ["/data/run/abc/passwd", "/etc/passwd", false],
      ["/data/run/abc/group", "/etc/group", false],
      ["/data/run/egress.sock", SANDBOX_EGRESS_SOCKET, false],
      ["/data/run/abc/mcp.sock", SANDBOX_MCP_SOCKET, false],
    ]);
    expect(
      spec.mounts.find((m) => m.destination === "/tmp")?.options,
    ).toContain("noexec");
  });
});

// --- The controller against a fake crun -----------------------------------------------------------

type Box = { config: any; running: boolean };

function fakeCrun(dataDir: string) {
  const boxes = new Map<string, Box>();
  const calls: string[][] = [];
  const oneShots: {
    args: string[];
    env: string[];
    mounts: any[];
    stdin?: string;
    uid: number;
  }[] = [];
  const tokens = new Map<string, string>(); // home -> daemon token
  const servers: { stop(): void }[] = [];
  const homeOf = (config: any) =>
    config.mounts.find((m: any) => m.destination === "/home/agent")
      ?.source as string;
  const run: Crun = async (args, opts = {}) => {
    calls.push(opts.cgroups ? ["cgroups", ...args] : args);
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    const [cmd] = args;
    const id = args[args.length - 1]!;
    if (cmd === "state")
      return boxes.get(id)?.running
        ? ok(JSON.stringify({ id, status: "running" }))
        : { code: 1, stdout: "", stderr: "no such container" };
    if (cmd === "delete") {
      boxes.delete(id);
      return ok();
    }
    if (cmd === "kill") {
      const box = boxes.get(args.includes("--all") ? args[2]! : args[1]!);
      if (box) box.running = false;
      return ok();
    }
    if (cmd === "list")
      return ok(
        JSON.stringify(
          [...boxes].map(([id, b]) => ({
            id,
            status: b.running ? "running" : "stopped",
          })),
        ),
      );
    if (cmd === "run") {
      const bundle = args[args.indexOf("--bundle") + 1]!;
      const config = JSON.parse(
        readFileSync(join(bundle, "config.json"), "utf8"),
      );
      const home = homeOf(config);
      if (args.includes("--detach")) {
        boxes.set(id, { config, running: true });
        tokens.set(home, "T".repeat(43));
        const sock = join(home, ".happy", "agent", "server.sock");
        mkdirSync(join(home, ".happy", "agent"), { recursive: true });
        rmSync(sock, { force: true });
        servers.push(Bun.listen({ unix: sock, socket: { data() {} } }));
        return ok();
      }
      const inner = config.process.args.slice(1); // after with-egress
      oneShots.push({
        args: config.process.args,
        env: config.process.env,
        mounts: config.mounts,
        stdin: opts.stdin?.toString(),
        uid: config.process.user.uid,
      });
      if (inner[0] === "rm") tokens.delete(home);
      if (inner[0] === "cat")
        return tokens.has(home)
          ? ok(tokens.get(home))
          : { code: 1, stdout: "", stderr: "" };
      return ok();
    }
    return ok();
  };
  return { run, boxes, calls, oneShots, servers };
}

/** The controller with or without delegated cgroups (tests have no cgroup tree). */
class TestRuntime extends SandboxRuntime {
  cgroupReason: string | null = "no cgroup tree in tests";
  protected override delegate() {
    return Promise.resolve(this.cgroupReason);
  }
}

function controller(vars: Record<string, string> = {}, cgroups = false) {
  const dataDir = mkdtempSync(join(work, "d"));
  const rootfs = join(dataDir, "rootfs");
  mkdirSync(join(rootfs, "usr/local/bin"), { recursive: true });
  writeFileSync(join(rootfs, "usr/local/bin/happy-agent"), "");
  const cfg = configWith({
    DATA_DIR: dataDir,
    RUNTIME_ROOTFS: rootfs,
    ...vars,
  });
  const fake = fakeCrun(dataDir);
  const rt = new TestRuntime(cfg, () => {}, fake.run);
  if (cgroups) rt.cgroupReason = null;
  afterAll(() => fake.servers.forEach((s) => s.stop()));
  return { cfg, rt, ...fake };
}

/** Homes in tests are owned by the test user: pin the person's uid to it. */
function ownUid(cfg: Config, ...keys: string[]) {
  const uid = process.getuid!();
  writeFileSync(
    join(cfg.dataDir, "uids.json"),
    JSON.stringify(Object.fromEntries(keys.map((k) => [k, uid]))),
  );
  return uid;
}

describe("one sandbox per person", () => {
  const KEY = "0123456789abcdef01234567";

  test("a container that cannot create sandboxes stops the gateway with what it needs", async () => {
    const { rt } = controller();
    (rt as any).run = async () => ({
      code: 1,
      stdout: "",
      stderr: "mount: Permission denied",
    });
    expect(rt.posture()).rejects.toThrow(
      /SYS_ADMIN and NET_ADMIN.*apparmor=unconfined/,
    );
  });

  test("the daemon starts under tini as the person, with the proxy settings and the MCP route", async () => {
    const { cfg, rt, boxes, calls } = controller();
    const uid = ownUid(cfg, KEY);
    const h = await rt.ensure(KEY);
    const box = boxes.get(`tandem-${KEY}`)!;
    expect(box.config.process.args).toEqual(DAEMON_ARGS);
    expect(box.config.process.user.uid).toBe(uid);
    const env = Object.fromEntries(
      box.config.process.env.map((e: string) => e.split(/=(.*)/s).slice(0, 2)),
    );
    expect(env).toMatchObject({
      HOME: "/home/agent",
      HTTPS_PROXY: "http://127.0.0.1:4750",
      NO_PROXY: "127.0.0.1,localhost",
      MCP_PROXY_URL: `http://127.0.0.1:8790/mcp/${KEY}`,
      [PROXY_TOKEN_ENV]: proxyToken(cfg.serviceSecret, KEY),
    });
    expect(
      box.config.mounts.find((m: any) => m.destination === "/home/agent")
        .source,
    ).toBe(join(cfg.dataDir, "homes", KEY));
    expect(h).toMatchObject({
      key: KEY,
      unix: join(cfg.dataDir, "homes", KEY, ".happy/agent/server.sock"),
      token: "T".repeat(43),
    });
    // The previous start's token was removed before the daemon started.
    const rm = calls.findIndex(
      (c) => c[0] === "run" && !c.includes("--detach") && calls.indexOf(c) > 0,
    );
    const start = calls.findIndex((c) => c.includes("--detach"));
    expect(rm).toBeLessThan(start);
    // Running: a second ensure starts nothing.
    await rt.ensure(KEY);
    expect(calls.filter((c) => c.includes("--detach"))).toHaveLength(1);
  });

  test("without delegated cgroups the gateway says so and sandboxes run without limits", async () => {
    const { cfg, rt, boxes } = controller();
    ownUid(cfg, KEY);
    const posture = await rt.posture();
    expect(posture.limits).toBe(false);
    expect(posture.warnings[0]).toContain("no per-person memory, CPU and process limits");
    await rt.ensure(KEY);
    expect(boxes.get(`tandem-${KEY}`)!.config.linux.cgroupsPath).toBeUndefined();
  });

  test("with delegated cgroups every sandbox gets its own limits; crun manages them", async () => {
    const { cfg, rt, boxes, calls } = controller({ RUNTIME_MEMORY_MB: "768", RUNTIME_CPUS: "0.5" }, true);
    ownUid(cfg, KEY);
    expect((await rt.posture()).limits).toBe(true);
    await rt.ensure(KEY);
    const linux = boxes.get(`tandem-${KEY}`)!.config.linux;
    expect(linux.cgroupsPath).toBe(`/sandboxes/tandem-${KEY}`);
    expect(linux.resources.memory.limit).toBe(768 * 1024 * 1024);
    expect(linux.resources.cpu.quota).toBe(50_000);
    expect(linux.seccomp.defaultAction).toBe("SCMP_ACT_ERRNO");
    expect(calls.filter((c) => c[0] !== "cgroups")).toEqual([]);
  });

  test("the temporary directory is fresh at every start and gone at every stop", async () => {
    const { cfg, rt, boxes } = controller();
    ownUid(cfg, KEY);
    const tmp = join(cfg.dataDir, "tmp", KEY);
    await rt.ensure(KEY);
    expect(boxes.get(`tandem-${KEY}`)!.config.mounts.find((m: any) => m.destination === RUNTIME_TMPDIR).source).toBe(tmp);
    writeFileSync(join(tmp, "claude"), "341 MiB");
    await rt.stop(KEY);
    expect(existsSync(tmp)).toBe(false);
    mkdirSync(tmp);
    writeFileSync(join(tmp, "left-over"), "x");
    await rt.ensure(KEY);
    expect(existsSync(join(tmp, "left-over"))).toBe(false);
  });

  test("one-shot commands run as the person with the egress relay, never with the MCP token", async () => {
    const { cfg, rt, oneShots } = controller();
    const uid = ownUid(cfg, KEY);
    await rt.exec(KEY, ["claude", "auth", "logout"]);
    const last = oneShots.at(-1)!;
    expect(last.args).toEqual([WITH_EGRESS, "claude", "auth", "logout"]);
    expect(last.uid).toBe(uid);
    expect(last.env.some((e) => e.startsWith(`${PROXY_TOKEN_ENV}=`))).toBe(
      false,
    );
    expect(last.mounts.some((m) => m.destination === SANDBOX_MCP_SOCKET)).toBe(
      false,
    );
  });

  test("private files go in through standard input, never in a command line", async () => {
    const { cfg, rt, oneShots } = controller();
    ownUid(cfg, KEY);
    await rt.writePrivateFile(
      KEY,
      "/home/agent/.agent-runtime",
      "anthropic-api-key",
      "sk-secret\n",
    );
    const write = oneShots.at(-1)!;
    expect(write.stdin).toBe("sk-secret\n");
    expect(JSON.stringify(write.args)).not.toContain("sk-secret");
    expect(rt.writePrivateFile(KEY, "/etc", "passwd", "x")).rejects.toThrow(
      "outside",
    );
    expect(
      rt.writePrivateFile(KEY, "/home/agent", "../x", "x"),
    ).rejects.toThrow("outside");
  });

  test("stop is graceful, then the sandbox is removed; listRunning follows", async () => {
    const { cfg, rt, calls } = controller();
    ownUid(cfg, KEY);
    await rt.ensure(KEY);
    expect(await rt.listRunning()).toEqual([KEY]);
    await rt.stop(KEY);
    expect(calls.some((c) => c[0] === "kill" && c.includes("TERM"))).toBe(true);
    expect(calls.at(-1)).toEqual(["delete", "-f", `tandem-${KEY}`]);
    expect(await rt.listRunning()).toEqual([]);
  });

  test("every person gets their own uid, kept across gateway restarts", async () => {
    expect(nextUid([])).toBe(FIRST_UID);
    expect(nextUid([FIRST_UID, FIRST_UID + 2])).toBe(FIRST_UID + 1);
    const { cfg, rt } = controller();
    const uidOf = (r: SandboxRuntime, k: string) =>
      (r as any).uidOf(k) as Promise<number>;
    const a = await uidOf(rt, "a".repeat(24));
    const b = await uidOf(rt, "b".repeat(24));
    expect(a).not.toBe(b);
    const again = new SandboxRuntime(
      cfg,
      () => {},
      async () => ({ code: 0, stdout: "", stderr: "" }),
    );
    expect(await uidOf(again, "b".repeat(24))).toBe(b);
    expect(
      JSON.parse(readFileSync(join(cfg.dataDir, "uids.json"), "utf8")),
    ).toEqual({
      ["a".repeat(24)]: a,
      ["b".repeat(24)]: b,
    });
  });

  test("anything but the person's socket at the daemon's path is refused", async () => {
    const { cfg, rt, run } = controller();
    ownUid(cfg, KEY);
    // A daemon that put a plain file (or a link to one) where its socket belongs.
    (rt as any).run = async (args: string[], opts: any) => {
      const r = await run(args, opts);
      if (args.includes("--detach")) {
        const sock = join(
          cfg.dataDir,
          "homes",
          KEY,
          ".happy/agent/server.sock",
        );
        rmSync(sock, { force: true });
        writeFileSync(sock, "not a socket");
      }
      return r;
    };
    expect(rt.ensure(KEY)).rejects.toThrow("not a socket");
    await Bun.sleep(50);
    expect(existsSync(join(cfg.dataDir, "homes", KEY))).toBe(true);
  });
});
