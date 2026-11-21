// The scripted model (./script.ts) as xAI's Responses API, the way a signed-in Grok Build reads it
// from cli-chat-proxy: complete OpenAI-shaped stream events (Grok parses them strictly). Session
// titles (the `session_title` tool) get a fixed title.
import { decide, log, type Tool } from "./script";

let seq = 0;
const sse = (events: any[]) =>
  events
    .map(
      (d, i) =>
        `event: ${d.type}\ndata: ${JSON.stringify({ ...d, sequence_number: i })}\n\n`,
    )
    .join("");

function response(
  id: string,
  model: string,
  status: string,
  output: any[] = [],
) {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status,
    output,
    usage:
      status === "completed"
        ? {
            input_tokens: 1000,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 20,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 1020,
          }
        : null,
  };
}

function stream(model: string, item: any) {
  const id = `resp_${++seq}`;
  const added =
    item.type === "message"
      ? { ...item, status: "in_progress", content: [] }
      : { ...item, status: "in_progress", arguments: "" };
  const events: any[] = [
    { type: "response.created", response: response(id, model, "in_progress") },
    { type: "response.output_item.added", output_index: 0, item: added },
  ];
  if (item.type === "message") {
    const text = item.content[0].text;
    events.push(
      {
        type: "response.content_part.added",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: text,
        logprobs: [],
      },
      {
        type: "response.output_text.done",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        text,
        logprobs: [],
      },
      {
        type: "response.content_part.done",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: item.content[0],
      },
    );
  } else
    events.push(
      {
        type: "response.function_call_arguments.delta",
        item_id: item.id,
        output_index: 0,
        delta: item.arguments,
      },
      {
        type: "response.function_call_arguments.done",
        item_id: item.id,
        output_index: 0,
        name: item.name,
        arguments: item.arguments,
      },
    );
  events.push(
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: response(id, model, "completed", [item]),
    },
  );
  return new Response(sse(events), {
    headers: { "content-type": "text/event-stream" },
  });
}

const message = (text: string) => ({
  type: "message",
  id: `msg_${++seq}`,
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
});

export async function handle(req: Request) {
  const body: any =
    req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const items: any[] = body.input ?? [];
  const tools: Tool[] = (body.tools ?? []).map((t: any) => ({
    name: t.name ?? t.type,
    schema: t.parameters,
  }));
  const model = body.model ?? "grok-mock";
  log(
    `responses(grok) model=${model} items=${items.length} tools=${tools
      .map((t) => t.name)
      .slice(0, 6)
      .join(",")} effort=${JSON.stringify(body.reasoning ?? null)}`,
  );
  if (tools.some((t) => t.name === "session_title")) {
    const args = JSON.stringify({ title: "Mock conversation" });
    return stream(model, {
      type: "function_call",
      id: `fc_${++seq}`,
      call_id: `call_${seq}`,
      name: "session_title",
      arguments: args,
      status: "completed",
    });
  }
  const last = items.at(-1);
  const users = items.filter((i) => i.role === "user");
  const d = decide(
    users.at(-1),
    items.slice(0, items.lastIndexOf(users.at(-1))),
    last?.type === "function_call_output"
      ? typeof last.output === "string"
        ? last.output
        : JSON.stringify(last.output)
      : null,
    tools,
  );
  if ("fail" in d) {
    log("FAIL " + d.fail);
    if (d.fail === "401")
      return Response.json(
        { error: { message: "Unauthorized: token expired", code: 401 } },
        { status: 401 },
      );
    if (d.fail === "429")
      return Response.json(
        { code: "rate_limited", error: "Too many requests" },
        { status: 429 },
      );
    return Response.json(
      {
        code: "subscription:free-usage-exhausted",
        error: "You have used up your free usage for this period.",
      },
      { status: 429 },
    );
  }
  if ("text" in d) return stream(model, message(d.text));
  return stream(model, {
    type: "function_call",
    id: `fc_${++seq}`,
    call_id: `call_${seq}`,
    name: d.call.name,
    arguments: JSON.stringify(d.call.args),
    status: "completed",
  });
}
