// ClaudeAgent in real sandboxes: the scenarios of tests/claude-scenarios.ts with the rootfs's
// /usr/local/bin/claude started by `crun run` as the person (their uid and home, no capabilities,
// seccomp, own namespaces), against the scripted Anthropic API and the stub MCP server, which the
// sandbox reaches through relays on 127.0.0.1 (as it reaches the egress and MCP proxies).
//
//   bun evidence/poc/claude-agent-vm.ts <person key> <uid> <bundle template config.json>
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mockAnthropic } from "../../scripts/mock-vendor/mock-anthropic";
import { startStubMcp } from "../../scripts/stub-mcp";
import { HOME, type Sandboxes } from "../../src/agents/types";
import { scenarios, type Harness } from "../../tests/claude-scenarios";

const [key, uidArg, template] = process.argv.slice(2);
if (!key || !uidArg || !template)
  throw new Error("usage: claude-agent-vm.ts <key> <uid> <template>");
const uid = Number(uidArg);
const home = `/var/lib/tandem/homes/${key}`;
const person = `tandem-${key}`;
const tmpl = JSON.parse(readFileSync(template, "utf8"));
/** The template's own person: their paths in it (home, tmp, passwd, MCP socket) carry their key. */
const fromKey = /homes\/([a-z0-9]+)$/.exec(
  tmpl.mounts.find((m: any) => m.destination === HOME).source,
)![1]!;
const BUNDLES = "/tmp/claude-agent/bundles";
/** Claude Code inside the sandbox: the rootfs's, or CLAUDE_EXE (e.g. a newer one in the home). */
const EXE = process.env.CLAUDE_EXE ?? "/usr/local/bin/claude";
const EXE_ON_DISK = EXE.startsWith(`${HOME}/`)
  ? home + EXE.slice(HOME.length)
  : `/opt/tandem/rootfs${EXE}`;
// The person's own passwd/group and tmp, kept beside this proof rather than in the gateway's folders.
const RUN = `/tmp/claude-agent/run/${key}`;
const TMP = `/var/lib/tandem/tmp/${key}`;
mkdirSync(RUN, { recursive: true });
writeFileSync(`${RUN}/passwd`, `root:x:0:0:root:/root:/bin/sh\nagent:x:${uid}:${uid}:agent:${HOME}:/bin/bash\n`);
writeFileSync(`${RUN}/group`, `root:x:0:\nagent:x:${uid}:\n`);
mkdirSync(TMP, { recursive: true, mode: 0o700 });
chownSync(TMP, uid, uid);

// The person's cgroup holds their limits; each process is a child sandbox under it.
const parent = `/sys/fs/cgroup/sandboxes/${person}-agent`;
if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
writeFileSync(`${parent}/cgroup.subtree_control`, "+memory +pids +cpu");
writeFileSync(`${parent}/memory.max`, String(2 * 2 ** 30));
mkdirSync(`${home}/projects/chats`, { recursive: true });
for (const p of [home, `${home}/projects`, `${home}/projects/chats`])
  chownSync(p, uid, uid);

/** The template's spec for this person: their uid, their home and tmp in place of its own. */
function specFor(
  args: string[],
  env: Record<string, string>,
  cwd: string,
  name: string,
) {
  const s = structuredClone(tmpl);
  const swap = (v: string) =>
    v === `/var/lib/tandem/run/${fromKey}/passwd`
      ? `${RUN}/passwd`
      : v === `/var/lib/tandem/run/${fromKey}/group`
        ? `${RUN}/group`
        : v.split(fromKey).join(key);
  s.process.user = { ...s.process.user, uid, gid: uid, additionalGids: [] };
  s.mounts = s.mounts
    .filter((m: any) => m.destination !== "/run/tandem/mcp.sock")
    .map((m: any) => ({
      ...m,
      source: typeof m.source === "string" ? swap(m.source) : m.source,
    }));
  const base: string[] = s.process.env.filter((e: string) =>
    /^(PATH|HOME|TMPDIR|HTTPS?_PROXY|https?_proxy|USER|LANG)=/.test(e),
  );
  s.process.env = [
    ...base,
    "NO_PROXY=127.0.0.1,localhost",
    "no_proxy=127.0.0.1,localhost",
    ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
  ];
  // Relays like the sandbox's own: the mock on :4799 and the stub MCP server on :4798.
  s.process.args = [
    "/usr/bin/tini",
    "-s",
    "--",
    "sh",
    "-c",
    'socat TCP-LISTEN:4799,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/home/agent/.agent-mock.sock 2>/dev/null & socat TCP-LISTEN:4798,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/home/agent/.agent-mcp.sock 2>/dev/null & sleep 0.2; exec with-egress "$@"',
    "sh",
    ...args,
  ];
  s.process.cwd = cwd;
  s.process.terminal = false;
  s.linux.cgroupsPath = `/sandboxes/${person}-agent/${name}`;
  delete s.linux.resources;
  return s;
}

let n = 0;
const live = new Set<ChildProcess>();
function run(
  args: string[],
  env: Record<string, string>,
  cwd: string,
  label: string,
) {
  const name = `${person}-${label}-${process.pid}-${++n}`.slice(0, 120);
  const dir = `${BUNDLES}/${name}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    `${dir}/config.json`,
    JSON.stringify(specFor(args, env, cwd, name)),
  );
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
  live.add(child);
  child.once("exit", () => {
    live.delete(child);
    spawnSync("crun", ["delete", "-f", name]);
    rmSync(dir, { recursive: true, force: true });
  });
  // The sandbox's own stop: TERM to everything in it, then KILL after a grace period.
  const send = child.kill.bind(child);
  child.kill = (signal?: NodeJS.Signals | number) => {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    spawnSync("crun", [
      "kill",
      "--all",
      name,
      signal === "SIGKILL" ? "KILL" : "TERM",
    ]);
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        spawnSync("crun", ["kill", "--all", name, "KILL"]);
        send("SIGKILL");
      }
    }, 5000).unref();
    return true;
  };
  return child;
}

const sandboxes: Sandboxes = {
  homeOf: () => home,
  async spawn(_key, args, o = {}) {
    return run(args, o.env ?? {}, o.cwd ?? HOME, o.label ?? "proc");
  },
  async exec(_key, args, o = {}) {
    const child = run(args, o.env ?? {}, o.cwd ?? HOME, "exec");
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    child.stdin!.end(o.stdin ?? "");
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    const exitCode = await new Promise<number>((r) =>
      child.once("exit", (c) => r(c ?? 1)),
    );
    clearTimeout(timer);
    return { exitCode, stdout, stderr };
  },
};

// The scripted vendor and the stub MCP server, on sockets in the person's home.
const mock = mockAnthropic({ log: "/tmp/claude-agent/mock.log" });
const mockSock = `${home}/.agent-mock.sock`;
rmSync(mockSock, { force: true });
Bun.serve({ unix: mockSock, fetch: mock.handle, idleTimeout: 120 });
chownSync(mockSock, uid, uid);
const stub = startStubMcp();
const mcpSock = `${home}/.agent-mcp.sock`;
rmSync(mcpSock, { force: true });
Bun.serve({
  unix: mcpSock,
  idleTimeout: 120,
  fetch: (req) => {
    const url = new URL(req.url);
    return fetch(`http://127.0.0.1:${stub.port}${url.pathname}${url.search}`, {
      method: req.method,
      headers: req.headers,
      body:
        req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    });
  },
});
chownSync(mcpSock, uid, uid);

const harness: Harness = {
  sandboxes,
  key,
  executable: EXE,
  mockUrl: "http://127.0.0.1:4799",
  mock,
  mcpUrl: "http://127.0.0.1:4798/mcp",
  mcpRequests: stub.requests,
  // This rootfs has no managed settings for Claude Code yet; they would hold this.
  env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
};

const version = spawnSync(
  EXE_ON_DISK,
  ["--version"],
  { encoding: "utf8" },
).stdout.trim();
console.log(
  `# ClaudeAgent in real sandboxes (crun), ${new Date().toISOString()}`,
);
console.log(
  `# person ${key} uid ${uid}, Claude Code ${version} at ${EXE}, SDK ${JSON.parse(readFileSync("node_modules/@anthropic-ai/claude-agent-sdk/package.json", "utf8")).version}, nproc ${spawnSync("nproc", { encoding: "utf8" }).stdout.trim()}`,
);
let peak = 0;
const sample = setInterval(() => {
  try {
    peak = Math.max(
      peak,
      Number(readFileSync(`${parent}/memory.peak`, "utf8")) ||
        Number(readFileSync(`${parent}/memory.current`, "utf8")),
    );
  } catch {}
}, 100);
let failed = 0;
for (const s of scenarios) {
  const t0 = performance.now();
  try {
    const line = await s.run(harness);
    console.log(
      `PASS ${s.name} (${Math.round(performance.now() - t0)} ms): ${line}`,
    );
  } catch (e) {
    failed++;
    console.log(
      `FAIL ${s.name} (${Math.round(performance.now() - t0)} ms): ${String((e as Error)?.stack ?? e).slice(0, 1500)}`,
    );
  }
}
clearInterval(sample);
// What the Bash tool saw inside the sandbox (the first scenario's probe).
const probe = mock.requests.find(
  (r) => r.scenario === "tool_result" && /CapEff/.test(r.text),
);
if (probe)
  console.log(
    `# tool output inside the sandbox: ${probe.text
      .split("\n")
      .filter((l) => /^\d+$|CapEff|NoNewPrivs|Seccomp|TMP=|net=/.test(l.trim()))
      .map((l) => l.trim())
      .join(" | ")}`,
  );
console.log(
  `# person's cgroup memory peak ${(peak / 2 ** 20).toFixed(0)} MiB; Anthropic requests ${mock.requests.length}; MCP requests ${stub.requests.length}`,
);
console.log(
  `# ${scenarios.length - failed}/${scenarios.length} passed; sandboxes left running: ${live.size}`,
);
for (const c of live) c.kill("SIGKILL");
process.exit(failed ? 1 : 0);
