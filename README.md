# Tandem

Tandem gives every person their own private, always-resumable AI workspace behind one small HTTP API:
Claude Code, Codex, Grok, Gemini and OpenRouter models. Each person signs in with **their own**
Claude, ChatGPT or Grok account through the vendor's own sign-in, or brings **their own** Anthropic,
Gemini or OpenRouter API key, inside **their own** sandbox. Your application talks to Tandem; Tandem
never sees passwords and never shares an account between people.

Tandem is **one container** that runs on any Docker host: deploy it once (Docker Compose, Dokploy)
and talk to it over HTTP. Inside it, the gateway runs every person's workspace as a sandboxed process
tree through [crun](https://github.com/containers/crun) (their own uid and Linux namespaces over a
read-only system), started on demand in about a second and stopped when idle. No KVM, no Docker
socket, no container per person.

Each workspace runs one unmodified [Happy Agent](https://github.com/slopus/happy-agent) daemon with the
official Claude Code, Codex, Grok and Google Antigravity CLIs. Tandem adds the parts a multi-user
service needs: authentication, one sandbox per person, start-on-demand and idle stop, a narrow façade
over Happy's owner-level API, and a friendlier sign-in flow.

## How it is isolated

- **One sandbox, one uid and one home per person.** The sandbox is `<prefix>-<id>`, its home
  `DATA_DIR/homes/<id>` (owner-only), where `<id>` is an HMAC of the person's id (`sub` of the service
  JWT) under `SERVICE_SECRET`; each person gets their own uid, recorded in `DATA_DIR/uids.json`. The
  gateway derives the runtime only from the verified token, so one person can never address another's.
- **What a sandbox sees.** Its own PID, network, IPC, UTS, cgroup and mount namespaces; the runtime
  system read-only; only the person's home and temporary directory writable; no capabilities,
  `no_new_privs` and Docker's seccomp filter for unprivileged containers. Other people's files and
  processes do not exist inside it.
- **Its own limits.** Each person has a cgroup holding their memory and process limits for all of
  their processes together (`RUNTIME_MEMORY_MB`, `RUNTIME_PIDS`), and every vendor process runs in a
  child of it: a runaway tool ends only its own process tree, never the person's other processes, other
  people, the gateway or the server. CPU is shared equally between the people who need it, and the
  gateway gets more than all sandboxes together.
- **Vendor credentials stay in the person's home.** `claude auth login`, `codex login` and
  `grok login --device-auth` run inside the sandbox and store their sign-in there, and the gateway
  writes a person's own API key there (through standard input, never a command line). Tandem does not
  read, copy or log them.
- **The daemon token never leaves the gateway.** Happy's owner token (shutdown, drain, debug, config,
  bots, remote connections) is read once per start inside the sandbox and kept in memory. The gateway
  can send only an allowlisted set of daemon requests (`src/happy.ts`), over the daemon's own Unix
  socket in the home.
- **No network but two sockets.** A sandbox has loopback only. Its ways out are two Unix sockets of the
  gateway: the egress proxy ([Smokescreen](https://github.com/stripe/smokescreen), an allowlist of
  vendor hosts) and its own MCP proxy socket. It cannot reach other people, the gateway's API, the
  host, private networks or cloud metadata (see [Security](#security)).
- **Application credentials stay in gateway memory.** The token your app sends for its own MCP server
  (`mcpAuth`) is held in the gateway's memory for that person only, never written to the sandbox, a
  file or a log. The runtime reaches your MCP server only through the gateway's MCP proxy, on a socket
  that exists for that person's sandbox only, and the proxy adds the person's latest credential on the
  way out (see [Connecting your app's MCP server](#connecting-your-apps-mcp-server)).
- **Hardened defaults.** Built-in admin bot archived on every start, Happy relay/mobile/Tailcat off,
  sub-agents limited to their own harness (a Claude chat cannot start Codex work) and none at all on
  Grok and OpenRouter (see [Happy's own agent loop](#happys-own-agent-loop-grok-and-openrouter)).

## Quick start (local)

Requirements: Docker Engine (or Docker Desktop) with Compose and Buildx, Bun 1.3.9, about 4 GB of
disk. The image builds for **linux/arm64** and **linux/amd64**.

```sh
bun install --frozen-lockfile
cp .env.example .env    # then set AUTH_MODE=dev, DEV_TOKEN_ROUTE=true and two random secrets:
                        #   DEV_AUTH_SECRET and SERVICE_SECRET (e.g. `openssl rand -hex 32` each)
docker compose up -d --build   # one image: the gateway, crun, Smokescreen and the runtime system
open http://127.0.0.1:8787/connect                              # demo sign-in page
```

Checks:

```sh
bun run typecheck && bun test       # unit tests (fixtures from the pinned daemon, a fake crun, a stub MCP
                                    # server)
bun scripts/e2e.ts                  # against the running container (restarts it once): sign-ins, isolation
                                    # probes from inside the sandboxes, the MCP proxy; its stub MCP server
                                    # needs MCP_ALLOWED_ORIGINS=http://host.docker.internal:8791 and, on
                                    # Linux, extra_hosts: ["host.docker.internal:host-gateway"]
E2E_REAL_SUBJECT=<person> bun scripts/e2e.ts   # plus real turns, MCP tool calls included, for a person
                                    # whose home holds real sign-ins
bun scripts/page-check.ts           # drives /connect in headless Chromium, screenshots to evidence/
                                    # (BROWSER_EXECUTABLE=/path/to/chromium if Playwright has none)
```

`bun scripts/token.ts <person>` prints a local development token for `curl`. `bun scripts/stub-mcp.ts`
runs the test MCP server on its own (a `lookup_customer` tool that requires `Bearer valid-…`).
Inside the container, `bun src/cli.ts ls`, `bun src/cli.ts exec <id> -- sh -c '…'` (a command as that
person, in a sandbox like theirs) and `bun src/cli.ts stop <id>` help with operations.

## Deploying on Dokploy

Tandem deploys as one Compose service on an ordinary Dokploy server (no KVM or other host changes).

1. In Dokploy, create a **Compose** service of type **Docker Compose** (not Stack: Swarm stacks drop
   `cap_add` and `security_opt`) from this repository, compose path `compose.yaml`.
2. In **Environment**, set the production variables from `.env.example`: `AUTH_MODE=oidc` with
   `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URL`, a random `SERVICE_SECRET` (keep it: changing it
   orphans every home), `MCP_ALLOWED_ORIGINS` (your app's origin) and, as needed, `EGRESS_ALLOW_DOMAINS`
   and `IDLE_MINUTES`. Dokploy writes them to `.env`, which `compose.yaml` reads.
3. In **Domains**, add your Tandem hostname for service `tandem`, port `8787`, with HTTPS. Dokploy's
   proxy reaches the container over its own network; the `127.0.0.1` port binding in `compose.yaml` is
   for local use (set `GATEWAY_PORT` if 8787 is taken on the server).
4. Deploy. The build compiles the runtime system into the Tandem image (about 2 GB; build time is
   mostly the vendor downloads). Health: `GET /healthz`. At startup the gateway creates a test sandbox
   and refuses to start, naming what is missing, if the container lacks the rights `compose.yaml` gives
   it.

Back up the `tandem-data` volume to keep people's homes (their sign-ins and conversations). Your app
reaches Tandem at its domain, and Tandem's gateway reaches your app's MCP endpoint at the origins in
`MCP_ALLOWED_ORIGINS`.

## API

Every `/v1` request needs `Authorization: Bearer <service JWT>`; `sub` is the person. Anything else is
`404`. Errors are `{ "error": "<code>", "message": "<English fallback>", "params": { … } }`: clients
translate by code (see [Error codes](#error-codes)).

**When a runtime runs.** Reads (`GET`) never start a person's runtime, so an app may prefetch with them
when the person signs in to it. Opening `GET /v1/events` starts it: open the stream when your assistant
UI opens, not before. Any change (`POST`, `PUT`, `PATCH`, `DELETE`), such as sending a message, starts it
too. While the runtime is stopped, `GET /v1/providers` answers at once from memory; every other read
answers `409 runtime_stopped`, and a read that arrives while the runtime is starting waits for it. A
runtime stops after `IDLE_MINUTES` without requests, but never while one of the person's event streams is
open, a run is in progress or a sign-in is waiting; the idle time counts from the last stream closing.
While a stream is open, a runtime that stops on its own (a crash, `docker stop`) is restarted at once.

| Method and path | Purpose |
| --- | --- |
| `GET /v1/providers` | `{ providers: [{ id: "claude"\|"codex"\|"grok"\|"openrouter"\|"gemini", status: "connected"\|"not_connected"\|"connecting"\|"unknown", method: "subscription"\|"api_key"\|null, account: { email, plan }\|null, models: [{ id, name, default, efforts, defaultEffort }], checkedAt }] }`. Models come from the account's live catalog and are empty until connected. A model's `name` is what the vendor calls it, without a harness prefix ("Opus 5.5", "GPT-6-Luna"); Claude's are read from the person's own Claude Code shortly after it connects and arrive as `provider.updated`, until then Claude's aliases ("Opus"); OpenRouter's are OpenRouter's own ("DeepSeek: DeepSeek V4.1 Flash 1017"); Gemini's are those Google's agent reports for the key ("Gemini 4 Carbon", IDs such as `antigravity/gemini-4-carbon`). `default: true` marks the vendor's default (Claude's `claude-code/default`; the other vendors have none): its `name` is the model it currently resolves to ("Sonnet 5.5"), or `null` until known, and the client labels it as the default in its own language. `checkedAt` (ISO time) is when this was read from the person's runtime. Never starts the runtime. While it is stopped or starting, the answer comes at once from the gateway's memory, with that older `checkedAt`; open `/v1/events` to start it and receive the live state as `provider.updated` once it is up. A provider not read since the gateway started (after a gateway restart, until the person's runtime has run) is `status: "unknown"` with `checkedAt: null`, `method: null`, `account: null` and no models: show it as loading, not as signed out. A provider whose turn failed with `signin_required` reports `not_connected` until the person signs in again. |
| `POST /v1/providers/:id/connect` | Starts the vendor sign-in, answers `{ connection }` once the vendor page is ready. Claude also accepts `{ "method": "api_key", "apiKey": "sk-ant-…" }`; OpenRouter and Gemini accept only `{ "method": "api_key", "apiKey": "sk-or-…" }` and `{ "method": "api_key", "apiKey": "AIza…" }`. |
| `GET /v1/providers/:id/connect` | Current `{ connection }` (or `null`). |
| `POST /v1/providers/:id/connect/code` | `{ code }` from the Claude page. A rejected code answers `status: "waiting"` with `error.code` `wrong_code` (paste the whole code again) or `wrong_code_reissued` (Claude refused it for good: `url` is a new sign-in page to open again). |
| `DELETE /v1/providers/:id/connect` | Cancels the sign-in. |
| `DELETE /v1/providers/:id` | Signs out with the vendor CLI and removes its credentials from the home (for OpenRouter and Gemini: the key). |
| `GET /v1/events` | Server-Sent Events for this person only: `provider.updated`, `conversation.run`, `conversation.message`, `conversation.delta`, `conversation.question`, `conversation.context` (`{ conversationId, context }`, the same `context` as above after each measurement, `null` after compaction). Opening it starts the person's runtime, and it keeps the runtime from stopping while it is open. Its first `provider.updated` for each provider is the live state, sent once the runtime is up. The stream closes when the token expires; reconnect with a fresh one. |
| `POST /v1/conversations` | `{ provider, model, effort?, title? }` → `201 { conversation }`. |
| `GET /v1/conversations` | `{ conversations, nextCursor }`, newest activity first. `?limit=` (1-200, default 50), `?cursor=<nextCursor>` for the next page, `?query=` to search titles (case-insensitive). |
| `PATCH /v1/conversations/:id` | `{ title }` (1-200 characters, or `null` for the generated title) → `{ conversation }`. |
| `DELETE /v1/conversations/:id` | Archives the conversation → `204`. It leaves every list and takes no messages; Happy keeps its history. |
| `GET /v1/conversations/:id/messages` | `{ conversation, messages, runs, hasMore, question, context, usage }`; `?before=<runId>&limit=` pages back. `context` is `{ usedTokens, limitTokens, approximate }`: the latest measured conversation size against the point where the agent compacts it automatically (so 100% is when compaction happens), or `null` before the first measurement and right after compaction. `usage` is the conversation's lifetime `{ input, output, cacheRead, cacheWrite }` tokens on that measured model, or `null`. |
| `POST /v1/conversations/:id/messages` | `{ text, model?, effort?, mcpAuth?, context? }` → `202 { message, conversation }`. `text` is at most 100 000 characters. `mcpAuth` is `{ "<server name>": "<Authorization header value>" \| null }` for registered MCP servers: held in gateway memory only, latest wins, `null` forgets it, and all are cleared when the runtime stops or the gateway restarts. `context` (at most 16 000 characters) is a hidden preamble for this message only: the agent receives it, but it is never returned as user text by `GET …/messages` or in events. |
| `POST /v1/conversations/:id/abort` | Stops the current run. |
| `POST /v1/conversations/:id/questions/:questionId` | `{ answer }`: an option label, a list of labels, or `{ "<promptId>": [...] }`. Used for permission questions, including those an MCP server asks. |
| `GET /v1/mcp-servers` | `{ servers: [{ name, url, enabledTools, description, hasCredential }] }`. |
| `PUT /v1/mcp-servers/:name` | `{ url, enabledTools?, description? }` → `201` (new) or `200 { server }`. Registers a Streamable HTTP MCP server for this person; no credentials here. `name`: a lowercase letter, then up to 31 lowercase letters, digits or `_`. `url`: `http` or `https`, an origin allowed by `MCP_ALLOWED_ORIGINS`. `enabledTools`: only these tools are offered and callable. At most 20 servers. |
| `DELETE /v1/mcp-servers/:name` | Removes the server and forgets its credential → `204`. |
| `GET /v1/instructions` | `{ text }`: the person's standing instructions (empty when none). |
| `PUT /v1/instructions` | `{ text }` (at most 64 000 characters; empty clears them) → `{ text }`. Written into the chat workspace as `AGENTS.md` (Codex, Gemini's Antigravity CLI, and Happy's own loop for Grok and OpenRouter) and `CLAUDE.md` (Claude Code), so every agent loads them in new conversations. |

`connection` is `{ status: "waiting"|"connected"|"failed"|"cancelled"|"expired", flow: "paste_code"|"device_code"|"api_key", url, userCode, expiresAt, error: { code, message, params }|null, account }`.

Messages are normalized for a chat UI: `{ id, runId, role: "user"|"assistant"|"error", createdAt, text, tools: [{ id, name, status }], failure }`.
Runs are `{ id, status: "running"|"completed"|"aborted"|"failed", failure }`. A message with
`role: "error"` and a failed or aborted run carry a typed `failure: { code, message, params }`.

Other unauthenticated routes: `GET /healthz`, `GET /connect` (demo page), and `POST /dev/token` only when
`AUTH_MODE=dev` and `DEV_TOKEN_ROUTE=true`.

### Error codes

Clients word errors in their own language by `code`, never by `message`. Everything that goes wrong
carries a stable snake_case code and a `params` object with each value a sentence about it needs (`{}`
when there are none). `message` is an English fallback for simple clients such as the demo page: its
wording is not part of the contract and may change, and for the provider's own failures (`usage_limit`,
`rate_limited`, `provider_unavailable`, `network`, `context_too_long`) it is the provider's text. A
code keeps its meaning; new codes may be added, so word a code you do not know like the generic one of
its kind (`failed`, `sign_in_failed`, or a generic error).

Codes arrive in three places:

- **HTTP error**: the body of every `/v1` error response, for example
  `{ "error": "signin_required", "message": "Connect your ChatGPT account first.", "params": { "provider": "codex" } }`.
- **Connection error**: `connection.error`, wherever a `connection` appears (the `/connect` routes and
  `provider.updated`), for example
  `{ "code": "invalid_api_key", "message": "Google didn't accept that API key, …", "params": { "provider": "gemini" } }`.
- **Run failure**: `failure` on a message with `role: "error"` and on a run that `failed` or was
  `aborted`, in `GET /v1/conversations/:id/messages` and in the `conversation.message` and
  `conversation.run` events, for example
  `{ "code": "usage_limit", "message": "<the provider's text>", "params": { "provider": "claude", "resetsAt": "2026-11-20T08:00:00.000Z" } }`.

`provider` is a provider id (`claude`, `codex`, `grok`, `openrouter`, `gemini`); the client names the
vendor itself. In a run failure it is `null` when the failure names no provider Tandem offers. Times
are ISO 8601.

| Code | Appears as | Meaning | `params` |
| --- | --- | --- | --- |
| `unauthorized` | HTTP 401 | No valid service token. | |
| `not_found` | HTTP 404 | No such route, conversation or MCP server for this person. | |
| `invalid_json` | HTTP 400 | The body is not a JSON object. | |
| `too_large` | HTTP 413 | The request body is over 1 MB. | |
| `invalid_request` | HTTP 400 | A malformed request, which is a client bug; `message` tells its developers what is wrong. | |
| `text_too_long` | HTTP 400 | Text the person wrote is over its limit: a message's `text` (100 000 characters), a conversation `title` (200), standing instructions (64 000) or a search `query` (200). The person shortens it. | `maxLength` |
| `invalid_api_key_format` | HTTP 400 | The pasted API key cannot be one: too short, too long or with other characters. | `provider` |
| `invalid_code` | HTTP 400 | The pasted sign-in code is empty, too long or contains control characters. | |
| `invalid_answer` | HTTP 400 | The answer names no option, or leaves a prompt unanswered. | |
| `runtime_stopped` | HTTP 409 | A read while the person's runtime is stopped; opening `/v1/events` starts it. | |
| `not_waiting_for_code` | HTTP 409 | A code was sent, but no sign-in of this provider is waiting for one. | |
| `signin_required` | HTTP 409 | A new conversation on a provider that isn't connected. | `provider` |
| `question_not_pending` | HTTP 409 | The question isn't waiting for an answer (any more): answered meanwhile, ended with its run, or unknown. | |
| `conversation_has_no_model` | HTTP 409 | The conversation has no model to continue with; start a new conversation. | |
| `too_many_servers` | HTTP 409 | The person already has as many MCP servers as allowed. | `maxServers` |
| `conflict` | HTTP 409 | Something in the workspace changed meanwhile; try again. | |
| `model_unavailable` | HTTP 422 | The connected account doesn't offer this model (any more); pick another. | |
| `invalid_effort` | HTTP 422 | The model doesn't offer this effort. | `efforts`: the ones it offers |
| `runtime_unavailable` | HTTP 503 | The person's workspace didn't answer (restarting, or failing); try again shortly. | |
| `wrong_code` | connection error, status `waiting` | The pasted code wasn't accepted; the same sign-in still waits for the whole code. | |
| `wrong_code_reissued` | connection error, status `waiting` | Claude refused the code for good, so Tandem started a new sign-in: the person opens the new `url` and pastes the code it shows. | |
| `expired` | connection error, status `expired` | The sign-in timed out; start again. | |
| `sign_in_failed` | connection error, status `failed` | The sign-in ended without signing in (it failed or was interrupted); start again. | |
| `unavailable` | connection error, status `failed` | Sign-in can't be offered right now; try again later. | |
| `invalid_api_key` | connection error, status `failed` | The provider refused the API key, or couldn't be reached to check it. | `provider` |
| `signin_required` | run failure | The account's sign-in is missing or expired, or its API key was refused; connect it again. The provider reports `not_connected` until then. | `provider` |
| `model_unavailable` | run failure | The account can't use this model; pick another. | |
| `usage_limit` | run failure | The account's plan or quota is used up. | `provider`; `resetsAt`: when it resets, or `null` when the provider didn't say |
| `rate_limited` | run failure | The provider is limiting requests; wait a moment, then retry. | `provider` |
| `provider_unavailable` | run failure | The provider is down or overloaded; retry later. | `provider` |
| `network` | run failure | The workspace couldn't reach the provider; retry. | `provider` |
| `context_too_long` | run failure | The conversation no longer fits the model's context; start a new conversation or pick a model with a larger one. | `model`: the model's `id`, or `null` |
| `aborted` | run failure | The run was stopped on request. | |
| `failed` | run failure | Any other failure, whose details are kept back; retry. | |

## The connect flow

1. Open `/v1/events` when the person opens your settings screen, and call `GET /v1/providers` for the
   first view. The stream starts their runtime (about 2 s for a new person, about 1 s for a stopped
   one), so the sign-in itself starts in well under a second. The providers answer comes at once from
   what the gateway last read (`checkedAt`, or `unknown` after a gateway restart), so show it and apply
   the `provider.updated` that follows.
2. **Claude** (`flow: "paste_code"`): open `url` in a new tab. After approving, Claude's page shows a code;
   the person pastes it and you send it to `/connect/code`. A code Claude refuses comes back as
   `wrong_code` with the sign-in still waiting. When Anthropic itself refuses the code, Tandem starts a
   fresh attempt automatically and returns its new `url` with `wrong_code_reissued`: the person opens
   the sign-in page again and pastes the new code.
3. **Codex** and **Grok** (`flow: "device_code"`): show `userCode` large, with a copy button and a link to
   `url`, and a countdown to `expiresAt`. The connection turns `connected` on its own; listen for
   `provider.updated`. Grok runs the Grok CLI's own `grok login --device-auth`; the person confirms the
   code on xAI's page.
4. **Claude, OpenRouter or Gemini with an API key**: `POST /connect` with `method: "api_key"`
   (OpenRouter and Gemini have no other way). The key is written to the person's home, becomes Happy's
   documented `api_key` setting for that account, and is verified; a refused key is removed again. Happy's
   own provider check verifies Claude and OpenRouter keys (for OpenRouter one minimal request to the first
   model in `runtime/happy.toml`, billed to that key; an account without credits is refused too). A
   Gemini key is checked by asking Google for its model list from inside the runtime, which costs
   nothing (Happy's check cannot vouch for it). Create one in Google AI Studio.
5. After any successful sign-in Tandem restarts that runtime once it is idle, so the vendor harnesses
   load the new account and its real model list. This is invisible apart from a few seconds of
   `connecting`.

`public/connect.html` is a framework-free reference implementation of these screens.

## Connecting your app's MCP server

Your app can give each person's agent its own MCP server (Streamable HTTP), called with **that person's
own credentials**, so the server enforces exactly what the person may see and do.

1. **Allow the origin.** Set `MCP_ALLOWED_ORIGINS=https://app.example.com` on the gateway. The gateway sends
   people's credentials to these origins only; nothing can be registered while it is empty.
2. **Register the server for the person** (no credentials here), for example when they open your chat:

   ```sh
   curl -X PUT "$TANDEM/v1/mcp-servers/app" -H "authorization: Bearer $SERVICE_JWT" \
     -H 'content-type: application/json' \
     -d '{"url":"https://app.example.com/mcp","description":"Our app","enabledTools":["lookup_customer"]}'
   ```

   The registration is stored in the person's home, signed by the gateway (a copy edited inside the
   runtime is ignored), and survives restarts. A change to the servers or `enabledTools` restarts the
   person's runtime once it is idle, because Happy reads its MCP configuration when it starts. Optionally
   `PUT /v1/instructions` with standing instructions about your app.
3. **Send the person's current credential with every message**, exactly the `Authorization` header your
   MCP server expects, plus any per-message context:

   ```json
   POST /v1/conversations/:id/messages
   { "text": "Who is my next client?",
     "mcpAuth": { "app": "Bearer <the person's current token>" },
     "context": "The person is on the calendar page, viewing 2026-11-17." }
   ```

   Send a fresh credential each time: the latest one wins, and Tandem forgets them all when the runtime
   stops. The agent sees the context in front of the message; the person never sees it in history or
   events.

The agent calls your tools as `mcp__app__<tool>`. How a call travels:

- Each runtime's `mcp.toml` lists your server as `http://127.0.0.1:8790/mcp/<runtime id>/app`: inside the
  sandbox that port is relayed to a Unix socket of the gateway that is mounted into this runtime's
  sandbox only. Calls are authenticated with a per-runtime proxy token from the daemon's environment
  (`MCP_PROXY_TOKEN`). Your URL and the person's credential never enter the runtime.
- The proxy accepts a request only with the right token **and** on that runtime's own socket, looks up
  the person's registration, and forwards the request to your `url` with the
  person's latest `mcpAuth` value as `Authorization`. JSON responses and SSE streams pass through
  unchanged, including questions your server asks mid-call (MCP elicitation), which reach the person as
  permission questions on `GET /v1/events` and are answered through `/v1/.../questions`.
- Before the first credential arrives, the proxy holds the runtime's MCP handshake (up to about ten
  minutes) instead of failing it, and a message that brings the credential waits briefly until the tools
  are listed.
- With no credential, or when your server answers `401`, the agent's tool call returns the error
  `Sign-in for <name> expired or is missing. Send a new message to continue.`, which the agent relays; the
  spent credential is dropped. Your server's `403` becomes `<name> refused this request (access denied).`
  The proxy never answers `401` to the runtime, so the connection stays usable for the next credential.
- `enabledTools` is written to Happy's `enabled_tools` and enforced by the proxy as well.

MCP tools need `PERMISSION_MODE=auto` (the default): on Happy Agent 2026.11.6-preview.7 every MCP tool is
refused in `read_only` and `workspace_write`, even when the person allows the call. In `auto` the harness's
own reviewer (Claude Code's auto classifier, Codex's Guardian, and for Grok and OpenRouter Happy's own
Auto review, which runs on the conversation's own model and account) decides each call; what it hands
off becomes a permission question. Gemini is the exception: Antigravity's agent never asks before an MCP
call, so its MCP calls run without any review (Happy Agent's harness documentation), and it registers
only small MCP tools directly; larger ones it may fail to load.

## Configuration

All settings are environment variables, documented with defaults in `.env.example`. The important ones:
`AUTH_MODE` (`oidc` with `OIDC_ISSUER`/`OIDC_AUDIENCE`/`OIDC_JWKS_URL`, or `dev`), `SERVICE_SECRET`,
`IDLE_MINUTES` (default 2; a vendor process never stops while a run, a question or a sign-in is open),
`PERMISSION_MODE` (default `auto`, the safest mode in which MCP tools run; never use `full_access` for
people's chats), `MCP_ALLOWED_ORIGINS` for application MCP servers, the limits per person
(`RUNTIME_MEMORY_MB`, `RUNTIME_PIDS`; defaults 1024 MiB and 512 processes, for all of a person's
processes together), and
the egress settings under [Security](#security). `RUNTIME_PREFIX` names
every sandbox of one instance.

Each runtime keeps all its state in its home (`DATA_DIR/homes/<id>`, on the `tandem-data` volume):
Happy's database, the conversations, the vendor sign-ins and the agents' working folder. Tandem has no
database of its own.

### Capacity

- **A stopped runtime** costs only its home on disk: Happy's database, the conversations and the
  sign-ins, a few MiB. The 341 MiB Claude Code copy that Happy unpacks for each person lives in their
  temporary directory, which exists only while their runtime runs.
- **A running runtime** is a few processes: in the tests (`evidence/e2e-sandbox.txt`) a started daemon
  held about 115 MiB of its own memory, plus about 340 MiB of page cache from Happy's freshly unpacked
  Claude Code that the kernel reclaims first under pressure; the 424 MiB Happy Agent binary is shared
  by every sandbox, so it counts once. The gateway and the egress proxy together held about 20 MiB. A
  turn adds whatever the agent's tools use, up to `RUNTIME_MEMORY_MB`.
- **Start-up:** a person's live state arrives about 1.2-1.7 seconds after their event stream opens,
  the first time included (2 vCPUs, no KVM).
- **Limits:** each person's cgroup caps the memory and processes of all of their sandboxes
  together; above 80 % of `RUNTIME_MEMORY_MB` the kernel reclaims their caches and slows them down,
  and at the limit it ends one process tree (the one using the most), not the person's others. CPU is
  shared by weight (no per-person quota, which would only leave CPUs idle): the gateway's own cgroup
  weighs four times all sandboxes together and keeps 128 MiB protected from reclaim. The gateway sets
  this up inside its own container at startup (cgroup v2 hosts, which current Ubuntu and Debian are);
  on a host without cgroup v2 it logs a `WARNING:` and only the per-uid process limit applies.
  `RUNTIME_MEMORY_MB` is per person, so for a server shared with other apps also cap the whole
  container (`mem_limit` in `compose.yaml` or Dokploy's resource settings); sandboxed processes are
  ended before the gateway when the container runs out of memory.

## Operations and upgrades

**Restarting or redeploying.** On `SIGTERM` the gateway stops every running sandbox gracefully, then
exits (`stop_grace_period: 60s` in `compose.yaml`; `init: true` reaps processes). After a restart
nothing runs until it is used again: reads answer from memory (`unknown` after a restart, see Other
notes), and opening `/v1/events` starts the person's sandbox. What a restart interrupts:

- Runs in progress stop; their conversations stay in the person's home.
- Open `/v1/events` streams close. Reconnect them (as `EventSource` does); the first
  `provider.updated` per provider after reconnecting is the live state.
- `mcpAuth` credentials live in the gateway's memory only. Until the next message brings them again,
  MCP tool calls answer `Sign-in for <name> expired or is missing`.

**A sandbox stopped or crashed outside the gateway** is started again as soon as the person's event
stream is open, or on their next request.

**Upgrading.** Rebuild and recreate the container (`docker compose up -d --build`, or redeploy in
Dokploy). The runtime system is part of the image, so every sandbox started afterwards runs the new
version; homes are kept.

**Upgrading from an older Tandem (0.1, Docker volumes).** Copy each `tandem-home-<id>` volume's
contents to `DATA_DIR/homes/<id>` in the new data volume (same `<id>`, same `SERVICE_SECRET`); the
gateway hands each home to the person's new uid on their first start. Then remove the old
`tandem-rt-*` containers, `tandem-net-*` networks, the egress proxy container and, if used, the socket
proxy.

## Security

The threat Tandem is built against: an agent with a shell inside its runtime (possibly steered by
prompt injection) tries to reach other people's runtimes or the host, or what it should not over the
network. The gateway logs one `security:` line at startup; `GET /healthz` reports the egress mode.

### 1. A sandbox per person

Every runtime runs under crun with the OCI spec in `src/security.ts`: the person's own uid, no
capabilities (all five sets empty), `no_new_privs`, its own PID, network, IPC, UTS, cgroup and mount
namespaces, the runtime system read-only, `/proc` and `/sys` restricted the way Docker restricts them,
a `noexec` `/tmp`, and exactly these host paths: the person's home and temporary directory (writable),
their `/etc/passwd` and `/etc/group`, the egress socket and their MCP socket.

- **Seccomp:** Docker's own default profile (pinned in `runtime/seccomp-docker-default.json`),
  converted for a process without capabilities: exactly what an ordinary unprivileged Docker container
  may call. `mount`, `unshare`, `setns`, `bpf`, `keyctl` and the like, which Docker allows the Tandem
  container itself because it holds `SYS_ADMIN`, are refused inside every sandbox.
- **Limits:** each person's cgroup (`/sandboxes/<prefix>-<id>` in the container's cgroup tree) with
  `RUNTIME_MEMORY_MB` and `RUNTIME_PIDS` for all of their sandboxes, each sandbox a child cgroup ended
  as a whole when the person runs out of memory (`memory.oom.group`), plus a per-uid process limit.

The sandboxes share the host's kernel, like containers do. What the Tandem container needs to create
them, and nothing more (`compose.yaml`): `cap_add: [SYS_ADMIN, NET_ADMIN]` (namespaces, mounts and
each sandbox's cgroup, and bringing up each sandbox's loopback) and `security_opt: [apparmor=unconfined]` (Docker's default
AppArmor profile forbids mounts). The gateway runs as root inside the container to do that; the agents
never do. Without those rights the gateway refuses to start and names them.

Codex's own bubblewrap sandbox and Happy's own sandbox (used by Grok and OpenRouter shell commands)
need user namespaces inside the sandbox, which this design does not grant: Codex's cannot create its
namespaces (Tandem's sandbox remains the boundary), and Grok and OpenRouter shell commands fail
(`create user namespace: Operation not permitted`) while chat, file tools and MCP tools work.

### 2. What a sandbox can reach

A sandbox's network namespace has loopback only. Its two ways out are Unix sockets of the gateway,
mounted into it and relayed to loopback ports by its entrypoint:

- **The Internet, through the egress proxy** (`HTTPS_PROXY`/`HTTP_PROXY`, honoured by Claude Code,
  Codex, the Grok CLI, Happy, git and curl): Stripe's [Smokescreen](https://github.com/stripe/smokescreen),
  run by the gateway on the container's loopback. It allows only the hostnames in
  `runtime/egress-allowlist.txt` (Anthropic, OpenAI/ChatGPT, xAI's sign-in `auth.x.ai` and Grok
  endpoint `cli-chat-proxy.grok.com`, `openrouter.ai`, the Gemini API
  `generativelanguage.googleapis.com`, GitHub) plus `EGRESS_ALLOW_DOMAINS`, and refuses private,
  loopback, link-local and CGNAT addresses in every mode. Vendor telemetry outside the list is refused.
  `EGRESS_MODE=open` allows any public host.
- **The gateway's MCP proxy**, through a socket that is mounted into this person's sandbox only
  (`DATA_DIR/run/<id>/mcp.sock`): a request on it can only come from that person's runtime.

Other people's sandboxes, the gateway's API and every other address are unreachable. People open the
vendors' sign-in pages (`accounts.x.ai` for Grok) in their own browser, not in the runtime. The
gateway itself (not the runtimes) calls your app's MCP servers, only at `MCP_ALLOWED_ORIGINS`.

| Setting | Default | Effect |
| --- | --- | --- |
| `EGRESS_MODE` | `allowlist` | `allowlist`: the hosts above; `open`: any public host |
| `EGRESS_ALLOW_DOMAINS` | empty | extra hostnames, e.g. `registry.npmjs.org,pypi.org,files.pythonhosted.org,git.example.com`; `*.example.com` covers subdomains only |
| `EGRESS_ALLOW_RANGES` | empty | private IPv4 CIDRs runtimes may reach anyway, e.g. an internal registry |

### Happy's own agent loop (Grok and OpenRouter)

Claude and Codex conversations run on the vendors' unmodified agents (Claude Code, Codex), as before.
Grok and OpenRouter have no agent of their own that Happy can run, so `runtime/happy.toml` turns on
Happy's own agent loop (`[harnesses.happy]`) for exactly those two accounts: their turns use Happy's
prompt, tools, sandbox and compaction with the vendor's model. Consequences:

- **Reviews.** In `auto`, Happy's own Auto review decides each shell command and MCP call that needs
  one, on the conversation's own model and account (it uses the person's quota or credits).
- **No sub-agents.** Happy chooses sub-agent routes per account, not per conversation, so a Grok
  conversation could otherwise start OpenRouter work and the reverse. Both accounts therefore offer no
  models for sub-agents (`include_subagent_models = []`), and Happy's loop reaches no other harness.
- **OpenRouter models** are a fixed list in `runtime/happy.toml` (`[providers.openrouter] models`), each
  of which must support tool calling and must not need reasoning signatures passed back between tool
  calls: Happy's Chat Completions client keeps none, which rules out Gemini (Google requires them) and
  Claude (OpenRouter's reasoning guide asks for them) there. Happy reads
  their names, context windows and efforts from OpenRouter. Edit the list and rebuild the image to
  change it.
- **The OpenRouter key** is the person's own: written by the gateway to the person's home and put into
  the generated `happy.toml` as Happy's `api_key` at each start, like the Anthropic key, never into a
  process environment. The person's own agent can read it, as it can every file in the home.

### Gemini: Google's agent on the person's own API key

Gemini conversations run on Google's own agent, the Antigravity CLI (`agy acp`, Happy's `antigravity`
harness), on the person's own Gemini API key; their models are the ones it reports for that key. The
entrypoint gives the key to the harness as `api_key`, which Happy hands to `agy` as `GEMINI_API_KEY`
(so it is in that agent's process environment, readable by the commands it runs), and points `agy` at
the Gemini API (`modelProvider` in `~/.gemini/antigravity-cli/settings.json`), so Antigravity's own
Google sign-in is never used. Without a key the harness is off. Its sub-agents stay on it. Why not the
other routes:

- **Antigravity's own sign-in.** It could be driven (`agy acp --login` prints a Google page and takes a
  pasted code even without a terminal; `agy -p`, which Happy runs, needs one), but Google's terms
  forbid it: "Using third-party software, tools, or services to access Antigravity is a violation of our
  Terms of Service … To use a third-party coding agent with Gemini, we recommend using a Gemini
  Enterprise or Google AI Studio API key." (<https://antigravity.google/docs/faq>)
- **Google's OpenAI-compatible endpoint on Happy's own loop.** Gemini 3 and 4 models refuse a tool call's
  follow-up unless their thought signatures come back with it, and Happy's Chat Completions client
  (this and the latest release) drops them, so every turn that uses a tool would fail.

A key Google refuses after it was connected shows up as the agent's reply ("API key not valid"), not as
a typed failure: Antigravity reports it as text and ends the turn normally.

### Other notes

- **Tokens.** Service JWTs are verified on every request; event streams close when the token expires. In
  production use `AUTH_MODE=oidc`. Development tokens (`AUTH_MODE=dev`) are for local use only;
  runtimes cannot reach `POST /dev/token` (or any gateway route) at all.
- **Secrets in transit.** Login codes and API keys pass through the gateway in memory only: they are not
  logged, stored or echoed (unit-tested). Error responses never include request or daemon bodies.
- **Last-known provider state.** For a stopped runtime the gateway answers `GET /v1/providers` from the
  views it last read (status, method, account e-mail and plan, models, `checkedAt`), kept in memory per
  person: no tokens, keys or codes. It is not persisted. After a restart the answer is `unknown` until
  the runtime has run. Answering a read is never a reason to start a runtime: an app that prefetches at
  sign-in must not start every person's sandbox.
- **Application credentials.** `mcpAuth` values live only in the gateway's memory, keyed by person, and go
  only to that person's registered URL on an allowed origin (no redirects followed). The runtime's proxy
  token is in its daemon's environment, so the person's agent can read it; it is useless elsewhere,
  because the proxy accepts it only on that person's own socket. With it the agent can do what its
  MCP tools already can. Keep `MCP_ALLOWED_ORIGINS` to your own app: the gateway can reach networks the
  runtimes cannot.
- **Images.** Every download in the `Dockerfile` is pinned and checksum-verified, and the npm
  dependencies are locked in `bun.lock`. Do not publish Tandem images (see
  Vendor terms).

## Vendor terms

Each person signs in with their own account to the unmodified official CLIs, through the vendors' own
sign-in pages, or uses their own API key; Tandem never pools or shares accounts. Operators are
responsible for complying with Anthropic's, OpenAI's, xAI's, Google's and OpenRouter's terms for their
deployment, including which accounts and plans may be used this way:

- Claude Code: <https://code.claude.com/docs/en/legal-and-compliance>
- Codex: <https://learn.chatgpt.com/docs/app-server#auth-endpoints>
- Grok: <https://x.ai/legal/terms-of-service> (the Grok CLI's source: <https://github.com/xai-org/grok-build>)
- Gemini: <https://ai.google.dev/gemini-api/terms> (API keys) and Antigravity's terms for its CLI
  (<https://antigravity.google/docs/faq>; Tandem never uses an Antigravity sign-in)
- OpenRouter: <https://openrouter.ai/terms>

Claude Code is proprietary to Anthropic. The runtime image downloads it from Anthropic's official npm
package at build time; prebuilt images containing it must not be published. See `THIRD_PARTY.md`.

## Limitations

- Sandboxes share the host kernel (as containers do). They are not virtual machines; the isolation is
  Linux namespaces, a uid per person, no capabilities and seccomp (see Security).
- One Tandem container serves one server's capacity. Several Tandem containers on several servers need
  your app to send each person to the same one.
- Pinned to Happy Agent 2026.11.6-preview.7, Codex 0.160.1, Claude Code 2.1.321, the Grok CLI 1.0.89,
  the Antigravity CLI 1.5.11 and Smokescreen 0.1.0, for linux/arm64 and linux/amd64; crun comes from
  Debian trixie.
- Happy's `claude_code` harness always starts the Claude Code copy embedded in Happy Agent (byte-identical
  to the official 2.1.321 build) and ignores the `executable` setting in this version.
- Grok and OpenRouter were verified without real accounts: Grok's device sign-in up to the code,
  OpenRouter's key check against OpenRouter, and Happy's own loop (Auto review, file and MCP tools)
  against a stand-in OpenRouter API. Gemini was verified up to Google's key check; no Gemini turn, tool
  call or MCP call has run with a real key.
- Gemini earlier read "not offered" here, because Antigravity's own sign-in fails under Happy (it needs a
  terminal) and Google's terms forbid it for third-party software. It is offered on the person's own
  Gemini API key instead (see Security, Gemini).
- Happy generates a conversation's title from its first messages, which include that message's
  `context`; set a `title` (or `PATCH` it) when the context must not show up there. Happy has no rename,
  so `PATCH` titles are kept by the gateway in the person's home.
- MCP server and `enabledTools` changes apply after the automatic idle restart; standing instructions
  apply to new conversations.
- The signed registration file can be rolled back by the person's own agent to an earlier version the
  app registered for that same person; it cannot point anywhere the app did not.

## License

MIT. Third-party components and their terms: `THIRD_PARTY.md`.
