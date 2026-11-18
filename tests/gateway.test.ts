// Gateway behavior through its real HTTP handler, with a fake runtime and fake per-person daemons.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { devToken } from "../src/auth";
import type { Config } from "../src/config";
import { createGateway } from "../src/gateway";
import { PROVIDER_IDS } from "../src/happy";
import { GEMINI_KEY_COMMAND, runtimeKey } from "../src/runtime";
import { sseFrames } from "../src/sse";
import {
  FakeRuntime,
  GOOD_CODE_PREFIX,
  GOOD_KEY_PREFIX,
  socketProxyPolicy,
} from "./fake-daemon";

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

/** Opens a person's event stream, as an app does when its UI opens; this starts their runtime. */
async function listen(
  token: string,
  send: (req: Request) => Promise<Response> = (req) => fetch(req),
) {
  const ac = new AbortController();
  const res = await send(
    new Request(`${base}/v1/events`, {
      headers: { authorization: `Bearer ${token}` },
      signal: ac.signal,
    }),
  );
  const events: { event: string; data: any }[] = [];
  void (async () => {
    try {
      for await (const f of sseFrames(res.body!))
        events.push({ event: f.event, data: JSON.parse(f.data) });
    } catch {}
  })();
  const updates = () => events.filter((e) => e.event === "provider.updated");
  return { events, updates, close: () => ac.abort() };
}

const until = async (ok: () => boolean | Promise<boolean>, ms = 5000) => {
  for (const end = Date.now() + ms; !(await ok()); await Bun.sleep(25))
    if (Date.now() > end) throw new Error("timed out");
};

/** Starts a person's runtime the way an app does, and waits until it is up and the stream closed. */
async function wake(token: string) {
  const stream = await listen(token);
  await until(() => stream.updates().length >= PROVIDER_IDS.length);
  stream.close();
  await until(() =>
    [...gateway.people.values()].every((p) => p.clients.size === 0),
  );
}

const unknown = (id: string) => ({
  id,
  status: "unknown",
  method: null,
  account: null,
  models: [],
  checkedAt: null,
});

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
      ["POST", "/v1/providers/antigravity/connect"],
      ["POST", "/v1/providers/bedrock/connect"],
      ["DELETE", "/v1/providers/bedrock"],
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
  test("reads never start a runtime: providers are unknown, everything else is runtime_stopped", async () => {
    const key = runtimeKey(cfg.serviceSecret, "alice");
    const { status, body } = await call(alice, "GET", "/v1/providers");
    expect(status).toBe(200);
    expect(body.providers).toEqual(PROVIDER_IDS.map(unknown));
    for (const path of [
      "/v1/conversations",
      "/v1/conversations/mabc/messages",
      "/v1/providers/claude/connect",
      "/v1/mcp-servers",
      "/v1/instructions",
    ])
      expect(await call(alice, "GET", path)).toMatchObject({
        status: 409,
        body: { error: "runtime_stopped" },
      });
    expect(runtime.calls.filter((c) => c.includes(key))).toEqual([]);
    expect(runtime.daemons.has(key)).toBe(false);
  });

  test("opening the event stream starts the runtime, archives the admin bot and sends the live state", async () => {
    const key = runtimeKey(cfg.serviceSecret, "alice");
    const stream = await listen(alice);
    await until(() => stream.updates().length >= PROVIDER_IDS.length);
    stream.close();
    expect(runtime.calls).toContain(`ensure ${key}`);
    expect(
      stream
        .updates()
        .map(({ data: { provider: p } }) => [p.id, p.status, p.models.length])
        .sort(),
    ).toEqual([
      ["claude", "not_connected", 0],
      ["codex", "not_connected", 0],
      ["gemini", "not_connected", 0],
      ["grok", "not_connected", 0],
      ["openrouter", "not_connected", 0],
    ]);
    const { body } = await call(alice, "GET", "/v1/providers");
    expect(
      body.providers.map((p: any) => [p.id, p.status, p.models.length]),
    ).toEqual([
      ["claude", "not_connected", 0],
      ["codex", "not_connected", 0],
      ["grok", "not_connected", 0],
      ["openrouter", "not_connected", 0],
      ["gemini", "not_connected", 0],
    ]);
    const d = runtime.daemons.get(key)!;
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
    // Claude Code's own names arrive once read from the person's runtime.
    let names: string[] = [];
    await until(async () => {
      names = (await call(alice, "GET", "/v1/providers")).body.providers[0]
        .models.map((m: any) => m.name);
      return names.includes("Opus 5.5");
    });
    expect(names).not.toContain("Claude Code · Opus");
  });

  test("disconnect signs out with the vendor CLI and restarts the runtime", async () => {
    runtime.calls.length = 0;
    const r = await call(alice, "DELETE", "/v1/providers/codex");
    expect(r.status).toBe(200);
    const key = runtimeKey(cfg.serviceSecret, "alice");
    // The restarted runtime's Claude Code model names are read again, in the background.
    expect(runtime.calls.filter((c) => !c.endsWith("claude-models"))).toEqual(
      [`exec ${key} sh`, `restart ${key}`],
    );
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

describe("Grok and OpenRouter", () => {
  const fixture = (name: string) =>
    Bun.file(`${import.meta.dir}/fixtures/${name}`).json();
  const provider = async (token: string, id: string) =>
    (await call(token, "GET", "/v1/providers")).body.providers.find(
      (p: any) => p.id === id,
    );

  test("Grok: one call starts the device flow; the approved code connects Grok, whose conversations run on Happy's grok account", async () => {
    const gina = await tokenFor("gina");
    const key = runtimeKey(cfg.serviceSecret, "gina");
    const start = await call(gina, "POST", "/v1/providers/grok/connect", {});
    expect(start.body.connection).toEqual({
      status: "waiting",
      flow: "device_code",
      url: "https://accounts.x.ai/oauth2/device?user_code=WXYZ-2345",
      userCode: "WXYZ-2345",
      expiresAt: expect.any(String),
      error: null,
      account: null,
    });
    // Grok has no code to paste and takes no API key.
    expect(
      await call(gina, "POST", "/v1/providers/grok/connect/code", {
        code: "WXYZ-2345",
      }),
    ).toMatchObject({ status: 409, body: { error: "not_waiting_for_code" } });
    expect(
      await call(gina, "POST", "/v1/providers/grok/connect", {
        method: "api_key",
        apiKey: "x".repeat(40),
      }),
    ).toMatchObject({
      status: 400,
      body: { message: "Only Claude, OpenRouter and Gemini accept an API key." },
    });
    runtime.daemons.get(key)!.approveDevice("grok");
    await until(async () => (await provider(gina, "grok")).status === "connected");
    const grok = await provider(gina, "grok");
    expect(grok).toMatchObject({
      method: "subscription",
      account: { email: "user@example.com", plan: null },
    });
    expect(grok.models.map((m: any) => m.id)).toContain("xai/grok-4.7");
    expect(
      (await call(gina, "GET", "/v1/providers/grok/connect")).body.connection,
    ).toMatchObject({ status: "connected", flow: "device_code" });

    const created = await call(gina, "POST", "/v1/conversations", {
      provider: "grok",
      model: "xai/grok-4.7",
    });
    expect(created.status).toBe(201);
    expect(created.body.conversation).toMatchObject({
      provider: "grok",
      model: "xai/grok-4.7",
      effort: "high",
    });
    const id = created.body.conversation.id;
    const sent = await call(gina, "POST", `/v1/conversations/${id}/messages`, {
      text: "hi",
      effort: "low",
    });
    expect(sent.body.conversation).toMatchObject({
      provider: "grok",
      effort: "low",
    });
    const send = runtime.daemons
      .get(key)!
      .requests.find((r) => r.path === `/v0/agents/${id}/send`)!;
    expect(JSON.parse(send.body).mode).toMatchObject({
      providerId: "grok",
      modelId: "xai/grok-4.7",
    });
    // Models of another account are refused.
    expect(
      (
        await call(gina, "POST", `/v1/conversations/${id}/messages`, {
          text: "hi",
          model: "codex-cli/gpt-6-luna",
        })
      ).body.error,
    ).toBe("model_unavailable");

    runtime.calls.length = 0;
    runtime.execs.length = 0;
    expect((await call(gina, "DELETE", "/v1/providers/grok")).status).toBe(200);
    expect(runtime.execs).toEqual([
      [
        "sh",
        "-c",
        'grok logout >/dev/null 2>&1; rm -f "$HOME/.grok/"auth.json*',
      ],
    ]);
    expect(runtime.calls).toContain(`restart ${key}`);
  });

  test("OpenRouter connects only with the person's own API key", async () => {
    const olga = await tokenFor("olga");
    await wake(olga);
    for (const body of [{}, { method: "subscription" }])
      expect(
        await call(olga, "POST", "/v1/providers/openrouter/connect", body),
      ).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    expect(
      (await call(olga, "GET", "/v1/providers/openrouter/connect")).body,
    ).toEqual({ connection: null });
    expect(
      await call(olga, "POST", "/v1/providers/openrouter/connect/code", {
        code: "abc",
      }),
    ).toMatchObject({ status: 409, body: { error: "not_waiting_for_code" } });
    expect(
      await call(olga, "DELETE", "/v1/providers/openrouter/connect"),
    ).toEqual({ status: 200, body: { connection: null } });
    expect(
      await call(olga, "POST", "/v1/providers/openrouter/connect", {
        method: "api_key",
        apiKey: "sk-or-short",
      }),
    ).toEqual({
      status: 400,
      body: {
        error: "invalid_api_key_format",
        message: "Paste the whole key. It starts with sk-or-.",
      },
    });
  });

  test("a refused OpenRouter key is removed again; an accepted one connects OpenRouter, and the key stays out of the gateway", async () => {
    const olga = await tokenFor("olga");
    const key = runtimeKey(cfg.serviceSecret, "olga");
    const path = "/home/agent/.agent-runtime/openrouter-api-key";
    const bad = `sk-or-v1-SECRETOR${"0".repeat(48)}`;
    const good = `${GOOD_KEY_PREFIX}-SECRETOR${"1".repeat(48)}`;
    responses.length = 0;
    logs.length = 0;
    runtime.execs.length = 0;
    const refused = await call(olga, "POST", "/v1/providers/openrouter/connect", {
      method: "api_key",
      apiKey: bad,
    });
    expect(refused.body.connection).toEqual({
      status: "failed",
      flow: "api_key",
      url: null,
      userCode: null,
      expiresAt: null,
      error: {
        code: "invalid_api_key",
        message:
          "OpenRouter didn't accept that API key, or couldn't be reached. Check the key and try again.",
      },
      account: null,
    });
    expect(runtime.execs).toContainEqual(["rm", "-f", path]);
    expect(runtime.volume.has(`${key}:${path}`)).toBe(false);
    expect(
      (await call(olga, "GET", "/v1/providers/openrouter/connect")).body
        .connection.error.code,
    ).toBe("invalid_api_key");
    // The verdict is OpenRouter's alone.
    expect(
      (await call(olga, "GET", "/v1/providers/claude/connect")).body.connection,
    ).toBeNull();

    const accepted = await call(olga, "POST", "/v1/providers/openrouter/connect", {
      method: "api_key",
      apiKey: ` ${good} `,
    });
    expect(accepted.body.connection).toMatchObject({
      status: "connected",
      flow: "api_key",
      error: null,
      account: { email: null, plan: "API key" },
    });
    expect(runtime.volume.get(`${key}:${path}`)).toBe(`${good}\n`);
    const daemon = runtime.daemons.get(key)!;
    expect(
      daemon.requests
        .filter((r) => r.path.endsWith("/verify"))
        .map((r) => [r.path, r.body]),
    ).toEqual([
      ["/v0/providers/openrouter/verify", '{"level":"authentication"}'],
      ["/v0/providers/openrouter/verify", '{"level":"authentication"}'],
    ]);
    const openrouter = await provider(olga, "openrouter");
    expect(openrouter).toMatchObject({
      status: "connected",
      method: "api_key",
      account: { email: null, plan: "API key" },
    });
    expect(openrouter.models).toHaveLength(6);
    expect(openrouter.models[0]).toMatchObject({
      id: "deepseek/deepseek-v4.1-flash-1017",
      name: "DeepSeek: DeepSeek V4.1 Flash 1017",
      default: false,
    });

    const created = await call(olga, "POST", "/v1/conversations", {
      provider: "openrouter",
      model: "deepseek/deepseek-v4.1-flash-1017",
    });
    expect(created.body.conversation).toMatchObject({
      provider: "openrouter",
      model: "deepseek/deepseek-v4.1-flash-1017",
    });
    const draft = daemon.requests.find(
      (r) =>
        r.method === "PUT" &&
        r.path === `/v0/agents/${created.body.conversation.id}/draft`,
    )!;
    expect(JSON.parse(draft.body).draft.providerId).toBe("openrouter");

    // The key reached the person's volume only: never a response, a log, the daemon or memory.
    expect(responses.join("\n")).not.toContain("SECRETOR");
    expect(logs.join("\n")).not.toContain("SECRETOR");
    expect(daemon.requests.some((r) => r.body.includes("SECRETOR"))).toBe(false);
    const state = JSON.stringify([...gateway.people.values()], (_k, v) =>
      v instanceof Map || v instanceof Set ? [...v] : v,
    );
    expect(state).not.toContain("SECRETOR");
  });

  test("a turn whose key OpenRouter refuses makes it not connected; disconnecting removes the key", async () => {
    const olga = await tokenFor("olga");
    const key = runtimeKey(cfg.serviceSecret, "olga");
    const page = await fixture("messages-invalid-api-key-openrouter.json");
    const message = page.runs
      .at(-1)
      .messages.find((m: any) => m.failure);
    runtime.daemons.get(key)!.push("message.created", {
      agentId: "someconversation",
      runId: "r1",
      message: { ...message, createdAt: Date.now() },
    });
    await until(
      async () => (await provider(olga, "openrouter")).status === "not_connected",
    );
    expect(
      (await call(olga, "GET", "/v1/providers/openrouter/connect")).body
        .connection,
    ).toBeNull();

    runtime.calls.length = 0;
    runtime.execs.length = 0;
    const daemon = runtime.daemons.get(key)!;
    const seen = daemon.requests.length;
    const r = await call(olga, "DELETE", "/v1/providers/openrouter");
    expect(r.body.provider).toMatchObject({
      id: "openrouter",
      status: "not_connected",
      method: null,
      models: [],
    });
    expect(runtime.execs).toEqual([
      ["rm", "-f", "/home/agent/.agent-runtime/openrouter-api-key"],
    ]);
    expect(runtime.calls).toContain(`restart ${key}`);
    // It has no sign-in of its own, and no other provider's was touched.
    expect(
      daemon.requests.slice(seen).filter((r) => r.path.startsWith("/v0/provider-clis/") && r.method === "POST"),
    ).toEqual([]);
  });
});

describe("Gemini (the person's own Gemini API key, run by Antigravity's agent)", () => {
  const provider = async (token: string) =>
    (await call(token, "GET", "/v1/providers")).body.providers.find(
      (p: any) => p.id === "gemini",
    );
  const path = "/home/agent/.agent-runtime/gemini-api-key";

  test("connects only with an API key, which Google checks from inside the runtime; a refused one is removed", async () => {
    const gwen = await tokenFor("gwen");
    const key = runtimeKey(cfg.serviceSecret, "gwen");
    await wake(gwen);
    expect(
      await call(gwen, "POST", "/v1/providers/gemini/connect", {}),
    ).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    expect(
      await call(gwen, "POST", "/v1/providers/gemini/connect", {
        method: "api_key",
        apiKey: "AIza-short",
      }),
    ).toEqual({
      status: 400,
      body: {
        error: "invalid_api_key_format",
        message: "Paste the whole key. It starts with AIza.",
      },
    });
    responses.length = 0;
    logs.length = 0;
    runtime.execs.length = 0;
    const refused = await call(gwen, "POST", "/v1/providers/gemini/connect", {
      method: "api_key",
      apiKey: `AIzaSECRETGEM${"0".repeat(26)}`,
    });
    expect(refused.body.connection).toMatchObject({
      status: "failed",
      flow: "api_key",
      error: {
        code: "invalid_api_key",
        message:
          "Google didn't accept that API key, or couldn't be reached. Check the key and try again.",
      },
    });
    expect(runtime.execs).toEqual([
      GEMINI_KEY_COMMAND,
      ["rm", "-f", path],
    ]);
    expect(runtime.volume.has(`${key}:${path}`)).toBe(false);
    // Happy's own provider check is never asked about this account.
    expect(
      runtime.daemons
        .get(key)!
        .requests.some((r) => r.path.endsWith("/verify")),
    ).toBe(false);
    expect((await provider(gwen)).status).toBe("not_connected");
  });

  test("an accepted key connects Gemini with the models agy reports, and its conversations run on the Antigravity account", async () => {
    const gwen = await tokenFor("gwen");
    const key = runtimeKey(cfg.serviceSecret, "gwen");
    const accepted = await call(gwen, "POST", "/v1/providers/gemini/connect", {
      method: "api_key",
      apiKey: `${GOOD_KEY_PREFIX}SECRETGEM${"1".repeat(26)}`,
    });
    expect(accepted.body.connection).toEqual({
      status: "connected",
      flow: "api_key",
      url: null,
      userCode: null,
      expiresAt: null,
      error: null,
      account: { email: null, plan: "API key" },
    });
    const gemini = await provider(gwen);
    expect(gemini).toMatchObject({
      status: "connected",
      method: "api_key",
      account: { email: null, plan: "API key" },
    });
    expect(gemini.models[0]).toMatchObject({
      id: "antigravity/gemini-4-carbon",
      name: "Gemini 4 Carbon",
      default: false,
    });
    const created = await call(gwen, "POST", "/v1/conversations", {
      provider: "gemini",
      model: "antigravity/gemini-3.8-flash",
    });
    expect(created.status).toBe(201);
    expect(created.body.conversation).toMatchObject({
      provider: "gemini",
      model: "antigravity/gemini-3.8-flash",
      effort: "high",
    });
    const id = created.body.conversation.id;
    const daemon = runtime.daemons.get(key)!;
    const draft = daemon.requests.find(
      (r) => r.method === "PUT" && r.path === `/v0/agents/${id}/draft`,
    )!;
    expect(JSON.parse(draft.body).draft.providerId).toBe("antigravity");
    const sent = await call(gwen, "POST", `/v1/conversations/${id}/messages`, {
      text: "hi",
      effort: "low",
    });
    expect(sent.body.conversation).toMatchObject({
      provider: "gemini",
      effort: "low",
    });
    expect(
      (await call(gwen, "GET", "/v1/conversations")).body.conversations[0]
        .provider,
    ).toBe("gemini");
    // The key reached the person's volume only.
    expect(responses.join("\n")).not.toContain("SECRETGEM");
    expect(logs.join("\n")).not.toContain("SECRETGEM");
    expect(daemon.requests.some((r) => r.body.includes("SECRETGEM"))).toBe(false);
    const state = JSON.stringify([...gateway.people.values()], (_k, v) =>
      v instanceof Map || v instanceof Set ? [...v] : v,
    );
    expect(state).not.toContain("SECRETGEM");
  });

  test("disconnecting removes the key and turns the account off again", async () => {
    const gwen = await tokenFor("gwen");
    runtime.execs.length = 0;
    const r = await call(gwen, "DELETE", "/v1/providers/gemini");
    expect(r.body.provider).toMatchObject({
      id: "gemini",
      status: "not_connected",
      models: [],
    });
    expect(runtime.execs).toEqual([["rm", "-f", path]]);
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
    // Haiku's context fills toward its 200k compaction point; usage is that model's totals.
    expect(page.body.context).toEqual({
      usedTokens: 1200,
      limitTokens: 200000,
      approximate: false,
    });
    expect(page.body.usage).toEqual({
      input: 1100,
      output: 100,
      cacheRead: 900,
      cacheWrite: 50,
    });
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
      PROVIDER_IDS.length,
    ); // Bob's own snapshot
  });

  test("a runtime stopped outside the gateway: a read answers without starting it, the next change starts it", async () => {
    const key = runtimeKey(cfg.serviceSecret, "carol");
    const carol = await tokenFor("carol");
    await wake(carol);
    runtime.kill(key);
    runtime.calls.length = 0;
    const read = await call(carol, "GET", "/v1/providers");
    expect(read.body.providers.map((p: any) => p.status)).toEqual(
      PROVIDER_IDS.map(() => "not_connected"),
    );
    expect(runtime.calls).not.toContain(`ensure ${key}`);
    const t0 = performance.now();
    expect(
      (await call(carol, "POST", "/v1/providers/codex/connect", {})).status,
    ).toBe(200);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(runtime.calls).toContain(`ensure ${key}`);
    await call(carol, "DELETE", "/v1/providers/codex/connect");
  });

  test("while an event stream is open, a runtime that went away is restarted at once", async () => {
    const key = runtimeKey(cfg.serviceSecret, "frank");
    const stream = await listen(await tokenFor("frank"));
    await until(() => stream.updates().length >= PROVIDER_IDS.length);
    runtime.kill(key);
    runtime.calls.length = 0;
    stream.events.length = 0;
    // A restart waits for a runtime that is still shutting down; a plain start would not.
    await until(() => runtime.calls.includes(`restart ${key}`));
    // Its clients get the live state again once it is back.
    await until(() => stream.updates().length >= PROVIDER_IDS.length);
    stream.close();
  });

  test("idle runtimes stop, but never while a run is in progress", async () => {
    const key = runtimeKey(cfg.serviceSecret, "dave");
    await wake(await tokenFor("dave"));
    const fake = runtime.daemons.get(key)!;
    fake.agents.set("busyconvo", {
      id: "busyconvo",
      workspaceId: "chats",
      parentAgentId: null,
      status: "working",
      pendingQuestionId: null,
      createdAt: 0,
      archivedAt: null,
    });
    for (const p of gateway.people.values()) p.lastUsed = 0;
    runtime.calls.length = 0;
    await gateway.idleSweep();
    expect(runtime.calls).not.toContain(`stop ${key}`);
    fake.agents.get("busyconvo").status = "idle";
    gateway.people.get(key)!.lastUsed = 0;
    await gateway.idleSweep();
    expect(runtime.calls).toContain(`stop ${key}`);
  });

  test("an open event stream keeps the runtime from idling out; the idle period starts when it closes", async () => {
    const key = runtimeKey(cfg.serviceSecret, "heidi");
    const stream = await listen(await tokenFor("heidi"));
    await until(() => stream.updates().length >= PROVIDER_IDS.length);
    const heidi = gateway.people.get(key)!;
    heidi.lastUsed = 0;
    runtime.calls.length = 0;
    await gateway.idleSweep();
    expect(runtime.calls).not.toContain(`stop ${key}`);
    stream.close();
    await until(() => heidi.clients.size === 0);
    await gateway.idleSweep();
    expect(runtime.calls).not.toContain(`stop ${key}`);
    heidi.lastUsed = 0;
    await gateway.idleSweep();
    expect(runtime.calls).toContain(`stop ${key}`);
  });

  test("a runtime that lost its network addresses restarts once idle, never mid-run; meanwhile the person sees connecting", async () => {
    const key = runtimeKey(cfg.serviceSecret, "rita");
    const rita = await tokenFor("rita");
    const agent = { id: "busyconvo", status: "working", pendingQuestionId: null };
    runtime.stale.add(key);
    runtime.agents.set(key, [agent]);
    runtime.calls.length = 0;
    const stream = await listen(rita);
    await until(() => stream.updates().length >= PROVIDER_IDS.length);
    const statuses = (list: any[]) => list.map((p) => p.status);
    expect(statuses(stream.updates().map((u) => u.data.provider))).toEqual(
      PROVIDER_IDS.map(() => "connecting"),
    );
    expect(
      statuses((await call(rita, "GET", "/v1/providers")).body.providers),
    ).toEqual(PROVIDER_IDS.map(() => "connecting"));
    const change = await call(rita, "PUT", "/v1/instructions", { text: "x" });
    expect([change.status, change.body.error]).toEqual([
      503,
      "runtime_unavailable",
    ]);
    // A run in progress holds the restart up.
    await until(
      () => runtime.calls.filter((c) => c === `activity ${key}`).length >= 2,
      10_000,
    );
    expect(runtime.calls).not.toContain(`stop ${key}`);
    // A question that waits for the person does not: they cannot answer it before the restart.
    agent.pendingQuestionId = "q1" as any;
    await until(() => runtime.calls.includes(`stop ${key}`), 10_000);
    // Then it starts at the current addresses, and the open stream gets the live state.
    await until(
      () =>
        stream
          .updates()
          .some((u) => u.data.provider.status === "not_connected"),
      10_000,
    );
    const calls = runtime.calls.filter((c) => !c.startsWith("activity"));
    expect(calls).toEqual([`ensure ${key}`, `stop ${key}`, `ensure ${key}`]);
    expect(
      statuses((await call(rita, "GET", "/v1/providers")).body.providers),
    ).toEqual(PROVIDER_IDS.map(() => "not_connected"));
    stream.close();
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

describe("last-known provider state", () => {
  const idleStop = async (key: string) => {
    const person = gateway.people.get(key)!;
    await until(() => person.clients.size === 0);
    person.lastUsed = 0;
    await gateway.idleSweep();
    expect(person.daemon).toBeUndefined();
  };
  const erinKey = runtimeKey(cfg.serviceSecret, "erin");
  let erin: string;

  test("a stopped runtime answers at once with what it last reported and starts nothing; the event stream starts it", async () => {
    erin = await tokenFor("erin");
    await call(erin, "POST", "/v1/providers/claude/connect", {});
    await call(erin, "POST", "/v1/providers/claude/connect/code", {
      code: `${GOOD_CODE_PREFIX}#state`,
    });
    const live = (await call(erin, "GET", "/v1/providers")).body.providers;
    expect(live[0]).toMatchObject({ id: "claude", status: "connected" });
    await wake(erin);
    await idleStop(erinKey);

    runtime.startDelayMs = 1500; // a real runtime takes a second or more to start
    runtime.calls.length = 0;
    const asked = Date.now();
    const t0 = performance.now();
    const r = await call(erin, "GET", "/v1/providers");
    expect(performance.now() - t0).toBeLessThan(500);
    expect(r.body.providers.map((p: any) => [p.id, p.status])).toEqual([
      ["claude", "connected"],
      ["codex", "not_connected"],
      ["grok", "not_connected"],
      ["openrouter", "not_connected"],
      ["gemini", "not_connected"],
    ]);
    expect(r.body.providers[0].models.length).toBeGreaterThan(0);
    expect(Date.parse(r.body.providers[0].checkedAt)).toBeLessThan(asked);
    await Bun.sleep(300);
    expect(runtime.calls).toEqual([]);

    // Opening the event stream starts it; reads meanwhile still answer at once from memory.
    const stream = await listen(erin);
    await until(() => runtime.calls.includes(`ensure ${erinKey}`));
    const t1 = performance.now();
    const during = await call(erin, "GET", "/v1/providers");
    expect(performance.now() - t1).toBeLessThan(500);
    expect(during.body.providers[0]).toMatchObject({ status: "connected" });
    // Once it is up, the live state arrives on the stream.
    await until(() =>
      stream
        .updates()
        .some((e) => Date.parse(e.data.provider.checkedAt) >= asked),
    );
    stream.close();
    runtime.startDelayMs = 0;
    expect(runtime.calls.filter((c) => c === `ensure ${erinKey}`)).toHaveLength(
      1,
    );
    expect(gateway.people.get(erinKey)!.daemon).toBeDefined();
  });

  test("a turn that finds the sign-in expired makes it not connected, also while stopped, until a new sign-in", async () => {
    const fake = runtime.daemons.get(erinKey)!;
    fake.push("message.created", {
      agentId: "someconversation",
      runId: "r1",
      message: {
        id: "failed1",
        role: "service",
        createdAt: Date.now(),
        content: [{ type: "text", text: "Not logged in · Please run /login" }],
        error: { code: "inference_failed", mode: { providerId: "claude" } },
        failure: {
          kind: "internal",
          message: "Not logged in · Please run /login",
        },
      },
    });
    const claude = async () =>
      (await call(erin, "GET", "/v1/providers")).body.providers[0];
    await until(async () => (await claude()).status === "not_connected");
    expect(await claude()).toMatchObject({
      method: null,
      account: null,
      models: [],
    });
    expect(
      (await call(erin, "GET", "/v1/providers/claude/connect")).body.connection,
    ).toBeNull();

    await idleStop(erinKey);
    expect(await claude()).toMatchObject({ status: "not_connected" });

    await call(erin, "POST", "/v1/providers/claude/connect", {});
    const r = await call(erin, "POST", "/v1/providers/claude/connect/code", {
      code: `${GOOD_CODE_PREFIX}#again`,
    });
    expect(r.body.connection.status).toBe("connected");
    expect(await claude()).toMatchObject({ status: "connected" });
  });

  test("after a gateway restart nothing is remembered: unknown at once, nothing started until the event stream opens", async () => {
    await idleStop(erinKey);
    const restarted = createGateway(cfg, runtime, { log: () => {} });
    runtime.calls.length = 0;
    const t0 = performance.now();
    const res = await restarted.fetch(
      new Request(`${base}/v1/providers`, {
        headers: { authorization: `Bearer ${erin}` },
      }),
    );
    expect(performance.now() - t0).toBeLessThan(500);
    expect(res.status).toBe(200);
    expect((await res.json()).providers).toEqual(PROVIDER_IDS.map(unknown));
    await Bun.sleep(300);
    expect(runtime.calls).toEqual([]);

    const stream = await listen(erin, restarted.fetch);
    await until(() => stream.updates().length >= PROVIDER_IDS.length);
    stream.close();
    expect(runtime.calls).toContain(`ensure ${erinKey}`);
    expect(
      stream.updates().find((e) => e.data.provider.id === "claude")!.data
        .provider,
    ).toMatchObject({ status: "connected" });
  });

  test("what is remembered holds no credentials", () => {
    const known = JSON.stringify(
      [...gateway.people.values()].map((p) => p.known),
    );
    expect(known).toContain("user@example.com");
    expect(known).not.toMatch(/sk-ant|SECRET|goodcode|token/i);
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
