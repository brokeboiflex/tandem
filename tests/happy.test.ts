// Façade mapping and failure classification against redacted responses captured from the pinned
// Happy Agent 2026.11.6-preview.7 daemon (tests/fixtures).
import { describe, expect, test } from "bun:test";
import * as H from "../src/happy";

const fixture = (name: string) =>
  Bun.file(`${import.meta.dir}/fixtures/${name}`).json();
const config = (await fixture("config-signed-out.json")).config;

/** The same daemon after a Codex Free sign-in: its live catalog offers only GPT-6-Luna. */
const codexFreeConfig = {
  ...config,
  models: Object.fromEntries(
    Object.entries(config.models).filter(
      ([id]) => id.startsWith("claude-code/") || id === "codex-cli/gpt-6-luna",
    ),
  ),
};

const cli = (id: string, over: any = {}) => ({
  id,
  installation: { status: "installed" },
  signIn: {
    status: "signed_out",
    account: null,
    methods: id === "codex" ? ["browser", "device"] : ["browser"],
  },
  operation: null,
  ...over,
});
const claudeWaiting = (output: string[] = []) =>
  cli("claude", {
    operation: {
      id: "op1",
      kind: "sign_in",
      status: "waiting",
      authorization: {
        method: "browser",
        url: "https://claude.com/cai/oauth/authorize?state=<redacted>",
        userCode: null,
        openedByProgram: true,
        acceptsCode: true,
        expiresAt: Date.parse("2026-11-16T13:30:00Z"),
      },
      output,
      error: null,
    },
  });

describe("live model catalog", () => {
  test("offers only models present in config.models, never the whole provider reference list", () => {
    expect(
      config.providers.codex.models.filter((m: any) => m.enabled),
    ).toHaveLength(5);
    expect(H.liveModels(codexFreeConfig, "codex").map((m) => m.id)).toEqual([
      "codex-cli/gpt-6-luna",
    ]);
    expect(H.liveModels(codexFreeConfig, "codex")[0]).toEqual({
      id: "codex-cli/gpt-6-luna",
      name: "Codex · GPT-6-Luna",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
    });
  });

  test("a signed-out provider offers no models; a connected one offers its live models", () => {
    expect(H.providerView("codex", cli("codex"), codexFreeConfig)).toEqual({
      id: "codex",
      status: "not_connected",
      method: null,
      account: null,
      models: [],
    });
    const signedIn = cli("codex", {
      signIn: {
        status: "signed_in",
        account: { email: "user@example.com", plan: "Free" },
        methods: [],
      },
    });
    const view = H.providerView("codex", signedIn, codexFreeConfig);
    expect(view.status).toBe("connected");
    expect(view.method).toBe("subscription");
    expect(view.account).toEqual({ email: "user@example.com", plan: "Free" });
    expect(view.models.map((m) => m.id)).toEqual(["codex-cli/gpt-6-luna"]);
    // A turn has since found the sign-in expired: not connected, though Happy still says signed in.
    expect(
      H.providerView("codex", signedIn, codexFreeConfig, {
        signinRequired: true,
      }),
    ).toEqual({
      id: "codex",
      status: "not_connected",
      method: null,
      account: null,
      models: [],
    });
    expect(
      H.connectionView("codex", signedIn, undefined, { signinRequired: true }),
    ).toBeNull();
  });

  test("a sign-in in progress or a post-sign-in restart reads as connecting", () => {
    expect(H.providerView("claude", claudeWaiting(), config).status).toBe(
      "connecting",
    );
    const signedIn = cli("claude", {
      signIn: { status: "signed_in", account: null, methods: [] },
    });
    expect(
      H.providerView("claude", signedIn, config, { restarting: true }).status,
    ).toBe("connecting");
  });

  test("an Anthropic API key configured by the runtime is a connected Claude account", () => {
    const apiKeyConfig = {
      ...config,
      providers: {
        ...config.providers,
        claude: { ...config.providers.claude, name: H.API_KEY_ACCOUNT_NAME },
      },
    };
    const view = H.providerView("claude", cli("claude"), apiKeyConfig);
    expect(view).toMatchObject({
      status: "connected",
      method: "api_key",
      account: { email: null, plan: "API key" },
    });
    expect(view.models.length).toBeGreaterThan(0);
  });
});

describe("connection states", () => {
  const now = Date.parse("2026-11-16T13:25:00Z");

  test("Claude waits for a pasted code; Codex shows a device code", () => {
    expect(
      H.connectionView("claude", claudeWaiting(), undefined, { now }),
    ).toEqual({
      status: "waiting",
      flow: "paste_code",
      url: "https://claude.com/cai/oauth/authorize?state=<redacted>",
      userCode: null,
      expiresAt: "2026-11-16T13:30:00.000Z",
      error: null,
      account: null,
    });
    const codex = cli("codex", {
      operation: {
        id: "op2",
        kind: "sign_in",
        status: "waiting",
        output: [],
        authorization: {
          method: "device",
          url: "https://auth.openai.com/codex/device",
          userCode: "ABCD-12345",
          acceptsCode: false,
          expiresAt: now + 60_000,
        },
      },
    });
    expect(H.connectionView("codex", codex, undefined, { now })).toMatchObject({
      status: "waiting",
      flow: "device_code",
      userCode: "ABCD-12345",
      url: "https://auth.openai.com/codex/device",
    });
  });

  test("expiry, failure codes, cancellation and success", () => {
    expect(
      H.connectionView("claude", claudeWaiting(), undefined, {
        now: Date.parse("2026-11-16T13:31:00Z"),
      }),
    ).toMatchObject({
      status: "expired",
      error: { code: "expired" },
    });
    const failed = (code: string) =>
      cli("claude", {
        operation: {
          id: "x",
          kind: "sign_in",
          status: "failed",
          output: [],
          error: { code, message: "raw" },
        },
      });
    expect(
      H.connectionView("claude", failed("expired"), undefined)?.error?.code,
    ).toBe("expired");
    expect(
      H.connectionView("claude", failed("sign_in_failed"), undefined)?.error
        ?.code,
    ).toBe("sign_in_failed");
    expect(
      H.connectionView("claude", failed("interrupted"), undefined)?.error?.code,
    ).toBe("sign_in_failed");
    expect(
      H.connectionView("claude", failed("unavailable"), undefined)?.error?.code,
    ).toBe("unavailable");
    expect(
      H.connectionView(
        "claude",
        cli("claude", {
          operation: { id: "x", kind: "sign_in", status: "cancelled" },
        }),
        undefined,
      )?.status,
    ).toBe("cancelled");
    const ok = cli("claude", {
      signIn: {
        status: "signed_in",
        account: { email: "a@example.com", plan: "Max" },
      },
      operation: { id: "x", kind: "sign_in", status: "succeeded" },
    });
    expect(H.connectionView("claude", ok, undefined)).toMatchObject({
      status: "connected",
      account: { email: "a@example.com", plan: "Max" },
    });
    expect(
      H.connectionView("claude", ok, undefined, { restarting: true })?.status,
    ).toBe("waiting");
    expect(H.connectionView("claude", cli("claude"), undefined)).toBeNull();
  });
});

describe("wrong-code detection (Claude keeps `waiting`; the rejection is only in operation.output)", () => {
  // Real output lines, URL query redacted.
  const opening = [
    "Opening browser to sign in…",
    "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?<redacted>",
  ];
  const invalid = "Invalid code. Please make sure the full code was copied.";
  const refused =
    "Login failed: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.";

  test("new lines are found in the 20-line sliding window", () => {
    expect(H.newLines(opening, [...opening, invalid])).toEqual([invalid]);
    const full = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    expect(H.newLines(full, [...full.slice(2), "a", "b"])).toEqual(["a", "b"]);
  });

  test("a malformed code is retryable; a refused code ends the attempt; a network error is neither", () => {
    expect(H.codeRejection(H.newLines(opening, [...opening, invalid]))).toBe(
      "retry",
    );
    expect(
      H.codeRejection([invalid, refused, "Paste code here if prompted >"]),
    ).toBe("restart");
    expect(
      H.codeRejection(["Login failed: connect ECONNREFUSED 160.79.104.10:443"]),
    ).toBeNull();
    // An earlier rejection is not a new one.
    expect(
      H.codeRejection(H.newLines([...opening, invalid], [...opening, invalid])),
    ).toBeNull();
  });

  test("the gateway's memo turns a rejected code into waiting + wrong_code", () => {
    const memo: H.CodeMemo = { opId: "op1", before: opening, wrong: true };
    const view = H.connectionView(
      "claude",
      claudeWaiting([...opening, invalid]),
      memo,
      { now: 0 },
    );
    expect(view).toMatchObject({
      status: "waiting",
      error: { code: "wrong_code", message: H.COPY.wrong_code },
    });
    const reissued = H.connectionView(
      "claude",
      claudeWaiting(),
      { ...memo, reissued: true },
      { now: 0 },
    );
    expect(reissued?.error).toEqual({
      code: "wrong_code",
      message: H.COPY.wrong_code_reissued,
    });
    // A memo for an older attempt does not leak into a new one.
    expect(
      H.connectionView(
        "claude",
        claudeWaiting(),
        { ...memo, opId: "old" },
        { now: 0 },
      )?.error,
    ).toBeNull();
  });
});

describe("typed failures from real signed-out turns", () => {
  const failureOf = async (name: string) => {
    const page = await fixture(name);
    const run = page.runs.at(-1);
    const message = run.messages.find((m: any) => m.failure);
    return { run, message, normalized: H.normalizeMessage(message, run.id)! };
  };

  test("Claude 'Not logged in' (kind internal) is signin_required", async () => {
    const { run, message, normalized } = await failureOf(
      "messages-signed-out-claude.json",
    );
    expect(message.failure.kind).toBe("internal");
    expect(normalized).toMatchObject({
      role: "error",
      text: "",
      failure: { code: "signin_required" },
    });
    expect(normalized.failure!.message).toContain("Claude");
    expect(H.normalizeRun(run, normalized.failure)).toEqual({
      id: run.id,
      status: "failed",
      failure: normalized.failure,
    });
  });

  test("Codex '401 Unauthorized' (kind internal) is signin_required", async () => {
    const { message, normalized } = await failureOf(
      "messages-signed-out-codex.json",
    );
    expect(message.failure.kind).toBe("internal");
    expect(normalized.failure).toMatchObject({ code: "signin_required" });
    expect(normalized.failure!.message).toContain("ChatGPT");
  });

  test("a rejected Anthropic API key is signin_required", async () => {
    const { normalized } = await failureOf(
      "messages-invalid-api-key-claude.json",
    );
    expect(normalized.failure?.code).toBe("signin_required");
  });

  test("model, limits and unknown failures", () => {
    expect(
      H.classifyFailure({
        kind: "internal",
        message:
          "There's an issue with the selected model (claude-x). It may not exist or you may not have access to it.",
      }).code,
    ).toBe("model_unavailable");
    expect(
      H.classifyFailure({
        kind: "internal",
        message:
          "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.",
      }).code,
    ).toBe("model_unavailable");
    expect(
      H.classifyFailure({ kind: "signin_missing", message: "" }).code,
    ).toBe("signin_required");
    expect(
      H.classifyFailure({
        kind: "usage_limit",
        message: "Claude usage limit reached. It resets in about 2 hours.",
      }),
    ).toEqual({
      code: "failed",
      message: "Claude usage limit reached. It resets in about 2 hours.",
    });
    // Unknown internal detail is never shown raw.
    expect(
      H.classifyFailure({
        kind: "internal",
        message: "stack trace at /home/agent/x.js:1",
      }).message,
    ).not.toContain("/home/agent");
  });

  test("only chat content is normalized; runs map aborts and steering", async () => {
    const page = await fixture("messages-signed-out-claude.json");
    const run = page.runs[0];
    const kept = run.messages
      .map((m: any) => H.normalizeMessage(m, run.id))
      .filter(Boolean);
    expect(kept.map((m: any) => m.role)).toEqual(["user", "error"]); // the configuration record is dropped
    expect(kept[0]).toMatchObject({
      role: "user",
      text: "Reply with the single word: pong",
      failure: null,
    });
    expect(
      H.normalizeRun({ id: "r", status: "aborted", reason: "abort" }),
    ).toMatchObject({ status: "aborted", failure: { code: "aborted" } });
    expect(
      H.normalizeRun({ id: "r", status: "aborted", reason: "steering" }).status,
    ).toBe("completed");
    const agent = {
      role: "agent",
      id: "a",
      createdAt: 0,
      content: [
        { type: "reasoning", text: "hmm" },
        {
          type: "tool_call",
          id: "t1",
          name: "Bash",
          status: "completed",
          arguments: { command: "ls" },
        },
        { type: "text", text: "pong" },
      ],
    };
    expect(H.normalizeMessage(agent, "r")).toMatchObject({
      role: "assistant",
      text: "pong",
      tools: [{ id: "t1", name: "Bash", status: "completed" }],
    });
  });
});

describe("event mapping", () => {
  const ctx = (): H.EventContext => ({
    conversations: new Set(),
    blockTypes: new Map(),
    runFailures: new Map(),
    questions: new Map(),
  });

  test("real signed-out Claude events become run/message events with a typed failure", async () => {
    const lines = (
      await Bun.file(
        `${import.meta.dir}/fixtures/events-signed-out-claude.jsonl`,
      ).text()
    )
      .trim()
      .split("\n");
    const c = ctx();
    const out = lines.flatMap((l) => H.mapEvent(JSON.parse(l), c));
    expect(out.map((e) => e.type)).toEqual([
      "conversation.message",
      "conversation.run",
      "conversation.message",
      "conversation.message",
      "conversation.run",
    ]);
    expect(out.at(-1)!.data).toMatchObject({
      conversationId: "probeclaude1",
      run: { status: "failed", failure: { code: "signin_required" } },
    });
  });

  test("only the failed turn of real signed-out events names the provider to sign in again", async () => {
    const events = (
      await Bun.file(
        `${import.meta.dir}/fixtures/events-signed-out-claude.jsonl`,
      ).text()
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events.map(H.signinFailure)).toEqual([
      null,
      null,
      null,
      null,
      null,
      { provider: "claude", at: events[5].payload.message.createdAt },
      null,
    ]);
  });

  test("assistant text deltas pass, reasoning deltas and unknown conversations do not", () => {
    const c = ctx();
    c.conversations.add("conv1");
    H.mapEvent(
      {
        type: "message.created",
        payload: {
          agentId: "conv1",
          runId: "r",
          message: {
            id: "m",
            role: "agent",
            createdAt: 0,
            content: [
              { type: "reasoning", text: "" },
              { type: "text", text: "" },
            ],
          },
        },
      },
      c,
    );
    const delta = (blockIndex: number, agentId = "conv1") =>
      H.mapEvent(
        {
          type: "message.delta",
          payload: {
            agentId,
            runId: "r",
            messageId: "m",
            blockIndex,
            offset: 0,
            append: "hi",
          },
        },
        c,
      );
    expect(delta(1)).toEqual([
      {
        type: "conversation.delta",
        data: { conversationId: "conv1", messageId: "m", append: "hi" },
      },
    ]);
    expect(delta(0)).toEqual([]);
    expect(delta(1, "chiefofstaffagent")).toEqual([]);
  });

  test("questions are announced and resolved", () => {
    const c = ctx();
    c.conversations.add("conv1");
    const q = {
      id: "q1",
      agentId: "conv1",
      status: "pending",
      questions: [
        {
          id: "q1",
          header: "Bash",
          question: "Allow ls?",
          options: [{ label: "Allow once" }, { label: "Deny" }],
        },
      ],
      permissionRequest: {
        source: "harness",
        server: "claude_code",
        serverTitle: "Claude Code",
      },
    };
    expect(
      H.mapEvent({ type: "question.created", payload: { question: q } }, c)[0]!
        .data,
    ).toMatchObject({
      conversationId: "conv1",
      question: {
        id: "q1",
        kind: "permission",
        askedBy: "Claude Code",
        prompts: [{ options: [{ label: "Allow once" }, { label: "Deny" }] }],
      },
    });
    expect(
      H.mapEvent(
        {
          type: "question.updated",
          payload: { questionId: "q1", changes: { status: "answered" } },
        },
        c,
      )[0]!.data,
    ).toEqual({
      conversationId: "conv1",
      question: { id: "q1", status: "answered" },
    });
    expect(H.questionAnswers(q, "Allow once")).toEqual({ q1: ["Allow once"] });
    expect(H.questionAnswers(q, { q1: ["Deny"] })).toEqual({ q1: ["Deny"] });
    expect(H.questionAnswers(q, 42)).toBeNull();
  });
});

describe("daemon route allowlist", () => {
  test("owner-only and unrelated daemon routes are unreachable", () => {
    const denied: [string, string][] = [
      ["POST", "/v0/shutdown"],
      ["POST", "/v0/drain"],
      ["POST", "/v0/debug/inspector"],
      ["DELETE", "/v0/debug/inspector"],
      ["PATCH", "/v0/config"],
      ["PUT", "/v0/config/security"],
      ["POST", "/v0/bots"],
      ["PATCH", "/v0/bots/abc123"],
      ["POST", "/v0/bots/abc123/unarchive"],
      ["GET", "/v0/connections"],
      ["POST", "/v0/connections/servers"],
      ["GET", "/v0/connections/abc/api/v0/config"],
      ["POST", "/v0/integrations/happy/start"],
      ["POST", "/v0/mobile-connector/pairing"],
      ["POST", "/v0/provider-routes/claude/use"],
      ["POST", "/v0/provider-clis/claude/install"],
      ["POST", "/v0/provider-clis/grok/sign-in"],
      ["POST", "/v0/secrets"],
      ["GET", "/v0/workspaces/chats/terminals"],
      ["GET", "/v0/projects"],
      ["GET", "/v0/projects/other"],
      ["POST", "/v0/agents/abc123/compact"],
      ["GET", "/v0/agents/ABC/messages"],
      ["GET", "/v0/agents/abc/../../shutdown"],
    ];
    for (const [method, path] of denied)
      expect(`${method} ${path} ${H.isAllowed(method, path)}`).toBe(
        `${method} ${path} false`,
      );
    expect(
      H.isAllowed(
        "GET",
        "/v0/agents/abc123/messages?limit=50&omitToolData=true",
      ),
    ).toBe(true);
    expect(H.isAllowed("POST", "/v0/provider-clis/claude/sign-in/code")).toBe(
      true,
    );
  });

  test("a disallowed call never leaves the gateway", async () => {
    let calls = 0;
    const d = new H.Daemon(
      {
        key: "k",
        url: "http://127.0.0.1:9",
        token: "t".repeat(43),
        startedAt: 0,
      },
      (async () => {
        calls++;
        return new Response("{}");
      }) as unknown as typeof fetch,
    );
    for (const path of ["/v0/shutdown", "/v0/drain"])
      await expect(d.call("POST", path, {})).rejects.toThrow("not allowed");
    await expect(d.call("PATCH", "/v0/config", { providers: {} })).rejects.toThrow(
      "not allowed",
    );
    expect(calls).toBe(0);
  });
});
