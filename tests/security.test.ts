// What keeps people apart: the configuration, the egress proxy's ACL, the sandbox spec and the
// cgroup limits. The sandbox controller itself: tests/runtime.test.ts.
import { describe, expect, test } from "bun:test";
import { loadConfig, type Config } from "../src/config";
import { smokescreenArgs } from "../src/egress";
import {
  allowedHosts,
  GATEWAY_CGROUP,
  personCgroupLimits,
  RUNTIME_TMPDIR,
  sandboxSeccomp,
  sandboxSpec,
  SANDBOX_EGRESS_SOCKET,
  SANDBOX_MCP_SOCKET,
  SANDBOX_OOM_SCORE_ADJ,
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
    if (/^(RUNTIME_|EGRESS_|DATA_DIR|MCP_|IDLE_)/.test(k)) delete process.env[k];
  Object.assign(process.env, BASE_ENV, vars);
  try {
    return loadConfig();
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

describe("configuration", () => {
  test("defaults: allowlist egress, 1 GiB and 512 processes per person, 2 idle minutes", () => {
    const cfg = configWith();
    expect(cfg).toMatchObject({
      egressMode: "allowlist",
      runtimeMemoryMb: 1024,
      runtimePids: 512,
      idleMs: 2 * 60_000,
      dataDir: "/var/lib/tandem",
      runtimeRootfs: "/opt/tandem/rootfs",
    });
    // No per-person CPU quota and no daemon restarts any more.
    expect(cfg).not.toHaveProperty("runtimeCpus");
    expect(cfg).not.toHaveProperty("restartAfterSignIn");
    // An empty value is the default, never 0.
    expect(configWith({ IDLE_MINUTES: "" }).idleMs).toBe(2 * 60_000);
  });

  test("invalid values stop the gateway with the variable's name", () => {
    for (const [vars, message] of [
      [{ EGRESS_MODE: "off" }, "EGRESS_MODE"],
      [{ EGRESS_ALLOW_RANGES: "10.0.0.0" }, "EGRESS_ALLOW_RANGES"],
      [{ RUNTIME_PIDS: "8" }, "RUNTIME_PIDS"],
      [{ RUNTIME_MEMORY_MB: "100" }, "RUNTIME_MEMORY_MB"],
      [{ IDLE_MINUTES: "soon" }, "IDLE_MINUTES"],
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
  test("a child of the person's cgroup, ended as a whole on out-of-memory; the seccomp filter", () => {
    expect((spec.linux as any).cgroupsPath).toBe("/sandboxes/tandem-abc/proc-1-1");
    // No limits of its own: the person's cgroup holds them for all of their sandboxes.
    expect((spec.linux as any).resources).toEqual({
      unified: { "memory.oom.group": "1" },
    });
    expect((spec.linux as any).seccomp).toEqual({ marker: "seccomp" });
    // Ended before the gateway when the whole container runs out of memory.
    expect(spec.process.oomScoreAdj).toBe(SANDBOX_OOM_SCORE_ADJ);
    expect(SANDBOX_OOM_SCORE_ADJ).toBeGreaterThan(0);
    // Without delegated cgroups: no cgroup and no resources at all.
    const flat = sandboxSpec({ ...input, cgroup: undefined }).linux;
    expect(flat).not.toHaveProperty("cgroupsPath");
    expect(flat).not.toHaveProperty("resources");
  });

  test("its environment is PATH and what it is given, nothing else", () => {
    expect(spec.process.env).toEqual([
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "HOME=/home/agent",
    ]);
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

  const input = {
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
    cwd: "/home/agent",
    pids: 512,
    seccomp: { marker: "seccomp" },
    cgroup: { path: "/sandboxes/tandem-abc/proc-1-1" },
  };
  const spec = sandboxSpec(input);

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

describe("cgroup limits", () => {
  test("the person's cgroup: their memory (80 % soft), processes and an equal CPU weight", () => {
    expect(personCgroupLimits(1024, 512)).toEqual({
      "memory.max": String(1024 * 2 ** 20),
      "memory.high": String(819 * 2 ** 20),
      "memory.swap.max": "0",
      "pids.max": "512",
      "cpu.weight": "100",
    });
    // No CPU quota: it would only leave CPUs idle.
    expect(personCgroupLimits(1024, 512)).not.toHaveProperty("cpu.max");
  });

  test("the gateway's leaf weighs more than all sandboxes together and keeps a memory reserve", () => {
    expect(Number(GATEWAY_CGROUP["cpu.weight"])).toBeGreaterThan(100);
    expect(Number(GATEWAY_CGROUP["memory.min"])).toBe(128 * 2 ** 20);
  });
});
