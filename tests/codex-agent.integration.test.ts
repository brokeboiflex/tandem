// The real `codex` (CODEX_BIN, else on PATH or ~/.local/bin) through CodexAgent and CodexSignIn,
// against the scripted OpenAI API and sign-in issuer in scripts/mock-vendor/mock-openai.ts and the
// stub MCP server. Hermetic: every process gets a temporary HOME (so its own ~/.codex), a dead
// HTTPS proxy for anything that is not the local mock, and no variable of the test runner's.
// Skipped when there is no codex. The same scenarios run in real sandboxes in
// evidence/poc/codex-agent-vm.ts.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAgent, autoCompactLimit } from "../src/agents/codex";
import {
  WORKSPACE,
  type McpServer,
  type PermissionMode,
  type TurnInput,
} from "../src/agents/types";
import { CodexSignIn } from "../src/signin/codex";
import { STUB_CUSTOMER, startStubMcp } from "../scripts/stub-mcp";
import { DirectSandboxes } from "./support/direct-sandboxes";
import { RecordingSink, choose } from "./support/sink";

const CODEX =
  process.env.CODEX_BIN ??
  [Bun.which("codex"), join(homedir(), ".local/bin/codex")].find(
    (p) => p && existsSync(p),
  );
setDefaultTimeout(90_000);

const root = mkdtempSync(join(tmpdir(), "tandem-codex-it-"));
process.env.MOCK_LOG = join(root, "mock.log");
const mock = await import("../scripts/mock-vendor/mock-openai");
const api = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 120,
  fetch: mock.handle,
});
const origin = `http://127.0.0.1:${api.port}`;
const stub = startStubMcp();
afterAll(() => {
  api.stop(true);
  stub.stop();
  if (!process.env.CODEX_IT_KEEP) rmSync(root, { recursive: true, force: true });
});
const dead = "http://127.0.0.1:9"; // nothing listens: a request for a real vendor fails here
const boxes = new DirectSandboxes(
  root,
  { codex: [CODEX!] },
  {
    HTTPS_PROXY: dead,
    HTTP_PROXY: dead,
    https_proxy: dead,
    http_proxy: dead,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    MOCK_API_KEY: "mock-key",
    CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${origin}/oauth/token`,
    CODEX_REVOKE_TOKEN_URL_OVERRIDE: `${origin}/oauth/revoke`,
  },
);
/** The scripted API as Codex's model provider; ChatGPT's backend is the mock as well. */
const PROVIDER = [
  'model_provider="mock"',
  'model_providers.mock.name="mock"',
  `model_providers.mock.base_url="${origin}/v1"`,
  'model_providers.mock.wire_api="responses"',
  'model_providers.mock.env_key="MOCK_API_KEY"',
  "model_providers.mock.request_max_retries=0",
  "model_providers.mock.stream_max_retries=0",
  `chatgpt_base_url="${origin}/backend-api/"`,
];
const key = "integration";
const home = boxes.homeOf(key);
const chats = boxes.path(key, WORKSPACE);
mkdirSync(chats, { recursive: true });
mkdirSync(join(home, ".codex"), { recursive: true });
// A ChatGPT sign-in as `codex login` writes it (the mock's unsigned tokens).
writeFileSync(
  join(home, ".codex/auth.json"),
  JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      id_token: mock.idToken(),
      access_token: mock.fakeJwt({
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
      refresh_token: "refresh-test",
      account_id: "acct-test",
    },
    last_refresh: new Date().toISOString(),
  }),
);
const log = process.env.CODEX_IT_LOG ? (l: string) => console.error(l) : undefined;
const agent = new CodexAgent(boxes, {
  log,
  workspace: chats,
  config: PROVIDER,
  idleMs: 60_000,
});
afterAll(() => agent.release(key));
// A model the catalog does not know: Codex then offers its classic function tools, which the
// scripted API speaks (catalog GPT-6 models get "code mode", one JavaScript `exec` tool).
const model = { id: "codex-cli/gpt-mock" };
const input = (
  text: string,
  permissionMode: PermissionMode,
  over: Partial<TurnInput> = {},
): TurnInput => ({
  conversationId: "c",
  provider: "codex",
  model: model.id,
  effort: null,
  session: null,
  text,
  mcpServers: [],
  permissionMode,
  ...over,
});
const turn = (
  agentFor: CodexAgent,
  i: TurnInput,
  sink = new RecordingSink(),
  signal = new AbortController().signal,
) => agentFor.turn(key, i, sink, signal).then((end) => ({ end, sink }));
let firstSession = "";
let firstUsage = 0;

describe.skipIf(!CODEX)("the real Codex", () => {
  test("read: signed in, with Codex's models", async () => {
    const live = await agent.read(key, "codex");
    expect(live.signedIn).toBe(true);
    // A custom model provider has no OpenAI account: Codex reports none (`requiresOpenaiAuth`
    // false). The ChatGPT account's email and plan are mapped in the unit tests.
    expect(live.account).toBeNull();
    expect(live.models.length).toBeGreaterThan(0);
    for (const m of live.models) expect(m.id).toStartWith("codex-cli/");
    expect(live.models[0]!.efforts.length).toBeGreaterThan(0);
  });

  test("a shell command writes a file in the workspace (full_access: nothing asked)", async () => {
    const { end, sink } = await turn(
      agent,
      input("RUN_TOOL please", "full_access"),
    );
    expect(end).toEqual({ status: "completed" });
    expect(readFileSync(join(chats, "probe.txt"), "utf8")).toBe("hi\n");
    expect(sink.asks).toHaveLength(0);
    expect(sink.tools.map(([, t]) => [t.name, t.status])).toEqual([
      ["exec_command", "running"],
      ["exec_command", "completed"],
    ]);
    expect(sink.allText()).toContain("TOOL_RESULT_SEEN");
    firstSession = sink.sessions[0]!;
    expect(firstSession).toBeTruthy();
    const context = sink.contexts.at(-1)!;
    expect(context.usedTokens).toBeGreaterThan(0);
    // 90/95 of the usable window Codex reports, so above what was used.
    expect(context.limitTokens).toBeGreaterThan(context.usedTokens);
    expect(sink.usages.at(-1)!.input).toBeGreaterThan(0);
    firstUsage = sink.usages.at(-1)!.input;
  });

  test("on-request asks before a dangerous command: allowed, it runs", async () => {
    rmSync(join(chats, "removed.txt"), { force: true });
    const { end, sink } = await turn(
      agent,
      input("RUN_DANGEROUS now", "auto"),
      new RecordingSink(choose("Allow once")),
    );
    expect(end.status).toBe("completed");
    expect(sink.asks).toHaveLength(1);
    expect(sink.asks[0]).toMatchObject({
      kind: "permission",
      askedBy: "Codex",
      prompts: [{ header: "exec_command" }],
    });
    expect(sink.asks[0]!.prompts[0]!.question).toContain("rm -f doomed.txt");
    expect(readFileSync(join(chats, "removed.txt"), "utf8")).toBe("removed\n");
  });

  test("on-request asks before a dangerous command: denied, it does not run", async () => {
    rmSync(join(chats, "removed.txt"), { force: true });
    const { end, sink } = await turn(
      agent,
      input("RUN_DANGEROUS now", "auto"),
      new RecordingSink(choose("Deny")),
    );
    expect(end.status).toBe("completed");
    expect(sink.asks).toHaveLength(1);
    expect(existsSync(join(chats, "removed.txt"))).toBe(false);
    expect(Object.values(sink.toolStatus())).toEqual(["failed"]);
    expect(sink.allText()).toContain("rejected");
  });

  test("abort mid-turn interrupts a running command", async () => {
    const ac = new AbortController();
    const sink = new RecordingSink();
    sink.onTool = (t) => t.status === "running" && ac.abort();
    const t0 = Date.now();
    const { end } = await turn(
      agent,
      input("RUN_SLOW please", "full_access"),
      sink,
      ac.signal,
    );
    expect(end).toEqual({ status: "aborted" });
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(sink.allText()).not.toContain("slept");
  });

  test("after release, a second turn resumes the same thread and its history reaches the model", async () => {
    await agent.release(key);
    expect(agent.busy(key)).toBe(false);
    const { end, sink } = await turn(
      agent,
      input("RECALL it", "full_access", { session: firstSession }),
    );
    expect(end.status).toBe("completed");
    expect(sink.sessions).toEqual([firstSession]);
    expect(sink.allText()).toContain("RUN_TOOL please");
    // Usage stays the thread's lifetime count: Codex restores it with the thread.
    expect(sink.usages.at(-1)!.input).toBeGreaterThan(firstUsage);
  });

  test("MCP: a tool of the person's server through the proxy token, which never reaches argv", async () => {
    const servers: McpServer[] = [
      {
        name: "app",
        url: stub.url,
        headers: { Authorization: "Bearer valid-integration-token" },
        enabledTools: ["lookup_customer", "confirm_action"],
      },
    ];
    const { end, sink } = await turn(
      agent,
      input("RUN_MCP please", "full_access", { mcpServers: servers }),
    );
    expect(end.status).toBe("completed");
    expect(sink.tools.at(-1)![1]).toMatchObject({
      name: "mcp__app__lookup_customer",
      status: "completed",
    });
    expect(sink.allText()).toContain(STUB_CUSTOMER.name);
    expect(
      stub.requests.some(
        (r) =>
          r.tool === "lookup_customer" &&
          r.authorization === "Bearer valid-integration-token",
      ),
    ).toBe(true);
    const spawned = boxes.spawned.at(-1)!;
    expect(spawned.args.join(" ")).not.toContain("valid-integration-token");
    expect(spawned.env.TANDEM_MCP_APP_TOKEN).toBe("valid-integration-token");
    // on-request: Codex asks before a tool that is not read-only, then the server asks itself.
    const confirm = await turn(
      agent,
      input("RUN_CONFIRM please", "auto", { mcpServers: servers }),
      new RecordingSink(choose("Allow once")),
    );
    expect(confirm.end.status).toBe("completed");
    expect(
      confirm.sink.asks.map((a) => [a.kind, a.askedBy, a.prompts[0]!.header]),
    ).toEqual([
      ["permission", "Codex", "mcp__app__confirm_action"],
      ["permission", "app", "mcp__app__confirm_action"],
    ]);
    expect(confirm.sink.allText()).toContain("The person answered: accept.");
  });

  test("401 from the provider is signin_required; a usage limit is usage_limit with its reset", async () => {
    const unauthorized = await turn(
      agent,
      input("FAIL_401 now", "full_access"),
    );
    expect(unauthorized.end).toMatchObject({
      status: "failed",
      failure: { code: "signin_required", params: { provider: "codex" } },
    });
    const usage = await turn(agent, input("FAIL_USAGE now", "full_access"));
    expect(usage.end).toMatchObject({
      status: "failed",
      failure: {
        code: "usage_limit",
        params: {
          provider: "codex",
          resetsAt: new Date(mock.USAGE_RESETS_AT * 1000).toISOString(),
        },
      },
    });
  });

  test("request_user_input (Codex's feature flag on) is a question with Codex's options", async () => {
    const asking = new CodexAgent(boxes, {
      workspace: chats,
      config: [...PROVIDER, "features.default_mode_request_user_input=true"],
    });
    try {
      const { end, sink } = await turn(
        asking,
        input("RUN_ASK please", "auto"),
        new RecordingSink((ask) => ({ [ask.prompts[0]!.id]: ["Green"] })),
      );
      expect(end.status).toBe("completed");
      expect(sink.asks[0]).toMatchObject({
        kind: "question",
        askedBy: "Codex",
        prompts: [
          {
            id: "colour",
            options: [{ label: "Blue (Recommended)" }, { label: "Green" }],
          },
        ],
      });
      expect(sink.allText()).toContain("Green");
    } finally {
      await asking.release(key);
    }
  });

  test("device sign-in: the real CLI's page and code, then signed in with the issuer's account", async () => {
    const person = "signin";
    mkdirSync(boxes.homeOf(person), { recursive: true });
    const signIn = new CodexSignIn(boxes, {
      args: ["--experimental_issuer", origin],
    });
    const changes: any[] = [];
    const first = await signIn.start(person, (s) => changes.push(s));
    expect(first).toMatchObject({
      state: "waiting",
      url: `${origin}/codex/device`,
      userCode: mock.DEVICE_USER_CODE,
      codeError: null,
    });
    for (let i = 0; i < 200 && !changes.length; i++) await Bun.sleep(50);
    expect(changes).toEqual([{ state: "succeeded" }]);
    expect(signIn.signedIn(person)).toBe(true);
    const reader = new CodexAgent(boxes, {
      workspace: chats,
      config: PROVIDER,
    });
    try {
      expect((await reader.read(person, "codex")).signedIn).toBe(true);
      // What the CLI stored is the issuer's ChatGPT sign-in.
      const stored = JSON.parse(readFileSync(join(boxes.homeOf(person), ".codex/auth.json"), "utf8"));
      expect(stored.tokens.id_token).toBe(mock.idToken().split(".")[0] + "." + stored.tokens.id_token.split(".")[1] + ".sig");
    } finally {
      await reader.release(person);
    }
    await signIn.signOut(person);
    expect(signIn.signedIn(person)).toBe(false);
  });

  test("nothing but the local mock was asked for", () => {
    const log = readFileSync(process.env.MOCK_LOG!, "utf8");
    const lines = log.split("\n").filter((l) => /^(GET|POST|AUTH)/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    // The model API, the sign-in issuer and ChatGPT's user settings (a ChatGPT sign-in reads
    // them); no analytics, plugins or apps, which are off.
    for (const line of lines)
      expect(line).toMatch(
        /^(POST \/v1\/responses|GET \/v1\/models|GET \/backend-api\/wham\/settings\/user|AUTH POST \/(api\/accounts\/deviceauth\/(usercode|token)|oauth\/(token|revoke)))/,
      );
  });
});
