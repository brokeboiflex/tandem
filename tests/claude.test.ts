// ClaudeAgent's pure mappings: Claude Code's models, account, context, usage and failures in the
// façade's terms, and the questions it asks.
import { describe, expect, test } from "bun:test";
import type { SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import {
  claudeAccount,
  claudeContext,
  claudeFailure,
  claudeModels,
  claudeUsage,
  effortOf,
  modelAlias,
  permissionAsk,
  questionAnswers,
  questionAsk,
  sandboxEnv,
  toolSummary,
} from "../src/agents/claude";

const fixture = await Bun.file(`${import.meta.dir}/fixtures/claude-initialize.json`).json();
const models = fixture.response.response.models;

describe("models", () => {
  test("catalog ids and names as Claude Code names them; the default by what it resolves to", () => {
    const catalog = claudeModels(models);
    expect(catalog.map((m) => m.id)).toEqual(models.map((m: any) => `claude-code/${m.value}`));
    const name = (id: string) => catalog.find((m) => m.id === `claude-code/${id}`)!.name;
    // As the façade's claudeModelNames named them from the same answer.
    expect(name("default")).toBe("Sonnet 5.5");
    expect(name("opus")).toBe("Opus 5.5");
    expect(name("fable")).toBe("Fable 5.2");
    expect(name("haiku")).toBe("Haiku 5.5");
    expect(name("claude-opus-4-6")).toBe("Opus 4.6");
    expect(catalog.filter((m) => m.default).map((m) => m.id)).toEqual(["claude-code/default"]);
    expect(catalog.find((m) => m.id === "claude-code/opus")!.default).toBeUndefined();
  });

  test("efforts are the model's own; Claude Code resolves default effort and compaction itself", () => {
    const [m] = claudeModels([
      { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
    ]);
    expect(m).toEqual({ id: "claude-code/opus", name: "Opus 5.5", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: null, contextLimit: null });
    expect(claudeModels([{ value: "haiku", displayName: "Haiku", description: "", supportsEffort: false }])[0]!.efforts).toEqual([]);
  });

  test("a default whose model is not listed has no name yet", () => {
    const [d] = claudeModels([{ value: "default", resolvedModel: "claude-x", displayName: "Default (recommended)", description: "" }]);
    expect(d).toMatchObject({ id: "claude-code/default", name: null, default: true });
  });

  test("catalog id → the SDK's model; the default is no model at all", () => {
    expect(modelAlias("claude-code/default")).toBeUndefined();
    expect(modelAlias("claude-code/opus")).toBe("opus");
    expect(modelAlias("claude-code/claude-opus-4-6")).toBe("claude-opus-4-6");
    expect(effortOf("xhigh")).toBe("xhigh");
    expect(effortOf("turbo")).toBeUndefined();
    expect(effortOf(null)).toBeUndefined();
  });
});

describe("account", () => {
  test("an API key, a subscription, nothing", () => {
    expect(claudeAccount({ tokenSource: "none", apiKeySource: "ANTHROPIC_API_KEY" })).toEqual({ signedIn: true, account: { email: null, plan: "API key" } });
    expect(claudeAccount({ tokenSource: "claude.ai", email: "a@example.com", subscriptionType: "max" })).toEqual({ signedIn: true, account: { email: "a@example.com", plan: "Max" } });
    expect(claudeAccount({ tokenSource: "claude.ai", subscriptionType: "team_premium" }).account!.plan).toBe("Team Premium");
    expect(claudeAccount({ tokenSource: "none" })).toEqual({ signedIn: false, account: null });
    expect(claudeAccount(undefined)).toEqual({ signedIn: false, account: null });
  });
});

describe("context and usage", () => {
  const usage = (o: Partial<SDKControlGetContextUsageResponse>) =>
    ({ totalTokens: 14666, maxTokens: 1_000_000, rawMaxTokens: 1_000_000, autoCompactThreshold: 967_000, isAutoCompactEnabled: true, apiUsage: { input_tokens: 1200, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, ...o }) as SDKControlGetContextUsageResponse;

  test("the limit is where Claude Code compacts automatically, else its window", () => {
    expect(claudeContext(usage({}))).toEqual({ usedTokens: 14666, limitTokens: 967_000, approximate: false });
    expect(claudeContext(usage({ isAutoCompactEnabled: false }))).toEqual({ usedTokens: 14666, limitTokens: 1_000_000, approximate: false });
    expect(claudeContext(usage({ apiUsage: null }))!.approximate).toBe(true);
    expect(claudeContext(null)).toBeNull();
  });

  test("lifetime tokens on the main model only", () => {
    const mu: any = {
      "claude-opus-5-5": { inputTokens: 2400, outputTokens: 40, cacheReadInputTokens: 7, cacheCreationInputTokens: 3, canonicalModel: "claude-opus-5-5" },
      "claude-haiku-5-5": { inputTokens: 99, outputTokens: 9, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    };
    expect(claudeUsage(mu, "claude-opus-5-5")).toEqual({ input: 2400, output: 40, cacheRead: 7, cacheWrite: 3 });
    expect(claudeUsage({ "us.anthropic.claude-opus-5-5": mu["claude-opus-5-5"] }, "claude-opus-5-5")!.input).toBe(2400);
    expect(claudeUsage(mu, "claude-sonnet-5-5")).toBeNull();
    expect(claudeUsage({}, null)).toBeNull();
  });
});

describe("failures", () => {
  const code = (e: Parameters<typeof claudeFailure>[0]) => claudeFailure(e, "claude-code/opus");
  test("sign-in: Claude Code's own error, a 401, its words", () => {
    expect(code({ error: "authentication_failed", text: "Not logged in · Please run /login" })).toMatchObject({ code: "signin_required", params: { provider: "claude" } });
    expect(code({ status: 401 }).code).toBe("signin_required");
    expect(code({ text: "Invalid API key · Fix external API key" }).code).toBe("signin_required");
  });

  test("a spent window is usage_limit with its reset; a throttle is rate_limited", () => {
    const f = code({ error: "rate_limit", text: "You've hit your 5-hour limit · resets 4:52pm", rateLimit: { status: "rejected", resetsAt: 1795276344, isUsingOverage: false } });
    expect(f).toEqual({ code: "usage_limit", message: "You've hit your 5-hour limit · resets 4:52pm", params: { provider: "claude", resetsAt: "2026-11-21T15:52:24.000Z" } });
    expect(code({ error: "rate_limit", text: "API Error: Request rejected (429)", rateLimit: { status: "rejected", resetsAt: 1795276344, isUsingOverage: true } }).code).toBe("rate_limited");
    expect(code({ error: "rate_limit", text: "API Error: Request rejected (429) · This request would exceed your account's rate limit." })).toMatchObject({ code: "rate_limited", params: { provider: "claude" } });
    expect(code({ error: "billing_error", text: "Credit balance is too low" })).toEqual({ code: "usage_limit", message: "Credit balance is too low", params: { provider: "claude", resetsAt: null } });
  });

  test("model, context, outage, network, anything else", () => {
    expect(code({ error: "model_not_found", text: "There's an issue with the selected model" }).code).toBe("model_unavailable");
    expect(code({ error: "invalid_request", text: "Prompt is too long" })).toMatchObject({ code: "context_too_long", params: { model: "claude-code/opus" } });
    expect(code({ error: "overloaded", text: "Overloaded" }).code).toBe("provider_unavailable");
    expect(code({ status: 503 }).code).toBe("provider_unavailable");
    expect(code({ text: "connect ECONNREFUSED 127.0.0.1:4750" }).code).toBe("network");
    expect(code({ text: "something odd" })).toEqual({ code: "failed", message: expect.any(String), params: {} });
  });
});

describe("questions", () => {
  test("a permission question per tool call", () => {
    expect(permissionAsk("Bash", { command: "ls -la" }, "needs approval")).toEqual({
      kind: "permission",
      askedBy: "Claude Code",
      context: "needs approval",
      prompts: [{ id: "permission", header: "Bash", question: "Allow running `ls -la`?", multiSelect: false, options: [{ label: "Allow once", description: null }, { label: "Deny", description: null }] }],
    });
    expect(toolSummary("Write", { file_path: "/w/a.txt" })).toBe("writing /w/a.txt");
    expect(toolSummary("WebFetch", { url: "https://x.test" })).toBe("fetching https://x.test");
    expect(toolSummary("mcp__crm__lookup_customer", { id: "1" })).toBe("lookup_customer (crm)");
    expect(toolSummary("Bash", { command: "x".repeat(500) }).length).toBeLessThan(220);
  });

  test("AskUserQuestion: its questions as prompts; answers keyed by question text, several joined", () => {
    const input = {
      questions: [
        { question: "Which color?", header: "Color", multiSelect: false, options: [{ label: "Red", description: "Warm" }, { label: "Blue", description: "Cool" }] },
        { question: "Which sizes?", header: "Size", multiSelect: true, options: [{ label: "S", description: "" }, { label: "M", description: "" }, { label: "L", description: "" }] },
      ],
    };
    const ask = questionAsk(input);
    expect(ask.kind).toBe("question");
    expect(ask.prompts.map((p) => [p.id, p.header, p.question, p.multiSelect, p.options.map((o) => o.label)])).toEqual([
      ["q1", "Color", "Which color?", false, ["Red", "Blue"]],
      ["q2", "Size", "Which sizes?", true, ["S", "M", "L"]],
    ]);
    expect(questionAnswers(input, { q1: ["Blue"], q2: ["S", "L"] })).toEqual({ ...input, answers: { "Which color?": "Blue", "Which sizes?": "S, L" } });
  });
});

test("only Claude Code's and the SDK's variables go to the sandbox", () => {
  expect(sandboxEnv({ PATH: "/x", HOME: "/h", ANTHROPIC_API_KEY: "k", CLAUDE_CODE_ENTRYPOINT: "sdk-ts", CLAUDE_AGENT_SDK_VERSION: "0.3.330", OPENAI_API_KEY: "no", CLAUDE_UNSET: undefined })).toEqual({
    ANTHROPIC_API_KEY: "k",
    CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
    CLAUDE_AGENT_SDK_VERSION: "0.3.330",
  });
});
