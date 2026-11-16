// Runtime hardening: what the Docker Engine in front of us supports, and the exact container and
// network specs the Docker runtime controller sends. Pure functions only, so every decision is
// unit-tested without Docker (tests/security.test.ts).
import { createHash } from "node:crypto";
import type { Config } from "./config";
import { PROXY_TOKEN_ENV, proxyToken } from "./mcp";

/** Where the person's temporary files go: on their volume, because the root filesystem is read-only. */
export const RUNTIME_TMPDIR = "/home/agent/.cache/tmp";

export type DockerApiAccess = "restricted" | "unrestricted";

/** What the gateway found at startup. Logged once; /healthz reports the egress mode. */
export type Posture = {
  /** OCI runtime sent to Docker; null means the Engine's default. */
  ociRuntime: string | null;
  sandbox: string;
  dockerApi: DockerApiAccess;
  egress: "allowlist" | "open" | "off";
  network: "per_runtime" | "shared";
  warnings: string[];
};

/**
 * RUNTIME_OCI_RUNTIME: `auto` prefers gVisor (runsc) when the Engine offers it and otherwise keeps the
 * Engine's default with a warning; `default` keeps the default silently; any other value is required.
 */
export function chooseOciRuntime(
  setting: string,
  available: string[],
  engineDefault = "runc",
): { runtime: string | null; sandbox: string; warning?: string } {
  if (setting === "default") return { runtime: null, sandbox: engineDefault };
  if (setting === "auto") {
    if (available.includes("runsc"))
      return { runtime: "runsc", sandbox: "gvisor (runsc)" };
    return {
      runtime: null,
      sandbox: engineDefault,
      warning:
        `gVisor (runsc) is not installed in this Docker Engine, so runtimes use its default runtime ` +
        `(${engineDefault}) and share the host kernel. Install gVisor (README, Security) or set ` +
        `RUNTIME_OCI_RUNTIME=default to accept this.`,
    };
  }
  if (!available.includes(setting))
    throw new Error(
      `RUNTIME_OCI_RUNTIME=${setting}, but this Docker Engine offers only: ${available.join(", ") || "none"}`,
    );
  return {
    runtime: setting,
    sandbox: setting.startsWith("runsc") ? `gvisor (${setting})` : setting,
  };
}

/**
 * A plain Engine socket answers every API section. A socket proxy refuses the plugin list, which
 * the gateway never needs, so one harmless read tells the two apart.
 */
export function dockerApiAccess(pluginListStatus: number): DockerApiAccess {
  return pluginListStatus >= 200 && pluginListStatus < 300
    ? "unrestricted"
    : "restricted";
}

/** Docker's error when its address pools are used up (no network can be created). */
export const isAddressPoolExhausted = (message: string) =>
  /available, non-overlapping|address pool|no available network/i.test(message);

/** Proxy variables for runtimes; both spellings, because tools disagree on which one they read. */
export function egressEnv(
  egress: Posture["egress"],
  proxy: string,
  directHosts: string[],
): string[] {
  if (egress === "off") return [];
  const url = `http://${proxy}`;
  const noProxy = ["localhost", "127.0.0.1", "::1", ...directHosts]
    .filter((h, i, all) => h && all.indexOf(h) === i)
    .join(",");
  return [
    `HTTPS_PROXY=${url}`,
    `https_proxy=${url}`,
    `HTTP_PROXY=${url}`,
    `http_proxy=${url}`,
    `NO_PROXY=${noProxy}`,
    `no_proxy=${noProxy}`,
  ];
}

export type RuntimeSpecInput = {
  key: string;
  volume: string;
  network: string;
  /** CIDR allowed to open the runtime's bridge port: the gateway's address on `network`. */
  allow: string;
  ociRuntime: string | null;
  egress: Posture["egress"];
  /** The egress proxy as address:port on this runtime's network. */
  egressProxy: string;
  /** Names and addresses runtimes reach without the egress proxy: the gateway itself. */
  directHosts: string[];
  imageId: string;
  devVolumeOverride: boolean;
  /** The gateway's MCP proxy for this runtime (`…/mcp/<key>`); empty when it has none. */
  mcpProxyUrl: string;
};

/** Body of POST /containers/create for one person's runtime. */
export function runtimeContainerSpec(cfg: Config, s: RuntimeSpecInput) {
  const label = (name: string) => `${cfg.runtimePrefix}.${name}`;
  const tmpfs =
    cfg.runtimeReadOnlyRootfs && cfg.runtimeTmpfsMb > 0
      ? {
          // Small scratch space for tools that write to /tmp by name; big files go to TMPDIR.
          Tmpfs: {
            "/tmp": `rw,noexec,nosuid,nodev,size=${cfg.runtimeTmpfsMb}m,mode=1777`,
          },
        }
      : {};
  const spec = {
    Image: cfg.runtimeImage,
    Hostname: "runtime",
    ...(cfg.runtimeUser ? { User: cfg.runtimeUser } : {}),
    Env: [
      `HAPPY_BRIDGE_ALLOW=${s.allow}`,
      `TMPDIR=${RUNTIME_TMPDIR}`,
      // The MCP proxy token only reaches the gateway's proxy, and only from this container's
      // address. Application credentials never enter the runtime.
      `MCP_PROXY_URL=${s.mcpProxyUrl}`,
      `${PROXY_TOKEN_ENV}=${proxyToken(cfg.serviceSecret, s.key)}`,
      ...egressEnv(s.egress, s.egressProxy, s.directHosts),
    ],
    Labels: {
      [label("runtime")]: "1",
      [label("key")]: s.key,
      [label("bridge-allow")]: s.allow,
      [label("volume")]: s.volume,
      [label("network")]: s.network,
      [label("platform")]: cfg.runtimePlatform,
      ...(s.devVolumeOverride ? { [label("dev-volume-override")]: "1" } : {}),
    } as Record<string, string>,
    StopTimeout: 30,
    HostConfig: {
      Init: true,
      ...(s.ociRuntime ? { Runtime: s.ociRuntime } : {}),
      CapDrop: ["ALL"],
      ...(cfg.runtimeCapAdd.length ? { CapAdd: cfg.runtimeCapAdd } : {}),
      SecurityOpt: cfg.runtimeNoNewPrivileges ? ["no-new-privileges:true"] : [],
      ReadonlyRootfs: cfg.runtimeReadOnlyRootfs,
      ...tmpfs,
      Mounts: [{ Type: "volume", Source: s.volume, Target: "/home/agent" }],
      NetworkMode: s.network,
      Memory: cfg.runtimeMemoryMb * 1024 * 1024,
      NanoCpus: Math.round(cfg.runtimeCpus * 1e9),
      PidsLimit: cfg.runtimePids,
      RestartPolicy: { Name: "no" },
      // No PortBindings: runtimes are reachable only on their private network.
    },
  };
  // Any change to the spec (the MCP proxy address included), the image or the platform makes a
  // stopped runtime be recreated.
  spec.Labels[label("spec")] = createHash("sha256")
    .update(JSON.stringify([spec, s.imageId, cfg.runtimePlatform]))
    .digest("hex")
    .slice(0, 16);
  return spec;
}

/**
 * An internal bridge still gives the host an address on it, so host services listening on all
 * interfaces would be reachable from runtimes. Isolated gateway mode (Docker Engine 28+) leaves the
 * bridge without one.
 */
export const ISOLATED_GATEWAY = "com.docker.network.bridge.gateway_mode_ipv4";

/**
 * Body of POST /networks/create. Runtime networks are internal (no route out, no host address)
 * unless egress is off; `key` marks a per-runtime network, none the shared fallback network.
 */
export function runtimeNetworkSpec(
  cfg: Config,
  name: string,
  egress: Posture["egress"],
  key?: string,
  isolatedGateway = true,
) {
  const label = (n: string) => `${cfg.runtimePrefix}.${n}`;
  const internal = egress !== "off";
  return {
    Name: name,
    Driver: "bridge",
    Internal: internal,
    ...(internal && isolatedGateway
      ? { Options: { [ISOLATED_GATEWAY]: "isolated" } }
      : {}),
    Labels: {
      [label("runtime-network")]: "1",
      ...(key ? { [label("key")]: key } : { [label("shared")]: "1" }),
    },
  };
}

/** IPv4 only: Tandem's runtime networks are IPv4 bridges. */
export function inCidr(ip: string, cidr: string): boolean {
  const toInt = (a: string) =>
    a.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
  const [base, bits] = cidr.split("/");
  const v4 = ip.replace(/^::ffff:/i, "");
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(v4) || !base) return false;
  const n = Number(bits ?? 32);
  const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
  return (toInt(v4) & mask) === (toInt(base) & mask);
}
