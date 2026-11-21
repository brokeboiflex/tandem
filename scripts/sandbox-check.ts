// Proves the sandbox layer (src/runtime.ts) on a real host, inside a Tandem container started with
// compose.yaml's privileges. This process plays the gateway: it starts the egress proxy, an MCP
// stand-in on the person's MCP socket, and the person's sandboxes, and checks what the kernel does.
//   docker compose -p tandem-sandbox -f compose.yaml -f compose.check.yaml run --rm -T tandem \
//     bun scripts/sandbox-check.ts
// The container's environment must hold SECRET (a fake value): it must never reach a sandbox.
import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { startEgress } from "../src/egress";
import { runtimeKey, SandboxRuntime, STOP_GRACE_MS } from "../src/runtime";

const CG = "/sys/fs/cgroup";
const cfg = loadConfig();

if (process.argv[2] === "leave") {
  // A gateway that dies with a sandbox running (killed by the parent below).
  const rt = new SandboxRuntime(cfg, { log: () => {} });
  const child = await rt.spawn(process.argv[3]!, ["sleep", "600"], {
    label: "left",
  });
  child.stdout!.resume();
  await Bun.sleep(500);
  console.log("started");
  await new Promise(() => {});
}

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`,
  );
  if (!ok) failures++;
}
const read = (path: string) =>
  existsSync(path) ? readFileSync(path, "utf8").trim() : null;
const childCgroups = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    : [];

/** Output and exit of a spawned sandbox. */
function collect(child: ChildProcess) {
  let out = "";
  let err = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (err += d));
  const t0 = Date.now();
  return new Promise<{
    out: string;
    err: string;
    code: number | null;
    ms: number;
  }>((resolve) =>
    child.once("exit", (code) =>
      resolve({ out, err, code, ms: Date.now() - t0 }),
    ),
  );
}
const firstLine = (child: ChildProcess) =>
  new Promise<string>((resolve) => {
    let buf = "";
    const on = (d: Buffer) => {
      buf += d;
      if (buf.includes("\n")) {
        child.stdout!.off("data", on);
        resolve(buf.split("\n")[0]!);
      }
    };
    child.stdout!.on("data", on);
  });

const alice = runtimeKey(cfg.serviceSecret, "sandbox-check-alice");
const person = join(CG, "sandboxes", `${cfg.runtimePrefix}-${alice}`);
console.log(
  `sandbox check: kernel ${read("/proc/sys/kernel/osrelease")}, ${navigator.hardwareConcurrency} CPUs, ` +
    `RUNTIME_MEMORY_MB=${cfg.runtimeMemoryMb}, RUNTIME_PIDS=${cfg.runtimePids}, key ${alice}`,
);
check(
  "the gateway's environment holds SECRET (a fake value)",
  !!process.env.SECRET,
);

// The egress proxy and its socket, which every sandbox has mounted.
const probeRt = new SandboxRuntime(cfg, { log: () => {}, sweep: false });
await startEgress(cfg, probeRt.egressSocket(), () => {});

// --- Leftovers of a gateway that was killed ------------------------------------------------------
{
  const leaver = spawnProcess(
    "bun",
    ["scripts/sandbox-check.ts", "leave", alice],
    {
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  await firstLine(leaver);
  leaver.kill("SIGKILL");
  await new Promise((r) => leaver.once("exit", r));
  const before = (await probeRt.list()).filter(
    (s) => s.key === alice && s.status === "running",
  );
  check(
    "a killed gateway leaves its sandbox running (the situation setup must clean up)",
    before.length === 1 && childCgroups(person).length === 1,
    `crun: ${before.map((s) => s.id).join(", ")}; cgroups: ${childCgroups(person).join(", ")}`,
  );
}
const logs: string[] = [];
const rt = new SandboxRuntime(cfg, { log: (...a) => logs.push(a.join(" ")) });
const posture = await rt.posture();
{
  const left = await rt.list();
  check(
    "setup deleted the leftover sandbox, its cgroups, bundles and temporary files",
    left.length === 0 &&
      !existsSync(person) &&
      readdirSync(join(cfg.dataDir, "bundles")).length === 0 &&
      readdirSync(join(cfg.dataDir, "tmp")).length === 0,
    `crun list: ${JSON.stringify(left)}; log: ${logs.join(" | ")}`,
  );
}

// --- The gateway's own cgroup ---------------------------------------------------------------------
check(
  "per-person limits are on (cgroups delegated)",
  posture.limits,
  posture.warnings.join("; "),
);
check(
  "the gateway runs in its own leaf with cpu.weight 400 and memory.min 128 MiB",
  read("/proc/self/cgroup") === "0::/gateway" &&
    read(join(CG, "gateway/cpu.weight")) === "400" &&
    read(join(CG, "gateway/memory.min")) === String(128 * 2 ** 20),
  `cgroup ${read("/proc/self/cgroup")}, cpu.weight ${read(join(CG, "gateway/cpu.weight"))}, memory.min ${read(join(CG, "gateway/memory.min"))}`,
);

// --- Two processes of one person, each in a sandbox of its own --------------------------------------
const uid = JSON.parse(readFileSync(join(cfg.dataDir, "uids.json"), "utf8"))[
  alice
] as number;
const IDENTITY =
  'echo "uid=$(id -u) pid=$$"; grep -E "^(CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp):" /proc/self/status; ' +
  'cat /proc/self/cgroup; echo "init=$(cat /proc/1/comm)"; cat /proc/self/oom_score_adj; cat';
const a = await rt.spawn(alice, ["sh", "-c", IDENTITY], {
  label: "a",
  cwd: "/home/agent/projects/chats",
});
const b = await rt.spawn(alice, ["sh", "-c", IDENTITY], { label: "b" });
const ra = collect(a);
const rb = collect(b);
await Bun.sleep(1500);
{
  const running = (await rt.list()).filter(
    (s) => s.key === alice && s.status === "running",
  );
  const leaves = childCgroups(person);
  check(
    "two processes of one person run at once, each a sandbox of its own and a child of the person's cgroup",
    running.length === 2 &&
      leaves.length === 2 &&
      leaves.every((l) => /^[ab]-\d+-\d+$/.test(l)),
    `sandboxes: ${running.map((s) => s.id).join(", ")}; ${person}: ${leaves.join(", ")}`,
  );
  check(
    "the person's cgroup holds their limits; each sandbox has memory.oom.group 1",
    read(join(person, "memory.max")) ===
      String(cfg.runtimeMemoryMb * 2 ** 20) &&
      read(join(person, "memory.high")) === "max" &&
      read(join(person, "pids.max")) === String(cfg.runtimePids) &&
      read(join(person, "cpu.weight")) === "100" &&
      read(join(person, "memory.oom.group")) === "0" &&
      leaves.every((l) => read(join(person, l, "memory.oom.group")) === "1") &&
      leaves.every((l) => read(join(person, l, "cpu.max"))!.startsWith("max ")),
    `memory.max ${read(join(person, "memory.max"))}, memory.high ${read(join(person, "memory.high"))}, ` +
      `pids.max ${read(join(person, "pids.max"))}, cpu.weight ${read(join(person, "cpu.weight"))}, ` +
      `leaves oom.group ${leaves.map((l) => read(join(person, l, "memory.oom.group"))).join(",")}, ` +
      `leaves cpu.max ${leaves.map((l) => read(join(person, l, "cpu.max"))).join(",")}`,
  );
}
a.stdin!.end();
b.stdin!.end();
const [oa, ob] = await Promise.all([ra, rb]);
for (const [name, r] of [
  ["a", oa],
  ["b", ob],
] as const) {
  const caps = [...r.out.matchAll(/^(Cap\w+):\s+(\w+)$/gm)].map((m) => m[2]);
  check(
    `process ${name}: the person's uid ${uid}, no capabilities, NoNewPrivs 1, seccomp filter, oom_score_adj 500, PID 1 is tini`,
    r.code === 0 &&
      r.out.includes(`uid=${uid} `) &&
      caps.length === 5 &&
      caps.every((c) => /^0+$/.test(c)) &&
      /^NoNewPrivs:\s+1$/m.test(r.out) &&
      /^Seccomp:\s+2$/m.test(r.out) &&
      /^500$/m.test(r.out) &&
      /^init=tini$/m.test(r.out) &&
      // Its own cgroup namespace: it sees its sandbox's cgroup as the root.
      /^0::\/$/m.test(r.out),
    r.out.trim().replaceAll("\n", " | ") +
      (r.err ? ` stderr: ${r.err.trim()}` : ""),
  );
}
check(
  "agent-run made the working directory as the person",
  existsSync(join(rt.homeOf(alice), "projects/chats")) &&
    Bun.spawnSync([
      "stat",
      "-c",
      "%u",
      join(rt.homeOf(alice), "projects/chats"),
    ])
      .stdout.toString()
      .trim() === String(uid),
);

// --- The gateway's environment never reaches a sandbox ---------------------------------------------
{
  const child = await rt.spawn(
    alice,
    ["sh", "-c", "env; echo ---; tr '\\0' '\\n' < /proc/1/environ"],
    {
      env: { ANTHROPIC_API_KEY: "sk-ant-fake-for-the-check" },
    },
  );
  const r = await collect(child);
  const names = r.out
    .split("---")[0]!
    .trim()
    .split("\n")
    .map((l) => l.split("=")[0]);
  check(
    "a sandbox's environment is the base set plus what the agent passes; the gateway's SECRET is absent",
    !r.out.includes(process.env.SECRET!) &&
      !r.out.includes(cfg.serviceSecret) &&
      !names.includes("SECRET") &&
      names.includes("ANTHROPIC_API_KEY") &&
      ["PATH", "HOME", "TMPDIR", "HTTPS_PROXY", "NO_PROXY"].every((n) =>
        names.includes(n),
      ),
    `variables: ${[...new Set(names)].sort().join(" ")}`,
  );
}

// --- Egress: only allowlisted hosts, only through the proxy ----------------------------------------
{
  const curl = (url: string, ...flags: string[]) =>
    rt
      .spawn(
        alice,
        [
          "curl",
          "-sS",
          "-m",
          "15",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          ...flags,
          url,
        ],
        {
          label: "curl",
        },
      )
      .then(collect);
  const allowed = await curl("https://api.anthropic.com/v1/models");
  check(
    "an allowlisted host (api.anthropic.com) answers through the egress proxy",
    allowed.code === 0 && /^[1-5]\d\d$/.test(allowed.out),
    `HTTP ${allowed.out} ${allowed.err.trim()}`,
  );
  const refused = await curl("https://example.com/");
  check(
    "a host outside the allowlist (example.com) is refused by the proxy",
    refused.code !== 0 && !/^[23]\d\d$/.test(refused.out),
    `exit ${refused.code}, ${refused.err.trim()}`,
  );
  const direct = await curl("https://api.anthropic.com/", "--noproxy", "*");
  check(
    "without the proxy there is no network at all",
    direct.code !== 0,
    `exit ${direct.code}, ${direct.err.trim()}`,
  );
}

// --- The person's MCP proxy socket -----------------------------------------------------------------
{
  const sock = rt.mcpSocket(alice);
  mkdirSync(join(sock, ".."), { recursive: true });
  const server = Bun.serve({
    unix: sock,
    fetch: (req) => new Response(`mcp-ok ${new URL(req.url).pathname}`),
  });
  const viaSpawn = await rt
    .spawn(
      alice,
      ["curl", "-sS", "-m", "5", `http://127.0.0.1:8790/mcp/${alice}/stub`],
      { label: "mcp" },
    )
    .then(collect);
  check(
    "a spawned process reaches the MCP socket at 127.0.0.1:8790 (not through the egress proxy)",
    viaSpawn.code === 0 && viaSpawn.out === `mcp-ok /mcp/${alice}/stub`,
    `${viaSpawn.out} ${viaSpawn.err.trim()}`,
  );
  const st = Bun.spawnSync(["stat", "-c", "%u %a", sock])
    .stdout.toString()
    .trim();
  check(
    "the MCP socket belongs to the person, mode 600",
    st === `${uid} 600`,
    st,
  );
  const viaExec = await rt.exec(alice, [
    "curl",
    "-sS",
    "-m",
    "5",
    "http://127.0.0.1:8790/",
  ]);
  check(
    "a one-shot command does not get the MCP socket",
    viaExec.exitCode !== 0,
    `exit ${viaExec.exitCode} ${viaExec.stderr.trim()}`,
  );
  server.stop(true);
}

// --- Memory: a runaway process tree ends alone ------------------------------------------------------
{
  const keep = await rt.spawn(alice, ["sleep", "600"], { label: "keep" });
  const keepDone = collect(keep);
  // dd's buffer is larger than the person's limit; the shell itself waits on, so only the group
  // kill (memory.oom.group) ends this sandbox.
  const hog = await rt.spawn(
    alice,
    [
      "sh",
      "-c",
      `dd if=/dev/zero of=/dev/null bs=${cfg.runtimeMemoryMb + 200}M count=3 & sleep 600`,
    ],
    { label: "hog" },
  );
  const hogDone = collect(hog);
  const result = await Promise.race([
    hogDone,
    Bun.sleep(60_000).then(() => null),
  ]);
  const events = read(join(person, "memory.events")) ?? "";
  const peak = read(join(person, "memory.peak"));
  const keepRunning = (await rt.list()).some(
    (s) => s.id.includes("-keep-") && s.status === "running",
  );
  // Not ended within a minute: end it, so the checks below are not stalled by it.
  if (!result) {
    hog.kill("SIGKILL");
    await hogDone;
  }
  check(
    `a process tree allocating beyond RUNTIME_MEMORY_MB (${cfg.runtimeMemoryMb} MiB) is OOM-killed with its whole group`,
    result !== null &&
      result.code === 137 &&
      /oom_kill [1-9]/.test(events) &&
      /oom_group_kill [1-9]/.test(events),
    `exit ${result?.code ?? "none within 60 s"} after ${result?.ms} ms; person memory.peak ${peak}; memory.events: ${events.replaceAll("\n", ", ")}`,
  );
  check(
    "the person's other process and the gateway survive",
    keepRunning && keep.exitCode === null && process.memoryUsage().rss > 0,
    `keep running: ${keepRunning}`,
  );
  keep.kill();
  await keepDone;
}

// --- kill(): TERM, then KILL --------------------------------------------------------------------------
{
  const polite = await rt.spawn(alice, ["sleep", "600"], { label: "polite" });
  const pd = collect(polite);
  await Bun.sleep(500);
  const t1 = Date.now();
  polite.kill();
  const p = await pd;
  const pms = Date.now() - t1;
  check(
    "kill() ends a program that honours TERM at once",
    p.code === 143 && pms < 1000,
    `exit ${p.code} ${pms} ms after kill()`,
  );
  const stubborn = await rt.spawn(
    alice,
    ["sh", "-c", 'trap "" TERM; echo up; while :; do sleep 1; done'],
    {
      label: "stubborn",
    },
  );
  const up = firstLine(stubborn);
  const sd = collect(stubborn);
  await up;
  const t0 = Date.now();
  stubborn.kill("SIGTERM");
  const s = await sd;
  const ms = Date.now() - t0;
  check(
    `kill() kills a program that ignores TERM after the grace period (${STOP_GRACE_MS} ms)`,
    s.code === 137 && ms >= STOP_GRACE_MS && ms < STOP_GRACE_MS + 3000,
    `exit ${s.code} after ${ms} ms`,
  );
}

// --- Vendor programs and settings in the runtime filesystem ----------------------------------------
{
  const home = rt.homeOf(alice);
  // A person's own config that tries to turn plugins back on: requirements.toml must win.
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(
    join(home, ".codex/config.toml"),
    "[features]\nplugins = true\n",
  );
  Bun.spawnSync(["chown", "-R", `${uid}:${uid}`, join(home, ".codex")]);
  const r = await rt.exec(alice, [
    "sh",
    "-c",
    "cat /etc/claude-code/managed-settings.json; codex features list 2>&1 | grep -E '^(plugins|apps) '; goose --version; claude --version",
  ]);
  const settings = (() => {
    try {
      return JSON.parse(r.stdout.slice(0, r.stdout.indexOf("}\n}") + 3));
    } catch {
      return null;
    }
  })();
  check(
    "Claude Code's managed settings are in place (env, sandbox off)",
    settings?.sandbox?.enabled === false &&
      settings?.env?.DISABLE_TELEMETRY === "1",
  );
  check(
    "Codex: plugins and apps stay off although the person's own config enables plugins",
    /^plugins\s.*false/m.test(r.stdout) && /^apps\s.*false/m.test(r.stdout),
    r.stdout
      .split("\n")
      .filter((l) => /^(plugins|apps) /.test(l))
      .join(" | "),
  );
  check(
    "goose and Claude Code run in a sandbox",
    /goose|1\.60\.2/.test(r.stdout) && /2\.1\.321/.test(r.stdout),
    r.stdout.split("\n").slice(-3).join(" | "),
  );
}

// --- An operator command next to the gateway leaves the gateway's sandboxes alone --------------------
{
  const live = await rt.spawn(alice, ["sleep", "600"], { label: "live" });
  const ld = collect(live);
  await Bun.sleep(500);
  const cli = Bun.spawnSync([
    "bun",
    "src/cli.ts",
    "exec",
    alice,
    "--",
    "id",
    "-u",
  ]);
  const still = (await rt.list()).some(
    (s) => s.id.includes("-live-") && s.status === "running",
  );
  check(
    "src/cli.ts exec runs as the person and does not end or sweep the gateway's sandboxes",
    cli.exitCode === 0 &&
      cli.stdout.toString().trim() === String(uid) &&
      still &&
      existsSync(person),
    `cli exit ${cli.exitCode} out ${cli.stdout.toString().trim()} ${cli.stderr.toString().trim()}; live still running: ${still}`,
  );
  // --- stopAll ------------------------------------------------------------------------------------
  const second = await rt.spawn(
    alice,
    ["sh", "-c", 'trap "" TERM; while :; do sleep 1; done'],
    { label: "second" },
  );
  const sd = collect(second);
  await Bun.sleep(500);
  await rt.stopAll(alice);
  const [l, s] = await Promise.all([ld, sd]);
  const left = (await rt.list()).filter((x) => x.key === alice);
  check(
    "stopAll ends every sandbox of the person and leaves no sandbox, cgroup or temporary directory",
    l.code !== null &&
      s.code !== null &&
      left.length === 0 &&
      !existsSync(person) &&
      !existsSync(join(cfg.dataDir, "tmp", alice)),
    `exits ${l.code}, ${s.code}; left: ${JSON.stringify(left)}; cgroup exists: ${existsSync(person)}`,
  );
}

await rt.stopEverything();
check(
  "stopEverything leaves no sandbox and no person cgroup of this instance",
  (await rt.list()).length === 0 &&
    childCgroups(join(CG, "sandboxes")).filter((n) =>
      n.startsWith(`${cfg.runtimePrefix}-`),
    ).length === 0,
);
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
