// Application MCP servers through the real gateway handlers and the real proxy listener, with a
// fake runtime, fake per-person daemons and a real Streamable HTTP MCP server (scripts/stub-mcp.ts).
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { devToken } from "../src/auth";
import type { Config } from "../src/config";
import { createGateway } from "../src/gateway";
import * as H from "../src/happy";
import * as M from "../src/mcp";
import { runtimeKey } from "../src/runtime";
import { sseFrames } from "../src/sse";
import { STUB_CUSTOMER, startStubMcp } from "../scripts/stub-mcp";
import { FakeRuntime, GOOD_CODE_PREFIX, socketProxyPolicy } from "./fake-daemon";

setDefaultTimeout(30_000);
const stub = startStubMcp();
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
  dockerHost: "",
  runtimeImage: "x",
  runtimeNetwork: "x",
  runtimePrefix: "test",
  runtimePlatform: "",
  runtimeMemoryMb: 1,
  runtimeCpus: 1,
  runtimePids: 1,
  bridgeAllow: "",
  idleMs: 60_000,
  permissionMode: "auto",
  restartAfterSignIn: false,
  devVolumeOverrides: new Map(),
  mcpProxyPort: 0,
  mcpProxyUrl: "",
  mcpAllowedOrigins: [new URL(stub.url).origin],
} as Config;

const logs: string[] = [];
const log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
const runtime = new FakeRuntime();
const gateway = createGateway(cfg, runtime, { log });
const api = Bun.serve({ port: 0, fetch: gateway.fetch, idleTimeout: 60 });
const proxy = Bun.serve({ port: 0, fetch: gateway.mcpProxy, idleTimeout: 60 });
afterAll(() => {
  api.stop(true);
  proxy.stop(true);
  stub.stop();
  runtime.stopAll();
});

const key = (subject: string) => runtimeKey(cfg.serviceSecret, subject);
const responses: string[] = [];
async function call(
  token: string,
  method: string,
  path: string,
  body?: unknown,
) {
  const res = await fetch(`http://127.0.0.1:${api.port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  responses.push(text);
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** A request as the person's runtime would send it to the proxy. */
function rpc(
  subject: string,
  name: string,
  body: unknown,
  opts: {
    token?: string | null;
    method?: string;
    session?: string;
    signal?: AbortSignal;
  } = {},
) {
  const token =
    opts.token === undefined
      ? M.proxyToken(cfg.serviceSecret, key(subject))
      : opts.token;
  return fetch(`http://127.0.0.1:${proxy.port}/mcp/${key(subject)}/${name}`, {
    method: opts.method ?? "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(opts.session ? { "mcp-session-id": opts.session } : {}),
    },
    body: (opts.method ?? "POST") === "POST" ? JSON.stringify(body) : undefined,
    signal: opts.signal,
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

async function connectedPerson(subject: string) {
  const token = await devToken(cfg.devSecret, subject);
  await call(token, "POST", "/v1/providers/claude/connect", {});
  await call(token, "POST", "/v1/providers/claude/connect/code", {
    code: `${GOOD_CODE_PREFIX}#s`,
  });
  const created = await call(token, "POST", "/v1/conversations", {
    provider: "claude",
    model: "claude-code/haiku",
    title: `${subject} chat`,
  });
  return { token, conversation: created.body.conversation.id as string };
}

const alice = await connectedPerson("alice");
const bob = await connectedPerson("bob");
const send = (
  who: { token: string; conversation: string },
  extra: Record<string, unknown> = {},
) =>
  call(who.token, "POST", `/v1/conversations/${who.conversation}/messages`, {
    text: "Look up customer 42",
    ...extra,
  });

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

  test("the runtime gets a sealed registry and a template naming only the proxy, then restarts", async () => {
    const k = key("alice");
    const template = runtime.volume.get(
      `${k}:${M.MCP_DIR}/${M.TEMPLATE_FILE}`,
    )!;
    expect(template).toContain("[mcp_servers.stub]");
    expect(template).toContain(`url = "${M.PROXY_URL_PLACEHOLDER}/stub"`);
    expect(template).toContain(`bearer_token_env_var = "${M.PROXY_TOKEN_ENV}"`);
    expect(template).not.toContain(stub.url); // the upstream address stays with the gateway
    const sealed = runtime.volume.get(`${k}:${M.MCP_DIR}/${M.REGISTRY_FILE}`)!;
    expect(
      M.openRegistry(cfg.serviceSecret, k, sealed)?.map((s) => s.url),
    ).toEqual([stub.url]);
    for (let i = 0; i < 50 && !runtime.calls.includes(`restart ${k}`); i++)
      await Bun.sleep(50);
    expect(runtime.calls).toContain(`restart ${k}`); // Happy reads mcp.toml when it starts
    // A change that leaves Happy's config alone (only the description) needs no restart.
    runtime.calls.length = 0;
    await call(alice.token, "PUT", "/v1/mcp-servers/stub", {
      url: stub.url,
      description: "Renamed",
    });
    await Bun.sleep(300);
    expect(runtime.calls).not.toContain(`restart ${k}`);
  });

  test("registrations survive a gateway restart; a file edited inside the runtime is ignored", async () => {
    const again = createGateway(cfg, runtime, { log });
    const res = await again.fetch(
      new Request("http://x/v1/mcp-servers", {
        headers: { authorization: `Bearer ${alice.token}` },
      }),
    );
    expect((await res.json()).servers.map((s: any) => s.url)).toEqual([
      stub.url,
    ]);
    const k = key("alice");
    const path = `${k}:${M.MCP_DIR}/${M.REGISTRY_FILE}`;
    const sealed = runtime.volume.get(path)!;
    runtime.volume.set(
      path,
      sealed.replace(stub.url, "https://attacker.example/mcp"),
    );
    const third = createGateway(cfg, runtime, { log });
    const r3 = await third.fetch(
      new Request("http://x/v1/mcp-servers", {
        headers: { authorization: `Bearer ${alice.token}` },
      }),
    );
    expect((await r3.json()).servers).toEqual([]);
    expect(logs.some((l) => l.startsWith("mcp registrations ignored"))).toBe(
      true,
    );
    runtime.volume.set(path, sealed);
  });
});

describe("the proxy refuses anyone but the person's own runtime", () => {
  test("absent or wrong runtime token, another person's token, a neighbour's address", async () => {
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
    runtime.addresses.set(key("alice"), "10.9.9.9"); // the token leaked to another container
    expect((await rpc("alice", "stub", lookup())).status).toBe(403);
    runtime.addresses.delete(key("alice"));
    const res = await fetch(`http://127.0.0.1:${proxy.port}/mcp/zz/stub`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(404);
    expect(stub.requests.length).toBe(0); // nothing reached the upstream
  });
});

describe("credentials: per message, per person, memory only", () => {
  let session = "";

  test("a waiting connection gets the first credential; the upstream sees it, the runtime does not", async () => {
    // Happy connects at startup, before any message: the proxy holds the handshake.
    const held = rpc("alice", "stub", initialize);
    await Bun.sleep(200);
    expect(stub.requests.length).toBe(0);
    const t0 = performance.now();
    const sending = send(alice, { mcpAuth: { stub: "Bearer valid-alice-1" } });
    const init = await held;
    expect(init.status).toBe(200);
    session = init.headers.get("mcp-session-id")!;
    expect(session).toMatch(/^[0-9a-f-]{36}$/);
    expect((await init.json()).result.serverInfo.name).toBe("stub-mcp");
    const list = await rpc("alice", "stub", toolsList, { session }); // as Happy does right after
    expect((await list.json()).result.tools.map((t: any) => t.name)).toContain(
      "lookup_customer",
    );
    expect((await sending).status).toBe(202);
    expect(performance.now() - t0).toBeLessThan(4000); // waited for the listing, not the 5 s bound
    expect(
      stub.requests.find((r) => r.rpcMethod === "initialize")?.authorization,
    ).toBe("Bearer valid-alice-1");
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
    await send(alice, { mcpAuth: { stub: "Bearer valid-alice-2" } }); // latest wins
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
    await send(bob, { mcpAuth: { stub: "Bearer valid-bob-1" } });
    const init = await rpc("bob", "stub", initialize);
    const bobSession = init.headers.get("mcp-session-id")!;
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
    const bobSeen = stub.requests.filter((r) =>
      r.authorization?.includes("bob"),
    ).length;
    const aliceSeen = stub.requests.filter((r) =>
      r.authorization?.includes("alice"),
    ).length;
    expect(bobSeen + aliceSeen).toBe(
      stub.requests.filter((r) => r.authorization).length,
    );
  });

  test("an expired credential becomes a tool error the agent can relay, never a 401", async () => {
    await send(alice, { mcpAuth: { stub: "Bearer expired-alice" } });
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
    await send(alice, { mcpAuth: { stub: "Bearer expired-alice-hs" } });
    const held = rpc("alice", "stub", initialize);
    await Bun.sleep(300);
    expect(stub.requests.at(-1)?.status).toBe(401); // tried once, then holds
    const sending = send(alice, { mcpAuth: { stub: "Bearer valid-alice-hs" } });
    const res = await held;
    expect(res.status).toBe(200);
    expect(stub.requests.at(-1)?.authorization).toBe("Bearer valid-alice-hs");
    session = res.headers.get("mcp-session-id")!;
    await (await rpc("alice", "stub", toolsList, { session })).text(); // as Happy does next
    expect((await sending).status).toBe(202);
  });

  test("credentials are forgotten when the runtime stops", async () => {
    await send(alice, { mcpAuth: { stub: "Bearer valid-alice-3" } });
    expect(
      (await call(alice.token, "GET", "/v1/mcp-servers")).body.servers[0]
        .hasCredential,
    ).toBe(true);
    for (const p of gateway.people.values()) p.lastUsed = 0;
    await gateway.idleSweep();
    expect(runtime.calls).toContain(`stop ${key("alice")}`);
    const res = await rpc("alice", "stub", lookup(), { session });
    expect((await res.json()).result.content[0].text).toBe(
      M.COPY.expired("stub"),
    );
  });

  test("enabledTools reaches Happy's config and is enforced by the proxy too", async () => {
    await call(alice.token, "PUT", "/v1/mcp-servers/stub", {
      url: stub.url,
      enabledTools: ["lookup_customer"],
    });
    expect(
      runtime.volume.get(`${key("alice")}:${M.MCP_DIR}/${M.TEMPLATE_FILE}`),
    ).toContain('enabled_tools = ["lookup_customer"]');
    await send(alice, { mcpAuth: { stub: "Bearer valid-alice-4" } });
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
      (await call(bob.token, "DELETE", "/v1/mcp-servers/stub")).status,
    ).toBe(204);
    expect(
      (await call(bob.token, "GET", "/v1/mcp-servers")).body.servers,
    ).toEqual([]);
    const res = await rpc("bob", "stub", lookup());
    expect((await res.json()).result.content[0].text).toBe(
      M.COPY.removed("stub"),
    );
  });

  test("credentials never reach the runtime, its files, the daemon, responses or logs", () => {
    const secrets = ["valid-alice", "valid-bob", "expired-alice", "SECRETX"];
    const runtimeSide = JSON.stringify([
      ...runtime.volume.values(),
      ...runtime.files.map((f) => f.content),
    ]);
    const daemonSide = JSON.stringify(
      [...runtime.daemons.values()].map((d) => d.requests),
    );
    const state = JSON.stringify([...gateway.people.values()], (_k, v) =>
      v instanceof Map || v instanceof Set ? [...v] : v,
    );
    for (const s of secrets) {
      expect(runtimeSide).not.toContain(s);
      expect(daemonSide).not.toContain(s);
      expect(responses.join("\n")).not.toContain(s);
      expect(logs.join("\n")).not.toContain(s);
      expect(state).not.toContain(s);
    }
    expect(
      stub.requests.some((r) => r.authorization === "Bearer valid-alice-4"),
    ).toBe(false); // never called after
  });
});

describe("hidden per-message context", () => {
  test("the agent receives it; the person never sees it in replies, history or events", async () => {
    const carol = await connectedPerson("carol");
    const ac = new AbortController();
    const events: { event: string; data: any }[] = [];
    const stream = await fetch(`http://127.0.0.1:${api.port}/v1/events`, {
      headers: { authorization: `Bearer ${carol.token}` },
      signal: ac.signal,
    });
    void (async () => {
      try {
        for await (const f of sseFrames(stream.body!))
          events.push({ event: f.event, data: JSON.parse(f.data) });
      } catch {}
    })();
    const context = "Viewing record HIDDENCTX-77 in the app";
    const sent = await send(carol, { text: "What am I looking at?", context });
    expect(sent.status).toBe(202);
    expect(sent.body.message.text).toBe("What am I looking at?");
    const daemon = runtime.daemons.get(key("carol"))!;
    const delivered = JSON.parse(
      daemon.requests.filter((r) => r.path.endsWith("/send")).at(-1)!.body,
    ).text;
    expect(delivered.startsWith(H.CONTEXT_OPEN)).toBe(true);
    expect(delivered).toContain(context);
    expect(delivered.endsWith("\n\nWhat am I looking at?")).toBe(true);
    const page = await call(
      carol.token,
      "GET",
      `/v1/conversations/${carol.conversation}/messages`,
    );
    expect(page.body.messages[0]).toMatchObject({
      role: "user",
      text: "What am I looking at?",
    });
    // The daemon's own event for that message carries the full text.
    const stored = daemon.agents.get(carol.conversation).runs.at(-1)
      .messages[0];
    daemon.push("message.created", {
      agentId: carol.conversation,
      runId: stored.id,
      message: stored,
    });
    await Bun.sleep(300);
    ac.abort();
    const echoed = events.find((e) => e.event === "conversation.message");
    expect(echoed?.data.message.text).toBe("What am I looking at?");
    expect(JSON.stringify(events)).not.toContain("HIDDENCTX");
    expect(JSON.stringify(page.body)).not.toContain("HIDDENCTX");
    for (const bad of [
      `x ${H.CONTEXT_CLOSE} y`,
      "x".repeat(H.MAX_CONTEXT + 1),
      42,
    ])
      expect((await send(carol, { context: bad })).status).toBe(400);
  });

  test("text without context is untouched, even if it looks like a marker", () => {
    expect(H.stripContext("plain text")).toBe("plain text");
    expect(H.stripContext(H.withContext("hi", ""))).toBe("hi");
    expect(H.stripContext(H.withContext("hi\n\nthere", "ctx"))).toBe(
      "hi\n\nthere",
    );
  });
});

describe("conversations: paging, search, rename, archive", () => {
  test("pages newest first, searches titles, renames and archives", async () => {
    const dave = await connectedPerson("dave");
    const more = [];
    for (const title of ["Invoice follow-up", "Weekly plan"]) {
      await Bun.sleep(5);
      more.push(
        (
          await call(dave.token, "POST", "/v1/conversations", {
            provider: "claude",
            model: "claude-code/haiku",
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
  test("written as AGENTS.md and CLAUDE.md in the chat workspace, read back, and cleared", async () => {
    const k = key("alice");
    const text = "Always answer in one sentence.\n";
    expect(
      (await call(alice.token, "PUT", "/v1/instructions", { text })).body.text,
    ).toBe(text);
    for (const path of [
      `${H.RUNTIME_DIR}/${H.INSTRUCTIONS_FILE}`,
      `${H.PROJECT_PATH}/AGENTS.md`,
      `${H.PROJECT_PATH}/CLAUDE.md`,
    ])
      expect(runtime.volume.get(`${k}:${path}`)).toBe(text);
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
    expect(runtime.volume.has(`${k}:${H.PROJECT_PATH}/CLAUDE.md`)).toBe(false);
    expect((await call(alice.token, "GET", "/v1/instructions")).body.text).toBe(
      "",
    );
  });
});

describe("files read from the person's volume", () => {
  test("a read cut off by a runtime restart is an error, never an empty file", async () => {
    const grace = await devToken(cfg.devSecret, "grace");
    const k = key("grace");
    expect((await call(grace, "GET", "/v1/providers")).status).toBe(200);
    const registered = [
      { name: "app", url: stub.url, enabledTools: null, description: null },
    ];
    runtime.volume.set(
      `${k}:${M.MCP_DIR}/${M.REGISTRY_FILE}`,
      M.sealRegistry(cfg.serviceSecret, k, registered),
    );
    runtime.volume.set(`${k}:${H.RUNTIME_DIR}/${H.INSTRUCTIONS_FILE}`, "Be brief.\n");
    runtime.failReads = 137;
    try {
      expect((await call(grace, "GET", "/v1/instructions")).status).toBe(503);
      expect((await call(grace, "GET", "/v1/mcp-servers")).status).toBe(503);
    } finally {
      runtime.failReads = undefined;
    }
    // Nothing was cached from the failed reads.
    expect((await call(grace, "GET", "/v1/instructions")).body.text).toBe("Be brief.\n");
    expect(
      (await call(grace, "GET", "/v1/mcp-servers")).body.servers.map((s: any) => s.name),
    ).toEqual(["app"]);
  });
});

describe("Happy's MCP configuration", () => {
  test("the template is valid TOML with the proxy, the token variable and the long startup timeout", () => {
    const toml = M.renderMcpToml([
      {
        name: "app",
        url: "https://app.example.com/mcp",
        enabledTools: ["a", "b.c"],
        description: null,
      },
    ]);
    const parsed = Bun.TOML.parse(
      toml.replaceAll(M.PROXY_URL_PLACEHOLDER, "http://gw:8790/mcp/k"),
    ) as any;
    expect(parsed.mcp_servers.app).toEqual({
      url: "http://gw:8790/mcp/k/app",
      bearer_token_env_var: "MCP_PROXY_TOKEN",
      startup_timeout_sec: 600,
      enabled_tools: ["a", "b.c"],
    });
  });
});

describe("socket proxy policy (deploy/sockguard.yaml)", () => {
  test("every command the gateway ran in a runtime and every folder it wrote to is allowlisted", async () => {
    const policy = await socketProxyPolicy();
    expect(runtime.execs.length).toBeGreaterThan(0);
    expect(
      runtime.execs.filter((c) => !policy.commands.has(JSON.stringify(c))),
    ).toEqual([]);
    expect(
      [...new Set(runtime.files.map((f) => f.dir))].filter(
        (d) => !policy.paths.includes(d),
      ),
    ).toEqual([]);
  });
});
