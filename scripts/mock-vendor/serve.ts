// The scripted vendor APIs as one network service, for the end-to-end run (scripts/e2e.ts): the
// Tandem container's sandboxes reach it only through the gateway's egress proxy (Smokescreen), at a
// hostname of the e2e allowlist. Each dialect has a port of its own, so every vendor program meets
// exactly the mock its own proof used:
//
//   4799  Anthropic Messages, the key check        (mock-anthropic.ts)  Claude Code, curl
//   4796  OpenAI Responses and the sign-in issuer  (mock-openai.ts)     codex app-server, codex login
//   4795  Gemini, xAI and OpenRouter               (index.ts)           agy, Grok Build, goose, grok login
//   4798  the stub MCP server                      (../stub-mcp.ts)     the gateway's MCP proxy
//   4797  control, for the e2e driver only (published on the Docker host's loopback):
//           POST /approve?userCode=X   the person confirms xAI's device code on its page
//           GET  /seen?marker=X        how many vendor requests carried X (hidden context, history)
//           GET  /requests             the latest vendor requests: port, method, path, status
//           GET  /stub                 every request the stub MCP server answered
//           GET  /last?port=N&back=K   a recent request body that port received (K=0: the latest)
//
//   MOCK_LOG=/tmp/mock.log MOCK_MCP_SERVER=stub bun scripts/mock-vendor/serve.ts
import { mockAnthropic } from "./mock-anthropic";
import { handle as openai } from "./mock-openai";
import { approveDevice, handle as acp } from "./index";
import { startStubMcp } from "../stub-mcp";

const MARKER = /MARK-[A-Za-z0-9-]+/g;
/** marker -> how many vendor requests carried it. */
const seen = new Map<string, number>();
type Seen = {
  at: string;
  port: number;
  method: string;
  path: string;
  status: number;
};
const recent: Seen[] = [];
/** The latest POST bodies each port received, newest last (diagnosis). */
const last = new Map<number, string[]>();

const anthropic = mockAnthropic({ log: process.env.MOCK_LOG });

/** A vendor API on `port`: every request's markers counted, every answer recorded. */
function vendor(port: number, handle: (req: Request) => Promise<Response>) {
  return Bun.serve({
    port,
    hostname: "0.0.0.0",
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST") {
        const body = await req.clone().text();
        const mine = last.get(port) ?? [];
        mine.push(body);
        last.set(port, mine.slice(-10));
        for (const m of new Set(body.match(MARKER) ?? []))
          seen.set(m, (seen.get(m) ?? 0) + 1);
      }
      const res = await handle(req);
      recent.push({
        at: new Date().toISOString(),
        port,
        method: req.method,
        path: url.pathname,
        status: res.status,
      });
      if (recent.length > 2000) recent.splice(0, recent.length - 2000);
      return res;
    },
  });
}

vendor(4799, anthropic.handle);
vendor(4796, openai);
vendor(4795, acp);
const stub = startStubMcp({ port: 4798, hostname: "0.0.0.0" });

Bun.serve({
  port: 4797,
  hostname: "0.0.0.0",
  fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/approve") {
      approveDevice(url.searchParams.get("userCode") ?? "");
      return Response.json({ ok: true });
    }
    if (url.pathname === "/seen") {
      const m = url.searchParams.get("marker") ?? "";
      return Response.json({ marker: m, requests: seen.get(m) ?? 0 });
    }
    if (url.pathname === "/requests") return Response.json(recent);
    if (url.pathname === "/last")
      return new Response(
        last.get(Number(url.searchParams.get("port")))?.at(
          -1 - Number(url.searchParams.get("back") ?? 0),
        ) ?? "",
      );
    if (url.pathname === "/stub") return Response.json(stub.requests);
    if (url.pathname === "/health") return Response.json({ ok: true });
    return new Response("not found", { status: 404 });
  },
});
console.log(
  "mock vendors on 4795 4796 4799, stub MCP on 4798, control on 4797",
);
