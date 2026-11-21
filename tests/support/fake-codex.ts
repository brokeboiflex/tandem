// A deterministic stand-in for the `codex` CLI in unit tests.
//
//   fake-codex.ts app-server [-c …]   speaks app-server JSON-RPC on stdio; the person's text picks a
//                                     script (see SCRIPTS). Every message it receives, its argv and
//                                     its TANDEM_MCP_* / TZ environment are appended to
//                                     $FAKE_CODEX_LOG as JSON lines.
//   fake-codex.ts login --device-auth prints the CLI's device prompt; $FAKE_LOGIN picks the ending:
//                                     success (writes ~/.codex/auth.json, exit 0), nofile (exit 0
//                                     without it), fail, timeout, unavailable, hang;
//                                     $FAKE_LOGIN_EXPIRES the minutes it prints.
//   fake-codex.ts logout              removes ~/.codex/auth.json.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const [command, ...rest] = process.argv.slice(2);
const HOME = process.env.HOME!;
const LOG = process.env.FAKE_CODEX_LOG;
const log = (entry: unknown) =>
  LOG && appendFileSync(LOG, JSON.stringify(entry) + "\n");

if (command === "logout") {
  rmSync(join(HOME, ".codex/auth.json"), { force: true });
  process.exit(0);
}

if (command === "login") {
  const mode = process.env.FAKE_LOGIN ?? "success";
  log({ login: rest });
  if (mode === "unavailable") {
    console.error(
      "Error logging in with device code: device code request failed with status 503 Service Unavailable",
    );
    process.exit(1);
  }
  // The real prompt (codex-rs/login/src/device_code_auth.rs), colours included.
  console.log(
    "\nWelcome to Codex [v\x1b[90m0.160.1\x1b[0m]\n\x1b[90mOpenAI's command-line coding agent\x1b[0m\n" +
      "\nFollow these steps to sign in with ChatGPT using device code authorization:\n" +
      "\n1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n" +
      `\n2. Enter this one-time code \x1b[90m(expires in ${process.env.FAKE_LOGIN_EXPIRES ?? 15} minutes)\x1b[0m\n   \x1b[94mABCD-EFGH2\x1b[0m\n` +
      "\n\x1b[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.\x1b[0m\n",
  );
  await Bun.sleep(Number(process.env.FAKE_LOGIN_DELAY_MS ?? 200));
  if (mode === "hang") await new Promise(() => {});
  if (mode === "nofile") process.exit(0);
  if (mode === "success") {
    mkdirSync(join(HOME, ".codex"), { recursive: true });
    writeFileSync(join(HOME, ".codex/auth.json"), '{"tokens":{}}\n');
    console.error("Successfully logged in");
    process.exit(0);
  }
  console.error(
    mode === "timeout"
      ? "Error logging in with device code: device auth timed out after 15 minutes"
      : "Error logging in with device code: device auth failed with status 400 Bad Request",
  );
  process.exit(1);
}

if (command !== "app-server") {
  console.error(`fake-codex: unknown command ${command}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------
// app-server

log({
  argv: rest,
  env: Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => k.startsWith("TANDEM_MCP_") || k === "TZ",
    ),
  ),
  pid: process.pid,
});

const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
const note = (method: string, params: unknown) => send({ method, params });
let seq = 0;
const waiting = new Map<number, (m: any) => void>();
/** A request to the client; resolves with its whole answer. */
const ask = (method: string, params: unknown) =>
  new Promise<any>((resolve) => {
    const id = seq++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

// Threads survive a restart (as Codex's rollout files do): kept beside the log.
const STATE = join(HOME, ".codex-fake-threads.json");
const known = (): string[] =>
  existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : [];
const remember = (id: string) =>
  writeFileSync(STATE, JSON.stringify([...known(), id]));
let turns = 0;
let running: {
  threadId: string;
  turnId: string;
  interrupted: () => void;
} | null = null;

const usage = (n: number, window: number | null = 258_400) => ({
  total: {
    totalTokens: 1100 * n,
    inputTokens: 1000 * n,
    cachedInputTokens: 400 * n,
    cacheWriteInputTokens: 0,
    outputTokens: 100 * n,
    reasoningOutputTokens: 10 * n,
  },
  last: {
    totalTokens: 1100,
    inputTokens: 1000,
    cachedInputTokens: 400,
    cacheWriteInputTokens: 0,
    outputTokens: 100,
    reasoningOutputTokens: 10,
  },
  modelContextWindow: window,
});

type Ctx = { threadId: string; turnId: string };
const item = (c: Ctx, kind: "started" | "completed", it: unknown) =>
  note(`item/${kind}`, { threadId: c.threadId, turnId: c.turnId, item: it });
const message = (c: Ctx, id: string, text: string) => {
  item(c, "started", { type: "agentMessage", id, text: "" });
  for (const part of text.match(/.{1,3}/gs) ?? [])
    note("item/agentMessage/delta", {
      threadId: c.threadId,
      turnId: c.turnId,
      itemId: id,
      delta: part,
    });
  item(c, "completed", { type: "agentMessage", id, text });
};
const cmdItem = (id: string, cmd: string, status: string) => ({
  type: "commandExecution",
  id,
  command: `/bin/bash -lc '${cmd}'`,
  cwd: "/home/agent/projects/chats",
  status,
  commandActions: [{ type: "unknown", command: cmd }],
  aggregatedOutput: null,
  exitCode: status === "completed" ? 0 : null,
});
const done = (c: Ctx, status = "completed", error: unknown = null) =>
  note("turn/completed", {
    threadId: c.threadId,
    turn: { id: c.turnId, items: [], status, error },
  });

/** What a turn does, by a word in the person's text. */
const SCRIPTS: Record<string, (c: Ctx, text: string) => Promise<void>> = {
  async hello(c) {
    message(c, "m1", "Hello there");
    note("thread/tokenUsage/updated", {
      threadId: c.threadId,
      turnId: c.turnId,
      tokenUsage: usage(1),
    });
    done(c);
  },
  async tool(c) {
    message(c, "m1", "Looking.");
    item(c, "started", cmdItem("cmd1", "ls", "inProgress"));
    item(c, "completed", cmdItem("cmd1", "ls", "completed"));
    item(c, "started", {
      type: "mcpToolCall",
      id: "mcp1",
      server: "app",
      tool: "lookup",
      status: "inProgress",
      arguments: {},
    });
    item(c, "completed", {
      type: "mcpToolCall",
      id: "mcp1",
      server: "app",
      tool: "lookup",
      status: "failed",
      arguments: {},
      error: { message: "no" },
    });
    item(c, "started", {
      type: "reasoning",
      id: "r1",
      summary: [],
      content: [],
    });
    message(c, "m2", "Done.");
    done(c);
  },
  async approve(c) {
    item(c, "started", cmdItem("cmd1", "rm -f x", "inProgress"));
    const r = await ask("item/commandExecution/requestApproval", {
      kind: "command",
      threadId: c.threadId,
      turnId: c.turnId,
      itemId: "cmd1",
      startedAtMs: 0,
      command: "/bin/bash -lc 'rm -f x'",
      cwd: "/home/agent/projects/chats",
      reason: "It deletes a file.",
      commandActions: [{ type: "unknown", command: "rm -f x" }],
      availableDecisions: ["accept", "acceptForSession", "cancel"],
    });
    item(
      c,
      "completed",
      cmdItem(
        "cmd1",
        "rm -f x",
        r.result?.decision === "accept" ||
          r.result?.decision === "acceptForSession"
          ? "completed"
          : "declined",
      ),
    );
    message(c, "m1", `decision ${JSON.stringify(r.result?.decision)}`);
    done(c);
  },
  async patch(c) {
    item(c, "started", {
      type: "fileChange",
      id: "fc1",
      changes: [
        { path: "notes.md", kind: { type: "add" }, diff: "" },
        { path: "src/a.ts", kind: { type: "update" }, diff: "" },
      ],
      status: "inProgress",
    });
    const r = await ask("item/fileChange/requestApproval", {
      threadId: c.threadId,
      turnId: c.turnId,
      itemId: "fc1",
      startedAtMs: 0,
      reason: null,
    });
    item(c, "completed", {
      type: "fileChange",
      id: "fc1",
      changes: [],
      status: r.result?.decision === "decline" ? "declined" : "completed",
    });
    message(c, "m1", `decision ${JSON.stringify(r.result?.decision)}`);
    done(c);
  },
  async mcp(c) {
    item(c, "started", {
      type: "mcpToolCall",
      id: "mcp1",
      server: "app",
      tool: "send_invoice",
      status: "inProgress",
      arguments: { id: "inv-1" },
    });
    const approval = await ask("mcpServer/elicitation/request", {
      threadId: c.threadId,
      turnId: c.turnId,
      serverName: "app",
      mode: "form",
      _meta: {
        codex_approval_kind: "mcp_tool_call",
        persist: ["session", "always"],
        tool_params: { id: "inv-1" },
        tool_params_display: [
          { name: "id", value: "inv-1", display_name: "id" },
        ],
      },
      message: 'Allow the app MCP server to run tool "send_invoice"?',
      requestedSchema: { type: "object", properties: {} },
    });
    const confirm = await ask("mcpServer/elicitation/request", {
      threadId: c.threadId,
      turnId: c.turnId,
      serverName: "app",
      mode: "form",
      _meta: null,
      message: "Really send it?",
      requestedSchema: { type: "object", properties: {} },
    });
    const form = await ask("mcpServer/elicitation/request", {
      threadId: c.threadId,
      turnId: c.turnId,
      serverName: "app",
      mode: "form",
      _meta: null,
      message: "A few details",
      requestedSchema: {
        type: "object",
        properties: {
          copies: { type: "integer", title: "Copies" },
          channel: {
            type: "string",
            oneOf: [
              { const: "mail", title: "E-mail" },
              { const: "post", title: "Post" },
            ],
          },
          urgent: { type: "boolean" },
          note: { type: "string", description: "A note for the customer" },
        },
        required: ["channel"],
      },
    });
    const url = await ask("mcpServer/elicitation/request", {
      threadId: c.threadId,
      turnId: c.turnId,
      serverName: "app",
      mode: "url",
      _meta: null,
      message: "Sign in",
      url: "https://example.com",
      elicitationId: "e1",
    });
    item(c, "completed", {
      type: "mcpToolCall",
      id: "mcp1",
      server: "app",
      tool: "send_invoice",
      status: "completed",
      arguments: {},
      result: { content: [] },
    });
    message(
      c,
      "m1",
      JSON.stringify([
        approval.result,
        confirm.result,
        form.result,
        url.result,
      ]),
    );
    done(c);
  },
  async question(c) {
    const r = await ask("item/tool/requestUserInput", {
      threadId: c.threadId,
      turnId: c.turnId,
      itemId: "q1",
      isBlocking: true,
      autoResolutionMs: null,
      questions: [
        {
          id: "colour",
          header: "Colour",
          question: "Which colour?",
          isOther: true,
          isSecret: false,
          options: [
            { label: "Blue", description: "Calm." },
            { label: "Green", description: "Fresh." },
          ],
        },
      ],
    });
    const p = await ask("item/permissions/requestApproval", {
      threadId: c.threadId,
      turnId: c.turnId,
      itemId: "p1",
      environmentId: null,
      startedAtMs: 0,
      cwd: "/",
      reason: null,
      permissions: {},
    });
    message(c, "m1", JSON.stringify([r.result, p.result]));
    done(c);
  },
  async slow(c) {
    item(c, "started", cmdItem("cmd1", "sleep 60", "inProgress"));
    await new Promise<void>((resolve) => (running!.interrupted = resolve));
    item(c, "completed", cmdItem("cmd1", "sleep 60", "failed"));
    done(c, "interrupted");
  },
  async pending(c) {
    item(c, "started", cmdItem("cmd1", "rm -f y", "inProgress"));
    const answered = ask("item/commandExecution/requestApproval", {
      kind: "command",
      threadId: c.threadId,
      turnId: c.turnId,
      itemId: "cmd1",
      startedAtMs: 0,
      command: "rm -f y",
      availableDecisions: ["accept", "cancel"],
    });
    await new Promise<void>((resolve) => (running!.interrupted = resolve));
    done(c, "interrupted");
    log({ pendingAnswer: (await answered).result });
  },
  async subagent(c) {
    item(c, "started", {
      type: "collabAgentToolCall",
      id: "col1",
      tool: "spawnAgent",
      status: "inProgress",
      senderThreadId: c.threadId,
      receiverThreadIds: ["child-1"],
      agentsStates: {},
    });
    note("item/agentMessage/delta", {
      threadId: "child-1",
      turnId: "t-child",
      itemId: "cm1",
      delta: "child text",
    });
    const r = await ask("item/commandExecution/requestApproval", {
      kind: "command",
      threadId: "child-1",
      turnId: "t-child",
      itemId: "cc1",
      startedAtMs: 0,
      command: "rm -f z",
      availableDecisions: ["accept", "cancel"],
    });
    message(c, "m1", `child ${JSON.stringify(r.result?.decision)}`);
    done(c);
  },
  async context(c) {
    note("thread/tokenUsage/updated", {
      threadId: c.threadId,
      turnId: c.turnId,
      tokenUsage: usage(2),
    });
    item(c, "completed", { type: "contextCompaction", id: "cc" });
    note("thread/compacted", { threadId: c.threadId, turnId: c.turnId });
    note("thread/tokenUsage/updated", {
      threadId: c.threadId,
      turnId: c.turnId,
      tokenUsage: usage(3, null),
    });
    done(c);
  },
  async limits(c) {
    note("account/rateLimits/updated", {
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 100,
          windowDurationMins: 300,
          resetsAt: 1_893_456_000,
        },
        secondary: {
          usedPercent: 40,
          windowDurationMins: 10080,
          resetsAt: 1_893_999_000,
        },
      },
    });
    done(c, "failed", {
      message: "You’ve hit your usage limit. Try again at 4:05 PM.",
      codexErrorInfo: "usageLimitExceeded",
      additionalDetails: null,
    });
  },
  async fail(c, text) {
    done(c, "failed", JSON.parse(text.slice(text.indexOf("{"))));
  },
  async crash() {
    process.exit(3);
  },
};

const handlers: Record<string, (p: any) => unknown> = {
  initialize: () => ({
    userAgent: "fake/0.160.1",
    codexHome: join(HOME, ".codex"),
    platformFamily: "unix",
    platformOs: "linux",
  }),
  "account/read": () =>
    JSON.parse(
      process.env.FAKE_ACCOUNT ??
        '{"account":{"type":"chatgpt","email":"person@example.com","planType":"plus"},"requiresOpenaiAuth":true}',
    ),
  "model/list": (p) =>
    p?.cursor === "p2"
      ? {
          data: [
            {
              id: "gpt-b",
              model: "gpt-b",
              displayName: "GPT-B",
              hidden: false,
              supportedReasoningEfforts: [
                { reasoningEffort: "low" },
                { reasoningEffort: "high" },
              ],
              defaultReasoningEffort: "high",
              isDefault: false,
            },
          ],
          nextCursor: null,
        }
      : {
          data: [
            {
              id: "gpt-a",
              model: "gpt-a",
              displayName: "GPT-A",
              hidden: false,
              supportedReasoningEfforts: [
                { reasoningEffort: "low" },
                { reasoningEffort: "medium" },
              ],
              defaultReasoningEffort: "medium",
              isDefault: true,
            },
            {
              id: "secret",
              model: "secret",
              displayName: "Hidden",
              hidden: true,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: "low",
              isDefault: false,
            },
          ],
          nextCursor: "p2",
        },
  "thread/start": () => {
    const id = `thr-${process.pid}-${known().length + 1}`;
    remember(id);
    return { thread: { id, turns: [] }, model: "gpt-a" };
  },
  "thread/resume": (p) => {
    if (!known().includes(p.threadId))
      throw Object.assign(
        new Error(`no rollout found for thread id ${p.threadId}`),
        { code: -32600 },
      );
    return { thread: { id: p.threadId, turns: [] }, model: "gpt-a" };
  },
  "turn/start": (p) => {
    const c = { threadId: p.threadId, turnId: `turn-${++turns}` };
    const text: string = p.input?.[0]?.text ?? "";
    const script = SCRIPTS[text.split(/\s/)[0]!] ?? SCRIPTS.hello!;
    running = { ...c, interrupted: () => {} };
    setTimeout(async () => {
      note("turn/started", {
        threadId: c.threadId,
        turn: { id: c.turnId, items: [], status: "inProgress", error: null },
      });
      await script(c, text);
      running = null;
    }, 5);
    return {
      turn: { id: c.turnId, items: [], status: "inProgress", error: null },
    };
  },
  "turn/interrupt": (p) => {
    if (running && running.turnId === p.turnId) running.interrupted();
    return {};
  },
};

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  log({ in: m });
  if (m.method === undefined) {
    waiting.get(m.id)?.(m);
    waiting.delete(m.id);
    return;
  }
  if (m.id === undefined) return; // `initialized`
  const handler = handlers[m.method];
  if (!handler)
    return send({
      id: m.id,
      error: { code: -32601, message: `unknown ${m.method}` },
    });
  try {
    send({ id: m.id, result: await handler(m.params) });
  } catch (e: any) {
    send({ id: m.id, error: { code: e.code ?? -32603, message: e.message } });
  }
});
