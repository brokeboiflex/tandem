// End-to-end: recreating the gateway and the egress proxy never leaves a running runtime unreachable
// or unusable. Against a running stack (docker compose up), with the Docker CLI on the host
// (DOCKER_HOST is honoured). Three phases, each while the people's event streams are open:
//
//   1. `docker compose up -d --force-recreate gateway egress`, the hostile way: the recreated egress
//      proxy is attached to each runtime network at the gateway's address before Compose starts it,
//      as an older gateway's sweep did, so it takes the gateway's address
//   2. `docker compose up -d --force-recreate --no-deps gateway`
//
//      After each: the streams reconnect and get the live state, the gateway and the egress proxy
//      are back at the addresses the runtimes were created with, MCP calls through the gateway's
//      proxy work, the egress proxy works, and no runtime was restarted.
//
//   3. the safety net: another container takes the gateway's address while the gateway is down; the
//      runtime is restarted once idle (`connecting` meanwhile), its volume kept
//
//   bun scripts/e2e-gateway-restart.ts
//   E2E_REAL_SUBJECT=<person> bun scripts/e2e-gateway-restart.ts
//          plus one one-word turn in flight across each phase, for a person whose volume holds real
//          sign-ins (claude-code/haiku across phase 1, codex-cli/gpt-6-luna across phase 2)
//   E2E_COMPOSE="docker compose -f compose.yaml -f compose.socket-proxy.yaml" for the socket proxy
//
// The MCP checks run a stub MCP server on this host (E2E_STUB_PORT, default 8791) that the gateway
// reaches at E2E_STUB_URL (default http://host.docker.internal:8791/mcp); MCP_ALLOWED_ORIGINS must
// allow that origin.
import { devToken } from "../src/auth";
import { COPY } from "../src/mcp";
import { runtimeKey } from "../src/runtime";
import { sseFrames } from "../src/sse";
import { STUB_CUSTOMER, startStubMcp } from "./stub-mcp";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:8787";
const PREFIX = process.env.RUNTIME_PREFIX || "tandem";
const COMPOSE = (process.env.E2E_COMPOSE || "docker compose").split(" ");
const run = Date.now().toString(36);
const secret = process.env.DEV_AUTH_SECRET ?? "";
const serviceSecret = process.env.SERVICE_SECRET ?? "";
if (secret.length < 32 || serviceSecret.length < 32)
  throw new Error("Run from the project directory so Bun loads .env (AUTH_MODE=dev).");

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};
const info = (line: string) => console.log(`      ${line}`);
const sh = (cmd: string[], env: Record<string, string> = {}) => {
  const p = Bun.spawnSync(cmd, { env: { ...process.env, ...env } });
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
};
const docker = (...args: string[]) => sh(["docker", ...args]);
const container = (subject: string) => `${PREFIX}-rt-${runtimeKey(serviceSecret, subject)}`;
const redact = (s: string) => s.replace(/[0-9a-f]{24}/g, "<key>");
async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, ms: number) {
  for (const until = Date.now() + ms; Date.now() < until; await Bun.sleep(250)) {
    const v = await fn();
    if (v) return v;
  }
}
const healthy = () =>
  waitFor(() => fetch(`${BASE}/healthz`).then((r) => r.ok || undefined, () => undefined), 120_000);

/** A person's app: API calls, and an event stream that reconnects like EventSource. */
async function person(subject: string) {
  const token = await devToken(secret, subject);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }).catch(() => null);
    return { status: res?.status ?? 0, body: (await res?.json().catch(() => null)) as any };
  };
  const events: { at: number; connection: number; event: string; data: any }[] = [];
  let connections = 0;
  const ac = new AbortController();
  void (async () => {
    while (!ac.signal.aborted) {
      try {
        const res = await fetch(`${BASE}/v1/events`, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
        if (res.ok) {
          const n = ++connections;
          for await (const f of sseFrames(res.body!))
            events.push({ at: Date.now(), connection: n, event: f.event, data: JSON.parse(f.data) });
        }
      } catch {}
      await Bun.sleep(500);
    }
  })();
  /** The live state of both providers on the current connection (at least `connection`), once it arrives. */
  const live = (since = 0, ms = 120_000, connection = 1) =>
    waitFor(() => {
      const latest = new Map<string, any>();
      for (const e of events.slice(since))
        if (e.event === "provider.updated" && e.connection === connections && e.connection >= connection)
          latest.set(e.data.provider.id, e.data.provider);
      const all = [...latest.values()];
      return all.length === 2 && all.every((p) => !["unknown", "connecting"].includes(p.status))
        ? all.sort((a, b) => a.id.localeCompare(b.id))
        : undefined;
    }, ms);
  return {
    subject,
    call,
    events,
    live,
    connections: () => connections,
    close: () => ac.abort(),
  };
}
type Person = Awaited<ReturnType<typeof person>>;

/** What must not change: the runtime container itself, and where it finds its peers. */
function snapshot(subject: string) {
  const c = container(subject);
  const [id, startedAt, restarts, net] = docker(
    "inspect", "-f", "{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.HostConfig.NetworkMode}}", c,
  ).out.split(" ");
  const members = Object.fromEntries(
    docker("network", "inspect", "-f", "{{range .Containers}}{{.Name}}={{.IPv4Address}} {{end}}", net!)
      .out.split(" ")
      .filter(Boolean)
      .map((m) => m.split("=") as [string, string])
      .map(([name, ip]) => [name === c ? "runtime" : name.replace(`${PREFIX}-`, ""), ip.split("/")[0]]),
  );
  const env = docker("exec", c, "sh", "-c", 'echo "$HAPPY_BRIDGE_ALLOW" "$MCP_PROXY_URL" "$HTTPS_PROXY"').out.split(" ");
  return {
    id: id!,
    startedAt: startedAt!,
    restarts: restarts!,
    net: net!,
    members,
    /** The addresses the runtime was created with. */
    expects: {
      gateway: env[0]!.replace(/\/32$/, ""),
      mcp: new URL(env[1]!).hostname,
      egress: new URL(env[2]!).hostname,
    },
  };
}
const describe = (s: ReturnType<typeof snapshot>) =>
  `gateway ${s.members.gateway}, egress ${s.members.egress}, runtime ${s.members.runtime}`;

/**
 * The runtime's own MCP call through the gateway's proxy: initialize, then tools/call in that session.
 * Asynchronous: the stub MCP server answers the gateway from this process's event loop.
 */
async function mcpCall(subject: string) {
  const script = `
    set -e
    h=$(mktemp); trap 'rm -f "$h"' EXIT
    curl -s -m 20 -D "$h" -o /dev/null -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
      -H "authorization: Bearer $MCP_PROXY_TOKEN" --data "$INIT" "$MCP_PROXY_URL/stub" || true
    sid=$(tr -d '\\r' < "$h" | sed -n 's/^mcp-session-id: //Ip')
    curl -s -m 20 -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
      -H "authorization: Bearer $MCP_PROXY_TOKEN" -H "mcp-session-id: $sid" --data "$CALL" "$MCP_PROXY_URL/stub"`;
  const p = Bun.spawn(["docker", "exec", "-e", "INIT", "-e", "CALL", container(subject), "sh", "-c", script], {
    env: {
      ...process.env,
      INIT: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } }),
      CALL: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lookup_customer", arguments: { id: "42" } } }),
    },
    stdout: "pipe",
  });
  return (await new Response(p.stdout).text()).trim();
}
/** Without a credential the proxy answers the runtime itself: it reached the proxy and was accepted. */
function mcpWithoutCredential(subject: string) {
  return sh(
    ["docker", "exec", "-e", "BODY", container(subject), "sh", "-c",
      `curl -s -m 10 -X POST -H 'content-type: application/json' -H "authorization: Bearer $MCP_PROXY_TOKEN" --data "$BODY" "$MCP_PROXY_URL/stub"`],
    { BODY: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lookup_customer", arguments: { id: "1" } } }) },
  ).out;
}
/**
 * The runtime's way out: a CONNECT through its egress proxy to an allowed vendor domain, retried for
 * up to 90 s. A recreated egress proxy has a new hardware address at the same IP address; gVisor's
 * network stack learns it only when its neighbour entry expires (about 30 s), runc at once.
 */
async function egressWorks(subject: string, since = Date.now()) {
  let code = "";
  for (const until = Date.now() + 90_000; Date.now() < until && code !== "200"; await Bun.sleep(1000))
    code = docker("exec", container(subject), "sh", "-c", "curl -s -o /dev/null -w '%{http_connect}' -m 5 https://api.anthropic.com/").out;
  return `CONNECT ${code}, ${((Date.now() - since) / 1000).toFixed(1)} s after the recreate began`;
}

// --- Setup ---------------------------------------------------------------------------------------
const stubPort = Number(process.env.E2E_STUB_PORT || 8791);
const stubUrl = process.env.E2E_STUB_URL || `http://host.docker.internal:${stubPort}/mcp`;
const stub = startStubMcp({ port: stubPort, hostname: process.env.E2E_STUB_HOST || "127.0.0.1" });
const people: Person[] = [];
const subject = `e2e-gwr-${run}`;
const tina = await person(subject);
people.push(tina);
check(!!(await tina.live()), "a person's event stream starts their runtime and delivers the live state");
const reg = await tina.call("PUT", "/v1/mcp-servers/stub", { url: stubUrl });
check(reg.status === 201, "the person's app registers its MCP server", reg.status === 201 ? "" : `${reg.status} ${reg.body?.message}`);
// The registration restarts the idle runtime once (Happy reads mcp.toml on start): wait for that.
await waitFor(
  () => docker("exec", container(subject), "sh", "-c", 'grep -c "mcp_servers.stub" "$HOME/happy/config/mcp.toml"').out === "1" || undefined,
  90_000,
);
await Bun.sleep(5000); // the gateway then publishes the live state again

const realSubject = process.env.E2E_REAL_SUBJECT;
let real: Person | undefined;
const turns: { label: string; message: string; conversation: string }[] = [];
if (realSubject) {
  real = await person(realSubject);
  people.push(real);
  const state = (await real.live()) ?? [];
  info(`${realSubject}: ${state.map((p: any) => `${p.id} ${p.status}`).join(", ")}`);
}
/** Sends a one-word turn and returns at once, while it runs. */
async function startTurn(provider: string, model: string, label: string) {
  if (!real) return;
  const conv = await real.call("POST", "/v1/conversations", { provider, model, effort: "low", title: `e2e gateway restart ${run}` });
  if (conv.status !== 201) return info(`SKIP ${label}: ${conv.status} ${conv.body?.message}`);
  const sent = await real.call("POST", `/v1/conversations/${conv.body.conversation.id}/messages`, { text: "Reply with the single word: pong" });
  check(sent.status === 202, `${label}: a new message is accepted`, `${model}`);
  turns.push({ label, message: sent.body?.message?.id, conversation: conv.body.conversation.id });
  // It must still run when the gateway goes away.
  const page = await real.call("GET", `/v1/conversations/${conv.body.conversation.id}/messages?limit=5`);
  const runId = page.body?.messages?.find((m: any) => m.id === sent.body?.message?.id)?.runId;
  info(`${label}: run ${page.body?.runs?.find((r: any) => r.id === runId)?.status ?? "not started yet"} when the recreate begins`);
}
async function turnResult(t: (typeof turns)[number]) {
  const done = await waitFor(async () => {
    const page = await real!.call("GET", `/v1/conversations/${t.conversation}/messages?limit=20`);
    const runId = page.body?.messages?.find((m: any) => m.id === t.message)?.runId;
    const r = page.body?.runs?.find((x: any) => x.id === runId);
    if (!r || r.status === "running") return undefined;
    return { status: r.status, reply: page.body.messages.filter((m: any) => m.role === "assistant").at(-1)?.text ?? "" };
  }, 300_000);
  return done ?? { status: "timeout", reply: "" };
}

// --- One phase: recreate, then check everything ----------------------------------------------------
async function phase(name: string, recreate: (nets: ReturnType<typeof snapshot>[]) => Promise<string>) {
  console.log(`\n## ${name}`);
  const subjects = people.map((p) => p.subject);
  const before = subjects.map(snapshot);
  for (const [i, s] of before.entries()) info(`${i ? "real" : "tina"}: ${describe(s)}`);
  const since = people.map((p) => p.events.length);
  const connected = people.map((p) => p.connections());
  const t0 = Date.now();
  const detail = await recreate(before);
  const up = await healthy();
  info(`${detail}; gateway healthy ${up ? `${((Date.now() - t0) / 1000).toFixed(1)} s` : "never"} after the recreate began`);
  for (const [i, p] of people.entries()) {
    const state = await p.live(since[i], 120_000, connected[i]! + 1);
    check(
      !!state,
      `${p === tina ? "tina" : "real"}: the open event stream reconnects and gets the live state`,
      state ? `${state.map((x: any) => `${x.id} ${x.status}`).join(", ")}, ${((p.events.at(-1)!.at - t0) / 1000).toFixed(1)} s after the recreate began` : "no live state within 120 s",
    );
  }
  for (const [i, s] of subjects.entries()) {
    const after = snapshot(s);
    const b = before[i]!;
    check(
      after.members.gateway === b.expects.gateway && after.members.egress === b.expects.egress && after.members.runtime === b.members.runtime,
      `${i ? "real" : "tina"}: the gateway and the egress proxy are back where the runtime expects them`,
      `${describe(after)}; created with gateway ${b.expects.gateway}, egress ${b.expects.egress}`,
    );
    check(
      after.id === b.id && after.startedAt === b.startedAt && after.restarts === b.restarts,
      `${i ? "real" : "tina"}: the runtime was not restarted`,
      `started ${after.startedAt}`,
    );
  }
  const plain = mcpWithoutCredential(subject);
  check(
    plain.includes(COPY.expired("stub")),
    "MCP: the runtime reaches the gateway's proxy, which accepts it (no credential since the gateway restarted)",
    plain.slice(0, 110),
  );
  // The app's next message brings the person's credential (here a message to a conversation that
  // does not exist: the gateway keeps the credential first, as for a cold start).
  const credential = `Bearer valid-gwr-${run}-${name.slice(0, 7).replace(/\W/g, "")}`;
  await tina.call("POST", `/v1/conversations/m${"0".repeat(31)}/messages`, { text: "x", mcpAuth: { stub: credential } });
  const answer = await mcpCall(subject);
  const upstream = stub.requests.filter((r) => r.authorization === credential && r.tool === "lookup_customer");
  check(
    answer.includes(STUB_CUSTOMER.name) && upstream.some((r) => r.status === 200),
    "MCP: a tool call through the proxy reaches the app's server with the person's credential",
    `${upstream.length} upstream call(s)`,
  );
  const out = await egressWorks(subject, t0);
  check(out.startsWith("CONNECT 200"), "the runtime's egress proxy works (CONNECT to an allowed vendor domain)", out);
}

// Phase 1: compose recreates the egress proxy and the gateway together. Compose stops the old
// gateway before it starts anything (about ten seconds), and an older gateway's sweep attached the
// new, not yet started egress proxy to each runtime network by name: it then took the lowest free
// address, the gateway's. Here it is placed at the gateway's address explicitly.
await startTurn("claude", "claude-code/haiku", "turn 1 (in flight across phase 1)");
await phase("phase 1: docker compose up -d --force-recreate gateway egress (the egress proxy takes the gateway's address)", async (nets) => {
  const egress = `${PREFIX}-egress`;
  const old = docker("inspect", "-f", "{{.Id}}", egress).out;
  const compose = Bun.spawn([...COMPOSE, "up", "-d", "--no-build", "--force-recreate", "gateway", "egress"], { stdout: "pipe", stderr: "pipe" });
  const placed: string[] = [];
  let seen = "";
  for (const until = Date.now() + 90_000; Date.now() < until && !seen; await Bun.sleep(50)) {
    const [id, status] = docker("inspect", "-f", "{{.Id}} {{.State.Status}}", egress).out.split(" ");
    if (!id || id === old) continue;
    seen = status!;
    if (status !== "created") break;
    for (const n of nets) {
      docker("network", "disconnect", n.net, egress); // in case a sweep attached it already
      if (docker("network", "connect", "--ip", n.members.gateway!, n.net, egress).code === 0) placed.push(n.members.gateway!);
    }
  }
  const code = await compose.exited;
  const log = (await new Response(compose.stderr).text()).trim().split("\n").at(-1);
  check(code === 0, "compose recreated the egress proxy and the gateway", log);
  check(
    placed.length === nets.length,
    "the recreated egress proxy was attached at the gateway's address on every runtime network before it started",
    `${placed.join(", ") || `none (the new egress proxy was ${seen || "not seen"})`}`,
  );
  return "compose done";
});
const movedLog = docker("logs", `${PREFIX}-gateway`);
const moves = (movedLog.out + "\n" + movedLog.err).split("\n").filter((l) => / moved on /.test(l));
for (const l of moves) info(`gateway: ${redact(l)}`);
check(moves.some((l) => l.startsWith("egress moved")), "the new gateway found the egress proxy on its address and moved it back");

// Turn 1 was running across phase 1; turn 2 starts now and runs across phase 2.
if (turns[0]) {
  const r = await turnResult(turns[0]);
  check(r.status === "completed" && /pong/i.test(r.reply), `${turns[0].label}: completed in the runtime that was never restarted`, `${r.status}, reply "${r.reply}"`);
}
await startTurn("codex", "codex-cli/gpt-6-luna", "turn 2 (sent after phase 1, in flight across phase 2)");

await phase("phase 2: docker compose up -d --force-recreate --no-deps gateway", async () => {
  const compose = sh([...COMPOSE, "up", "-d", "--no-build", "--force-recreate", "--no-deps", "gateway"]);
  check(compose.code === 0, "compose recreated the gateway alone", compose.err.split("\n").at(-1));
  return "compose done";
});
if (turns[1]) {
  const r = await turnResult(turns[1]);
  check(r.status === "completed" && /pong/i.test(r.reply), `${turns[1].label}: completed`, `${r.status}, reply "${r.reply}"`);
}

// Phase 3, the safety net: a container that is not Tandem's takes the gateway's address while the
// gateway is down, so the running runtime cannot be reached at the address it was created with. It
// is restarted once idle (this person has no run), with `connecting` meanwhile; its volume is kept.
console.log("\n## phase 3: another container takes the gateway's address while it is down");
{
  const before = snapshot(subject);
  docker("exec", "-u", "10001:10001", container(subject), "sh", "-c", `echo ${run} > "$HOME/projects/chats/e2e-marker.txt"`);
  const intruder = `${PREFIX}-e2e-intruder-${run}`;
  const since = tina.events.length;
  const connected = tina.connections();
  const t0 = Date.now();
  docker("stop", "-t", "10", `${PREFIX}-gateway`);
  const took = docker("run", "-d", "--name", intruder, "--network", before.net, "--ip", before.members.gateway!, "--entrypoint", "sleep", docker("inspect", "-f", "{{.Config.Image}}", container(subject)).out, "600");
  check(took.code === 0, "another container took the gateway's address on the runtime network", `${before.members.gateway}`);
  // The stopped gateway container cannot start again at its address: compose replaces it.
  const compose = sh([...COMPOSE, "up", "-d", "--no-build", "--force-recreate", "--no-deps", "gateway"]);
  check(compose.code === 0, "compose recreated the gateway", compose.err.split("\n").at(-1));
  await healthy();
  // While the runtime restarts, the person's app sees `connecting` (stream and GET /v1/providers).
  const polled = new Set<string>();
  for (const until = Date.now() + 60_000; Date.now() < until; await Bun.sleep(100)) {
    const r = await tina.call("GET", "/v1/providers");
    const statuses = (r.body?.providers ?? []).map((p: any) => p.status);
    statuses.forEach((s: string) => polled.add(s));
    if (statuses.length && statuses.every((s: string) => s === "not_connected" || s === "connected")) break;
  }
  const streamed = tina.events
    .slice(since)
    .filter((e) => e.event === "provider.updated" && e.connection > connected)
    .map((e) => e.data.provider.status);
  check(
    polled.has("connecting") || streamed.includes("connecting"),
    "while the runtime restarts the person sees it as connecting",
    `GET /v1/providers: ${[...polled].join(" -> ")}; stream: ${[...new Set(streamed)].join(" -> ")}`,
  );
  const state = await tina.live(since, 180_000, connected + 1);
  const after = snapshot(subject);
  check(
    !!state && after.startedAt !== before.startedAt,
    "the runtime was restarted once idle, and the stream gets the live state",
    state ? `${((tina.events.at(-1)!.at - t0) / 1000).toFixed(1)} s after the gateway stopped; ${describe(after)}` : "no live state",
  );
  check(
    after.members.gateway === after.expects.gateway && after.members.egress === after.expects.egress,
    "the new runtime finds the gateway and the egress proxy where it was created with them",
    `created with gateway ${after.expects.gateway}, egress ${after.expects.egress}`,
  );
  check(
    docker("exec", container(subject), "cat", "/home/agent/projects/chats/e2e-marker.txt").out === run,
    "the person's volume was kept",
  );
  const plain = mcpWithoutCredential(subject);
  check(plain.includes(COPY.expired("stub")), "MCP: the new runtime reaches the gateway's proxy", plain.slice(0, 80));
  const out = await egressWorks(subject, t0);
  check(out.startsWith("CONNECT 200"), "the new runtime's egress proxy works", out);
  const logs = docker("logs", `${PREFIX}-gateway`);
  for (const l of (logs.out + "\n" + logs.err).split("\n").filter((l) => /must restart|stopped key|ready key|WARNING: (Docker refused|The gateway cannot)/.test(l)))
    info(`gateway: ${redact(l).slice(0, 200)}`);
  docker("rm", "-f", intruder);
}

// --- Cleanup ----------------------------------------------------------------------------------------
for (const t of turns) await real!.call("DELETE", `/v1/conversations/${t.conversation}`);
for (const p of people) p.close();
stub.stop();
await Bun.sleep(1000); // the gateway notices the closed streams before the runtime goes away
const c = container(subject);
const net = docker("inspect", "-f", "{{.HostConfig.NetworkMode}}", c).out;
docker("rm", "-f", c);
docker("network", "disconnect", net, `${PREFIX}-gateway`);
docker("network", "disconnect", net, `${PREFIX}-egress`);
docker("network", "rm", net);
docker("volume", "rm", `${PREFIX}-home-${runtimeKey(serviceSecret, subject)}`);
console.log(failures ? `\nE2E GATEWAY RESTART FAILED (${failures})` : "\nE2E GATEWAY RESTART PASSED");
process.exit(failures ? 1 : 0);
