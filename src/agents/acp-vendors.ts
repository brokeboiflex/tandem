// The three ACP agents Tandem runs: Google's Antigravity CLI for Gemini, xAI's Grok Build for Grok
// and goose for OpenRouter. Each is the vendor's unmodified program in the person's sandbox; this
// file says how to start it, how its models and modes are named, and how a pasted key is checked.
//
// Permission modes (PermissionMode) on each agent's own session modes, plus the client's policy in
// AcpAgent.autoAnswer (full_access allows every ask, read_only allows reads and denies the rest,
// workspace_write allows edits inside the workspace; every other ask goes to the person):
//
// | Tandem          | agy (Antigravity) | Grok Build | goose          |
// | --------------- | ----------------- | ---------- | -------------- |
// | read_only       | plan              | plan       | approve        |
// | workspace_write | accept-edits      | default    | approve        |
// | auto            | accept-edits      | default    | smart_approve  |
// | full_access     | accept-edits      | default    | auto           |
//
// agy offers its own `auto` only with its terminal sandbox, which Tandem's sandbox replaces, so
// `auto` is agy's accept-edits and its asks go to the person. Grok's default asks before shell
// commands outside its safe list, edits and MCP calls. Verified with the real programs:
// evidence/acp-agents.txt.
import { lstatSync } from "node:fs";
import { fail } from "./failures";
import {
  AcpAgent,
  option,
  rpcText,
  type AcpOptions,
  type AcpVendor,
  type Advertised,
  type CatalogModel,
  type SessionChange,
} from "./acp";
import type { RpcError } from "./jsonrpc";
import type { KeyVerdict, Sandboxes } from "./types";

export type VendorOptions = AcpOptions & {
  /** Tests and proofs only: more environment for the vendor process (a mock API's address). */
  env?: Record<string, string>;
  /** API origins the key checks and OpenRouter's model list use (tests and proofs override). */
  urls?: { openrouter?: string; gemini?: string };
  /** The gateway's own fetch, for OpenRouter's public model list. */
  fetch?: typeof fetch;
};

const OPENROUTER = "https://openrouter.ai";
const GEMINI_API = "https://generativelanguage.googleapis.com";

/** Efforts as agy spells them in model ids (`gemini-4-hydrogen-xhigh`), in picker order. */
const EFFORT_SUFFIXES = ["minimal", "low", "medium", "high", "xhigh", "max"];
/** agy's default effort where Happy's curated catalog named one other than medium. */
const AGY_DEFAULT_EFFORT: Record<string, string> = {
  "gemini-3.8-flash": "high",
};

// ---------------------------------------------------------------------------------------------
// Gemini: `agy acp` on the person's own Gemini API key

export function geminiAgent(o: VendorOptions) {
  return new AcpAgent(
    {
      provider: "gemini",
      label: "Antigravity",
      // agy uses the Gemini API with GEMINI_API_KEY, never its own Google sign-in, once its settings
      // name that backend (Google's terms forbid a third-party client on an Antigravity sign-in).
      // Written as the person, inside the sandbox, on every start: the gateway never writes into a
      // home it does not own.
      command: [
        "sh",
        "-c",
        'mkdir -p "$HOME/.gemini/antigravity-cli" && printf \'{ "modelProvider": "gemini" }\\n\' > "$HOME/.gemini/antigravity-cli/settings.json" && exec agy acp --disable-telemetry',
      ],
      env: (key) => {
        const k = o.apiKeys.get(key, "gemini");
        return k
          ? { GEMINI_API_KEY: k, AGY_CLI_DISABLE_AUTO_UPDATE: "true", ...o.env }
          : null;
      },
      modes: {
        read_only: ["plan"],
        workspace_write: ["accept-edits"],
        auto: ["accept-edits"],
        full_access: ["accept-edits"],
      },
      models: agyModels,
      defaultAccount: { email: null, plan: "API key" },
      // agy takes HTTP MCP servers in session/new without advertising them, and never asks
      // before an MCP tool call.
      mcpWithoutAdvert: true,
      usage: "turn",
      // agy reports a failed model request as assistant text (" ⚠ agent executor error: … API key not
      // valid", " ⚠ API error (attempt 1): Error 429 …") and ends the turn as if it answered.
      errorText: /^\s*⚠\s*(agent executor error|API error)\b/,
      // Google words a rate limit "Resource has been exhausted (e.g. check quota)"; a used-up
      // quota says "exceeded your current quota".
      classify: (text) =>
        /RESOURCE_EXHAUSTED|Error 429/.test(text) && !/exceeded your current quota|billing/i.test(text)
          ? fail.rateLimited("gemini")
          : null,
      verifyApiKey: (sb, key, apiKey) =>
        checkKey(sb, key, apiKey, {
          header: "x-goog-api-key: %s",
          url: `${o.urls?.gemini ?? GEMINI_API}/v1beta/models?pageSize=1`,
          // Google answers 400 API_KEY_INVALID for a malformed or unknown key.
          refused: [400, 401, 403],
        }),
    },
    o,
  );
}

/**
 * agy lists each model once per effort (`gemini-4-carbon-high`, "Gemini 4 Carbon (High)") in
 * its model state, and plainly in its `model` option with the effort as `thought_level`. Each
 * base name is one catalog model whose efforts are its suffixes.
 */
export function agyModels(adv: Advertised): CatalogModel[] {
  const grouped = new Map<
    string,
    { name: string; efforts: Set<string>; plain: boolean }
  >();
  const add = (value: string, name: string | undefined) => {
    const effort = EFFORT_SUFFIXES.find((e) => value.endsWith(`-${e}`));
    const base = effort ? value.slice(0, -(effort.length + 1)) : value;
    const label = (name ?? base).replace(/\s*\([^)]*\)\s*$/, "").trim() || base;
    const g = grouped.get(base) ?? {
      name: label,
      efforts: new Set(),
      plain: false,
    };
    if (effort) g.efforts.add(effort);
    else g.plain = true;
    grouped.set(base, g);
  };
  for (const m of adv.models?.availableModels ?? []) add(m.modelId, m.name);
  const modelOpt = option(adv, "model");
  const levels = option(adv, "thought_level")?.values.map((v) => v.value) ?? [];
  if (!adv.models) for (const v of modelOpt?.values ?? []) add(v.value, v.name);
  const listed = new Set(
    (adv.models?.availableModels ?? []).map((m) => m.modelId),
  );
  return [...grouped].map(([base, g]) => {
    const efforts = EFFORT_SUFFIXES.filter((e) => g.efforts.has(e));
    const offered = efforts.length ? efforts : g.plain ? levels : [];
    const preferred = AGY_DEFAULT_EFFORT[base] ?? "medium";
    const defaultEffort = offered.includes(preferred)
      ? preferred
      : (offered[0] ?? null);
    return {
      id: `antigravity/${base}`,
      name: g.name,
      efforts: offered,
      defaultEffort,
      contextLimit: null,
      select: (effort): SessionChange[] => {
        const e = effort ?? defaultEffort;
        if (e && listed.has(`${base}-${e}`))
          return [{ method: "session/set_model", modelId: `${base}-${e}` }];
        if (listed.has(base))
          return [
            { method: "session/set_model", modelId: base },
            ...(e ? [{ method: "effort" as const, value: e }] : []),
          ];
        const changes: SessionChange[] = [];
        if (modelOpt)
          changes.push({
            method: "session/set_config_option",
            configId: modelOpt.id,
            value: base,
          });
        if (e) changes.push({ method: "effort", value: e });
        return changes;
      },
    };
  });
}

// ---------------------------------------------------------------------------------------------
// OpenRouter: goose with the person's own OpenRouter key

/**
 * Tandem's OpenRouter models: chat models with tool calling that need no reasoning signatures
 * passed back between tool calls. Gemini's and Claude's do (Google requires them; OpenRouter's
 * reasoning guide asks for them), so they are not offered here, as before (runtime/happy.toml).
 */
export const OPENROUTER_MODELS = [
  "deepseek/deepseek-v4.1-flash-1017",
  "openai/gpt-6.2-sol",
  "x-ai/grok-4.7",
  "qwen/qwen4-max",
  "moonshotai/kimi-k3.1-pro",
  "z-ai/glm-5.3-prime",
];
/** goose's thinking efforts for a reasoning model (`thinking_effort`). */
const GOOSE_EFFORTS = ["off", "low", "medium", "high", "max"];

type ModelInfo = {
  name: string | null;
  context: number | null;
  reasoning: boolean | null;
};

export function openrouterAgent(o: VendorOptions) {
  const doFetch = o.fetch ?? fetch;
  const base = o.urls?.openrouter ?? OPENROUTER;
  let cache: { at: number; info: Map<string, ModelInfo> } | null = null;
  // OpenRouter's public model list (no key, nothing about the person), read by the gateway for
  // names, context windows and whether a model reasons; kept an hour, a failure a minute.
  const info = async () => {
    if (cache && Date.now() - cache.at < (cache.info.size ? 3_600_000 : 60_000))
      return cache.info;
    const map = new Map<string, ModelInfo>();
    try {
      const r = await doFetch(`${base}/api/v1/models`, {
        signal: AbortSignal.timeout(10_000),
      });
      const body: any = r.ok ? await r.json() : null;
      for (const m of Array.isArray(body?.data) ? body.data : [])
        if (typeof m?.id === "string")
          map.set(m.id, {
            name: typeof m.name === "string" ? m.name : null,
            context:
              typeof m.context_length === "number" ? m.context_length : null,
            reasoning: Array.isArray(m.supported_parameters)
              ? m.supported_parameters.includes("reasoning")
              : null,
          });
    } catch {}
    cache = { at: Date.now(), info: map };
    return map;
  };
  return new AcpAgent(
    {
      provider: "openrouter",
      label: "goose",
      command: ["goose", "acp"],
      env: (key) => {
        const k = o.apiKeys.get(key, "openrouter");
        if (!k) return null;
        return {
          GOOSE_PROVIDER: "openrouter",
          // A model the session starts on; each conversation sets its own.
          GOOSE_MODEL: OPENROUTER_MODELS[0]!,
          OPENROUTER_API_KEY: k,
          // Its secrets file instead of an OS keyring, which a sandbox has none of.
          GOOSE_DISABLE_KEYRING: "1",
          GOOSE_MODE: "approve",
          GOOSE_TELEMETRY_OFF: "1",
          OTEL_SDK_DISABLED: "true",
          // Titles are the gateway's; goose's would be another request billed to the person.
          GOOSE_DISABLE_SESSION_NAMING: "true",
          ...o.env,
        };
      },
      modes: {
        read_only: ["approve"],
        workspace_write: ["approve"],
        auto: ["smart_approve"],
        full_access: ["auto"],
      },
      models: () => [],
      catalog: async () => {
        const known = await info();
        return OPENROUTER_MODELS.map((id) => {
          const m = known.get(id);
          const efforts = m?.reasoning ? GOOSE_EFFORTS : [];
          const defaultEffort = efforts.length ? "medium" : null;
          return {
            id,
            name: m?.name ?? null,
            efforts,
            defaultEffort,
            contextLimit: m?.context ?? null,
            select: (effort): SessionChange[] => [
              { method: "session/set_config_option", configId: "model", value: id },
              // Offered for reasoning models only (`thinking_effort`): otherwise goose's own.
              ...(effort ? [{ method: "effort" as const, value: effort }] : []),
            ],
          };
        });
      },
      defaultAccount: { email: null, plan: "API key" },
      // The session gets goose's developer tools (shell, files) and the person's MCP servers only,
      // each limited to its enabled tools; goose's other built-ins (extension manager, apps,
      // sub-agents, scheduler) stay off. A selection here replaces `mcpServers`.
      newSession: (servers) => ({
        mcpServers: [],
        _meta: {
          enabledExtensions: [
            { type: "platform", name: "developer" },
            ...servers.map((s) => ({
              type: "mcp",
              server: {
                type: "http",
                name: s.name,
                url: s.url,
                headers: Object.entries(s.headers).map(([name, value]) => ({
                  name,
                  value,
                })),
              },
              ...(s.enabledTools ? { available_tools: s.enabledTools } : {}),
            })),
          ],
        },
      }),
      toolName: (call) => call._meta?.goose?.toolCall?.toolName ?? null,
      // goose streams a failed turn's error as assistant text before failing the prompt with it.
      errorText: /^Ran into this error: /,
      // PromptResponse.usage is goose's last request only; the session's totals come in goose's own
      // usage notification, which it sends to clients that ask for them.
      usage: "none",
      clientMeta: { goose: { customNotifications: true } },
      notification: (method, params) => {
        const u = params?.update;
        if (method !== "_goose/unstable/session/update" || u?.sessionUpdate !== "usage_update")
          return null;
        if (typeof params.sessionId !== "string") return null;
        return {
          sessionId: params.sessionId,
          usage: {
            input: Number(u.accumulatedInputTokens) || 0,
            output: Number(u.accumulatedOutputTokens) || 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        };
      },
      failure: (e: RpcError) =>
        (e.data as any)?.reason === "credits_exhausted"
          ? fail.usageLimit("openrouter", null, e.message)
          : null,
      // After session/load goose first finishes a run the previous process left (an interrupted
      // tool call): "session already has active run `resume_…`; use …/session/steer".
      busy: (e: RpcError) =>
        e.code === -32602 && /already has active run/i.test(rpcText(e)),
      verifyApiKey: (sb, key, apiKey) =>
        checkKey(sb, key, apiKey, {
          header: "Authorization: Bearer %s",
          url: `${base}/api/v1/key`,
          refused: [401, 403],
        }),
    },
    o,
  );
}

// ---------------------------------------------------------------------------------------------
// Grok: xAI's Grok Build agent on the person's own `grok login --device-auth`

/**
 * Grok Build's environment: no telemetry, error reports, managed (remote) config, memory sampler
 * or self-update (grok-build: S/agent/config.rs, xai-grok-cloud-config managed_config/store.rs,
 * xai-grok-pager memory_trace.rs, xai-grok-pager-bin main.rs). The sign-in CLI gets it too.
 */
export const GROK_ENV: Record<string, string> = {
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  GROK_MANAGED_CONFIG: "0",
  GROK_MEMTRACE: "0",
  GROK_DISABLE_AUTOUPDATER: "1",
};
/** The person's Grok sign-in in their home (`$GROK_HOME`, default ~/.grok). */
export const GROK_AUTH_FILE = ".grok/auth.json";

export function grokAgent(o: VendorOptions) {
  return new AcpAgent(
    {
      provider: "grok",
      label: "Grok Build",
      // Standalone: never a shared "leader" process that would serve several homes' sessions.
      command: ["grok", "agent", "--no-leader", "stdio"],
      env: (key) =>
        hasFile(o.sandboxes, key, GROK_AUTH_FILE) ? { ...GROK_ENV, ...o.env } : null,
      // Grok takes default, plan and ask without advertising them; it asks before shell commands,
      // edits and MCP calls in default, and Tandem's policy answers what the mode decides.
      modes: {
        read_only: ["plan"],
        workspace_write: ["default"],
        auto: ["default"],
        full_access: ["default"],
      },
      unadvertisedModes: true,
      models: grokModels,
      account: async (rpc) => {
        // `meta` is Grok's own view of the signed-in account (email, subscription tier).
        const sub: any = await rpc.request("_x.ai/auth/check_subscription", {}, 20_000).catch(() => null);
        const info: any = sub?.meta?.email
          ? null
          : await rpc.request("_x.ai/auth/info", {}, 10_000).catch(() => null);
        const email = sub?.meta?.email ?? info?.email ?? null;
        const plan = sub?.meta?.subscription_tier ?? null;
        return email || plan ? { email, plan } : null;
      },
      defaultAccount: { email: null, plan: null },
      // Grok reports a prompt's usage in `_meta.usage` and the last model call's size in
      // `_meta.totalTokens` (no usage_update): that size against the model's window is the context.
      usage: "turn",
      report: (r, model) => {
        const meta = r?._meta;
        if (!meta || typeof meta !== "object") return null;
        const used = typeof meta.totalTokens === "number" ? meta.totalTokens : 0;
        return {
          usage: meta.usage ?? null,
          context:
            used > 0 && model.contextLimit
              ? { usedTokens: used, limitTokens: model.contextLimit, approximate: false }
              : null,
        };
      },
      failure: (e, model) => {
        const d: any = e.data;
        const text = rpcText(e);
        if (d?.http_status === 401) return fail.signinRequired("grok");
        if (d?.errorType === "context_length") return fail.contextTooLong(model);
        // A used-up free tier arrives as a 429 too (subscription:free-usage-exhausted).
        if (e.code === -32003 || d?.http_status === 429)
          return /usage-exhausted|quota|limit reached/i.test(text)
            ? fail.usageLimit("grok", null)
            : fail.rateLimited("grok");
        return null;
      },
    },
    o,
  );
}

/**
 * Grok's models (its model state's `_meta`: totalContextTokens, reasoningEfforts and the default
 * reasoningEffort), as `xai/<id>`.
 */
export function grokModels(adv: Advertised): CatalogModel[] {
  const modelOpt = option(adv, "model");
  const list =
    adv.models?.availableModels ??
    (modelOpt?.values ?? []).map((v) => ({ modelId: v.value, name: v.name, _meta: undefined }));
  return list.map((m) => {
    const meta = m._meta ?? {};
    // Each option's `id` is what the reasoning_effort option takes; `value` is the API's word.
    const options: { id: string; value: unknown; default: boolean }[] = (
      Array.isArray(meta.reasoningEfforts) ? meta.reasoningEfforts : []
    )
      .map((e: any) =>
        typeof e === "string"
          ? { id: e, value: e, default: false }
          : { id: e?.id ?? e?.value, value: e?.value ?? e?.id, default: !!e?.default },
      )
      .filter((o: any) => typeof o.id === "string");
    const efforts = options.map((o) => o.id);
    const defaultEffort =
      options.find((o) => o.value === meta.reasoningEffort)?.id ??
      options.find((o) => o.default)?.id ??
      efforts[0] ??
      null;
    return {
      id: `xai/${m.modelId}`,
      name: m.name ?? null,
      efforts,
      defaultEffort,
      contextLimit: typeof meta.totalContextTokens === "number" ? meta.totalContextTokens : null,
      select: (effort): SessionChange[] => [
        modelOpt
          ? { method: "session/set_config_option", configId: modelOpt.id, value: m.modelId }
          : { method: "session/set_model", modelId: m.modelId },
        ...(effort ? [{ method: "effort" as const, value: effort }] : []),
      ],
    };
  });
}

/** All three ACP agents. */
export function acpAgents(o: VendorOptions) {
  return [geminiAgent(o), grokAgent(o), openrouterAgent(o)];
}

// ---------------------------------------------------------------------------------------------
// Key checks

/**
 * One request with the pasted key, from a one-shot sandbox through the egress proxy. The key
 * reaches curl's standard input through shell builtins: never an argument or an environment
 * variable of any process. Exit code and status only; nothing of the answer is kept.
 */
async function checkKey(
  sb: Sandboxes,
  key: string,
  apiKey: string,
  how: { header: string; url: string; refused: number[] },
): Promise<KeyVerdict> {
  const script =
    `IFS= read -r k; printf '${how.header}\\n' "$k" | ` +
    `curl -s -m 15 -o /dev/null -w '%{http_code}' -H @- "$1"`;
  const r = await sb
    .exec(key, ["sh", "-c", script, "check-key", how.url], {
      stdin: Buffer.from(`${apiKey}\n`),
    })
    .catch(() => null);
  const status = Number(r?.stdout.trim());
  if (status >= 200 && status < 300) return "ok";
  if (how.refused.includes(status)) return "refused";
  return "unreachable";
}

/** Whether a file exists in the person's home on the gateway's disk (never read: lstat only). */
export function hasFile(sb: Sandboxes, key: string, path: string) {
  try {
    return lstatSync(`${sb.homeOf(key)}/${path}`).isFile();
  } catch {
    return false;
  }
}

export { rpcText };
