// Grok's own device sign-in: `grok login --device-auth` in the person's sandbox, as long as it
// waits. The CLI prints the verification page and the user code (to stderr), polls xAI until the
// person confirms, writes ~/.grok/auth.json and exits 0 (grok-build: xai-grok-login device_code.rs,
// flow.rs; xai-grok-pager-bin main.rs).
import type { ChildProcess } from "node:child_process";
import { GROK_AUTH_FILE, GROK_ENV, hasFile } from "../agents/acp-vendors";
import type { Sandboxes, SignIn, SignInStatus } from "../agents/types";

/** How disconnecting signs out: Grok's own logout, then no sign-in file (or its stray copies) is left. */
export const GROK_SIGN_OUT = [
  "sh",
  "-c",
  `grok logout >/dev/null 2>&1; rm -f "$HOME/.grok/"auth.json*`,
];

export type GrokSignInOptions = {
  sandboxes: Sandboxes;
  /** Tests and proofs only: more environment for the CLI (a mock issuer). */
  env?: Record<string, string>;
  /** How long the CLI may take to show the page (default 30 s). */
  startMs?: number;
  /** The longest a sign-in may wait for the person (default 20 min; xAI's code expires first). */
  maxMs?: number;
};

type Run = {
  child: ChildProcess;
  status: SignInStatus;
  emit: (s: SignInStatus) => void;
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
};

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ENDED = new Set(["succeeded", "failed", "cancelled"]);

/** The page and user code in the CLI's output so far, once both are there. */
export function parseDeviceAuth(
  output: string,
): { url: string; userCode: string } | null {
  const lines = output
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((l) => l.trim());
  let url: string | null = null;
  let userCode: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!url && /^https:\/\/\S+$/.test(line)) url = line;
    if (/enter this code:|confirm this code/i.test(line)) {
      const next = lines.slice(i + 1).find((l) => l.length > 0);
      if (next && /^[A-Z0-9-]{4,32}$/.test(next)) userCode = next;
    }
  }
  // Only a page with its code is a device sign-in (without one the CLI fell back to a browser
  // login on localhost, which cannot work from a sandbox).
  return url && userCode ? { url, userCode } : null;
}

export class GrokSignIn implements SignIn {
  readonly provider = "grok" as const;
  readonly flow = "device_code" as const;
  #runs = new Map<string, Run>();

  constructor(private o: GrokSignInOptions) {}

  signedIn(key: string) {
    return hasFile(this.o.sandboxes, key, GROK_AUTH_FILE);
  }

  async start(
    key: string,
    onChange: (s: SignInStatus) => void,
  ): Promise<SignInStatus> {
    await this.cancel(key);
    const child = await this.o.sandboxes.spawn(
      key,
      ["grok", "login", "--device-auth"],
      { env: { ...GROK_ENV, ...this.o.env }, label: "grok-login" },
    );
    // The first status after `starting` answers start(); every later one goes to onChange.
    let answer: ((s: SignInStatus) => void) | null = null;
    const first = new Promise<SignInStatus>((r) => (answer = r));
    const run: Run = {
      child,
      status: { state: "starting" },
      emit: (s) => {
        const a = answer;
        answer = null;
        if (a) a(s);
        else onChange(s);
      },
      cancelled: false,
      timer: undefined,
    };
    this.#runs.set(key, run);
    // Never showed a page: sign-in cannot be offered right now.
    run.timer = setTimeout(
      () => this.#set(key, run, { state: "failed", reason: "unavailable" }),
      this.o.startMs ?? 30_000,
    );
    let output = "";
    const read = (d: Buffer | string) => {
      output = (output + d).slice(-16_000);
      if (run.status.state !== "starting") return;
      const page = parseDeviceAuth(output);
      if (!page) return;
      clearTimeout(run.timer);
      run.timer = setTimeout(
        () => this.#set(key, run, { state: "failed", reason: "expired" }),
        this.o.maxMs ?? 20 * 60_000,
      );
      this.#set(key, run, {
        state: "waiting",
        url: page.url,
        userCode: page.userCode,
        expiresAt: null,
        codeError: null,
      });
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.stdin?.end();
    child.once("exit", (code) => {
      this.#set(
        key,
        run,
        run.cancelled
          ? { state: "cancelled" }
          : code === 0 && this.signedIn(key)
            ? { state: "succeeded" }
            : {
                state: "failed",
                reason: /expired/i.test(output) ? "expired" : "sign_in_failed",
              },
      );
    });
    child.once("error", () =>
      this.#set(key, run, { state: "failed", reason: "unavailable" }),
    );
    return first;
  }

  async cancel(key: string) {
    const run = this.#runs.get(key);
    if (!run) return;
    run.cancelled = true;
    const gone = new Promise<void>((r) => {
      if (run.child.exitCode !== null || run.child.signalCode !== null) r();
      else run.child.once("exit", () => r());
    });
    this.#set(key, run, { state: "cancelled" });
    await gone;
  }

  async signOut(key: string) {
    await this.cancel(key);
    await this.o.sandboxes.exec(key, GROK_SIGN_OUT, {
      env: { ...GROK_ENV, ...this.o.env },
    });
  }

  #set(key: string, run: Run, status: SignInStatus) {
    if (ENDED.has(run.status.state)) return;
    run.status = status;
    if (ENDED.has(status.state)) {
      clearTimeout(run.timer);
      if (this.#runs.get(key) === run) this.#runs.delete(key);
      if (run.child.exitCode === null && run.child.signalCode === null)
        run.child.kill();
    }
    run.emit(status);
  }
}
