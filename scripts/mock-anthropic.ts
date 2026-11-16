// Test-only stand-in for the Anthropic Messages API (scripts/e2e-hardening.ts): the first turn asks
// for one Bash tool call, the next turn echoes the tool result. No real account needed.
const sse = (events: [string, unknown][]) =>
  new Response(
    events
      .map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
const message = {
  id: "msg_mock",
  type: "message",
  role: "assistant",
  model: "claude-mock",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};
Bun.serve({
  hostname: "0.0.0.0",
  port: 8080,
  async fetch(req) {
    const url = new URL(req.url);
    const body: any =
      req.method === "POST" ? await req.json().catch(() => ({})) : {};
    console.log(
      req.method,
      url.pathname,
      body.stream ? "stream" : "",
      (body.tools ?? []).length,
      "tools",
    );
    if (url.pathname.endsWith("/count_tokens"))
      return Response.json({ input_tokens: 10 });
    if (!url.pathname.endsWith("/v1/messages"))
      return Response.json(
        { type: "error", error: { type: "not_found_error", message: "mock" } },
        { status: 404 },
      );
    const last = body.messages?.at(-1);
    const blocks = Array.isArray(last?.content)
      ? last.content
      : [{ type: "text", text: String(last?.content ?? "") }];
    const result = blocks.find((b: any) => b.type === "tool_result");
    const bash = (body.tools ?? []).find((t: any) =>
      /^bash$/i.test(t.name),
    )?.name;
    console.log("tools:", (body.tools ?? []).map((t: any) => t.name).join(","));
    const wantsTool =
      !!bash && JSON.stringify(body.messages ?? []).includes("MOCKTOOL");
    let content: any;
    if (result) {
      const text =
        typeof result.content === "string"
          ? result.content
          : (result.content ?? []).map((c: any) => c.text).join("");
      content = { type: "text", text: `TOOL RESULT: ${text.trim()}` };
    } else if (wantsTool)
      content = {
        type: "tool_use",
        id: "toolu_mock1",
        name: bash,
        input: {
          command:
            "cd ~/projects/chats && echo shell-tool-ok > mock-proof.txt && cat mock-proof.txt && id -u && uname -r",
          description: "Write a proof file",
        },
      };
    else content = { type: "text", text: "pong" };
    const stop = content.type === "tool_use" ? "tool_use" : "end_turn";
    if (!body.stream)
      return Response.json({
        ...message,
        content: [content],
        stop_reason: stop,
      });
    const start =
      content.type === "tool_use"
        ? { ...content, input: {} }
        : { type: "text", text: "" };
    const delta =
      content.type === "tool_use"
        ? {
            type: "input_json_delta",
            partial_json: JSON.stringify(content.input),
          }
        : { type: "text_delta", text: content.text };
    return sse([
      [
        "message_start",
        {
          type: "message_start",
          message: { ...message, content: [], stop_reason: null },
        },
      ],
      [
        "content_block_start",
        { type: "content_block_start", index: 0, content_block: start },
      ],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "message_delta",
        {
          type: "message_delta",
          delta: { stop_reason: stop, stop_sequence: null },
          usage: { output_tokens: 1 },
        },
      ],
      ["message_stop", { type: "message_stop" }],
    ]);
  },
});
console.log("mock anthropic on :8080");
