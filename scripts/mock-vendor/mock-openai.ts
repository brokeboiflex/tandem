// A scripted OpenAI Responses API. The person's latest message picks the script:
//   RUN_TOOL       one call of the agent's shell tool (PROBE, which writes probe.txt), then text
//   RUN_DANGEROUS  a shell call Codex itself asks about (`rm -f`), which writes removed.txt
//   RUN_SLOW       a shell call that sleeps for a minute (for aborting mid-turn)
//   RUN_MCP        the stub MCP server's `lookup_customer`
//   RUN_CONFIRM    the stub MCP server's `confirm_action` (approval, then the server's own question)
//   RUN_ASK        Codex's `request_user_input` with two options
//   FAIL_401       HTTP 401, as for a revoked sign-in
//   FAIL_USAGE     HTTP 429 `usage_limit_reached` with a reset time (body and rate-limit headers)
//   RECALL         text naming every earlier message of the person it was sent (proves history)
// A tool's result always answers with "TOOL_RESULT_SEEN <output>"; anything else "hello from mock".
// Codex's catalog models run in code mode: their only tool is `exec`, JavaScript that calls the
// nested tools (`await tools.exec_command({ cmd })`), offered in an `additional_tools` input item;
// then each call above is a script making that one call.
// It is also OpenAI's sign-in issuer for `codex login --device-auth --experimental_issuer <origin>`
// (device code, then tokens whose id_token names DEVICE_EMAIL on a Plus plan).
import { appendFileSync } from "node:fs";
const log = (s: string) =>
  appendFileSync(process.env.MOCK_LOG ?? "/tmp/poc/mock.log", s + "\n");
const PROBE =
  "id -u; grep -E 'CapEff|NoNewPrivs|Seccomp:' /proc/self/status; echo TMP=$TMPDIR; echo hi > probe.txt && cat probe.txt";
/** When FAIL_USAGE says the limit resets (Unix seconds); fixed so tests can compare it. */
export const USAGE_RESETS_AT = 1_893_456_000; // 2030-01-01T00:00:00Z
const sse = (events: any[]) =>
  events
    .map((d) => `event: ${d.type}\ndata: ${JSON.stringify(d)}\n\n`)
    .join("");
const done = (id: string, items: any[]) =>
  new Response(
    sse([
      { type: "response.created", response: { id } },
      ...items.map((item, i) => ({
        type: "response.output_item.done",
        output_index: i,
        item,
      })),
      {
        type: "response.completed",
        response: {
          id,
          usage: {
            input_tokens: 1000,
            input_tokens_details: { cached_tokens: 100 },
            output_tokens: 20,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 1020,
          },
        },
      },
    ]),
    { headers: { "content-type": "text/event-stream" } },
  );
const say = (id: string, text: string) =>
  done(id, [
    {
      type: "message",
      role: "assistant",
      id: "m" + id,
      content: [{ type: "output_text", text }],
    },
  ]);
const textOf = (item: any): string =>
  typeof item?.content === "string"
    ? item.content
    : (item?.content ?? []).map((c: any) => c.text ?? "").join("");
/** The person's own messages: user messages minus the context Codex adds (`<environment_context>`, AGENTS.md). */
const personMessages = (items: any[]) =>
  items
    .filter((i) => i?.type === "message" && i.role === "user")
    .map(textOf)
    .filter(
      (t) =>
        t && !t.trimStart().startsWith("<") && !t.startsWith("# AGENTS.md"),
    );
/** Every tool the request offers; Codex groups each MCP server's tools in a namespace (`mcp__<server>`). */
function toolNames(tools: any[]): string[] {
  return tools.flatMap((t: any) =>
    t.type === "namespace"
      ? (t.tools ?? []).map((s: any) => `${t.name}/${s.name}`)
      : [t.name ?? t.type],
  );
}
export const DEVICE_USER_CODE = "TEST-12345";
export const DEVICE_EMAIL = "person@example.com";
/** An unsigned JWT: Codex reads its claims and never checks a signature. */
export const fakeJwt = (claims: Record<string, unknown>) =>
  [{ alg: "none", typ: "JWT" }, claims]
    .map((p) => Buffer.from(JSON.stringify(p)).toString("base64url"))
    .join(".") + ".sig";
export const idToken = (email = DEVICE_EMAIL, plan = "plus") =>
  fakeJwt({
    email,
    exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    "https://api.openai.com/auth": {
      chatgpt_plan_type: plan,
      chatgpt_account_id: "acct-test",
      chatgpt_user_id: "user-test",
    },
  });
const polls = new Map<string, number>();
/** The issuer's device-code and token endpoints; the first poll is still pending (403). */
async function auth(req: Request, path: string) {
  const body = await req.text();
  log(`AUTH ${req.method} ${path}`);
  if (path.endsWith("/deviceauth/usercode"))
    return Response.json({ device_auth_id: "dev-test", user_code: DEVICE_USER_CODE, interval: "1" });
  if (path.endsWith("/deviceauth/token")) {
    const n = (polls.get(body) ?? 0) + 1;
    polls.set(body, n);
    return n === 1
      ? Response.json({ error: "authorization_pending" }, { status: 403 })
      : Response.json({ authorization_code: "code-test", code_challenge: "challenge-test", code_verifier: "verifier-test" });
  }
  if (path === "/oauth/token")
    return Response.json({
      id_token: idToken(),
      access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      refresh_token: "refresh-test",
    });
  return Response.json({});
}
export async function handle(req: Request) {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/accounts/") || url.pathname.startsWith("/oauth/"))
    return auth(req, url.pathname);
  const body: any =
    req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const tools = toolNames(body.tools ?? []);
  log(
    `${req.method} ${url.pathname} model=${body.model ?? ""} items=${body.input?.length ?? ""} tools=${tools.join(",")}`,
  );
  if (url.pathname.endsWith("/models"))
    return Response.json({ object: "list", data: [], models: [] });
  if (!url.pathname.endsWith("/responses"))
    return new Response("{}", { status: 404 });
  const id = "resp_" + Date.now();
  const items: any[] = body.input ?? [];
  const last = items.at(-1);
  if (
    last?.type === "function_call_output" ||
    last?.type === "custom_tool_call_output"
  ) {
    const out =
      typeof last.output === "string"
        ? last.output
        : JSON.stringify(last.output);
    log("TOOL_RESULT " + out.slice(0, 500));
    return say(id, "TOOL_RESULT_SEEN " + out.slice(0, 300));
  }
  /** Code mode's nested tools, by their JavaScript names (`exec_command`, `mcp__app__lookup_customer`). */
  const nested = items
    .filter((i) => i?.type === "additional_tools")
    .flatMap((i) => i.tools ?? [])
    .flatMap((t: any) => (t.type === "namespace" ? t.tools ?? [] : [t]))
    .find((t: any) => t.type === "custom" && t.name === "exec");
  const script = (source: string) => {
    log(`CALL exec ${JSON.stringify(source)}`);
    return done(id, [
      {
        type: "custom_tool_call",
        id: "ctc" + id,
        call_id: "call_" + Date.now(),
        name: "exec",
        input: source,
      },
    ]);
  };
  const mine = personMessages(items);
  const text = mine.at(-1) ?? JSON.stringify(last ?? {});
  const call = (tool: string, args: unknown) => {
    log(`CALL ${tool} ${JSON.stringify(args)}`);
    const [namespace, name] = tool.includes("/") ? tool.split("/") : [undefined, tool];
    return done(id, [
      {
        type: "function_call",
        id: "fc" + id,
        call_id: "call_" + Date.now(),
        name,
        ...(namespace ? { namespace } : {}),
        arguments: JSON.stringify(args),
      },
    ]);
  };
  const shell = (cmd: string, extra: Record<string, unknown> = {}) => {
    if (nested && /\bexec_command\(/.test(nested.description ?? ""))
      return script(
        `const r = await tools.exec_command(${JSON.stringify({ cmd, ...extra })});\ntext(typeof r === "string" ? r : r.output ?? JSON.stringify(r));`,
      );
    if (tools.includes("exec_command"))
      return call("exec_command", { cmd, ...extra });
    if (tools.includes("shell_command"))
      return call("shell_command", { command: cmd, ...extra });
    if (tools.includes("shell"))
      return call("shell", { command: ["bash", "-lc", cmd], ...extra });
    log("NO SHELL TOOL");
    return say(id, "no shell tool");
  };
  const mcp = (tool: string, args: unknown) => {
    const js = (nested?.description ?? "").match(
      new RegExp(`\\b(mcp__[A-Za-z0-9_]+__${tool})\\(`),
    )?.[1];
    if (js)
      return script(
        `const r = await tools.${js}(${JSON.stringify(args)});\ntext(typeof r === "string" ? r : JSON.stringify(r));`,
      );
    // Deferred (MCP tools are): not in the description, but on `tools` and listed in ALL_TOOLS.
    if (nested)
      return script(
        [
          `const t = ALL_TOOLS.find((x) => x.name.endsWith(${JSON.stringify(tool)}));`,
          `if (!t) { text("no MCP tool ${tool} in " + ALL_TOOLS.map((x) => x.name).join(",")); exit(); }`,
          `const f = tools[t.name] ?? tools[t.name.replace(/[^A-Za-z0-9_$]/g, "_")];`,
          `const r = await f(${JSON.stringify(args)});`,
          `text(typeof r === "string" ? r : JSON.stringify(r));`,
        ].join("\n"),
      );
    const name = tools.find((t) => t.startsWith("mcp__") && t.endsWith(`/${tool}`));
    if (!name) {
      log(`NO MCP TOOL ${tool}`);
      return say(id, `no MCP tool ${tool}`);
    }
    return call(name, args);
  };
  if (text.includes("FAIL_401")) {
    log("FAIL 401");
    return Response.json(
      {
        error: {
          message:
            "Your authentication token has been invalidated. Please try signing in again.",
          type: "invalid_request_error",
          code: "token_invalidated",
        },
      },
      { status: 401 },
    );
  }
  if (text.includes("FAIL_USAGE")) {
    log("FAIL usage_limit_reached");
    return Response.json(
      {
        error: {
          type: "usage_limit_reached",
          message: "The usage limit has been reached",
          plan_type: "plus",
          resets_at: USAGE_RESETS_AT,
        },
      },
      {
        status: 429,
        headers: {
          "x-codex-primary-used-percent": "100",
          "x-codex-primary-window-minutes": "300",
          "x-codex-primary-reset-at": String(USAGE_RESETS_AT),
        },
      },
    );
  }
  // `rm -f` is one of Codex's dangerous commands: it asks even outside its own sandbox.
  if (text.includes("RUN_DANGEROUS"))
    return shell("rm -f doomed.txt && echo removed > removed.txt && cat removed.txt");
  if (text.includes("RUN_SLOW")) return shell("sleep 60; echo slept");
  if (text.includes("RUN_TOOL")) return shell(PROBE);
  if (text.includes("RUN_MCP")) return mcp("lookup_customer", { id: "c-42" });
  if (text.includes("RUN_CONFIRM"))
    return mcp("confirm_action", { action: "send the invoice" });
  if (text.includes("RUN_ASK"))
    return call("request_user_input", {
      questions: [
        {
          id: "colour",
          header: "Colour",
          question: "Which colour should the button be?",
          options: [
            { label: "Blue (Recommended)", description: "Matches the brand." },
            { label: "Green", description: "Stands out." },
          ],
        },
      ],
    });
  if (text.includes("RECALL"))
    return say(id, `RECALLED ${JSON.stringify(mine.slice(0, -1))}`);
  return say(id, "hello from mock");
}
