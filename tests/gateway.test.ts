// Gateway behavior through its real HTTP handler, with a fake runtime and fake per-person daemons.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { devToken } from "../src/auth";
import type { Config } from "../src/config";
import { createGateway } from "../src/gateway";
import { runtimeKey } from "../src/runtime";
import { sseFrames } from "../src/sse";
import { FakeRuntime, GOOD_CODE_PREFIX, socketProxyPolicy } from "./fake-daemon";

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
  permissionMode: "workspace_write",
  restartAfterSignIn: false,
  devVolumeOverrides: new Map(),
  mcpProxyPort: 0,
  mcpProxyUrl: "",
  mcpAllowedOrigins: [] as string[],
} as Config;

setDefaultTimeout(30_000);
const logs: string[] = [];
const runtime = new FakeRuntime();
const gateway = createGateway(cfg, runtime, {
  log: (...a) => logs.push(a.map(String).join(" ")),
});
const server = Bun.serve({ port: 0, fetch: gateway.fetch, idleTimeout: 60 });
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => {
  server.stop(true);
  runtime.stopAll();
});

const tokenFor = (subject: string) => devToken(cfg.devSecret, subject);
const alice = await tokenFor("alice");
const bob = await tokenFor("bob");
const responses: string[] = [];
async function call(
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
  raw?: string,
) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body || raw ? { "content-type": "application/json" } : {}),
    },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  responses.push(text);
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("façade surface", () => {
  test("anything outside the /v1 contract is 404, authenticated or not", async () => {
    for (const [method, path] of [
      ["GET", "/v0/health"],
      ["POST", "/v0/shutdown"],
      ["POST", "/v1/shutdown"],
      ["POST", "/v1/drain"],
      ["GET", "/v1/config"],
      ["GET", "/v1/bots"],
      ["GET", "/v1/connections"],
      ["POST", "/v1/providers/grok/connect"],
      ["PATCH", "/v1/providers"],
      ["GET", "/v1/providers/claude"],
      ["PUT", "/v1/conversations"],
      ["GET", "/v1/conversations/BAD-ID/messages"],
      ["GET", "/"],
    ])
      expect(
        `${method} ${path} ${(await call(alice, method, path)).status}`,
      ).toBe(`${method} ${path} 404`);
  });

  test("every façade route needs a valid service token", async () => {
    expect((await call(null, "GET", "/v1/providers")).status).toBe(401);
    expect((await call("not-a-jwt", "GET", "/v1/providers")).status).toBe(401);
    const forged = await devToken(
      "another-secret-that-is-32-characters-long",
      "alice",
    );
    expect((await call(forged, "GET", "/v1/providers")).status).toBe(401);
  });
});

describe("providers and sign-in", () => {
  test("first request starts the runtime, archives the admin bot and lists both providers", async () => {
    const { status, body } = await call(alice, "GET", "/v1/providers");
    expect(status).toBe(200);
    expect(
      body.providers.map((p: any) => [p.id, p.status, p.models.length]),
    ).toEqual([
      ["claude", "not_connected", 0],
      ["codex", "not_connected", 0],
    ]);
    const d = runtime.daemons.get(runtimeKey(cfg.serviceSecret, "alice"))!;
    expect(
      d.requests.some(
        (r) =>
          r.method === "POST" && r.path === "/v0/bots/chiefofstaff/archive",
      ),
    ).toBe(true);
  });

  test("Codex: one call starts the device flow; cancel ends it", async () => {
    const { body } = await call(
      alice,
      "POST",
      "/v1/providers/codex/connect",
      {},
    );
    expect(body.connection).toMatchObject({
      status: "waiting",
      flow: "device_code",
      userCode: "ABCD-12345",
      url: "https://auth.openai.com/codex/device",
      error: null,
    });
    expect(
      (await call(alice, "GET", "/v1/providers/codex/connect")).body.connection
        .status,
    ).toBe("waiting");
    expect(
      (await call(alice, "DELETE", "/v1/providers/codex/connect")).body
        .connection.status,
    ).toBe("cancelled");
  });

  test("Claude: a malformed code is wrong_code and the sign-in keeps waiting", async () => {
    const start = await call(alice, "POST", "/v1/providers/claude/connect", {});
    expect(start.body.connection).toMatchObject({
      status: "waiting",
      flow: "paste_code",
      error: null,
    });
    const r = await call(alice, "POST", "/v1/providers/claude/connect/code", {
      code: "notarealcode",
    });
    expect(r.body.connection).toMatchObject({
      status: "waiting",
      url: start.body.connection.url,
      error: { code: "wrong_code" },
    });
    expect(
      (await call(alice, "GET", "/v1/providers/claude/connect")).body.connection
        .error.code,
    ).toBe("wrong_code");
  });

  test("Claude: a refused code restarts the sign-in, still waiting with wrong_code and a new page", async () => {
    const before = (await call(alice, "GET", "/v1/providers/claude/connect"))
      .body.connection;
    const r = await call(alice, "POST", "/v1/providers/claude/connect/code", {
      code: "refused#state",
    });
    expect(r.body.connection).toMatchObject({
      status: "waiting",
      error: { code: "wrong_code" },
    });
    expect(r.body.connection.error.message).toContain(
      "Open the sign-in page again",
    );
    expect(r.body.connection.url).not.toBe(before.url);
  });

  test("Claude: the right code connects", async () => {
    const r = await call(alice, "POST", "/v1/providers/claude/connect/code", {
      code: `${GOOD_CODE_PREFIX}#state`,
    });
    expect(r.body.connection).toMatchObject({
      status: "connected",
      account: { email: "user@example.com", plan: "Max" },
    });
    const providers = (await call(alice, "GET", "/v1/providers")).body
      .providers;
    expect(providers[0]).toMatchObject({
      id: "claude",
      status: "connected",
      method: "subscription",
    });
    expect(providers[0].models.length).toBeGreaterThan(0);
  });

  test("disconnect signs out with the vendor CLI and restarts the runtime", async () => {
    runtime.calls.length = 0;
    const r = await call(alice, "DELETE", "/v1/providers/codex");
    expect(r.status).toBe(200);
    const key = runtimeKey(cfg.serviceSecret, "alice");
    expect(runtime.calls).toEqual([`exec ${key} sh`, `restart ${key}`]);
  });
});

describe("secrets pass through the gateway in memory only", () => {
  test("a pasted login code is never logged, stored or echoed", async () => {
    const secret = "SECRETCODE7f3a9";
    await call(bob, "POST", "/v1/providers/claude/connect", {});
    responses.length = 0;
    logs.length = 0;
    await call(bob, "POST", "/v1/providers/claude/connect/code", {
      code: `${secret}x`,
    }); // wrong code path
    await call(bob, "POST", "/v1/providers/claude/connect/code", {
      code: `${secret}#state`,
    }); // refused path
    await call(bob, "POST", "/v1/providers/claude/connect/code", {
      code: `${secret}echo`,
    }); // daemon echoes it in a 500
    await call(
      bob,
      "POST",
      "/v1/providers/claude/connect/code",
      undefined,
      `{"code":"${secret}`,
    ); // malformed JSON
    await call(bob, "POST", "/v1/providers/claude/connect/code", {
      code: `${secret}\u0001`,
    }); // invalid characters
    await call(bob, "POST", "/v1/providers/codex/connect/code", {
      code: secret,
    }); // nothing waiting for a code
    const bobDaemon = runtime.daemons.get(
      runtimeKey(cfg.serviceSecret, "bob"),
    )!;
    expect(
      bobDaemon.requests.filter((r) => r.body.includes(secret)).length,
    ).toBe(3); // delivered to the vendor CLI only
    expect(responses.join("\n")).not.toContain(secret);
    expect(logs.join("\n")).not.toContain(secret);
    expect(logs.some((l) => l.startsWith("request_failed"))).toBe(true); // the failure itself is logged
    const state = JSON.stringify([...gateway.people.values()], (_k, v) =>
      v instanceof Map || v instanceof Set ? [...v] : v,
    );
    expect(state).not.toContain(secret);
  });

  test("an Anthropic API key goes only to the person's own runtime volume", async () => {
    const key = "sk-ant-api03-SECRETKEY" + "x".repeat(40);
    responses.length = 0;
    logs.length = 0;
    const r = await call(bob, "POST", "/v1/providers/claude/connect", {
      method: "api_key",
      apiKey: key,
    });
    expect(r.body.connection).toMatchObject({
      status: "failed",
      flow: "api_key",
      error: { code: "invalid_api_key" },
    });
    const bad = await call(bob, "POST", "/v1/providers/claude/connect", {
      method: "api_key",
      apiKey: `${key} with spaces`,
    });
    expect(bad.status).toBe(400);
    expect(runtime.files).toEqual([
      {
        key: runtimeKey(cfg.serviceSecret, "bob"),
        dir: "/home/agent/.agent-runtime",
        name: "anthropic-api-key",
        content: `${key}\n`,
      },
    ]);
    expect(responses.join("\n")).not.toContain("SECRETKEY");
    expect(logs.join("\n")).not.toContain("SECRETKEY");
    const bobDaemon = runtime.daemons.get(
      runtimeKey(cfg.serviceSecret, "bob"),
    )!;
    expect(bobDaemon.requests.some((r) => r.body.includes("SECRETKEY"))).toBe(
      false,
    );
    const state = JSON.stringify([...gateway.people.values()], (_k, v) =>
      v instanceof Map || v instanceof Set ? [...v] : v,
    );
    expect(state).not.toContain("SECRETKEY");
  });
});

describe("conversations and isolation between people", () => {
  test("Alice's conversation is invisible and unreachable for Bob", async () => {
    const created = await call(alice, "POST", "/v1/conversations", {
      provider: "claude",
      model: "claude-code/haiku",
      title: "hello",
    });
    expect(created.status).toBe(201);
    expect(created.body.conversation).toMatchObject({
      provider: "claude",
      model: "claude-code/haiku",
      effort: "medium",
      status: "idle",
      title: "hello",
    });
    const id = created.body.conversation.id;
    const sent = await call(alice, "POST", `/v1/conversations/${id}/messages`, {
      text: "Reply with one word",
    });
    expect(sent.status).toBe(202);
    const page = await call(alice, "GET", `/v1/conversations/${id}/messages`);
    expect(page.body.messages.map((m: any) => [m.role, m.text])).toEqual([
      ["user", "Reply with one word"],
      ["assistant", "pong"],
    ]);
    expect(
      (await call(alice, "GET", "/v1/conversations")).body.conversations.map(
        (c: any) => c.id,
      ),
    ).toEqual([id]);

    const aliceDaemon = runtime.daemons.get(
      runtimeKey(cfg.serviceSecret, "alice"),
    )!;
    const seen = aliceDaemon.requests.length;
    expect(
      (await call(bob, "GET", "/v1/conversations")).body.conversations,
    ).toEqual([]);
    expect(
      (await call(bob, "GET", `/v1/conversations/${id}/messages`)).status,
    ).toBe(404);
    expect(
      (
        await call(bob, "POST", `/v1/conversations/${id}/messages`, {
          text: "hi",
        })
      ).status,
    ).toBe(404);
    expect(
      (await call(bob, "POST", `/v1/conversations/${id}/abort`)).status,
    ).toBe(404);
    expect(aliceDaemon.requests.length).toBe(seen); // Bob's requests never reached Alice's runtime
  });

  test("a model outside the live catalog is refused; signed-out providers need a sign-in first", async () => {
    expect(
      (
        await call(alice, "POST", "/v1/conversations", {
          provider: "claude",
          model: "claude-code/imaginary",
        })
      ).body.error,
    ).toBe("model_unavailable");
    expect(
      (
        await call(alice, "POST", "/v1/conversations", {
          provider: "codex",
          model: "codex-cli/gpt-6-luna",
        })
      ).body.error,
    ).toBe("signin_required");
  });

  test("one person's events reach only that person's stream", async () => {
    const open = async (token: string) => {
      const ac = new AbortController();
      const res = await fetch(`${base}/v1/events`, {
        headers: { authorization: `Bearer ${token}` },
        signal: ac.signal,
      });
      const events: { event: string; data: any }[] = [];
      void (async () => {
        try {
          for await (const f of sseFrames(res.body!))
            events.push({ event: f.event, data: JSON.parse(f.data) });
        } catch {}
      })();
      return { events, close: () => ac.abort() };
    };
    const a = await open(alice);
    const b = await open(bob);
    await Bun.sleep(300);
    const convo = (await call(alice, "GET", "/v1/conversations")).body
      .conversations[0].id;
    runtime.daemons
      .get(runtimeKey(cfg.serviceSecret, "alice"))!
      .push("run.started", {
        agentId: convo,
        run: { id: "r9", status: "running" },
      });
    await Bun.sleep(300);
    a.close();
    b.close();
    expect(
      a.events.some(
        (e) =>
          e.event === "conversation.run" && e.data.conversationId === convo,
      ),
    ).toBe(true);
    expect(b.events.some((e) => e.event.startsWith("conversation."))).toBe(
      false,
    );
    expect(b.events.filter((e) => e.event === "provider.updated").length).toBe(
      2,
    ); // Bob's own snapshot
  });

  test("a runtime stopped outside the gateway is started again on the next request", async () => {
    const key = runtimeKey(cfg.serviceSecret, "carol");
    const carol = await tokenFor("carol");
    expect((await call(carol, "GET", "/v1/providers")).status).toBe(200);
    runtime.kill(key);
    runtime.calls.length = 0;
    const t0 = performance.now();
    expect((await call(carol, "GET", "/v1/providers")).status).toBe(200);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(runtime.calls).toContain(`ensure ${key}`);
  });

  test("idle runtimes stop, but never while a run is in progress", async () => {
    const key = runtimeKey(cfg.serviceSecret, "dave");
    expect((await call(await tokenFor("dave"), "GET", "/v1/providers")).status).toBe(200);
    const fake = runtime.daemons.get(key)!;
    fake.agents.set("busyconvo", { id: "busyconvo", workspaceId: "chats", parentAgentId: null, status: "working", pendingQuestionId: null, createdAt: 0, archivedAt: null });
    for (const p of gateway.people.values()) p.lastUsed = 0;
    runtime.calls.length = 0;
    await gateway.idleSweep();
    expect(runtime.calls).not.toContain(`stop ${key}`);
    fake.agents.get("busyconvo").status = "idle";
    gateway.people.get(key)!.lastUsed = 0;
    await gateway.idleSweep();
    expect(runtime.calls).toContain(`stop ${key}`);
  });

  test("runtime names come from HMAC(secret, subject)", () => {
    const a = runtimeKey(cfg.serviceSecret, "alice");
    expect(a).toMatch(/^[0-9a-f]{24}$/);
    expect(a).toBe(runtimeKey(cfg.serviceSecret, "alice"));
    expect(a).not.toBe(runtimeKey(cfg.serviceSecret, "bob"));
    expect(a).not.toBe(
      runtimeKey("another-service-secret-of-32-characters", "alice"),
    );
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
