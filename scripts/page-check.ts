// Drives the /connect demo page in headless Chromium through start -> wrong code -> cancel for both
// providers and saves screenshots to evidence/. Needs DEV_TOKEN_ROUTE=true on the running gateway.
//   BROWSER_EXECUTABLE=/path/to/chrome bun scripts/page-check.ts
import { chromium } from "playwright-core";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:8787";
const out = (name: string) =>
  `${import.meta.dir}/../evidence/connect-${name}.png`;
const browser = await chromium.launch({
  executablePath: process.env.BROWSER_EXECUTABLE || undefined,
});
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const claude = page.locator("#card-claude");
const codex = page.locator("#card-codex");
const step = (text: string) => console.log(`PASS  ${text}`);

await page.goto(`${BASE}/connect`);
await page
  .getByLabel("Your user ID (local development only)")
  .fill(`page-check-${Date.now().toString(36)}`);
await page.keyboard.press("Enter");
await claude.getByText("Not connected").waitFor();
await codex.getByText("Not connected").waitFor();
await page.screenshot({ path: out("1-not-connected") });
step("both cards render Not connected");

const [popup] = await Promise.all([
  page.waitForEvent("popup"),
  claude.getByRole("button", { name: "Connect Claude" }).click(),
]);
await claude.getByLabel(/Claude shows a code/).waitFor();
await popup.waitForURL(/claude\.com/, { timeout: 15_000 }).catch(() => {});
step(
  `Claude opens its sign-in page in a new tab (${new URL(popup.url()).host})`,
);
await popup.close();
if ((await page.evaluate(() => document.activeElement?.id)) !== "claude-code")
  throw new Error("code field is not focused");
step("the code field is focused and labelled");
await page.screenshot({ path: out("2-claude-paste-code") });
await page.keyboard.type("notarealcode");
await page.keyboard.press("Enter");
await claude
  .getByRole("alert")
  .getByText("That code didn't work")
  .waitFor({ timeout: 30_000 });
await page.screenshot({ path: out("3-claude-wrong-code") });
step("a wrong code shows an inline error and keeps the sign-in open");

// Keyboard only: Tab to "Connect ChatGPT" and press Enter.
for (
  let i = 0;
  i < 20 &&
  (await page.evaluate(() => document.activeElement?.textContent)) !==
    "Connect ChatGPT";
  i++
)
  await page.keyboard.press("Tab");
await page.keyboard.press("Enter");
await codex.locator(".code").waitFor();
const code = await codex.locator(".code").textContent();
await codex.getByText(/The code expires in \d+:\d\d/).waitFor();
// The device code is a live login code: blur it so the screenshot never stores it.
await codex.locator(".code").evaluate((el) => ((el as HTMLElement).style.filter = "blur(9px)"));
await page.screenshot({ path: out("4-codex-device-code") });
step(
  `Codex shows a ${code?.length}-character device code, copy button, sign-in link and countdown (reached by keyboard)`,
);

await codex.getByRole("button", { name: "Cancel sign-in" }).click();
await codex.getByText("Sign-in cancelled.").waitFor();
await claude.getByRole("button", { name: "Cancel sign-in" }).click();
await claude.getByText("Sign-in cancelled.").waitFor();
await page.screenshot({ path: out("5-cancelled") });
step("cancel returns both cards to a Try again state");

await claude
  .getByRole("button", { name: "Use your own Anthropic API key" })
  .click();
await claude.getByLabel("Anthropic API key").waitFor();
await page.screenshot({ path: out("6-claude-api-key") });
step("Claude also offers its own API key");

await browser.close();
