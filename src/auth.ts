// Service JWT verification: local HS256 secret in dev, issuer/audience/JWKS (RS256/ES256) in production.
import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import type { Config } from "./config";

export const DEV_ISSUER = "tandem-dev";
export const DEV_AUDIENCE = "tandem";

export type Principal = { subject: string; expiresAt: number };

export function verifier(cfg: Config) {
  const jwks =
    cfg.authMode === "oidc"
      ? createRemoteJWKSet(new URL(cfg.oidcJwksUrl))
      : null;
  const secret = new TextEncoder().encode(cfg.devSecret);
  return async function verify(req: Request): Promise<Principal | null> {
    const token = req.headers
      .get("authorization")
      ?.match(/^Bearer ([A-Za-z0-9._~+/=-]+)$/)?.[1];
    if (!token) return null;
    try {
      const { payload } = jwks
        ? await jwtVerify(token, jwks, {
            issuer: cfg.oidcIssuer,
            audience: cfg.oidcAudience,
            algorithms: ["RS256", "ES256"],
          })
        : await jwtVerify(token, secret, {
            issuer: DEV_ISSUER,
            audience: DEV_AUDIENCE,
            algorithms: ["HS256"],
          });
      if (
        typeof payload.sub !== "string" ||
        !payload.sub ||
        payload.sub.length > 256 ||
        typeof payload.exp !== "number"
      )
        return null;
      return { subject: payload.sub, expiresAt: payload.exp * 1000 };
    } catch {
      return null;
    }
  };
}

/** Local development tokens only; production tokens come from the identity provider. */
export function devToken(secret: string, subject: string, ttl = "8h") {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(DEV_ISSUER)
    .setAudience(DEV_AUDIENCE)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(new TextEncoder().encode(secret));
}
