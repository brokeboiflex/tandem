// What keeps people apart, as pure functions (no tests need a kernel): every vendor process runs in
// a sandbox of its own, run by crun inside the one Tandem container (src/runtime.ts) and described
// by the OCI spec below, inside its person's cgroup with the limits below; its only way out is
// Stripe's Smokescreen, configured by the ACL below.
import { readFileSync } from "node:fs";
import { release } from "node:os";
import type { Config } from "./config";

/**
 * Temporary files: a per-person directory outside the home, shared by all of the person's
 * sandboxes and removed when the last one ends, so it takes disk only while the person has a
 * process. The mount point exists in the runtime image (Dockerfile).
 */
export const RUNTIME_TMPDIR = "/var/tmp/agent";
/** Where a sandbox finds the gateway's sockets (bind-mounted files). */
export const SANDBOX_EGRESS_SOCKET = "/run/tandem/egress.sock";
export const SANDBOX_MCP_SOCKET = "/run/tandem/mcp.sock";
/** Inside each sandbox: the egress proxy and the MCP proxy on loopback (runtime/agent-run). */
export const SANDBOX_EGRESS_PORT = 4750;
export const SANDBOX_MCP_PORT = 8790;

/** The vendor hosts the runtimes need (README, Security): one hostname or `*.domain` per line. */
export const ALLOWLIST_FILE = new URL(
  "../runtime/egress-allowlist.txt",
  import.meta.url,
);

export type Posture = {
  sandbox: "namespaces";
  egress: "allowlist" | "open";
  /** Per-person memory/CPU/process limits in their own cgroup (false: the host cannot delegate). */
  limits: boolean;
  warnings: string[];
};

const HOST_RE =
  /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

/** Hostnames from the allowlist file plus EGRESS_ALLOW_DOMAINS, validated, lowercased, sorted. */
export function allowedHosts(text: string, extra: string[]): string[] {
  const hosts = new Set<string>();
  for (const raw of [
    ...text.split("\n").map((l) => l.replace(/#.*/, "").trim()),
    ...extra,
  ]) {
    if (!raw) continue;
    const host = raw.toLowerCase();
    if (!HOST_RE.test(host))
      throw new Error(`egress allowlist: "${raw}" is not a hostname`);
    hosts.add(host);
  }
  return [...hosts].sort();
}

/**
 * Smokescreen's ACL: `allowlist` enforces the hostnames (`*.example.com` is every subdomain, not
 * example.com itself); `open` allows any public host. Smokescreen refuses private, loopback,
 * link-local and CGNAT addresses in both, except the EGRESS_ALLOW_RANGES passed on its command line.
 */
export function smokescreenAcl(
  cfg: Config,
  allowlist = readFileSync(ALLOWLIST_FILE, "utf8"),
) {
  const hosts = allowedHosts(allowlist, cfg.egressAllowDomains);
  return [
    "version: v1",
    "services: []",
    "default:",
    "  name: tandem-runtimes",
    "  project: tandem",
    `  action: ${cfg.egressMode === "open" ? "open" : "enforce"}`,
    "  allowed_domains:",
    ...hosts.map((h) => `    - "${h}"`),
    "",
  ].join("\n");
}

/** One sandbox of a person: who runs in it, what it sees, what it may do. */
export type SandboxInput = {
  uid: number;
  /** The read-only runtime filesystem (the runtime image, unpacked into the Tandem image). */
  rootfs: string;
  /** The person's home on the data volume, mounted read-write at /home/agent. */
  home: string;
  /** Their /etc/passwd and /etc/group (naming `agent` with their uid). */
  passwd: string;
  group: string;
  /** The person's temporary directory (host path), mounted at RUNTIME_TMPDIR. */
  tmp: string;
  /** The gateway's egress socket and the person's own MCP socket (both host paths). */
  egressSocket: string;
  mcpSocket?: string;
  args: string[];
  env: Record<string, string>;
  /** Working directory inside the sandbox; must exist (the home always does). */
  cwd: string;
  /** Processes of the person's uid (RLIMIT_NPROC); the person's cgroup holds the same limit. */
  pids: number;
  /** The seccomp filter (sandboxSeccomp()). */
  seccomp: object;
  /**
   * The sandbox's own cgroup, a child of its person's (personCgroupLimits); absent when the host
   * cannot delegate cgroups.
   */
  cgroup?: { path: string };
};

/**
 * Raised for every sandboxed process, so that when the whole container or host runs out of memory
 * the kernel ends a vendor process before the gateway. Raising needs no privilege; lowering it
 * again inside the sandbox would (CAP_SYS_RESOURCE).
 */
export const SANDBOX_OOM_SCORE_ADJ = 500;

const AGENT_PATH =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * The OCI runtime spec for crun: crun's own default (`crun spec`) with the person's uid, no
 * capabilities, no_new_privs, a read-only root, only their home and their temporary directory
 * writable, their own PID, network (loopback only), IPC, UTS, cgroup and mount namespaces and
 * Docker's seccomp filter for unprivileged containers. Its cgroup is a child of the person's, which
 * holds their limits; `memory.oom.group` makes the kernel end this sandbox's whole process tree,
 * and only it, when the person runs out of memory. The only connections out are the two
 * bind-mounted gateway sockets.
 */
export function sandboxSpec(s: SandboxInput) {
  const bind = (source: string, destination: string, ...options: string[]) => ({
    destination,
    type: "bind",
    source,
    options: ["bind", ...options],
  });
  return {
    ociVersion: "1.0.0",
    process: {
      terminal: false,
      user: { uid: s.uid, gid: s.uid, additionalGids: [] },
      args: s.args,
      env: Object.entries({ PATH: AGENT_PATH, ...s.env }).map(
        ([k, v]) => `${k}=${v}`,
      ),
      cwd: s.cwd,
      capabilities: {
        bounding: [],
        effective: [],
        permitted: [],
        inheritable: [],
        ambient: [],
      },
      rlimits: [
        { type: "RLIMIT_NOFILE", hard: 65536, soft: 65536 },
        // Per uid, and every person has their own: a fork bomb stays inside one sandbox.
        { type: "RLIMIT_NPROC", hard: s.pids, soft: s.pids },
        { type: "RLIMIT_CORE", hard: 0, soft: 0 },
      ],
      noNewPrivileges: true,
      oomScoreAdj: SANDBOX_OOM_SCORE_ADJ,
    },
    root: { path: s.rootfs, readonly: true },
    hostname: "tandem",
    mounts: [
      {
        destination: "/proc",
        type: "proc",
        source: "proc",
        options: ["nosuid", "noexec", "nodev"],
      },
      {
        destination: "/dev",
        type: "tmpfs",
        source: "tmpfs",
        options: ["nosuid", "strictatime", "mode=755", "size=65536k"],
      },
      {
        destination: "/dev/pts",
        type: "devpts",
        source: "devpts",
        options: [
          "nosuid",
          "noexec",
          "newinstance",
          "ptmxmode=0666",
          "mode=0620",
          "gid=5",
        ],
      },
      {
        destination: "/dev/shm",
        type: "tmpfs",
        source: "shm",
        options: ["nosuid", "noexec", "nodev", "mode=1777", "size=65536k"],
      },
      {
        destination: "/dev/mqueue",
        type: "mqueue",
        source: "mqueue",
        options: ["nosuid", "noexec", "nodev"],
      },
      {
        destination: "/sys",
        type: "sysfs",
        source: "sysfs",
        options: ["nosuid", "noexec", "nodev", "ro"],
      },
      {
        destination: "/tmp",
        type: "tmpfs",
        source: "tmpfs",
        options: ["nosuid", "nodev", "noexec", "mode=1777", "size=262144k"],
      },
      bind(s.home, "/home/agent", "rw", "nosuid", "nodev"),
      bind(s.tmp, RUNTIME_TMPDIR, "rw", "nosuid", "nodev"),
      bind(s.passwd, "/etc/passwd", "ro"),
      bind(s.group, "/etc/group", "ro"),
      bind(s.egressSocket, SANDBOX_EGRESS_SOCKET),
      ...(s.mcpSocket ? [bind(s.mcpSocket, SANDBOX_MCP_SOCKET)] : []),
    ],
    linux: {
      namespaces: ["pid", "network", "ipc", "uts", "cgroup", "mount"].map(
        (type) => ({ type }),
      ),
      maskedPaths: [
        "/proc/acpi",
        "/proc/asound",
        "/proc/kcore",
        "/proc/keys",
        "/proc/latency_stats",
        "/proc/timer_list",
        "/proc/timer_stats",
        "/proc/sched_debug",
        "/sys/firmware",
        "/proc/scsi",
      ],
      readonlyPaths: [
        "/proc/bus",
        "/proc/fs",
        "/proc/irq",
        "/proc/sys",
        "/proc/sysrq-trigger",
      ],
      seccomp: s.seccomp,
      ...(s.cgroup
        ? {
            cgroupsPath: s.cgroup.path,
            resources: { unified: { "memory.oom.group": "1" } },
          }
        : {}),
    },
  };
}

const MIB = 1024 * 1024;

/**
 * The person's cgroup (`/sandboxes/<prefix>-<key>`): every sandbox of theirs is a child, so these
 * limits hold for all of their processes together. At memory.max the kernel first reclaims the
 * person's caches, then ends the process tree using the most (memory.oom.group). No memory.high:
 * without swap, a runaway above it is throttled instead of ended, and the person's other processes
 * with it (measured: a 1.2 GiB allocation under a 1 GiB limit with memory.high at 80 % sat at
 * 933 MiB for minutes, never OOM-killed, and the person's new sandboxes stalled while starting).
 * Equal cpu.weight shares the CPUs fairly between people under contention without capping an idle
 * server (a cpu.max quota of N CPUs caps nothing on a host with N or fewer). memory.swap.max, where
 * the host has swap accounting, keeps the limit from spilling into swap.
 */
export function personCgroupLimits(memoryMb: number, pids: number) {
  return {
    "memory.max": String(memoryMb * MIB),
    "memory.swap.max": "0",
    "pids.max": String(pids),
    "cpu.weight": "100",
  };
}

/**
 * The gateway's own leaf (`/gateway`), a sibling of `/sandboxes`: under contention it gets four
 * times the CPU of all sandboxes together, and the memory it uses up to 128 MiB is protected from
 * reclaim when the container's own limit is reached.
 */
export const GATEWAY_CGROUP = {
  "cpu.weight": "400",
  "memory.min": String(128 * MIB),
};

/** The person's /etc/passwd and /etc/group inside their sandbox. */
export const passwdFile = (uid: number) =>
  `root:x:0:0:root:/root:/usr/sbin/nologin\nagent:x:${uid}:${uid}:Tandem:/home/agent:/bin/bash\n`;
export const groupFile = (uid: number) => `root:x:0:\nagent:x:${uid}:\n`;

/**
 * Docker's default seccomp profile (moby/profiles a0fa70805f742f7da15b367770d802ea2a86c68b,
 * runtime/seccomp-docker-default.json) as an OCI filter for a process without capabilities on this
 * architecture and kernel: what an ordinary unprivileged Docker container gets. The Tandem container
 * itself runs with SYS_ADMIN, under which Docker's filter also allows mount, unshare, setns and the
 * like; this filter takes them away again inside every sandbox.
 */
export const SECCOMP_FILE = new URL(
  "../runtime/seccomp-docker-default.json",
  import.meta.url,
);

type DockerRule = {
  names: string[];
  action: string;
  args?: unknown[] | null;
  errnoRet?: number;
  includes?: { caps?: string[]; arches?: string[]; minKernel?: string };
  excludes?: { caps?: string[]; arches?: string[] };
};

const ARCHES: Record<string, string[]> = {
  x64: ["amd64", "x86_64", "x32", "x86"],
  arm64: ["arm64", "aarch64", "arm"],
};
const SCMP_ARCH: Record<string, string> = { x64: "SCMP_ARCH_X86_64", arm64: "SCMP_ARCH_AARCH64" };

const kernelAtLeast = (have: string, want: string) => {
  const [a, b] = have.split(/[.-]/).map(Number);
  const [c, d] = want.split(".").map(Number);
  return a! > c! || (a === c && b! >= d!);
};

export function sandboxSeccomp(
  profile: any = JSON.parse(readFileSync(SECCOMP_FILE, "utf8")),
  arch: string = process.arch,
  kernel: string = release(),
) {
  const names = ARCHES[arch];
  const main = SCMP_ARCH[arch];
  if (!names || !main) throw new Error(`no seccomp profile for ${arch}`);
  const mine = (list?: string[]) => !!list?.some((a) => names.includes(a));
  const syscalls = (profile.syscalls as DockerRule[])
    .filter(
      (r) =>
        !r.includes?.caps?.length &&
        (!r.includes?.arches || mine(r.includes.arches)) &&
        (!r.includes?.minKernel || kernelAtLeast(kernel, r.includes.minKernel)) &&
        !mine(r.excludes?.arches),
    )
    .map((r) => ({
      names: r.names,
      action: r.action,
      ...(r.args?.length ? { args: r.args } : {}),
      ...(r.errnoRet !== undefined ? { errnoRet: r.errnoRet } : {}),
    }));
  const sub = profile.archMap.find((m: any) => m.architecture === main)?.subArchitectures ?? [];
  return {
    defaultAction: profile.defaultAction,
    defaultErrnoRet: profile.defaultErrnoRet,
    architectures: [main, ...sub],
    syscalls,
  };
}
