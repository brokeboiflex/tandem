// Application MCP servers through the gateway's real HTTP handler and its real per-person proxy
// sockets, with fake agents and sign-ins (./fakes.ts), a store on a temp dir and a real Streamable
// HTTP MCP server upstream (scripts/stub-mcp.ts).
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { devToken } from "../src/auth";
import type { Config } from "../src/config";
import { createGateway } from "../src/gateway";
import * as M from "../src/mcp";
import {
  CONTEXT_CLOSE,
  CONTEXT_OPEN,
  MAX_CONTEXT,
  withContext,
} from "../src/providers";
import { runtimeKey } from "../src/runtime";
import { sseFrames } from "../src/sse";
import { Store } from "../src/store";
import { WORKSPACE } from "../src/agents/types";
import { STUB_CUSTOMER, startStubMcp } from "../scripts/stub-mcp";
import { FakeAgent, FakeSignIn, execs, fakeRuntime, written } from "./fakes";

setDefaultTimeout(30_000);
const stub = startStubMcp();
const dir = mkdtempSync("/tmp/tandem-mcp-"); // short: Unix socket paths are limited
const cfg = {
  port: 0,
  host: "127.0.0.1",
  authMode: "dev",
  devSecret: "test-dev-secret-at-least-32-characters!!",
  devTokenRoute: false,
  oidcIssuer: "",
  oidcAudience: "",
  oidcJwksUrl: "",
  serviceSecret: "test-service-secret-at-least-32-characters",
  dataDir: dir,
  runtimeRootfs: "/nonexistent",
  runtimePrefix: "test",
  runtimeMemoryMb: 1024,
  runtimePids: 512,
  idleMs: 60_000,
  permissionMode: "auto",
  egressMode: "allowlist",
  egressAllowDomains: [],
  egressAllowRanges: [],
  mcpAllowedOrigins: [new URL(stub.url).origin],
} as unknown as Config;

const runtime = fakeRuntime(dir);
const claude = new FakeAgent(["claude"]);
/** The agent of a second gateway process on the same store (the restart test). */
const restarted = new FakeAgent(["claude"]);
const claudeSignIn = new FakeSignIn("claude", "paste_code");
const dbPath = join(dir, "tandem.db");
const store = new Store(dbPath);
const logs: string[] = [];
const log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
const gateway = createGateway(cfg, {
  runtime,
  agents: [claude],
  signIns: [claudeSignIn],
  store,
  log,
});
const server = Bun.serve({ port: 0, fetch: gateway.fetch, idleTimeout: 60 });
const base = `http://127.0.0.1:${server.port}`;
afterAll(async () => {
  await gateway.shutdown();
  server.stop(true);
  stub.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  claude.script = new FakeAgent([]).script;
});

const key = (subject: string) => runtimeKey(cfg.serviceSecret, subject);
type Handler = (req: Request) => Response | Promise<Response>;
/** Every /v1 response body, to check that nothing secret or hidden is ever returned. */
const responses: string[] = [];
async function call(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  handler: Handler = fetch,
) {
  const res = await handler(
    new Request(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  const text = await res.text();
  responses.push(text);
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** A request as the person's agent sends it to the proxy, through the person's MCP socket. */
function rpc(
  subject: string,
  name: string,
  body: unknown,
  opts: {
    token?: string | null;
    method?: string;
    session?: string;
    /** The socket it arrives on; the person's own by default. */
    socket?: string;
  } = {},
) {
  const k = key(subject);
  const token =
    opts.token === undefined ? M.proxyToken(cfg.serviceSecret, k) : opts.token;
  const method = opts.method ?? "POST";
  return fetch(`http://runtime/mcp/${k}/${name}`, {
    unix: opts.socket ?? runtime.mcpSocket(k),
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(opts.session ? { "mcp-session-id": opts.session } : {}),
    },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  },
};
const toolsList = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
const lookup = (id = "42") => ({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "lookup_customer", arguments: { id } },
});
const since = (mark: number) => stub.requests.slice(mark);

async function until(pred: () => boolean, ms = 5000) {
  for (const end = Date.now() + ms; !pred(); await Bun.sleep(20))
    if (Date.now() > end) throw new Error("timed out");
}

type Who = { token: string; conversation: string };
async function connectedPerson(subject: string): Promise<Who> {
  const token = await devToken(cfg.devSecret, subject);
  await call(token, "POST", "/v1/providers/claude/connect", {});
  const code = await call(token, "POST", "/v1/providers/claude/connect/code", {
    code: "good-code",
  });
  expect(code.body.connection.status).toBe("connected");
  const created = await call(token, "POST", "/v1/conversations", {
    provider: "claude",
    model: "claude-code/default",
    title: `${subject} chat`,
  });
  expect(created.status).toBe(201);
  return { token, conversation: created.body.conversation.id as string };
}

const send = (
  who: Who,
  extra: Record<string, unknown> = {},
  handler?: Handler,
) =>
  call(
    who.token,
    "POST",
    `/v1/conversations/${who.conversation}/messages`,
    { text: "Look up customer 42", ...extra },
    handler,
  );

/** Waits until the conversation's turns have ended. */
async function settled(who: Who, conversation = who.conversation) {
  for (let i = 0; i < 400; i++) {
    const r = await call(
      who.token,
      "GET",
      `/v1/conversations/${conversation}/messages`,
    );
    if (
      r.body.conversation.status === "idle" &&
      r.body.runs.every((x: any) => x.status !== "running")
    )
      return r.body;
    await Bun.sleep(20);
  }
  throw new Error("turn did not settle");
}

/** One message and its whole turn. The gateway listens on the person's MCP socket from then on. */
async function turn(who: Who, extra: Record<string, unknown> = {}) {
  const sent = await send(who, extra);
  expect(sent.status).toBe(202);
  await settled(who);
}

/** Opens the person's event stream and collects its events. */
async function listen(who: Who) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/v1/events`, {
    headers: { authorization: `Bearer ${who.token}` },
    signal: ctrl.signal,
  });
  const events: { event: string; data: any }[] = [];
  void (async () => {
    try {
      for await (const f of sseFrames(res.body!))
        events.push({ event: f.event, data: JSON.parse(f.data) });
    } catch {}
  })();
  return {
    events,
    until: (pred: (e: { event: string; data: any }) => boolean) =>
      until(() => events.some(pred)),
    close: () => ctrl.abort(),
  };
}

const alice = await connectedPerson("alice");
const bob = await connectedPerson("bob");

describe("registering MCP servers", () => {
  test("PUT registers, GET lists, invalid input is refused with a readable message", async () => {
    const put = await call(alice.token, "PUT", "/v1/mcp-servers/stub", {
      url: stub.url,
      description: "Test app",
    });
    expect(put.status).toBe(201);
    expect(put.body.server).toEqual({
      name: "stub",
      url: stub.url,
      enabledTools: null,
      description: "Test app",
      hasCredential: false,
    });
    expect(
      (
        await call(alice.token, "PUT", "/v1/mcp-servers/stub", {
          url: stub.url,
          description: "Test app",
        })
      ).status,
    ).toBe(200);
    expect(
      (await call(alice.token, "GET", "/v1/mcp-servers")).body.servers.map(
        (s: any) => s.name,
      ),
    ).toEqual(["stub"]);
    for (const [name, body, status] of [
      ["bad", { url: "ftp://example.com/mcp" }, 400],
      ["bad", { url: "not a url" }, 400],
      ["bad", { url: `http://user:pw@${new URL(stub.url).host}/mcp` }, 400],
      ["bad", { url: "https://elsewhere.example.com/mcp" }, 400], // origin not allowed
      ["bad", { url: stub.url, enabledTools: "lookup_customer" }, 400],
      ["bad", { url: stub.url, enabledTools: ["bad name!"] }, 400],
      ["Bad", { url: stub.url }, 404], // the name pattern is part of the route
      ["bad-name", { url: stub.url }, 404],
    ] as const) {
      const r = await call(alice.token, "PUT", `/v1/mcp-servers/${name}`, body);
      expect(`${name} ${JSON.stringify(body)} ${r.status}`).toBe(
        `${name} ${JSON.stringify(body)} ${status}`,
      );
      if (status === 400) expect(r.body.message.length).toBeGreaterThan(10);
    }
    expect(
      (await call(alice.token, "DELETE", "/v1/mcp-servers/nothing")).status,
    ).toBe(404);
  });

  test("past the limit, too_many_servers names the limit", async () => {
    const token = await devToken(cfg.devSecret, "max");
    for (let i = 0; i < M.MAX_SERVERS; i++)
      expect(
        (await call(token, "PUT", `/v1/mcp-servers/s${i}`, { url: stub.url }))
          .status,
      ).toBe(201);
    expect(
      await call(token, "PUT", "/v1/mcp-servers/onemore", { url: stub.url }),
    ).toEqual({
      status: 409,
      body: {
        error: "too_many_servers",
        message: `At most ${M.MAX_SERVERS} MCP servers can be registered.`,
        params: { maxServers: M.MAX_SERVERS },
      },
    });
    // Replacing a registered one is no new server.
    expect(
      (await call(token, "PUT", "/v1/mcp-servers/s0", { url: stub.url }))
        .status,
    ).toBe(200);
  });

  test("registrations live in the gateway's store, not the person's home, and survive a restart", async () => {
    // Nothing written into the person's home names the upstream.
    expect(JSON.stringify(written)).not.toContain(stub.url);
    // A second gateway process on the same store, listening on MCP sockets of its own: the first
    // keeps serving the proxy for the tests below.
    const sockets = mkdtempSync("/tmp/tmcp-");
    const socketOf = (k: string) => join(sockets, `${k}.sock`);
    const again = createGateway(cfg, {
      runtime: { ...runtime, mcpSocket: socketOf },
      agents: [restarted],
      signIns: [claudeSignIn],
      store,
      log,
    });
    try {
      expect(
        (
          await call(
            alice.token,
            "GET",
            "/v1/mcp-servers",
            undefined,
            again.fetch,
          )
        ).body.servers,
      ).toEqual([
        {
          name: "stub",
          url: stub.url,
          enabledTools: null,
          description: "Test app",
          hasCredential: false,
        },
      ]);
      // Its proxy forwards to the stored registration.
      const mark = stub.requests.length;
      expect(
        (
          await send(
            alice,
            { mcpAuth: { stub: "Bearer valid-alice-restart" } },
            again.fetch,
          )
        ).status,
      ).toBe(202);
      await until(() => restarted.inputs.length > 0);
      const init = await rpc("alice", "stub", initialize, {
        socket: socketOf(key("alice")),
      });
      expect(init.status).toBe(200);
      expect((await init.json()).result.serverInfo.name).toBe("stub-mcp");
      expect(since(mark).map((r) => r.authorization)).toEqual([
        "Bearer valid-alice-restart",
      ]);
      // A credential belongs to one gateway process's memory, never to the store they share.
      expect(
        (
          await call(
            alice.token,
            "GET",
            "/v1/mcp-servers",
            undefined,
            again.fetch,
          )
        ).body.servers[0].hasCredential,
      ).toBe(true);
      expect(
        (await call(alice.token, "GET", "/v1/mcp-servers")).body.servers[0]
          .hasCredential,
      ).toBe(false);
    } finally {
      await again.shutdown();
      rmSync(sockets, { recursive: true, force: true });
    }
  });
});

describe("the proxy refuses anyone but the person's own runtime", () => {
  test("absent or wrong runtime token, another person's token, another person's socket", async () => {
    // The agents reach the proxy during their turns: each person's socket exists from the first.
    await turn(alice);
    await turn(bob);
    const mark = stub.requests.length;
    expect((await rpc("alice", "stub", lookup(), { token: null })).status).toBe(
      401,
    );
    expect(
      (await rpc("alice", "stub", lookup(), { token: "x".repeat(43) })).status,
    ).toBe(401);
    expect(
      (
        await rpc("alice", "stub", lookup(), {
          token: M.proxyToken(cfg.serviceSecret, key("bob")),
        })
      ).status,
    ).toBe(401);
    // Alice's token leaked to Bob's runtime: it arrives on Bob's socket.
    expect(
      (
        await rpc("alice", "stub", lookup(), {
          socket: runtime.mcpSocket(key("bob")),
        })
      ).status,
    ).toBe(403);
    const res = await fetch("http://runtime/mcp/zz/stub", {
      unix: runtime.mcpSocket(key("alice")),
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(404);
    expect(stub.requests.length).toBe(mark); // nothing reached the upstream
  });
});

describe("credentials: per message, per person, memory only", () => {
  let session = "";

  test("a waiting connection gets the first credential, and that message's turn waits for its tools", async () => {
    // An agent's MCP connection set up before any credential: the proxy holds the handshake.
    const mark = stub.requests.length;
    const held = rpc("alice", "stub", initialize);
    await Bun.sleep(200);
    expect(stub.requests.length).toBe(mark);
    const starts: number[] = [];
    claude.script = async () => {
      starts.push(performance.now());
      return { status: "completed" };
    };
    const t0 = performance.now();
    const sending = send(alice, { mcpAuth: { stub: "Bearer valid-alice-1" } });
    const init = await held;
    expect(init.status).toBe(200);
    session = init.headers.get("mcp-session-id")!;
    expect(session).toMatch(/^[0-9a-f-]{36}$/);
    expect((await init.json()).result.serverInfo.name).toBe("stub-mcp");
    expect((await sending).status).toBe(202);
    // The turn starts once that connection has listed its tools, so the agent's catalog has them.
    await Bun.sleep(300);
    expect(starts).toEqual([]);
    const list = await rpc("alice", "stub", toolsList, { session });
    expect((await list.json()).result.tools.map((t: any) => t.name)).toContain(
      "lookup_customer",
    );
    await until(() => starts.length > 0);
    expect(starts[0]! - t0).toBeLessThan(4000); // waited for the listing, not the 5 s bound
    expect(
      since(mark).find((r) => r.rpcMethod === "initialize")?.authorization,
    ).toBe("Bearer valid-alice-1");
    await settled(alice);
  });

  test("tool calls stream through as SSE with the person's latest credential", async () => {
    const res = await rpc("alice", "stub", lookup(), { session });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const frames = [];
    for await (const f of sseFrames(res.body!)) frames.push(JSON.parse(f.data));
    expect(JSON.parse(frames[0].result.content[0].text)).toMatchObject({
      id: "42",
      ...STUB_CUSTOMER,
    });
    await turn(alice, { mcpAuth: { stub: "Bearer valid-alice-2" } }); // latest wins
    await (await rpc("alice", "stub", lookup(), { session })).text();
    expect(stub.requests.at(-1)?.authorization).toBe("Bearer valid-alice-2");
  });

  test("a server's question mid-call (elicitation) and its answer pass both ways", async () => {
    const call = await rpc(
      "alice",
      "stub",
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "confirm_action",
          arguments: { action: "archive note" },
        },
      },
      { session },
    );
    const reader = sseFrames(call.body!);
    const ask = JSON.parse((await reader.next()).value!.data);
    expect(ask.method).toBe("elicitation/create");
    const answered = await rpc(
      "alice",
      "stub",
      { jsonrpc: "2.0", id: ask.id, result: { action: "accept", content: {} } },
      { session },
    );
    expect(answered.status).toBe(202);
    const done = JSON.parse((await reader.next()).value!.data);
    expect(done.result.content[0].text).toBe("The person answered: accept.");
  });

  test("person A's credential is never used for person B", async () => {
    await call(bob.token, "PUT", "/v1/mcp-servers/stub", { url: stub.url });
    await turn(bob, { mcpAuth: { stub: "Bearer valid-bob-1" } });
    const init = await rpc("bob", "stub", initialize);
    const bobSession = init.headers.get("mcp-session-id")!;
    await init.text();
    await (
      await rpc("bob", "stub", lookup("7"), { session: bobSession })
    ).text();
    expect(stub.requests.at(-1)?.authorization).toBe("Bearer valid-bob-1");
    await (await rpc("alice", "stub", lookup(), { session })).text();
    expect(stub.requests.at(-1)?.authorization).toBe("Bearer valid-alice-2");
    // Bob's runtime token cannot reach Alice's path at all.
    const cross = await rpc("alice", "stub", lookup(), {
      token: M.proxyToken(cfg.serviceSecret, key("bob")),
    });
    expect(cross.status).toBe(401);
    // Every request in one person's session carried that person's credential.
    const bySession = (id: string) =>
      stub.requests
        .filter((r) => r.sessionId === id)
        .map((r) => r.authorization);
    expect(bySession(bobSession)).toEqual(["Bearer valid-bob-1"]);
    expect(bySession(session).length).toBeGreaterThan(0);
    expect(bySession(session).every((a) => a?.includes("alice"))).toBe(true);
  });

  test("an expired credential becomes a tool error the agent can relay, never a 401", async () => {
    await turn(alice, { mcpAuth: { stub: "Bearer expired-alice" } });
    const res = await rpc("alice", "stub", lookup(), { session });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toEqual({
      content: [{ type: "text", text: M.COPY.expired("stub") }],
      isError: true,
    });
    expect(stub.requests.at(-1)?.status).toBe(401); // the upstream refused it
    // The spent credential is dropped; other requests get a JSON-RPC error, not an HTTP error.
    expect(
      (await call(alice.token, "GET", "/v1/mcp-servers")).body.servers[0]
        .hasCredential,
    ).toBe(false);
    const list = await rpc("alice", "stub", toolsList, { session });
    expect(list.status).toBe(200);
    expect((await list.json()).error.message).toBe(M.COPY.expired("stub"));
    // Optional SSE stream and session end need no credential and never fail the connection.
    expect(
      (await rpc("alice", "stub", null, { method: "GET", session })).status,
    ).toBe(405);
    expect(
      (await rpc("alice", "stub", null, { method: "DELETE", session })).status,
    ).toBe(204);
  });

  test("a handshake refused for an expired credential waits for the next one", async () => {
    await turn(alice, { mcpAuth: { stub: "Bearer expired-alice-hs" } });
    const mark = stub.requests.length;
    const held = rpc("alice", "stub", initialize);
    await Bun.sleep(300);
    // Tried once, refused, and now held.
    expect(since(mark).map((r) => [r.authorization, r.status])).toEqual([
      ["Bearer expired-alice-hs", 401],
    ]);
    const sending = send(alice, { mcpAuth: { stub: "Bearer valid-alice-hs" } });
    const res = await held;
    expect(res.status).toBe(200);
    expect(stub.requests.at(-1)?.authorization).toBe("Bearer valid-alice-hs");
    session = res.headers.get("mcp-session-id")!;
    await res.text();
    expect((await sending).status).toBe(202);
    await (await rpc("alice", "stub", toolsList, { session })).text(); // as the agent does next
    await settled(alice);
  });

  test("credentials are forgotten once the person is idle", async () => {
    await turn(alice, { mcpAuth: { stub: "Bearer valid-alice-3" } });
    expect(
      (await call(alice.token, "GET", "/v1/mcp-servers")).body.servers[0]
        .hasCredential,
    ).toBe(true);
    const k = key("alice");
    const p = gateway.people.get(k)!;
    await until(() => p.queues.size === 0);
    p.lastUsed = 0;
    gateway.idleSweep();
    expect(gateway.people.has(k)).toBe(false);
    expect(gateway.people.has(key("bob"))).toBe(true); // only the idle person
    // Its socket is closed with it, and nothing is held for it any more.
    await expect(rpc("alice", "stub", lookup(), { session })).rejects.toThrow();
    const res = await gateway.mcpProxy(
      new Request(`http://runtime/mcp/${k}/stub`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${M.proxyToken(cfg.serviceSecret, k)}`,
          "content-type": "application/json",
          "mcp-session-id": session,
        },
        body: JSON.stringify(lookup()),
      }),
      { timeout() {} },
      k,
    );
    expect((await res.json()).result.content[0].text).toBe(
      M.COPY.expired("stub"),
    );
    expect(
      (await call(alice.token, "GET", "/v1/mcp-servers")).body.servers[0]
        .hasCredential,
    ).toBe(false);
  });

  test("enabledTools reaches the agent and is enforced by the proxy too", async () => {
    await call(alice.token, "PUT", "/v1/mcp-servers/stub", {
      url: stub.url,
      enabledTools: ["lookup_customer"],
    });
    await turn(alice, { mcpAuth: { stub: "Bearer valid-alice-4" } }); // listens on the socket again
    // The agent gets the proxy and its own token: never the upstream address or the credential.
    const k = key("alice");
    expect(claude.inputs.at(-1)!.mcpServers).toEqual([
      {
        name: "stub",
        url: `http://127.0.0.1:8790/mcp/${k}/stub`,
        headers: {
          Authorization: `Bearer ${M.proxyToken(cfg.serviceSecret, k)}`,
        },
        enabledTools: ["lookup_customer"],
      },
    ]);
    const mark = stub.requests.length;
    const res = await rpc(
      "alice",
      "stub",
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "confirm_action", arguments: { action: "x" } },
      },
      { session },
    );
    expect((await res.json()).result).toEqual({
      content: [
        { type: "text", text: M.COPY.disabled("stub", "confirm_action") },
      ],
      isError: true,
    });
    expect(stub.requests.length).toBe(mark); // refused at the proxy
    const allowed = await rpc("alice", "stub", lookup(), { session });
    const frames = [];
    for await (const f of sseFrames(allowed.body!))
      frames.push(JSON.parse(f.data));
    expect(JSON.parse(frames[0].result.content[0].text)).toMatchObject(
      STUB_CUSTOMER,
    );
  });

  test("mcpAuth is validated without echoing it; DELETE forgets the server and its credential", async () => {
    for (const mcpAuth of [
      { stub: "Bearer bad\nvalue-SECRETX" },
      { "Not A Name": "Bearer valid-SECRETX" },
      "Bearer valid-SECRETX",
    ]) {
      const r = await send(alice, { mcpAuth });
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).not.toContain("SECRETX");
    }
    expect(
      (await call(bob.token, "GET", "/v1/mcp-servers")).body.servers[0]
        .hasCredential,
    ).toBe(true);
    expect(
      (await call(bob.token, "DELETE", "/v1/mcp-servers/stub")).status,
    ).toBe(204);
    expect(
      (await call(bob.token, "GET", "/v1/mcp-servers")).body.servers,
    ).toEqual([]);
    const res = await rpc("bob", "stub", lookup());
    expect((await res.json()).result.content[0].text).toBe(
      M.COPY.removed("stub"),
    );
    // Registered again, it starts without the old credential.
    expect(
      (await call(bob.token, "PUT", "/v1/mcp-servers/stub", { url: stub.url }))
        .body.server.hasCredential,
    ).toBe(false);
  });

  test("credentials never reach the agents, the person's home, the store, responses or logs", () => {
    const secrets = ["valid-alice", "valid-bob", "expired-alice", "SECRETX"];
    const agentSide = JSON.stringify([claude.inputs, restarted.inputs]);
    const homeSide = JSON.stringify([written, execs]);
    const state = JSON.stringify([...gateway.people.values()], (_k, v) =>
      v instanceof Map || v instanceof Set ? [...v] : v,
    );
    // The SQLite file itself, with its write-ahead log.
    const db = Buffer.concat(
      [dbPath, `${dbPath}-wal`].filter(existsSync).map((f) => readFileSync(f)),
    );
    expect(db.includes("Look up customer 42")).toBe(true); // the files hold the messages
    for (const s of secrets) {
      expect(agentSide).not.toContain(s);
      expect(homeSide).not.toContain(s);
      expect(state).not.toContain(s);
      expect(db.includes(s)).toBe(false);
      expect(responses.join("\n")).not.toContain(s);
      expect(logs.join("\n")).not.toContain(s);
    }
  });
});

describe("hidden per-message context", () => {
  test("the agent receives it; the person never sees it in replies, history, titles or events", async () => {
    const carol = await connectedPerson("carol");
    // Untitled, so the generated title shows what it is made of.
    const created = await call(carol.token, "POST", "/v1/conversations", {
      provider: "claude",
      model: "claude-code/default",
    });
    const conversation = created.body.conversation.id as string;
    const s = await listen(carol);
    const context = "Viewing record HIDDENCTX-77 in the app";
    const sent = await call(
      carol.token,
      "POST",
      `/v1/conversations/${conversation}/messages`,
      { text: "What am I looking at?", context },
    );
    expect(sent.status).toBe(202);
    expect(sent.body.message.text).toBe("What am I looking at?");
    await s.until(
      (e) =>
        e.event === "conversation.run" && e.data.run.status === "completed",
    );
    s.close();
    const delivered = claude.inputs
      .filter((i) => i.conversationId === conversation)
      .at(-1)!.text;
    expect(delivered.startsWith(CONTEXT_OPEN)).toBe(true);
    expect(delivered).toContain(context);
    expect(delivered.endsWith("\n\nWhat am I looking at?")).toBe(true);
    const page = await call(
      carol.token,
      "GET",
      `/v1/conversations/${conversation}/messages`,
    );
    expect(page.body.messages[0]).toMatchObject({
      role: "user",
      text: "What am I looking at?",
    });
    expect(page.body.conversation.title).toBe("What am I looking at?");
    await call(carol.token, "GET", "/v1/conversations");
    const echoed = s.events.find(
      (e) =>
        e.event === "conversation.message" && e.data.message.role === "user",
    );
    expect(echoed?.data.message.text).toBe("What am I looking at?");
    expect(JSON.stringify(s.events)).not.toContain("HIDDENCTX");
    expect(responses.join("\n")).not.toContain("HIDDENCTX");
    for (const bad of [`x ${CONTEXT_CLOSE} y`, "x".repeat(MAX_CONTEXT + 1), 42])
      expect(
        (
          await call(
            carol.token,
            "POST",
            `/v1/conversations/${conversation}/messages`,
            { text: "hi", context: bad },
          )
        ).status,
      ).toBe(400);
  });

  test("text without context reaches the agent and the history untouched", async () => {
    expect(withContext("hi", "")).toBe("hi");
    for (const body of [
      { text: "plain text" },
      { text: "hi\n\nthere", context: "" },
      { text: `${CONTEXT_OPEN}\nnot from the app\n${CONTEXT_CLOSE}\n\nhi` },
    ]) {
      await turn(alice, body);
      expect(claude.inputs.at(-1)!.text).toBe(body.text);
      const page = await settled(alice);
      expect(
        page.messages.filter((m: any) => m.role === "user").at(-1).text,
      ).toBe(body.text);
    }
  });
});

describe("conversations: paging, search, rename, archive", () => {
  test("pages newest first, searches titles, renames and archives", async () => {
    const dave = await connectedPerson("dave");
    const more: string[] = [];
    for (const title of ["Invoice follow-up", "Weekly plan"]) {
      await Bun.sleep(5);
      more.push(
        (
          await call(dave.token, "POST", "/v1/conversations", {
            provider: "claude",
            model: "claude-code/default",
            title,
          })
        ).body.conversation.id,
      );
    }
    const first = await call(dave.token, "GET", "/v1/conversations?limit=2");
    expect(first.body.conversations.map((c: any) => c.title)).toEqual([
      "Weekly plan",
      "Invoice follow-up",
    ]);
    const second = await call(
      dave.token,
      "GET",
      `/v1/conversations?limit=2&cursor=${first.body.nextCursor}`,
    );
    expect(second.body.conversations.map((c: any) => c.title)).toEqual([
      "dave chat",
    ]);
    expect(second.body.nextCursor).toBeNull();
    expect(
      (
        await call(dave.token, "GET", "/v1/conversations?query=INVOICE")
      ).body.conversations.map((c: any) => c.id),
    ).toEqual([more[0]]);
    expect(
      (await call(dave.token, "GET", "/v1/conversations?cursor=nonsense"))
        .status,
    ).toBe(400);

    const renamed = await call(
      dave.token,
      "PATCH",
      `/v1/conversations/${more[1]}`,
      { title: "Plan for Monday" },
    );
    expect(renamed.body.conversation.title).toBe("Plan for Monday");
    expect(
      (await call(dave.token, "GET", "/v1/conversations?query=monday")).body
        .conversations.length,
    ).toBe(1);
    expect(
      (await call(dave.token, "GET", `/v1/conversations/${more[1]}/messages`))
        .body.conversation.title,
    ).toBe("Plan for Monday");
    expect(
      (
        await call(dave.token, "PATCH", `/v1/conversations/${more[1]}`, {
          title: "",
        })
      ).status,
    ).toBe(400);
    // The person's own title wins; null goes back to the generated one, which is the title given
    // at creation ("Weekly plan") and is not replaced by the first message.
    await turn(
      { token: dave.token, conversation: more[1]! },
      { text: "Weekly plan for the team\nwith the details" },
    );
    expect(
      (await call(dave.token, "GET", `/v1/conversations/${more[1]}/messages`))
        .body.conversation.title,
    ).toBe("Plan for Monday");
    expect(
      (
        await call(dave.token, "PATCH", `/v1/conversations/${more[1]}`, {
          title: null,
        })
      ).body.conversation.title,
    ).toBe("Weekly plan");
    expect(
      (
        await call(bob.token, "PATCH", `/v1/conversations/${more[1]}`, {
          title: "mine",
        })
      ).status,
    ).toBe(404);

    expect(
      (await call(bob.token, "DELETE", `/v1/conversations/${more[0]}`)).status,
    ).toBe(404);
    expect(
      (await call(dave.token, "DELETE", `/v1/conversations/${more[0]}`)).status,
    ).toBe(204);
    expect(
      (
        await call(dave.token, "GET", "/v1/conversations")
      ).body.conversations.map((c: any) => c.id),
    ).not.toContain(more[0]);
    expect(
      (await call(dave.token, "GET", `/v1/conversations/${more[0]}/messages`))
        .status,
    ).toBe(404);
  });
});

describe("standing instructions", () => {
  test("kept by the gateway, written as AGENTS.md and CLAUDE.md in the chat workspace, and cleared", async () => {
    const k = key("alice");
    const text = "Always answer in one sentence.\n";
    const mark = written.length;
    expect(
      (await call(alice.token, "PUT", "/v1/instructions", { text })).body.text,
    ).toBe(text);
    expect(
      written
        .slice(mark)
        .filter((w) => w.key === k)
        .map((w) => [w.dir, w.name, w.content]),
    ).toEqual([
      [WORKSPACE, "AGENTS.md", text],
      [WORKSPACE, "CLAUDE.md", text],
    ]);
    expect((await call(alice.token, "GET", "/v1/instructions")).body.text).toBe(
      text,
    );
    expect(
      (await call(alice.token, "PUT", "/v1/instructions", { text: 5 })).status,
    ).toBe(400);
    expect(
      (await call(alice.token, "PUT", "/v1/instructions", { text: "" })).body
        .text,
    ).toBe("");
    expect(execs.at(-1)).toEqual([
      "rm",
      "-f",
      `${WORKSPACE}/AGENTS.md`,
      `${WORKSPACE}/CLAUDE.md`,
    ]);
    expect((await call(alice.token, "GET", "/v1/instructions")).body.text).toBe(
      "",
    );
  });
});
