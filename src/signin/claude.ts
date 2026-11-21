// Claude's own sign-in: `claude auth login --claudeai` in the person's sandbox, as Happy ran it.
// It prints a page to open; that page shows a code the person pastes, which goes to the CLI's
// standard input. The CLI saves the sign-in in ~/.claude/.credentials.json.
import type { ChildProcess } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_EXECUTABLE, CREDENTIALS_FILE } from "../agents/claude";
import {
  HOME,
  type Sandboxes,
  type SignIn,
  type SignInStatus,
} from "../agents/types";

/** How long a sign-in waits for its code when the CLI does not say. */
const EXPIRES_MS = 15 * 60_000;
/** How long the CLI may take to print its page. */
const START_MS = 30_000;
/** How long a pasted code may take to be decided. */
const CODE_MS = 30_000;
const URL = /(https:\/\/\S+\/oauth\/authorize\?\S+)/;

/**
 * Claude Code's own words for a code it did not take. "Invalid code" is its local format check and
 * it keeps waiting ("retry"); a code the server refused ends the attempt ("restart").
 */
export function codeRejection(lines: string[]): "retry" | "restart" | null {
  if (
    lines.some((l) => /wasn't accepted|was not accepted|invalid_grant/i.test(l))
  )
    return "restart";
  if (lines.some((l) => /invalid code/i.test(l))) return "retry";
  return null;
}

/** The page to open, once the CLI printed it. */
export function signInUrl(lines: string[]) {
  for (const l of lines) {
    const m = URL.exec(l);
    if (m) return m[1]!;
  }
  return null;
}

/** When the CLI says how long its sign-in lasts ("expires in 10 minutes"), else null. */
export function cliExpiry(lines: string[], now: number): number | null {
  for (const l of lines) {
    const m = /expires? in (\d+) (second|minute)s?/i.exec(l);
    if (m)
      return (
        now + Number(m[1]) * (m[2]!.toLowerCase() === "second" ? 1000 : 60_000)
      );
  }
  return null;
}

/** Splits a CLI's output into lines; a prompt that waits without a newline counts as one. */
export function lineReader(push: (line: string) => void) {
  let partial = "";
  return (chunk: Buffer | string) => {
    partial += chunk.toString();
    const parts = partial.split(/\r?\n/);
    partial = parts.pop()!;
    if (/[>:?]\s*$/.test(partial)) {
      parts.push(partial);
      partial = "";
    }
    for (const l of parts) if (l.trim()) push(l.trim());
  };
}

type Attempt = {
  child: ChildProcess;
  lines: string[];
  status: SignInStatus;
  onChange(s: SignInStatus): void;
  /** Ended by us (cancel, expiry, a replacement): its exit changes nothing. */
  stopped: boolean;
  /** A pasted code is being decided: submitCode reads the outcome, including the exit. */
  deciding: boolean;
  /** The CLI's exit code once it ended (null: killed or never ran). */
  exitCode: number | null | undefined;
  exit: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
  /** Wakes whoever waits for the next line or the exit. */
  wake: Set<() => void>;
};

export class ClaudeSignIn implements SignIn {
  readonly provider = "claude" as const;
  readonly flow = "paste_code" as const;
  readonly #sandboxes: Sandboxes;
  readonly #executable: string;
  readonly #expiresMs: number;
  readonly #attempts = new Map<string, Attempt>();

  constructor(opts: {
    sandboxes: Sandboxes;
    /** Claude Code inside the sandbox (default /usr/local/bin/claude). */
    executable?: string;
    expiresMs?: number;
  }) {
    this.#sandboxes = opts.sandboxes;
    this.#executable = opts.executable ?? CLAUDE_EXECUTABLE;
    this.#expiresMs = opts.expiresMs ?? EXPIRES_MS;
  }

  signedIn(key: string) {
    try {
      lstatSync(join(this.#sandboxes.homeOf(key), CREDENTIALS_FILE));
      return true;
    } catch {
      return false;
    }
  }

  async start(
    key: string,
    onChange: (s: SignInStatus) => void,
  ): Promise<SignInStatus> {
    await this.#stop(key);
    return this.#launch(key, onChange, null);
  }

  async submitCode(key: string, code: string): Promise<SignInStatus> {
    const a = this.#attempts.get(key);
    if (!a || a.status.state !== "waiting")
      return a?.status ?? { state: "failed", reason: "sign_in_failed" };
    const mark = a.lines.length;
    a.deciding = true;
    try {
      // The code goes only to the CLI's standard input: never logged or kept.
      a.child.stdin?.write(`${code.trim()}\n`);
      for (const until = Date.now() + CODE_MS; Date.now() < until;) {
        if (this.#attempts.get(key) !== a || a.status.state !== "waiting")
          return this.#attempts.get(key)?.status ?? a.status;
        const rejected = codeRejection(a.lines.slice(mark));
        if (rejected === "restart") {
          // Claude ended this attempt for good; a fresh one gives a new page and a new code.
          await Promise.race([a.exit, Bun.sleep(10_000)]);
          await this.#stop(key);
          return this.#launch(key, a.onChange, "wrong_code_reissued");
        }
        if (rejected === "retry" && a.exitCode === undefined) {
          this.#set(a, { ...a.status, codeError: "wrong_code" });
          return a.status;
        }
        if (a.exitCode !== undefined) {
          // It ended without saying why (a network failure, a crash): the person starts again.
          this.#attempts.delete(key);
          this.#set(a, { state: "failed", reason: "sign_in_failed" });
          return a.status;
        }
        await this.#next(a, until - Date.now());
      }
      return a.status;
    } finally {
      a.deciding = false;
    }
  }

  async cancel(key: string) {
    const a = this.#attempts.get(key);
    await this.#stop(key);
    if (a && (a.status.state === "waiting" || a.status.state === "starting"))
      this.#set(a, { state: "cancelled" });
  }

  async signOut(key: string) {
    await this.cancel(key);
    // Claude's own sign-out, then no sign-in file is left (nor a key from before keys left homes).
    const claude = `'${this.#executable.replace(/'/g, `'\\''`)}'`;
    await this.#sandboxes.exec(key, [
      "sh",
      "-c",
      `${claude} auth logout >/dev/null 2>&1; rm -f "$HOME/${CREDENTIALS_FILE}" "$HOME/.agent-runtime/anthropic-api-key"`,
    ]);
  }

  // ---------------------------------------------------------------------------------------------

  /** Ends the person's attempt quietly (no status: the caller says what happened). */
  async #stop(key: string) {
    const a = this.#attempts.get(key);
    if (!a) return;
    this.#attempts.delete(key);
    a.stopped = true;
    if (a.timer) clearTimeout(a.timer);
    a.child.kill("SIGTERM");
    await Promise.race([a.exit, Bun.sleep(10_000)]);
  }

  /** Starts the CLI; resolves once its page is known or it ended. */
  async #launch(
    key: string,
    onChange: (s: SignInStatus) => void,
    codeError: "wrong_code_reissued" | null,
  ): Promise<SignInStatus> {
    const unavailable: SignInStatus = {
      state: "failed",
      reason: "unavailable",
    };
    let child: ChildProcess;
    try {
      child = await this.#sandboxes.spawn(
        key,
        [this.#executable, "auth", "login", "--claudeai"],
        { cwd: HOME, label: "claude-signin" },
      );
    } catch {
      onChange(unavailable);
      return unavailable;
    }
    let exited!: () => void;
    const a: Attempt = {
      child,
      lines: [],
      status: { state: "starting" },
      onChange,
      stopped: false,
      deciding: false,
      exitCode: undefined,
      exit: new Promise((r) => (exited = r)),
      timer: null,
      wake: new Set(),
    };
    this.#attempts.set(key, a);
    child.stdin?.on("error", () => {}); // kept open: the code comes later
    const read = lineReader((l) => a.lines.push(l));
    const onData = (d: Buffer) => {
      read(d);
      this.#onOutput(key, a, codeError);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const onExit = (code: number | null) => {
      if (a.exitCode !== undefined) return;
      a.exitCode = code;
      exited();
      this.#onExit(key, a);
    };
    child.once("exit", (code) => onExit(code));
    child.once("error", () => onExit(null));
    for (
      const until = Date.now() + START_MS;
      a.status.state === "starting" && Date.now() < until;
    )
      await this.#next(a, until - Date.now());
    if (a.status.state === "starting") {
      // A CLI that prints no page cannot sign anyone in.
      await this.#stop(key);
      this.#set(a, unavailable);
    }
    return a.status;
  }

  #onOutput(key: string, a: Attempt, codeError: "wrong_code_reissued" | null) {
    const url = a.status.state === "starting" ? signInUrl(a.lines) : null;
    if (url) {
      const expiresAt =
        cliExpiry(a.lines, Date.now()) ?? Date.now() + this.#expiresMs;
      a.timer = setTimeout(
        () => {
          if (this.#attempts.get(key) !== a || a.status.state !== "waiting")
            return;
          void this.#stop(key);
          this.#set(a, { state: "failed", reason: "expired" });
        },
        Math.max(0, expiresAt - Date.now()),
      );
      this.#set(a, {
        state: "waiting",
        url,
        userCode: null,
        expiresAt,
        codeError,
      });
    }
    for (const w of a.wake) w();
  }

  #onExit(key: string, a: Attempt) {
    if (a.timer) clearTimeout(a.timer);
    const current = this.#attempts.get(key) === a;
    if (current && a.exitCode === 0 && this.signedIn(key)) {
      this.#attempts.delete(key);
      this.#set(a, { state: "succeeded" });
    } else if (current && !a.stopped && !a.deciding) {
      // Ended on its own while nobody's code was being decided.
      this.#attempts.delete(key);
      const missing =
        a.status.state === "starting" &&
        (a.exitCode === 127 || a.exitCode === null);
      this.#set(a, {
        state: "failed",
        reason: missing ? "unavailable" : "sign_in_failed",
      });
    }
    for (const w of a.wake) w();
  }

  #set(a: Attempt, s: SignInStatus) {
    a.status = s;
    if (s.state !== "starting") a.onChange(s);
  }

  /** Waits for the CLI's next line or its exit, at most `ms` (and at most a second). */
  #next(a: Attempt, ms: number) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        a.wake.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(1, Math.min(ms, 1000)));
      a.wake.add(done);
    });
  }
}
