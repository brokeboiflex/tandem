// Claude's paste-code sign-in against a fake `claude` that prints Claude Code's own lines.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ClaudeSignIn, cliExpiry, codeRejection, lineReader, signInUrl } from "../src/signin/claude";
import type { SignInStatus } from "../src/agents/types";
import { directSandboxes } from "./direct-sandboxes";

const FAKE = join(import.meta.dir, "fixtures", "fake-claude-login.sh");
const sandboxes = directSandboxes();
afterAll(() => sandboxes.cleanup());
let n = 0;
const setup = (o: { expiresMs?: number; executable?: string } = {}) => {
  const key = `s${++n}`;
  const changes: SignInStatus[] = [];
  const signIn = new ClaudeSignIn({ sandboxes, executable: o.executable ?? FAKE, expiresMs: o.expiresMs });
  return { key, changes, signIn, onChange: (s: SignInStatus) => void changes.push(s) };
};

describe("Claude Code's words", () => {
  // Real output lines, URL query redacted.
  const opening = [
    "Opening browser to sign in…",
    "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?<redacted>",
  ];
  const invalid = "Invalid code. Please make sure the full code was copied.";
  // Claude Code 2.1.330 (the pinned one), after its prompt on the same line.
  const incomplete =
    "Paste code here if prompted > That doesn't look like the full code. Copy all of it, including the # in the middle.";
  const verification =
    "That looks like a verification code. Enter it in your browser, on the page that asks for it. If a page then shows a longer code, paste it here.";
  const refused =
    "Login failed: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.";

  test("the page comes from the CLI's output", () => {
    expect(signInUrl(opening)).toBe("https://claude.com/cai/oauth/authorize?<redacted>");
    expect(signInUrl(["Opening browser to sign in…"])).toBeNull();
  });

  test("a malformed code is retryable; a refused code ends the attempt; a network error is neither", () => {
    expect(codeRejection([invalid])).toBe("retry");
    expect(codeRejection([incomplete])).toBe("retry");
    expect(codeRejection([verification])).toBe("retry");
    expect(codeRejection(["Couldn't log in: proxy refused the connection"])).toBeNull();
    expect(codeRejection([invalid, refused, "Paste code here if prompted >"])).toBe("restart");
    expect(codeRejection(["Login failed: connect ECONNREFUSED 160.79.104.10:443"])).toBeNull();
    expect(codeRejection(["invalid_grant"])).toBe("restart");
  });

  test("an expiry the CLI states wins over the default", () => {
    expect(cliExpiry(["This code expires in 10 minutes."], 1000)).toBe(1000 + 600_000);
    expect(cliExpiry(["expires in 90 seconds"], 0)).toBe(90_000);
    expect(cliExpiry(opening, 0)).toBeNull();
  });

  test("output is read line by line, and a prompt without a newline is a line", () => {
    const lines: string[] = [];
    const read = lineReader((l) => lines.push(l));
    read("Opening browser");
    read(" to sign in…\nIf the browser didn't open, visit: https://x/oauth/auth");
    read("orize?a=1\r\nPaste code here if prompted > ");
    expect(lines).toEqual([
      "Opening browser to sign in…",
      "If the browser didn't open, visit: https://x/oauth/authorize?a=1",
      "Paste code here if prompted >",
    ]);
  });
});

describe("ClaudeSignIn with a fake claude", () => {
  test("start → waiting with the page; a good code → succeeded and signed in", async () => {
    const { key, changes, signIn, onChange } = setup();
    expect(signIn.signedIn(key)).toBe(false);
    const t0 = Date.now();
    const s = await signIn.start(key, onChange);
    expect(s).toMatchObject({ state: "waiting", url: expect.stringContaining("/oauth/authorize?code=true&state=attempt1"), userCode: null, codeError: null });
    const expiresAt = (s as any).expiresAt as number;
    expect(expiresAt - t0).toBeGreaterThan(14 * 60_000);
    expect(expiresAt - t0).toBeLessThanOrEqual(15 * 60_000 + 1000);
    const args = sandboxes.spawned.at(-1)!.args;
    expect(args).toEqual([FAKE, "auth", "login", "--claudeai"]);
    expect(await signIn.submitCode(key, "goodcode123")).toEqual({ state: "succeeded" });
    expect(signIn.signedIn(key)).toBe(true);
    expect(changes.map((c) => c.state)).toEqual(["waiting", "succeeded"]);
    // The code never reached argv.
    for (const sp of sandboxes.spawned) expect(sp.args.join(" ")).not.toContain("goodcode");
  });

  test("a malformed code: still waiting on the same page with wrong_code, then a good one", async () => {
    const { key, signIn, onChange } = setup();
    const first = await signIn.start(key, onChange);
    const s = await signIn.submitCode(key, "short");
    expect(s).toMatchObject({ state: "waiting", url: (first as any).url, codeError: "wrong_code" });
    expect(await signIn.submitCode(key, "goodcode")).toEqual({ state: "succeeded" });
  });

  test("a code Claude refuses for good: a fresh sign-in with a new page (wrong_code_reissued)", async () => {
    const { key, changes, signIn, onChange } = setup();
    const first = await signIn.start(key, onChange);
    const s = await signIn.submitCode(key, "refusedcode");
    expect(s).toMatchObject({ state: "waiting", codeError: "wrong_code_reissued", url: expect.stringContaining("state=attempt2") });
    expect((s as any).url).not.toBe((first as any).url);
    // No failure flashes in between: the person only sees the new page.
    expect(changes.map((c) => c.state)).toEqual(["waiting", "waiting"]);
    expect(await signIn.submitCode(key, "goodcode")).toEqual({ state: "succeeded" });
  });

  test("a sign-in that ends for another reason → failed sign_in_failed", async () => {
    const { key, signIn, onChange } = setup();
    await signIn.start(key, onChange);
    expect(await signIn.submitCode(key, "crash")).toEqual({ state: "failed", reason: "sign_in_failed" });
    expect(signIn.signedIn(key)).toBe(false);
  });

  test("it expires: the CLI is stopped and the status says so", async () => {
    const { key, changes, signIn, onChange } = setup({ expiresMs: 300 });
    await signIn.start(key, onChange);
    for (const until = Date.now() + 5000; !changes.some((c) => c.state === "failed") && Date.now() < until; ) await Bun.sleep(50);
    expect(changes.at(-1)).toEqual({ state: "failed", reason: "expired" });
    expect(sandboxes.live().length).toBe(0);
    expect((await signIn.submitCode(key, "goodcode")).state).toBe("failed");
  });

  test("cancel stops the CLI and says cancelled", async () => {
    const { key, changes, signIn, onChange } = setup();
    await signIn.start(key, onChange);
    await signIn.cancel(key);
    expect(changes.at(-1)).toEqual({ state: "cancelled" });
    expect(sandboxes.live().length).toBe(0);
  });

  test("no claude program → failed unavailable", async () => {
    const { key, signIn, onChange } = setup({ executable: "/nonexistent/claude" });
    expect(await signIn.start(key, onChange)).toEqual({ state: "failed", reason: "unavailable" });
  });

  test("signOut: Claude's own logout, then no sign-in file is left", async () => {
    const { key, signIn, onChange } = setup();
    await signIn.start(key, onChange);
    await signIn.submitCode(key, "goodcode");
    expect(signIn.signedIn(key)).toBe(true);
    await signIn.signOut(key);
    expect(signIn.signedIn(key)).toBe(false);
    expect(existsSync(join(sandboxes.homeOf(key), ".claude/.credentials.json"))).toBe(false);
  });
});
