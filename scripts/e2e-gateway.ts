// The Tandem gateway for the end-to-end run (scripts/e2e.ts): src/gateway.ts's own startup, with
// every agent and sign-in given the test options its proof used, so the real vendor programs in the
// real sandboxes talk to the scripted vendor APIs (scripts/mock-vendor/serve.ts) instead of the
// vendors. Nothing in the production code paths changes: these are the agents' existing options
// (Claude's `env`, Codex's `config`/`env`, the ACP agents' `env`/`urls`, the sign-ins' mock issuers).
// The sandboxes still reach the mock only through the gateway's egress proxy, at E2E_MOCK_HOST, which
// the e2e allowlist (scripts/e2e/egress-allowlist.txt) is the only host of.
//
//   docker compose -f compose.yaml -f scripts/e2e/compose.yaml up   (command: bun scripts/e2e-gateway.ts)
import { join } from "node:path";
import { createGateway } from "../src/gateway";
import { loadConfig } from "../src/config";
import { SandboxRuntime } from "../src/runtime";
import { startEgress } from "../src/egress";
import { Store } from "../src/store";
import { fail } from "../src/agents/failures";
import { ClaudeAgent } from "../src/agents/claude";
import { CodexAgent } from "../src/agents/codex";
import {
  geminiAgent,
  grokAgent,
  openrouterAgent,
} from "../src/agents/acp-vendors";
import { rpcText, type AcpAgent } from "../src/agents/acp";
import { ClaudeSignIn } from "../src/signin/claude";
import { CodexSignIn } from "../src/signin/codex";
import { GrokSignIn } from "../src/signin/grok";
import type { Agent, SignIn } from "../src/agents/types";

const HOST = process.env.E2E_MOCK_HOST || "mock.tandem.test";
const ANTHROPIC = `http://${HOST}:4799`;
const OPENAI = `http://${HOST}:4796`;
const ACP = `http://${HOST}:4795`;

/** Codex on the scripted Responses API, its ChatGPT sign-in issued and refreshed by the mock. */
const CODEX_CONFIG = [
  'model_provider="mock"',
  'model_providers.mock.name="mock"',
  `model_providers.mock.base_url="${OPENAI}/v1"`,
  'model_providers.mock.wire_api="responses"',
  'model_providers.mock.env_key="MOCK_API_KEY"',
  "model_providers.mock.request_max_retries=0",
  "model_providers.mock.stream_max_retries=0",
  `chatgpt_base_url="${OPENAI}/backend-api/"`,
];
const CODEX_ENV = {
  MOCK_API_KEY: "mock-key-not-a-real-key",
  CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${OPENAI}/oauth/token`,
  CODEX_REVOKE_TOKEN_URL_OVERRIDE: `${OPENAI}/oauth/revoke`,
};
/** xAI's sign-in issuer and Grok's own API (cli-chat-proxy) at the mock. */
const GROK_ENV = {
  GROK_OAUTH2_ISSUER: `${ACP}/auth`,
  GROK_OAUTH2_CLIENT_ID: "mock-client",
  GROK_CLI_CHAT_PROXY_BASE_URL: ACP,
};

const cfg = loadConfig();
const runtime = new SandboxRuntime(cfg);
const posture = await startEgress(cfg, runtime.egressSocket())
  .then(() => runtime.posture())
  .catch((e) => {
    console.error(`startup failed: ${(e as Error).message}`);
    process.exit(1);
  });
console.log(
  `security: sandbox=${posture.sandbox} egress=${posture.egress} ` +
    `limits=${posture.limits ? `${cfg.runtimeMemoryMb}MiB/${cfg.runtimePids}pids per person` : "none"} ` +
    `data=${cfg.dataDir} (e2e: vendors at ${HOST})`,
);
for (const w of posture.warnings) console.warn(`WARNING: ${w}`);
const store = new Store(join(cfg.dataDir, "tandem.db"));
const interrupted = store.failInterruptedRuns(fail.failed(), Date.now());
if (interrupted)
  console.log(`${interrupted} run(s) ended with the previous gateway process`);

const apiKeys = { get: (key: string, p: any) => store.apiKey(key, p) };
/** An ACP agent whose JSON-RPC errors are logged before Tandem classifies them (the run's diagnosis). */
const logged = (agent: AcpAgent) => {
  const own = agent.vendor.failure;
  agent.vendor.failure = (e, model) => {
    console.log(
      `acp_error ${agent.vendor.provider} ${e.code} ${rpcText(e).replace(/\s+/g, " ").slice(0, 300)}`,
    );
    return own?.(e, model) ?? null;
  };
  // The failure text an agent streams instead of answering (AcpVendor.errorText), held back too.
  const classify = agent.vendor.classify;
  agent.vendor.classify = (text, model) => {
    console.log(
      `acp_error_text ${agent.vendor.provider} ${text.replace(/\s+/g, " ").slice(0, 300)}`,
    );
    return classify?.(text, model) ?? null;
  };
  return agent;
};
const acp = { sandboxes: runtime, apiKeys, idleMs: cfg.idleMs };
const gateway = createGateway(cfg, {
  runtime,
  store,
  // standardAgents (src/gateway.ts), in its order, with the mock's addresses.
  agents: [
    new ClaudeAgent({
      sandboxes: runtime,
      apiKeys,
      idleMs: cfg.idleMs,
      env: { ANTHROPIC_BASE_URL: ANTHROPIC },
    }),
    new CodexAgent(runtime, {
      idleMs: cfg.idleMs,
      log: (l: string) => console.log(l),
      config: CODEX_CONFIG,
      env: CODEX_ENV,
    }),
    logged(
      geminiAgent({
        ...acp,
        env: { GOOGLE_GEMINI_BASE_URL: ACP },
        urls: { gemini: ACP },
      }),
    ),
    logged(grokAgent({ ...acp, env: GROK_ENV })),
    logged(
      openrouterAgent({
        ...acp,
        env: { OPENROUTER_HOST: ACP },
        urls: { openrouter: ACP },
      }),
    ),
  ] as Agent[],
  signIns: [
    // Claude's sign-in has no issuer to point elsewhere: its page and code checks run as in
    // production, and the egress allowlist keeps it from reaching Anthropic.
    new ClaudeSignIn({ sandboxes: runtime }),
    new CodexSignIn(runtime, {
      args: ["--experimental_issuer", OPENAI],
      env: CODEX_ENV,
    }),
    new GrokSignIn({ sandboxes: runtime, env: GROK_ENV }),
  ] as SignIn[],
});
Bun.serve({
  hostname: cfg.host,
  port: cfg.port,
  fetch: gateway.fetch,
  idleTimeout: 255,
});
console.log(
  `tandem gateway on ${cfg.host}:${cfg.port} (auth ${cfg.authMode}, idle ${cfg.idleMs / 60_000} min, permission mode ${cfg.permissionMode})`,
);
setInterval(() => gateway.idleSweep(), 30_000);
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await gateway.shutdown().catch(() => {});
    await runtime.stopEverything().catch(() => {});
    store.close();
    process.exit(0);
  });
