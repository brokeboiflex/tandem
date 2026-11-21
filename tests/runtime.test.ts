// The sandbox controller (src/runtime.ts) against a stand-in crun (tests/fixtures/fake-crun.ts) that
// runs each program directly, and a plain directory as the cgroup tree. What the kernel does with
// these specs and cgroups is proven on a real host by scripts/sandbox-check.ts.
import { afterAll, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config";
import {
  FIRST_UID,
  nextUid,
  SANDBOX_INIT,
  SandboxRuntime,
  type RuntimeOptions,
} from "../src/runtime";
import { RUNTIME_TMPDIR, SANDBOX_MCP_SOCKET } from "../src/security";

const KEY = "0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba98";
const work = mkdtempSync("/tmp/trt-");
afterAll(() => rmSync(work, { recursive: true, force: true }));

function configWith(vars: Record<string, string>): Config {
  const saved = { ...process.env };
  Object.assign(process.env, {
    AUTH_MODE: "dev",
    DEV_AUTH_SECRET: "d".repeat(32),
    SERVICE_SECRET: "s".repeat(32),
    ...vars,
  });
  try {
    return loadConfig();
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

class TestRuntime extends SandboxRuntime {
  cgroupReason: string | null = "no cgroup tree in tests";
  protected override delegate() {
    return Promise.resolve(this.cgroupReason);
  }
}

type Call = { manager: string; args: string[]; env: string[] };

function setup(
  opts: {
    cgroups?: boolean;
    vars?: Record<string, string>;
  } & RuntimeOptions = {},
) {
  const dir = mkdtempSync(join(work, "d"));
  const dataDir = join(dir, "data");
  const rootfs = join(dir, "rootfs");
  mkdirSync(join(rootfs, "usr/local/bin"), { recursive: true });
  writeFileSync(join(rootfs, "usr/local/bin/agent-run"), "");
  const state = join(dir, "crun");
  const crun = join(dir, "crun.sh");
  writeFileSync(
    crun,
    `#!/bin/sh\nFAKE_CRUN_STATE='${state}' exec '${process.execPath}' '${new URL("./fixtures/fake-crun.ts", import.meta.url).pathname}' "$@"\n`,
    { mode: 0o755 },
  );
  const cgroupRoot = join(dir, "cgroup");
  mkdirSync(join(cgroupRoot, "sandboxes"), { recursive: true });
  const cfg = configWith({
    DATA_DIR: dataDir,
    RUNTIME_ROOTFS: rootfs,
    ...opts.vars,
  });
  const rt = new TestRuntime(cfg, {
    log: () => {},
    crun,
    cgroupRoot,
    stopGraceMs: 300,
    ...opts,
  });
  if (opts.cgroups) rt.cgroupReason = null;
  // Homes in tests belong to the test user: pin every person's uid to it.
  const uid = process.getuid!();
  writeFileSync(join(dataDir + "-uids.json"), "");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "uids.json"),
    JSON.stringify({ [KEY]: uid, [OTHER]: uid }),
  );
  const calls = (): Call[] =>
    existsSync(join(state, "calls.jsonl"))
      ? readFileSync(join(state, "calls.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : [];
  const configOf = (id: string) =>
    JSON.parse(readFileSync(join(state, "configs", `${id}.json`), "utf8"));
  const running = () =>
    existsSync(join(state, "boxes")) ? readdirSync(join(state, "boxes")) : [];
  return { cfg, rt, uid, state, calls, configOf, running, cgroupRoot, dataDir };
}

/** stdout, and the exit event's arguments, of a spawned sandbox. */
function collect(child: ChildProcess) {
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  return new Promise<{
    out: string;
    code: number | null;
    signal: string | null;
  }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ out, code, signal })),
  );
}

const idOf = (t: ReturnType<typeof setup>, label: string) =>
  t
    .calls()
    .find((c) => c.args[0] === "run" && c.args.at(-1)!.includes(`-${label}-`))!
    .args.at(-1)!;

/** The spec crun was given for `label`'s sandbox, once crun has read it. */
async function specSoon(t: ReturnType<typeof setup>, label: string) {
  for (const until = Date.now() + 5_000; ; await Bun.sleep(20)) {
    const call = t
      .calls()
      .find((c) => c.args[0] === "run" && c.args.at(-1)!.includes(`-${label}-`));
    if (call && existsSync(join(t.state, "configs", `${call.args.at(-1)}.json`)))
      return t.configOf(call.args.at(-1)!);
    if (Date.now() > until) throw new Error(`no sandbox ${label}`);
  }
}

describe("a sandbox per process", () => {
  test("each process gets its own spec: tini and agent-run, the person's uid, home and cwd", async () => {
    const t = setup();
    const a = await t.rt.spawn(KEY, ["sh", "-c", "echo a"], {
      label: "claude",
      cwd: "/home/agent/projects/chats",
    });
    const b = await t.rt.spawn(KEY, ["sh", "-c", "echo b"], { label: "codex" });
    const [ra, rb] = await Promise.all([collect(a), collect(b)]);
    expect([ra.out, rb.out]).toEqual(["a\n", "b\n"]);
    const ca = t.configOf(idOf(t, "claude"));
    const cb = t.configOf(idOf(t, "codex"));
    expect(idOf(t, "claude")).not.toBe(idOf(t, "codex"));
    expect(idOf(t, "claude")).toMatch(
      new RegExp(`^tandem-${KEY}-claude-${process.pid}-\\d+$`),
    );
    expect(ca.process.args).toEqual([
      ...SANDBOX_INIT,
      "/home/agent/projects/chats",
      "sh",
      "-c",
      "echo a",
    ]);
    expect(cb.process.args).toEqual([
      ...SANDBOX_INIT,
      "/home/agent",
      "sh",
      "-c",
      "echo b",
    ]);
    for (const c of [ca, cb]) {
      expect(c.process.user.uid).toBe(t.uid);
      expect(c.process.cwd).toBe("/home/agent");
      expect(
        c.mounts.find((m: any) => m.destination === "/home/agent").source,
      ).toBe(join(t.cfg.dataDir, "homes", KEY));
      expect(
        c.mounts.find((m: any) => m.destination === RUNTIME_TMPDIR).source,
      ).toBe(join(t.cfg.dataDir, "tmp", KEY));
    }
    // agent-run made the working directory, as the person.
    expect(
      existsSync(join(t.cfg.dataDir, "homes", KEY, "projects/chats")),
    ).toBe(true);
  });

  test("the gateway's environment never reaches a sandbox, nor crun", async () => {
    const t = setup();
    process.env.TANDEM_TEST_SECRET = "gateway-only-secret";
    try {
      const child = await t.rt.spawn(KEY, ["env"], {
        env: { ANTHROPIC_API_KEY: "sk-test" },
      });
      const { out } = await collect(child);
      const env = Object.fromEntries(
        out
          .trim()
          .split("\n")
          .map((l) => l.split(/=(.*)/s).slice(0, 2)),
      );
      expect(out).not.toContain("gateway-only-secret");
      expect(env).toEqual({
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        HOME: "/home/agent",
        TMPDIR: RUNTIME_TMPDIR,
        HTTPS_PROXY: "http://127.0.0.1:4750",
        HTTP_PROXY: "http://127.0.0.1:4750",
        https_proxy: "http://127.0.0.1:4750",
        http_proxy: "http://127.0.0.1:4750",
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
        ANTHROPIC_API_KEY: "sk-test",
        // The stand-in's own runtime adds these to every Bun child.
        ...Object.fromEntries(
          Object.entries(env).filter(([k]) => /^(PWD|SHLVL|_)$/.test(k)),
        ),
      });
      // crun itself gets PATH only (the stand-in adds its own state variable).
      for (const c of t.calls())
        expect(
          c.env.filter(
            (k) => !["FAKE_CRUN_STATE", "PWD", "SHLVL", "_"].includes(k),
          ),
        ).toEqual(["PATH"]);
    } finally {
      delete process.env.TANDEM_TEST_SECRET;
    }
  });

  test("the MCP socket is mounted for a spawned program when the gateway listens on it, never for exec", async () => {
    const t = setup();
    const sock = t.rt.mcpSocket(KEY);
    mkdirSync(join(sock, ".."), { recursive: true });
    writeFileSync(sock, ""); // stands in for the gateway's listening socket
    await collect(await t.rt.spawn(KEY, ["true"], { label: "codex" }));
    await t.rt.exec(KEY, ["true"]);
    const mcp = (id: string) =>
      t
        .configOf(id)
        .mounts.find((m: any) => m.destination === SANDBOX_MCP_SOCKET);
    expect(mcp(idOf(t, "codex"))?.source).toBe(sock);
    expect(mcp(idOf(t, "exec"))).toBeUndefined();
  });

  test("invalid keys, labels, variables and working directories are refused", async () => {
    const t = setup();
    for (const [key, args, opts, message] of [
      ["../x", ["true"], {}, "invalid runtime key"],
      [KEY, [], {}, "invalid sandbox command"],
      [KEY, ["true"], { label: "Bad Label" }, "invalid sandbox label"],
      [KEY, ["true"], { env: { "A=B": "x" } }, "invalid environment variable"],
      [KEY, ["true"], { cwd: "relative" }, "absolute path"],
    ] as const)
      expect(t.rt.spawn(key, [...args], opts as any)).rejects.toThrow(message);
    expect(() => t.rt.homeOf("../../etc")).toThrow("invalid runtime key");
    expect(t.rt.homeOf(KEY)).toBe(join(t.cfg.dataDir, "homes", KEY));
  });
});

describe("stopping", () => {
  // Ignores SIGTERM, so only the KILL after the grace period ends it.
  const STUBBORN = [
    process.execPath,
    "-e",
    "process.on('SIGTERM',()=>{});console.log('up');setInterval(()=>{},1000)",
  ];
  const started = (child: ChildProcess) =>
    new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));

  test("kill(): TERM, then KILL after the grace; exit and exitCode once the sandbox is gone", async () => {
    const t = setup();
    const child = await t.rt.spawn(KEY, STUBBORN, { label: "stubborn" });
    await started(child);
    const id = idOf(t, "stubborn");
    let goneAtExit = null as boolean | null;
    const exited = new Promise<number | null>((resolve) =>
      child.once("exit", (code) => {
        goneAtExit =
          !t.running().includes(`${id}.json`) &&
          !existsSync(join(t.cfg.dataDir, "bundles", id)) &&
          t.calls().some((c) => c.args[0] === "delete" && c.args.at(-1) === id);
        resolve(code);
      }),
    );
    const t0 = Date.now();
    expect(child.kill()).toBe(true);
    expect(child.killed).toBe(true);
    expect(child.exitCode).toBeNull();
    const code = await exited;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    expect(code).toBe(137);
    expect(child.exitCode).toBe(137);
    expect(goneAtExit).toBe(true);
    const kills = t
      .calls()
      .filter((c) => c.args[0] === "kill")
      .map((c) => c.args.slice(1));
    expect(kills).toEqual([
      [id, "TERM"],
      [id, "KILL"],
    ]);
    // Gone: killing again does nothing.
    expect(child.kill()).toBe(false);
  });

  test("kill('SIGKILL') does not wait; a program that honours TERM ends at once", async () => {
    const t = setup();
    const a = await t.rt.spawn(KEY, STUBBORN, { label: "a" });
    await started(a);
    const t0 = Date.now();
    a.kill("SIGKILL");
    await collect(a);
    expect(Date.now() - t0).toBeLessThan(300);
    const b = await t.rt.spawn(KEY, ["sleep", "30"], { label: "b" });
    b.kill("SIGTERM");
    expect((await collect(b)).code).toBe(143);
  });

  test("stopAll ends every sandbox of the person, also ones it did not start, and leaves no cgroup", async () => {
    const t = setup({ cgroups: true });
    const a = await t.rt.spawn(KEY, STUBBORN, { label: "a" });
    const b = await t.rt.spawn(KEY, ["sleep", "30"], { label: "b" });
    const other = await t.rt.spawn(OTHER, ["sleep", "30"], { label: "c" });
    await started(a);
    // A sandbox of the person that another process (src/cli.ts) started.
    writeFileSync(
      join(t.state, "boxes", `tandem-${KEY}-exec-1-1.json`),
      JSON.stringify({ status: "running" }),
    );
    const ends = Promise.all([collect(a), collect(b)]);
    await t.rt.stopAll(KEY);
    await ends;
    const left = (await t.rt.list()).map((s) => s.id);
    expect(left.filter((id) => id.includes(KEY))).toEqual([]);
    expect(left.filter((id) => id.includes(OTHER))).toHaveLength(1);
    expect(existsSync(join(t.cgroupRoot, "sandboxes", `tandem-${KEY}`))).toBe(
      false,
    );
    expect(existsSync(join(t.cgroupRoot, "sandboxes", `tandem-${OTHER}`))).toBe(
      true,
    );
    expect(existsSync(join(t.cfg.dataDir, "tmp", KEY))).toBe(false);
    const done = collect(other);
    await t.rt.stopEverything();
    await done;
    expect(await t.rt.list()).toEqual([]);
    expect(readdirSync(join(t.cgroupRoot, "sandboxes"))).toEqual([]);
    // Shut down: nothing new starts.
    expect(t.rt.spawn(KEY, ["true"])).rejects.toThrow("shutting down");
  });
});

describe("the person's cgroup and temporary directory", () => {
  test("their limits on the person's cgroup; each sandbox a child of it; gone with the last", async () => {
    const t = setup({
      cgroups: true,
      vars: { RUNTIME_MEMORY_MB: "768", RUNTIME_PIDS: "300" },
    });
    expect((await t.rt.posture()).limits).toBe(true);
    const a = await t.rt.spawn(KEY, ["sleep", "30"], { label: "a" });
    const b = await t.rt.spawn(KEY, ["sleep", "30"], { label: "b" });
    const person = join(t.cgroupRoot, "sandboxes", `tandem-${KEY}`);
    const read = (f: string) => readFileSync(join(person, f), "utf8");
    expect([
      read("memory.max"),
      read("memory.high"),
      read("pids.max"),
      read("cpu.weight"),
    ]).toEqual([String(768 * 2 ** 20), String(614 * 2 ** 20), "300", "100"]);
    expect(read("cgroup.subtree_control")).toBe("+memory +pids +cpu");
    for (const label of ["a", "b"]) {
      const c = await specSoon(t, label);
      expect(c.linux.cgroupsPath).toMatch(
        new RegExp(`^/sandboxes/tandem-${KEY}/${label}-${process.pid}-\\d+$`),
      );
      expect(c.linux.resources).toEqual({
        unified: { "memory.oom.group": "1" },
      });
    }
    // crun creates and deletes each sandbox's own cgroup; it is told to manage cgroups.
    expect(
      t
        .calls()
        .filter((c) => c.args[0] === "run")
        .map((c) => c.manager),
    ).toEqual(
      [
        "--cgroup-manager=cgroupfs",
        "--cgroup-manager=cgroupfs",
        "--cgroup-manager=cgroupfs", // the setup probe
      ].slice(0, 3),
    );
    const ea = collect(a);
    a.kill("SIGKILL");
    await ea;
    expect(existsSync(person)).toBe(true); // b still runs
    const eb = collect(b);
    b.kill("SIGKILL");
    await eb;
    expect(existsSync(person)).toBe(false);
  });

  test("without delegated cgroups the gateway says so; sandboxes have no cgroup, crun leaves cgroups alone", async () => {
    const t = setup();
    const posture = await t.rt.posture();
    expect(posture.limits).toBe(false);
    expect(posture.warnings[0]).toContain(
      "no per-person memory and process limits",
    );
    await collect(await t.rt.spawn(KEY, ["true"], { label: "x" }));
    expect(t.configOf(idOf(t, "x")).linux.cgroupsPath).toBeUndefined();
    expect(new Set(t.calls().map((c) => c.manager))).toEqual(
      new Set(["--cgroup-manager=disabled"]),
    );
    expect(readdirSync(t.cgroupRoot + "/sandboxes")).toEqual([]);
  });

  test("the temporary directory is shared while any sandbox runs and removed after the last", async () => {
    const t = setup();
    const tmp = join(t.cfg.dataDir, "tmp", KEY);
    const a = await t.rt.spawn(KEY, ["sleep", "30"], { label: "a" });
    writeFileSync(join(tmp, "unpacked"), "x");
    const b = await t.rt.spawn(KEY, ["sleep", "30"], { label: "b" });
    // A one-shot command meanwhile neither empties nor removes it.
    await t.rt.exec(KEY, ["true"]);
    expect(existsSync(join(tmp, "unpacked"))).toBe(true);
    const ea = collect(a);
    a.kill("SIGKILL");
    await ea;
    expect(existsSync(join(tmp, "unpacked"))).toBe(true);
    const eb = collect(b);
    b.kill("SIGKILL");
    await eb;
    expect(existsSync(tmp)).toBe(false);
  });
});

describe("setup", () => {
  test("what an earlier gateway run left is removed: sandboxes, cgroups, bundles, temporary files", async () => {
    const t = setup({ cgroups: true });
    const left = `tandem-${KEY}-claude-1-1`;
    mkdirSync(join(t.state, "boxes"), { recursive: true });
    writeFileSync(
      join(t.state, "boxes", `${left}.json`),
      JSON.stringify({ status: "running" }),
    );
    writeFileSync(
      join(t.state, "boxes", "other-thing.json"),
      JSON.stringify({ status: "running" }),
    );
    mkdirSync(join(t.cgroupRoot, "sandboxes", `tandem-${KEY}`, "claude-1-1"), {
      recursive: true,
    });
    writeFileSync(
      join(t.cgroupRoot, "sandboxes", `tandem-${KEY}`, "memory.max"),
      "1",
    );
    mkdirSync(join(t.cgroupRoot, "sandboxes", "other-x"));
    mkdirSync(join(t.cfg.dataDir, "bundles", left), { recursive: true });
    mkdirSync(join(t.cfg.dataDir, "tmp", KEY), { recursive: true });
    await t.rt.posture();
    expect(t.running()).toEqual(["other-thing.json"]);
    expect(
      t.calls().some((c) => c.args[0] === "delete" && c.args.at(-1) === left),
    ).toBe(true);
    expect(readdirSync(join(t.cgroupRoot, "sandboxes"))).toEqual(["other-x"]);
    expect(readdirSync(join(t.cfg.dataDir, "bundles"))).toEqual([]);
    expect(readdirSync(join(t.cfg.dataDir, "tmp"))).toEqual([]);
  });

  test("an operator command next to the gateway (sweep: false) leaves its sandboxes alone", async () => {
    const t = setup({ cgroups: true, sweep: false });
    const theirs = `tandem-${KEY}-claude-1-1`;
    mkdirSync(join(t.state, "boxes"), { recursive: true });
    writeFileSync(
      join(t.state, "boxes", `${theirs}.json`),
      JSON.stringify({ status: "running" }),
    );
    mkdirSync(join(t.cgroupRoot, "sandboxes", `tandem-${KEY}`, "claude-1-1"), {
      recursive: true,
    });
    const r = await t.rt.exec(KEY, [
      "sh",
      "-c",
      "echo out; echo err >&2; exit 3",
    ]);
    expect(r).toEqual({ exitCode: 3, stdout: "out\n", stderr: "err\n" });
    // Its sandbox is untouched. (Its cgroup, in use, is too: cgroupfs refuses to remove a busy
    // cgroup, which a plain directory cannot show; scripts/sandbox-check.ts checks it.)
    expect(t.running()).toEqual([`${theirs}.json`]);
    expect((await t.rt.list()).map((s) => s.key)).toEqual([KEY]);
  });

  test("a container that cannot create sandboxes stops the gateway with what it needs", async () => {
    const t = setup();
    writeFileSync(
      join(t.dataDir, "..", "crun.sh"),
      "#!/bin/sh\necho 'mount: Permission denied' >&2\nexit 1\n",
      {
        mode: 0o755,
      },
    );
    expect(t.rt.posture()).rejects.toThrow(
      /SYS_ADMIN and NET_ADMIN.*apparmor=unconfined/,
    );
  });
});

describe("one-shot commands and private files", () => {
  test("exec: output, errors and exit code back; standard input in", async () => {
    const t = setup();
    expect(
      await t.rt.exec(KEY, ["cat"], { stdin: Buffer.from("hello") }),
    ).toEqual({
      exitCode: 0,
      stdout: "hello",
      stderr: "",
    });
  });

  test("private files go in through standard input, never in a command line", async () => {
    const t = setup();
    await t.rt.writePrivateFile(
      KEY,
      "/home/agent/.agent-runtime",
      "anthropic-api-key",
      "sk-secret\n",
    );
    expect(
      readFileSync(
        join(t.cfg.dataDir, "homes", KEY, ".agent-runtime/anthropic-api-key"),
        "utf8",
      ),
    ).toBe("sk-secret\n");
    expect(JSON.stringify(t.calls())).not.toContain("sk-secret");
    const id = t
      .calls()
      .filter((c) => c.args[0] === "run")
      .at(-1)!
      .args.at(-1)!;
    expect(JSON.stringify(t.configOf(id))).not.toContain("sk-secret");
    expect(t.rt.writePrivateFile(KEY, "/etc", "passwd", "x")).rejects.toThrow(
      "outside",
    );
    expect(
      t.rt.writePrivateFile(KEY, "/home/agent", "../x", "x"),
    ).rejects.toThrow("outside");
  });

  test("every person gets their own uid, kept across gateway restarts", async () => {
    expect(nextUid([])).toBe(FIRST_UID);
    expect(nextUid([FIRST_UID, FIRST_UID + 2])).toBe(FIRST_UID + 1);
    const t = setup();
    rmSync(join(t.cfg.dataDir, "uids.json"));
    const uidOf = (r: SandboxRuntime, k: string) =>
      (r as any).uidOf(k) as Promise<number>;
    const a = await uidOf(t.rt, "a".repeat(24));
    const b = await uidOf(t.rt, "b".repeat(24));
    expect(a).not.toBe(b);
    const again = new SandboxRuntime(t.cfg, { log: () => {} });
    expect(await uidOf(again, "b".repeat(24))).toBe(b);
    expect(
      JSON.parse(readFileSync(join(t.cfg.dataDir, "uids.json"), "utf8")),
    ).toEqual({
      ["a".repeat(24)]: a,
      ["b".repeat(24)]: b,
    });
  });
});
