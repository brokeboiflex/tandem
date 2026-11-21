// A scripted Anthropic Messages API for hermetic proofs: RUN_TOOL -> one Bash tool call, tool_result -> text.
import { appendFileSync } from "node:fs";
const LOG = process.env.MOCK_LOG ?? "/tmp/poc/mock.log";
const log = (s: string) => appendFileSync(LOG, s + "\n");
const sse = (events: [string, unknown][]) =>
  events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
function reply(model: string, blocks: any[], stop: string) {
  const ev: [string, unknown][] = [["message_start", { type: "message_start", message: { id: "msg_" + Date.now(), type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }]];
  blocks.forEach((b, i) => {
    if (b.type === "text") {
      ev.push(["content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } }]);
      ev.push(["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text } }]);
    } else {
      ev.push(["content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } }]);
      ev.push(["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } }]);
    }
    ev.push(["content_block_stop", { type: "content_block_stop", index: i }]);
  });
  ev.push(["message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } }]);
  ev.push(["message_stop", { type: "message_stop" }]);
  return new Response(sse(ev), { headers: { "content-type": "text/event-stream" } });
}
export async function handle(req: Request) {
  const url = new URL(req.url);
  const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  log(`${req.method} ${url.pathname} model=${body.model ?? ""} stream=${body.stream ?? ""} msgs=${body.messages?.length ?? ""}`);
  if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 10 });
  if (!url.pathname.startsWith("/v1/messages")) return new Response("{}", { status: 404 });
  const last = body.messages?.at(-1);
  const parts = typeof last?.content === "string" ? [{ type: "text", text: last.content }] : (last?.content ?? []);
  const result = parts.find((p: any) => p.type === "tool_result");
  const text = parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join(" ");
  if (result) {
    const out = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
    log("TOOL_RESULT " + out.slice(0, 400));
    return reply(body.model, [{ type: "text", text: "TOOL_RESULT_SEEN " + out.slice(0, 300) }], "end_turn");
  }
  if (text.includes("RUN_TOOL"))
    return reply(body.model, [{ type: "tool_use", id: "toolu_" + Date.now(), name: "Bash", input: { command: "id -u; grep -E 'CapEff|NoNewPrivs|Seccomp:' /proc/self/status; echo TMP=$TMPDIR; curl -sS -m 5 -o /dev/null -w 'net=%{http_code}' https://example.com || echo net=blocked", description: "probe" } }], "tool_use");
  return reply(body.model, [{ type: "text", text: "hello from mock" }], "end_turn");
}
