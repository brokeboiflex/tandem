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
    // The data volume: every person's home, their uids, the gateway's sockets.
    dataDir: (env.DATA_DIR || "/var/lib/tandem").replace(/\/+$/, ""),
    // The runtime filesystem every sandbox runs on, read-only (built into the image, Dockerfile).
    runtimeRootfs: env.RUNTIME_ROOTFS || "/opt/tandem/rootfs",
    runtimePrefix: prefix,
    // Per person, for all of their processes together, in their own cgroup: memory (MiB) and
    // processes. CPU is shared fairly between people (src/security.ts, personCgroupLimits).
    runtimeMemoryMb: num(env.RUNTIME_MEMORY_MB, 1024),
    runtimePids: num(env.RUNTIME_PIDS, 512),
    // A vendor process starts again in 0.05-0.45 s, so it is not kept long after the last turn.
    idleMs: num(env.IDLE_MINUTES, 2) * 60_000,
    permissionMode: env.PERMISSION_MODE || "auto",
    mcpAllowedOrigins: origins(env.MCP_ALLOWED_ORIGINS ?? ""),
    egressMode: oneOf(
      "EGRESS_MODE",
      env.EGRESS_MODE,
      ["allowlist", "open"],
      "allowlist",
    ),
    egressAllowDomains: list(env.EGRESS_ALLOW_DOMAINS),
    egressAllowRanges: list(env.EGRESS_ALLOW_RANGES),
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
  if (cfg.authMode !== "dev" && cfg.devTokenRoute)
    throw new Error("DEV_TOKEN_ROUTE is only allowed with AUTH_MODE=dev");
  if (
    !["read_only", "workspace_write", "auto", "full_access"].includes(
      cfg.permissionMode,
    )
  )
    throw new Error(
      "PERMISSION_MODE must be read_only, workspace_write, auto or full_access",
    );
  // Sandbox names: <prefix>-<key>.
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(cfg.runtimePrefix))
    throw new Error("RUNTIME_PREFIX must be lowercase letters, digits, '_' or '-'");
  if (!(Number.isInteger(cfg.runtimePids) && cfg.runtimePids >= 64))
    throw new Error("RUNTIME_PIDS must be a whole number, at least 64");
  if (!(Number.isInteger(cfg.runtimeMemoryMb) && cfg.runtimeMemoryMb >= 256))
    throw new Error("RUNTIME_MEMORY_MB must be a whole number of MiB, at least 256");
  if (!(cfg.idleMs >= 0))
    throw new Error("IDLE_MINUTES must be a number of minutes, 0 or more");
  if (!cfg.runtimeRootfs.startsWith("/"))
    throw new Error("RUNTIME_ROOTFS must be an absolute path");
  if (!cfg.dataDir.startsWith("/") || cfg.dataDir.length > 40)
    // Unix socket paths (DATA_DIR/run/<key>/mcp.sock) are limited to 107 bytes.
    throw new Error("DATA_DIR must be an absolute path of at most 40 characters");
  for (const r of cfg.egressAllowRanges)
    if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(r))
      throw new Error(`EGRESS_ALLOW_RANGES: "${r}" is not an IPv4 CIDR range`);
  return cfg;
}

export type Config = ReturnType<typeof loadConfig>;
