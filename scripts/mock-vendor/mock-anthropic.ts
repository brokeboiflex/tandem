// A scripted Anthropic Messages API for hermetic proofs. A marker in the person's last message picks
// the scenario; a tool result is echoed back as `TOOL_RESULT_SEEN <result>`.
//
//   RUN_TOOL        one Bash call (a probe of the sandbox: uid, capabilities, network)
//   ASK_QUESTION    one AskUserQuestion call ("Which color?": Red / Blue)
//   CALL_MCP        lookup_customer of the MCP server (through ToolSearch when the tool is deferred)
//   SLOW            text streamed slowly for ~12 s (to abort mid-turn)
//   RUN_SLOW        one Bash call that sleeps for minutes (to abort mid-command)
//   REMEMBER <w>    "OK"; a later RECALL answers "RECALLED <w>" from the history it was sent
//   AUTH_FAIL       401 authentication_error
//   USAGE_LIMIT     429 with the unified rate-limit headers of a spent subscription window
//
// Requests without tools (Claude Code's side calls, such as titles) always get plain text.
import { appendFileSync } from "node:fs";

const PROBE =
  "id -u; grep -E 'CapEff|NoNewPrivs|Seccomp:' /proc/self/status; echo TMP=$TMPDIR; curl -sS -m 5 -o /dev/null -w 'net=%{http_code}' https://example.com || echo net=blocked";
/** When USAGE_LIMIT says the window resets (epoch seconds), two hours after the mock started. */
export const USAGE_RESET = Math.floor(Date.now() / 1000) + 2 * 3600;

export type MockRequest = {
  method: string;
  path: string;
  model: string | null;
  messages: number;
  tools: string[];
  /** Every text the request carried in its messages, for checking what history was sent. */
  text: string;
  scenario: string | null;
};

const sse = (events: [string, unknown][]) =>
  events
    .map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)
    .join("");

const usage = {
  input_tokens: 1200,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

function events(
  model: string,
  blocks: any[],
  stop: string,
): [string, unknown][] {
  const ev: [string, unknown][] = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: `msg_${crypto.randomUUID().slice(0, 12)}`,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage,
        },
      },
    ],
  ];
  blocks.forEach((b, i) => {
    if (b.type === "text") {
      ev.push([
        "content_block_start",
        {
          type: "content_block_start",
          index: i,
          content_block: { type: "text", text: "" },
        },
      ]);
      ev.push([
        "content_block_delta",
        {
          type: "content_block_delta",
          index: i,
          delta: { type: "text_delta", text: b.text },
        },
      ]);
    } else {
      ev.push([
        "content_block_start",
        {
          type: "content_block_start",
          index: i,
          content_block: {
            type: "tool_use",
            id: b.id,
            name: b.name,
            input: {},
          },
        },
      ]);
      ev.push([
        "content_block_delta",
        {
          type: "content_block_delta",
          index: i,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(b.input),
          },
        },
      ]);
    }
    ev.push(["content_block_stop", { type: "content_block_stop", index: i }]);
  });
  ev.push([
    "message_delta",
    {
      type: "message_delta",
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: 20 },
    },
  ]);
  ev.push(["message_stop", { type: "message_stop" }]);
  return ev;
}

const stream = (
  body: string | ReadableStream,
  headers: Record<string, string> = {},
) =>
  new Response(body, {
    headers: { "content-type": "text/event-stream", ...headers },
  });
const reply = (model: string, blocks: any[], stop = "end_turn") =>
  stream(sse(events(model, blocks, stop)));
const text = (model: string, t: string) =>
  reply(model, [{ type: "text", text: t }]);
const toolUse = (
  model: string,
  name: string,
  input: unknown,
  id = `toolu_${crypto.randomUUID().slice(0, 12)}`,
) => reply(model, [{ type: "tool_use", id, name, input }], "tool_use");

/** Text streamed one tick every 300 ms, so a turn can be stopped while it streams. */
function slow(model: string) {
  const [start, ...rest] = events(
    model,
    [{ type: "text", text: "" }],
    "end_turn",
  );
  const enc = new TextEncoder();
  return stream(
    new ReadableStream<Uint8Array>({
      async start(c) {
        try {
          c.enqueue(enc.encode(sse([start!, rest[0]!])));
          for (let i = 1; i <= 40; i++) {
            await Bun.sleep(300);
            c.enqueue(
              enc.encode(
                sse([
                  [
                    "content_block_delta",
                    {
                      type: "content_block_delta",
                      index: 0,
                      delta: { type: "text_delta", text: `tick ${i} ` },
                    },
                  ],
                ]),
              ),
            );
          }
          c.enqueue(enc.encode(sse(rest.slice(2))));
          c.close();
        } catch {} // the client went away
      },
    }),
  );
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((p: any) =>
            p?.type === "text"
              ? p.text
              : p?.type === "tool_result"
                ? textOf(p.content)
                : "",
          )
          .join(" ")
      : "";

export function mockAnthropic(opts: { log?: string } = {}) {
  const requests: MockRequest[] = [];
  const log = (s: string) => {
    try {
      if (opts.log) appendFileSync(opts.log, s + "\n");
    } catch {} // a log folder that does not exist must not fail the request
  };
  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const body: any =
      req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const msgs: any[] = body.messages ?? [];
    const tools: string[] = (body.tools ?? []).map((t: any) => t.name);
    const record: MockRequest = {
      method: req.method,
      path: url.pathname,
      model: body.model ?? null,
      messages: msgs.length,
      tools,
      text: msgs.map((m) => textOf(m.content)).join("\n"),
      scenario: null,
    };
    requests.push(record);
    log(
      `${req.method} ${url.pathname} model=${body.model ?? ""} stream=${body.stream ?? ""} msgs=${msgs.length} tools=${tools.length}`,
    );
    if (url.pathname.endsWith("/count_tokens"))
      return Response.json({ input_tokens: 10 });
    // The cheap key check: a key that starts with sk-ant-good is accepted.
    if (url.pathname === "/v1/models")
      return /^sk-ant-good/.test(req.headers.get("x-api-key") ?? "")
        ? Response.json({
            data: [{ type: "model", id: "claude-mock" }],
            has_more: false,
          })
        : Response.json(
            {
              type: "error",
              error: {
                type: "authentication_error",
                message: "invalid x-api-key",
              },
            },
            { status: 401 },
          );
    if (!url.pathname.startsWith("/v1/messages"))
      return new Response("{}", { status: 404 });
    const model = body.model ?? "claude-mock";
    // Newer Claude Code sends a trailing `system` message (its environment) after the person's.
    const last = [...msgs].reverse().find((m: any) => m.role === "user");
    const parts =
      typeof last?.content === "string"
        ? [{ type: "text", text: last.content }]
        : (last?.content ?? []);
    const result = parts.find((p: any) => p.type === "tool_result");
    const said = parts
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join(" ");
    const scenario = (record.scenario = result
      ? "tool_result"
      : ([
          "AUTH_FAIL",
          "USAGE_LIMIT",
          "RUN_TOOL",
          "ASK_QUESTION",
          "CALL_MCP",
          "RUN_SLOW",
          "SLOW",
          "REMEMBER",
          "RECALL",
        ].find((m) => said.includes(m)) ?? null));
    // Claude Code's own side calls (no tools) never follow a scenario, except the account's refusals.
    if (!tools.length && scenario !== "AUTH_FAIL" && scenario !== "USAGE_LIMIT")
      return text(model, "hello from mock");
    switch (scenario) {
      case "tool_result": {
        // A ToolSearch that found the MCP tool goes on to call it.
        if (String(result.tool_use_id).startsWith("toolu_search")) {
          const mcp = tools.find((t) => t.endsWith("__lookup_customer"));
          if (mcp) return toolUse(model, mcp, { id: "42" });
        }
        const out = textOf(result.content);
        log("TOOL_RESULT " + out.slice(0, 400));
        return text(model, "TOOL_RESULT_SEEN " + out.slice(0, 300));
      }
      case "AUTH_FAIL":
        return Response.json(
          {
            type: "error",
            error: {
              type: "authentication_error",
              message: "invalid x-api-key",
            },
          },
          { status: 401 },
        );
      case "USAGE_LIMIT":
        return Response.json(
          {
            type: "error",
            error: {
              type: "rate_limit_error",
              message: "This request would exceed your account's rate limit.",
            },
          },
          {
            status: 429,
            headers: {
              "anthropic-ratelimit-unified-status": "rejected",
              "anthropic-ratelimit-unified-reset": String(USAGE_RESET),
              "anthropic-ratelimit-unified-representative-claim": "five_hour",
              "anthropic-ratelimit-unified-5h-status": "rejected",
              "anthropic-ratelimit-unified-5h-reset": String(USAGE_RESET),
              "anthropic-ratelimit-unified-5h-utilization": "1.0",
              "anthropic-ratelimit-unified-overage-status": "rejected",
              "anthropic-ratelimit-unified-overage-disabled-reason":
                "org_level_disabled",
              "retry-after": "7200",
            },
          },
        );
      case "RUN_TOOL":
        return toolUse(model, "Bash", { command: PROBE, description: "probe" });
      case "RUN_SLOW":
        return toolUse(model, "Bash", {
          command: "echo started; sleep 300; echo late",
          description: "a long command",
          timeout: 600000,
        });
      case "ASK_QUESTION":
        return toolUse(model, "AskUserQuestion", {
          questions: [
            {
              question: "Which color?",
              header: "Color",
              multiSelect: false,
              options: [
                { label: "Red", description: "Warm" },
                { label: "Blue", description: "Cool" },
              ],
            },
          ],
        });
      case "CALL_MCP": {
        const mcp = tools.find((t) => t.endsWith("__lookup_customer"));
        if (mcp) return toolUse(model, mcp, { id: "42" });
        if (tools.includes("ToolSearch"))
          return toolUse(
            model,
            "ToolSearch",
            { query: "select:mcp__stub__lookup_customer", max_results: 1 },
            `toolu_search_${crypto.randomUUID().slice(0, 8)}`,
          );
        return text(model, "NO_MCP_TOOL");
      }
      case "SLOW":
        return slow(model);
      case "REMEMBER":
        return text(model, "OK");
      case "RECALL": {
        const word = record.text.match(/REMEMBER (\w+)/)?.[1];
        return text(model, `RECALLED ${word ?? "nothing"}`);
      }
      default:
        return text(model, "hello from mock");
    }
  }
  return { handle, requests };
}

/** The proofs' default instance, logging to MOCK_LOG. */
export const { handle } = mockAnthropic({
  log: process.env.MOCK_LOG ?? "/tmp/poc/mock.log",
});
