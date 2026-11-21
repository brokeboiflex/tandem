// Application MCP servers: per-person registrations, the per-person credentials an application
// sends with each message, and the proxy that a person's agents reach those servers through.
//
// An agent never sees an application credential. Its MCP configuration names only the gateway
// proxy, which it authenticates to with a per-person token. The proxy forwards each request to the
// registered upstream URL with the person's latest credential, held in this process's memory only.
import { createHmac, timingSafeEqual } from "node:crypto";

export const MCP_NAME = "[a-z][a-z0-9_]{0,31}";
const NAME_RE = new RegExp(`^${MCP_NAME}$`);
const TOOL_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const KEY_RE = /^[0-9a-f]{24}$/;
export const MAX_SERVERS = 20;
export const MAX_CREDENTIAL = 8192;
/** How long the proxy holds a handshake that waits for the person's first credential. */
const STARTUP_TIMEOUT_SEC = 600;
const HOLD_MS = (STARTUP_TIMEOUT_SEC - 15) * 1000;
const MAX_BODY = 4 * 1024 * 1024;

export type McpServer = {
  name: string;
  url: string;
  enabledTools: string[] | null;
  description: string | null;
};

export const isServerName = (name: unknown): name is string =>
  typeof name === "string" && NAME_RE.test(name);

/** Validates a registration. Returns an error sentence instead of throwing. */
export function parseServer(
  name: string,
  body: any,
  allowedOrigins: string[],
): McpServer | string {
  if (!isServerName(name))
    return "name: a lowercase letter, then up to 31 lowercase letters, digits or _";
  const raw = body?.url;
  let url: URL;
  try {
    if (typeof raw !== "string" || raw.length > 2048) throw new Error();
    url = new URL(raw);
  } catch {
    return "url must be an http or https URL";
  }
  if (!["http:", "https:"].includes(url.protocol))
    return "url must be an http or https URL";
  if (url.username || url.password) return "url must not contain credentials";
  if (url.hash) return "url must not contain a fragment";
  if (!allowedOrigins.includes("*") && !allowedOrigins.includes(url.origin))
    return "This server's origin is not allowed (MCP_ALLOWED_ORIGINS).";
  const tools = body?.enabledTools;
  if (
    tools !== undefined &&
    tools !== null &&
    !(
      Array.isArray(tools) &&
      tools.length <= 200 &&
      tools.every((t) => typeof t === "string" && TOOL_RE.test(t))
    )
  )
    return "enabledTools must be a list of tool names (letters, digits, _ . -)";
  const description = body?.description;
  if (
    description !== undefined &&
    description !== null &&
    (typeof description !== "string" || description.length > 500)
  )
    return "description must be at most 500 characters";
  return {
    name,
    url: url.href,
    enabledTools: Array.isArray(tools) ? [...new Set<string>(tools)] : null,
    description: description || null,
  };
}

// ---------------------------------------------------------------------------------------------
// Persistence. Registrations live in the person's own home, which their agent can write to.
// They decide where that person's credentials are sent, so the gateway signs them: a file the
// agent edited is ignored.

/** The token a person's agents present to the proxy. Derived, so it survives gateway restarts. */
export function proxyToken(secret: string, key: string) {
  return createHmac("sha256", secret)
    .update(`mcp-proxy:${key}`)
    .digest("base64url");
}

// ---------------------------------------------------------------------------------------------
// The proxy.

type Rpc = { id?: unknown; method?: unknown; params?: any };

export const COPY = {
  expired: (name: string) =>
    `Sign-in for ${name} expired or is missing. Send a new message to continue.`,
  refused: (name: string) => `${name} refused this request (access denied).`,
  disabled: (name: string, tool: string) =>
    `The ${tool} tool of ${name} is not enabled.`,
  removed: (name: string) => `${name} is no longer connected.`,
};

/** JSON-RPC answers the proxy gives itself: tool calls fail as tool errors the agent can relay. */
function synthesize(body: Rpc | Rpc[], text: string): Response {
  const list = Array.isArray(body) ? body : [body];
  const answers = list
    .filter((m) => m && typeof m.method === "string" && m.id !== undefined)
    .map((m) =>
      m.method === "tools/call"
        ? {
            jsonrpc: "2.0",
            id: m.id,
            result: { content: [{ type: "text", text }], isError: true },
          }
        : { jsonrpc: "2.0", id: m.id, error: { code: -32001, message: text } },
    );
  if (!answers.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? answers : answers[0], {
    headers: { "cache-control": "no-store" },
  });
}

const REQUEST_HEADERS = [
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
];
const RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "mcp-session-id",
  "mcp-protocol-version",
  "allow",
];

const plain = (status: number, error: string) =>
  Response.json(
    { error },
    { status, headers: { "cache-control": "no-store" } },
  );

/**
 * GET (the optional server-to-client stream) and DELETE (ending a session) without a usable
 * credential: "no stream offered" and "ended", answers that never mark the server failed.
 */
const withoutCredential = (method: string) =>
  method === "GET"
    ? new Response(null, { status: 405, headers: { allow: "POST, DELETE" } })
    : new Response(null, { status: 204 });

export type ProxyDeps = {
  secret: string;
  /** The person's registrations (loaded from their home when needed). */
  servers: (key: string) => Promise<McpServer[]>;
  fetchImpl?: typeof fetch;
  log?: (...args: unknown[]) => void;
  holdMs?: number;
};

type ServerLike = {
  timeout(req: Request, seconds: number): void;
};

export class McpProxy {
  /** person key -> server name -> Authorization header value. Memory only. */
  #credentials = new Map<string, Map<string, string>>();
  #waiters = new Map<string, Set<() => void>>();
  /** person key -> server name -> when a connection began setting up and whether it listed tools. */
  #progress = new Map<string, Map<string, { listed: boolean; since: number }>>();

  constructor(private deps: ProxyDeps) {}

  /** Latest wins; `null` forgets one server's credential. */
  setCredentials(key: string, auth: Record<string, string | null>) {
    let map = this.#credentials.get(key);
    if (!map) this.#credentials.set(key, (map = new Map()));
    for (const [name, value] of Object.entries(auth))
      if (value === null) map.delete(name);
      else map.set(name, value);
    for (const wake of [...(this.#waiters.get(key) ?? [])]) wake();
  }

  hasCredential(key: string, name: string) {
    return !!this.#credentials.get(key)?.has(name);
  }

  /** Forgets everything held for a person: their runtime stopped. */
  clear(key: string) {
    this.#credentials.delete(key);
    this.#progress.delete(key);
    for (const wake of [...(this.#waiters.get(key) ?? [])]) wake();
  }

  /**
   * Waits (bounded) until servers that were connecting have listed their tools, so a message sent
   * right after a credential arrives finds the tools in the agent's catalog.
   */
  async settle(key: string, ms: number) {
    for (
      const until = Date.now() + ms;
      Date.now() < until;
      await Bun.sleep(100)
    ) {
      // Only recent set-ups count, so a server whose upstream is down never delays every message.
      const pending = [...(this.#progress.get(key)?.entries() ?? [])].filter(
        ([name, p]) =>
          !p.listed &&
          Date.now() - p.since < 30_000 &&
          this.hasCredential(key, name),
      );
      if (!pending.length) return;
    }
  }

  #phase(key: string, name: string, listed: boolean) {
    let map = this.#progress.get(key);
    if (!map) this.#progress.set(key, (map = new Map()));
    map.set(name, { listed, since: listed ? (map.get(name)?.since ?? 0) : Date.now() });
  }

  #wait(key: string, signal: AbortSignal, ms: number) {
    return new Promise<void>((resolve) => {
      let set = this.#waiters.get(key);
      if (!set) this.#waiters.set(key, (set = new Set()));
      const done = () => {
        clearTimeout(timer);
        set!.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      signal.addEventListener("abort", done);
      set.add(done);
    });
  }

  /**
   * Handles one request from a runtime: `/mcp/<runtime key>/<server name>`. `from` is the runtime
   * whose own socket (mounted into that runtime's sandbox only) the request arrived on.
   */
  async handle(req: Request, server: ServerLike, from: string): Promise<Response> {
    const m = new URL(req.url).pathname.match(/^\/mcp\/([^/]+)\/([^/]+)$/);
    if (!m || !KEY_RE.test(m[1]!) || !isServerName(m[2]))
      return plain(404, "not_found");
    const [, key, name] = m as unknown as [string, string, string];
    const given = Buffer.from(
      req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "",
    );
    const expected = Buffer.from(proxyToken(this.deps.secret, key));
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      return plain(401, "unauthorized");
    // The token alone is not enough: the request must come from that person's own runtime.
    if (from !== key) return plain(403, "forbidden");
    const registration = (await this.deps.servers(key)).find(
      (s) => s.name === name,
    );
    server.timeout(req, 0); // waiting for a credential, and SSE streams, outlast the idle timeout
    let text = "";
    let body: Rpc | Rpc[] | null = null;
    if (req.method === "POST") {
      text = await req.text();
      if (text.length > MAX_BODY) return plain(413, "too_large");
      try {
        body = JSON.parse(text);
      } catch {
        return plain(400, "invalid_json");
      }
    } else if (!["GET", "DELETE"].includes(req.method))
      return plain(405, "method_not_allowed");
    if (!registration)
      return body
        ? synthesize(body, COPY.removed(name))
        : plain(404, "not_found");
    const messages = body ? (Array.isArray(body) ? body : [body]) : [];
    const has = (method: string) => messages.some((x) => x?.method === method);
    if (registration.enabledTools)
      for (const x of messages)
        if (
          x?.method === "tools/call" &&
          !registration.enabledTools.includes(x.params?.name)
        )
          return synthesize(body!, COPY.disabled(name, String(x.params?.name)));
    // A connection being set up waits for the person's first credential; an agent would otherwise
    // mark the server failed and retry it only later, if at all.
    const handshake = has("initialize");
    const deadline = Date.now() + (this.deps.holdMs ?? HOLD_MS);
    for (;;) {
      const credential = this.#credentials.get(key)?.get(name);
      if (!credential) {
        if (!body) return withoutCredential(req.method);
        if (handshake && !req.signal.aborted && Date.now() < deadline) {
          await this.#wait(key, req.signal, deadline - Date.now());
          continue;
        }
        return synthesize(body, COPY.expired(name));
      }
      const headers = new Headers();
      for (const h of REQUEST_HEADERS) {
        const v = req.headers.get(h);
        if (v) headers.set(h, v);
      }
      headers.set("authorization", credential);
      if (handshake) this.#phase(key, name, false);
      let upstream: Response;
      try {
        upstream = await (this.deps.fetchImpl ?? fetch)(registration.url, {
          method: req.method,
          headers,
          body: req.method === "POST" ? text : undefined,
          redirect: "manual",
          signal: req.signal,
        });
      } catch (e) {
        this.deps.log?.(
          "mcp_upstream_unreachable",
          name,
          (e as Error)?.name ?? "Error",
        );
        return plain(502, "upstream_unreachable");
      }
      if (upstream.status === 401) {
        await upstream.body?.cancel().catch(() => {});
        // That credential is spent. Never answer 401 to an agent: it would stop using the server
        // until it restarts. Drop it, unless a newer one arrived meanwhile.
        const map = this.#credentials.get(key);
        if (map?.get(name) === credential) map.delete(name);
        if (!body) return withoutCredential(req.method);
        if (handshake && !req.signal.aborted && Date.now() < deadline) continue;
        return synthesize(body, COPY.expired(name));
      }
      if (
        upstream.status === 403 ||
        (upstream.status >= 300 && upstream.status < 400)
      ) {
        await upstream.body?.cancel().catch(() => {});
        if (upstream.status !== 403) return plain(502, "upstream_redirect");
        if (!body) return withoutCredential(req.method);
        return synthesize(body, COPY.refused(name));
      }
      if (has("tools/list") && upstream.ok) this.#phase(key, name, true);
      const out = new Headers();
      for (const h of RESPONSE_HEADERS) {
        const v = upstream.headers.get(h);
        if (v) out.set(h, v);
      }
      // Streamed through unchanged: JSON bodies and SSE streams alike.
      return new Response(upstream.body, {
        status: upstream.status,
        headers: out,
      });
    }
  }
}
