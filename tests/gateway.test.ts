// The /v1 façade through the gateway's real HTTP handler, with fake agents, sign-ins and runtime.
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devToken } from "../src/auth";
import type { Config } from "../src/config";
import { createGateway, type GatewayRuntime } from "../src/gateway";
import { runtimeKey } from "../src/runtime";
import { sseFrames } from "../src/sse";
import { Store } from "../src/store";
import type {
  Agent,
  KeyVerdict,
  ProviderId,
  ProviderLive,
  SignIn,
  SignInStatus,
  TurnEnd,
  TurnInput,
  TurnSink,
} from "../src/agents/types";
import { CONTEXT_OPEN } from "../src/providers";
import { fail } from "../src/agents/failures";
import { FakeAgent, FakeSignIn, execs, fakeRuntime, written } from "./fakes";

setDefaultTimeout(20_000);
const dir = mkdtempSync(join(tmpdir(), "tandem-gw-"));
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
  mcpAllowedOrigins: ["https://crm.example"],
} as unknown as Config;

const runtime = fakeRuntime(dir);

const claude = new FakeAgent(["claude"]);
const codex = new FakeAgent(["codex"]);
const acp = new FakeAgent(["grok", "openrouter", "gemini"]);
const claudeSignIn = new FakeSignIn("claude", "paste_code");
const codexSignIn = new FakeSignIn("codex", "device_code");
const grokSignIn = new FakeSignIn("grok", "device_code");
const store = new Store(join(dir, "tandem.db"));
const logs: string[] = [];
const gateway = createGateway(cfg, {
  runtime,
  agents: [claude, codex, acp],
  signIns: [claudeSignIn, codexSignIn, grokSignIn],
  store,
  log: (...a) => logs.push(a.map(String).join(" ")),
});
const server = Bun.serve({ port: 0, fetch: gateway.fetch, idleTimeout: 60 });
const base = `http://127.0.0.1:${server.port}`;
afterAll(async () => {
  await gateway.shutdown();
  server.stop(true);
});

const keyOf = (subject: string) => runtimeKey(cfg.serviceSecret, subject);
const tokens = new Map<string, string>();
async function token(subject: string) {
  if (!tokens.has(subject))
    tokens.set(subject, await devToken(cfg.devSecret, subject));
  return tokens.get(subject)!;
}
async function call(
  subject: string | null,
  method: string,
  path: string,
  body?: unknown,
) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(subject ? { authorization: `Bearer ${await token(subject)}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Opens the person's event stream and collects its events. */
async function listen(subject: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/v1/events`, {
    headers: { authorization: `Bearer ${await token(subject)}` },
    signal: ctrl.signal,
  });
  const events: { event: string; data: any }[] = [];
  const waiters: (() => void)[] = [];
  void (async () => {
    try {
      for await (const f of sseFrames(res.body!)) {
        events.push({ event: f.event, data: JSON.parse(f.data) });
        waiters.splice(0).forEach((w) => w());
      }
    } catch {}
  })();
  async function until(
    pred: (e: { event: string; data: any }) => boolean,
    ms = 5000,
  ) {
    const end = Date.now() + ms;
    for (;;) {
      const hit = events.find(pred);
      if (hit) return hit;
      if (Date.now() > end)
        throw new Error(
          `no matching event; got ${events.map((e) => e.event).join(",")}`,
        );
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }
  return { events, until, close: () => ctrl.abort() };
}

const providerOf = async (subject: string, id: string) =>
  (await call(subject, "GET", "/v1/providers")).body.providers.find(
    (p: any) => p.id === id,
  );

async function connectClaude(subject: string) {
  await call(subject, "POST", "/v1/providers/claude/connect", {});
  const r = await call(subject, "POST", "/v1/providers/claude/connect/code", {
    code: "good-code",
  });
  expect(r.body.connection.status).toBe("connected");
  // The account is read once after sign-in; wait for it.
  for (
    let i = 0;
    i < 50 && (await providerOf(subject, "claude")).status !== "connected";
    i++
  )
    await Bun.sleep(20);
}

async function newConversation(subject: string, model = "claude-code/default") {
  const r = await call(subject, "POST", "/v1/conversations", {
    provider: "claude",
    model,
  });
  expect(r.status).toBe(201);
  return r.body.conversation;
}

async function settled(subject: string, id: string) {
  for (let i = 0; i < 200; i++) {
    const r = await call(subject, "GET", `/v1/conversations/${id}/messages`);
    if (
      r.body.conversation.status === "idle" &&
      r.body.runs.every((x: any) => x.status !== "running")
    )
      return r.body;
    await Bun.sleep(20);
  }
  throw new Error("turn did not settle");
}

beforeEach(() => {
  claude.script = new FakeAgent([]).script;
  claude.signedIn = true;
});

// --- Tests ------------------------------------------------------------------------------------

describe("auth and routing", () => {
  test("every /v1 route needs a service token; unknown routes are 404", async () => {
    expect((await call(null, "GET", "/v1/providers")).status).toBe(401);
    expect((await call("alice", "GET", "/v1/nope")).body.error).toBe(
      "not_found",
    );
    expect((await call(null, "GET", "/healthz")).body.ok).toBe(true);
  });
});

describe("providers and sign-in", () => {
  test("a new person: nothing connected, answered at once without starting anything", async () => {
    const r = await call("fresh", "GET", "/v1/providers");
    expect(r.body.providers.map((p: any) => [p.id, p.status])).toEqual([
      ["claude", "not_connected"],
      ["codex", "not_connected"],
      ["grok", "not_connected"],
      ["openrouter", "not_connected"],
      ["gemini", "not_connected"],
    ]);
    expect(claude.reads.filter((r) => r.startsWith(keyOf("fresh")))).toEqual(
      [],
    );
  });

  test("Claude paste code: a wrong code waits, a refused one reissues, a good one connects", async () => {
    const start = await call("pc", "POST", "/v1/providers/claude/connect", {});
    expect(start.body.connection).toMatchObject({
      status: "waiting",
      flow: "paste_code",
      url: "https://claude.example/signin",
    });
    expect((await providerOf("pc", "claude")).status).toBe("connecting");
    const wrong = await call(
      "pc",
      "POST",
      "/v1/providers/claude/connect/code",
      { code: "nope" },
    );
    expect(wrong.body.connection).toMatchObject({
      status: "waiting",
      error: { code: "wrong_code" },
    });
    const dead = await call("pc", "POST", "/v1/providers/claude/connect/code", {
      code: "dead-code",
    });
    expect(dead.body.connection.error.code).toBe("wrong_code_reissued");
    expect(
      (
        await call("pc", "POST", "/v1/providers/claude/connect/code", {
          code: "a\nb",
        })
      ).body.error,
    ).toBe("invalid_code");
    const ok = await call("pc", "POST", "/v1/providers/claude/connect/code", {
      code: "good-code",
    });
    expect(ok.body.connection.status).toBe("connected");
    for (
      let i = 0;
      i < 50 && (await providerOf("pc", "claude")).status !== "connected";
      i++
    )
      await Bun.sleep(20);
    const view = await providerOf("pc", "claude");
    expect(view).toMatchObject({
      status: "connected",
      method: "subscription",
      account: { email: "person@example.com" },
    });
    expect(view.models.map((m: any) => m.id)).toEqual([
      "claude-code/default",
      "claude-code/opus",
    ]);
    expect(view.models[0]).toEqual({
      id: "claude-code/default",
      name: "Sonnet 5.5",
      default: true,
      efforts: ["low", "high"],
      defaultEffort: "high",
    });
    expect(
      (
        await call("pc", "POST", "/v1/providers/codex/connect/code", {
          code: "x",
        })
      ).body.error,
    ).toBe("not_waiting_for_code");
  });

  test("Codex device code connects when the person confirms, announced as provider.updated", async () => {
    const s = await listen("dc");
    const start = await call("dc", "POST", "/v1/providers/codex/connect", {});
    expect(start.body.connection).toMatchObject({
      status: "waiting",
      flow: "device_code",
      userCode: "ABCD-1234",
    });
    codexSignIn.confirm(keyOf("dc"));
    await s.until(
      (e) =>
        e.event === "provider.updated" &&
        e.data.provider.id === "codex" &&
        e.data.provider.status === "connected",
    );
    s.close();
  });

  test("API keys: format checked, a refused key is not kept, a good one is kept outside the home", async () => {
    expect(
      (
        await call("ak", "POST", "/v1/providers/openrouter/connect", {
          method: "api_key",
          apiKey: "short",
        })
      ).body.error,
    ).toBe("invalid_api_key_format");
    const bad = await call("ak", "POST", "/v1/providers/openrouter/connect", {
      method: "api_key",
      apiKey: "bad-0123456789abcdefghij",
    });
    expect(bad.body.connection).toMatchObject({
      status: "failed",
      error: { code: "invalid_api_key", params: { provider: "openrouter" } },
    });
    expect(store.apiKey(keyOf("ak"), "openrouter")).toBeNull();
    const good = await call("ak", "POST", "/v1/providers/openrouter/connect", {
      method: "api_key",
      apiKey: "good-0123456789abcdefghij",
    });
    expect(good.body.connection.status).toBe("connected");
    expect(store.apiKey(keyOf("ak"), "openrouter")).toBe(
      "good-0123456789abcdefghij",
    );
    expect(written.some((w) => w.content.includes("good-0123456789"))).toBe(
      false,
    );
    for (
      let i = 0;
      i < 50 && (await providerOf("ak", "openrouter")).status !== "connected";
      i++
    )
      await Bun.sleep(20);
    expect(await providerOf("ak", "openrouter")).toMatchObject({
      status: "connected",
      method: "api_key",
      account: { plan: "API key" },
    });
    expect(
      (
        await call("ak", "POST", "/v1/providers/codex/connect", {
          method: "api_key",
          apiKey: "good-0123456789abcdefghij",
        })
      ).status,
    ).toBe(400);
  });

  test("disconnect signs out, drops the key and restarts the agent", async () => {
    await connectClaude("dis");
    const r = await call("dis", "DELETE", "/v1/providers/claude");
    expect(r.body.provider.status).toBe("not_connected");
    expect(claudeSignIn.signedOut).toContain(keyOf("dis"));
    expect(claude.released).toContain(keyOf("dis"));
  });
});

describe("conversations and turns", () => {
  test("creating needs a connected account, an offered model and a valid effort", async () => {
    expect(
      (
        await call("cc", "POST", "/v1/conversations", {
          provider: "claude",
          model: "claude-code/opus",
        })
      ).body.error,
    ).toBe("signin_required");
    await connectClaude("cc");
    expect(
      (
        await call("cc", "POST", "/v1/conversations", {
          provider: "claude",
          model: "claude-code/imaginary",
        })
      ).body.error,
    ).toBe("model_unavailable");
    const e = await call("cc", "POST", "/v1/conversations", {
      provider: "claude",
      model: "claude-code/opus",
      effort: "max",
    });
    expect(e.body).toMatchObject({
      error: "invalid_effort",
      params: { efforts: ["low", "high"] },
    });
    const c = await newConversation("cc", "claude-code/opus");
    expect(c).toMatchObject({
      provider: "claude",
      model: "claude-code/opus",
      effort: "high",
      status: "idle",
      title: null,
    });
  });

  test("a turn: events in order, history from the store, hidden context never shown", async () => {
    await connectClaude("turn");
    const c = await newConversation("turn");
    const s = await listen("turn");
    const sent = await call(
      "turn",
      "POST",
      `/v1/conversations/${c.id}/messages`,
      { text: "Hi there\nsecond line", context: "Customer #42 is open" },
    );
    expect(sent.status).toBe(202);
    expect(sent.body.message).toMatchObject({
      role: "user",
      text: "Hi there\nsecond line",
    });
    await s.until(
      (e) =>
        e.event === "conversation.run" && e.data.run.status === "completed",
    );
    const kinds = s.events
      .filter((e) => e.event.startsWith("conversation."))
      .map((e) => e.event);
    expect(kinds.slice(0, 4)).toEqual([
      "conversation.message",
      "conversation.run",
      "conversation.message",
      "conversation.delta",
    ]);
    expect(claude.inputs.at(-1)!.text.startsWith(CONTEXT_OPEN)).toBe(true);
    expect(claude.inputs.at(-1)!.session).toBeNull();
    const m = await settled("turn", c.id);
    expect(m.messages.map((x: any) => [x.role, x.text])).toEqual([
      ["user", "Hi there\nsecond line"],
      ["assistant", "Hello"],
    ]);
    expect(m.messages[1].tools).toEqual([
      { id: "t1", name: "Bash", status: "completed" },
    ]);
    expect(m.runs).toEqual([
      { id: sent.body.message.runId, status: "completed", failure: null },
    ]);
    expect(m.context).toEqual({
      usedTokens: 1200,
      limitTokens: 200_000,
      approximate: false,
    });
    expect(m.usage).toEqual({
      input: 1200,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(m.conversation.title).toBe("Hi there");
    // The next turn resumes the vendor's own session.
    await call("turn", "POST", `/v1/conversations/${c.id}/messages`, {
      text: "again",
    });
    await settled("turn", c.id);
    expect(claude.inputs.at(-1)!.session).toBe("vendor-session-1");
    s.close();
  });

  test("questions: announced, answered once, validated", async () => {
    await connectClaude("ask");
    const c = await newConversation("ask");
    let answers: any;
    claude.script = async (_i, sink) => {
      answers = await sink.ask({
        kind: "permission",
        askedBy: "Claude Code",
        context: null,
        prompts: [
          {
            id: "p",
            header: "Bash",
            question: "Allow ls?",
            multiSelect: false,
            options: [
              { label: "Allow once", description: null },
              { label: "Deny", description: null },
            ],
          },
        ],
      });
      return { status: "completed" };
    };
    const s = await listen("ask");
    await call("ask", "POST", `/v1/conversations/${c.id}/messages`, {
      text: "list",
    });
    const q = (await s.until((e) => e.event === "conversation.question")).data
      .question;
    const m = await call("ask", "GET", `/v1/conversations/${c.id}/messages`);
    expect(m.body.conversation).toMatchObject({
      status: "waiting_for_answer",
      pendingQuestionId: q.id,
    });
    expect(m.body.question).toMatchObject({
      id: q.id,
      kind: "permission",
      askedBy: "Claude Code",
    });
    expect(
      (
        await call(
          "ask",
          "POST",
          `/v1/conversations/${c.id}/questions/${q.id}`,
          { answer: "Maybe" },
        )
      ).body.error,
    ).toBe("invalid_answer");
    const ok = await call(
      "ask",
      "POST",
      `/v1/conversations/${c.id}/questions/${q.id}`,
      { answer: "Allow once" },
    );
    expect(ok.body.question.status).toBe("answered");
    expect(
      (
        await call(
          "ask",
          "POST",
          `/v1/conversations/${c.id}/questions/${q.id}`,
          { answer: "Deny" },
        )
      ).body.error,
    ).toBe("question_not_pending");
    await settled("ask", c.id);
    expect(answers).toEqual({ p: ["Allow once"] });
    s.close();
  });

  test("abort ends the run as aborted; an unanswered question is cancelled", async () => {
    await connectClaude("ab");
    const c = await newConversation("ab");
    claude.script = (_i, sink, signal) =>
      new Promise((resolve) => {
        void sink.ask({
          kind: "question",
          askedBy: null,
          context: null,
          prompts: [
            {
              id: "p",
              header: null,
              question: "Which?",
              multiSelect: false,
              options: [],
            },
          ],
        });
        signal.addEventListener("abort", () => resolve({ status: "aborted" }));
      });
    const s = await listen("ab");
    await call("ab", "POST", `/v1/conversations/${c.id}/messages`, {
      text: "go",
    });
    await s.until((e) => e.event === "conversation.question");
    await call("ab", "POST", `/v1/conversations/${c.id}/abort`);
    await s.until(
      (e) =>
        e.event === "conversation.question" &&
        e.data.question.status === "cancelled",
    );
    const m = await settled("ab", c.id);
    expect(m.runs.at(-1)).toMatchObject({
      status: "aborted",
      failure: { code: "aborted" },
    });
    s.close();
  });

  test("a lost sign-in fails the run and marks the provider not connected", async () => {
    await connectClaude("lost");
    const c = await newConversation("lost");
    claude.script = async () => ({
      status: "failed",
      failure: fail.signinRequired("claude"),
    });
    await call("lost", "POST", `/v1/conversations/${c.id}/messages`, {
      text: "hi",
    });
    const m = await settled("lost", c.id);
    expect(m.messages.at(-1)).toMatchObject({
      role: "error",
      failure: { code: "signin_required", params: { provider: "claude" } },
    });
    expect(m.runs.at(-1).status).toBe("failed");
    expect((await providerOf("lost", "claude")).status).toBe("not_connected");
  });

  test("a message sent during a turn runs after it", async () => {
    await connectClaude("q");
    const c = await newConversation("q");
    const order: string[] = [];
    claude.script = async (input) => {
      order.push(`start ${input.text}`);
      await Bun.sleep(100);
      order.push(`end ${input.text}`);
      return { status: "completed" };
    };
    await call("q", "POST", `/v1/conversations/${c.id}/messages`, {
      text: "one",
    });
    await call("q", "POST", `/v1/conversations/${c.id}/messages`, {
      text: "two",
    });
    await Bun.sleep(50);
    await settled("q", c.id);
    for (let i = 0; i < 50 && order.length < 4; i++) await Bun.sleep(20);
    expect(order).toEqual(["start one", "end one", "start two", "end two"]);
  });

  test("list, search, page, rename, archive; one person never sees another's", async () => {
    await connectClaude("lst");
    const ids: string[] = [];
    for (const t of ["alpha report", "beta plan", "gamma notes"]) {
      const c = await newConversation("lst");
      await call("lst", "PATCH", `/v1/conversations/${c.id}`, { title: t });
      ids.push(c.id);
      await Bun.sleep(5);
    }
    const page1 = await call("lst", "GET", "/v1/conversations?limit=2");
    expect(page1.body.conversations).toHaveLength(2);
    const page2 = await call(
      "lst",
      "GET",
      `/v1/conversations?limit=2&cursor=${page1.body.nextCursor}`,
    );
    expect(page2.body.nextCursor).toBeNull();
    const all = [...page1.body.conversations, ...page2.body.conversations].map(
      (c: any) => c.id,
    );
    expect(new Set(all)).toEqual(new Set(ids));
    expect(
      (
        await call("lst", "GET", "/v1/conversations?query=BETA")
      ).body.conversations.map((c: any) => c.title),
    ).toEqual(["beta plan"]);
    expect(
      (await call("other", "GET", `/v1/conversations/${ids[0]}/messages`))
        .status,
    ).toBe(404);
    expect(
      (await call("lst", "PATCH", `/v1/conversations/${ids[0]}`, { title: "" }))
        .body.error,
    ).toBe("invalid_request");
    expect(
      (await call("lst", "DELETE", `/v1/conversations/${ids[0]}`)).status,
    ).toBe(204);
    expect(
      (await call("lst", "GET", `/v1/conversations/${ids[0]}/messages`)).status,
    ).toBe(404);
    expect(
      (
        await call("lst", "POST", `/v1/conversations/${ids[0]}/messages`, {
          text: "x",
        })
      ).status,
    ).toBe(404);
  });
});

describe("MCP servers and instructions", () => {
  test("registered servers reach the agent through the proxy, without the app's credential", async () => {
    await connectClaude("mcp");
    const put = await call("mcp", "PUT", "/v1/mcp-servers/crm", {
      url: "https://crm.example/api/v1/mcp",
      enabledTools: ["search"],
    });
    expect(put.status).toBe(201);
    expect(
      (
        await call("mcp", "PUT", "/v1/mcp-servers/evil", {
          url: "https://evil.example/mcp",
        })
      ).status,
    ).toBe(400);
    const c = await newConversation("mcp");
    await call("mcp", "POST", `/v1/conversations/${c.id}/messages`, {
      text: "hi",
      mcpAuth: { crm: "Bearer app-secret" },
    });
    await settled("mcp", c.id);
    const servers = claude.inputs.at(-1)!.mcpServers;
    expect(servers).toHaveLength(1);
    expect(servers[0]!.url).toBe(
      `http://127.0.0.1:8790/mcp/${keyOf("mcp")}/crm`,
    );
    expect(servers[0]!.enabledTools).toEqual(["search"]);
    expect(JSON.stringify(servers)).not.toContain("app-secret");
    expect(
      (await call("mcp", "GET", "/v1/mcp-servers")).body.servers[0],
    ).toMatchObject({ name: "crm", hasCredential: true });
    expect((await call("mcp", "DELETE", "/v1/mcp-servers/crm")).status).toBe(
      204,
    );
    expect((await call("mcp", "GET", "/v1/mcp-servers")).body.servers).toEqual(
      [],
    );
  });

  test("instructions are kept by the gateway and written into the workspace", async () => {
    expect((await call("ins", "GET", "/v1/instructions")).body.text).toBe("");
    await call("ins", "PUT", "/v1/instructions", { text: "Answer in Polish." });
    expect((await call("ins", "GET", "/v1/instructions")).body.text).toBe(
      "Answer in Polish.",
    );
    const files = written
      .filter((w) => w.key === keyOf("ins"))
      .map((w) => `${w.dir}/${w.name}`);
    expect(files).toEqual([
      "/home/agent/projects/chats/AGENTS.md",
      "/home/agent/projects/chats/CLAUDE.md",
    ]);
    await call("ins", "PUT", "/v1/instructions", { text: "" });
    expect(execs.at(-1)).toEqual([
      "rm",
      "-f",
      "/home/agent/projects/chats/AGENTS.md",
      "/home/agent/projects/chats/CLAUDE.md",
    ]);
  });
});
