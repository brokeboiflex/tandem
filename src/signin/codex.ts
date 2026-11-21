// Codex's own device sign-in: `codex login --device-auth` in the person's sandbox, as long as it
// waits. It prints a page and a one-time code; the person confirms the code on OpenAI's page and
// the CLI writes ~/.codex/auth.json and exits 0. (The app-server's `account/login/start
// {type:"chatgptDeviceCode"}` does the same inside a running app-server; the CLI needs no
// app-server kept alive for up to 15 minutes and is what people already verified.)
import type { ChildProcess } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { AUTH_FILE } from "../agents/codex";
import type { Sandboxes, SignIn, SignInStatus } from "../agents/types";

/** The CLI's own sign-out, then no credential file is left (as before, Happy's SIGN_OUT.codex). */
export const SIGN_OUT = [
  "sh",
  "-c",
  `codex logout >/dev/null 2>&1; rm -f "$HOME/.codex/auth.json"`,
];

/** The CLI says "expires in 15 minutes" (`device_code_auth.rs`); this is when it does not. */
const DEFAULT_EXPIRY_MS = 15 * 60_000;
/** How long the CLI may take to print its page before Tandem calls sign-in unavailable. */
const START_TIMEOUT_MS = 30_000;

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/** The page, the one-time code and how long it lasts, from what the CLI printed so far. */
export function parseDeviceOutput(raw: string): {
  url: string | null;
  userCode: string | null;
  expiresInMs: number | null;
} {
  const text = strip(raw);
  const url = /(https?:\/\/\S+\/codex\/device\S*)/.exec(text)?.[1] ?? null;
  const userCode =
    /one-time code[^\n]*\n\s*([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)/.exec(
      text,
    )?.[1] ??
    /\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/.exec(text)?.[1] ??
    null;
  const minutes = /expires in (\d{1,3}) minutes?/i.exec(text)?.[1];
  return {
    url,
    userCode,
    expiresInMs: minutes ? Number(minutes) * 60_000 : null,
  };
}

type Attempt = {
  child: ChildProcess;
  status: SignInStatus;
  cancelled: boolean;
  expired: boolean;
  exited: Promise<void>;
};

export type CodexSignInOptions = {
  /** The program inside the sandbox (default `codex`). */
  command?: string;
  /** More arguments after `login --device-auth` (tests: `--experimental_issuer <mock>`). */
  args?: string[];
  /** More environment for the CLI (tests). */
  env?: Record<string, string>;
  now?: () => number;
  /** How long after the code expires the CLI may still finish (default 30 s). */
  graceMs?: number;
};

export class CodexSignIn implements SignIn {
  readonly provider = "codex" as const;
  readonly flow = "device_code" as const;
  #attempts = new Map<string, Attempt>();

  constructor(
    private sandboxes: Sandboxes,
    private opts: CodexSignInOptions = {},
  ) {}

  #now() {
    return this.opts.now?.() ?? Date.now();
  }

  signedIn(key: string) {
    try {
      return lstatSync(join(this.sandboxes.homeOf(key), AUTH_FILE)).isFile();
    } catch {
      return false;
    }
  }

  /** The current attempt's status, or null when none ran since the gateway started. */
  status(key: string): SignInStatus | null {
    return this.#attempts.get(key)?.status ?? null;
  }

  async start(
    key: string,
    onChange: (s: SignInStatus) => void,
  ): Promise<SignInStatus> {
    await this.cancel(key);
    let child: ChildProcess;
    try {
      child = await this.sandboxes.spawn(
        key,
        [
          this.opts.command ?? "codex",
          "login",
          "--device-auth",
          // A container has no keyring: the sign-in is a file in the home.
          "-c",
          'cli_auth_credentials_store="file"',
          ...(this.opts.args ?? []),
        ],
        {
          env: { NO_COLOR: "1", TZ: "UTC", ...this.opts.env },
          label: "codex-login",
        },
      );
    } catch {
      return { state: "failed", reason: "unavailable" };
    }
    child.stdin?.end();
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    const a: Attempt = {
      child,
      status: { state: "starting" },
      cancelled: false,
      expired: false,
      exited,
    };
    this.#attempts.set(key, a);

    return new Promise<SignInStatus>((resolve) => {
      let settled = false;
      const set = (s: SignInStatus) => {
        if (this.#attempts.get(key) !== a) return; // a newer attempt replaced this one
        a.status = s;
        if (!settled) {
          settled = true;
          resolve(s);
        } else onChange(s);
      };
      let out = "";
      let expiry: ReturnType<typeof setTimeout> | undefined;
      const startTimer = setTimeout(() => {
        if (a.status.state === "starting") child.kill("SIGTERM");
      }, START_TIMEOUT_MS);
      const read = (d: Buffer | string) => {
        out = (out + String(d)).slice(-16_000);
        if (a.status.state !== "starting") return;
        const { url, userCode, expiresInMs } = parseDeviceOutput(out);
        if (!url || !userCode) return;
        clearTimeout(startTimer);
        const expiresAt = this.#now() + (expiresInMs ?? DEFAULT_EXPIRY_MS);
        // The CLI gives up after its own 15 minutes; this only ends one that hangs past them.
        expiry = setTimeout(
          () => {
            a.expired = true;
            child.kill("SIGTERM");
          },
          expiresAt - this.#now() + (this.opts.graceMs ?? 30_000),
        );
        set({ state: "waiting", url, userCode, expiresAt, codeError: null });
      };
      child.stdout?.on("data", read);
      child.stderr?.on("data", read);
      const end = (code: number | null) => {
        clearTimeout(startTimer);
        if (expiry) clearTimeout(expiry);
        if (a.cancelled) return set({ state: "cancelled" });
        if (code === 0 && this.signedIn(key))
          return set({ state: "succeeded" });
        if (a.status.state === "starting")
          // No page was shown: the sign-in service could not be reached or refused device codes.
          return set({ state: "failed", reason: "unavailable" });
        const timedOut =
          a.expired ||
          /timed out/i.test(strip(out)) ||
          (a.status.state === "waiting" &&
            a.status.expiresAt !== null &&
            this.#now() > a.status.expiresAt);
        set({
          state: "failed",
          reason: timedOut ? "expired" : "sign_in_failed",
        });
      };
      child.once("exit", (code) => end(code));
      child.once("error", () => end(null));
    });
  }

  async cancel(key: string) {
    const a = this.#attempts.get(key);
    if (!a || !["starting", "waiting"].includes(a.status.state)) return;
    a.cancelled = true;
    a.child.kill("SIGTERM");
    await a.exited;
  }

  async signOut(key: string) {
    await this.cancel(key);
    await this.sandboxes.exec(key, SIGN_OUT);
  }
}
