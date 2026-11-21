// End-to-end check against a running Tandem container (docker compose up) on a KVM host. Uses the
// Docker CLI on the host only to run `msb` inside that container (stop a microVM, run a probe inside
// one, read its footprint) and to restart the container; everything else goes through the /v1 façade.
//
//   bun scripts/e2e.ts                      sign-in flows, wrong codes, isolation, cold start, footprint;
//                                           restarts the Tandem container once (reads after a restart)
//   E2E_REAL_SUBJECT=<subject> bun scripts/e2e.ts
//                                           also real turns for that subject's signed-in accounts (its home
//                                           must hold real logins), including MCP tool calls through the
//                                           gateway's proxy
//
// E2E_CONTAINER names the Tandem container (default: the compose service `tandem`). The MCP checks
// run a stub MCP server on this host (E2E_STUB_PORT, default 8791) that the gateway reaches at
// E2E_STUB_URL (default http://host.docker.internal:8791/mcp; on Linux give the container
// `extra_hosts: ["host.docker.internal:host-gateway"]`); MCP_ALLOWED_ORIGINS must allow that origin.
import { devToken } from "../src/auth";
import { CONTEXT_OPEN, PROVIDER_IDS } from "../src/happy";
import { COPY } from "../src/mcp";
import { runtimeKey } from "../src/runtime";
import { sseFrames } from "../src/sse";
import { STUB_CUSTOMER, startStubMcp } from "./stub-mcp";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:8787";
const PREFIX = process.env.RUNTIME_PREFIX || "tandem";
const run = Date.now().toString(36);
const secret = process.env.DEV_AUTH_SECRET ?? "";
const serviceSecret = process.env.SERVICE_SECRET ?? "";
if (secret.length < 32 || serviceSecret.length < 32)
  throw new Error(
    "Run from the project directory so Bun loads .env (AUTH_MODE=dev).",
  );

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`,
  );
  if (!ok) failures++;
};
const seconds = (t0: number) =>
  `${((performance.now() - t0) / 1000).toFixed(2)} s`;
const redactUrl = (url: string | null) =>
  url ? url.split("?")[0] + (url.includes("?") ? "?<redacted>" : "") : url;
const docker = (...args: string[]) => {
  const p = Bun.spawnSync(["docker", ...args]);
  return p.stdout.toString().trim();
};
const stubPort = Number(process.env.E2E_STUB_PORT || 8791);
const stubUrl =
  process.env.E2E_STUB_URL || `http://host.docker.internal:${stubPort}/mcp`;
const stub = startStubMcp({ port: stubPort });
/** The one Tandem container. */
const GATEWAY =
  process.env.E2E_CONTAINER ||
  docker("ps", "-q", "--filter", "label=com.docker.compose.service=tandem").split("\n")[0]!;
if (!GATEWAY) throw new Error("No Tandem container: set E2E_CONTAINER or start compose.yaml.");
const msb = (...args: string[]) => docker("exec", GATEWAY, "msb", ...args);
/** A person's microVM (src/runtime.ts). */
const vm = (subject: string) => `${PREFIX}-${runtimeKey(serviceSecret, subject)}`;
/** Its status in microsandbox (`running`, `stopped`, ...), or null while it does not exist. */
const vmStatus = (subject: string) => {
  const line = msb("ls").split("\n").find((l) => l.startsWith(`${vm(subject)} `));
  return line ? line.trim().split(/\s+/)[2]! : null;
};
/** The daemon's MCP settings, exported for a probe: they live only in its own environment. */
const DAEMON_ENV =
  "eval \"$(tr '\\0' '\\n' < /proc/$(pgrep -xo happy-agent)/environ | grep -E '^(MCP_PROXY_TOKEN|MCP_PROXY_URL)=' | sed 's/^/export /')\"; ";
/** Runs a shell snippet inside a person's microVM as `agent`; `env` values pass as variables. */
const inRuntime = (subject: string, script: string, env: Record<string, string> = {}) =>
  Bun.spawnSync(
    [
      "docker", "exec", ...Object.keys(env).flatMap((k) => ["-e", k]), GATEWAY,
      "sh", "-c",
      `exec msb exec -u agent ${Object.keys(env).map((k) => `-e "${k}=$${k}"`).join(" ")} "$0" -- sh -c "$1"`,
      vm(subject), DAEMON_ENV + script,
    ],
    { env: { ...process.env, ...env } },
  )
    .stdout.toString()
    .trim();

async function client(subject: string) {
  const token = await devToken(secret, subject);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: res.status,
      body: (await res.json().catch(() => null)) as any,
    };
  };
  const events: { event: string; data: any }[] = [];
  let ac: AbortController | undefined;
  /** Opens the person's event stream, as an app does when its UI opens: this starts the runtime. */
  const listen = async () => {
    ac?.abort();
    const own = (ac = new AbortController());
    const res = await fetch(`${BASE}/v1/events`, {
      headers: { authorization: `Bearer ${token}` },
      signal: own.signal,
    });
    void (async () => {
      try {
        for await (const f of sseFrames(res.body!))
          events.push({ event: f.event, data: JSON.parse(f.data) });
      } catch {}
    })();
  };
  /** The live state of every provider, which the stream sends once the runtime is up. */
  const live = (since = 0, ms = 90_000) =>
    waitFor(() => {
      const latest = new Map<string, any>();
      for (const e of events.slice(since))
        if (e.event === "provider.updated")
          latest.set(e.data.provider.id, e.data.provider);
      return latest.size >= PROVIDER_IDS.length
        ? [...latest.values()].sort((a, b) => a.id.localeCompare(b.id))
        : undefined;
    }, ms);
  return { subject, call, events, listen, live, close: () => ac?.abort() };
}
type Client = Awaited<ReturnType<typeof client>>;

async function waitFor<T>(
  fn: () => T | undefined | Promise<T | undefined>,
  ms: number,
): Promise<T | undefined> {
  for (
    const until = Date.now() + ms;
    Date.now() < until;
    await Bun.sleep(250)
  ) {
    const v = await fn();
    if (v) return v;
  }
}

// --- 1. Reads never start a runtime; opening the event stream does ------------------------------
const alice = await client(`e2e-alice-${run}`);
const bob = await client(`e2e-bob-${run}`);
const running = async (subject: string) => vmStatus(subject) === "running";
const allUnknown = (r: { status: number; body: any }) =>
  r.status === 200 &&
  r.body.providers.length === PROVIDER_IDS.length &&
  r.body.providers.every((p: any) => p.status === "unknown" && p.checkedAt === null);
/** Opens the stream; reports when the microVM ran and when the live state came. */
async function wakeAndTime(c: Client) {
  const since = c.events.length;
  const t0 = performance.now();
  let started: number | undefined;
  let watching = true;
  const watch = (async () => {
    while (watching && started === undefined) {
      if (vmStatus(c.subject) === "running") started = performance.now() - t0;
      else await Bun.sleep(100);
    }
  })();
  await c.listen();
  const state = await c.live(since, 300_000);
  const live = state ? performance.now() - t0 : undefined;
  watching = false;
  await watch;
  return { started, live, state };
}
const ms = (v?: number) => (v === undefined ? "never" : `${v.toFixed(0)} ms`);

let t0 = performance.now();
let r = await alice.call("GET", "/v1/providers");
check(allUnknown(r), "new person: GET /v1/providers answers `unknown` at once", seconds(t0));
r = await alice.call("GET", "/v1/conversations");
check(
  r.status === 409 && r.body?.error === "runtime_stopped",
  "new person: other reads answer 409 runtime_stopped",
);
await Bun.sleep(2000);
check(vmStatus(alice.subject) === null, "…and no runtime is created");
let woke = await wakeAndTime(alice);
check(
  woke.started !== undefined,
  "cold start: opening /v1/events boots a fresh microVM",
  `microVM running after ${ms(woke.started)}`,
);
check(
  !!woke.state && woke.state.every((p: any) => p.status !== "unknown"),
  "cold start: the live state arrives over the stream",
  `${ms(woke.live)} after opening`,
);
for (const p of woke.state ?? [])
  console.log(`      ${p.id}: ${p.status}, ${p.models.length} models`);

// The UI closes, then the runtime stops (as after an idle stop): reads still start nothing.
alice.close();
await Bun.sleep(500);
msb("stop", vm(alice.subject));
const stoppedAt = Date.now();
t0 = performance.now();
const warm = await alice.call("GET", "/v1/providers");
check(
  warm.status === 200 &&
    performance.now() - t0 < 500 &&
    warm.body.providers.every((p: any) => Date.parse(p.checkedAt) < stoppedAt),
  "stopped runtime: GET /v1/providers answers at once with the last-known state",
  seconds(t0),
);
await Bun.sleep(3000);
check(!(await running(alice.subject)), "stopped runtime: …and starts nothing");

// After a restart of the Tandem container nothing is remembered: `unknown`, and still nothing started.
docker("restart", "-t", "60", GATEWAY);
await waitFor(
  () => fetch(`${BASE}/healthz`).then((res) => res.ok, () => false),
  60_000,
);
t0 = performance.now();
r = await alice.call("GET", "/v1/providers");
check(allUnknown(r), "after a gateway restart: GET /v1/providers answers `unknown` at once", seconds(t0));
await Bun.sleep(3000);
check(!(await running(alice.subject)), "after a gateway restart: …and starts nothing");
woke = await wakeAndTime(alice);
check(
  woke.started !== undefined,
  "stopped runtime: opening /v1/events boots it again",
  `microVM running after ${ms(woke.started)}`,
);
check(
  !!woke.state && woke.state.every((p: any) => p.status !== "unknown") && (await running(alice.subject)),
  "stopped runtime: the live state arrives over the stream",
  `${ms(woke.live)} after opening`,
);
// With the stream open, a runtime stopped behind the gateway's back is restarted at once and the
// live state comes again on the same stream (a restart waits for the microVM to finish stopping).
{
  const since = alice.events.length;
  t0 = performance.now();
  msb("stop", vm(alice.subject));
  const again = await alice.live(since, 300_000);
  check(
    !!again && (await running(alice.subject)),
    "open stream: a runtime stopped outside the gateway is restarted and reports live again",
    `${seconds(t0)} after the stop`,
  );
}
// The bridges listen on the container's own loopback: the host sees only the API port.
check(
  docker("port", GATEWAY).split("\n").every((l) => l.startsWith("8787/tcp")),
  "only the API port is published",
  docker("port", GATEWAY).replace(/\n/g, ", "),
);
const bridge = inRuntime(alice.subject, "pgrep -a socat | grep -o 'range=[0-9./]*' | head -1");
check(
  /^range=\d+\.\d+\.\d+\.\d+\/32$/.test(bridge) && !bridge.includes("127.0.0.1"),
  "runtime bridge accepts only its microVM's own gateway address",
  bridge,
);
// From inside a microVM: no other person's microVM, no gateway API, no host, no cloud metadata, and
// only allowlisted hosts on the Internet.
await bob.listen();
await bob.live(0, 300_000);
const aliceIp = inRuntime(alice.subject, "hostname -I | cut -d' ' -f1");
/** "blocked" when the connection fails or microsandbox answers its own denial; else the HTTP status. */
const probe = (url: string) => {
  const out = inRuntime(bob.subject, `curl -s -m 8 -w '\\n%{http_code}' "$U" | tail -c 400; true`, { U: url });
  const code = out.slice(-3);
  // microsandbox answers a denied plain-HTTP request itself: 403 with JSON naming the destination.
  const denied = code === "403" && /"code"\s*:/.test(out) && /"domain"\s*:/.test(out);
  return code === "000" || denied ? "blocked" : code;
};
const bobGateway = inRuntime(
  bob.subject,
  "awk '$2==\"00000000\"{print $3; exit}' /proc/net/route",
);
const dotted = (hex: string) =>
  hex.length === 8
    ? [6, 4, 2, 0].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(".")
    : "0.0.0.0";
for (const [url, label] of [
  [`http://${aliceIp}:24790/v0/health`, "another person's microVM"],
  [`http://${dotted(bobGateway)}:8787/healthz`, "the gateway API from a microVM"],
  [`http://${dotted(bobGateway)}:${41000}/v0/health`, "the bridge ports from a microVM"],
  ["http://169.254.169.254/latest/meta-data/", "cloud metadata"],
  ["https://example.com/", "a host outside the allowlist"],
] as const) {
  const code = probe(url);
  check(code === "blocked", `a microVM cannot reach ${label}`, code);
}
const allowed = probe("https://api.anthropic.com/v1/models");
check(/^[1-5]\d\d$/.test(allowed), "a microVM reaches an allowlisted vendor", allowed);

// --- 2. Connect -> cancel for every provider that signs in ---------------------------------------------
for (const id of ["claude", "codex", "grok"]) {
  t0 = performance.now();
  const start = await alice.call("POST", `/v1/providers/${id}/connect`, {});
  const c = start.body.connection;
  check(
    c?.status === "waiting" && !!c.url,
    `${id}: connect starts the vendor sign-in`,
    `${seconds(t0)}, ${c?.flow}, ${redactUrl(c?.url)}${c?.userCode ? `, userCode ${c.userCode.length} chars` : ""}, expires ${c?.expiresAt}`,
  );
  const sse = await waitFor(
    () =>
      alice.events.find(
        (e) =>
          e.event === "provider.updated" &&
          e.data.provider.id === id &&
          e.data.provider.status === "connecting",
      ),
    5000,
  );
  check(!!sse, `${id}: SSE reports provider.updated connecting`);
  const cancelled = await alice.call("DELETE", `/v1/providers/${id}/connect`);
  check(
    cancelled.body.connection?.status === "cancelled",
    `${id}: cancel ends the sign-in`,
  );
  const after = await alice.call("GET", "/v1/providers");
  check(
    after.body.providers.find((p: any) => p.id === id).status ===
      "not_connected",
    `${id}: provider back to not_connected`,
  );
}

// --- 3. Wrong Claude codes ---------------------------------------------------------------------------
let start = (await alice.call("POST", "/v1/providers/claude/connect", {})).body
  .connection;
r = await alice.call("POST", "/v1/providers/claude/connect/code", {
  code: "notarealcode123",
});
check(
  r.body.connection?.status === "waiting" &&
    r.body.connection.error?.code === "wrong_code",
  "claude: malformed code -> waiting + wrong_code",
  r.body.connection?.error?.message,
);
const state = new URL(start.url).searchParams.get("state");
r = await alice.call("POST", "/v1/providers/claude/connect/code", {
  code: `boguscode0000#${state}`,
});
check(
  r.body.connection?.status === "waiting" &&
    r.body.connection.error?.code === "wrong_code_reissued" &&
    r.body.connection.url !== start.url,
  "claude: code refused by Anthropic -> fresh sign-in, waiting + wrong_code_reissued",
  r.body.connection?.error?.message,
);
await alice.call("DELETE", "/v1/providers/claude/connect");

// --- 4. Own Anthropic API key (bogus) ----------------------------------------------------------------
t0 = performance.now();
r = await alice.call("POST", "/v1/providers/claude/connect", {
  method: "api_key",
  apiKey: `sk-ant-api03-${"0".repeat(80)}AA`,
});
check(
  r.body.connection?.status === "failed" &&
    r.body.connection.error?.code === "invalid_api_key",
  "claude: a bogus API key is refused and removed",
  seconds(t0),
);
check(
  (await alice.call("GET", "/v1/providers")).body.providers[0].status ===
    "not_connected",
  "claude: still not connected after the refused key",
);

// --- 4b. Own OpenRouter API key (bogus): verified by OpenRouter itself, through the egress proxy -----
t0 = performance.now();
r = await alice.call("POST", "/v1/providers/openrouter/connect", {
  method: "api_key",
  apiKey: `sk-or-v1-${"0".repeat(64)}`,
});
check(
  r.body.connection?.status === "failed" &&
    r.body.connection.error?.code === "invalid_api_key",
  "openrouter: a bogus API key is refused and removed",
  seconds(t0),
);
check(
  (await alice.call("GET", "/v1/providers")).body.providers.find(
    (p: any) => p.id === "openrouter",
  ).status === "not_connected" &&
    inRuntime(alice.subject, 'test -e "$HOME/.agent-runtime/openrouter-api-key" && echo kept') === "",
  "openrouter: still not connected, and the key is gone from the volume",
);
check(
  (await alice.call("POST", "/v1/providers/openrouter/connect", {})).status === 400,
  "openrouter: connects only with an API key",
);

// --- 4c. Own Gemini API key (bogus): checked against Google's model list from inside the runtime ----
t0 = performance.now();
r = await alice.call("POST", "/v1/providers/gemini/connect", {
  method: "api_key",
  apiKey: `AIza${"0".repeat(35)}`,
});
check(
  r.body.connection?.status === "failed" &&
    r.body.connection.error?.code === "invalid_api_key",
  "gemini: a bogus API key is refused and removed",
  seconds(t0),
);
check(
  (await alice.call("GET", "/v1/providers")).body.providers.find(
    (p: any) => p.id === "gemini",
  ).status === "not_connected" &&
    inRuntime(alice.subject, 'test -e "$HOME/.agent-runtime/gemini-api-key" && echo kept') === "",
  "gemini: still not connected, and the key is gone from the volume",
);

// --- 5. A second person sees nothing of the first ----------------------------------------------------
await bob.listen();
await bob.live();
const bobList = await bob.call("GET", "/v1/conversations");
check(
  bobList.status === 200 && bobList.body.conversations.length === 0,
  "second person: no conversations",
);
check(
  vm(alice.subject) !== vm(bob.subject) && vmStatus(bob.subject) === "running",
  "second person: a separate microVM",
);

// --- 6. MCP servers, the proxy, instructions ---------------------------------------------------------
r = await alice.call("PUT", "/v1/mcp-servers/stub", { url: stubUrl, description: "Stub app" });
check(
  r.status === 201 && r.body.server.url === stubUrl && r.body.server.hasCredential === false,
  "mcp: PUT registers a server for this person",
  r.status === 201 ? "" : `${r.status} ${r.body?.message} (is ${new URL(stubUrl).origin} in MCP_ALLOWED_ORIGINS?)`,
);
check(
  (await alice.call("PUT", "/v1/mcp-servers/other", { url: "ftp://example.com/mcp" })).status === 400,
  "mcp: a non-http(s) url is refused",
);
check(
  (await alice.call("GET", "/v1/mcp-servers")).body.servers.map((s: any) => s.name).join() === "stub" &&
    (await bob.call("GET", "/v1/mcp-servers")).body.servers.length === 0,
  "mcp: GET lists the person's own servers only",
);
r = await alice.call("PUT", "/v1/instructions", { text: "The codeword is TEAL-HERON.\n" });
const mcpToml = await waitFor(() => {
  const t = inRuntime(alice.subject, 'cat "$HOME/happy/config/mcp.toml" 2>/dev/null');
  return t.includes("[mcp_servers.stub]") ? t : undefined;
}, 60_000); // the gateway restarts the idle runtime so Happy reads it
// Read back once that restart is through (a read cut off by it is a 503, never an empty file).
const instructions = await alice.call("GET", "/v1/instructions");
check(
  r.status === 200 && instructions.body?.text === "The codeword is TEAL-HERON.\n",
  "instructions: PUT and GET",
  r.status === 200 && instructions.status === 200 ? "" : `PUT ${r.status}, GET ${instructions.status} ${JSON.stringify(instructions.body).slice(0, 120)}`,
);
check(
  !!mcpToml && mcpToml.includes(`/mcp/${runtimeKey(serviceSecret, alice.subject)}/stub"`) && !mcpToml.includes(new URL(stubUrl).host),
  "mcp: the runtime's mcp.toml names only the gateway proxy, never the upstream",
);
check(
  inRuntime(alice.subject, 'cat "$HOME/projects/chats/AGENTS.md" "$HOME/projects/chats/CLAUDE.md"') ===
    "The codeword is TEAL-HERON.\nThe codeword is TEAL-HERON.",
  "instructions: AGENTS.md and CLAUDE.md in the chat workspace",
);
const probeBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lookup_customer", arguments: { id: "1" } } });
const proxyCurl = (auth: string) =>
  `curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' ${auth} --data "$BODY" "$MCP_PROXY_URL/stub"`;
check(
  inRuntime(alice.subject, proxyCurl(""), { BODY: probeBody }) === "401" &&
    inRuntime(alice.subject, proxyCurl("-H 'authorization: Bearer wrong'"), { BODY: probeBody }) === "401",
  "proxy: an absent or wrong runtime token is refused",
);
const noCredential = inRuntime(
  alice.subject,
  `curl -s -m 10 -X POST -H 'content-type: application/json' -H "authorization: Bearer $MCP_PROXY_TOKEN" --data "$BODY" "$MCP_PROXY_URL/stub"`,
  { BODY: probeBody },
);
check(
  noCredential.includes(COPY.expired("stub")) && stub.requests.length === 0,
  "proxy: its own runtime gets a clear MCP error while no credential was sent",
  noCredential.slice(0, 160),
);
const aliceProxyToken = inRuntime(alice.subject, 'printf %s "$MCP_PROXY_TOKEN"');
const aliceKey = runtimeKey(serviceSecret, alice.subject);
// Bob's runtime reaches the proxy only through its own route: it tries Alice's path there.
check(
  inRuntime(bob.subject, `curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $MCP_PROXY_TOKEN" --data "$BODY" "\${MCP_PROXY_URL%/mcp/*}/mcp/$KEY/stub"`, {
    BODY: probeBody,
    KEY: aliceKey,
  }) === "401",
  "proxy: another person's runtime cannot use its own token on this person's path",
);
check(
  inRuntime(bob.subject, `curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $T" --data "$BODY" "\${MCP_PROXY_URL%/mcp/*}/mcp/$KEY/stub"`, {
    BODY: probeBody,
    KEY: aliceKey,
    T: aliceProxyToken,
  }) === "403",
  "proxy: a leaked runtime token is refused from any other microVM",
);

// --- 7. Real turns (optional) -----------------------------------------------------------------------
const realSubject = process.env.E2E_REAL_SUBJECT;
if (realSubject) {
  const real = await client(realSubject);
  await real.listen();
  const status = (await real.live()) ?? [];
  const cheap: Record<string, string[]> = {
    claude: ["claude-code/haiku", "claude-code/sonnet"],
    codex: ["codex-cli/gpt-6-luna"],
    grok: ["xai/grok-4.5"],
    openrouter: ["deepseek/deepseek-v4.1-flash-1017"],
    gemini: ["antigravity/gemini-3.8-flash"],
  };
  const questions: string[] = [];
  const ask = async (id: string, text: string, extra: Record<string, unknown> = {}) => {
    const mark = real.events.length;
    const sent = await real.call("POST", `/v1/conversations/${id}/messages`, {
      text,
      ...extra,
    });
    const answered = new Set<string>();
    const done = await waitFor(async () => {
      // Permission questions (the harness's own, or an MCP server's) arrive through /v1 like any other.
      for (const e of real.events.slice(mark))
        if (
          e.event === "conversation.question" &&
          e.data.conversationId === id &&
          e.data.question.prompts?.length === 1 &&
          !answered.has(e.data.question.id)
        ) {
          answered.add(e.data.question.id);
          const q = e.data.question;
          const allow = q.prompts[0].options.find((o: any) => /^(Allow once|Approve)$/.test(o.label));
          const r = await real.call("POST", `/v1/conversations/${id}/questions/${q.id}`, { answer: allow?.label ?? q.prompts[0].options[0]?.label });
          questions.push(`${q.askedBy ?? "agent"}: ${q.prompts[0].question.slice(0, 80)} -> ${allow?.label} (${r.status})`);
        }
      // Done when the run holding this message has ended. (A message sent while a run is still
      // winding down steers it, which ends that earlier run first.)
      const page = await real.call("GET", `/v1/conversations/${id}/messages?limit=20`);
      const runId = page.body?.messages?.find((m: any) => m.id === sent.body?.message?.id)?.runId;
      const run = page.body?.runs?.find((x: any) => x.id === runId);
      return run && run.status !== "running" ? { data: { run } } : undefined;
    }, 300_000);
    const deltas = real.events
      .slice(mark)
      .filter(
        (e) => e.event === "conversation.delta" && e.data.conversationId === id,
      )
      .map((e) => e.data.append);
    const page = await real.call("GET", `/v1/conversations/${id}/messages`);
    const reply =
      page.body.messages.filter((m: any) => m.role === "assistant").at(-1)
        ?.text ?? "";
    return { sent: sent.status, run: done?.data.run, deltas, reply };
  };
  // The person's app registers its MCP server and standing instructions once.
  await real.call("PUT", "/v1/mcp-servers/stub", { url: stubUrl });
  await real.call("PUT", "/v1/instructions", { text: "The codeword is TEAL-HERON.\n" });
  await waitFor(
    () => inRuntime(realSubject, 'grep -c "mcp_servers.stub" "$HOME/happy/config/mcp.toml"') === "1" || undefined,
    60_000,
  );
  const created: string[] = [];
  for (const p of status) {
    if (p.status !== "connected") {
      console.log(`SKIP  ${p.id}: not connected for ${realSubject}`);
      continue;
    }
    const model =
      cheap[p.id]?.find((m) => p.models.some((x: any) => x.id === m)) ??
      p.models[0].id;
    console.log(
      `      ${p.id}: ${p.account?.plan ?? "?"} plan, live models: ${p.models.map((m: any) => m.id).join(", ")}`,
    );
    const conv = (
      await real.call("POST", "/v1/conversations", {
        provider: p.id,
        model,
        effort: "low",
        title: `e2e ${p.id}`,
      })
    ).body.conversation;
    const first = await ask(conv.id, "Reply with the single word: pong");
    check(
      first.run?.status === "completed" && /pong/i.test(first.reply),
      `${p.id}: real turn on ${model}`,
      `reply "${first.reply}", ${first.deltas.length} streamed deltas`,
    );
    t0 = performance.now();
    msb("stop", vm(realSubject)); // stopped outside the gateway (the idle stop does the same after IDLE_MINUTES)
    const second = await ask(
      conv.id,
      "What single word did you reply with in your previous message? Answer with just that word.",
    );
    check(
      second.run?.status === "completed" && /pong/i.test(second.reply),
      `${p.id}: remembers after the runtime was stopped`,
      `reply "${second.reply}", restart+turn ${seconds(t0)}`,
    );
    created.push(conv.id);

    // The app's MCP tool, called with this message's credential through the gateway's proxy.
    const credential = `Bearer valid-e2e-${run}-${p.id}`;
    const page = `PAGE-${run}-${p.id}`;
    const question =
      "Use the lookup_customer tool to look up customer 42. Reply with three short lines: the customer's name, the codeword from your standing instructions, and the page id the app says I am viewing.";
    const mark = real.events.length;
    const lookup = await ask(conv.id, question, {
      mcpAuth: { stub: credential },
      context: `The person is viewing page ${page} in the app.`,
    });
    const calls = stub.requests.filter((x) => x.tool === "lookup_customer" && x.authorization === credential);
    check(
      lookup.run?.status === "completed" && lookup.reply.includes(STUB_CUSTOMER.name) && calls.some((x) => x.status === 200),
      `${p.id}: calls the app's MCP tool through the proxy with this message's credential`,
      `reply ${JSON.stringify(lookup.reply.slice(0, 120))}, ${calls.length} upstream call(s)`,
    );
    check(/TEAL-HERON/.test(lookup.reply), `${p.id}: follows the standing instructions (${p.id === "claude" ? "CLAUDE.md" : "AGENTS.md"})`);
    const history = await real.call("GET", `/v1/conversations/${conv.id}/messages`);
    const userTexts = [
      ...history.body.messages.filter((m: any) => m.role === "user").map((m: any) => m.text),
      ...real.events
        .slice(mark)
        .filter((e) => e.event === "conversation.message" && e.data.message.role === "user")
        .map((e) => e.data.message.text),
    ];
    check(
      lookup.reply.includes(page) &&
        history.body.messages.filter((m: any) => m.role === "user").at(-1)?.text === question &&
        !userTexts.some((t: string) => t.includes(page) || t.startsWith(CONTEXT_OPEN)),
      `${p.id}: the context reaches the agent and stays out of history and events`,
    );
    const expiredCredential = `Bearer expired-e2e-${run}-${p.id}`;
    const expired = await ask(
      conv.id,
      "Look up customer 43 with lookup_customer. If the tool returns an error, quote the error text exactly.",
      { mcpAuth: { stub: expiredCredential } },
    );
    check(
      expired.run?.status === "completed" &&
        /expired/i.test(expired.reply) &&
        stub.requests.some((x) => x.authorization === expiredCredential && x.status === 401),
      `${p.id}: an expired credential comes back as a clear error the agent relays`,
      JSON.stringify(expired.reply.slice(0, 140)),
    );
  }
  for (const q of questions) console.log(`      question answered through /v1: ${q}`);

  // The credentials never entered the runtime: not its configuration, environment, files or logs.
  const marker = `(valid|expired)-e2e-${run}`;
  const logsOf = (...args: string[]) => {
    const p = Bun.spawnSync(args);
    return p.stdout.toString() + p.stderr.toString();
  };
  const leaks = [
    msb("inspect", vm(realSubject)),
    inRuntime(realSubject, 'cat /proc/[0-9]*/environ 2>/dev/null | tr "\\0" "\\n"'),
    logsOf("docker", "exec", GATEWAY, "msb", "logs", vm(realSubject)),
    logsOf("docker", "logs", GATEWAY),
  ].filter((text) => new RegExp(marker).test(text)).length;
  const files = inRuntime(
    realSubject,
    'grep -r -l -a -E "$PAT" / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev 2>/dev/null; true',
    { PAT: marker },
  );
  const used = new Set(stub.requests.map((x) => x.authorization).filter((a) => a && new RegExp(marker).test(a)));
  check(
    used.size >= 2 && leaks === 0 && files === "",
    "credentials never appear in the runtime (inspect, process environments, filesystem, logs)",
    `${used.size} credentials checked${files ? `; found in ${files}` : ""}`,
  );

  // Conversations: search, rename, archive (also cleans up this run's conversations).
  if (created.length) {
    const found = await real.call("GET", `/v1/conversations?query=${encodeURIComponent(`e2e ${status[0].id}`)}&limit=50`);
    const renamed = await real.call("PATCH", `/v1/conversations/${created[0]}`, { title: `e2e renamed ${run}` });
    const search = await real.call("GET", `/v1/conversations?query=renamed%20${run}`);
    const firstPage = await real.call("GET", "/v1/conversations?limit=1");
    check(
      found.body.conversations.some((c: any) => c.id === created[0]) &&
        renamed.body.conversation.title === `e2e renamed ${run}` &&
        search.body.conversations.map((c: any) => c.id).join() === created[0] &&
        firstPage.body.conversations.length === 1 &&
        typeof firstPage.body.nextCursor === "string",
      "conversations: title search, paging and rename",
    );
    for (const id of created) await real.call("DELETE", `/v1/conversations/${id}`);
    const after = (await real.call("GET", "/v1/conversations?limit=200")).body.conversations.map((c: any) => c.id);
    check(
      created.every((id) => !after.includes(id)) &&
        (await real.call("GET", `/v1/conversations/${created[0]}/messages`)).status === 404,
      "conversations: DELETE archives them",
    );
  }
  const bobSees = (await bob.call("GET", "/v1/conversations")).body
    .conversations;
  check(
    bobSees.length === 0,
    "second person sees none of the real conversations",
  );
  real.close();
}

// --- 8. Idle footprint ----------------------------------------------------------------------------
await Bun.sleep(5000);
console.log(`      idle footprint ${vm(alice.subject)}:`);
console.log(msb("metrics", vm(alice.subject)).replace(/^/gm, "        "));
console.log(
  `      Tandem container (gateway and every microVM): ${docker("stats", "--no-stream", "--format", "{{.MemUsage}} cpu={{.CPUPerc}}", GATEWAY)}`,
);

alice.close();
bob.close();
stub.stop();
console.log(failures ? `E2E FAILED (${failures})` : "E2E PASSED");
process.exit(failures ? 1 : 0);
