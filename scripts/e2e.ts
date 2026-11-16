// End-to-end check against a running stack (docker compose up). Uses the Docker CLI on the host only
// to measure footprint and to force-stop a runtime; everything else goes through the /v1 façade.
//
//   bun scripts/e2e.ts                      sign-in flows, wrong codes, isolation, cold start, footprint
//   E2E_REAL_SUBJECT=<subject> bun scripts/e2e.ts
//                                           also real turns for that subject's signed-in accounts (needs a
//                                           DEV_VOLUME_OVERRIDES entry that mounts a volume with real logins)
import { devToken } from "../src/auth";
import { runtimeKey } from "../src/runtime";
import { sseFrames } from "../src/sse";

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
  process.env.RUNTIME_NETWORK || `${PREFIX}-runtimes`,
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

// --- 6. Real turns (optional) -----------------------------------------------------------------------
const realSubject = process.env.E2E_REAL_SUBJECT;
if (realSubject) {
  const real = await client(realSubject);
  await real.listen();
  const status = (await real.call("GET", "/v1/providers")).body.providers;
  const cheap: Record<string, string[]> = {
    claude: ["claude-code/haiku", "claude-code/sonnet"],
    codex: ["codex-cli/gpt-6-luna"],
  };
  const ask = async (id: string, text: string) => {
    const sent = await real.call("POST", `/v1/conversations/${id}/messages`, {
      text,
    });
    const mark = real.events.length;
    const done = await waitFor(
      () =>
        real.events
          .slice(mark)
          .find(
            (e) =>
              e.event === "conversation.run" &&
              e.data.conversationId === id &&
              e.data.run.status !== "running",
          ),
      300_000,
    );
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
  }
  const bobSees = (await bob.call("GET", "/v1/conversations")).body
    .conversations;
  check(
    bobSees.length === 0,
    "second person sees none of the real conversations",
  );
  real.close();
}

// --- 7. Idle footprint ----------------------------------------------------------------------------
await Bun.sleep(5000);
console.log(
  `      idle footprint ${container(alice.subject)}: ${docker("stats", "--no-stream", "--format", "{{.MemUsage}} cpu={{.CPUPerc}} pids={{.PIDs}}", container(alice.subject))}`,
);
console.log(
  `      gateway: ${docker("stats", "--no-stream", "--format", "{{.MemUsage}} cpu={{.CPUPerc}}", `${PREFIX}-gateway`)}`,
);

alice.close();
bob.close();
console.log(failures ? `E2E FAILED (${failures})` : "E2E PASSED");
process.exit(failures ? 1 : 0);
