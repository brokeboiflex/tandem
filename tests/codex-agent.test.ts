// CodexAgent against a fake `codex app-server` (tests/support/fake-codex.ts) through a Sandboxes
// that spawns directly, so these run anywhere. tests/codex-agent.integration.test.ts runs the real
// Codex against a scripted model API.
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALLOW_ALWAYS,
  ALLOW_ONCE,
  CODEX_SETTINGS,
  CodexAgent,
  DENY,
  approvalPolicy,
  autoCompactLimit,
  failureOf,
  mcpOverrides,
  resetFromText,
  tomlString,
} from "../src/agents/codex";
import type { McpServer, TurnInput } from "../src/agents/types";
import { DirectSandboxes } from "./support/direct-sandboxes";
import { RecordingSink, choose } from "./support/sink";

setDefaultTimeout(20_000);
const root = mkdtempSync(join(tmpdir(), "tandem-codex-"));
const LOG = join(root, "fake.log");
const FAKE = join(import.meta.dir, "support/fake-codex.ts");
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
let key = "";
let boxes: DirectSandboxes;
let agent: CodexAgent;
const make = (opts: ConstructorParameters<typeof CodexAgent>[1] = {}) => {
  key = `p${++n}`;
  boxes = new DirectSandboxes(
    root,
    { codex: [process.execPath, FAKE] },
    { FAKE_CODEX_LOG: LOG },
  );
  mkdirSync(join(boxes.homeOf(key), ".codex"), { recursive: true });
  writeFileSync(join(boxes.homeOf(key), ".codex/auth.json"), "{}");
  agent = new CodexAgent(boxes, { idleMs: 60_000, ...opts });
  made.push([agent, key]);
};
/** Every agent a test made, released after it so no fake app-server outlives its test. */
const made: [CodexAgent, string][] = [];
afterEach(async () => {
  for (const [a, k] of made.splice(0)) await a.release(k);
});
beforeEach(() => {
  rmSync(LOG, { force: true });
  make();
});

/** What the fake received, in order. */
const received = (): any[] =>
  readFileSync(LOG, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
const requests = (method: string) =>
  received()
    .filter((e) => e.in?.method === method)
    .map((e) => e.in.params);

const input = (text: string, over: Partial<TurnInput> = {}): TurnInput => ({
  conversationId: "c1",
  provider: "codex",
  model: "codex-cli/gpt-a",
  effort: null,
  session: null,
  text,
  mcpServers: [],
  permissionMode: "auto",
  ...over,
});
const run = async (
  text: string,
  sink = new RecordingSink(),
  over: Partial<TurnInput> = {},
  signal = new AbortController().signal,
) => ({
  sink,
  end: await agent.turn(key, input(text, over), sink, signal),
});

describe("a turn", () => {
  test("streams one message per turn, reports the thread, usage and context, and runs in Tandem's sandbox", async () => {
    const { sink, end } = await run("hello", undefined, {
      effort: "high",
      permissionMode: "full_access",
    });
    expect(end).toEqual({ status: "completed" });
    expect(sink.sessions).toHaveLength(1);
    const [item] = [...sink.texts.keys()];
    expect(sink.texts.get(item!)).toBe("Hello there");
    expect(sink.streamed(item!)).toBe("Hello there");
    expect(sink.usages.at(-1)).toEqual({
      input: 600,
      output: 100,
      cacheRead: 400,
      cacheWrite: 0,
    });
    expect(sink.contexts.at(-1)).toEqual({
      usedTokens: 1100,
      limitTokens: autoCompactLimit(258_400),
      approximate: false,
    });
    expect(autoCompactLimit(258_400)).toBe(244_800); // 90 % of the 272 000 window
    const [start] = requests("thread/start");
    expect(start).toMatchObject({
      cwd: "/home/agent/projects/chats",
      model: "gpt-a",
      approvalPolicy: "never",
    });
    const [turn] = requests("turn/start");
    expect(turn).toMatchObject({
      threadId: sink.sessions[0],
      model: "gpt-a",
      effort: "high",
      approvalPolicy: "never",
      sandboxPolicy: { type: "externalSandbox", networkAccess: "enabled" },
      cwd: "/home/agent/projects/chats",
    });
    // Tandem's settings on argv, as `-c` overrides; the app-server is the person's own process.
    const argv: string[] = received().find((e) => e.argv).argv;
    for (const c of CODEX_SETTINGS) expect(argv).toContain(c);
    // In the chat workspace, which the sandbox makes: Codex runs every command in the thread's cwd.
    expect(boxes.spawned[0]).toMatchObject({ key, label: "codex", cwd: "/home/agent/projects/chats" });
    expect(boxes.spawned[0]!.args.slice(0, 2)).toEqual(["codex", "app-server"]);
    expect(received().find((e) => e.env).env.TZ).toBe("UTC");
    const [init] = requests("initialize");
    expect(init.capabilities.optOutNotificationMethods).toContain(
      "item/reasoning/textDelta",
    );
  });

  test("several agent messages are one message; tools are reported by Codex's names; reasoning never", async () => {
    const { sink, end } = await run("tool");
    expect(end.status).toBe("completed");
    const items = new Set([
      ...sink.deltas.map(([i]) => i),
      ...sink.texts.keys(),
      ...sink.tools.map(([i]) => i),
    ]);
    expect(items.size).toBe(1);
    const [item] = items;
    expect(sink.texts.get(item!)).toBe("Looking.\n\nDone.");
    expect(sink.streamed(item!)).toBe("Looking.\n\nDone.");
    expect(sink.tools.map(([, t]) => t)).toEqual([
      { id: "cmd1", name: "exec_command", status: "running" },
      { id: "cmd1", name: "exec_command", status: "completed" },
      { id: "mcp1", name: "mcp__app__lookup", status: "running" },
      { id: "mcp1", name: "mcp__app__lookup", status: "failed" },
    ]);
  });

  test("the permission mode sets Codex's approval policy; never a sandbox Codex would build itself", () => {
    expect(approvalPolicy("read_only")).toBe("untrusted");
    expect(approvalPolicy("workspace_write")).toBe("on-request");
    expect(approvalPolicy("auto")).toBe("on-request");
    expect(approvalPolicy("full_access")).toBe("never");
  });
});

describe("questions", () => {
  test("a command approval is a permission question; each answer is Codex's decision", async () => {
    for (const [label, decision] of [
      [ALLOW_ONCE, "accept"],
      [ALLOW_ALWAYS, "acceptForSession"],
      [DENY, "decline"],
    ] as const) {
      const { sink, end } = await run(
        "approve",
        new RecordingSink(choose(label)),
      );
      expect(end.status).toBe("completed");
      expect(sink.asks[0]).toEqual({
        kind: "permission",
        askedBy: "Codex",
        context: "It deletes a file.",
        prompts: [
          {
            id: "permission",
            header: "exec_command",
            question: "Allow running `rm -f x`?",
            multiSelect: false,
            options: [
              { label: "Allow once", description: null },
              { label: "Allow always", description: null },
              { label: "Deny", description: null },
            ],
          },
        ],
      });
      expect(sink.allText()).toBe(`decision ${JSON.stringify(decision)}`);
      expect(sink.toolStatus().cmd1).toBe(
        decision === "decline" ? "failed" : "completed",
      );
    }
  });

  test("a file change names its files", async () => {
    const { sink } = await run(
      "patch",
      new RecordingSink(choose(ALLOW_ALWAYS)),
    );
    expect(sink.asks[0]!.prompts[0]).toMatchObject({
      header: "apply_patch",
      question: "Allow editing notes.md, src/a.ts?",
    });
    expect(sink.allText()).toBe('decision "acceptForSession"');
  });

  test("MCP: Codex's approval of a tool, the server's own confirmation and form, a link declined", async () => {
    const sink = new RecordingSink((ask) => {
      if (ask.kind === "permission")
        return choose(
          ask.prompts[0]!.header === "mcp__app__send_invoice" &&
            ask.askedBy === "Codex"
            ? ALLOW_ALWAYS
            : ALLOW_ONCE,
        )(ask);
      return {
        copies: ["3"],
        channel: ["Post"],
        urgent: ["Yes"],
        note: ["Thanks!"],
      };
    });
    const { end } = await run("mcp", sink);
    expect(end.status).toBe("completed");
    expect(sink.asks).toHaveLength(3); // the link is declined without asking
    expect(sink.asks[0]).toMatchObject({
      kind: "permission",
      askedBy: "Codex",
      context: "id: inv-1",
      prompts: [
        {
          header: "mcp__app__send_invoice",
          question: 'Allow the app MCP server to run tool "send_invoice"?',
        },
      ],
    });
    expect(sink.asks[0]!.prompts[0]!.options.map((o) => o.label)).toEqual([
      ALLOW_ONCE,
      ALLOW_ALWAYS,
      DENY,
    ]);
    expect(sink.asks[1]).toMatchObject({
      kind: "permission",
      askedBy: "app",
      prompts: [
        { header: "mcp__app__send_invoice", question: "Really send it?" },
      ],
    });
    expect(sink.asks[1]!.prompts[0]!.options.map((o) => o.label)).toEqual([
      ALLOW_ONCE,
      DENY,
    ]);
    expect(sink.asks[2]).toMatchObject({
      kind: "question",
      askedBy: "app",
      context: "A few details",
    });
    expect(
      sink.asks[2]!.prompts.map((p) => [
        p.id,
        p.header,
        p.options.map((o) => o.label),
      ]),
    ).toEqual([
      ["copies", "Copies", []],
      ["channel", "channel", ["E-mail", "Post"]],
      ["urgent", "urgent", ["Yes", "No"]],
      ["note", "note", []],
    ]);
    expect(JSON.parse(sink.allText())).toEqual([
      { action: "accept", content: {}, _meta: { persist: "session" } },
      { action: "accept", content: {}, _meta: null },
      {
        action: "accept",
        content: { copies: 3, channel: "post", urgent: true, note: "Thanks!" },
        _meta: null,
      },
      { action: "decline", content: null, _meta: null },
    ]);
  });

  test("Codex's request_user_input is a question; more sandbox access is never granted", async () => {
    const { sink } = await run(
      "question",
      new RecordingSink(() => ({ colour: ["Green"] })),
    );
    expect(sink.asks[0]).toEqual({
      kind: "question",
      askedBy: "Codex",
      context: null,
      prompts: [
        {
          id: "colour",
          header: "Colour",
          question: "Which colour?",
          multiSelect: false,
          options: [
            { label: "Blue", description: "Calm." },
            { label: "Green", description: "Fresh." },
          ],
        },
      ],
    });
    expect(JSON.parse(sink.allText())).toEqual([
      { answers: { colour: { answers: ["Green"] } } },
      { permissions: {}, scope: "turn" },
    ]);
  });

  test("a sub-agent's question reaches the turn that started it; its own text does not", async () => {
    const { sink } = await run(
      "subagent",
      new RecordingSink(choose(ALLOW_ONCE)),
    );
    expect(sink.asks).toHaveLength(1);
    expect(sink.allText()).toBe('child "accept"');
    expect(sink.deltas.some(([, d]) => d.includes("child text"))).toBe(false);
  });

  test("a question left unanswered when the turn ends is cancelled", async () => {
    const ac = new AbortController();
    const sink = new RecordingSink(() => {
      setTimeout(() => ac.abort(), 20);
      return new Promise(() => {}); // the person never answers
    });
    const { end } = await run("pending", sink, {}, ac.signal);
    expect(end).toEqual({ status: "aborted" });
    for (let i = 0; i < 50 && !received().some((e) => e.pendingAnswer); i++)
      await Bun.sleep(20);
    expect(received().find((e) => e.pendingAnswer).pendingAnswer).toEqual({
      decision: "cancel",
    });
  });
});

describe("abort, failures, resume, MCP, lifetime", () => {
  test("abort interrupts the turn", async () => {
    const ac = new AbortController();
    const sink = new RecordingSink();
    sink.onTool = (t) => t.status === "running" && ac.abort();
    const { end } = await run("slow", sink, {}, ac.signal);
    expect(end).toEqual({ status: "aborted" });
    expect(requests("turn/interrupt")).toEqual([
      { threadId: sink.sessions[0], turnId: expect.any(String) },
    ]);
    // Codex keeps an interrupted command running as a background terminal: it is ended too.
    for (let i = 0; i < 50 && !requests("thread/backgroundTerminals/clean").length; i++)
      await Bun.sleep(20);
    expect(requests("thread/backgroundTerminals/clean")).toEqual([
      { threadId: sink.sessions[0] },
    ]);
    expect(requests("initialize")[0].capabilities.experimentalApi).toBe(true);
    // An already aborted signal starts nothing.
    expect(
      await agent.turn(
        key,
        input("hello"),
        new RecordingSink(),
        AbortSignal.abort(),
      ),
    ).toEqual({ status: "aborted" });
  });

  test("Codex's errors become failures in the façade's terms", async () => {
    const failed = async (error: unknown) => {
      const { end } = await run(`fail ${JSON.stringify(error)}`);
      return end.status === "failed" ? end.failure : null;
    };
    expect(
      (await failed({ message: "x", codexErrorInfo: "unauthorized" }))?.code,
    ).toBe("signin_required");
    expect(
      await failed({
        message: "unexpected status 401 Unauthorized",
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
      }),
    ).toEqual({
      code: "signin_required",
      message: expect.any(String),
      params: { provider: "codex" },
    });
    expect(
      await failed({
        message: "Codex ran out of room",
        codexErrorInfo: "contextWindowExceeded",
      }),
    ).toMatchObject({
      code: "context_too_long",
      params: { model: "codex-cli/gpt-a" },
    });
    expect(
      await failed({
        message: "Selected model is at capacity. Please try a different model.",
        codexErrorInfo: "serverOverloaded",
      }),
    ).toMatchObject({
      code: "provider_unavailable",
      message: "Selected model is at capacity. Please try a different model.",
    });
    expect(
      (await failed({ message: "x", codexErrorInfo: "rateLimitExceeded" }))
        ?.code,
    ).toBe("rate_limited");
    expect(
      (
        await failed({
          message: "stream error",
          codexErrorInfo: {
            responseStreamDisconnected: { httpStatusCode: null },
          },
        })
      )?.code,
    ).toBe("network");
    expect(
      (
        await failed({
          message: "x",
          codexErrorInfo: {
            responseTooManyFailedAttempts: { httpStatusCode: 502 },
          },
        })
      )?.code,
    ).toBe("provider_unavailable");
    expect(
      (
        await failed({
          message: "fetch failed: ECONNREFUSED",
          codexErrorInfo: null,
        })
      )?.code,
    ).toBe("network");
    expect(
      await failed({ message: "something odd", codexErrorInfo: "other" }),
    ).toMatchObject({ code: "failed", params: {} });
    // A usage limit: the reset time from the exhausted rate-limit window, Codex's text kept.
    const { end } = await run("limits");
    expect(end).toEqual({
      status: "failed",
      failure: {
        code: "usage_limit",
        message: "You’ve hit your usage limit. Try again at 4:05 PM.",
        params: { provider: "codex", resetsAt: "2030-01-01T00:00:00.000Z" },
      },
    });
    // Without a rate-limit window, from Codex's text (written in UTC: it runs with TZ=UTC).
    expect(
      failureOf(
        {
          message:
            "You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jan 1st, 2030 1:00 AM.",
          codexErrorInfo: "usageLimitExceeded",
        },
        null,
      ).params,
    ).toEqual({ provider: "codex", resetsAt: "2030-01-01T01:00:00.000Z" });
    const now = Date.UTC(2026, 10, 21, 18, 0);
    expect(resetFromText("Try again at 4:05 PM.", now)?.toISOString()).toBe(
      "2026-11-22T16:05:00.000Z",
    );
    expect(resetFromText("Try again at 11:30 PM.", now)?.toISOString()).toBe(
      "2026-11-21T23:30:00.000Z",
    );
    expect(
      failureOf(
        {
          message: "You’ve hit your usage limit. Try again later.",
          codexErrorInfo: "usageLimitExceeded",
        },
        null,
      ).params,
    ).toEqual({ provider: "codex", resetsAt: null });
  });

  test("an app-server that dies mid-turn fails the turn and is started again for the next", async () => {
    const { end } = await run("crash");
    expect(end).toEqual({
      status: "failed",
      failure: expect.objectContaining({ code: "failed" }),
    });
    expect(agent.busy(key)).toBe(false);
    expect((await run("hello")).end.status).toBe("completed");
    expect(boxes.spawned).toHaveLength(2);
  });

  test("a later turn resumes the conversation's thread, also after release; a lost thread starts anew", async () => {
    const first = await run("hello");
    const session = first.sink.sessions[0]!;
    // Same process: the thread is still loaded.
    const second = await run("hello", undefined, { session });
    expect(second.sink.sessions).toEqual([session]);
    expect(requests("thread/resume")).toHaveLength(0);
    await agent.release(key);
    expect(agent.busy(key)).toBe(false);
    const third = await run("hello", undefined, { session });
    expect(third.end.status).toBe("completed");
    expect(third.sink.sessions).toEqual([session]);
    expect(requests("thread/resume")).toEqual([
      {
        threadId: session,
        cwd: "/home/agent/projects/chats",
        approvalPolicy: "on-request",
        excludeTurns: true,
      },
    ]);
    expect(boxes.spawned).toHaveLength(2);
    const lost = await run("hello", undefined, { session: "thr-gone" });
    expect(lost.end.status).toBe("completed");
    expect(lost.sink.sessions[0]).not.toBe("thr-gone");
  });

  test("MCP servers are -c overrides with tokens in the environment only; a changed set restarts the app-server", async () => {
    const servers: McpServer[] = [
      {
        name: "app",
        url: "http://127.0.0.1:8790/mcp/k/app",
        headers: { Authorization: "Bearer proxy-secret-1" },
        enabledTools: ["lookup", "send_invoice"],
      },
      {
        name: "docs",
        url: "http://127.0.0.1:8790/mcp/k/docs",
        headers: {
          authorization: "Bearer proxy-secret-1",
          "X-Extra": "extra-secret",
        },
        enabledTools: null,
      },
    ];
    await run("hello", undefined, { mcpServers: servers });
    const spawned = received().find((e) => e.argv);
    const argv: string[] = spawned.argv;
    expect(argv).toContain(
      'mcp_servers.app.url="http://127.0.0.1:8790/mcp/k/app"',
    );
    expect(argv).toContain(
      'mcp_servers.app.bearer_token_env_var="TANDEM_MCP_APP_TOKEN"',
    );
    expect(argv).toContain(
      'mcp_servers.app.enabled_tools=["lookup", "send_invoice"]',
    );
    expect(argv).toContain(
      'mcp_servers.docs.env_http_headers={ "X-Extra" = "TANDEM_MCP_DOCS_H1" }',
    );
    expect(argv.join(" ")).not.toContain("secret");
    expect(spawned.env).toMatchObject({
      TANDEM_MCP_APP_TOKEN: "proxy-secret-1",
      TANDEM_MCP_DOCS_TOKEN: "proxy-secret-1",
      TANDEM_MCP_DOCS_H1: "extra-secret",
    });
    // Same set: same process. A different set: a new one.
    await run("hello", undefined, { mcpServers: servers });
    expect(boxes.spawned).toHaveLength(1);
    await run("hello", undefined, { mcpServers: servers.slice(0, 1) });
    expect(boxes.spawned).toHaveLength(2);
    expect(
      boxes.spawned[0]!.child.exitCode !== null ||
        boxes.spawned[0]!.child.signalCode !== null,
    ).toBe(true);
    // A read reuses the running process.
    await agent.read(key, "codex");
    expect(boxes.spawned).toHaveLength(2);
    expect(tomlString('a"b\\c\u007f')).toBe('"a\\"b\\\\c\\u007f"');
    expect(
      mcpOverrides([
        { name: "Bad-Name", url: "x", headers: {}, enabledTools: null },
      ]).args,
    ).toEqual([]);
  });

  test("the app-server stops after idleMs without turns, and on release", async () => {
    make({ idleMs: 150 });
    await run("hello");
    expect(agent.busy(key)).toBe(true);
    await Bun.sleep(400);
    expect(agent.busy(key)).toBe(false);
    await run("hello");
    expect(agent.busy(key)).toBe(true);
    await agent.release(key);
    expect(agent.busy(key)).toBe(false);
  });
});

describe("read", () => {
  test("account and models from Codex; signed out without starting anything when no sign-in file", async () => {
    expect(await agent.read(key, "codex")).toEqual({
      signedIn: true,
      account: { email: "person@example.com", plan: "Plus" },
      models: [
        {
          id: "codex-cli/gpt-a",
          name: "GPT-A",
          efforts: ["low", "medium"],
          defaultEffort: "medium",
          contextLimit: null,
        },
        {
          id: "codex-cli/gpt-b",
          name: "GPT-B",
          efforts: ["low", "high"],
          defaultEffort: "high",
          contextLimit: null,
        },
      ],
    });
    // A turn measured gpt-a's limit: later reads report it.
    await run("hello");
    expect((await agent.read(key, "codex")).models[0]!.contextLimit).toBe(
      244_800,
    );
    make();
    rmSync(join(boxes.homeOf(key), ".codex/auth.json"));
    expect(await agent.read(key, "codex")).toEqual({
      signedIn: false,
      account: null,
      models: [],
    });
    expect(boxes.spawned).toHaveLength(0);
    // A symlink is not a sign-in file (the home is the person's; it could point anywhere).
    const { symlinkSync } = await import("node:fs");
    symlinkSync("/etc/hosts", join(boxes.homeOf(key), ".codex/auth.json"));
    expect((await agent.read(key, "codex")).signedIn).toBe(false);
  });

  test("Codex saying signed out is signed out", async () => {
    make();
    boxes = new DirectSandboxes(
      root,
      { codex: [process.execPath, FAKE] },
      {
        FAKE_CODEX_LOG: LOG,
        FAKE_ACCOUNT: '{"account":null,"requiresOpenaiAuth":true}',
      },
    );
    mkdirSync(join(boxes.homeOf(key), ".codex"), { recursive: true });
    agent = new CodexAgent(boxes);
    expect(await agent.read(key, "codex")).toEqual({
      signedIn: false,
      account: null,
      models: [],
    });
    await agent.release(key);
  });
});
