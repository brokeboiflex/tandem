// Codex's device sign-in against a fake `codex login --device-auth` (tests/support/fake-codex.ts)
// that prints the real CLI's prompt. The integration test runs the real CLI against a scripted
// issuer.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SignInStatus } from "../src/agents/types";
import { CodexSignIn, SIGN_OUT, parseDeviceOutput } from "../src/signin/codex";
import { DirectSandboxes } from "./support/direct-sandboxes";

setDefaultTimeout(20_000);
const root = mkdtempSync(join(tmpdir(), "tandem-codex-signin-"));
const FAKE = join(import.meta.dir, "support/fake-codex.ts");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

const setup = (
  mode: string,
  opts: ConstructorParameters<typeof CodexSignIn>[1] = {},
  env: Record<string, string> = {},
) => {
  const key = `s${++n}`;
  const boxes = new DirectSandboxes(
    root,
    { codex: [process.execPath, FAKE] },
    { FAKE_LOGIN: mode, FAKE_CODEX_LOG: join(root, `${key}.log`), ...env },
  );
  mkdirSync(boxes.homeOf(key), { recursive: true });
  const changes: SignInStatus[] = [];
  const signIn = new CodexSignIn(boxes, opts);
  const next = () =>
    new Promise<SignInStatus>((resolve) => {
      const t = setInterval(() => {
        if (changes.length) {
          clearInterval(t);
          resolve(changes.at(-1)!);
        }
      }, 10);
    });
  return {
    key,
    boxes,
    signIn,
    changes,
    next,
    start: () => signIn.start(key, (s) => changes.push(s)),
  };
};

describe("codex login --device-auth", () => {
  test("parses the CLI's page, code and expiry (colours and all)", () => {
    const out =
      "\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mABCD-EFGH2\x1b[0m\n";
    expect(parseDeviceOutput(out)).toEqual({
      url: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH2",
      expiresInMs: 15 * 60_000,
    });
    expect(
      parseDeviceOutput(
        "1. Open this link\n   https://auth.openai.com/codex/device\n",
      ),
    ).toEqual({
      url: "https://auth.openai.com/codex/device",
      userCode: null,
      expiresInMs: null,
    });
  });

  test("waiting with the page and code, then succeeded once the CLI exits 0 with auth.json", async () => {
    const t0 = Date.now();
    const s = setup("success");
    const first = await s.start();
    expect(first).toEqual({
      state: "waiting",
      url: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH2",
      expiresAt: expect.any(Number),
      codeError: null,
    });
    if (first.state === "waiting")
      expect(first.expiresAt! - t0).toBeGreaterThanOrEqual(15 * 60_000 - 100);
    expect(await s.next()).toEqual({ state: "succeeded" });
    expect(s.signIn.signedIn(s.key)).toBe(true);
    // The CLI ran in the person's sandbox, keeping its sign-in in a file.
    expect(s.boxes.spawned[0]!.args).toEqual([
      "codex",
      "login",
      "--device-auth",
      "-c",
      'cli_auth_credentials_store="file"',
    ]);
    expect(s.boxes.spawned[0]!.label).toBe("codex-login");
  });

  test("a CLI that fails, times out or never shows a page: sign_in_failed, expired, unavailable", async () => {
    const failed = setup("fail");
    expect((await failed.start()).state).toBe("waiting");
    expect(await failed.next()).toEqual({
      state: "failed",
      reason: "sign_in_failed",
    });
    const timedOut = setup("timeout");
    await timedOut.start();
    expect(await timedOut.next()).toEqual({
      state: "failed",
      reason: "expired",
    });
    const unavailable = setup("unavailable");
    expect(await unavailable.start()).toEqual({
      state: "failed",
      reason: "unavailable",
    });
    // Exit 0 without a sign-in file is no sign-in.
    const noFile = setup("nofile");
    await noFile.start();
    expect(await noFile.next()).toEqual({ state: "failed", reason: "sign_in_failed" });
  });

  test("a CLI that hangs past the code's expiry is ended as expired", async () => {
    const s = setup("hang", { graceMs: 200 }, { FAKE_LOGIN_EXPIRES: "0" });
    expect((await s.start()).state).toBe("waiting");
    expect(await s.next()).toEqual({ state: "failed", reason: "expired" });
  });

  test("cancel ends the CLI; a new start replaces a waiting one", async () => {
    const s = setup("hang");
    expect((await s.start()).state).toBe("waiting");
    await s.signIn.cancel(s.key);
    expect(s.changes.at(-1)).toEqual({ state: "cancelled" });
    expect(
      s.boxes.spawned[0]!.child.exitCode !== null ||
        s.boxes.spawned[0]!.child.signalCode !== null,
    ).toBe(true);
    const old: SignInStatus[] = [];
    await s.signIn.start(s.key, (x) => old.push(x));
    const again = await s.signIn.start(s.key, () => {});
    expect(again.state).toBe("waiting");
    expect(old).toEqual([{ state: "cancelled" }]);
    await s.signIn.cancel(s.key);
  });

  test("signedIn is a file check that never follows a link; signOut is the CLI's own logout", async () => {
    const s = setup("success");
    expect(s.signIn.signedIn(s.key)).toBe(false);
    mkdirSync(join(s.boxes.homeOf(s.key), ".codex"), { recursive: true });
    symlinkSync("/etc/hosts", join(s.boxes.homeOf(s.key), ".codex/auth.json"));
    expect(s.signIn.signedIn(s.key)).toBe(false);
    rmSync(join(s.boxes.homeOf(s.key), ".codex/auth.json"));
    writeFileSync(join(s.boxes.homeOf(s.key), ".codex/auth.json"), "{}");
    expect(s.signIn.signedIn(s.key)).toBe(true);
    expect(SIGN_OUT).toEqual([
      "sh",
      "-c",
      `codex logout >/dev/null 2>&1; rm -f "$HOME/.codex/auth.json"`,
    ]);
    await s.signIn.signOut(s.key);
    expect(existsSync(join(s.boxes.homeOf(s.key), ".codex/auth.json"))).toBe(
      false,
    );
  });
});
