// Every setting the gateway reads. .env.example lists each one with its default.
const env = process.env;

const flag = (value: string | undefined, fallback: boolean) =>
  value === undefined || value === ""
    ? fallback
    : /^(1|true|yes)$/i.test(value);

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

export function loadConfig() {
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
    runtimeImage: env.RUNTIME_IMAGE ?? "tandem-runtime:2026.11.6-preview.7",
    runtimeNetwork: env.RUNTIME_NETWORK ?? "tandem-runtimes",
    runtimePrefix: env.RUNTIME_PREFIX ?? "tandem",
    runtimePlatform: env.RUNTIME_PLATFORM ?? "",
    runtimeMemoryMb: Number(env.RUNTIME_MEMORY_MB ?? 2048),
    runtimeCpus: Number(env.RUNTIME_CPUS ?? 2),
    runtimePids: Number(env.RUNTIME_PIDS ?? 512),
    bridgeAllow: env.BRIDGE_ALLOW ?? "",
    idleMs: Number(env.IDLE_MINUTES ?? 5) * 60_000,
    permissionMode: env.PERMISSION_MODE ?? "workspace_write",
    restartAfterSignIn: flag(env.RESTART_AFTER_SIGN_IN, true),
    devVolumeOverrides: overrides(env.DEV_VOLUME_OVERRIDES ?? ""),
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
  if (!["", "linux/amd64", "linux/arm64"].includes(cfg.runtimePlatform))
    throw new Error("RUNTIME_PLATFORM must be empty (host platform), linux/amd64 or linux/arm64");
  return cfg;
}

export type Config = ReturnType<typeof loadConfig>;
