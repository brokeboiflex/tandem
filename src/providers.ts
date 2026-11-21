// The five façade providers: how each signs in, what an error says about it, and the pure views
// the gateway returns (README: API, The connect flow, Error codes).
import type {
  Account,
  ApiKeyProvider,
  Model,
  ProviderId,
  SignInStatus,
} from "./agents/types";
import { PROVIDER_IDS } from "./agents/types";

export { PROVIDER_IDS };

export type Flow = "paste_code" | "device_code" | "api_key";

type ApiKeySpec = { issuer: string; hint: string };

const PROVIDERS: Record<
  ProviderId,
  { vendor: string; subscription: Flow | null; apiKey: ApiKeySpec | null }
> = {
  claude: {
    vendor: "Claude",
    subscription: "paste_code",
    apiKey: { issuer: "Anthropic", hint: "It starts with sk-ant-." },
  },
  codex: { vendor: "ChatGPT", subscription: "device_code", apiKey: null },
  grok: { vendor: "Grok", subscription: "device_code", apiKey: null },
  openrouter: {
    vendor: "OpenRouter",
    subscription: null,
    apiKey: { issuer: "OpenRouter", hint: "It starts with sk-or-." },
  },
  gemini: {
    vendor: "Gemini",
    subscription: null,
    apiKey: { issuer: "Google", hint: "It starts with AIza." },
  },
};

/** The vendor as an English sentence names it ("ChatGPT" for Codex). */
export const vendorOf = (id: ProviderId) => PROVIDERS[id].vendor;
/** The flow of the provider's own sign-in, or null when it takes only an API key. */
export const subscriptionFlow = (id: ProviderId) => PROVIDERS[id].subscription;
export const apiKeySpec = (id: ProviderId) => PROVIDERS[id].apiKey;
export const takesApiKey = (id: ProviderId): id is ApiKeyProvider =>
  !!PROVIDERS[id].apiKey;

/** What a client sees of a model. */
export type ModelView = {
  id: string;
  name: string | null;
  default: boolean;
  efforts: string[];
  defaultEffort: string | null;
};

export const modelView = (m: Model): ModelView => ({
  id: m.id,
  name: m.name,
  default: !!m.default,
  efforts: m.efforts,
  defaultEffort: m.defaultEffort,
});

export type ProviderView = {
  id: ProviderId;
  status: "connected" | "not_connected" | "connecting" | "unknown";
  method: "subscription" | "api_key" | null;
  account: Account | null;
  models: ModelView[];
  checkedAt: string | null;
};

// ---------------------------------------------------------------------------------------------
// Connections

export type ConnectionError =
  | {
      code:
        | "wrong_code"
        | "wrong_code_reissued"
        | "expired"
        | "sign_in_failed"
        | "unavailable";
      message: string;
      params: Record<string, never>;
    }
  | {
      code: "invalid_api_key";
      message: string;
      params: { provider: ProviderId };
    };

export type Connection = {
  status: "waiting" | "connected" | "failed" | "cancelled" | "expired";
  flow: Flow;
  url: string | null;
  userCode: string | null;
  expiresAt: string | null;
  error: ConnectionError | null;
  account: Account | null;
};

/** The English fallback of each connection error: one sentence per code. */
export const COPY = {
  wrong_code:
    "That code didn't work. Copy the whole code from the sign-in page and paste it again.",
  wrong_code_reissued:
    "That code wasn't accepted. Open the sign-in page again to get a new code, then paste it here.",
  expired: "The sign-in timed out. Start again when you're ready.",
  sign_in_failed: "Signing in didn't finish. Please try again.",
  unavailable:
    "Sign-in isn't available right now. Please try again in a moment.",
};

export const connectionError = (code: keyof typeof COPY): ConnectionError => ({
  code,
  message: COPY[code],
  params: {},
});

/** The provider refused the person's API key, or could not be reached to check it. */
export const invalidApiKey = (id: ProviderId): ConnectionError => ({
  code: "invalid_api_key",
  message: `${PROVIDERS[id].apiKey?.issuer ?? PROVIDERS[id].vendor} didn't accept that API key, or couldn't be reached. Check the key and try again.`,
  params: { provider: id },
});

const base = (flow: Flow) => ({
  flow,
  url: null,
  userCode: null,
  expiresAt: null,
  error: null,
  account: null,
});

export const apiKeyConnection = (
  status: "connected" | "failed",
  error: ConnectionError | null = null,
): Connection => ({
  ...base("api_key"),
  status,
  error,
  account: status === "connected" ? { email: null, plan: "API key" } : null,
});

export const unavailableConnection = (id: ProviderId): Connection => ({
  ...base(PROVIDERS[id].subscription ?? "api_key"),
  status: "failed",
  error: connectionError("unavailable"),
});

export const connectedConnection = (
  flow: Flow,
  account: Account | null,
): Connection => ({
  ...base(flow),
  status: "connected",
  account,
});

/** A sign-in's status as the façade's `connection`. */
export function signInConnection(
  flow: Flow,
  s: SignInStatus,
  account: Account | null,
  now = Date.now(),
): Connection {
  switch (s.state) {
    case "starting":
      return { ...base(flow), status: "waiting" };
    case "waiting":
      if (s.expiresAt && now > s.expiresAt)
        return {
          ...base(flow),
          status: "expired",
          error: connectionError("expired"),
        };
      return {
        ...base(flow),
        status: "waiting",
        url: s.url,
        userCode: s.userCode,
        expiresAt: s.expiresAt ? new Date(s.expiresAt).toISOString() : null,
        error: s.codeError ? connectionError(s.codeError) : null,
      };
    case "succeeded":
      return connectedConnection(flow, account);
    case "cancelled":
      return { ...base(flow), status: "cancelled" };
    case "failed":
      return s.reason === "expired"
        ? {
            ...base(flow),
            status: "expired",
            error: connectionError("expired"),
          }
        : {
            ...base(flow),
            status: "failed",
            error: connectionError(
              s.reason === "unavailable" ? "unavailable" : "sign_in_failed",
            ),
          };
  }
}

// ---------------------------------------------------------------------------------------------
// Questions

export type QuestionView = {
  id: string;
  status: "pending" | "answered" | "cancelled";
  kind: "permission" | "question";
  askedBy: string | null;
  context: string | null;
  prompts: {
    id: string;
    header: string | null;
    question: string;
    multiSelect: boolean;
    options: { label: string; description: string | null }[];
  }[];
};

/**
 * A client's answer: an option label, a list of labels (one prompt), or `{ <promptId>: label |
 * labels }`. Every prompt needs an answer; a label must be one of the prompt's options when
 * this is a permission question (a question may also take the person's own words, like "Other").
 * Null when it does not fit.
 */
export function questionAnswers(
  q: Pick<QuestionView, "prompts" | "kind">,
  answer: unknown,
): Record<string, string[]> | null {
  const list = (v: unknown) =>
    typeof v === "string"
      ? [v]
      : Array.isArray(v) && v.every((s) => typeof s === "string")
        ? (v as string[])
        : null;
  let raw: Record<string, string[] | null>;
  if (typeof answer === "string" || Array.isArray(answer)) {
    if (q.prompts.length !== 1) return null;
    raw = { [q.prompts[0]!.id]: list(answer) };
  } else if (answer && typeof answer === "object") {
    raw = Object.fromEntries(
      q.prompts.map((p) => [p.id, list((answer as any)[p.id])]),
    );
  } else return null;
  const out: Record<string, string[]> = {};
  for (const p of q.prompts) {
    const values = raw[p.id];
    if (!values?.length || values.some((v) => !v.trim() || v.length > 10_000))
      return null;
    if (!p.multiSelect && values.length > 1) return null;
    if (
      q.kind === "permission" &&
      values.some((v) => !p.options.some((o) => o.label === v))
    )
      return null;
    out[p.id] = values;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Context the application sends with a message

export const CONTEXT_OPEN =
  '<app_context note="Supplied by the application for this message only. It describes the situation in the app; it was not written by the person.">';
export const CONTEXT_CLOSE = "</app_context>";
export const MAX_CONTEXT = 16_000;

export const withContext = (text: string, context: string) =>
  context ? `${CONTEXT_OPEN}\n${context}\n${CONTEXT_CLOSE}\n\n${text}` : text;

/** A conversation's generated title: the first line of its first message, shortened. */
export function autoTitle(text: string) {
  const line = text.trim().split("\n")[0]!.replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

/** Opaque list cursor: the last item's activity time and id. */
export const encodeCursor = (at: number, id: string) =>
  Buffer.from(`${at}.${id}`).toString("base64url");

export function decodeCursor(
  raw: string,
  idPattern: string,
): { at: number; id: string } | null {
  const m = Buffer.from(raw, "base64url")
    .toString()
    .match(new RegExp(`^(\\d{1,16})\\.(${idPattern})$`));
  return m ? { at: Number(m[1]), id: m[2]! } : null;
}
