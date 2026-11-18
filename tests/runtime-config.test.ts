// The runtime's own policy (runtime/happy.toml) and what its entrypoint renders from it with and
// without the person's API keys, run with stand-ins for the daemon and its bridge.
import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as H from "../src/happy";

const runtimeDir = new URL("../runtime/", import.meta.url).pathname;
const policyText = await Bun.file(join(runtimeDir, "happy.toml")).text();
const policy = Bun.TOML.parse(policyText) as any;
const entrypoint = await Bun.file(join(runtimeDir, "entrypoint.sh")).text();
const work = mkdtempSync(join(tmpdir(), "tandem-entrypoint-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** Runs the entrypoint in a fresh home holding `files` (relative to it); returns its happy.toml. */
function render(files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(work, "run-"));
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of [
    ["happy-agent", 'env > "$HOME/daemon-env"'],
    ["socat", "exit 0"],
    ["pgrep", "exit 1"],
  ])
    writeFileSync(join(bin, name!), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(home, path, ".."), { recursive: true });
    writeFileSync(join(home, path), content);
  }
  const script = join(dir, "entrypoint.sh");
  writeFileSync(
    script,
    entrypoint.replaceAll(
      "/opt/agent-runtime/happy.toml",
      join(runtimeDir, "happy.toml"),
    ),
  );
  const r = Bun.spawnSync(["sh", script], {
    env: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      TMPDIR: join(home, ".cache/tmp"),
    },
  });
  expect(r.exitCode).toBe(0);
  const text = readFileSync(join(home, "happy/config/happy.toml"), "utf8");
  const env = readFileSync(join(home, "daemon-env"), "utf8");
  return { text, toml: Bun.TOML.parse(text) as any, env };
}

const keyFile = (id: H.ProviderId) => `.agent-runtime/${H.apiKeyOf(id)!.file}`;
const anthropicKey = `sk-ant-api03-${"a".repeat(40)}`;
const openrouterKey = `sk-or-v1-${"b".repeat(64)}`;

describe("runtime/happy.toml policy", () => {
  test("only the person's own accounts, none enabled by default", () => {
    expect(policy.providers.default_enable).toBe(false);
    expect(
      Object.keys(policy.providers).filter((k) => k !== "default_enable"),
    ).toEqual(["claude", "codex", "grok", "openrouter"]);
    for (const id of ["claude", "codex", "grok", "openrouter"])
      expect(policy.providers[id].enabled).toBe(true);
  });

  test("Happy's own loop runs only Grok and OpenRouter; Claude and Codex keep their own agents", () => {
    expect(policy.harnesses).toEqual({
      happy: { providers: ["grok", "openrouter"], subagent_harnesses: [] },
      claude_code: { providers: ["claude"], subagent_harnesses: [] },
      codex_cli: { providers: ["codex"], subagent_harnesses: [] },
    });
    expect(policy.defaults).toEqual({
      provider: "claude",
      model: "claude-code/default",
      permission_mode: "auto",
    });
  });

  test("no Happy sub-agents on Grok or OpenRouter, so neither starts the other's work", () => {
    expect(policy.providers.grok.include_subagent_models).toEqual([]);
    expect(policy.providers.openrouter.include_subagent_models).toEqual([]);
  });

  test("OpenRouter: its API, tool-capable models, and no credential in the shipped file", () => {
    const or = policy.providers.openrouter;
    expect(or).toMatchObject({
      type: "openai_compatible",
      base_url: "https://openrouter.ai/api/v1",
      reasoning_field: "reasoning",
      request: { reasoning: { enabled: true } },
    });
    expect(or.models.length).toBeGreaterThan(0);
    expect(or.api_key).toBeUndefined();
    expect(or.api_key_env).toBeUndefined();
  });
});

describe("runtime entrypoint", () => {
  test("reads each API key from the file the gateway writes", () => {
    for (const id of H.PROVIDER_IDS.filter((p) => H.apiKeyOf(p)))
      expect(entrypoint).toContain(`"$HOME/${keyFile(id)}"`);
  });

  test("without keys: no credential, and an OpenRouter account that names an unset variable", () => {
    const { toml } = render();
    expect(toml.providers.claude.api_key).toBeUndefined();
    expect(toml.providers.claude.name).toBeUndefined();
    expect(toml.providers.openrouter).toMatchObject({
      name: "OpenRouter",
      api_key_env: "OPENROUTER_API_KEY",
    });
    expect(toml.providers.openrouter.api_key).toBeUndefined();
    expect(H.usesApiKey({ providers: toml.providers }, "openrouter")).toBe(false);
    // Everything else is the shipped policy.
    expect(toml.harnesses).toEqual(policy.harnesses);
  });

  test("with keys: each becomes its account's api_key under the name the gateway reads back, never in the daemon's environment", () => {
    const { toml, env } = render({
      [keyFile("claude")]: `${anthropicKey}\n`,
      [keyFile("openrouter")]: `${openrouterKey}\n`,
    });
    expect(toml.providers.claude).toMatchObject({
      name: H.apiKeyOf("claude")!.account,
      api_key: anthropicKey,
    });
    expect(toml.providers.openrouter).toMatchObject({
      name: H.apiKeyOf("openrouter")!.account,
      api_key: openrouterKey,
    });
    expect(toml.providers.openrouter.api_key_env).toBeUndefined();
    expect(H.usesApiKey({ providers: toml.providers }, "openrouter")).toBe(true);
    expect(H.usesApiKey({ providers: toml.providers }, "claude")).toBe(true);
    expect(env).not.toContain(openrouterKey);
    expect(env).not.toContain(anthropicKey);
  });

  test("a key with any other character is ignored instead of breaking the file", () => {
    const { toml, text } = render({
      [keyFile("openrouter")]: 'sk-or-v1-x"\nevil = "y\n',
    });
    expect(text).not.toContain("evil");
    expect(toml.providers.openrouter).toMatchObject({
      name: "OpenRouter",
      api_key_env: "OPENROUTER_API_KEY",
    });
  });
});
