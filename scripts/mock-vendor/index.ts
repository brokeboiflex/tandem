// One scripted vendor API for hermetic proofs. RUN_TOOL -> one call of the agent's own shell tool;
// a tool result -> text echoing it. Speaks Anthropic Messages, OpenAI Responses, OpenAI chat
// completions and Gemini generateContent, dispatched by path; anything else is logged.
import { appendFileSync } from "node:fs";
import { handle as anthropic } from "./mock-anthropic.ts";
import { handle as responses } from "./mock-openai.ts";
const LOG = process.env.MOCK_LOG ?? "/tmp/poc/mock.log";
const log = (s: string) => appendFileSync(LOG, s + "\n");
const PROBE = "id -u; grep -E 'CapEff|NoNewPrivs|Seccomp:' /proc/self/status; echo TMP=$TMPDIR; echo hi > probe.txt && cat probe.txt";
const SHELL = /^(run_shell_command|shell|bash|exec_command|shell_command|run_command|execute|developer__shell|terminal|command)$/i;
const SHELLISH = /shell|bash|command|exec|terminal/i;
function argsFor(schema: any) {
  const props = schema?.properties ?? {};
  const key = ["command", "cmd", "CommandLine", "script"].find((k) => k in props) ?? (schema?.required ?? [])[0] ?? "command";
  const out: Record<string, unknown> = { [key]: props[key]?.type === "array" ? ["bash", "-lc", PROBE] : PROBE };
  for (const r of schema?.required ?? []) {
    if (r in out) continue;
    const t = String(props[r]?.type ?? "string").toLowerCase();
    out[r] = /cwd|dir/i.test(r) ? "/home/agent/projects/chats" : t === "number" || t === "integer" ? 0 : t === "boolean" ? false : t === "array" ? [] : t === "object" ? {} : "probe";
  }
  return out;
}
const pick = (tools: { name: string; schema: any }[]) => tools.find((t) => SHELL.test(t.name)) ?? tools.find((t) => SHELLISH.test(t.name));
async function chat(body: any) {
  const msgs = body.messages ?? [];
  const last = msgs.at(-1);
  const tools = (body.tools ?? []).map((t: any) => ({ name: t.function?.name, schema: t.function?.parameters }));
  log(`chat tools=${tools.map((t: any) => t.name).join(",")} last=${last?.role}`);
  const chunk = (delta: any, finish: string | null = null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  let out: string;
  if (last?.role === "tool") { log("TOOL_RESULT " + String(last.content).slice(0, 400)); out = chunk({ role: "assistant", content: "TOOL_RESULT_SEEN " + String(typeof last.content === "string" ? last.content : JSON.stringify(last.content)).slice(0, 300) }) + chunk({}, "stop"); }
  else if (JSON.stringify(last).includes("RUN_TOOL") && pick(tools)) { const t = pick(tools)!; log("CALL " + t.name); out = chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: t.name, arguments: JSON.stringify(argsFor(t.schema)) } }] }) + chunk({}, "tool_calls"); }
  else out = chunk({ role: "assistant", content: "hello from mock" }) + chunk({}, "stop");
  out += `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020 } })}\n\ndata: [DONE]\n\n`;
  return new Response(out, { headers: { "content-type": "text/event-stream" } });
}
async function gemini(body: any, stream: boolean) {
  const contents = body.contents ?? [];
  const last = contents.at(-1);
  const tools = (body.tools ?? []).flatMap((t: any) => (t.functionDeclarations ?? []).map((f: any) => ({ name: f.name, schema: f.parameters ?? f.parametersJsonSchema })));
  log(`gemini tools=${tools.map((t: any) => t.name).join(",")}`);
  const fr = last?.parts?.find((p: any) => p.functionResponse);
  let parts: any[];
  if (fr) { const s = JSON.stringify(fr.functionResponse.response); log("TOOL_RESULT " + s.slice(0, 400)); parts = [{ text: "TOOL_RESULT_SEEN " + s.slice(0, 300) }]; }
  else if (JSON.stringify(last).includes("RUN_TOOL") && pick(tools)) { const t = pick(tools)!; log("CALL " + t.name); parts = [{ functionCall: { name: t.name, args: argsFor(t.schema) } }]; }
  else parts = [{ text: "hello from mock" }];
  const resp = { candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 20, totalTokenCount: 1020 }, modelVersion: "gemini-mock" };
  return stream ? new Response(`data: ${JSON.stringify(resp)}\r\n\r\n`, { headers: { "content-type": "text/event-stream" } }) : Response.json(resp);
}
export async function handle(req: Request) {
  const url = new URL(req.url);
  const p = url.pathname;
  if (p.startsWith("/v1/messages")) return anthropic(req);
  if (p.endsWith("/responses")) return responses(req);
  const text = req.method === "POST" ? await req.text() : "";
  log(`${req.method} ${p}${url.search} ${text.slice(0, 160).replace(/\s+/g, " ")}`);
  const body = text ? JSON.parse(text) : {};
  if (p.endsWith("/chat/completions")) return chat(body);
  if (/:(stream)?generateContent$/i.test(p)) return gemini(body, /stream/i.test(p));
  if (p.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "mock-model", object: "model" }], models: [{ name: "models/gemini-mock", displayName: "Gemini Mock", supportedGenerationMethods: ["generateContent"] }] });
  return Response.json({});
}
