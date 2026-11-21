// Run failures in the façade's terms (README: Error codes). Agents build them from the vendor's
// structured error first; `classifyText` is the fallback for a vendor's bare error text.
import type { Failure, ProviderId } from "./types";

const VENDOR: Record<ProviderId, string> = {
  claude: "Claude",
  codex: "ChatGPT",
  grok: "Grok",
  openrouter: "OpenRouter",
  gemini: "Gemini",
};

/** Tandem's English fallbacks; a provider's own text replaces them where it is meant for people. */
export const FAILURE_COPY = {
  model_unavailable:
    "This model isn't available on your plan. Pick another model and try again.",
  usage_limit:
    "You've reached your plan's usage limit. Try again once it resets.",
  rate_limited:
    "The provider is getting too many requests right now. Wait a moment, then try again.",
  provider_unavailable:
    "The provider isn't available right now. Please try again in a moment.",
  network: "The provider couldn't be reached. Please try again in a moment.",
  context_too_long:
    "This conversation no longer fits the model's context. Start a new conversation.",
  failed: "The assistant couldn't finish this reply. Please try again.",
  aborted: "Stopped.",
};

const text = (t: string | null | undefined, fallback: string) =>
  typeof t === "string" && t.trim() ? t.trim().slice(0, 300) : fallback;

export const fail = {
  signinRequired: (provider: ProviderId): Failure => ({
    code: "signin_required",
    message: `Your ${VENDOR[provider]} account isn't connected or its sign-in expired. Connect it again, then retry.`,
    params: { provider },
  }),
  usageLimit: (
    provider: ProviderId,
    resetsAt: Date | null,
    message?: string,
  ): Failure => ({
    code: "usage_limit",
    message: text(message, FAILURE_COPY.usage_limit),
    params: {
      provider,
      resetsAt:
        resetsAt && !Number.isNaN(resetsAt.getTime())
          ? resetsAt.toISOString()
          : null,
    },
  }),
  rateLimited: (provider: ProviderId, message?: string): Failure => ({
    code: "rate_limited",
    message: text(message, FAILURE_COPY.rate_limited),
    params: { provider },
  }),
  providerUnavailable: (provider: ProviderId, message?: string): Failure => ({
    code: "provider_unavailable",
    message: text(message, FAILURE_COPY.provider_unavailable),
    params: { provider },
  }),
  network: (provider: ProviderId, message?: string): Failure => ({
    code: "network",
    message: text(message, FAILURE_COPY.network),
    params: { provider },
  }),
  contextTooLong: (model: string | null, message?: string): Failure => ({
    code: "context_too_long",
    message: text(message, FAILURE_COPY.context_too_long),
    params: { model },
  }),
  modelUnavailable: (): Failure => ({
    code: "model_unavailable",
    message: FAILURE_COPY.model_unavailable,
    params: {},
  }),
  aborted: (): Failure => ({
    code: "aborted",
    message: FAILURE_COPY.aborted,
    params: {},
  }),
  /** Anything else: its details stay out of the message. */
  failed: (): Failure => ({
    code: "failed",
    message: FAILURE_COPY.failed,
    params: {},
  }),
};

const SIGNIN =
  /not logged in|please run \/login|\b401\b|unauthorized|missing bearer|invalid api key|invalid x-api-key|authentication_error|token (has )?expired|refresh token|invalid_grant|log ?in again|sign ?in again|api key not valid|invalid_api_key|incorrect api key/i;
const MODEL =
  /issue with the selected model|model.{0,80}(not (found|supported|available)|does not exist|unavailable|no access|not have access)|unknown model|invalid model/i;
const USAGE =
  /usage limit|quota|insufficient[_ ]credits|out of credits|credit balance|plan limit|hit your limit|limit reached|billing/i;
const RATE = /\b429\b|rate.?limit|too many requests/i;
const OVERLOADED =
  /\b5(00|02|03|04|29)\b|overloaded|service unavailable|bad gateway|internal server error/i;
const NETWORK =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network error|fetch failed|connection (refused|reset|closed)|tunnel failed|proxy/i;
const CONTEXT =
  /context (length|window)|prompt is too long|too many tokens|maximum context|context_length_exceeded|input is too long/i;

/**
 * A vendor's bare error text, classified. Only codes whose text is written for people keep it;
 * everything unrecognised is `failed` with Tandem's own words.
 */
export function classifyText(
  provider: ProviderId,
  raw: string,
  model: string | null = null,
): Failure {
  const t = raw ?? "";
  if (SIGNIN.test(t)) return fail.signinRequired(provider);
  if (CONTEXT.test(t)) return fail.contextTooLong(model);
  if (USAGE.test(t)) return fail.usageLimit(provider, null);
  if (RATE.test(t)) return fail.rateLimited(provider);
  if (MODEL.test(t)) return fail.modelUnavailable();
  if (OVERLOADED.test(t)) return fail.providerUnavailable(provider);
  if (NETWORK.test(t)) return fail.network(provider);
  return fail.failed();
}
