// The ACP client (src/agents/acp.ts) and its three vendors against tests/fake-acp.ts, through a
// `Sandboxes` that runs the programs directly: `agy`, `grok` and `goose` on PATH are the fake.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { AcpAgent } from "../src/agents/acp";
import {
  geminiAgent,
  grokAgent,
  openrouterAgent,
  OPENROUTER_MODELS,
  type VendorOptions,
} from "../src/agents/acp-vendors";
import type {
  Answers,
  McpServer,
  Ask,
  ContextView,
  Sandboxes,
  SandboxSpawnOptions,
  ToolView,
  TurnInput,
  TurnSink,
  UsageView,
} from "../src/agents/types";
import { GrokSignIn, parseDeviceAuth } from "../src/signin/grok";

const ROOT = mkdtempSync(`${tmpdir()}/tandem-acp-`);
const BIN = `${ROOT}/bin`;
mkdirSync(BIN);
for (const p of ["agy", "grok", "goose"]) {
  writeFileSync(
    `${BIN}/${p}`,
    `#!/bin/sh\nexec "${process.execPath}" "${import.meta.dir}/fake-acp.ts" ${p} "$@"\n`,
  );
  chmodSync(`${BIN}/${p}`, 0o755);
}
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/** Runs each program as a plain child process with the person's home as HOME. */
class LocalSandboxes implements Sandboxes {
  spawned: {
    key: string;
    args: string[];
    env: Record<string, string>;
    label?: string;
  }[] = [];
  homeOf(key: string) {
    const home = `${ROOT}/homes/${key}`;
    mkdirSync(`${home}/projects/chats`, { recursive: true });
    return home;
  }
  #env(key: string, env: Record<string, string> = {}) {
    return {
      PATH: `${BIN}:${process.env.PATH}`,
      HOME: this.homeOf(key),
      TMPDIR: tmpdir(),
      ...env,
    };
  }
  #cwd(key: string, cwd?: string) {
    return (cwd ?? "/home/agent").replace(/^\/home\/agent/, this.homeOf(key));
  }
  async spawn(
    key: string,
    args: string[],
    opts: SandboxSpawnOptions = {},
  ): Promise<ChildProcess> {
    this.spawned.push({ key, args, env: opts.env ?? {}, label: opts.label });
    return spawn(args[0]!, args.slice(1), {
      cwd: this.#cwd(key, opts.cwd),
      env: this.#env(key, opts.env),
      stdio: "pipe",
    });
  }
  async exec(
    key: string,
    args: string[],
    opts: { env?: Record<string, string>; stdin?: Buffer; cwd?: string } = {},
  ) {
    this.spawned.push({ key, args, env: opts.env ?? {}, label: "exec" });
    const child = spawn(args[0]!, args.slice(1), {
      cwd: this.#cwd(key, opts.cwd),
      env: this.#env(key, opts.env),
      stdio: "pipe",
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end(opts.stdin ?? Buffer.alloc(0));
    const exitCode = await new Promise<number>((r) =>
      child.once("exit", (c) => r(c ?? 1)),
    );
    return { exitCode, stdout, stderr };
  }
}

let n = 0;
let sb: LocalSandboxes;
let keys: Record<
  string,
  Partial<Record<"gemini" | "openrouter" | "claude", string>>
>;
const opts = (over: Partial<VendorOptions> = {}): VendorOptions => ({
  sandboxes: sb,
  apiKeys: { get: (key, provider) => keys[key]?.[provider] ?? null },
  idleMs: 60_000,
  fetch: (async () =>
    Response.json({
      data: OPENROUTER_MODELS.map((id, i) => ({
        id,
        name: `Name of ${id}`,
        context_length: 100_000 + i,
        supported_parameters: i === 4 ? ["tools"] : ["tools", "reasoning"],
      })),
    })) as unknown as typeof fetch,
  ...over,
});
/** A fresh person per test, with every credential. */
function person() {
  const key = `p${++n}${Date.now() % 1000}`;
  keys[key] = {
    gemini: "AIzaTestKeyForGemini00000",
    openrouter: "sk-or-test-key-000000000",
  };
  const home = sb.homeOf(key);
  mkdirSync(`${home}/.grok`, { recursive: true });
  writeFileSync(`${home}/.grok/auth.json`, "{}");
  return key;
}
const logOf = (key: string) =>
  existsSync(`${sb.homeOf(key)}/.fake-acp/log.jsonl`)
    ? readFileSync(`${sb.homeOf(key)}/.fake-acp/log.jsonl`, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : [];
const calls = (key: string, method: string) =>
  logOf(key).filter((e) => e.method === method);

type Recorded = {
  sink: TurnSink;
  sessions: string[];
  text: Map<string, string>;
  tools: Map<string, { item: string; view: ToolView }[]>;
  asks: Ask[];
  contexts: (ContextView | null)[];
  usages: UsageView[];
};
function recorder(
  answer: (ask: Ask) => Answers | null | Promise<Answers | null> = () => null,
): Recorded {
  const r: Recorded = {
    sessions: [],
    text: new Map(),
    tools: new Map(),
    asks: [],
    contexts: [],
    usages: [],
    sink: null as any,
  };
  r.sink = {
    session: (id) => r.sessions.push(id),
    delta: (item, append) =>
      r.text.set(item, (r.text.get(item) ?? "") + append),
    text: (item, text) => r.text.set(item, text),
    tool: (item, view) => {
      const list = r.tools.get(view.id) ?? [];
      list.push({ item, view });
      r.tools.set(view.id, list);
    },
    ask: async (ask) => {
      r.asks.push(ask);
      return answer(ask);
    },
    context: (c) => r.contexts.push(c),
    usage: (u) => r.usages.push(u),
  };
  return r;
}
const input = (
  over: Partial<TurnInput> & Pick<TurnInput, "provider" | "model">,
): TurnInput => ({
  conversationId: "c1",
  effort: null,
  session: null,
  text: "hello",
  mcpServers: [],
  permissionMode: "auto",
  ...over,
});
const never = () => new AbortController().signal;

beforeEach(() => {
  sb = new LocalSandboxes();
  keys = {};
});

describe("read", () => {
  test("signed out without a key or sign-in: nothing starts", async () => {
    const key = "nobody";
    for (const agent of [
      geminiAgent(opts()),
      grokAgent(opts()),
      openrouterAgent(opts()),
    ])
      expect(await agent.read(key, agent.vendor.provider)).toEqual({
        signedIn: false,
        account: null,
        models: [],
      });
    expect(sb.spawned).toEqual([]);
  });

  test("Gemini: agy's models per effort become one model with efforts; key in env only", async () => {
    const key = person();
    const agent = geminiAgent(opts());
    const live = await agent.read(key, "gemini");
    expect(live.signedIn).toBe(true);
    expect(live.account).toEqual({ email: null, plan: "API key" });
    expect(live.models).toEqual([
      {
        id: "antigravity/gemini-4-carbon",
        name: "Gemini 4 Carbon",
        efforts: ["low", "medium", "high"],
        defaultEffort: "medium",
        contextLimit: null,
      },
      {
        id: "antigravity/gemini-4-hydrogen",
        name: "Gemini 4 Hydrogen",
        efforts: ["low", "medium", "high", "xhigh"],
        defaultEffort: "medium",
        contextLimit: null,
      },
      {
        id: "antigravity/gemini-3.1-pro",
        name: "Gemini 3.1 Pro",
        efforts: ["low", "high"],
        defaultEffort: "low",
        contextLimit: null,
      },
    ]);
    const s = sb.spawned[0]!;
    expect(s.env.GEMINI_API_KEY).toBe(keys[key]!.gemini!);
    expect(s.args.join(" ")).not.toContain(keys[key]!.gemini!);
    expect(s.args.join(" ")).toContain("agy acp --disable-telemetry");
    // agy's own settings, written by the person's process before agy starts.
    expect(
      JSON.parse(
        readFileSync(
          `${sb.homeOf(key)}/.gemini/antigravity-cli/settings.json`,
          "utf8",
        ),
      ),
    ).toEqual({ modelProvider: "gemini" });
    // The throwaway session is closed again; the process stays for the next turn.
    expect(calls(key, "session/close").length).toBe(1);
    expect(agent.busy(key)).toBe(true);
    await agent.release(key);
    expect(agent.busy(key)).toBe(false);
  });

  test("Grok: models, efforts and context from its model state; account from its subscription", async () => {
    const key = person();
    const agent = grokAgent(opts());
    const live = await agent.read(key, "grok");
    expect(live).toEqual({
      signedIn: true,
      account: { email: "person@example.invalid", plan: "SuperGrok" },
      models: [
        {
          id: "xai/grok-4.6",
          name: "Grok 4.6",
          efforts: ["xhigh", "high", "medium", "low"],
          defaultEffort: "high",
          contextLimit: 500000,
        },
        {
          id: "xai/grok-build",
          name: "Grok Build",
          efforts: [],
          defaultEffort: null,
          contextLimit: 256000,
        },
      ],
    });
    expect(sb.spawned[0]!.args).toEqual([
      "grok",
      "agent",
      "--no-leader",
      "stdio",
    ]);
    expect(sb.spawned[0]!.env).toMatchObject({
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      GROK_MANAGED_CONFIG: "0",
      GROK_MEMTRACE: "0",
      GROK_DISABLE_AUTOUPDATER: "1",
    });
    await agent.release(key);
  });

  test("Grok without its sign-in file reads signed out", async () => {
    const key = person();
    rmSync(`${sb.homeOf(key)}/.grok/auth.json`);
    expect((await grokAgent(opts()).read(key, "grok")).signedIn).toBe(false);
    expect(sb.spawned).toEqual([]);
  });

  test("OpenRouter: Tandem's list with OpenRouter's names, without starting goose", async () => {
    const key = person();
    const live = await openrouterAgent(opts()).read(key, "openrouter");
    expect(sb.spawned).toEqual([]);
    expect(live.account).toEqual({ email: null, plan: "API key" });
    expect(live.models.map((m) => m.id)).toEqual(OPENROUTER_MODELS);
    expect(live.models[0]).toEqual({
      id: OPENROUTER_MODELS[0]!,
      name: `Name of ${OPENROUTER_MODELS[0]}`,
      efforts: ["off", "low", "medium", "high", "max"],
      defaultEffort: "medium",
      contextLimit: 100000,
    });
    expect(live.models[4]).toMatchObject({ efforts: [], defaultEffort: null });
  });

  test("OpenRouter unreachable: the list without names", async () => {
    const key = person();
    const live = await openrouterAgent(
      opts({
        fetch: (async () => {
          throw new Error("offline");
        }) as any,
      }),
    ).read(key, "openrouter");
    expect(live.models.map((m) => [m.id, m.name])).toEqual(
      OPENROUTER_MODELS.map((id) => [id, null]),
    );
  });
});

describe("turns", () => {
  test("a tool turn: text, the tool on its message, a permission allowed once, usage and context", async () => {
    const key = person();
    const agent = geminiAgent(opts());
    const rec = recorder(() => ({ permission: ["Allow once"] }));
    const end = await agent.turn(
      key,
      input({
        provider: "gemini",
        model: "antigravity/gemini-4-carbon",
        text: "TOOL please",
        usage: { input: 500, output: 10, cacheRead: 0, cacheWrite: 0 },
      }),
      rec.sink,
      never(),
    );
    expect(end).toEqual({ status: "completed" });
    expect(rec.sessions.length).toBe(1);
    const items = [...rec.text.entries()];
    expect(items.map(([, t]) => t)).toEqual(["Let me run it.", "ran it: hi"]);
    const tool = rec.tools.get("call_1")!;
    expect(tool[0]!.item).toBe(items[0]![0]);
    expect(tool.map((t) => t.view.status)).toEqual([
      "running",
      "running",
      "completed",
    ]);
    expect(tool[0]!.view.name).toBe("run_command");
    expect(rec.asks).toEqual([
      {
        kind: "permission",
        askedBy: "Antigravity",
        context: null,
        prompts: [
          {
            id: "permission",
            header: "run_command",
            question: "Allow echo hi?",
            multiSelect: false,
            options: [
              { label: "Allow once", description: null },
              { label: "Deny", description: null },
            ],
          },
        ],
      },
    ]);
    expect(logOf(key).find((e) => e.permission)?.permission).toEqual({
      outcome: { outcome: "selected", optionId: "allow" },
    });
    expect(rec.contexts).toEqual([
      { usedTokens: 1000, limitTokens: 1048576, approximate: false },
    ]);
    // agy reports a turn's usage: added to the conversation's earlier usage.
    expect(rec.usages).toEqual([
      { input: 1500, output: 30, cacheRead: 100, cacheWrite: 0 },
    ]);
    // Model and effort: agy's per-effort model id (the default effort when none is asked for).
    expect(
      calls(key, "session/set_model").map((c) => c.params.modelId),
    ).toEqual(["gemini-4-carbon-medium"]);
    await agent.release(key);
  });

  test("a permission denied: the agent's reject option; Grok's labels by kind", async () => {
    const key = person();
    const agent = grokAgent(opts());
    const rec = recorder(() => ({ permission: ["Deny"] }));
    const end = await agent.turn(
      key,
      input({ provider: "grok", model: "xai/grok-4.6", text: "TOOL" }),
      rec.sink,
      never(),
    );
    expect(end).toEqual({ status: "completed" });
    expect(rec.asks[0]!.prompts[0]!.options.map((o) => o.label)).toEqual([
      "Allow once",
      "Allow always",
      "Deny",
    ]);
    expect(rec.asks[0]!.askedBy).toBe("Grok Build");
    expect(logOf(key).find((e) => e.permission)?.permission).toEqual({
      outcome: { outcome: "selected", optionId: "reject-once" },
    });
    expect(rec.tools.get("call_1")!.at(-1)!.view.status).toBe("failed");
    expect([...rec.text.values()].at(-1)).toBe("it was denied");
    await agent.release(key);
  });

  test("a prompt goose refuses while its own resumed run goes on is sent again", async () => {
    const key = person();
    const agent = openrouterAgent(opts());
    const rec = recorder();
    const end = await agent.turn(
      key,
      input({ provider: "openrouter", model: OPENROUTER_MODELS[0]!, text: "BUSY then hello" }),
      rec.sink,
      never(),
    );
    expect(end).toEqual({ status: "completed" });
    expect(calls(key, "session/prompt")).toHaveLength(3);
    await agent.release(key);
  });

  test("an unanswered question is a cancelled outcome", async () => {
    const key = person();
    const agent = openrouterAgent(opts());
    const rec = recorder(() => null);
    const end = await agent.turn(
      key,
      input({
        provider: "openrouter",
        model: OPENROUTER_MODELS[0]!,
        text: "TOOL",
      }),
      rec.sink,
      never(),
    );
    expect(logOf(key).find((e) => e.permission)?.permission).toEqual({
      outcome: { outcome: "cancelled" },
    });
    // The agent ended the turn itself (not stopped by Tandem): an ordinary end.
    expect(end).toEqual({ status: "completed" });
    expect(rec.asks[0]!.prompts[0]!.header).toBe("shell");
    await agent.release(key);
  });

  test("permission modes: full_access allows and read_only denies without asking; edits inside the workspace pass", async () => {
    const key = person();
    const agent = openrouterAgent(opts());
    const full = recorder();
    await agent.turn(
      key,
      input({
        provider: "openrouter",
        model: OPENROUTER_MODELS[0]!,
        text: "TOOL",
        permissionMode: "full_access",
      }),
      full.sink,
      never(),
    );
    const ro = recorder();
    await agent.turn(
      key,
      input({
        conversationId: "c2",
        provider: "openrouter",
        model: OPENROUTER_MODELS[0]!,
        text: "TOOL",
        permissionMode: "read_only",
      }),
      ro.sink,
      never(),
    );
    const ww = recorder();
    await agent.turn(
      key,
      input({
        conversationId: "c3",
        provider: "openrouter",
        model: OPENROUTER_MODELS[0]!,
        text: "EDIT",
        permissionMode: "workspace_write",
      }),
      ww.sink,
      never(),
    );
    expect([full.asks, ro.asks, ww.asks]).toEqual([[], [], []]);
    expect(
      logOf(key)
        .filter((e) => e.permission)
        .map((e) => e.permission.outcome.optionId),
    ).toEqual(["allow_once", "reject_once", "allow_once"]);
    // goose's own modes: auto for full_access, approve for read_only and workspace_write.
    expect(
      calls(key, "session/set_config_option")
        .filter((c) => c.params.configId === "mode")
        .map((c) => c.params.value),
    ).toEqual(["auto", "approve", "approve"]);
    await agent.release(key);
  });

  test("thoughts are never shown", async () => {
    const key = person();
    const agent = geminiAgent(opts());
    const rec = recorder();
    await agent.turn(
      key,
      input({
        provider: "gemini",
        model: "antigravity/gemini-3.1-pro",
        text: "THINK",
      }),
      rec.sink,
      never(),
    );
    expect([...rec.text.values()]).toEqual(["thought about it"]);
    await agent.release(key);
  });

  test("abort mid-turn: session/cancel, aborted, and the process ends", async () => {
    const key = person();
    const agent = grokAgent(opts());
    const rec = recorder();
    const ac = new AbortController();
    const done = agent.turn(
      key,
      input({ provider: "grok", model: "xai/grok-4.6", text: "SLOW" }),
      rec.sink,
      ac.signal,
    );
    for (let i = 0; i < 100 && !rec.tools.has("call_slow"); i++)
      await Bun.sleep(20);
    ac.abort();
    expect(await done).toEqual({ status: "aborted" });
    expect(calls(key, "session/cancel").length).toBe(1);
    expect(rec.tools.get("call_slow")!.at(-1)!.view.status).toBe("failed");
    for (let i = 0; i < 100 && agent.busy(key); i++) await Bun.sleep(20);
    expect(agent.busy(key)).toBe(false);
  });

  test("abort while a question waits: the agent gets a cancelled outcome", async () => {
    const key = person();
    const agent = geminiAgent(opts());
    const ac = new AbortController();
    const rec = recorder(() => new Promise(() => {}));
    const done = agent.turn(
      key,
      input({
        provider: "gemini",
        model: "antigravity/gemini-4-carbon",
        text: "TOOL",
      }),
      rec.sink,
      ac.signal,
    );
    for (let i = 0; i < 100 && !rec.asks.length; i++) await Bun.sleep(20);
    ac.abort();
    expect(await done).toEqual({ status: "aborted" });
    for (let i = 0; i < 50 && !logOf(key).some((e) => e.permission); i++)
      await Bun.sleep(20);
    expect(logOf(key).find((e) => e.permission)?.permission).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });

  test("a second turn after release resumes the same session (Grok, agy) or loads it (goose)", async () => {
    for (const [agent, provider, model] of [
      [grokAgent(opts()), "grok", "xai/grok-4.6"],
      [geminiAgent(opts()), "gemini", "antigravity/gemini-4-carbon"],
      [openrouterAgent(opts()), "openrouter", OPENROUTER_MODELS[1]!],
    ] as const) {
      const key = person();
      const first = recorder();
      await agent.turn(
        key,
        input({ provider, model, text: "REMEMBER kiwi-42" }),
        first.sink,
        never(),
      );
      await agent.release(key);
      const second = recorder();
      const end = await agent.turn(
        key,
        input({ provider, model, text: "RECALL", session: first.sessions[0]! }),
        second.sink,
        never(),
      );
      expect(end).toEqual({ status: "completed" });
      expect(second.sessions).toEqual(first.sessions);
      // Only this turn's reply: a load's replayed history is not news.
      expect([...second.text.values()]).toEqual(["earlier: REMEMBER kiwi-42"]);
      const method =
        provider === "openrouter" ? "session/load" : "session/resume";
      expect(calls(key, method).length).toBe(1);
      expect(calls(key, "session/new").length).toBe(1);
      await agent.release(key);
    }
  });

  test("a session the agent no longer has becomes a new one", async () => {
    const key = person();
    const agent = grokAgent(opts());
    const rec = recorder();
    expect(
      await agent.turn(
        key,
        input({ provider: "grok", model: "xai/grok-4.6", session: "gone" }),
        rec.sink,
        never(),
      ),
    ).toEqual({ status: "completed" });
    expect(rec.sessions.length).toBe(1);
    expect(rec.sessions[0]).not.toBe("gone");
    await agent.release(key);
  });

  test("MCP servers: HTTP with headers in session/new (agy without advertising it); goose's own extensions", async () => {
    const servers: McpServer[] = [
      {
        name: "app",
        url: "http://127.0.0.1:8790/mcp/k/app",
        headers: { authorization: "Bearer proxy-token" },
        enabledTools: ["lookup_customer"],
      },
      {
        name: "all",
        url: "http://127.0.0.1:8790/mcp/k/all",
        headers: {},
        enabledTools: null,
      },
      {
        name: "none",
        url: "http://127.0.0.1:8790/mcp/k/none",
        headers: {},
        enabledTools: [],
      },
    ];
    const acp = [
      {
        type: "http",
        name: "app",
        url: servers[0]!.url,
        headers: [{ name: "authorization", value: "Bearer proxy-token" }],
      },
      { type: "http", name: "all", url: servers[1]!.url, headers: [] },
    ];
    for (const [agent, provider, model] of [
      [grokAgent(opts()), "grok", "xai/grok-4.6"],
      [geminiAgent(opts()), "gemini", "antigravity/gemini-4-carbon"],
      [openrouterAgent(opts()), "openrouter", OPENROUTER_MODELS[0]!],
    ] as const) {
      const key = person();
      await agent.turn(
        key,
        input({ provider, model, mcpServers: servers }),
        recorder().sink,
        never(),
      );
      const params = calls(key, "session/new")[0]!.params;
      if (provider === "openrouter") {
        expect(params.mcpServers).toEqual([]);
        expect(params._meta.enabledExtensions).toEqual([
          { type: "platform", name: "developer" },
          { type: "mcp", server: acp[0], available_tools: ["lookup_customer"] },
          { type: "mcp", server: acp[1] },
        ]);
      } else expect(params.mcpServers).toEqual(acp);
      // Other servers on the next turn: the session is opened again with them.
      await agent.turn(
        key,
        input({
          provider,
          model,
          mcpServers: servers.slice(1),
          session: null,
        }),
        recorder().sink,
        never(),
      );
      const reopened = calls(key, provider === "openrouter" ? "session/load" : "session/resume");
      expect(reopened.length).toBe(1);
      expect(reopened[0]!.params.mcpServers).toEqual([acp[1]]);
      expect(calls(key, "session/close").length).toBe(1);
      expect(calls(key, "session/new").length).toBe(1);
      await agent.release(key);
    }
  });

  test("model and effort per agent; a model the account lacks is model_unavailable", async () => {
    const key = person();
    const grok = grokAgent(opts());
    await grok.turn(
      key,
      input({
        provider: "grok",
        model: "xai/grok-4.6",
        effort: "low",
        permissionMode: "read_only",
      }),
      recorder().sink,
      never(),
    );
    expect(
      calls(key, "session/set_config_option").map((c) => [
        c.params.configId,
        c.params.value,
      ]),
    ).toEqual([
      ["model", "grok-4.6"],
      ["reasoning_effort", "low"],
    ]);
    expect(calls(key, "session/set_mode").map((c) => c.params.modeId)).toEqual([
      "plan",
    ]);
    const missing = await grok.turn(
      key,
      input({ conversationId: "c2", provider: "grok", model: "xai/grok-9" }),
      recorder().sink,
      never(),
    );
    expect(missing).toEqual({
      status: "failed",
      failure: {
        code: "model_unavailable",
        message: expect.any(String),
        params: {},
      },
    });
    await grok.release(key);

    const k2 = person();
    const gemini = geminiAgent(opts());
    await gemini.turn(
      k2,
      input({
        provider: "gemini",
        model: "antigravity/gemini-4-hydrogen",
        effort: "xhigh",
        permissionMode: "read_only",
      }),
      recorder().sink,
      never(),
    );
    expect(calls(k2, "session/set_model").map((c) => c.params.modelId)).toEqual(
      ["gemini-4-hydrogen-xhigh"],
    );
    expect(
      calls(k2, "session/set_config_option").map((c) => [
        c.params.configId,
        c.params.value,
      ]),
    ).toEqual([["mode", "plan"]]);
    await gemini.release(k2);

    const k3 = person();
    const or = openrouterAgent(opts());
    const rec = recorder();
    await or.turn(
      k3,
      input({
        provider: "openrouter",
        model: OPENROUTER_MODELS[1]!,
        effort: "high",
        text: "CONFIG",
      }),
      rec.sink,
      never(),
    );
    expect(JSON.parse([...rec.text.values()][0]!)).toMatchObject({
      model: OPENROUTER_MODELS[1],
      effort: "high",
      mode: "smart_approve",
    });
    // goose's own notification has the session's totals: passed on as they are.
    expect(rec.usages).toEqual([
      { input: 1000, output: 20, cacheRead: 0, cacheWrite: 0 },
    ]);
    const again = recorder();
    await or.turn(k3, input({ provider: "openrouter", model: OPENROUTER_MODELS[1]!, session: rec.sessions[0]! }), again.sink, never());
    expect(again.usages).toEqual([{ input: 2000, output: 40, cacheRead: 0, cacheWrite: 0 }]);
    // An effort goose does not offer for the model is left to goose.
    const rec2 = recorder();
    await or.turn(
      k3,
      input({
        conversationId: "c2",
        provider: "openrouter",
        model: OPENROUTER_MODELS[4]!,
        effort: "high",
        text: "CONFIG",
      }),
      rec2.sink,
      never(),
    );
    expect(JSON.parse([...rec2.text.values()][0]!)).toMatchObject({
      model: OPENROUTER_MODELS[4],
      effort: null,
    });
    await or.release(k3);
  });

  test("Grok's own usage and context in the prompt's _meta", async () => {
    const key = person();
    const agent = grokAgent(opts());
    const rec = recorder();
    await agent.turn(
      key,
      input({
        provider: "grok",
        model: "xai/grok-4.6",
        usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 },
      }),
      rec.sink,
      never(),
    );
    expect(rec.contexts).toEqual([
      { usedTokens: 1200, limitTokens: 500000, approximate: false },
    ]);
    expect(rec.usages).toEqual([
      { input: 1010, output: 21, cacheRead: 100, cacheWrite: 5 },
    ]);
    await agent.release(key);
  });

  test("failures: refused sign-in, rate limit, quota, context, a crash", async () => {
    const cases: [
      () => AcpAgent,
      "grok" | "gemini" | "openrouter",
      string,
      string,
      string,
    ][] = [
      [
        () => grokAgent(opts()),
        "grok",
        "xai/grok-4.6",
        "FAIL:401 Unauthorized",
        "signin_required",
      ],
      [
        () => grokAgent(opts()),
        "grok",
        "xai/grok-4.6",
        "FAIL:429 Too Many Requests",
        "rate_limited",
      ],
      [
        () => grokAgent(opts()),
        "grok",
        "xai/grok-4.6",
        "FAIL:429 subscription:free-usage-exhausted",
        "usage_limit",
      ],
      [
        () => openrouterAgent(opts()),
        "openrouter",
        OPENROUTER_MODELS[0]!,
        "AUTH",
        "signin_required",
      ],
      [
        () => openrouterAgent(opts()),
        "openrouter",
        OPENROUTER_MODELS[0]!,
        "FAIL:credits",
        "usage_limit",
      ],
      [
        () => openrouterAgent(opts()),
        "openrouter",
        OPENROUTER_MODELS[0]!,
        "FAIL:Rate limit exceeded: 429",
        "rate_limited",
      ],
      [
        () => geminiAgent(opts()),
        "gemini",
        "antigravity/gemini-4-carbon",
        "FAIL:API key not valid. Please pass a valid API key.",
        "signin_required",
      ],
      [
      () => geminiAgent(opts()),
      "gemini",
      "antigravity/gemini-4-carbon",
      "SHOWERR=Error 429, Message: Resource has been exhausted (e.g. check quota)., Status: RESOURCE_EXHAUSTED",
      "rate_limited",
    ],
    [
        () => geminiAgent(opts()),
        "gemini",
        "antigravity/gemini-4-carbon",
        "FAIL:You exceeded your current quota",
        "usage_limit",
      ],
      [
        () => geminiAgent(opts()),
        "gemini",
        "antigravity/gemini-4-carbon",
        "FAIL:The input token count exceeds the maximum context length",
        "context_too_long",
      ],
      [
        () => geminiAgent(opts()),
        "gemini",
        "antigravity/gemini-4-carbon",
        "EXIT",
        "failed",
      ],
    ];
    for (const [make, provider, model, text, code] of cases) {
      const key = person();
      const agent = make();
      const end = await agent.turn(
        key,
        input({ provider, model, text }),
        recorder().sink,
        never(),
      );
      expect([
        text,
        end.status === "failed" ? end.failure.code : end.status,
      ]).toEqual([text, code]);
      if (code === "signin_required" || code === "failed")
        expect(agent.busy(key)).toBe(false);
      await agent.release(key);
    }
  });

  test("agy's failure shown as text: the turn fails with it; a recovered retry is not shown", async () => {
    const key = person();
    const agent = geminiAgent(opts());
    const bad = recorder();
    const end = await agent.turn(key, input({ provider: "gemini", model: "antigravity/gemini-4-carbon", text: "SHOWERR=Error 400, Message: API key not valid. Please pass a valid API key., Status: INVALID_ARGUMENT" }), bad.sink, never());
    expect(end).toMatchObject({ status: "failed", failure: { code: "signin_required", params: { provider: "gemini" } } });
    expect([...bad.text.values()]).toEqual([]);
    const k2 = person();
    const ok = recorder();
    const end2 = await agent.turn(k2, input({ provider: "gemini", model: "antigravity/gemini-4-carbon", text: "SHOWERR=Error 429 RECOVER" }), ok.sink, never());
    expect(end2).toEqual({ status: "completed" });
    expect([...ok.text.values()]).toEqual(["recovered"]);
    await agent.release(k2);
  });

  test("a person without the key fails with signin_required and starts nothing", async () => {
    const agent = openrouterAgent(opts());
    const end = await agent.turn(
      "nobody",
      input({ provider: "openrouter", model: OPENROUTER_MODELS[0]! }),
      recorder().sink,
      never(),
    );
    expect(end).toMatchObject({
      status: "failed",
      failure: { code: "signin_required", params: { provider: "openrouter" } },
    });
    expect(sb.spawned).toEqual([]);
  });

  test("two conversations share one process; it ends idleMs after the last turn", async () => {
    const key = person();
    const agent = grokAgent(opts({ idleMs: 200 }));
    await Promise.all([
      agent.turn(
        key,
        input({ provider: "grok", model: "xai/grok-4.6" }),
        recorder().sink,
        never(),
      ),
      agent.turn(
        key,
        input({
          conversationId: "c2",
          provider: "grok",
          model: "xai/grok-4.6",
        }),
        recorder().sink,
        never(),
      ),
    ]);
    expect(sb.spawned.length).toBe(1);
    expect(agent.busy(key)).toBe(true);
    await Bun.sleep(500);
    expect(agent.busy(key)).toBe(false);
  });
});

describe("API key checks", () => {
  test("OpenRouter and Gemini: ok, refused, unreachable; the key only on stdin", async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        seen.push(
          `${url.pathname} ${req.headers.get("authorization") ?? req.headers.get("x-goog-api-key")}`,
        );
        const good = /good/.test(
          req.headers.get("authorization") ??
            req.headers.get("x-goog-api-key") ??
            "",
        );
        if (url.pathname === "/api/v1/key")
          return good
            ? Response.json({ data: {} })
            : new Response("no", { status: 401 });
        if (url.pathname === "/v1beta/models")
          return good
            ? Response.json({ models: [] })
            : new Response("bad", { status: 400 });
        return new Response("?", { status: 500 });
      },
    });
    try {
      const urls = {
        openrouter: `http://127.0.0.1:${server.port}`,
        gemini: `http://127.0.0.1:${server.port}`,
      };
      const key = person();
      const or = openrouterAgent(opts({ urls }));
      const ge = geminiAgent(opts({ urls }));
      expect(
        await or.verifyApiKey(key, "openrouter", "sk-or-good-000000000000"),
      ).toBe("ok");
      expect(
        await or.verifyApiKey(key, "openrouter", "sk-or-bad-0000000000000"),
      ).toBe("refused");
      expect(
        await ge.verifyApiKey(key, "gemini", "AIza-good-000000000000"),
      ).toBe("ok");
      expect(
        await ge.verifyApiKey(key, "gemini", "AIza-bad-0000000000000"),
      ).toBe("refused");
      expect(seen).toEqual([
        "/api/v1/key Bearer sk-or-good-000000000000",
        "/api/v1/key Bearer sk-or-bad-0000000000000",
        "/v1beta/models AIza-good-000000000000",
        "/v1beta/models AIza-bad-0000000000000",
      ]);
      const down = openrouterAgent(
        opts({ urls: { openrouter: "http://127.0.0.1:9" } }),
      );
      expect(
        await down.verifyApiKey(key, "openrouter", "sk-or-good-000000000000"),
      ).toBe("unreachable");
      for (const s of sb.spawned)
        expect(JSON.stringify(s)).not.toContain("000000000000");
    } finally {
      server.stop(true);
    }
  });
});

describe("Grok sign-in", () => {
  const output =
    "To sign in, open this URL in your browser:\n  https://accounts.x.ai/oauth2/device?user_code=WXYZ-9876\nConfirm this code in your browser:\n  WXYZ-9876\n\x1b[90mOnly continue with a code you requested.\x1b[0m\nWaiting for authorization...\n";
  test("the page and code from the CLI's output", () => {
    expect(parseDeviceAuth(output)).toEqual({
      url: "https://accounts.x.ai/oauth2/device?user_code=WXYZ-9876",
      userCode: "WXYZ-9876",
    });
    expect(
      parseDeviceAuth(
        output.replace(
          "Confirm this code in your browser:",
          "Then enter this code:",
        ),
      ),
    ).toMatchObject({ userCode: "WXYZ-9876" });
    expect(
      parseDeviceAuth(
        "To sign in, open this URL in your browser:\n  https://auth.x.ai/oauth2/auth?x=1\n",
      ),
    ).toBeNull();
  });

  const mode = (key: string, m: string) => {
    mkdirSync(`${sb.homeOf(key)}/.fake-acp`, { recursive: true });
    writeFileSync(`${sb.homeOf(key)}/.fake-acp/login-mode`, m);
  };

  test("waiting with page and code, then succeeded once auth.json is there", async () => {
    const key = person();
    rmSync(`${sb.homeOf(key)}/.grok/auth.json`);
    const s = new GrokSignIn({ sandboxes: sb });
    expect(s.signedIn(key)).toBe(false);
    const later: string[] = [];
    const first = await s.start(key, (st) => later.push(st.state));
    expect(first).toEqual({
      state: "waiting",
      url: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
      userCode: "ABCD-1234",
      expiresAt: null,
      codeError: null,
    });
    for (let i = 0; i < 100 && !later.length; i++) await Bun.sleep(20);
    expect(later).toEqual(["succeeded"]);
    expect(s.signedIn(key)).toBe(true);
    expect(sb.spawned.at(-1)).toMatchObject({
      args: ["grok", "login", "--device-auth"],
      env: { DISABLE_TELEMETRY: "1" },
    });
    await s.signOut(key);
    expect(s.signedIn(key)).toBe(false);
    expect(sb.spawned.at(-1)!.args.join(" ")).toContain("grok logout");
  });

  test("expired, failed before the page, cancelled", async () => {
    const s = new GrokSignIn({ sandboxes: sb });
    const k1 = person();
    rmSync(`${sb.homeOf(k1)}/.grok/auth.json`);
    mode(k1, "expire");
    const later: any[] = [];
    expect((await s.start(k1, (st) => later.push(st))).state).toBe("waiting");
    for (let i = 0; i < 100 && !later.length; i++) await Bun.sleep(20);
    expect(later).toEqual([{ state: "failed", reason: "expired" }]);

    const k2 = person();
    mode(k2, "unavailable");
    expect(await s.start(k2, () => {})).toEqual({
      state: "failed",
      reason: "sign_in_failed",
    });

    const k3 = person();
    mode(k3, "hang");
    const hung = new GrokSignIn({ sandboxes: sb, startMs: 200 });
    expect(await hung.start(k3, () => {})).toEqual({
      state: "failed",
      reason: "unavailable",
    });

    const k4 = person();
    rmSync(`${sb.homeOf(k4)}/.grok/auth.json`);
    mode(k4, "slow");
    const changes: string[] = [];
    expect((await s.start(k4, (st) => changes.push(st.state))).state).toBe("waiting");
    await s.cancel(k4);
    expect(changes).toEqual(["cancelled"]);
    expect(s.signedIn(k4)).toBe(false);
  });
});
