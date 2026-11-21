// A `Sandboxes` for tests on any machine: each "sandbox" is a plain child process with a temporary
// home of its own (HOME and CLAUDE_CONFIG_DIR inside it), a dead proxy for every non-loopback host
// and nothing from the test runner's environment. Paths under /home/agent map into that home.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOME, type Sandboxes } from "../src/agents/types";

export type DirectSandboxes = Sandboxes & {
  /** Every process started (spawn and exec): its arguments, environment and label. */
  spawned: { key: string; args: string[]; env: Record<string, string>; label?: string }[];
  /** Processes still running. */
  live(): ChildProcess[];
  cleanup(): void;
};

export function directSandboxes(
  opts: { programs?: Record<string, string>; env?: Record<string, string> } = {},
): DirectSandboxes {
  const root = mkdtempSync(join(tmpdir(), "tandem-sbx-"));
  const children = new Set<ChildProcess>();
  const spawned: DirectSandboxes["spawned"] = [];
  const homeOf = (key: string) => {
    const home = join(root, key);
    mkdirSync(join(home, "projects", "chats"), { recursive: true });
    mkdirSync(join(home, "tmp"), { recursive: true });
    return home;
  };
  const inside = (key: string, p: string) =>
    p === HOME || p.startsWith(`${HOME}/`) ? homeOf(key) + p.slice(HOME.length) : p;
  const baseEnv = (key: string): Record<string, string> => ({
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: homeOf(key),
    TMPDIR: join(homeOf(key), "tmp"),
    // Claude Code keeps its sign-in and sessions here instead of the developer's own ~/.claude.
    CLAUDE_CONFIG_DIR: join(homeOf(key), ".claude"),
    // Nothing reaches a real host: every non-loopback request goes to a port that refuses it.
    HTTPS_PROXY: "http://127.0.0.1:9",
    HTTP_PROXY: "http://127.0.0.1:9",
    https_proxy: "http://127.0.0.1:9",
    http_proxy: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
    ...opts.env,
  });
  const program = (args: string[]) => [opts.programs?.[args[0]!] ?? args[0]!, ...args.slice(1)];
  return {
    spawned,
    homeOf,
    live: () => [...children],
    async spawn(key, args, o = {}) {
      const env = { ...baseEnv(key), ...o.env };
      spawned.push({ key, args, env, label: o.label });
      const [cmd, ...rest] = program(args);
      const child = spawn(cmd!, rest, {
        cwd: inside(key, o.cwd ?? HOME),
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.add(child);
      child.once("exit", () => children.delete(child));
      child.once("error", () => children.delete(child));
      return child;
    },
    async exec(key, args, o = {}) {
      spawned.push({ key, args, env: { ...baseEnv(key), ...o.env }, label: "exec" });
      const [cmd, ...rest] = program(args);
      const proc = Bun.spawn([cmd!, ...rest], {
        cwd: inside(key, o.cwd ?? HOME),
        env: { ...baseEnv(key), ...o.env },
        stdin: o.stdin ?? "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(timer);
      return { exitCode, stdout, stderr };
    },
    cleanup() {
      for (const c of children) c.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    },
  };
}
