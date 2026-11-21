// acp-agents.ts: Tandem's three ACP agents (src/agents/acp.ts) with the real programs in real crun
// sandboxes against the scripted vendor API (scripts/mock-vendor): Grok's device sign-in, then for
// agy, Grok Build and goose a read, a tool turn with a permission allowed, one denied, an abort, a
// second turn in a new process that resumes the session, an MCP call and three failures; the key
// checks. Run as root inside the Tandem container (crun, the rootfs, the egress proxy):
//
//   bun evidence/poc/acp-agents.ts > evidence/acp-agents.txt
//
// No real vendor is contacted: every program's API base and xAI's sign-in issuer point at the mock.
import { chmodSync, chownSync, mkdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { CrunSandboxes } from "./crun-sandboxes";
import {
  geminiAgent,
  grokAgent,
  openrouterAgent,
  OPENROUTER_MODELS,
} from "../../src/agents/acp-vendors";
import { rpcText, type AcpAgent } from "../../src/agents/acp";
import type {
  Answers,
  Ask,
  McpServer,
  ProviderId,
  TurnInput,
  TurnSink,
} from "../../src/agents/types";
import { GrokSignIn } from "../../src/signin/grok";
import { approveDevice, handle } from "../../scripts/mock-vendor/index";
import { startStubMcp } from "../../scripts/stub-mcp";

const KEY = process.env.PERSON ?? "6c2a5ef8332a30e31842f17a";
const UID = Number(process.env.PERSON_UID ?? 100003);
const HOME = `/var/lib/tandem/homes/${KEY}`;
const DIR = "/tmp/acp-agent";
const TMP = `${DIR}/tmp`;
const MOCK_SOCK = ".acp-agent-mock.sock";
const M = "http://127.0.0.1:4799";
// The mock's log: MOCK_LOG, set before this runs (the mock reads it when it is imported).
if (!process.env.MOCK_LOG) throw new Error("set MOCK_LOG");

mkdirSync(TMP, { recursive: true });
chownSync(TMP, UID, UID);
rmSync(`${HOME}/${MOCK_SOCK}`, { force: true });
Bun.serve({ unix: `${HOME}/${MOCK_SOCK}`, fetch: handle });
chownSync(`${HOME}/${MOCK_SOCK}`, UID, UID);
// The application's MCP server; the sandbox reaches it as 127.0.0.1:8790 through a socket (as
// it reaches the gateway's MCP proxy).
const stub = startStubMcp({ port: 0 });
const MCP_SOCK = `${DIR}/mcp.sock`;
rmSync(MCP_SOCK, { force: true });
Bun.serve({
  unix: MCP_SOCK,
  fetch: (req) => {
    const u = new URL(req.url);
    return fetch(`http://127.0.0.1:${stub.port}${u.pathname}${u.search}`, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: "manual",
    });
  },
});
chmodSync(MCP_SOCK, 0o666);

const sandboxes = new CrunSandboxes({
  key: KEY,
  uid: UID,
  home: HOME,
  tmp: TMP,
  template:
    "/var/lib/tandem/bundles/tandem-9a05180e08ef315bf682183e/config.json",
  dir: `${DIR}/bundles`,
  mockSock: MOCK_SOCK,
  mcpSock: MCP_SOCK,
});
const apiKeys = {
  get: (_k: string, p: string) =>
    p === "gemini"
      ? "AIzaMockKeyNotReal000000"
      : p === "openrouter"
        ? "sk-or-mock-not-real-000000"
        : null,
};
// xAI's sign-in issuer and Grok's own API (cli-chat-proxy, where a signed-in Grok sends its
// requests and reads its models) at the mock.
const GROK_MOCK = {
  GROK_OAUTH2_ISSUER: `${M}/auth`,
  GROK_OAUTH2_CLIENT_ID: "mock-client",
  GROK_CLI_CHAT_PROXY_BASE_URL: M,
};
const base = {
  sandboxes,
  apiKeys,
  idleMs: 120_000,
  urls: { openrouter: M, gemini: M },
  fetch: ((u: string, i?: RequestInit) =>
    handle(new Request(u, i))) as unknown as typeof fetch,
};

const t0 = performance.now();
const at = () => `${((performance.now() - t0) / 1000).toFixed(2)}s`;
const out = (...a: unknown[]) => console.log(at().padStart(8), ...a);
const short = (s: string, n = 160) => s.replace(/\s+/g, " ").slice(0, n);

function recorder(
  answer: (a: Ask) => Answers | null | Promise<Answers | null>,
) {
  const r = {
    sessions: [] as string[],
    text: new Map<string, string>(),
    tools: new Map<string, string[]>(),
    asks: [] as Ask[],
    context: null as unknown,
    usage: null as unknown,
    onTool: (_s: string) => {},
  };
  const sink: TurnSink = {
    session: (id) => r.sessions.push(id),
    delta: (item, t) => r.text.set(item, (r.text.get(item) ?? "") + t),
    text: (item, t) => r.text.set(item, t),
    tool: (_item, v) => {
      const l = r.tools.get(v.id) ?? [];
      if (l.at(-1) !== `${v.name}:${v.status}`) l.push(`${v.name}:${v.status}`);
      r.tools.set(v.id, l);
      r.onTool(v.status);
    },
    ask: async (a) => {
      r.asks.push(a);
      out(
        "    ask:",
        JSON.stringify({
          askedBy: a.askedBy,
          header: a.prompts[0]?.header,
          question: short(a.prompts[0]?.question ?? "", 90),
          options: a.prompts[0]?.options.map((o) => o.label),
        }),
      );
      return answer(a);
    },
    context: (c) => (r.context = c),
    usage: (u) => (r.usage = u),
  };
  return { r, sink };
}

async function turn(
  agent: AcpAgent,
  title: string,
  input: TurnInput,
  answer: (a: Ask) => Answers | null | Promise<Answers | null> = () => ({
    permission: ["Allow once"],
  }),
  abortWhen?: (r: any, abort: () => void) => void,
) {
  const { r, sink } = recorder(answer);
  const ac = new AbortController();
  if (abortWhen) abortWhen(r, () => ac.abort());
  const s = performance.now();
  out(
    `  ${title}: "${short(input.text, 60)}" (${input.model}${input.effort ? ` ${input.effort}` : ""}, ${input.permissionMode}${input.session ? `, session ${input.session}` : ""})`,
  );
  const end = await agent.turn(KEY, input, sink, ac.signal);
  out(
    `    end: ${JSON.stringify(end.status === "failed" ? { status: end.status, code: end.failure.code, message: short(end.failure.message, 100) } : end)} in ${Math.round(performance.now() - s)} ms`,
  );
  for (const [id, states] of r.tools)
    out(`    tool ${short(id, 40)}: ${states.join(" -> ")}`);
  for (const t of r.text.values()) out(`    text: ${short(t)}`);
  if (r.context) out(`    context: ${JSON.stringify(r.context)}`);
  if (r.usage) out(`    usage: ${JSON.stringify(r.usage)}`);
  return { end, r };
}

const sandboxCount = () =>
  Number(
    execSync(`crun list 2>/dev/null | grep -c "tandem-${KEY}-acp-" || true`)
      .toString()
      .trim(),
  );

/** ONLY=gemini,grok runs only those (iterating on one vendor). */
const ONLY = process.env.ONLY?.split(",");

async function scenario(
  agent: AcpAgent,
  provider: ProviderId,
  model: string,
  effort: string | null,
) {
  if (ONLY && !ONLY.includes(provider)) return;
  // Shows each JSON-RPC error the agent answered with, before Tandem classifies it.
  const own = agent.vendor.failure;
  agent.vendor.failure = (e, m) => {
    out(`    agent's error: ${e.code} ${short(rpcText(e), 300)}`);
    return own?.(e, m) ?? null;
  };
  out(
    `== ${provider}: ${agent.vendor.command.join(" ").replace(/^sh -c .*exec /, "")}`,
  );
  let s = performance.now();
  const live = await agent.read(KEY, provider);
  out(
    `  read in ${Math.round(performance.now() - s)} ms: signedIn=${live.signedIn} account=${JSON.stringify(live.account)}`,
  );
  for (const m of live.models)
    out(
      `    model ${m.id} "${m.name}" efforts=[${m.efforts}] default=${m.defaultEffort} context=${m.contextLimit}`,
    );
  const inp = (over: Partial<TurnInput>): TurnInput => ({
    conversationId: `${provider}-1`,
    provider,
    model,
    effort,
    session: null,
    text: "",
    mcpServers: [],
    permissionMode: "auto",
    ...over,
  });

  const t1 = await turn(
    agent,
    "tool turn, allowed once",
    inp({ text: "REMEMBER kiwi-42. Then RUN_TOOL please." }),
  );
  const session = t1.r.sessions[0]!;
  await turn(
    agent,
    "tool turn, denied",
    inp({ text: "RUN_TOOL once more", session, usage: t1.r.usage as any }),
    () => ({ permission: ["Deny"] }),
  );

  const before = sandboxCount();
  const sleeping = () =>
    Number(
      execSync(
        `for p in /proc/[0-9]*; do [ "$(stat -c %u $p 2>/dev/null)" = ${UID} ] && tr '\\0' ' ' < $p/cmdline 2>/dev/null && echo; done | grep -c '^sleep 300' || true`,
        { shell: "/bin/sh" },
      )
        .toString()
        .trim(),
    );
  // Stopped 2.5 s after its command started (`sleep 300` as the person's uid); allowed at once if
  // the agent asks first.
  let stop: () => void = () => {};
  let armed = false;
  await turn(
    agent,
    "abort mid-command",
    inp({ conversationId: `${provider}-abort`, text: "RUN_SLOW now" }),
    () => ({ permission: ["Allow once"] }),
    (r, abort) => {
      stop = abort;
      r.onTool = () => {
        if (armed) return;
        armed = true;
        setTimeout(() => {
          out(`    command running before abort: ${sleeping() > 0}`);
          stop();
        }, 2500);
      };
    },
  );
  for (let i = 0; i < 50 && (agent.busy(KEY) || sandboxCount() > before - 1); i++)
    await Bun.sleep(100);
  out(
    `    after abort: agent holds a process=${agent.busy(KEY)}, command still running=${sleeping() > 0}, sandboxes of this proof ${before} -> ${sandboxCount()}`,
  );

  await agent.release(KEY);
  out(`  released: agent holds a process=${agent.busy(KEY)}`);
  const spawnedBefore = sandboxes.spawned.length;
  await turn(
    agent,
    "second turn in a new process, same session",
    inp({ text: "RECALL what I asked you to remember", session }),
  );
  out(`    new process started: ${sandboxes.spawned.length > spawnedBefore}`);

  const mcp: McpServer[] = [
    {
      name: "app",
      url: "http://127.0.0.1:8790/mcp",
      headers: { authorization: "Bearer valid-proof" },
      enabledTools: ["lookup_customer"],
    },
  ];
  const calls = stub.requests.length;
  await turn(
    agent,
    "MCP tool call",
    inp({
      conversationId: `${provider}-mcp`,
      text: "RUN_MCP for customer 42",
      mcpServers: mcp,
    }),
  );
  out(
    `    MCP server saw: ${JSON.stringify(stub.requests.slice(calls).map((q) => q.rpcMethod + (q.tool ? `(${q.tool})` : "") + ` ${q.status}`))}`,
  );

  for (const f of ["FAIL_401", "FAIL_429", "FAIL_QUOTA"])
    await turn(
      agent,
      `failure ${f}`,
      inp({ conversationId: `${provider}-${f}`, text: f }),
    );
  await agent.release(KEY);
  s = performance.now();
}

out(
  `person ${KEY} (uid ${UID}); crun ${execSync("crun --version | head -1").toString().trim()}; ${execSync("uname -srm").toString().trim()}; nproc ${execSync("nproc").toString().trim()}`,
);

// Grok's device sign-in first: its agent then runs on that sign-in.
{
  out("== grok sign-in: grok login --device-auth");
  rmSync(`${HOME}/.grok/auth.json`, { force: true });
  const signIn = new GrokSignIn({ sandboxes, env: GROK_MOCK });
  out(`  signedIn before: ${signIn.signedIn(KEY)}`);
  let done: (s: string) => void = () => {};
  const finished = new Promise<string>((r) => (done = r));
  const s = performance.now();
  const first = await signIn.start(KEY, (st) => done(JSON.stringify(st)));
  out(
    `  start -> ${JSON.stringify(first)} in ${Math.round(performance.now() - s)} ms`,
  );
  if (first.state === "waiting" && first.userCode) {
    approveDevice(first.userCode);
    out(`  (the person confirms ${first.userCode} on the page)`);
  }
  out(`  then -> ${await finished}; signedIn after: ${signIn.signedIn(KEY)}`);
  // A cancelled one.
  const second = await signIn.start(KEY, (st) =>
    out(`  second sign-in -> ${JSON.stringify(st)}`),
  );
  out(`  second start -> ${second.state}; cancel:`);
  await signIn.cancel(KEY);
}

await scenario(
  geminiAgent({ ...base, env: { GOOGLE_GEMINI_BASE_URL: M } }),
  "gemini",
  "antigravity/gemini-4-carbon",
  "high",
);
await scenario(
  grokAgent({ ...base, env: GROK_MOCK }),
  "grok",
  "xai/grok-4.6",
  "medium",
);
await scenario(
  openrouterAgent({ ...base, env: { OPENROUTER_HOST: M } }),
  "openrouter",
  OPENROUTER_MODELS[0]!,
  "high",
);

out(
  "== key checks from a one-shot sandbox through the egress proxy and the mock",
);
for (const [agent, provider, good, bad] of [
  [
    geminiAgent(base),
    "gemini",
    "AIzaMockGoodKey000000000",
    "AIzaMockbadKey0000000000",
  ],
  [
    openrouterAgent(base),
    "openrouter",
    "sk-or-mock-good-00000000",
    "sk-or-mock-bad-000000000",
  ],
] as const) {
  for (const k of [good, bad]) {
    const s = performance.now();
    out(
      `  ${provider} ${k.includes("bad") ? "refused key" : "good key"}: ${await agent.verifyApiKey(KEY, provider, k)} in ${Math.round(performance.now() - s)} ms`,
    );
  }
}
const down = openrouterAgent({
  ...base,
  urls: { openrouter: "http://127.0.0.1:4798" },
});
out(
  `  openrouter unreachable: ${await down.verifyApiKey(KEY, "openrouter", "sk-or-mock-good-00000000")}`,
);
out(
  `  keys on any sandbox's argv: ${sandboxes.spawned.some((x) => /AIzaMock|sk-or-mock/.test(x.args.join(" ")))}`,
);

const peaks = new Map<string, number>();
for (const p of sandboxes.peaks) peaks.set(p.label, Math.max(peaks.get(p.label) ?? 0, p.mib));
out(`== memory peak of one sandbox, by program: ${JSON.stringify(Object.fromEntries(peaks))} MiB`);
out(`leftover sandboxes: ${sandboxCount()}`);
rmSync(`${HOME}/.grok/auth.json`, { force: true });
rmSync(`${HOME}/${MOCK_SOCK}`, { force: true });
stub.stop();
process.exit(0);
