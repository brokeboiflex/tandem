// End-to-end check of Tandem as it is deployed: the image built from this checkout, run with
// compose.yaml's privileges, the real gateway process (scripts/e2e-gateway.ts: src/gateway.ts with each
// agent's test options), every vendor's own program in the person's crun sandboxes, and the scripted
// vendor APIs (scripts/mock-vendor/serve.ts), which the sandboxes reach only through the gateway's
// egress proxy. Everything a client does goes through HTTP /v1. The Docker CLI and the host's cgroup
// files only look inside (a person's sandbox through src/cli.ts, crun's list, processes, memory) and
// restart or recreate the container. No real vendor is contacted and no real credential is used: the
// egress allowlist names the mock alone (scripts/e2e/egress-allowlist.txt).
//
//   sudo BUN=$HOME/.bun/bin/bun scripts/e2e/run.sh     build, start, then both runs below
//   bun scripts/e2e.ts             every provider through /v1 (connect, a shell tool call in the
//                                  sandbox, a question allowed and one denied, abort, resume after the
//                                  process was released, MCP through the proxy, hidden context, history
//                                  paging, a refused sign-in), isolation, sign-ins, the MCP proxy's
//                                  checks, a gateway restart mid-run; PERMISSION_MODE=auto (the
//                                  default), then Claude's own questions under workspace_write
//   bun scripts/e2e.ts capacity    measurements: image, idle memory, cold and warm turns, per-person
//                                  peaks, 5 first Claude turns at once, 5 providers at once
//
// Run as root on the Docker host from the project directory: Bun loads .env (DEV_AUTH_SECRET,
// SERVICE_SECRET). E2E_PROJECT names the compose project (default tandem-agents-e2e).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { devToken } from "../src/auth";
import { CONTEXT_OPEN, PROVIDER_IDS } from "../src/providers";
import { COPY, proxyToken } from "../src/mcp";
import { runtimeKey } from "../src/runtime";
import { sseFrames } from "../src/sse";
import type { ProviderId } from "../src/agents/types";
import { STUB_CUSTOMER } from "./stub-mcp";

const MODE = process.argv[2] ?? "scenarios";
const RUN = Date.now().toString(36);
const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:8787";
const MOCK = process.env.E2E_MOCK_URL ?? "http://127.0.0.1:4797";
const PROJECT = process.env.E2E_PROJECT ?? "tandem-agents-e2e";
const PREFIX = process.env.RUNTIME_PREFIX || "tandem";
const IDLE_MS = (Number(process.env.IDLE_MINUTES) || 2) * 60_000;
const MOCK_HOST = "mock.tandem.test";
const STUB_URL = `http://${MOCK_HOST}:4798/mcp`;
const secret = process.env.DEV_AUTH_SECRET ?? "";
const serviceSecret = process.env.SERVICE_SECRET ?? "";
if (secret.length < 32 || serviceSecret.length < 32)
  throw new Error(
    "Run from the project directory with the e2e .env (scripts/e2e/run.sh writes it).",
  );

// --- Output ----------------------------------------------------------------------------------------

const T0 = performance.now();
const stamp = () =>
  `${((performance.now() - T0) / 1000).toFixed(1)}s`.padStart(7);
const say = (...a: unknown[]) => console.log(stamp(), ...a);
const section = (title: string) => console.log(`\n${stamp()} == ${title}`);
const ms = (v: number | null | undefined) =>
  v === null || v === undefined ? "n/a" : `${Math.round(v)} ms`;
const mib = (b: number | null | undefined) =>
  b === null || b === undefined ? "n/a" : `${(b / 2 ** 20).toFixed(0)} MiB`;
const short = (s: unknown, n = 140) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .slice(0, n);

let failures = 0;
/** provider -> scenario -> passed (every check of that cell). */
const table = new Map<ProviderId, Map<string, boolean>>();
function check(
  ok: boolean,
  label: string,
  detail = "",
  at?: [ProviderId, string],
) {
  console.log(
    `${stamp()} ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`,
  );
  if (!ok) failures++;
  if (at) {
    const row = table.get(at[0]) ?? new Map<string, boolean>();
    table.set(at[0], row);
    row.set(at[1], (row.get(at[1]) ?? true) && ok);
  }
  return ok;
}

// --- The host's view: Docker, cgroups, processes ---------------------------------------------------

const sh = (cmd: string[], env?: Record<string, string>) => {
  const p = Bun.spawnSync(cmd, {
    stdin: "ignore",
    env: env ? { ...process.env, ...env } : undefined,
  });
  return {
    code: p.exitCode,
    out: p.stdout.toString(),
    err: p.stderr.toString(),
  };
};
const docker = (...a: string[]) => sh(["docker", ...a]).out.trim();
const container = () =>
  docker(
    "ps",
    "-aq",
    "--filter",
    `label=com.docker.compose.project=${PROJECT}`,
    "--filter",
    "label=com.docker.compose.service=tandem",
  ).split("\n")[0]!;
let C = container();
if (!C) throw new Error(`no Tandem container in compose project ${PROJECT}`);
const IMAGE = docker("inspect", "-f", "{{.Config.Image}}", C);
/** The container's cgroup on the host (the gateway's own tree is delegated below it). */
function containerCgroup() {
  const id = docker("inspect", "-f", "{{.Id}}", C);
  const scope = `/sys/fs/cgroup/system.slice/docker-${id}.scope`;
  if (existsSync(scope)) return scope;
  const pid = docker("inspect", "-f", "{{.State.Pid}}", C);
  const line = readFileSync(`/proc/${pid}/cgroup`, "utf8").trim();
  return `/sys/fs/cgroup${line.replace(/^0::/, "").replace(/\/gateway$/, "")}`;
}
let CG = containerCgroup();
const read = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};
const num = (path: string) => {
  const t = read(path);
  return t === null ? null : Number(t.trim().split(/\s+/)[0]);
};
const statOf = (dir: string, field: string) => {
  const m = (read(`${dir}/memory.stat`) ?? "").match(
    new RegExp(`^${field} (\\d+)$`, "m"),
  );
  return m ? Number(m[1]) : null;
};
const oomKills = (dir: string) =>
  Number(
    (read(`${dir}/memory.events`) ?? "").match(/^oom_kill (\d+)$/m)?.[1] ?? 0,
  );
const personCgroup = (key: string) => `${CG}/sandboxes/${PREFIX}-${key}`;
/** The person's running sandboxes: the child cgroups of their cgroup (one per process). */
const sandboxesOf = (key: string) => {
  try {
    return readdirSync(personCgroup(key), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
};
/** Sandboxes crun knows of for this person (running or not). */
const crunOf = (key: string) => {
  try {
    return (
      JSON.parse(
        docker(
          "exec",
          C,
          "crun",
          "--cgroup-manager=disabled",
          "list",
          "--format",
          "json",
        ) || "[]",
      ) as { id: string; status: string }[]
    ).filter((x) => x.id.startsWith(`${PREFIX}-${key}-`));
  } catch {
    return [];
  }
};
const uidOf = (key: string): number | undefined =>
  JSON.parse(docker("exec", C, "cat", "/var/lib/tandem/uids.json") || "{}")[
    key
  ];
/** Processes of a uid on the host (sandboxes run as the person's uid, no user namespace). */
const processesOf = (uid: number | undefined) =>
  uid === undefined
    ? []
    : sh(["ps", "-eo", "uid=,pid=,args="])
        .out.split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith(`${uid} `));
/** Sleeping commands of the slow scripts, by the person's uid. */
const sleepers = (uid: number | undefined) =>
  processesOf(uid).filter((l) => /\bsleep (60|300)\b/.test(l));
const shq = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
/** A shell snippet as the person, in a one-shot sandbox like theirs (src/cli.ts exec). */
const inSandbox = (key: string, script: string) => {
  const r = sh([
    "docker",
    "exec",
    C,
    "bun",
    "src/cli.ts",
    "exec",
    key,
    "--",
    "sh",
    "-c",
    script,
  ]);
  return (r.out + r.err).trim();
};
/** A request on a person's own MCP socket, as their sandbox sends it: "<status> <body>". */
const onMcpSocket = (
  socketKey: string,
  path: string,
  token: string | null,
  body: string,
) =>
  sh([
    "docker",
    "exec",
    "-e",
    `SOCK=/var/lib/tandem/run/${socketKey}/mcp.sock`,
    "-e",
    `URL=http://runtime${path}`,
    "-e",
    `TOKEN=${token ?? ""}`,
    "-e",
    `BODY=${body}`,
    C,
    "bun",
    "-e",
    `const r = await fetch(process.env.URL, { unix: process.env.SOCK, method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(process.env.TOKEN ? { authorization: "Bearer " + process.env.TOKEN } : {}) }, body: process.env.BODY }); console.log(r.status + " " + (await r.text()).slice(0, 300));`,
  ]).out.trim();
const mock = async (path: string, method = "GET") =>
  (await fetch(MOCK + path, { method })).json() as Promise<any>;
const seen = async (marker: string) =>
  ((await mock(`/seen?marker=${encodeURIComponent(marker)}`)).requests ??
    0) as number;

async function waitFor<T>(
  fn: () =>
    T | undefined | null | false | Promise<T | undefined | null | false>,
  timeoutMs: number,
  everyMs = 200,
): Promise<T | undefined> {
  for (const until = Date.now() + timeoutMs; ; await Bun.sleep(everyMs)) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) return undefined;
  }
}

async function healthy(timeoutMs = 120_000) {
  return !!(await waitFor(
    () =>
      fetch(`${BASE}/healthz`).then(
        (r) => r.ok,
        () => false,
      ),
    timeoutMs,
    250,
  ));
}

/** What the egress proxy (Smokescreen) refused, by requested host: its log, kept across restarts. */
const refused = new Map<string, Set<string>>();
function collectEgress() {
  const r = sh(["docker", "logs", C]);
  for (const line of (r.out + r.err).split("\n")) {
    if (!line.startsWith("{") || !line.includes('"allow":false')) continue;
    try {
      const j = JSON.parse(line);
      const host = String(j.requested_host ?? "?");
      refused.set(host, (refused.get(host) ?? new Set()).add(String(j.id)));
    } catch {}
  }
}

/** `docker restart` (SIGTERM, then the gateway's own shutdown), until /healthz answers again. */
async function restartGateway() {
  collectEgress();
  const t0 = performance.now();
  docker("restart", "-t", "60", C);
  const up = await healthy();
  CG = containerCgroup();
  return { up, ms: performance.now() - t0 };
}

/** Recreates the Tandem container with another PERMISSION_MODE (the data volume stays). */
async function recreate(permissionMode: string) {
  collectEgress();
  const r = sh(
    [
      "docker",
      "compose",
      "-p",
      PROJECT,
      "-f",
      "compose.yaml",
      "-f",
      "scripts/e2e/compose.yaml",
      "up",
      "-d",
      "--no-deps",
      "--wait",
      "tandem",
    ],
    { E2E_PERMISSION_MODE: permissionMode },
  );
  C = container();
  CG = containerCgroup();
  const up = await healthy();
  const line = docker("logs", C)
    .split("\n")
    .filter((l) => l.startsWith("tandem gateway on"))
    .at(-1);
  return { up: up && r.code === 0, line: line ?? short(r.err, 300) };
}

// --- A person: their client of /v1 and their event stream ---------------------------------------

type Ev = { at: number; event: string; data: any };
type Person = Awaited<ReturnType<typeof person>>;

async function person(name: string) {
  const subject = `e2e-${name}-${RUN}`;
  const key = runtimeKey(serviceSecret, subject);
  const token = await devToken(secret, subject);
  const events: Ev[] = [];
  let ac: AbortController | undefined;
  const call = async (method: string, path: string, body?: unknown) => {
    const t0 = performance.now();
    const res = await fetch(BASE + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json, ms: performance.now() - t0 };
  };
  return {
    name,
    subject,
    key,
    call,
    events,
    /** Sent with every message, as the application does once it has registered its MCP server. */
    mcpAuth: null as Record<string, string | null> | null,
    /** Opens (or reopens) the person's event stream, as an app does when its UI opens. */
    async listen() {
      ac?.abort();
      const own = (ac = new AbortController());
      const res = await fetch(`${BASE}/v1/events`, {
        headers: { authorization: `Bearer ${token}` },
        signal: own.signal,
      });
      void (async () => {
        try {
          for await (const f of sseFrames(res.body!))
            events.push({
              at: performance.now(),
              event: f.event,
              data: JSON.parse(f.data),
            });
        } catch {}
      })();
    },
    close: () => ac?.abort(),
    /** The provider's latest state from the stream. */
    provider(id: ProviderId) {
      for (let i = events.length - 1; i >= 0; i--)
        if (
          events[i]!.event === "provider.updated" &&
          events[i]!.data.provider.id === id
        )
          return events[i]!.data as { provider: any; connection: any };
      return null;
    },
  };
}

type TurnOptions = {
  /** The answer to every question of this turn (default "Allow once"). */
  answer?: string;
  context?: string;
  /** Instead of the person's usual mcpAuth (null: none). */
  mcpAuth?: Record<string, string | null> | null;
  /** Abort `ms` after the first running tool (or streamed text) of this run. */
  abortAfter?: { on: "tool" | "delta"; ms: number; before?: () => void };
  timeoutMs?: number;
};

/** One message, its questions answered through /v1, until its run ends. */
async function turn(
  p: Person,
  conv: string,
  text: string,
  o: TurnOptions = {},
) {
  const mark = p.events.length;
  const mcpAuth = o.mcpAuth === undefined ? p.mcpAuth : o.mcpAuth;
  const t0 = performance.now();
  const sent = await p.call("POST", `/v1/conversations/${conv}/messages`, {
    text,
    ...(o.context ? { context: o.context } : {}),
    ...(mcpAuth ? { mcpAuth } : {}),
  });
  const runId: string | undefined = sent.body?.message?.runId;
  const questions: {
    q: any;
    label: string;
    status: number;
    pendingShown: boolean;
    answered: string | null;
  }[] = [];
  let aborting = false;
  let deltas = 0;
  const handled = new Set<string>();
  const end = !runId
    ? undefined
    : await waitFor(
        async () => {
          for (let i = mark; i < p.events.length; i++) {
            const e = p.events[i]!;
            if (e.data?.conversationId !== conv) continue;
            const q = e.data.question;
            if (
              e.event === "conversation.question" &&
              q?.status === "pending" &&
              !handled.has(q.id)
            ) {
              handled.add(q.id);
              const labels: string[] =
                q.prompts?.[0]?.options?.map((x: any) => x.label) ?? [];
              const want = o.answer ?? "Allow once";
              const label = labels.includes(want)
                ? want
                : (labels.find((l) =>
                    want === "Deny"
                      ? /deny|reject/i.test(l)
                      : /^allow|approve|accept/i.test(l),
                  ) ??
                  labels[0] ??
                  want);
              // While it waits, the conversation shows the question.
              const during = await p.call(
                "GET",
                `/v1/conversations/${conv}/messages?limit=1`,
              );
              const r = await p.call(
                "POST",
                `/v1/conversations/${conv}/questions/${q.id}`,
                { answer: label },
              );
              questions.push({
                q,
                label,
                status: r.status,
                pendingShown:
                  during.body?.question?.id === q.id &&
                  during.body?.conversation?.status === "waiting_for_answer",
                answered: r.body?.question?.status ?? null,
              });
            }
            const a = o.abortAfter;
            if (
              a &&
              !aborting &&
              ((a.on === "tool" &&
                e.event === "conversation.message" &&
                e.data.message.runId === runId &&
                e.data.message.tools.some(
                  (t: any) => t.status === "running",
                )) ||
                (a.on === "delta" && e.event === "conversation.delta"))
            ) {
              aborting = true;
              setTimeout(() => {
                a.before?.();
                void p.call("POST", `/v1/conversations/${conv}/abort`);
              }, a.ms);
            }
            if (
              e.event === "conversation.run" &&
              e.data.run.id === runId &&
              e.data.run.status !== "running"
            ) {
              deltas = p.events
                .slice(mark, i)
                .filter(
                  (x) =>
                    x.event === "conversation.delta" &&
                    x.data.conversationId === conv,
                ).length;
              return { run: e.data.run, at: e.at };
            }
          }
        },
        o.timeoutMs ?? 300_000,
        50,
      );
  const page = runId
    ? await p.call("GET", `/v1/conversations/${conv}/messages?limit=20`)
    : null;
  const mine = (page?.body?.messages ?? []).filter(
    (m: any) => m.runId === runId,
  );
  return {
    sent,
    runId,
    run: end?.run ?? null,
    ms: end ? end.at - t0 : null,
    questions,
    deltas,
    reply: mine
      .filter((m: any) => m.role === "assistant")
      .map((m: any) => m.text)
      .join("\n"),
    tools: mine.flatMap((m: any) => m.tools) as {
      name: string;
      status: string;
    }[],
    messages: mine,
  };
}
type Turn = Awaited<ReturnType<typeof turn>>;
const ended = (t: Turn) =>
  `${t.run?.status ?? "no end"}${t.run?.failure ? ` ${t.run.failure.code}` : ""} in ${ms(t.ms)}`;
const toolsOf = (t: Turn) =>
  t.tools.map((x) => `${x.name}:${x.status}`).join(",") || "none";
/** The probe's own output: the person's uid, no capabilities (JSON-escaped in some agents' results). */
const probed = (t: Turn, uid: number | undefined) =>
  t.reply.includes("TOOL_RESULT_SEEN") &&
  t.reply.includes(String(uid)) &&
  /CapEff:(\s|\\t)*0{16}/.test(t.reply);

// --- Providers ---------------------------------------------------------------------------------------

/** How each provider connects, and the scripted model's keywords in its dialect. */
type Spec = {
  id: ProviderId;
  connect: "api_key" | "device";
  good?: string;
  bad?: string;
  /** One call of the agent's shell tool, the identity probe. */
  tool: string;
  /** A tool call the agent asks the person about. */
  ask: string;
  /** A shell call that sleeps for minutes. */
  slow: string;
  mcp: string;
  /** The vendor refuses the sign-in or key (401). */
  refused: string;
};
const SPECS: Spec[] = [
  {
    id: "claude",
    connect: "api_key",
    good: "sk-ant-good-e2e-000000000000000000",
    bad: "sk-ant-bad-e2e-0000000000000000000",
    tool: "RUN_TOOL",
    ask: "RUN_TOOL",
    slow: "RUN_SLOW",
    mcp: "CALL_MCP",
    refused: "AUTH_FAIL",
  },
  {
    id: "codex",
    connect: "device",
    tool: "RUN_TOOL",
    // Codex runs the probe without asking (on-request); `rm -f` it asks about.
    ask: "RUN_DANGEROUS",
    slow: "RUN_SLOW",
    mcp: "RUN_MCP",
    refused: "FAIL_401",
  },
  {
    id: "grok",
    connect: "device",
    tool: "RUN_TOOL",
    ask: "RUN_TOOL",
    slow: "RUN_SLOW",
    mcp: "RUN_MCP",
    refused: "FAIL_401",
  },
  {
    id: "openrouter",
    connect: "api_key",
    good: "sk-or-v1-e2e-good-0000000000000000",
    bad: "sk-or-v1-e2e-bad-00000000000000000",
    tool: "RUN_TOOL",
    ask: "RUN_TOOL",
    slow: "RUN_SLOW",
    mcp: "RUN_MCP",
    refused: "FAIL_401",
  },
  {
    id: "gemini",
    connect: "api_key",
    good: "AIzaE2eGoodKey00000000000000000",
    bad: "AIzaE2ebadKey000000000000000000",
    tool: "RUN_TOOL",
    ask: "RUN_TOOL",
    slow: "RUN_SLOW",
    mcp: "RUN_MCP",
    refused: "FAIL_401",
  },
];

/** Connects the provider through /v1 (the stream must be open); the live provider view once connected. */
async function connect(p: Person, s: Spec, cell = true) {
  const at: [ProviderId, string] | undefined = cell
    ? [s.id, "connect"]
    : undefined;
  if (s.connect === "api_key") {
    if (cell) {
      const bad = await p.call("POST", `/v1/providers/${s.id}/connect`, {
        method: "api_key",
        apiKey: s.bad,
      });
      check(
        bad.body?.connection?.status === "failed" &&
          bad.body.connection.error?.code === "invalid_api_key" &&
          bad.body.connection.error?.params?.provider === s.id,
        `${s.id}: a key the vendor refuses → failed, invalid_api_key`,
        `checked from a sandbox through the egress proxy in ${ms(bad.ms)}`,
        at,
      );
    }
    const good = await p.call("POST", `/v1/providers/${s.id}/connect`, {
      method: "api_key",
      apiKey: s.good,
    });
    if (cell)
      check(
        good.body?.connection?.status === "connected",
        `${s.id}: a key the vendor accepts → connected`,
        `${ms(good.ms)}`,
        at,
      );
  } else {
    const start = await p.call("POST", `/v1/providers/${s.id}/connect`, {});
    const c = start.body?.connection;
    if (cell)
      check(
        c?.status === "waiting" &&
          c.flow === "device_code" &&
          !!c.url &&
          !!c.userCode,
        `${s.id}: connect starts the vendor CLI's device sign-in`,
        `${ms(start.ms)}, ${c?.url}, code ${c?.userCode}`,
        at,
      );
    // The person confirms the code on the vendor's page (Codex's scripted issuer confirms by itself).
    if (s.id === "grok" && c?.userCode)
      await mock(`/approve?userCode=${encodeURIComponent(c.userCode)}`, "POST");
  }
  const live = await waitFor(() => {
    const v = p.provider(s.id)?.provider;
    return v?.status === "connected" && v.models.length ? v : undefined;
  }, 180_000);
  if (cell)
    check(
      !!live,
      `${s.id}: provider.updated connected, with the account's models`,
      live
        ? `${live.method}, ${live.account?.email ?? "-"} / ${live.account?.plan ?? "-"}, models ${live.models
            .slice(0, 4)
            .map((m: any) => m.id)
            .join(", ")}${live.models.length > 4 ? ", …" : ""}`
        : JSON.stringify(p.provider(s.id)),
      at,
    );
  return live;
}

const modelOf = (live: any) =>
  (live.models.find((m: any) => m.default) ?? live.models[0]).id as string;

async function conversation(
  p: Person,
  provider: ProviderId,
  model: string,
  title: string,
) {
  const r = await p.call("POST", "/v1/conversations", {
    provider,
    model,
    title,
  });
  return { r, id: r.body?.conversation?.id as string | undefined };
}

/** The person's registered MCP server and standing instructions, as the application sets them up. */
async function setUp(p: Person, s: Spec) {
  const put = await p.call("PUT", "/v1/mcp-servers/stub", {
    url: STUB_URL,
    description: "Stub customer records",
  });
  p.mcpAuth = { stub: `Bearer valid-e2e-${RUN}-${s.id}` };
  const instr = await p.call("PUT", "/v1/instructions", {
    text: `The codeword is MARK-instr-${s.id}-${RUN}.\n`,
  });
  return put.status === 201 && instr.status === 200;
}

/** A turn that asks, allowed once; then one denied. */
async function allowAndDeny(
  p: Person,
  s: Spec,
  conv: string,
  first?: Turn,
  note = "",
) {
  const allow = first ?? (await turn(p, conv, `${s.ask} now`));
  const qa = allow.questions[0];
  check(
    allow.run?.status === "completed" &&
      !!qa &&
      qa.q.kind === "permission" &&
      qa.q.prompts[0].options.some((o: any) => o.label === "Allow once") &&
      qa.q.prompts[0].options.some((o: any) => o.label === "Deny") &&
      qa.label === "Allow once" &&
      qa.status === 200 &&
      qa.answered === "answered" &&
      qa.pendingShown &&
      allow.tools.some((t) => t.status === "completed"),
    `${s.id}: a permission question through /v1 answered "Allow once": the tool ran${note}`,
    qa
      ? `${qa.q.askedBy}: ${short(qa.q.prompts[0].question, 70)} [${qa.q.prompts[0].options.map((o: any) => o.label).join(" / ")}]; GET showed it pending: ${qa.pendingShown}; ${ended(allow)}`
      : `no question; ${ended(allow)}; ${short(allow.reply, 160)}`,
    [s.id, "allow once"],
  );
  const deny = await turn(p, conv, `${s.ask} once more`, { answer: "Deny" });
  const qd = deny.questions[0];
  check(
    deny.run?.status === "completed" &&
      !!qd &&
      qd.label === "Deny" &&
      qd.status === 200 &&
      !deny.tools.some((t) => t.status === "completed"),
    `${s.id}: another one answered "Deny": the tool did not run, the turn ends normally${note}`,
    `${qd ? `${short(qd.q.prompts[0].question, 60)} → Deny; ` : "no question; "}${ended(deny)}; tools ${toolsOf(deny)}`,
    [s.id, "deny"],
  );
}

/** Abort while the slow command runs, in a conversation of its own; the next turn there completes. */
async function abortMidCommand(
  p: Person,
  s: Spec,
  model: string,
  uid: number | undefined,
  note = "",
) {
  const ca = await conversation(p, s.id, model, `e2e ${s.id} abort`);
  let before: string[] = [];
  const ab = await turn(p, ca.id!, `${s.slow} now`, {
    abortAfter: {
      on: "tool",
      ms: 2500,
      before: () => (before = sleepers(uid)),
    },
  });
  const gone = await waitFor(() => sleepers(uid).length === 0, 20_000);
  const after = await turn(p, ca.id!, "PING after the abort");
  check(
    ab.run?.status === "aborted" &&
      ab.run.failure?.code === "aborted" &&
      before.length > 0 &&
      !!gone &&
      after.run?.status === "completed",
    `${s.id}: abort mid-command → run aborted; the command is gone; the next turn completes${note}`,
    `${ended(ab)}; \`sleep\` running before the abort: ${before.length}, after: ${sleepers(uid).length}; next ${ended(after)}`,
    [s.id, "abort"],
  );
}

// ===================================================================================================
// Scenarios

type State = {
  s: Spec;
  p: Person;
  uid?: number;
  model: string;
  conv: string;
  word: string;
  peaks: number[];
};

const header = (what: string) => {
  console.log(
    `# Tandem ${what}, ${new Date().toISOString()}: image ${IMAGE}, container ${C.slice(0, 12)}, run ${RUN}`,
  );
  console.log(
    `# host: ${sh(["uname", "-srm"]).out.trim()}, ${sh(["nproc"]).out.trim()} vCPU, ${short(sh(["sh", "-c", "free -m | sed -n 2p"]).out)}; ${docker("version", "--format", "Docker {{.Server.Version}}")}`,
  );
  console.log(
    `# gateway: ${docker("logs", C)
      .split("\n")
      .filter((l) => /^(security|tandem gateway)/.test(l))
      .slice(-2)
      .join(" | ")}`,
  );
};

async function scenarios() {
  header("end to end");
  const mode = await recreate("auto");
  check(
    mode.up,
    "the container runs with the deployed PERMISSION_MODE",
    mode.line,
  );

  // --- A new person: reads answer at once and nothing starts --------------------------------------
  section("a new person: nothing runs until they use it");
  const fresh = await person("fresh");
  let r = await fresh.call("GET", "/v1/providers");
  check(
    r.status === 200 &&
      r.body.providers.length === PROVIDER_IDS.length &&
      r.body.providers.every((x: any) => x.status === "not_connected"),
    "GET /v1/providers answers at once: every provider not_connected",
    ms(r.ms),
  );
  r = await fresh.call("GET", "/v1/conversations");
  check(
    r.status === 200 && r.body.conversations.length === 0,
    "GET /v1/conversations: none",
  );
  await fresh.listen();
  await Bun.sleep(3000);
  check(
    fresh.events.filter((e) => e.event === "provider.updated").length ===
      PROVIDER_IDS.length &&
      sandboxesOf(fresh.key).length === 0 &&
      crunOf(fresh.key).length === 0 &&
      !existsSync(personCgroup(fresh.key)),
    "opening /v1/events sends each provider's state and starts no process",
    `${fresh.events.length} events, ${crunOf(fresh.key).length} sandboxes`,
  );
  fresh.close();
  check(
    docker("port", C)
      .split("\n")
      .every((l) => l.startsWith("8787/tcp")),
    "only the API port is published",
    docker("port", C).replace(/\n/g, ", "),
  );

  // --- Sign-in flows that end without signing in -------------------------------------------------
  section("sign-in flows (the vendors' own CLIs in the person's sandbox)");
  const si = await person("signin");
  await si.listen();
  {
    const start = await si.call("POST", "/v1/providers/claude/connect", {});
    const c = start.body?.connection;
    check(
      c?.status === "waiting" &&
        c.flow === "paste_code" &&
        /^https:\/\/\S+\/oauth\/authorize\?/.test(c.url ?? ""),
      "claude: `claude auth login` prints its page; connect answers waiting, paste_code",
      `${ms(start.ms)}, ${String(c?.url).split("?")[0]}?<redacted>, expires ${c?.expiresAt}`,
    );
    const connecting = await waitFor(
      () => si.provider("claude")?.provider.status === "connecting",
      5000,
    );
    check(!!connecting, "claude: provider.updated connecting");
    // A code without its state part: Claude Code's own format check (nothing leaves the sandbox).
    const wrong = await si.call("POST", "/v1/providers/claude/connect/code", {
      code: "notarealcode123",
    });
    check(
      wrong.body?.connection?.status === "waiting" &&
        wrong.body.connection.error?.code === "wrong_code" &&
        wrong.ms < 5000,
      "claude: a malformed code → still waiting, wrong_code, at once",
      `${ms(wrong.ms)}: ${short(wrong.body?.connection?.error?.message)}`,
    );
    const cancelled = await si.call("DELETE", "/v1/providers/claude/connect");
    check(
      cancelled.body?.connection?.status === "cancelled" &&
        (await si.call("GET", "/v1/providers")).body.providers.find(
          (x: any) => x.id === "claude",
        ).status === "not_connected",
      "claude: cancel → cancelled, provider not_connected",
    );
  }
  for (const id of ["codex", "grok"] as const) {
    const start = await si.call("POST", `/v1/providers/${id}/connect`, {});
    const c = start.body?.connection;
    check(
      c?.status === "waiting" && !!c.url && !!c.userCode,
      `${id}: connect → waiting with the CLI's page and code`,
      `${ms(start.ms)}, ${c?.url}, ${c?.userCode}`,
    );
    const cancelled = await si.call("DELETE", `/v1/providers/${id}/connect`);
    await Bun.sleep(500);
    check(
      cancelled.body?.connection?.status === "cancelled" &&
        (await si.call("GET", "/v1/providers")).body.providers.find(
          (x: any) => x.id === id,
        ).status === "not_connected",
      `${id}: cancel → cancelled, provider not_connected`,
    );
  }
  check(
    (await si.call("POST", "/v1/providers/openrouter/connect", {})).status ===
      400 &&
      (await si.call("POST", "/v1/providers/gemini/connect", {})).status ===
        400,
    "openrouter, gemini: connect only with an API key (400 otherwise)",
  );
  {
    await connect(
      si,
      SPECS.find((x) => x.id === "gemini")!,
      false,
    );
    const out = await si.call("DELETE", "/v1/providers/gemini");
    check(
      out.status === 200 &&
        out.body.provider.status === "not_connected" &&
        (await si.call("GET", "/v1/providers")).body.providers.find(
          (x: any) => x.id === "gemini",
        ).status === "not_connected",
      "gemini: DELETE /v1/providers/gemini signs out (the key is forgotten)",
    );
  }
  const quiet = await waitFor(
    () => sandboxesOf(si.key).length === 0,
    IDLE_MS + 60_000,
    1000,
  );
  check(
    !!quiet,
    "after the sign-ins: no process of that person is left",
    `${sandboxesOf(si.key).length} sandboxes`,
  );
  si.close();

  // --- Every provider through /v1 -------------------------------------------------------------------
  const states: State[] = [];
  for (const s of SPECS) {
    section(
      `${s.id}: connect, a conversation, tool calls, questions, abort, MCP, hidden context`,
    );
    const p = await person(s.id);
    await p.listen();
    const live = await connect(p, s);
    if (!live) continue;
    check(
      await setUp(p, s),
      `${s.id}: the app registers its MCP server and standing instructions`,
    );
    const model = modelOf(live);
    const c = await conversation(p, s.id, model, `e2e ${s.id} ${RUN}`);
    check(
      c.r.status === 201 &&
        c.r.body.conversation.provider === s.id &&
        c.r.body.conversation.status === "idle",
      `${s.id}: POST /v1/conversations → 201`,
      `${model}, ${ms(c.r.ms)}`,
      [s.id, "conversation"],
    );
    if (!c.id) continue;
    await Bun.sleep(3000);
    say(
      `  connected, a conversation, no turn yet: ${sandboxesOf(p.key).length} process(es) (${sandboxesOf(p.key).join(", ") || "none"}; a read's process stays for IDLE_MINUTES)`,
    );
    const uid = uidOf(p.key);
    const st: State = {
      s,
      p,
      uid,
      model,
      conv: c.id,
      word: `kiwi${RUN}${s.id}`,
      peaks: [],
    };
    states.push(st);

    // A shell tool call, executed in the person's sandbox (the probe: uid, capabilities, seccomp).
    const t1 = await turn(
      p,
      c.id,
      `REMEMBER ${st.word}. Then ${s.tool} please.`,
    );
    st.peaks.push(num(`${personCgroup(p.key)}/memory.peak`) ?? 0);
    if (s.id === "claude")
      // Claude Code's auto mode asks Anthropic's server whether an action is safe; the scripted API
      // cannot answer, so Claude Code refuses the tool itself (checked under workspace_write below).
      say(
        `  claude, PERMISSION_MODE=auto: ${ended(t1)}; tools ${toolsOf(t1)}; "${short(t1.reply, 230)}"`,
      );
    else
      check(
        t1.run?.status === "completed" &&
          t1.tools.some((t) => t.status === "completed") &&
          probed(t1, uid),
        `${s.id}: a shell tool call runs in the person's sandbox, as their uid, without capabilities`,
        `${ended(t1)}; tools ${toolsOf(t1)}; ${t1.deltas} deltas; "${short(t1.reply, 200)}"`,
        [s.id, "shell in sandbox"],
      );
    const instr = await seen(`MARK-instr-${s.id}-${RUN}`);
    check(
      instr > 0,
      `${s.id}: the standing instructions (${s.id === "claude" ? "CLAUDE.md" : "AGENTS.md"}) reach the vendor`,
      `${instr} vendor request(s) carried them`,
      [s.id, "instructions"],
    );

    if (s.id === "claude") {
      // A question the agent itself asks (AskUserQuestion), answered through /v1.
      const q = await turn(p, c.id, "ASK_QUESTION please", { answer: "Blue" });
      const qq = q.questions[0];
      check(
        q.run?.status === "completed" &&
          qq?.q.kind === "question" &&
          qq.status === 200 &&
          qq.pendingShown &&
          q.reply.includes('"Which color?"="Blue"'),
        "claude: Claude's own question (AskUserQuestion) answered through /v1",
        `${qq ? `${short(qq.q.prompts[0].question, 40)} [${qq.q.prompts[0].options.map((o: any) => o.label).join(" / ")}] → ${qq.label}; ` : "no question; "}${ended(q)}; "${short(q.reply, 120)}"`,
        [s.id, "question"],
      );
    } else {
      await allowAndDeny(p, s, c.id, s.ask === s.tool ? t1 : undefined);
      await abortMidCommand(p, s, model, uid);
    }

    // An MCP tool call through the gateway's proxy, with this message's credential.
    const stubBefore = (await mock("/stub")).length;
    const m1 = await turn(p, c.id, `${s.mcp} for customer 42`);
    const stubSaw = ((await mock("/stub")) as any[]).slice(stubBefore);
    const call = stubSaw.find((x) => x.tool === "lookup_customer");
    check(
      m1.run?.status === "completed" &&
        m1.reply.includes(STUB_CUSTOMER.name) &&
        call?.status === 200 &&
        call.authorization === p.mcpAuth!.stub,
      `${s.id}: an MCP tool call through the gateway's proxy, with the message's credential`,
      `${ended(m1)}; tools ${toolsOf(m1)}; the MCP server saw ${stubSaw.map((x) => x.rpcMethod + (x.tool ? `(${x.tool})` : "") + ` ${x.status}`).join(", ")}`,
      [s.id, "MCP via proxy"],
    );
    const expiredAuth = `Bearer expired-e2e-${RUN}-${s.id}`;
    const m2 = await turn(p, c.id, `${s.mcp} again for customer 43`, {
      mcpAuth: { stub: expiredAuth },
    });
    const stubSaw2 = ((await mock("/stub")) as any[]).filter(
      (x) => x.authorization === expiredAuth,
    );
    check(
      m2.run?.status === "completed" &&
        m2.reply.includes(COPY.expired("stub").slice(0, 30)) &&
        stubSaw2.some((x) => x.status === 401),
      `${s.id}: a credential the app's server refuses → a tool error the agent relays`,
      `${ended(m2)}; "${short(m2.reply, 120)}"`,
      [s.id, "MCP via proxy"],
    );

    // Hidden context: the vendor gets it; history and events never show it.
    const marker = `MARK-ctx-${s.id}-${RUN}`;
    const mark = p.events.length;
    const ctxText = "Which page am I on?";
    const hc = await turn(p, c.id, ctxText, {
      context: `The person is viewing page ${marker} in the app.`,
    });
    const all = await p.call(
      "GET",
      `/v1/conversations/${c.id}/messages?limit=200`,
    );
    const shown =
      JSON.stringify(all.body).includes(marker) ||
      JSON.stringify(p.events.slice(mark)).includes(marker) ||
      JSON.stringify(all.body).includes(CONTEXT_OPEN.slice(0, 20));
    const vendorGot = await seen(marker);
    check(
      hc.run?.status === "completed" &&
        vendorGot > 0 &&
        !shown &&
        hc.messages.find((m: any) => m.role === "user")?.text === ctxText,
      `${s.id}: hidden context reaches the vendor and is never shown back`,
      `${vendorGot} vendor request(s) carried it; in history or events: ${shown}`,
      [s.id, "hidden context"],
    );
    st.peaks.push(num(`${personCgroup(p.key)}/memory.peak`) ?? 0);
  }

  // --- Two people cannot see each other ---------------------------------------------------------
  const A = states.find((x) => x.s.id === "codex");
  const B = states.find((x) => x.s.id === "openrouter");
  if (A && B) {
    section(`isolation: the ${A.s.id} person (A) and the ${B.s.id} person (B)`);
    const aConvs = (
      await A.p.call("GET", "/v1/conversations?limit=200")
    ).body.conversations.map((c: any) => c.id);
    const bList = (
      await B.p.call("GET", "/v1/conversations?limit=200")
    ).body.conversations.map((c: any) => c.id);
    const probes = [
      await B.p.call("GET", `/v1/conversations/${A.conv}/messages`),
      await B.p.call("POST", `/v1/conversations/${A.conv}/messages`, {
        text: "hello",
      }),
      await B.p.call("POST", `/v1/conversations/${A.conv}/abort`),
      await B.p.call("PATCH", `/v1/conversations/${A.conv}`, {
        title: "mine now",
      }),
      await B.p.call("DELETE", `/v1/conversations/${A.conv}`),
    ];
    check(
      !bList.some((id: string) => aConvs.includes(id)) &&
        probes.every((x) => x.status === 404) &&
        (await A.p.call("GET", `/v1/conversations/${A.conv}/messages`))
          .status === 200,
      "conversations: B lists none of A's; reading, writing, aborting, renaming or archiving A's is 404",
      probes.map((x) => x.status).join(","),
    );
    check(
      !JSON.stringify(B.p.events).includes(A.conv),
      "events: B's stream carries nothing of A's",
    );
    // Files: something only A has, looked for from inside B's sandbox.
    inSandbox(A.p.key, `echo MARK-secret-${RUN} > "$HOME/secret.txt"`);
    const aHas = inSandbox(A.p.key, 'cat "$HOME/secret.txt"');
    const bLooks = inSandbox(
      B.p.key,
      `ls -a /home; ls -a "$HOME"; ls /var/lib/tandem 2>&1 | head -1; grep -rls MARK-secret-${RUN} / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev 2>/dev/null | head -3; echo end`,
    );
    check(
      aHas === `MARK-secret-${RUN}` &&
        !bLooks.includes("secret.txt") &&
        !bLooks.includes(`MARK-secret-${RUN}`) &&
        /No such file/.test(bLooks) &&
        bLooks.endsWith("end"),
      "files: B's sandbox has only B's home; A's file is nowhere in it; no data volume",
      short(bLooks, 200),
    );
    // Processes: while A's command runs, B's sandbox sees only its own processes.
    let aSleeps = 0;
    let bPs = "";
    const aRun = await turn(A.p, A.conv, `${A.s.slow} please`, {
      abortAfter: {
        on: "tool",
        ms: 2000,
        before: () => {
          aSleeps = sleepers(A.uid).length;
          bPs = inSandbox(
            B.p.key,
            "ps -eo uid,args; echo; ls /proc | grep -c '^[0-9]'",
          );
        },
      },
    });
    check(
      aSleeps > 0 &&
        !/sleep (60|300)/.test(bPs) &&
        !new RegExp(`^\\s*${A.uid}\\s`, "m").test(bPs),
      "processes: while A's `sleep` runs, B's sandbox sees none of A's processes",
      `A's sleep running: ${aSleeps}; B sees: ${short(bPs, 200)}; A's run ${ended(aRun)}`,
    );
    check(
      A.uid !== undefined && B.uid !== undefined && A.uid !== B.uid,
      "each person has a uid of their own",
      `A ${A.uid}, B ${B.uid}`,
    );

    section("a sandbox from the inside (B)");
    const inside = inSandbox(
      B.p.key,
      'echo "uid=$(id -u) caps=$(grep ^CapEff /proc/self/status | cut -f2) nnp=$(grep ^NoNewPrivs /proc/self/status | cut -f2) seccomp=$(grep ^Seccomp: /proc/self/status | cut -f2)"; touch /usr/x 2>&1 | head -1; unshare -U true 2>&1; unshare -m true 2>&1; true',
    );
    check(
      inside.startsWith(`uid=${B.uid} caps=0000000000000000 nnp=1 seccomp=2`) &&
        /Read-only file system/.test(inside) &&
        (inside.match(/Operation not permitted/g) ?? []).length === 2,
      "the person's uid, no capabilities, no_new_privs, seccomp; a read-only system; no new namespaces",
      short(inside, 240),
    );
    const probe = (url: string, direct = false) => {
      const code = inSandbox(
        B.p.key,
        `curl -s -m 8 ${direct ? '--noproxy "*"' : ""} -o /dev/null -w '%{http_code}' ${shq(url)}; true`,
      ).slice(-3);
      return code === "000" ? "blocked" : code;
    };
    for (const [url, direct, label] of [
      [
        "http://127.0.0.1:8787/healthz",
        true,
        "the gateway's port on its own loopback",
      ],
      [
        "http://tandem:8787/healthz",
        false,
        "the gateway by name through the proxy",
      ],
      ["http://169.254.169.254/latest/meta-data/", false, "cloud metadata"],
      ["http://10.0.0.1/", false, "a private address"],
      [
        "http://172.29.77.10:4799/v1/models",
        false,
        "the mock by address (not by an allowed name)",
      ],
      ["https://example.com/", false, "a host outside the allowlist"],
      [
        "https://api.anthropic.com/v1/models",
        false,
        "a real vendor (not on the e2e allowlist)",
      ],
      ["https://example.com/", true, "the Internet without the proxy"],
    ] as const) {
      const code = probe(url, direct);
      check(
        ["blocked", "403", "407"].includes(code),
        `egress: a sandbox cannot reach ${label}`,
        code,
      );
    }
    const ok = probe(`http://${MOCK_HOST}:4799/v1/models`);
    check(
      ok === "401",
      "egress: a sandbox reaches the allowlisted host through the proxy",
      `HTTP ${ok} (no key)`,
    );
    // After a turn the person's vendor process is kept for IDLE_MINUTES: their cgroup holds the limits.
    const b = await turn(B.p, B.conv, "PING");
    const limits = ["memory.max", "pids.max", "cpu.weight"].map((f) =>
      read(`${personCgroup(B.p.key)}/${f}`)?.trim(),
    );
    check(
      b.run?.status === "completed" &&
        limits[0] === String(1024 * 2 ** 20) &&
        limits[1] === "512" &&
        limits[2] === "100",
      "the person's cgroup holds their limits (RUNTIME_MEMORY_MB, RUNTIME_PIDS, cpu.weight)",
      `memory.max ${limits[0]}, pids.max ${limits[1]}, cpu.weight ${limits[2]}; sandboxes ${sandboxesOf(B.p.key).join(", ")}`,
    );

    section("the MCP proxy: only the person's own sandbox, with its own token");
    const rpc = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "lookup_customer", arguments: { id: "1" } },
    });
    const path = `/mcp/${A.p.key}/stub`;
    const aToken = proxyToken(serviceSecret, A.p.key);
    const bToken = proxyToken(serviceSecret, B.p.key);
    const none = onMcpSocket(A.p.key, path, null, rpc);
    const wrong = onMcpSocket(A.p.key, path, "wrong", rpc);
    const own = onMcpSocket(B.p.key, path, bToken, rpc);
    const leaked = onMcpSocket(B.p.key, path, aToken, rpc);
    check(
      none.startsWith("401") && wrong.startsWith("401"),
      "no token or a wrong one → 401",
      `${none.slice(0, 3)}, ${wrong.slice(0, 3)}`,
    );
    check(
      own.startsWith("401"),
      "B's own token on A's path (B's socket) → 401",
      own.slice(0, 60),
    );
    check(
      leaked.startsWith("403"),
      "A's token on B's socket → 403: the socket names the caller",
      leaked.slice(0, 60),
    );
    const marker = `(valid|expired)-e2e-${RUN}`;
    const procs = sh([
      "docker",
      "exec",
      C,
      "sh",
      "-c",
      'for p in /proc/[0-9]*; do tr "\\0" "\\n" < $p/environ; tr "\\0" " " < $p/cmdline; echo; done 2>/dev/null',
    ]).out;
    const homes = states
      .map((x) =>
        inSandbox(
          x.p.key,
          `grep -rlE ${shq(marker)} "$HOME" /var/tmp/agent 2>/dev/null; true`,
        ),
      )
      .join("");
    const logs = sh(["docker", "logs", C]).out + sh(["docker", "logs", C]).err;
    const argv = sh([
      "docker",
      "exec",
      C,
      "sh",
      "-c",
      'for p in /proc/[0-9]*; do tr "\\0" " " < $p/cmdline; echo; done 2>/dev/null',
    ]).out;
    check(
      !new RegExp(marker).test(procs) &&
        !homes &&
        !new RegExp(marker).test(logs),
      "the app's MCP credentials never reach a sandbox: no process environment or argv, no file, no log",
      `${new Set(((await mock("/stub")) as any[]).map((x) => x.authorization).filter((a: string) => a && new RegExp(marker).test(a))).size} credentials checked`,
    );
    check(
      !SPECS.some((s) => s.good && argv.includes(s.good)),
      "API keys never on any process's argv (only in the environment of that person's vendor process)",
    );
    check(
      inSandbox(
        A.p.key,
        'cat "$HOME/projects/chats/AGENTS.md" "$HOME/projects/chats/CLAUDE.md" "$HOME/.grok/AGENTS.md"',
      ) ===
        Array(3).fill(`The codeword is MARK-instr-codex-${RUN}.`).join("\n"),
      "instructions: AGENTS.md and CLAUDE.md in the chat workspace, and Grok's global rules (~/.grok/AGENTS.md)",
    );
  }

  // --- The processes go after IDLE_MINUTES; the next turn resumes the vendor session --------------
  section(
    "idle: every vendor process is released, then each conversation resumes",
  );
  const t0 = performance.now();
  const released = await waitFor(
    () => states.every((x) => sandboxesOf(x.p.key).length === 0),
    IDLE_MS + 180_000,
    1000,
  );
  check(
    !!released,
    "every person's processes ended after IDLE_MINUTES without turns",
    `${((performance.now() - t0) / 1000).toFixed(0)} s after the last turns; left: ${states.map((x) => sandboxesOf(x.p.key).length).join(",")}`,
  );
  check(
    states.every(
      (x) =>
        docker(
          "exec",
          C,
          "sh",
          "-c",
          `test -e /var/lib/tandem/tmp/${x.p.key} && echo kept || echo gone`,
        ) === "gone",
    ) && states.every((x) => !existsSync(personCgroup(x.p.key))),
    "…and with them their temporary files and cgroups; only the homes stay",
    states
      .map(
        (x) =>
          `${x.s.id} home ${docker("exec", C, "du", "-sm", `/var/lib/tandem/homes/${x.p.key}`).split(/\s/)[0]} MiB`,
      )
      .join(", "),
  );
  for (const x of states) {
    const before = sandboxesOf(x.p.key).length;
    const t = await turn(x.p, x.conv, "RECALL what I asked you to remember");
    check(
      before === 0 &&
        t.run?.status === "completed" &&
        t.reply.includes(x.word) &&
        sandboxesOf(x.p.key).length > 0,
      `${x.s.id}: a turn after the process was released resumes the vendor session (a new process)`,
      `${ended(t)}; "${short(t.reply, 120)}"`,
      [x.s.id, "resume after idle"],
    );
  }

  // --- History paging ------------------------------------------------------------------------------
  section("history paging");
  for (const x of states) {
    const full = await x.p.call(
      "GET",
      `/v1/conversations/${x.conv}/messages?limit=200`,
    );
    const runs: string[] = [];
    const messages: string[] = [];
    let before: string | null = null;
    let pages = 0;
    let ordered = true;
    for (;;) {
      const page: any = await x.p.call(
        "GET",
        `/v1/conversations/${x.conv}/messages?limit=2${before ? `&before=${before}` : ""}`,
      );
      pages++;
      const ids = page.body.runs.map((r: any) => r.id);
      ordered &&= page.body.messages.every((m: any) => ids.includes(m.runId));
      runs.unshift(...ids);
      messages.unshift(...page.body.messages.map((m: any) => m.id));
      if (!page.body.hasMore || pages > 50) break;
      before = ids[0];
    }
    check(
      ordered &&
        JSON.stringify(runs) ===
          JSON.stringify(full.body.runs.map((r: any) => r.id)) &&
        JSON.stringify(messages) ===
          JSON.stringify(full.body.messages.map((m: any) => m.id)) &&
        full.body.hasMore === false,
      `${x.s.id}: paging back two runs at a time gives the whole history, in order`,
      `${full.body.runs.length} runs, ${full.body.messages.length} messages in ${pages} pages; context ${JSON.stringify(full.body.context)}; usage ${JSON.stringify(full.body.usage)}`,
      [x.s.id, "history paging"],
    );
  }
  {
    // A person with more than one conversation (the abort test made a second).
    const x = states.find((y) => y.s.id === "codex") ?? states[0]!;
    const found = await x.p.call(
      "GET",
      `/v1/conversations?query=${encodeURIComponent(`e2e ${x.s.id} ${RUN}`)}`,
    );
    const renamed = await x.p.call("PATCH", `/v1/conversations/${x.conv}`, {
      title: `renamed ${RUN}`,
    });
    const search = await x.p.call(
      "GET",
      `/v1/conversations?query=renamed%20${RUN}`,
    );
    const first = await x.p.call("GET", "/v1/conversations?limit=1");
    const next = await x.p.call(
      "GET",
      `/v1/conversations?limit=1&cursor=${first.body.nextCursor}`,
    );
    check(
      found.body.conversations.some((c: any) => c.id === x.conv) &&
        renamed.body.conversation.title === `renamed ${RUN}` &&
        search.body.conversations.map((c: any) => c.id).join() === x.conv &&
        first.body.conversations.length === 1 &&
        next.body?.conversations?.length === 1 &&
        next.body.conversations[0].id !== first.body.conversations[0].id,
      "conversations: title search, rename, cursor paging",
    );
  }

  // --- A gateway restart mid-run ---------------------------------------------------------------------
  section("a gateway restart while every provider's turn runs");
  const running: { x: State; runId: string }[] = [];
  // Claude last: under auto its slow turn is ~12 s of streamed text, not a command.
  for (const x of [...states].sort((a, b) =>
    a.s.id === "claude" ? 1 : b.s.id === "claude" ? -1 : 0,
  )) {
    const mark = x.p.events.length;
    const text =
      x.s.id === "claude"
        ? "SLOW for the restart"
        : `${x.s.slow} for the restart`;
    const sent = await x.p.call(
      "POST",
      `/v1/conversations/${x.conv}/messages`,
      {
        text,
        ...(x.p.mcpAuth ? { mcpAuth: x.p.mcpAuth } : {}),
      },
    );
    const runId = sent.body?.message?.runId;
    const t0 = Date.now();
    const started = await waitFor(
      async () => {
        for (const e of x.p.events.slice(mark)) {
          if (e.data?.conversationId !== x.conv) continue;
          if (
            e.event === "conversation.question" &&
            e.data.question.status === "pending"
          )
            await x.p.call(
              "POST",
              `/v1/conversations/${x.conv}/questions/${e.data.question.id}`,
              { answer: "Allow once" },
            );
          if (
            e.event === "conversation.message" &&
            e.data.message.runId === runId &&
            e.data.message.tools.some((t: any) => t.status === "running")
          )
            return "its command runs";
        }
        if (x.s.id === "claude" && Date.now() - t0 > 2000) return "streaming";
      },
      60_000,
      100,
    );
    if (runId && started) running.push({ x, runId });
    say(`  ${x.s.id}: run ${runId}: ${started ?? "did not start"}`);
  }
  const restart = await restartGateway();
  check(
    restart.up,
    "docker restart: the gateway stops its sandboxes, exits and starts again",
    ms(restart.ms),
  );
  for (const x of states) await x.p.listen();
  for (const { x, runId } of running) {
    const page = await x.p.call(
      "GET",
      `/v1/conversations/${x.conv}/messages?limit=5`,
    );
    const runAfter = page.body?.runs?.find((r: any) => r.id === runId);
    check(
      runAfter?.status === "failed" && runAfter.failure?.code === "failed",
      `${x.s.id}: the run the restart interrupted is failed (not aborted: nobody asked)`,
      JSON.stringify(runAfter),
      [x.s.id, "restart: run failed"],
    );
  }
  check(
    states.every(
      (x) => crunOf(x.p.key).length === 0 && sleepers(x.uid).length === 0,
    ),
    "after the restart: no sandbox and no command of anyone is left",
  );
  for (const x of states) {
    const t = await turn(x.p, x.conv, "RECALL it after the restart");
    check(
      t.run?.status === "completed" && t.reply.includes(x.word),
      `${x.s.id}: the next turn after the restart resumes the session`,
      `${ended(t)}; "${short(t.reply, 100)}"`,
      [x.s.id, "restart: resumes"],
    );
    if (t.run?.status !== "completed")
      // The agent's own error, before Tandem classified it (scripts/e2e-gateway.ts logs it).
      say(
        `  ${x.s.id} after the restart: ${docker("logs", "--since", "2m", C)
          .split("\n")
          .filter((l) => /acp_error|turn_failed|codex\]/.test(l))
          .slice(-5)
          .join(" | ")}`,
      );
  }

  // --- A refused sign-in or key: signin_required, then connecting again works ----------------------
  section("the vendor refuses the sign-in or key");
  for (const x of states) {
    // In a conversation of its own: the refused message stays in that vendor session's history.
    const cf = await conversation(
      x.p,
      x.s.id,
      x.model,
      `e2e ${x.s.id} refused`,
    );
    const t = await turn(x.p, cf.id!, `${x.s.refused} now`);
    const view = await waitFor(
      () =>
        x.p.provider(x.s.id)?.provider.status === "not_connected"
          ? true
          : undefined,
      20_000,
    );
    const listed = (await x.p.call("GET", "/v1/providers")).body.providers.find(
      (v: any) => v.id === x.s.id,
    );
    const create = await x.p.call("POST", "/v1/conversations", {
      provider: x.s.id,
      model: x.model,
    });
    const errorMessage = t.messages.find((m: any) => m.role === "error");
    check(
      t.run?.status === "failed" &&
        t.run.failure?.code === "signin_required" &&
        t.run.failure.params?.provider === x.s.id &&
        errorMessage?.failure?.code === "signin_required" &&
        !!view &&
        listed.status === "not_connected" &&
        create.status === 409 &&
        create.body?.error === "signin_required",
      `${x.s.id}: refused → run failed signin_required; provider not_connected; new conversations 409`,
      `${ended(t)}; ${short(t.run?.failure?.message, 90)}`,
      [x.s.id, "signin_required"],
    );
    const live = await connect(x.p, x.s, false);
    const again = live
      ? await turn(x.p, x.conv, "PING after connecting again")
      : null;
    check(
      !!live && again?.run?.status === "completed",
      `${x.s.id}: connecting again → connected; the conversation continues`,
      again ? ended(again) : "not connected",
      [x.s.id, "signin_required"],
    );
  }

  // --- Claude's own permission questions: PERMISSION_MODE=workspace_write ---------------------------
  const cl = states.find((x) => x.s.id === "claude");
  if (cl) {
    section(
      "claude under PERMISSION_MODE=workspace_write (auto's safety check runs on Anthropic's server)",
    );
    const w = await recreate("workspace_write");
    check(
      w.up,
      "the container recreated with PERMISSION_MODE=workspace_write",
      w.line,
    );
    await cl.p.listen();
    const cw = await conversation(
      cl.p,
      "claude",
      cl.model,
      `e2e claude ww ${RUN}`,
    );
    const note = " (workspace_write)";
    const t = await turn(cl.p, cw.id!, `${cl.s.tool} please`);
    check(
      t.run?.status === "completed" &&
        t.tools.some((x) => x.status === "completed") &&
        probed(t, cl.uid),
      `claude: a shell tool call runs in the person's sandbox, as their uid, without capabilities${note}`,
      `${ended(t)}; tools ${toolsOf(t)}; ${t.deltas} deltas; "${short(t.reply, 200)}"`,
      ["claude", "shell in sandbox"],
    );
    await allowAndDeny(cl.p, cl.s, cw.id!, t, note);
    await abortMidCommand(cl.p, cl.s, cl.model, cl.uid, note);
    const back = await recreate("auto");
    check(
      back.up,
      "the container recreated with the deployed PERMISSION_MODE again",
      back.line,
    );
  }

  // --- What the vendor programs tried to reach ---------------------------------------------------------
  section("egress during the run");
  collectEgress();
  say(
    `  hosts the egress proxy refused during the run: ${[...refused].map(([h, ids]) => `${h} ×${ids.size}`).join(", ") || "none"}`,
  );
  const vendorRequests = (await mock("/requests")) as any[];
  say(
    `  requests the mock answered: ${vendorRequests.length} (by port: ${JSON.stringify(Object.fromEntries([4795, 4796, 4799].map((port) => [port, vendorRequests.filter((x) => x.port === port).length])))})`,
  );

  for (const x of states) x.p.close();
  summary(states);
}

function summary(states: State[]) {
  section("summary");
  const cols = [
    "connect",
    "conversation",
    "shell in sandbox",
    "instructions",
    "allow once",
    "deny",
    "question",
    "abort",
    "MCP via proxy",
    "hidden context",
    "resume after idle",
    "history paging",
    "restart: run failed",
    "restart: resumes",
    "signin_required",
  ];
  console.log(`| scenario | ${SPECS.map((s) => s.id).join(" | ")} |`);
  console.log(`| --- | ${SPECS.map(() => "---").join(" | ")} |`);
  for (const col of cols)
    console.log(
      `| ${col} | ${SPECS.map((s) => {
        const v = table.get(s.id)?.get(col);
        return v === undefined ? "-" : v ? "pass" : "FAIL";
      }).join(" | ")} |`,
    );
  console.log(
    "(claude: shell, allow once, deny and abort under PERMISSION_MODE=workspace_write; the rest under auto)",
  );
  for (const x of states)
    say(
      `  ${x.s.id}: person's cgroup memory.peak after the first turn ${mib(x.peaks[0])}, after the scenarios ${mib(x.peaks.at(-1))}`,
    );
  console.log(
    failures ? `\nE2E FAILED (${failures} failed checks)` : "\nE2E PASSED",
  );
}

// ===================================================================================================
// Measurements

/** Samples the container's and some people's memory every 100 ms, from the host's cgroup files. */
function sampler(keys: string[]) {
  let container = 0;
  let minAvailable = Infinity;
  const people = new Map<string, number>();
  const timer = setInterval(() => {
    container = Math.max(container, num(`${CG}/memory.current`) ?? 0);
    const avail =
      Number(
        (read("/proc/meminfo") ?? "").match(
          /^MemAvailable:\s+(\d+) kB$/m,
        )?.[1] ?? NaN,
      ) * 1024;
    if (avail < minAvailable) minAvailable = avail;
    for (const k of keys)
      people.set(
        k,
        Math.max(
          people.get(k) ?? 0,
          num(`${personCgroup(k)}/memory.current`) ?? 0,
        ),
      );
  }, 100);
  return {
    stop() {
      clearInterval(timer);
      return { container, minAvailable, people };
    },
  };
}

const dmesgOoms = () =>
  sh([
    "sh",
    "-c",
    "dmesg 2>/dev/null | grep -ciE 'out of memory|oom-kill|killed process' || true",
  ]).out.trim();

function containerMemory(label: string) {
  const top = docker("top", C, "-o", "pid,rss,args").split("\n").slice(1);
  const rss = (re: RegExp) =>
    top
      .filter((l) => re.test(l))
      .reduce((n, l) => n + Number(l.trim().split(/\s+/)[1]) * 1024, 0);
  say(
    `  ${label}: container memory.current ${mib(num(`${CG}/memory.current`))} (anon ${mib(statOf(CG, "anon"))}, file ${mib(statOf(CG, "file"))}), memory.peak since its start ${mib(num(`${CG}/memory.peak`))}; ` +
      `gateway (bun) RSS ${mib(rss(/bun scripts\/e2e-gateway\.ts|bun src\/gateway\.ts/))}, smokescreen RSS ${mib(rss(/smokescreen/))}, ${top.length} processes; docker stats ${docker("stats", "--no-stream", "--format", "{{.MemUsage}}", C)}`,
  );
}

/** People ready for a first turn: connected, a conversation each, and no process (after the reads' idle). */
async function prepare(name: string, specs: Spec[]) {
  const out: { s: Spec; p: Person; conv: string }[] = [];
  for (const [i, s] of specs.entries()) {
    const p = await person(`${name}-${s.id}-${i}`);
    await p.listen();
    const live = await connect(p, s, false);
    if (!live) {
      check(false, `${p.name}: connected`);
      continue;
    }
    const c = await conversation(p, s.id, modelOf(live), `${name} ${s.id}`);
    if (c.id) out.push({ s, p, conv: c.id });
  }
  const t0 = performance.now();
  const idle = await waitFor(
    () => out.every((x) => sandboxesOf(x.p.key).length === 0),
    IDLE_MS + 120_000,
    1000,
  );
  check(
    !!idle &&
      out.every(
        (x) =>
          !existsSync(personCgroup(x.p.key)) && crunOf(x.p.key).length === 0,
      ),
    `${out.length} people connected with a conversation each and no turn: no process, no cgroup`,
    `the processes their connecting started (sign-in CLIs, reads) ended within ${((performance.now() - t0) / 1000).toFixed(0)} s`,
  );
  return out;
}

async function burst(
  title: string,
  people: { s: Spec; p: Person; conv: string }[],
) {
  section(title);
  const restart = await restartGateway();
  check(
    restart.up,
    "a fresh container (memory.peak counts from its start)",
    ms(restart.ms),
  );
  await Bun.sleep(15_000);
  for (const x of people) await x.p.listen();
  await Bun.sleep(2000);
  check(
    people.every((x) => sandboxesOf(x.p.key).length === 0),
    "before: none of these people has a process (their streams are open)",
  );
  containerMemory("before");
  const base = num(`${CG}/memory.current`) ?? 0;
  const oomBefore = dmesgOoms();
  const s = sampler(people.map((x) => x.p.key));
  const t0 = performance.now();
  const turns = await Promise.all(
    people.map((x) => turn(x.p, x.conv, `${x.s.tool} please`)),
  );
  const wall = performance.now() - t0;
  await Bun.sleep(500);
  const peaks = people.map(
    (x) => num(`${personCgroup(x.p.key)}/memory.peak`) ?? 0,
  );
  const sampled = s.stop();
  for (const [i, x] of people.entries())
    say(
      `  ${x.p.name}: ${ended(turns[i]!)}, tools ${toolsOf(turns[i]!)}, person peak ${mib(peaks[i])}`,
    );
  const ooms =
    people.reduce((n, x) => n + oomKills(personCgroup(x.p.key)), 0) +
    oomKills(CG);
  check(
    turns.every(
      (t) =>
        t.run?.status === "completed" &&
        t.tools.some((x) => x.status === "completed"),
    ),
    `all ${people.length} first turns completed, each with its shell tool call`,
    `wall ${ms(wall)}`,
  );
  say(
    `  container: before ${mib(base)}, highest sampled memory.current ${mib(sampled.container)} (+${mib(sampled.container - base)}), memory.peak since start ${mib(num(`${CG}/memory.peak`))}; ` +
      `people's peaks ${peaks.map((b) => mib(b)).join(", ")} (sum ${mib(peaks.reduce((a, b) => a + b, 0))}); host MemAvailable lowest ${mib(sampled.minAvailable)}`,
  );
  check(
    ooms === 0 && dmesgOoms() === oomBefore,
    "nothing was OOM-killed (memory.events oom_kill of the container and each person; kernel log)",
    `oom_kill ${ooms}, kernel OOM lines ${oomBefore} → ${dmesgOoms()}`,
  );
  containerMemory("after");
  for (const x of people) x.p.close();
}

async function capacity() {
  header("capacity");
  const limit = docker("inspect", "-f", "{{.HostConfig.Memory}}", C);
  console.log(
    `# container memory limit: ${limit === "0" ? "none (compose.yaml sets no mem_limit)" : mib(Number(limit))}; per person: memory.max = RUNTIME_MEMORY_MB (default 1024 MiB); no swap on the host`,
  );
  // workspace_write: Claude asks before Bash (answered here) instead of asking Anthropic's server,
  // which the scripted API cannot stand in for; every turn below runs its shell tool call.
  const w = await recreate("workspace_write");
  check(
    w.up,
    "the container runs with PERMISSION_MODE=workspace_write",
    w.line,
  );

  section("image");
  for (const img of [IMAGE, "tandem:0.3.0"]) {
    const size = docker("image", "inspect", "-f", "{{.Size}}", img);
    if (!size) continue;
    const rootfs = docker(
      "history",
      "--format",
      "{{.Size}}\t{{.CreatedBy}}",
      img,
    )
      .split("\n")
      .find((l) => l.includes("/opt/tandem/rootfs"))
      ?.split("\t")[0];
    say(
      `  ${img}: ${(Number(size) / 1e9).toFixed(2)} GB (${size} bytes); runtime filesystem layer ${rootfs ?? "?"}${img === "tandem:0.3.0" ? " (the Happy Agent build)" : ""}`,
    );
  }

  section("gateway at rest");
  const restart = await restartGateway();
  check(restart.up, "a fresh container", ms(restart.ms));
  await Bun.sleep(20_000);
  containerMemory("idle, nobody connected");

  section("connected people without a turn");
  const lat = await prepare(
    "lat",
    SPECS.flatMap((s) => [s, s, s]),
  );
  containerMemory(`${lat.length} people connected, no turn`);

  section(
    "first turn (cold: the vendor program starts) and warm turns, per provider",
  );
  const rows: string[] = [];
  const median = (a: number[]) =>
    [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)];
  for (const s of SPECS) {
    const mine = lat.filter((x) => x.s.id === s.id);
    const cold: number[] = [];
    for (const x of mine) {
      const t = await turn(x.p, x.conv, "PING");
      if (t.run?.status === "completed" && t.ms) cold.push(t.ms);
      else say(`  ${x.p.name}: cold ${ended(t)}`);
    }
    const x = mine[0]!;
    const warm: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = await turn(x.p, x.conv, "PING again");
      if (t.run?.status === "completed" && t.ms) warm.push(t.ms);
    }
    const tool = await turn(x.p, x.conv, `${s.tool} please`);
    const peaks = mine.map(
      (y) => num(`${personCgroup(y.p.key)}/memory.peak`) ?? 0,
    );
    rows.push(
      `| ${s.id} | ${cold.map((v) => Math.round(v)).join(", ")} (median ${ms(median(cold))}) | ${warm.map((v) => Math.round(v)).join(", ")} (median ${ms(median(warm))}) | ${ms(tool.ms)} (${tool.run?.status}, ${tool.questions.length} question answered) | ${peaks.map((b) => mib(b)).join(", ")} |`,
    );
  }
  console.log(
    "\n| provider | cold first turn, 3 people (ms) | warm turns (ms) | warm turn with a shell tool call | each person's cgroup memory.peak |",
  );
  console.log("| --- | --- | --- | --- | --- |");
  for (const r of rows) console.log(r);
  for (const x of lat) x.p.close();

  const claude = SPECS.find((s) => s.id === "claude")!;
  const five = await prepare("burst-claude", [
    claude,
    claude,
    claude,
    claude,
    claude,
  ]);
  await burst(
    "5 people start their first Claude turn at the same moment (a shell tool call each)",
    five,
  );
  const mixed = await prepare("burst-mixed", SPECS);
  await burst(
    "5 people, one per provider, start their first turn at the same moment (a shell tool call each)",
    mixed,
  );
  const back = await recreate("auto");
  check(
    back.up,
    "the container recreated with the deployed PERMISSION_MODE again",
    back.line,
  );
  console.log(
    failures
      ? `\nCAPACITY RUN HAD ${failures} FAILED CHECKS`
      : "\nCAPACITY RUN PASSED",
  );
}

if (MODE === "capacity") await capacity();
else await scenarios();
process.exit(failures ? 1 : 0);
