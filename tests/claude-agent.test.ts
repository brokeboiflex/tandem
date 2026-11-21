// ClaudeAgent with the real Claude Code against the scripted Anthropic API, each process started
// directly (no crun) with a temporary home. Skipped where Claude Code is not installed. Nothing
// reaches a real host: the mock is on loopback and every other request meets a dead proxy.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mockAnthropic } from "../scripts/mock-vendor/mock-anthropic";
import { startStubMcp } from "../scripts/stub-mcp";
import { agentFor, input, recorder, scenarios, type Harness } from "./claude-scenarios";
import { directSandboxes, type DirectSandboxes } from "./direct-sandboxes";

const CLAUDE = [process.env.CLAUDE_BIN, Bun.which("claude"), join(homedir(), ".local/bin/claude")].find(
  (p): p is string => !!p && existsSync(p),
);

describe.skipIf(!CLAUDE)("ClaudeAgent with Claude Code", () => {
  const mock = mockAnthropic();
  let server: ReturnType<typeof Bun.serve>;
  let stub: ReturnType<typeof startStubMcp>;
  let sandboxes: DirectSandboxes;
  const harness = (): Harness => ({
    sandboxes,
    spawnedArgs: () => sandboxes.spawned.map((s) => s.args),
    key: `p${crypto.randomUUID().slice(0, 8)}`,
    executable: CLAUDE!,
    mockUrl: `http://127.0.0.1:${server.port}`,
    mock,
    mcpUrl: stub.url,
    mcpRequests: stub.requests,
    // What the rootfs's managed settings hold in production.
    env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
  });

  beforeAll(() => {
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: mock.handle, idleTimeout: 60 });
    stub = startStubMcp();
    sandboxes = directSandboxes();
  });
  afterAll(() => {
    sandboxes.cleanup();
    server.stop(true);
    stub.stop();
  });

  for (const s of scenarios)
    test(s.name, async () => {
      console.log(`  ${s.name}: ${await s.run(harness())}`);
    }, 90_000);

  test("the gateway's environment never reaches the sandbox; the key only its env", async () => {
    process.env.CLAUDE_GATEWAY_CANARY = "leak";
    process.env.ANTHROPIC_GATEWAY_CANARY = "leak";
    try {
      const h = harness();
      const agent = agentFor(h);
      const n = sandboxes.spawned.length;
      const end = await agent.turn(h.key, input("hello"), recorder().sink, new AbortController().signal);
      await agent.release(h.key);
      expect(end).toEqual({ status: "completed" });
      const claude = sandboxes.spawned.slice(n).filter((s) => s.args[0] === CLAUDE);
      expect(claude.length).toBe(1);
      const { args, env, label } = claude[0]!;
      expect(label).toMatch(/^[a-z0-9-]{1,24}$/);
      // What the agent added: only Claude Code's and the SDK's variables.
      const base = new Set(Object.keys(sandboxes.spawned[0]!.env).filter((k) => !/^(CLAUDE|ANTHROPIC)/.test(k)));
      for (const k of Object.keys(env)) if (!base.has(k)) expect(k).toMatch(/^(CLAUDE|ANTHROPIC)/);
      expect(env.CLAUDE_GATEWAY_CANARY).toBeUndefined();
      expect(env.ANTHROPIC_GATEWAY_CANARY).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-mock-0000000000000000000000");
      expect(args.join(" ")).not.toContain("sk-ant-mock");
      expect(env.CLAUDE_CODE_PROXY_RESOLVES_HOSTS).toBe("1");
    } finally {
      delete process.env.CLAUDE_GATEWAY_CANARY;
      delete process.env.ANTHROPIC_GATEWAY_CANARY;
    }
  }, 90_000);

  test("release ends a running turn as aborted and stops its process", async () => {
    const h = harness();
    const agent = agentFor(h);
    const { r, sink } = recorder();
    const turn = agent.turn(h.key, input("SLOW please"), sink, new AbortController().signal);
    for (const until = Date.now() + 30_000; !r.deltas.size && Date.now() < until; ) await Bun.sleep(50);
    await agent.release(h.key);
    expect(await turn).toEqual({ status: "aborted" });
    expect(agent.busy(h.key)).toBe(false);
  }, 90_000);

  test("a conversation's process ends idleMs after its last turn; busy follows it", async () => {
    const h = harness();
    const agent = agentFor(h, { idleMs: 300 });
    const end = await agent.turn(h.key, input("hello"), recorder().sink, new AbortController().signal);
    expect(end).toEqual({ status: "completed" });
    expect(agent.busy(h.key)).toBe(true);
    for (const until = Date.now() + 15_000; agent.busy(h.key) && Date.now() < until; ) await Bun.sleep(100);
    expect(agent.busy(h.key)).toBe(false);
  }, 90_000);

  test("another model for the conversation starts a new process on the same session", async () => {
    const h = harness();
    const agent = agentFor(h);
    const conv = input("REMEMBER kiwi");
    const first = recorder();
    expect(await agent.turn(h.key, conv, first.sink, new AbortController().signal)).toEqual({ status: "completed" });
    const n = sandboxes.spawned.length;
    const second = recorder();
    const end = await agent.turn(
      h.key,
      { ...conv, text: "RECALL it", model: "claude-code/haiku", effort: "low", session: first.r.sessions[0]! },
      second.sink,
      new AbortController().signal,
    );
    await agent.release(h.key);
    expect(end).toEqual({ status: "completed" });
    expect(second.text()).toContain("RECALLED kiwi");
    const args = sandboxes.spawned.slice(n).find((s) => s.args[0] === CLAUDE)!.args;
    expect(args).toContain("--model=haiku");
    expect(args).toContain("--effort=low");
    expect(args).toContain(`--resume=${first.r.sessions[0]}`);
    expect(mock.requests.at(-1)!.model).toContain("haiku");
  }, 90_000);
});
