// One scripted vendor API for hermetic proofs. It speaks Anthropic Messages, OpenAI Responses,
// OpenAI chat completions (OpenRouter, xAI) and Gemini generateContent, dispatched by path, plus the
// model lists, key checks and xAI's device sign-in the agents use. What a turn does depends on the
// person's latest message:
//
//   RUN_TOOL    one call of the agent's own shell tool (an identity probe); its result -> text
//   RUN_SLOW    a shell call that sleeps for minutes (for aborting)
//   RUN_MCP     a call of the MCP tool lookup_customer
//   REMEMBER x  (any message) and later RECALL -> "RECALLED x" when the history still holds it
//   FAIL_401 / FAIL_429 / FAIL_QUOTA   the vendor's own error for a refused key, a rate limit, a
//               used-up quota or credit balance
//   anything else -> "hello from mock"
//
// Anything else is logged (MOCK_LOG).
import { handle as anthropic } from "./mock-anthropic";
import { handle as responses } from "./mock-openai";
import { handle as grokResponses } from "./mock-responses";
import { decide, log, type Tool } from "./script";
async function chat(body: any, openrouter: boolean) {
  const msgs = body.messages ?? [];
  const last = msgs.at(-1);
  const users = msgs.filter((m: any) => m.role === "user");
  const tools: Tool[] = (body.tools ?? []).map((t: any) => ({
    name: t.function?.name,
    schema: t.function?.parameters,
  }));
  log(
    `chat model=${body.model} tools=${tools.map((t) => t.name).join(",")} last=${last?.role} reasoning=${JSON.stringify(body.reasoning ?? body.reasoning_effort ?? null)}`,
  );
  const d = decide(
    users.at(-1),
    msgs.slice(0, msgs.lastIndexOf(users.at(-1))),
    last?.role === "tool"
      ? typeof last.content === "string"
        ? last.content
        : JSON.stringify(last.content)
      : null,
    tools,
  );
  if ("fail" in d) {
    log("FAIL " + d.fail);
    // OpenRouter's and xAI's own error bodies.
    if (d.fail === "401")
      return Response.json(
        {
          error: {
            message: openrouter
              ? "No auth credentials found"
              : "Incorrect API key provided",
            code: 401,
          },
        },
        { status: 401 },
      );
    if (d.fail === "429")
      return Response.json(
        {
          error: {
            message: "Rate limit exceeded: too many requests",
            code: 429,
          },
        },
        { status: 429 },
      );
    return openrouter
      ? Response.json(
          {
            error: {
              message:
                "Insufficient credits. Add more using https://openrouter.ai/settings/credits",
              code: 402,
            },
          },
          { status: 402 },
        )
      : Response.json(
          {
            code: "subscription:free-usage-exhausted",
            error: "You have used up your free usage for this period.",
          },
          { status: 429 },
        );
  }
  const chunk = (delta: any, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "c" + Date.now(), object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  let out =
    "text" in d
      ? chunk({ role: "assistant", content: d.text }) + chunk({}, "stop")
      : chunk({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_" + Date.now(),
              type: "function",
              function: {
                name: d.call.name,
                arguments: JSON.stringify(d.call.args),
              },
            },
          ],
        }) + chunk({}, "tool_calls");
  out += `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020 } })}\n\ndata: [DONE]\n\n`;
  return new Response(out, {
    headers: { "content-type": "text/event-stream" },
  });
}

async function gemini(body: any, stream: boolean) {
  const contents = body.contents ?? [];
  const last = contents.at(-1);
  // agy wraps the person's message in <USER_REQUEST> and may add its own user-role notes after it.
  const all = contents.filter(
    (c: any) =>
      c.role === "user" && !c.parts?.some((p: any) => p.functionResponse),
  );
  const requests = all.filter((c: any) => JSON.stringify(c).includes("USER_REQUEST"));
  const users = requests.length ? requests : all;
  const tools: Tool[] = (body.tools ?? []).flatMap((t: any) =>
    (t.functionDeclarations ?? []).map((f: any) => ({
      name: f.name,
      schema: f.parameters ?? f.parametersJsonSchema,
    })),
  );
  log(`gemini roles=${contents.map((c: any) => (c.role ?? "?") + (c.parts?.some((p: any) => p.functionResponse) ? "(fr)" : "")).join(",")} lastUser=${JSON.stringify(users.at(-1) ?? null).slice(0, 120)}`);
  log(
    `gemini tools=${tools.map((t) => t.name).join(",")} thinking=${JSON.stringify(body.generationConfig?.thinkingConfig ?? null)}`,
  );
  const fr = last?.parts?.find((p: any) => p.functionResponse);
  const d = decide(
    users.at(-1),
    contents.slice(0, contents.lastIndexOf(users.at(-1))),
    fr ? JSON.stringify(fr.functionResponse.response) : null,
    tools,
  );
  if ("fail" in d) {
    log("FAIL " + d.fail);
    // Google's own error bodies: a refused key is a 400 API_KEY_INVALID.
    const [status, code, message, reason] =
      d.fail === "401"
        ? [
            400,
            "INVALID_ARGUMENT",
            "API key not valid. Please pass a valid API key.",
            "API_KEY_INVALID",
          ]
        : d.fail === "429"
          ? [
              429,
              "RESOURCE_EXHAUSTED",
              "Resource has been exhausted (e.g. check quota).",
              "RATE_LIMIT_EXCEEDED",
            ]
          : [
              429,
              "RESOURCE_EXHAUSTED",
              "You exceeded your current quota, please check your plan and billing details.",
              "QUOTA_EXCEEDED",
            ];
    return Response.json(
      {
        error: {
          code: status,
          message,
          status: code,
          details: [
            { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason },
          ],
        },
      },
      { status },
    );
  }
  const parts =
    "text" in d
      ? [{ text: d.text }]
      : [{ functionCall: { name: d.call.name, args: d.call.args } }];
  const resp = {
    candidates: [
      { content: { role: "model", parts }, finishReason: "STOP", index: 0 },
    ],
    usageMetadata: {
      promptTokenCount: 1000,
      candidatesTokenCount: 20,
      totalTokenCount: 1020,
    },
    modelVersion: "gemini-mock",
  };
  return stream
    ? new Response(`data: ${JSON.stringify(resp)}\r\n\r\n`, {
        headers: { "content-type": "text/event-stream" },
      })
    : Response.json(resp);
}

// ---------------------------------------------------------------------------------------------
// Model lists, key checks, xAI's device sign-in

/** OpenRouter's public model list, for Tandem's six. */
const OPENROUTER_MODELS = [
  [
    "deepseek/deepseek-v4.1-flash-1017",
    "DeepSeek: DeepSeek V4.1 Flash 1017",
    1048576,
  ],
  ["openai/gpt-6.2-sol", "OpenAI: GPT-6.2 Sol", 1050000],
  ["x-ai/grok-4.7", "SpaceXAI: Grok 4.7", 500000],
  ["qwen/qwen4-max", "Qwen: Qwen4 Max", 1000000],
  ["moonshotai/kimi-k3.1-pro", "MoonshotAI: Kimi K3.1 Pro", 1048576],
  ["z-ai/glm-5.3-prime", "Z.ai: GLM 5.3 Prime", 1000000],
] as const;
/** xAI's model list as Grok Build reads it. */
const XAI_MODELS = [
  {
    id: "grok-4.6",
    name: "Grok 4.6",
    contextWindow: 500000,
    apiBackend: "chat_completions",
    reasoningEfforts: [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High", default: true },
    ],
  },
  {
    id: "grok-build",
    name: "Grok Build",
    contextWindow: 256000,
    apiBackend: "chat_completions",
  },
];

/** The device codes the proof approved, by device code. */
const approved = new Set<string>();
let deviceSeq = 0;
/** Approves a pending device sign-in, as the person would on xAI's page. */
export function approveDevice(userCode: string) {
  approved.add(`dev-${userCode}`);
}
const b64 = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString("base64url");

export async function handle(req: Request) {
  const url = new URL(req.url);
  const p = url.pathname;
  if (p.startsWith("/v1/messages")) return anthropic(req);
  // Grok Build signed in calls cli-chat-proxy's Responses API at its root; Codex calls /v1/responses.
  if (p === "/responses") return grokResponses(req);
  if (p.endsWith("/responses")) return responses(req);
  const text = req.method === "POST" ? await req.text() : "";
  log(
    `${req.method} ${p}${url.search} ${text.slice(0, 160).replace(/\s+/g, " ")}`,
  );
  // xAI's device sign-in at the issuer (GROK_OAUTH2_ISSUER): a code, pending until approved.
  if (p.endsWith("/oauth2/device/code")) {
    const userCode = `MOCK-${1000 + ++deviceSeq}`;
    return Response.json({
      device_code: `dev-${userCode}`,
      user_code: userCode,
      verification_uri: "https://device.mock.invalid/activate",
      verification_uri_complete: `https://device.mock.invalid/activate?user_code=${userCode}`,
      expires_in: 600,
      interval: 1,
    });
  }
  if (p.endsWith("/oauth2/token")) {
    const device = new URLSearchParams(text).get("device_code") ?? "";
    if (!approved.has(device))
      return Response.json({ error: "authorization_pending" }, { status: 400 });
    const idToken = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "mock-user", email: "person@mock.invalid" })}.sig`;
    return Response.json({
      access_token: `mock-access-${device}`,
      refresh_token: "mock-refresh",
      expires_in: 86400,
      token_type: "Bearer",
      id_token: idToken,
    });
  }
  if (p === "/v1/user" || p === "/user")
    return Response.json({ userId: "mock-user", email: "person@mock.invalid" });
  const body = text && text.trim().startsWith("{") ? JSON.parse(text) : {};
  if (p.endsWith("/chat/completions"))
    return chat(body, p.startsWith("/api/v1"));
  if (/:(stream)?generateContent$/i.test(p))
    return gemini(body, /stream/i.test(p));
  // Key checks: OpenRouter's /key and Google's model list. A key containing "bad" is refused.
  if (p === "/api/v1/key") {
    const auth = req.headers.get("authorization") ?? "";
    return /bad/.test(auth) || !auth
      ? new Response('{"error":{"message":"User not found.","code":401}}', {
          status: 401,
        })
      : Response.json({
          data: {
            label: "sk-or-…",
            usage: 0,
            limit: null,
            is_free_tier: false,
          },
        });
  }
  if (
    p === "/v1beta/models" &&
    req.headers.has("x-goog-api-key") &&
    /bad/.test(req.headers.get("x-goog-api-key")!)
  )
    return Response.json(
      {
        error: {
          code: 400,
          message: "API key not valid. Please pass a valid API key.",
          status: "INVALID_ARGUMENT",
        },
      },
      { status: 400 },
    );
  if (p === "/api/v1/models")
    return Response.json({
      data: OPENROUTER_MODELS.map(([id, name, context_length]) => ({
        id,
        name,
        context_length,
        supported_parameters: id.includes("kimi")
          ? ["tools", "tool_choice"]
          : ["tools", "tool_choice", "reasoning", "include_reasoning"],
      })),
    });
  if (p.endsWith("/models"))
    return Response.json({
      object: "list",
      data: XAI_MODELS,
      models: [
        {
          name: "models/gemini-mock",
          displayName: "Gemini Mock",
          supportedGenerationMethods: ["generateContent"],
        },
      ],
    });
  return Response.json({});
}
