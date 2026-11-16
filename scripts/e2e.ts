// End-to-end check against a running stack (docker compose up). Uses the Docker CLI on the host only
// to measure footprint and to force-stop a runtime; everything else goes through the /v1 façade.
//
//   bun scripts/e2e.ts                      sign-in flows, wrong codes, isolation, cold start, footprint
//   E2E_REAL_SUBJECT=<subject> bun scripts/e2e.ts
//                                           also real turns for that subject's signed-in accounts (its runtime
//                                           volume must hold real logins, e.g. through DEV_VOLUME_OVERRIDES),
//                                           including MCP tool calls through the gateway's proxy
//
// The MCP checks run a stub MCP server on this host (E2E_STUB_PORT, default 8791) that the gateway
// reaches at E2E_STUB_URL (default http://host.docker.internal:8791/mcp); the gateway's
// MCP_ALLOWED_ORIGINS must allow that origin.
import { devToken } from "../src/auth";
import { CONTEXT_OPEN } from "../src/happy";
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
/** Runs a shell snippet inside a runtime; values travel through the exec environment, not argv. */
const inRuntime = (subject: string, script: string, env: Record<string, string> = {}) =>
  Bun.spawnSync(
    ["docker", "exec", ...Object.keys(env).flatMap((k) => ["-e", k]), container(subject), "sh", "-c", script],
    { env: { ...process.env, ...env } },
  )
    .stdout.toString()
    .trim();
const container = (subject: string) =>
  `${PREFIX}-rt-${runtimeKey(serviceSecret, subject)}`;

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
  const ac = new AbortController();
  const listen = async () => {
    const res = await fetch(`${BASE}/v1/events`, {
      headers: { authorization: `Bearer ${token}` },
      signal: ac.signal,
    });
    void (async () => {
      try {
        for await (const f of sseFrames(res.body!))
          events.push({ event: f.event, data: JSON.parse(f.data) });
      } catch {}
    })();
  };
  return { subject, call, events, listen, close: () => ac.abort() };
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

// --- 1. Cold start, provider status, footprint ----------------------------------------------------
const alice = await client(`e2e-alice-${run}`);
const bob = await client(`e2e-bob-${run}`);
let t0 = performance.now();
const providers = await alice.call("GET", "/v1/providers");
const cold = seconds(t0);
check(
  providers.status === 200 && providers.body.providers.length === 2,
  "cold start: GET /v1/providers creates and starts a fresh runtime",
  cold,
);
for (const p of providers.body.providers)
  console.log(`      ${p.id}: ${p.status}, ${p.models.length} models`);
docker("stop", "-t", "30", container(alice.subject)); // as after an idle stop
t0 = performance.now();
const warm = await alice.call("GET", "/v1/providers");
check(warm.status === 200, "warm start: a stopped runtime starts again on the next request", seconds(t0));
check(
  docker("port", container(alice.subject)) === "",
  "runtime publishes no host ports",
);
const allow = docker(
  "inspect",
  "-f",
  "{{range .Config.Env}}{{println .}}{{end}}",
  container(alice.subject),
)
  .split("\n")
  .find((l) => l.startsWith("HAPPY_BRIDGE_ALLOW="));
check(
  !!allow && /\/32$/.test(allow),
  "runtime bridge accepts only the gateway address",
  allow,
);
// Another container on the private network cannot even open the bridge port, and the bridge still needs the token.
const probe = Bun.spawnSync([
  "docker",
  "run",
  "--rm",
  "--network",
  docker("inspect", "-f", "{{.HostConfig.NetworkMode}}", container(alice.subject)),
  "--entrypoint",
  "curl",
  process.env.RUNTIME_IMAGE || "tandem-runtime:2026.11.6-preview.7",
  "-sS",
  "-m",
  "5",
  "-o",
  "/dev/null",
  "-w",
  "%{http_code}",
  `http://${container(alice.subject)}:24790/v0/health`,
]);
check(
  probe.exitCode !== 0 && !probe.stdout.toString().startsWith("2"),
  "a neighbour container on the runtime network is refused",
  probe.stderr.toString().trim().slice(0, 80),
);

// --- 2. Connect -> cancel for both providers ---------------------------------------------------------
await alice.listen();
for (const id of ["claude", "codex"]) {
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
let r = await alice.call("POST", "/v1/providers/claude/connect/code", {
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
    r.body.connection.error?.code === "wrong_code" &&
    r.body.connection.url !== start.url,
  "claude: code refused by Anthropic -> fresh sign-in, waiting + wrong_code",
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

// --- 5. A second person sees nothing of the first ----------------------------------------------------
const bobList = await bob.call("GET", "/v1/conversations");
check(
  bobList.status === 200 && bobList.body.conversations.length === 0,
  "second person: no conversations",
);
check(
  container(alice.subject) !== container(bob.subject),
  "second person: separate runtime container",
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
const aliceProxyUrl = inRuntime(alice.subject, 'printf %s "$MCP_PROXY_URL"');
// Bob's runtime reaches the proxy only on its own network: it tries Alice's path there with its token.
check(
  inRuntime(bob.subject, `curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $MCP_PROXY_TOKEN" --data "$BODY" "\${MCP_PROXY_URL%/*}/$KEY/stub"`, {
    BODY: probeBody,
    KEY: runtimeKey(serviceSecret, alice.subject),
  }) === "401",
  "proxy: another person's runtime cannot use its own token on this person's path",
);
const neighbour = Bun.spawnSync(
  [
    "docker", "run", "--rm", "-e", "T", "-e", "U", "-e", "BODY",
    "--network", docker("inspect", "-f", "{{.HostConfig.NetworkMode}}", container(alice.subject)),
    "--entrypoint", "sh", process.env.RUNTIME_IMAGE || "tandem-runtime:2026.11.6-preview.7",
    "-c", `curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $T" --data "$BODY" "$U/stub"`,
  ],
  { env: { ...process.env, T: aliceProxyToken, U: aliceProxyUrl, BODY: probeBody } },
);
check(
  neighbour.stdout.toString() === "403",
  "proxy: a leaked runtime token is refused from any other container",
  neighbour.stdout.toString(),
);

// --- 7. Real turns (optional) -----------------------------------------------------------------------
const realSubject = process.env.E2E_REAL_SUBJECT;
if (realSubject) {
  const real = await client(realSubject);
  await real.listen();
  const status = (await real.call("GET", "/v1/providers")).body.providers;
  const cheap: Record<string, string[]> = {
    claude: ["claude-code/haiku", "claude-code/sonnet"],
    codex: ["codex-cli/gpt-6-luna"],
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
      cheap[p.id]!.find((m) => p.models.some((x: any) => x.id === m)) ??
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
    docker("stop", "-t", "30", container(realSubject)); // forced stop (the idle stop does the same after IDLE_MINUTES)
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
  const rt = container(realSubject);
  const leaks = [
    docker("inspect", rt),
    inRuntime(realSubject, 'cat /proc/[0-9]*/environ 2>/dev/null | tr "\\0" "\\n"'),
    Bun.spawnSync(["docker", "logs", rt]).stdout.toString() + Bun.spawnSync(["docker", "logs", rt]).stderr.toString(),
    Bun.spawnSync(["docker", "logs", `${PREFIX}-gateway`]).stdout.toString() + Bun.spawnSync(["docker", "logs", `${PREFIX}-gateway`]).stderr.toString(),
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
console.log(
  `      idle footprint ${container(alice.subject)}: ${docker("stats", "--no-stream", "--format", "{{.MemUsage}} cpu={{.CPUPerc}} pids={{.PIDs}}", container(alice.subject))}`,
);
console.log(
  `      gateway: ${docker("stats", "--no-stream", "--format", "{{.MemUsage}} cpu={{.CPUPerc}}", `${PREFIX}-gateway`)}`,
);

alice.close();
bob.close();
stub.stop();
console.log(failures ? `E2E FAILED (${failures})` : "E2E PASSED");
process.exit(failures ? 1 : 0);
