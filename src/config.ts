// Every setting the gateway reads. .env.example lists each one with its default.
const env = process.env;

const flag = (value: string | undefined, fallback: boolean) =>
  value === undefined || value === ""
    ? fallback
    : /^(1|true|yes)$/i.test(value);

/** An empty value means the default, never 0 (which would lift a limit). */
const num = (value: string | undefined, fallback: number) =>
  value === undefined || value.trim() === "" ? fallback : Number(value);

const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const oneOf = <T extends string>(
  name: string,
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T => {
  const v = (value || fallback) as T;
  if (!allowed.includes(v))
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  return v;
};

function overrides(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [subject, volume] = pair.split("=");
    if (!subject || !volume)
      throw new Error(
        'DEV_VOLUME_OVERRIDES must be "subject=volume[,subject=volume]"',
      );
    map.set(subject, volume);
  }
  return map;
}

/** "*" or a comma-separated list of http(s) origins. */
function origins(raw: string): string[] {
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const o of list) {
    if (o === "*") continue;
    let url: URL | null = null;
    try {
      url = new URL(o);
    } catch {}
    if (!url || !["http:", "https:"].includes(url.protocol) || url.origin !== o.replace(/\/$/, ""))
      throw new Error(
        `MCP_ALLOWED_ORIGINS: "${o}" is not an origin like https://app.example.com`,
      );
  }
  return list.map((o) => (o === "*" ? o : new URL(o).origin));
}

export function loadConfig() {
  const prefix = env.RUNTIME_PREFIX || "tandem";
  const cfg = {
    port: Number(env.PORT ?? 8787),
    host: env.BIND_HOST ?? "127.0.0.1",
    authMode: (env.AUTH_MODE ?? "oidc") as "oidc" | "dev",
    devSecret: env.DEV_AUTH_SECRET ?? "",
    devTokenRoute: flag(env.DEV_TOKEN_ROUTE, false),
    oidcIssuer: env.OIDC_ISSUER ?? "",
    oidcAudience: env.OIDC_AUDIENCE ?? "",
    oidcJwksUrl: env.OIDC_JWKS_URL ?? "",
    serviceSecret: env.SERVICE_SECRET ?? "",
    dockerHost: env.RUNTIME_DOCKER_HOST ?? "unix:///var/run/docker.sock",
    // Fully qualified, so a socket proxy can allowlist exactly this image.
    runtimeImage:
      env.RUNTIME_IMAGE || "docker.io/library/tandem-runtime:2026.11.6-preview.7",
    runtimeNetwork: env.RUNTIME_NETWORK || `${prefix}-runtimes`,
    runtimePrefix: prefix,
    runtimePlatform: env.RUNTIME_PLATFORM ?? "",
    runtimeMemoryMb: num(env.RUNTIME_MEMORY_MB, 2048),
    runtimeCpus: num(env.RUNTIME_CPUS, 2),
    runtimePids: num(env.RUNTIME_PIDS, 512),
    bridgeAllow: env.BRIDGE_ALLOW ?? "",
    idleMs: Number(env.IDLE_MINUTES ?? 5) * 60_000,
    permissionMode: env.PERMISSION_MODE || "auto",
    restartAfterSignIn: flag(env.RESTART_AFTER_SIGN_IN, true),
    devVolumeOverrides: overrides(env.DEV_VOLUME_OVERRIDES ?? ""),
    mcpProxyPort: Number(env.MCP_PROXY_PORT || 8790),
    mcpProxyUrl: (env.MCP_PROXY_URL ?? "").replace(/\/+$/, ""),
    mcpAllowedOrigins: origins(env.MCP_ALLOWED_ORIGINS ?? ""),
    // --- Hardening (README, Security). Each protection has a safe default and an explicit opt-out.
    runtimeOciRuntime: env.RUNTIME_OCI_RUNTIME || "auto",
    runtimeUser: env.RUNTIME_USER ?? "10001:10001",
    runtimeCapAdd: list(env.RUNTIME_CAP_ADD).map((c) => c.toUpperCase()),
    runtimeNoNewPrivileges: flag(env.RUNTIME_NO_NEW_PRIVILEGES, true),
    runtimeReadOnlyRootfs: flag(env.RUNTIME_READ_ONLY_ROOTFS, true),
    runtimeTmpfsMb: num(env.RUNTIME_TMPFS_MB, 256),
    runtimeDockerProxy: oneOf(
      "RUNTIME_DOCKER_PROXY",
      env.RUNTIME_DOCKER_PROXY,
      ["auto", "required", "none"],
      "auto",
    ),
    networkIsolation: oneOf(
      "RUNTIME_NETWORK_ISOLATION",
      env.RUNTIME_NETWORK_ISOLATION,
      ["auto", "per_runtime", "shared"],
      "auto",
    ),
    egressMode: oneOf(
      "EGRESS_MODE",
      env.EGRESS_MODE,
      ["auto", "allowlist", "open", "off"],
      "auto",
    ),
    egressProxy: env.EGRESS_PROXY || `${prefix}-egress:4750`,
  };
  if (cfg.serviceSecret.length < 32)
    throw new Error("SERVICE_SECRET must be at least 32 characters");
  if (!["oidc", "dev"].includes(cfg.authMode))
    throw new Error("AUTH_MODE must be oidc or dev");
  if (cfg.authMode === "dev" && cfg.devSecret.length < 32)
    throw new Error("DEV_AUTH_SECRET must be at least 32 characters");
  if (
    cfg.authMode === "oidc" &&
    !(cfg.oidcIssuer && cfg.oidcAudience && cfg.oidcJwksUrl)
  )
    throw new Error(
      "OIDC_ISSUER, OIDC_AUDIENCE and OIDC_JWKS_URL are required when AUTH_MODE=oidc",
    );
  if (
    cfg.authMode !== "dev" &&
    (cfg.devTokenRoute || cfg.devVolumeOverrides.size)
  )
    throw new Error(
      "DEV_TOKEN_ROUTE and DEV_VOLUME_OVERRIDES are only allowed with AUTH_MODE=dev",
    );
  if (
    !["read_only", "workspace_write", "auto", "full_access"].includes(
      cfg.permissionMode,
    )
  )
    throw new Error(
      "PERMISSION_MODE must be read_only, workspace_write, auto or full_access",
    );
  if (
    cfg.mcpProxyUrl &&
    !/^https?:\/\/[^/?#]+(\/[^?#]*)?$/.test(cfg.mcpProxyUrl)
  )
    throw new Error("MCP_PROXY_URL must be an http(s) URL without query or fragment");
  if (!Number.isInteger(cfg.mcpProxyPort) || cfg.mcpProxyPort < 1 || cfg.mcpProxyPort > 65535)
    throw new Error("MCP_PROXY_PORT must be a TCP port");
  if (!["", "linux/amd64", "linux/arm64"].includes(cfg.runtimePlatform))
    throw new Error("RUNTIME_PLATFORM must be empty (host platform), linux/amd64 or linux/arm64");
  // Also the compose project name, which allows no dots.
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(cfg.runtimePrefix))
    throw new Error("RUNTIME_PREFIX must be lowercase letters, digits, '_' or '-'");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(cfg.runtimeOciRuntime))
    throw new Error("RUNTIME_OCI_RUNTIME must be auto, default or a runtime name");
  for (const cap of cfg.runtimeCapAdd)
    if (!/^(CAP_)?[A-Z_]+$/.test(cap))
      throw new Error(`RUNTIME_CAP_ADD: "${cap}" is not a capability name`);
  for (const [name, value] of [
    ["RUNTIME_MEMORY_MB", cfg.runtimeMemoryMb],
    ["RUNTIME_CPUS", cfg.runtimeCpus],
    ["RUNTIME_PIDS", cfg.runtimePids],
    ["RUNTIME_TMPFS_MB", cfg.runtimeTmpfsMb],
  ] as const)
    if (!(value >= 0)) throw new Error(`${name} must be 0 (no limit) or more`);
  if (!/^[A-Za-z0-9.-]+:\d+$/.test(cfg.egressProxy))
    throw new Error("EGRESS_PROXY must be <container>:<port>");
  return cfg;
}

export type Config = ReturnType<typeof loadConfig>;
