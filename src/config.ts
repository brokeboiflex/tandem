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
    // The gateway's data volume: microsandbox's state, every person's home, the MCP sockets.
    dataDir: (env.DATA_DIR || "/var/lib/tandem").replace(/\/+$/, ""),
    // The runtime image archive built into the gateway image (Dockerfile), loaded into microsandbox
    // on first start. RUNTIME_IMAGE names an image already in microsandbox's store instead.
    runtimeImageArchive: env.RUNTIME_IMAGE_ARCHIVE || "/opt/tandem/runtime.tar",
    runtimeImage: env.RUNTIME_IMAGE ?? "",
    runtimePrefix: prefix,
    runtimeMemoryMb: num(env.RUNTIME_MEMORY_MB, 2048),
    runtimeCpus: num(env.RUNTIME_CPUS, 2),
    idleMs: Number(env.IDLE_MINUTES ?? 5) * 60_000,
    permissionMode: env.PERMISSION_MODE || "auto",
    restartAfterSignIn: flag(env.RESTART_AFTER_SIGN_IN, true),
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
  // Sandbox names and labels: <prefix>-<key>.
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(cfg.runtimePrefix))
    throw new Error("RUNTIME_PREFIX must be lowercase letters, digits, '_' or '-'");
  // A microVM always has a fixed size: no "0 = no limit" here.
  if (!(Number.isInteger(cfg.runtimeMemoryMb) && cfg.runtimeMemoryMb >= 512))
    throw new Error("RUNTIME_MEMORY_MB must be a whole number of MiB, at least 512");
  if (!(Number.isInteger(cfg.runtimeCpus) && cfg.runtimeCpus >= 1 && cfg.runtimeCpus <= 32))
    throw new Error("RUNTIME_CPUS must be a whole number from 1 to 32");
  if (!cfg.dataDir.startsWith("/") || cfg.dataDir.length > 60)
    // Unix socket paths (DATA_DIR/run/<key>.sock) are limited to 107 bytes.
    throw new Error("DATA_DIR must be an absolute path of at most 60 characters");
  for (const r of cfg.egressAllowRanges)
    if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(r))
      throw new Error(`EGRESS_ALLOW_RANGES: "${r}" is not an IPv4 CIDR range`);
  return cfg;
}

export type Config = ReturnType<typeof loadConfig>;
