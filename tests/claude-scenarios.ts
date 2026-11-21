// Claude Code scenarios against the scripted Anthropic API (scripts/mock-vendor/mock-anthropic.ts),
// shared by tests/claude-agent.test.ts (direct processes, any machine) and
// evidence/poc/claude-agent-vm.ts (real sandboxes on the VM). Each returns a line for the record.
import assert from "node:assert/strict";
import { ClaudeAgent } from "../src/agents/claude";
import type {
  Answers,
  Ask,
  ContextView,
  McpServer,
  Sandboxes,
  ToolView,
  TurnEnd,
  TurnInput,
  TurnSink,
  UsageView,
} from "../src/agents/types";
import type { mockAnthropic } from "../scripts/mock-vendor/mock-anthropic";
import { USAGE_RESET } from "../scripts/mock-vendor/mock-anthropic";
import type { StubRequest } from "../scripts/stub-mcp";

export type Harness = {
  sandboxes: Sandboxes;
  /** Every argv a sandbox was started with, when the harness records them. */
  spawnedArgs?: () => string[][];
  key: string;
  executable: string;
  /** The mock as Claude Code reaches it from inside a sandbox. */
  mockUrl: string;
  mock: ReturnType<typeof mockAnthropic>;
  /** The stub MCP server as Claude Code reaches it from inside a sandbox, and what it saw. */
  mcpUrl: string;
  mcpRequests: StubRequest[];
  /** Added to every Claude Code process (vendor settings the rootfs would otherwise hold). */
  env?: Record<string, string>;
};

export const API_KEY = "sk-ant-mock-0000000000000000000000";

export function agentFor(
  h: Harness,
  o: {
    apiKey?: string | null;
    env?: Record<string, string>;
    idleMs?: number;
  } = {},
) {
  const apiKey = o.apiKey === undefined ? API_KEY : o.apiKey;
  return new ClaudeAgent({
    sandboxes: h.sandboxes,
    apiKeys: { get: () => apiKey },
    executable: h.executable,
    idleMs: o.idleMs ?? 60_000,
    env: { ANTHROPIC_BASE_URL: h.mockUrl, ...h.env, ...o.env },
  });
}

/** A TurnSink that records everything and answers questions with `answer`. */
export function recorder(answer: (a: Ask) => Answers | null = () => null) {
  const r = {
    sessions: [] as string[],
    deltas: new Map<string, string>(),
    texts: new Map<string, string>(),
    tools: [] as { item: string; tool: ToolView }[],
    asks: [] as Ask[],
    contexts: [] as (ContextView | null)[],
    usages: [] as UsageView[],
  };
  const sink: TurnSink = {
    session: (id) => void r.sessions.push(id),
    delta: (item, s) => void r.deltas.set(item, (r.deltas.get(item) ?? "") + s),
    text: (item, s) => void r.texts.set(item, s),
    tool: (item, tool) => void r.tools.push({ item, tool }),
    ask: async (a) => {
      r.asks.push(a);
      return answer(a);
    },
    context: (c) => void r.contexts.push(c),
    usage: (u) => void r.usages.push(u),
  };
  return { r, sink, text: () => [...r.texts.values()].join("\n") };
}

let seq = 0;
export const input = (text: string, o: Partial<TurnInput> = {}): TurnInput => ({
  conversationId: `conv-${Date.now()}-${++seq}`,
  provider: "claude",
  model: "claude-code/default",
  effort: null,
  session: null,
  text,
  mcpServers: [],
  permissionMode: "workspace_write",
  ...o,
});

const never = () => new AbortController().signal;
const failure = (end: TurnEnd) =>
  end.status === "failed" ? end.failure : null;
const statuses = (r: ReturnType<typeof recorder>["r"], id?: string) =>
  r.tools.filter((t) => !id || t.tool.id === id).map((t) => t.tool.status);

export type Scenario = { name: string; run(h: Harness): Promise<string> };

export const scenarios: Scenario[] = [
  {
    name: "a turn with a shell tool call (full access: no question)",
    async run(h) {
      const agent = agentFor(h);
      const { r, sink, text } = recorder();
      const t0 = performance.now();
      const end = await agent.turn(
        h.key,
        input("RUN_TOOL please", { permissionMode: "full_access" }),
        sink,
        never(),
      );
      const ms = Math.round(performance.now() - t0);
      assert.deepEqual(end, { status: "completed" });
      assert.equal(r.asks.length, 0);
      assert.equal(r.sessions.length, 1);
      const bash = r.tools.filter((t) => t.tool.name === "Bash");
      assert.deepEqual(
        bash.map((t) => t.tool.status),
        ["running", "completed"],
      );
      assert.match(text(), /TOOL_RESULT_SEEN/);
      // Deltas stream only text, and the full text of each message replaces them.
      for (const [item, d] of r.deltas) assert.equal(r.texts.get(item), d);
      assert.ok(r.usages.at(-1)!.input > 0 && r.usages.at(-1)!.output > 0);
      const ctx = r.contexts.at(-1)!;
      assert.ok(ctx && ctx.usedTokens > 0 && ctx.limitTokens >= 100_000);
      assert.ok(agent.busy(h.key), "the process stays for the next turn");
      await agent.release(h.key);
      assert.equal(agent.busy(h.key), false);
      const out = text().replace(/\s+/g, " ").slice(0, 220);
      return `completed in ${ms} ms, Bash running→completed, context ${ctx.usedTokens}/${ctx.limitTokens}, usage ${JSON.stringify(r.usages.at(-1))}; ${out}`;
    },
  },
  {
    name: "permission asked → Allow once",
    async run(h) {
      const agent = agentFor(h);
      const { r, sink, text } = recorder((a) => ({
        [a.prompts[0]!.id]: ["Allow once"],
      }));
      const end = await agent.turn(
        h.key,
        input("RUN_TOOL please"),
        sink,
        never(),
      );
      await agent.release(h.key);
      assert.deepEqual(end, { status: "completed" });
      assert.equal(r.asks.length, 1);
      const ask = r.asks[0]!;
      assert.equal(ask.kind, "permission");
      assert.equal(ask.askedBy, "Claude Code");
      assert.equal(ask.prompts[0]!.header, "Bash");
      assert.match(ask.prompts[0]!.question, /^Allow running `id -u;.*`\?$/);
      assert.deepEqual(
        ask.prompts[0]!.options.map((o) => o.label),
        ["Allow once", "Deny"],
      );
      assert.deepEqual(statuses(r), ["running", "completed"]);
      assert.match(text(), /TOOL_RESULT_SEEN/);
      return `asked "${ask.prompts[0]!.question.slice(0, 40)}…" [${ask.prompts[0]!.options.map((o) => o.label).join(" / ")}], allowed → tool completed`;
    },
  },
  {
    name: "permission asked → Deny",
    async run(h) {
      const agent = agentFor(h);
      const { r, sink, text } = recorder((a) => ({
        [a.prompts[0]!.id]: ["Deny"],
      }));
      const end = await agent.turn(
        h.key,
        input("RUN_TOOL please"),
        sink,
        never(),
      );
      await agent.release(h.key);
      assert.deepEqual(end, { status: "completed" });
      assert.equal(r.asks.length, 1);
      assert.deepEqual(statuses(r), ["running", "failed"]);
      assert.match(text(), /TOOL_RESULT_SEEN .*denied/);
      return `denied → tool failed; Claude was told: ${text().replace(/\s+/g, " ").slice(17, 120)}`;
    },
  },
  {
    name: "AskUserQuestion answered",
    async run(h) {
      const agent = agentFor(h);
      const { r, sink, text } = recorder((a) => ({
        [a.prompts[0]!.id]: ["Blue"],
      }));
      const end = await agent.turn(
        h.key,
        input("ASK_QUESTION please"),
        sink,
        never(),
      );
      await agent.release(h.key);
      assert.deepEqual(end, { status: "completed" });
      assert.equal(r.asks.length, 1);
      const ask = r.asks[0]!;
      assert.equal(ask.kind, "question");
      assert.deepEqual(ask.prompts[0], {
        id: "q1",
        header: "Color",
        question: "Which color?",
        multiSelect: false,
        options: [
          { label: "Red", description: "Warm" },
          { label: "Blue", description: "Cool" },
        ],
      });
      assert.match(text(), /"Which color\?"="Blue"/);
      return `question "Which color?" [Red / Blue] → Blue; tool result: ${text().slice(17, 80)}`;
    },
  },
  {
    name: "abort mid-turn",
    async run(h) {
      const agent = agentFor(h);
      const { r, sink } = recorder();
      const ac = new AbortController();
      const turn = agent.turn(h.key, input("SLOW please"), sink, ac.signal);
      for (
        const until = Date.now() + 30_000;
        ![...r.deltas.values()].some((d) => d.includes("tick 2"));
      ) {
        assert.ok(Date.now() < until, "the slow reply never streamed");
        await Bun.sleep(50);
      }
      const t0 = performance.now();
      ac.abort();
      const end = await turn;
      const ms = Math.round(performance.now() - t0);
      assert.deepEqual(end, { status: "aborted" });
      assert.ok(ms < 8000, `abort took ${ms} ms`);
      // The process survives an interrupt and takes the next turn.
      const next = recorder();
      const again = await agent.turn(
        h.key,
        input("hello", {}),
        next.sink,
        never(),
      );
      await agent.release(h.key);
      assert.deepEqual(again, { status: "completed" });
      return `aborted ${ms} ms after the request (streamed "${[...r.deltas.values()].join("").trim().slice(0, 20)}…"); the next turn completed`;
    },
  },
  {
    name: "a second turn after release resumes the same session",
    async run(h) {
      const agent = agentFor(h);
      const first = recorder();
      const conv = input("REMEMBER mango");
      assert.deepEqual(await agent.turn(h.key, conv, first.sink, never()), {
        status: "completed",
      });
      const session = first.r.sessions[0]!;
      await agent.release(h.key);
      assert.equal(agent.busy(h.key), false);
      const before = h.mock.requests.length;
      const second = recorder();
      const end = await agent.turn(
        h.key,
        { ...conv, text: "RECALL it", session },
        second.sink,
        never(),
      );
      await agent.release(h.key);
      assert.deepEqual(end, { status: "completed" });
      assert.deepEqual(second.r.sessions, [session]);
      assert.match(second.text(), /RECALLED mango/);
      const sent = h.mock.requests
        .slice(before)
        .find((q) => q.scenario === "RECALL")!;
      assert.match(sent.text, /REMEMBER mango/);
      return `session ${session.slice(0, 8)}… resumed in a new process; the mock got ${sent.messages} messages incl. the first turn → "${second.text()}"`;
    },
  },
  {
    name: "MCP server through initialize (headers never on argv)",
    async run(h) {
      const agent = agentFor(h);
      const token = `Bearer valid-${crypto.randomUUID().slice(0, 8)}`;
      const server: McpServer = {
        name: "stub",
        url: h.mcpUrl,
        headers: { Authorization: token },
        enabledTools: ["lookup_customer"],
      };
      const { r, sink, text } = recorder();
      const end = await agent.turn(
        h.key,
        input("CALL_MCP please", { mcpServers: [server] }),
        sink,
        never(),
      );
      await agent.release(h.key);
      assert.deepEqual(end, { status: "completed" });
      const mcp = r.tools.filter(
        (t) => t.tool.name === "mcp__stub__lookup_customer",
      );
      assert.deepEqual(
        mcp.map((t) => t.tool.status),
        ["running", "completed"],
      );
      assert.equal(r.asks.length, 0, "an enabled tool runs without asking");
      assert.match(text(), /Wilhelmina Quarrington/);
      const calls = h.mcpRequests.filter(
        (q) => q.tool === "lookup_customer" && q.authorization === token,
      );
      assert.equal(calls.length, 1);
      if (h.spawnedArgs)
        for (const args of h.spawnedArgs())
          assert.ok(!args.join(" ").includes(token), "a header reached argv");
      return `mcp__stub__lookup_customer completed with the proxy token as its header; ${text().slice(17, 110)}`;
    },
  },
  {
    name: "signed out: no process to read, and a turn says signin_required",
    async run(h) {
      const agent = agentFor(h, { apiKey: null });
      const n = h.spawnedArgs?.().length ?? 0;
      const live = await agent.read(h.key, "claude");
      assert.deepEqual(live, { signedIn: false, account: null, models: [] });
      if (h.spawnedArgs)
        assert.equal(h.spawnedArgs().length, n, "read started a process");
      const { sink } = recorder();
      const end = await agent.turn(h.key, input("hello"), sink, never());
      await agent.release(h.key);
      assert.equal(failure(end)?.code, "signin_required");
      return `read → signed out without a process; turn → ${JSON.stringify(failure(end))}`;
    },
  },
  {
    name: "a refused key (401) → signin_required",
    async run(h) {
      const agent = agentFor(h, {
        apiKey: "sk-ant-refused-00000000000000000000",
      });
      const { sink } = recorder();
      const t0 = performance.now();
      const end = await agent.turn(
        h.key,
        input("AUTH_FAIL please"),
        sink,
        never(),
      );
      const ms = Math.round(performance.now() - t0);
      await agent.release(h.key);
      assert.deepEqual(failure(end), {
        code: "signin_required",
        message: failure(end)!.message,
        params: { provider: "claude" },
      });
      return `failed after ${ms} ms (Claude Code would retry for minutes): ${failure(end)!.code}`;
    },
  },
  {
    name: "a spent subscription window → usage_limit with resetsAt",
    async run(h) {
      // A subscription sign-in is what makes Claude Code read the unified rate-limit headers.
      const agent = agentFor(h, {
        apiKey: null,
        env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-mock" },
      });
      const { sink } = recorder();
      const end = await agent.turn(
        h.key,
        input("USAGE_LIMIT please"),
        sink,
        never(),
      );
      await agent.release(h.key);
      const f = failure(end);
      assert.equal(f?.code, "usage_limit");
      assert.deepEqual(f!.params, {
        provider: "claude",
        resetsAt: new Date(USAGE_RESET * 1000).toISOString(),
      });
      assert.match(f!.message, /limit/i);
      return `${JSON.stringify(f)}`;
    },
  },
  {
    name: "read: account and models from Claude Code",
    async run(h) {
      const agent = agentFor(h);
      const live = await agent.read(h.key, "claude");
      assert.equal(agent.busy(h.key), false, "read lets its process go");
      assert.equal(live.signedIn, true);
      assert.deepEqual(live.account, { email: null, plan: "API key" });
      const def = live.models.find((m) => m.id === "claude-code/default")!;
      assert.equal(def.default, true);
      assert.ok(def.name && def.name !== "Default (recommended)");
      assert.ok(
        live.models.some((m) => m.id === "claude-code/opus" && !m.default),
      );
      assert.ok(live.models.every((m) => m.efforts.length > 0));
      return `${JSON.stringify(live.account)}; ${live.models.map((m) => `${m.id}=${m.name}${m.default ? " (default)" : ""}`).join(", ")}`;
    },
  },
  {
    name: "verifyApiKey from a one-shot sandbox",
    async run(h) {
      const agent = agentFor(h, { apiKey: null });
      const ok = await agent.verifyApiKey(
        h.key,
        "claude",
        "sk-ant-good-0000000000000000000000",
      );
      const refused = await agent.verifyApiKey(
        h.key,
        "claude",
        "sk-ant-bad-00000000000000000000000",
      );
      const down = await new ClaudeAgent({
        sandboxes: h.sandboxes,
        apiKeys: { get: () => null },
        env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" },
      }).verifyApiKey(h.key, "claude", "sk-ant-good-0000000000000000000000");
      assert.deepEqual([ok, refused, down], ["ok", "refused", "unreachable"]);
      if (h.spawnedArgs)
        for (const args of h.spawnedArgs())
          assert.ok(
            !args.join(" ").includes("sk-ant-good"),
            "a key reached argv",
          );
      return `good → ${ok}, bad → ${refused}, no answer → ${down}`;
    },
  },
];
