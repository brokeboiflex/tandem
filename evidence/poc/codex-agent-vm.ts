// CodexAgent and CodexSignIn with the real Codex in real Tandem sandboxes (crun), against the
// scripted OpenAI API and sign-in issuer (scripts/mock-vendor/mock-openai.ts) and the stub MCP
// server, inside the Tandem container. The scenarios of tests/codex-agent.integration.test.ts.
//
//   bun evidence/poc/codex-agent-vm.ts <person key> <uid>       (as root in the container)
//
// Each process gets a sandbox of its own from a running person's bundle with this person's uid,
// home, tmp and passwd: no capabilities, no_new_privs, seccomp, own PID/net/IPC/UTS/mount
// namespaces, the read-only rootfs, a child cgroup of the person's. Inside, 127.0.0.1:4799 is the
// mock (a socket in the home), 127.0.0.1:8790 the MCP relay (/run/tandem/mcp.sock, this run's
// own socket) and HTTPS_PROXY a proxy that refuses and records every request, so no real vendor
// is ever asked.
import { spawn, type ChildProcess } from "node:child_process";
import {
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CodexAgent } from "../../src/agents/codex";
import {
  WORKSPACE,
  type McpServer,
  type PermissionMode,
  type SandboxSpawnOptions,
  type Sandboxes,
  type TurnInput,
} from "../../src/agents/types";
import { CodexSignIn } from "../../src/signin/codex";
import * as mock from "../../scripts/mock-vendor/mock-openai";
import { STUB_CUSTOMER, startStubMcp } from "../../scripts/stub-mcp";
import { startRefusingProxy } from "../../tests/support/refusing-proxy";
import { RecordingSink, choose } from "../../tests/support/sink";

const [KEY, UID_ARG] = process.argv.slice(2);
if (!KEY || !UID_ARG)
  throw new Error("usage: codex-agent-vm.ts <person key> <uid>");
const UID = Number(UID_ARG);
const DIR = "/tmp/codex-agent";
const HOMEDIR = `/var/lib/tandem/homes/${KEY}`;
const TEMPLATE =
  "/var/lib/tandem/bundles/tandem-9a05180e08ef315bf682183e/config.json";
const CGROUP = `tandem-${KEY}-codexagent`;
const t0 = performance.now();
const ms = () => `${(performance.now() - t0).toFixed(0).padStart(6)} ms`;
const out = (s: string) => console.log(`${ms()}  ${s}`);
let failures = 0;
const check = (ok: boolean, what: string) => {
  if (!ok) failures++;
  out(`${ok ? "PASS" : "FAIL"} ${what}`);
};

for (const d of [DIR, `${DIR}/bundles`, `${DIR}/tmp`])
  mkdirSync(d, { recursive: true });
chownSync(`${DIR}/tmp`, UID, UID);
if (!existsSync(HOMEDIR)) {
  mkdirSync(HOMEDIR, { recursive: true, mode: 0o700 });
  chownSync(HOMEDIR, UID, UID);
}
const chats = join(HOMEDIR, WORKSPACE.slice("/home/agent/".length));
mkdirSync(chats, { recursive: true });
chownSync(join(HOMEDIR, "projects"), UID, UID);
chownSync(chats, UID, UID);
process.env.MOCK_LOG = `${DIR}/mock.log`;
rmSync(process.env.MOCK_LOG, { force: true });

// The gateway side of the relays: the mock and the stub MCP server on Unix sockets.
const mockSock = join(HOMEDIR, ".codex-agent-mock.sock");
rmSync(mockSock, { force: true });
const api = Bun.serve({ unix: mockSock, fetch: mock.handle });
chownSync(mockSock, UID, UID);
const stub = startStubMcp();
const mcpSock = `${DIR}/mcp.sock`;
rmSync(mcpSock, { force: true });
// A sandbox's MCP relay ends here; the stub listens on the container's loopback.
const mcpRelay = Bun.serve({
  unix: mcpSock,
  fetch: (req) => {
    const u = new URL(req.url);
    return fetch(
      `${stub.url.replace(/\/mcp$/, "")}${u.pathname.replace(/^\/mcp\/[^/]+\/[^/]+$/, "/mcp")}`,
      {
        method: req.method,
        headers: req.headers,
        body: req.body,
        // @ts-ignore Bun streams request bodies
        duplex: "half",
      },
    );
  },
});
chownSync(mcpSock, UID, UID);
const proxySock = join(HOMEDIR, ".codex-agent-proxy.sock");
rmSync(proxySock, { force: true });
const proxy = startRefusingProxy({ unix: proxySock });
chownSync(proxySock, UID, UID);

// ---------------------------------------------------------------------------------------------
// Sandboxes on crun, from a running person's bundle with this person swapped in.

const tmpl = JSON.parse(readFileSync(TEMPLATE, "utf8"));
const BASE_ENV = (tmpl.process.env as string[]).filter((e) =>
  /^(PATH|HOME|TMPDIR|NO_PROXY|no_proxy)=/.test(e),
);
// Everything not for 127.0.0.1 goes to the refusing proxy (relayed from the home's socket).
const PROXY = "http://127.0.0.1:4750";
const RELAYS = [
  `socat TCP-LISTEN:4750,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/home/agent/.codex-agent-proxy.sock`,
  `socat TCP-LISTEN:4799,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/home/agent/.codex-agent-mock.sock`,
  `socat TCP-LISTEN:8790,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/run/tandem/mcp.sock`,
]
  .map((c) => `${c} 2>/dev/null &`)
  .join(" ");
const parent = `/sys/fs/cgroup/sandboxes/${CGROUP}`;
if (!existsSync(parent)) mkdirSync(parent);
writeFileSync(`${parent}/cgroup.subtree_control`, "+memory +pids +cpu");
let seq = 0;

const crun = (args: string[]) =>
  Bun.spawn(["crun", "--cgroup-manager=cgroupfs", ...args], {
    stdout: "ignore",
    stderr: "ignore",
  }).exited;

class CrunSandboxes implements Sandboxes {
  spawned: { label?: string; args: string[]; env: Record<string, string> }[] =
    [];
  homeOf() {
    return HOMEDIR;
  }
  #bundle(args: string[], opts: SandboxSpawnOptions) {
    const label = opts.label ?? "exec";
    const name = `codexagent-${label}-${process.pid}-${++seq}`;
    const spec = structuredClone(tmpl);
    spec.process.user = { uid: UID, gid: UID, additionalGids: [] };
    spec.process.args = [
      "/usr/bin/tini",
      "-s",
      "--",
      "sh",
      "-c",
      `${RELAYS} exec "$@"`,
      "sh",
      ...args,
    ];
    spec.process.cwd = opts.cwd ?? "/home/agent";
    const env = {
      HTTPS_PROXY: PROXY,
      HTTP_PROXY: PROXY,
      https_proxy: PROXY,
      http_proxy: PROXY,
      ...opts.env,
    };
    spec.process.env = [
      ...BASE_ENV,
      ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
    ];
    spec.mounts = spec.mounts.map((m: any) => {
      if (m.destination === "/home/agent") return { ...m, source: HOMEDIR };
      if (m.destination === "/var/tmp/agent")
        return { ...m, source: `${DIR}/tmp` };
      if (m.destination === "/etc/passwd")
        return { ...m, source: `/var/lib/tandem/run/${KEY}/passwd` };
      if (m.destination === "/etc/group")
        return { ...m, source: `/var/lib/tandem/run/${KEY}/group` };
      if (m.destination === "/run/tandem/mcp.sock")
        return { ...m, source: mcpSock };
      return m;
    });
    spec.linux.cgroupsPath = `/sandboxes/${CGROUP}/${label}-${seq}`;
    delete spec.linux.resources;
    const dir = `${DIR}/bundles/${name}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/config.json`, JSON.stringify(spec));
    this.spawned.push({ label, args, env });
    return { name, dir };
  }
  async spawn(
    _key: string,
    args: string[],
    opts: SandboxSpawnOptions = {},
  ): Promise<ChildProcess> {
    const { name, dir } = this.#bundle(args, opts);
    const child = spawn(
      "crun",
      [
        "--cgroup-manager=cgroupfs",
        "run",
        "--no-pivot",
        "--no-new-keyring",
        "--bundle",
        dir,
        name,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child.once(
      "exit",
      () =>
        void crun(["delete", "-f", name]).then(() =>
          rmSync(dir, { recursive: true, force: true }),
        ),
    );
    // The sandbox's own kill: TERM to its processes, KILL after a grace period.
    child.kill = () => {
      void crun(["kill", name, "TERM"]);
      const t = setTimeout(
        () => void crun(["kill", "--all", name, "KILL"]),
        3000,
      );
      child.once("exit", () => clearTimeout(t));
      return true;
    };
    return child;
  }
  async exec(
    key: string,
    args: string[],
    opts: { env?: Record<string, string>; cwd?: string } = {},
  ) {
    const child = await this.spawn(key, args, { ...opts, label: "exec" });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    child.stdin!.end();
    const exitCode = await new Promise<number>((r) =>
      child.once("exit", (c) => r(c ?? 1)),
    );
    return { exitCode, stdout, stderr };
  }
}

// ---------------------------------------------------------------------------------------------

const boxes = new CrunSandboxes();
const ORIGIN = "http://127.0.0.1:4799";
const PROVIDER = [
  'model_provider="mock"',
  'model_providers.mock.name="mock"',
  `model_providers.mock.base_url="${ORIGIN}/v1"`,
  'model_providers.mock.wire_api="responses"',
  'model_providers.mock.env_key="MOCK_API_KEY"',
  "model_providers.mock.request_max_retries=0",
  "model_providers.mock.stream_max_retries=0",
  `chatgpt_base_url="${ORIGIN}/backend-api/"`,
];
const ENV = {
  MOCK_API_KEY: "mock-key",
  CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${ORIGIN}/oauth/token`,
  CODEX_REVOKE_TOKEN_URL_OVERRIDE: `${ORIGIN}/oauth/revoke`,
};
const agent = new CodexAgent(boxes, {
  config: PROVIDER,
  env: ENV,
  idleMs: 60_000,
  log: (l) => out(l),
});
const input = (
  text: string,
  permissionMode: PermissionMode,
  over: Partial<TurnInput> = {},
): TurnInput => ({
  conversationId: "c",
  provider: "codex",
  model: "codex-cli/gpt-mock",
  effort: null,
  session: null,
  text,
  mcpServers: [],
  permissionMode,
  ...over,
});
const turn = async (
  a: CodexAgent,
  i: TurnInput,
  sink = new RecordingSink(),
  signal = new AbortController().signal,
) => {
  const start = performance.now();
  const end = await a.turn(KEY, i, sink, signal);
  out(
    `  turn "${i.text}" (${i.permissionMode}) -> ${JSON.stringify(end)} in ${(performance.now() - start).toFixed(0)} ms`,
  );
  return { end, sink };
};
const peak = () =>
  (Number(readFileSync(`${parent}/memory.peak`, "utf8")) / 2 ** 20).toFixed(0);

try {
  out(
    `person ${KEY} uid ${UID}; codex ${(await boxes.exec(KEY, ["codex", "--version"])).stdout.trim()}`,
  );

  out(
    "== device sign-in: the real `codex login --device-auth` against the scripted issuer",
  );
  rmSync(join(HOMEDIR, ".codex/auth.json"), { force: true });
  const signIn = new CodexSignIn(boxes, {
    args: ["--experimental_issuer", ORIGIN],
  });
  const changes: unknown[] = [];
  const first = await signIn.start(KEY, (s) => changes.push(s));
  out(`  start -> ${JSON.stringify(first)}`);
  check(
    first.state === "waiting" &&
      first.url === `${ORIGIN}/codex/device` &&
      first.userCode === mock.DEVICE_USER_CODE,
    "waiting with the CLI's page and one-time code",
  );
  for (let i = 0; i < 300 && !changes.length; i++) await Bun.sleep(50);
  out(`  then -> ${JSON.stringify(changes)}`);
  check(
    JSON.stringify(changes) === '[{"state":"succeeded"}]' &&
      signIn.signedIn(KEY),
    "succeeded: the CLI exited 0 and wrote ~/.codex/auth.json",
  );

  out("== read");
  const live = await agent.read(KEY, "codex");
  out(
    `  ${JSON.stringify({ ...live, models: live.models.slice(0, 2) })} (+${live.models.length - 2} more)`,
  );
  check(
    live.signedIn &&
      live.models.length > 0 &&
      live.models.every((m) => m.id.startsWith("codex-cli/")),
    "signed in, Codex's models as codex-cli/<id>",
  );

  out("== a shell command writes a file in the workspace (full_access)");
  rmSync(join(chats, "probe.txt"), { force: true });
  const shell = await turn(agent, input("RUN_TOOL please", "full_access"));
  out(`  text: ${JSON.stringify(shell.sink.allText().slice(0, 400))}`);
  check(
    shell.end.status === "completed" &&
      readFileSync(join(chats, "probe.txt"), "utf8") === "hi\n",
    "completed; probe.txt written in the workspace",
  );
  check(
    /Output:\n100002\nCapEff:\s+0+\nNoNewPrivs:\s+1\nSeccomp:\s+2/.test(
      shell.sink.allText(),
    ),
    "the command ran as the person's uid, CapEff 0, NoNewPrivs 1, Seccomp 2",
  );
  const firstSession = shell.sink.sessions[0]!;
  out(
    `  tools ${JSON.stringify(shell.sink.tools.map(([, t]) => t))}; context ${JSON.stringify(shell.sink.contexts.at(-1))}; usage ${JSON.stringify(shell.sink.usages.at(-1))}`,
  );
  out(
    `  app-server argv: ${boxes.spawned.find((s) => s.label === "codex")!.args.join(" ")}`,
  );

  out("== on-request asks before a dangerous command: allowed");
  rmSync(join(chats, "removed.txt"), { force: true });
  const allowed = await turn(
    agent,
    input("RUN_DANGEROUS now", "auto"),
    new RecordingSink(choose("Allow once")),
  );
  out(`  ask: ${JSON.stringify(allowed.sink.asks[0])}`);
  check(
    allowed.end.status === "completed" &&
      allowed.sink.asks.length === 1 &&
      existsSync(join(chats, "removed.txt")),
    "asked once (exec_command); allowed, it ran",
  );

  out("== on-request asks before a dangerous command: denied");
  rmSync(join(chats, "removed.txt"), { force: true });
  const denied = await turn(
    agent,
    input("RUN_DANGEROUS now", "auto"),
    new RecordingSink(choose("Deny")),
  );
  check(
    denied.end.status === "completed" &&
      denied.sink.asks.length === 1 &&
      !existsSync(join(chats, "removed.txt")) &&
      denied.sink.allText().includes("rejected"),
    "denied: it did not run, Codex was told it was rejected",
  );

  out("== abort mid-turn");
  const ac = new AbortController();
  const slowSink = new RecordingSink();
  slowSink.onTool = (t) => t.status === "running" && ac.abort();
  const slow = await turn(
    agent,
    input("RUN_SLOW please", "full_access"),
    slowSink,
    ac.signal,
  );
  check(
    slow.end.status === "aborted" && !slowSink.allText().includes("slept"),
    "aborted while `sleep 60` ran",
  );

  out("== release, then a second turn resumes the same thread");
  await agent.release(KEY);
  const recall = await turn(
    agent,
    input("RECALL it", "full_access", { session: firstSession }),
  );
  out(`  text: ${JSON.stringify(recall.sink.allText().slice(0, 300))}`);
  check(
    recall.end.status === "completed" &&
      recall.sink.sessions[0] === firstSession &&
      recall.sink.allText().includes("RUN_TOOL please"),
    "same thread id; the earlier message reached the model",
  );

  out("== MCP through the relay, the proxy token only in the environment");
  const servers: McpServer[] = [
    {
      name: "app",
      url: `http://127.0.0.1:8790/mcp/${KEY}/app`,
      headers: { Authorization: "Bearer valid-vm-token" },
      enabledTools: ["lookup_customer", "confirm_action"],
    },
  ];
  const lookup = await turn(
    agent,
    input("RUN_MCP please", "full_access", { mcpServers: servers }),
  );
  const app = boxes.spawned.filter((s) => s.label === "codex").at(-1)!;
  check(
    lookup.end.status === "completed" &&
      lookup.sink.allText().includes(STUB_CUSTOMER.name),
    "mcp__app__lookup_customer answered",
  );
  check(
    stub.requests.some(
      (r) =>
        r.tool === "lookup_customer" &&
        r.authorization === "Bearer valid-vm-token",
    ) &&
      !app.args.join(" ").includes("valid-vm-token") &&
      app.env.TANDEM_MCP_APP_TOKEN === "valid-vm-token",
    "the stub saw the token; argv never had it",
  );
  const confirm = await turn(
    agent,
    input("RUN_CONFIRM please", "auto", { mcpServers: servers }),
    new RecordingSink(choose("Allow once")),
  );
  out(
    `  asks: ${JSON.stringify(confirm.sink.asks.map((a) => [a.kind, a.askedBy, a.prompts[0]!.header, a.prompts[0]!.question]))}`,
  );
  check(
    confirm.end.status === "completed" &&
      confirm.sink.asks.length === 2 &&
      confirm.sink.allText().includes("The person answered: accept."),
    "Codex's approval, then the server's own question, both answered",
  );

  out("== failures");
  const u401 = await turn(agent, input("FAIL_401 now", "full_access"));
  check(
    u401.end.status === "failed" && u401.end.failure.code === "signin_required",
    "401 -> signin_required",
  );
  const usage = await turn(agent, input("FAIL_USAGE now", "full_access"));
  check(
    usage.end.status === "failed" &&
      usage.end.failure.code === "usage_limit" &&
      (usage.end.failure.params as any).resetsAt ===
        new Date(mock.USAGE_RESETS_AT * 1000).toISOString(),
    "usage limit -> usage_limit with its reset time",
  );

  out(
    `== person's cgroup peak ${peak()} MiB; the refusing proxy saw ${JSON.stringify(proxy.attempts)}`,
  );
  check(
    proxy.attempts.length === 0,
    "nothing but the scripted services was asked for",
  );
  await agent.release(KEY);
  check(!agent.busy(KEY), "released: no app-server left");

  out("== sign-out");
  await signIn.signOut(KEY);
  check(!signIn.signedIn(KEY), "codex logout; no auth.json left");
} catch (e: any) {
  failures++;
  out(`ERROR ${e?.stack ?? e}`);
} finally {
  await agent.release(KEY).catch(() => {});
  for (const f of [
    mockSock,
    proxySock,
    join(chats, "probe.txt"),
    join(chats, "removed.txt"),
  ])
    rmSync(f, { force: true });
  api.stop(true);
  mcpRelay.stop(true);
  stub.stop();
  proxy.stop();
  out(failures ? `${failures} FAILED` : "ALL PASSED");
  process.exit(failures ? 1 : 0);
}
