// A small Streamable HTTP MCP server for tests: it requires a bearer token, keeps sessions, answers
// tool calls as SSE streams, and can ask the person a question (elicitation) mid-call.
//
//   bun scripts/stub-mcp.ts            listens on 127.0.0.1:8791 (STUB_MCP_HOST, STUB_MCP_PORT),
//                                      accepts "Bearer valid-<anything>" and prints one JSON line
//                                      per request (including the Authorization it received)
//
// Tools: lookup_customer({ id }) returns a fixed record; confirm_action({ action }) asks the person
// to approve the action before it answers.

export const STUB_CUSTOMER = {
  name: "Wilhelmina Quarrington",
  plan: "Gold",
  visits: 7,
};

const TOOLS = [
  {
    name: "lookup_customer",
    description: "Look up one customer record by id (read only).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Customer id" } },
      required: ["id"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "confirm_action",
    description:
      "Ask the person to confirm an action before it is carried out. Use it when the person asks for a confirmation.",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string" } },
      required: ["action"],
    },
  },
];

export type StubRequest = {
  httpMethod: string;
  rpcMethod: string | null;
  tool: string | null;
  authorization: string | null;
  sessionId: string | null;
  status: number;
};

export function startStubMcp(
  opts: {
    port?: number;
    hostname?: string;
    /** Whether an Authorization header value is accepted. */
    accept?: (authorization: string | null) => boolean;
    /** Called with every request after it was answered (CLI: one JSON line per request). */
    onRequest?: (r: StubRequest) => void;
  } = {},
) {
  const accept =
    opts.accept ?? ((a: string | null) => !!a && /^Bearer valid-\S+$/.test(a));
  const sessions = new Set<string>();
  const pending = new Map<string, (answer: any) => void>();
  const requests: StubRequest[] = [];
  const enc = new TextEncoder();
  const sse = (message: unknown) =>
    enc.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`);

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: opts.hostname ?? "127.0.0.1",
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url);
      const record: StubRequest = {
        httpMethod: req.method,
        rpcMethod: null,
        tool: null,
        authorization: req.headers.get("authorization"),
        sessionId: req.headers.get("mcp-session-id"),
        status: 0,
      };
      requests.push(record);
      const reply = (res: Response) => {
        record.status = res.status;
        opts.onRequest?.(record);
        return res;
      };
      if (url.pathname !== "/mcp")
        return reply(new Response(null, { status: 404 }));
      if (!accept(record.authorization))
        return reply(
          new Response(JSON.stringify({ error: "invalid_token" }), {
            status: 401,
            headers: { "www-authenticate": 'Bearer error="invalid_token"' },
          }),
        );
      if (req.method === "GET")
        return reply(
          new Response(null, {
            status: 405,
            headers: { allow: "POST, DELETE" },
          }),
        );
      if (req.method === "DELETE") {
        if (record.sessionId) sessions.delete(record.sessionId);
        return reply(new Response(null, { status: 200 }));
      }
      const body: any = await req.json().catch(() => null);
      record.rpcMethod =
        body?.method ?? (body?.result || body?.error ? "response" : null);
      record.tool = body?.params?.name ?? null;
      if (body?.method === "initialize") {
        const id = crypto.randomUUID();
        sessions.add(id);
        return reply(
          Response.json(
            {
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: body.params?.protocolVersion ?? "2025-06-18",
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: "stub-mcp", version: "1.0.0" },
              },
            },
            { headers: { "mcp-session-id": id } },
          ),
        );
      }
      if (!record.sessionId || !sessions.has(record.sessionId))
        return reply(new Response(null, { status: 404 })); // unknown session: initialize again
      // A client's answer to our elicitation, or a notification.
      if (body?.method === undefined && body?.id !== undefined) {
        pending.get(String(body.id))?.(body.result ?? null);
        return reply(new Response(null, { status: 202 }));
      }
      if (body?.id === undefined)
        return reply(new Response(null, { status: 202 }));
      if (body.method === "tools/list")
        return reply(
          Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: { tools: TOOLS },
          }),
        );
      if (body.method === "tools/call") {
        const { name, arguments: args } = body.params ?? {};
        // Tool calls answer as an SSE stream, as Streamable HTTP servers may.
        const stream = new ReadableStream<Uint8Array>({
          async start(c) {
            let result: any;
            if (name === "lookup_customer")
              result = {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      id: String(args?.id ?? ""),
                      ...STUB_CUSTOMER,
                    }),
                  },
                ],
              };
            else if (name === "confirm_action") {
              const askId = `ask${crypto.randomUUID().slice(0, 8)}`;
              const answered = new Promise<any>((resolve) =>
                pending.set(askId, resolve),
              );
              c.enqueue(
                sse({
                  jsonrpc: "2.0",
                  id: askId,
                  method: "elicitation/create",
                  params: {
                    message: `Allow the action "${String(args?.action ?? "")}"?`,
                    requestedSchema: { type: "object", properties: {} },
                  },
                }),
              );
              const answer = await Promise.race([
                answered,
                Bun.sleep(120_000).then(() => null),
              ]);
              pending.delete(askId);
              result = {
                content: [
                  {
                    type: "text",
                    text: `The person answered: ${answer?.action ?? "no answer"}.`,
                  },
                ],
              };
            } else
              result = {
                content: [{ type: "text", text: `Unknown tool ${name}` }],
                isError: true,
              };
            c.enqueue(sse({ jsonrpc: "2.0", id: body.id, result }));
            c.close();
          },
        });
        return reply(
          new Response(stream, {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
            },
          }),
        );
      }
      return reply(
        Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "Method not found" },
        }),
      );
    },
  });
  return {
    url: `http://${server.hostname}:${server.port}/mcp`,
    port: server.port,
    requests,
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const stub = startStubMcp({
    port: Number(process.env.STUB_MCP_PORT || 8791),
    hostname: process.env.STUB_MCP_HOST || "127.0.0.1",
    onRequest: (r) => console.log(JSON.stringify({ at: new Date().toISOString(), ...r })),
  });
  console.log(`stub MCP server on ${stub.url} (accepts "Bearer valid-…")`);
}
