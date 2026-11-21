// Fakes shared by the façade tests: agents, sign-ins and a runtime that never starts a process.
import { join } from "node:path";
import type { GatewayRuntime } from "../src/gateway";
import type {
  Agent,
  KeyVerdict,
  ProviderId,
  ProviderLive,
  SignIn,
  SignInStatus,
  TurnEnd,
  TurnInput,
  TurnSink,
} from "../src/agents/types";

export const written: {
  key: string;
  dir: string;
  name: string;
  content: string;
}[] = [];
export const execs: string[][] = [];
export function fakeRuntime(dir: string): GatewayRuntime {
  return {
    spawn: () => Promise.reject(new Error("the gateway itself never spawns")),
    exec: async (_key, args) => {
      execs.push(args);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    homeOf: (key) => join(dir, "homes", key),
    mcpSocket: (key) => join(dir, "run", key, "mcp.sock"),
    writePrivateFile: async (key, d, name, content) => {
      written.push({ key, dir: d, name, content });
    },
  };
}

export const MODELS = {
  claude: [
    {
      id: "claude-code/default",
      name: "Sonnet 5.5",
      default: true,
      efforts: ["low", "high"],
      defaultEffort: "high",
      contextLimit: 200_000,
    },
    {
      id: "claude-code/opus",
      name: "Opus 5.5",
      efforts: ["low", "high"],
      defaultEffort: "high",
      contextLimit: 200_000,
    },
  ],
  codex: [
    {
      id: "codex-cli/gpt-6-luna",
      name: "GPT-6-Luna",
      efforts: ["medium"],
      defaultEffort: "medium",
      contextLimit: 400_000,
    },
  ],
  grok: [
    {
      id: "xai/grok-4.7",
      name: "Grok 4.7",
      efforts: [],
      defaultEffort: null,
      contextLimit: 256_000,
    },
  ],
  openrouter: [
    {
      id: "deepseek/deepseek-v4.1-flash-1017",
      name: "DeepSeek",
      efforts: [],
      defaultEffort: null,
      contextLimit: 128_000,
    },
  ],
  gemini: [
    {
      id: "antigravity/gemini-4-carbon",
      name: "Gemini 4 Carbon",
      efforts: ["low", "high"],
      defaultEffort: "high",
      contextLimit: 1_000_000,
    },
  ],
};

export type Script = (
  input: TurnInput,
  sink: TurnSink,
  signal: AbortSignal,
) => Promise<TurnEnd>;
export class FakeAgent implements Agent {
  script: Script = async (_i, sink) => {
    sink.session("vendor-session-1");
    sink.delta("a1", "Hel");
    sink.delta("a1", "lo");
    sink.text("a1", "Hello");
    sink.tool("a1", { id: "t1", name: "Bash", status: "running" });
    sink.tool("a1", { id: "t1", name: "Bash", status: "completed" });
    sink.context({
      usedTokens: 1200,
      limitTokens: 200_000,
      approximate: false,
    });
    sink.usage({ input: 1200, output: 20, cacheRead: 0, cacheWrite: 0 });
    return { status: "completed" };
  };
  inputs: TurnInput[] = [];
  reads: string[] = [];
  released: string[] = [];
  signedIn = true;
  constructor(readonly providers: ProviderId[]) {}
  async read(key: string, provider: ProviderId): Promise<ProviderLive> {
    this.reads.push(`${key}:${provider}`);
    return {
      signedIn: this.signedIn,
      account: { email: "person@example.com", plan: "pro" },
      models: MODELS[provider],
    };
  }
  turn(_key: string, input: TurnInput, sink: TurnSink, signal: AbortSignal) {
    this.inputs.push(input);
    return this.script(input, sink, signal);
  }
  busy() {
    return false;
  }
  async release(key: string) {
    this.released.push(key);
  }
  async verifyApiKey(
    _key: string,
    _p: ProviderId,
    apiKey: string,
  ): Promise<KeyVerdict> {
    return apiKey.startsWith("good") ? "ok" : "refused";
  }
}

export class FakeSignIn implements SignIn {
  signed = new Set<string>();
  changes = new Map<string, (s: SignInStatus) => void>();
  signedOut: string[] = [];
  constructor(
    readonly provider: ProviderId,
    readonly flow: "paste_code" | "device_code",
  ) {}
  async start(
    key: string,
    onChange: (s: SignInStatus) => void,
  ): Promise<SignInStatus> {
    this.changes.set(key, onChange);
    return {
      state: "waiting",
      url: `https://${this.provider}.example/signin`,
      userCode: this.flow === "device_code" ? "ABCD-1234" : null,
      expiresAt: Date.now() + 600_000,
      codeError: null,
    };
  }
  async submitCode(key: string, code: string): Promise<SignInStatus> {
    if (code === "good-code") {
      this.signed.add(key);
      return { state: "succeeded" };
    }
    return {
      state: "waiting",
      url: `https://${this.provider}.example/signin`,
      userCode: null,
      expiresAt: Date.now() + 600_000,
      codeError: code === "dead-code" ? "wrong_code_reissued" : "wrong_code",
    };
  }
  /** What the device-code CLI does when the person confirms on the vendor's page. */
  confirm(key: string) {
    this.signed.add(key);
    this.changes.get(key)?.({ state: "succeeded" });
  }
  async cancel() {}
  signedIn(key: string) {
    return this.signed.has(key);
  }
  async signOut(key: string) {
    this.signed.delete(key);
    this.signedOut.push(key);
  }
}
