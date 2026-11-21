// A scripted OpenAI Responses API: RUN_TOOL -> one shell tool call, function_call_output -> text.
import { appendFileSync } from "node:fs";
const LOG = process.env.MOCK_LOG ?? "/tmp/poc/mock.log";
const log = (s: string) => appendFileSync(LOG, s + "\n");
const PROBE = "id -u; grep -E 'CapEff|NoNewPrivs|Seccomp:' /proc/self/status; echo TMP=$TMPDIR; echo hi > probe.txt && cat probe.txt";
const sse = (events: any[]) => events.map((d) => `event: ${d.type}\ndata: ${JSON.stringify(d)}\n\n`).join("");
const done = (id: string, items: any[]) => new Response(sse([
  { type: "response.created", response: { id } },
  ...items.map((item, i) => ({ type: "response.output_item.done", output_index: i, item })),
  { type: "response.completed", response: { id, usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1020 } } },
]), { headers: { "content-type": "text/event-stream" } });
export async function handle(req: Request) {
  const url = new URL(req.url);
  const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const tools = (body.tools ?? []).map((t: any) => t.name ?? t.type);
  log(`${req.method} ${url.pathname} model=${body.model ?? ""} items=${body.input?.length ?? ""} tools=${tools.join(",")}`);
  if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [], models: [] });
  if (!url.pathname.endsWith("/responses")) return new Response("{}", { status: 404 });
  const id = "resp_" + Date.now();
  const items: any[] = body.input ?? [];
  const last = items.at(-1);
  if (last?.type === "function_call_output" || last?.type === "custom_tool_call_output") {
    const out = typeof last.output === "string" ? last.output : JSON.stringify(last.output);
    log("TOOL_RESULT " + out.slice(0, 500));
    return done(id, [{ type: "message", role: "assistant", id: "m" + id, content: [{ type: "output_text", text: "TOOL_RESULT_SEEN " + out.slice(0, 300) }] }]);
  }
  const text = JSON.stringify(last ?? {});
  if (text.includes("RUN_TOOL")) {
    const call = (name: string, args: unknown) => done(id, [{ type: "function_call", id: "fc" + id, call_id: "call_" + Date.now(), name, arguments: JSON.stringify(args) }]);
    if (tools.includes("exec_command")) return call("exec_command", { cmd: PROBE });
    if (tools.includes("shell_command")) return call("shell_command", { command: PROBE });
    if (tools.includes("shell")) return call("shell", { command: ["bash", "-lc", PROBE] });
    log("NO SHELL TOOL");
  }
  return done(id, [{ type: "message", role: "assistant", id: "m" + id, content: [{ type: "output_text", text: "hello from mock" }] }]);
}
