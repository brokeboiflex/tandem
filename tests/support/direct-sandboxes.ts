// A `Sandboxes` for tests that runs programs directly (no crun), each person's home a directory of
// its own. Paths under /home/agent in a request are that directory. The environment is built from
// scratch, as a sandbox's is: nothing of the test runner's (or the developer's) leaks in, so a vendor
// CLI only ever sees the temporary home.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  HOME,
  type SandboxSpawnOptions,
  type Sandboxes,
} from "../../src/agents/types";

export type Spawned = {
  key: string;
  args: string[];
  env: Record<string, string>;
  label: string | undefined;
  /** The working directory asked for (inside the sandbox), if any. */
  cwd: string | undefined;
  child: ChildProcess;
};

export class DirectSandboxes implements Sandboxes {
  readonly spawned: Spawned[] = [];

  constructor(
    private root: string,
    /** A program name in `args[0]` → the command that stands in for it (a fake, a real binary). */
    private programs: Record<string, string[]> = {},
    /** Added to every process's environment (a scripted vendor's address, a dead proxy). */
    private env: Record<string, string> = {},
  ) {}

  homeOf(key: string) {
    return join(this.root, key);
  }

  /** A path inside the sandbox, on this machine. */
  path(key: string, p: string) {
    return p === HOME || p.startsWith(`${HOME}/`)
      ? this.homeOf(key) + p.slice(HOME.length)
      : p;
  }

  #env(key: string, extra: Record<string, string> = {}) {
    const home = this.homeOf(key);
    const tmp = join(home, ".tmp");
    mkdirSync(tmp, { recursive: true });
    return {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      TMPDIR: tmp,
      LANG: "C.UTF-8",
      ...this.env,
      ...extra,
    };
  }

  #command(args: string[]) {
    const [program, ...rest] = args;
    const prefix = this.programs[program!] ?? [program!];
    return [prefix[0]!, ...prefix.slice(1), ...rest];
  }

  async spawn(key: string, args: string[], opts: SandboxSpawnOptions = {}) {
    const env = this.#env(key, opts.env);
    const [cmd, ...rest] = this.#command(args);
    // Like runtime/agent-run, which makes the working directory as the person.
    const cwd = this.path(key, opts.cwd ?? HOME);
    mkdirSync(cwd, { recursive: true });
    const child = spawn(cmd!, rest, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Like a sandbox: TERM, then KILL after a grace period.
    const kill = child.kill.bind(child);
    child.kill = (signal?: NodeJS.Signals | number) => {
      const sent = kill(signal ?? "SIGTERM");
      const t = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          kill("SIGKILL");
      }, 3000);
      child.once("exit", () => clearTimeout(t));
      return sent;
    };
    this.spawned.push({ key, args, env, label: opts.label, cwd: opts.cwd, child });
    return child;
  }

  async exec(
    key: string,
    args: string[],
    opts: { env?: Record<string, string>; stdin?: Buffer; cwd?: string } = {},
  ) {
    const [cmd, ...rest] = this.#command(args);
    const p = Bun.spawn([cmd!, ...rest], {
      cwd: this.path(key, opts.cwd ?? HOME),
      env: this.#env(key, opts.env),
      stdin: opts.stdin ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { exitCode, stdout, stderr };
  }
}
