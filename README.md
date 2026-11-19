# Tandem

Tandem gives every person their own private, always-resumable AI workspace behind one small HTTP API:
Claude Code, Codex, Grok, Gemini and OpenRouter models. Each person signs in with **their own**
Claude, ChatGPT or Grok account through the vendor's own sign-in, or brings **their own** Anthropic,
Gemini or OpenRouter API key, inside **their own** Linux container. Your application talks to Tandem; Tandem
never sees passwords and never shares an account between people.

Under the hood each workspace runs one unmodified [Happy Agent](https://github.com/slopus/happy-agent)
daemon with the official Claude Code, Codex, Grok and Google Antigravity CLIs. Tandem adds the parts a
multi-user service needs: authentication, one container per person, start-on-demand and idle stop, a narrow façade over
Happy's owner-level API, and a friendlier sign-in flow.

## How it is isolated

- **One container and one volume per person.** Names are `tandem-rt-<id>` and `tandem-home-<id>`,
  where `<id>` is an HMAC of the person's id (`sub` of the service JWT) under `SERVICE_SECRET`. The
  gateway derives the runtime only from the verified token, so one person can never address another's.
- **Vendor credentials stay in the person's volume.** `claude auth login`, `codex login` and
  `grok login --device-auth` run inside the container and store their sign-in there, and the gateway
  writes a person's own API key there. Tandem does not read, copy or log them.
- **The daemon token never leaves the gateway.** Happy's owner token (shutdown, drain, debug, config,
  bots, remote connections) is read once per runtime through the Docker exec API and kept in memory. The
  gateway can send only an allowlisted set of daemon requests (`src/happy.ts`).
- **A private network per person, no published ports.** Each runtime sits alone on its own internal
  network with the gateway and the egress proxy (see [Security](#security)). Inside it, a tiny `socat`
  bridge forwards TCP 24790 to the daemon's Unix socket and accepts connections from the gateway's
  address only; the daemon still requires its token on every request.
- **Application credentials stay in gateway memory.** The token your app sends for its own MCP server
  (`mcpAuth`) is held in the gateway's memory for that person only, never written to the container, a
  file or a log. The runtime reaches your MCP server only through the gateway's MCP proxy, which accepts
  a per-runtime token from that runtime's own address and adds the person's latest credential on the way
  out (see [Connecting your app's MCP server](#connecting-your-apps-mcp-server)).
- **Hardened defaults.** Built-in admin bot archived on every start, Happy relay/mobile/Tailcat off,
  sub-agents limited to their own harness (a Claude chat cannot start Codex work) and none at all on
  Grok and OpenRouter (see [Happy's own agent loop](#happys-own-agent-loop-grok-and-openrouter)), gVisor
  when the host has it, a non-root user without Linux capabilities, `no-new-privileges`, a read-only
  root filesystem, memory/CPU/process limits and an egress allowlist.

## Quick start (local)

Requirements: Docker Engine or Docker Desktop with Compose and Buildx, Bun 1.3.9, about 3 GB for
images. Runtimes build for **linux/arm64** and **linux/amd64**.

```sh
bun install --frozen-lockfile
docker buildx build --load -t tandem-runtime:2026.11.6-preview.7 runtime   # person runtime, host platform
docker buildx build --load -t tandem-gateway:0.1.0 .                       # gateway
docker buildx build --load -t tandem-egress:0.1.0 egress                   # egress proxy (Smokescreen)
# Both platforms (needs the containerd image store; never push these images):
#   docker buildx build --platform linux/arm64,linux/amd64 --load -t tandem-runtime:2026.11.6-preview.7 runtime
cp .env.example .env    # then set AUTH_MODE=dev, DEV_TOKEN_ROUTE=true and two random secrets:
                        #   DEV_AUTH_SECRET and SERVICE_SECRET (e.g. `openssl rand -hex 32` each)
docker compose up -d --no-build
open http://127.0.0.1:8787/connect                              # demo sign-in page
```

Checks:

```sh
bun run typecheck && bun test       # unit tests (fixtures from the pinned daemon, a stub MCP server)
bun scripts/e2e.ts                  # against the running stack (restarts its gateway once); its stub MCP
                                    # server needs MCP_ALLOWED_ORIGINS=http://host.docker.internal:8791 in .env
E2E_REAL_SUBJECT=<person> bun scripts/e2e.ts   # plus real turns, MCP tool calls included, for a person
                                    # whose volume holds real sign-ins
bun scripts/e2e-hardening.ts        # proves the protections below against the running stack
bun scripts/e2e-gateway-restart.ts  # recreates the gateway and the egress proxy (see Operations) with
                                    # event streams open: nothing is restarted, everything reconnects;
                                    # E2E_REAL_SUBJECT=<person> keeps a one-word turn in flight meanwhile
bun scripts/page-check.ts           # drives /connect in headless Chromium, screenshots to evidence/
                                    # (BROWSER_EXECUTABLE=/path/to/chromium if Playwright has none)
```

`bun scripts/token.ts <person>` prints a local development token for `curl`. `bun scripts/stub-mcp.ts`
runs the test MCP server on its own (a `lookup_customer` tool that requires `Bearer valid-…`).

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
| `DELETE /v1/providers/:id` | Signs out with the vendor CLI and removes its credentials from the volume (for OpenRouter and Gemini: the key). |
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
   (OpenRouter and Gemini have no other way). The key is written to the person's volume, becomes Happy's
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

   The registration is stored in the person's volume, signed by the gateway (a copy edited inside the
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

- Each runtime's `mcp.toml` lists your server as `http://<gateway>:8790/mcp/<runtime id>/app`, where
  `<gateway>` is the gateway's address on that runtime's own network (never a name, which gVisor cannot
  resolve, and in `NO_PROXY`, so the call bypasses the egress proxy), authenticated
  with a per-runtime proxy token from the runtime's environment (`MCP_PROXY_TOKEN`). Your URL and the
  person's credential never enter the runtime.
- The proxy accepts a request only with the right token **and** from that runtime's own address on the
  private network, looks up the person's registration, and forwards the request to your `url` with the
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
`RUNTIME_DOCKER_HOST`, `RUNTIME_IMAGE`, `IDLE_MINUTES` (default 5; a runtime never stops while a run, a
question or a sign-in is open), `PERMISSION_MODE` (default `auto`, the safest mode in which MCP tools run;
never use `full_access` for people's chats) and, for application MCP servers, `MCP_ALLOWED_ORIGINS`,
`MCP_PROXY_PORT` (default 8790, never published) and `MCP_PROXY_URL` (default: the gateway's address on
each runtime's own network). `RUNTIME_PREFIX` names every container, volume, network and label of one
instance, so several instances can share a Docker Engine (each with its own directory, `.env`, prefix
and `GATEWAY_PORT`). The hardening settings are described under [Security](#security).

Each runtime keeps all its state on its volume: Happy's database, the conversations, the vendor sign-ins
and the agents' working folder. Tandem has no database of its own.

## Operations and upgrades

**Restarting or redeploying.** The gateway and the egress proxy can be recreated at any time, together
or alone and in any order (`docker compose up -d`, with or without `--force-recreate` or `--no-deps`).
Running runtimes are not restarted and runs in progress continue. A runtime reaches both by address
(gVisor has no DNS), so each one keeps a fixed address on every runtime network: the gateway the
subnet's last address, the egress proxy the one before it. Docker gives every other container the
lowest free address, so nothing else takes them while either container is being recreated. At startup
and every 30 seconds the gateway puts itself and the egress proxy back at the addresses each running
runtime was created with, also when a recreated egress proxy got the gateway's address in the meantime.
What a restart does interrupt:

- Open `/v1/events` streams close. Reconnect them (as `EventSource` does); the first
  `provider.updated` per provider after reconnecting is the live state.
- `mcpAuth` credentials live in the gateway's memory only. Until the next message brings them again,
  MCP tool calls answer `Sign-in for <name> expired or is missing`.
- A recreated egress proxy drops the outbound connections that were open through it, and the vendor
  CLIs retry them. Under gVisor, new connections work again only after about 30 seconds (up to a
  minute): each sandbox notices the proxy's new hardware address at the same IP address only when its
  neighbour entry expires. Under runc they work at once. The gateway is reachable from runtimes at once
  either way, so a gateway-only redeploy has no such pause.

**When an address cannot be restored.** If another container holds the address a running runtime
expects, or the Docker Engine refuses fixed addresses (29.0 releases before 29.0.4 and 29.1 releases
before 29.1.3 do, moby#51583), the gateway logs a `WARNING:` and restarts that runtime at the current
addresses once nothing in it would be cut off: no run and no sign-in in progress. A question or a code
that waits for the person does not hold it up, because the person cannot answer it before the
restart. Meanwhile the person's providers show `connecting` and their requests answer
`503 runtime_unavailable`; then the live state follows on the stream. The volume is kept.

**Upgrading** from a version without fixed addresses: pull, rebuild the images (Quick start) and run
`docker compose up -d --no-build`. Running runtimes need nothing else: the new gateway reads from inside
each one the gateway and egress proxy addresses it was created with and takes them again, moving the
egress proxy if an earlier restart left it on the gateway's address, and they keep running. Runtimes
started afterwards get the fixed addresses. With the socket proxy, recreate the proxy together with the
gateway so that its new policy is active first (Compose does not notice a changed mounted file):
`docker compose -f compose.yaml -f compose.socket-proxy.yaml up -d --no-build --force-recreate docker-proxy gateway`.

## Security

The threat Tandem is built against: an agent with a shell inside its runtime (possibly steered by
prompt injection) tries to break out to the host, or to reach what it should not over the network.
Four protections stack up. Each has a safe default, is detected at startup, degrades with a `WARNING:`
line instead of locking anyone out when the host cannot provide it, and has an explicit setting to
require it or to relax it. The gateway logs one `security:` line with what it found at startup;
`GET /healthz` reports the egress mode. `bun scripts/e2e-hardening.ts` proves each one on a running
stack.

### 1. Sandbox: gVisor when available

`RUNTIME_OCI_RUNTIME=auto` (default) runs runtimes under gVisor (`runsc`) when the Docker Engine
offers it, so the agent talks to gVisor's user-space kernel instead of the host's. Without it, runtimes
use the Engine's default (`runc`) and the gateway warns. `default` accepts the Engine default silently;
any other value (`runsc`, `runsc-kvm`, `kata-runtime`) is required, and the gateway refuses to start
when the Engine lacks it. Docker Desktop has no gVisor: use a Linux host or VM for it.

Install gVisor on a Linux Docker host (x86_64 or arm64, kernel 5.6+), from
[gvisor.dev](https://gvisor.dev/docs/user_guide/install/):

```sh
sudo apt-get update && sudo apt-get install -y apt-transport-https ca-certificates curl gnupg
curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
  | sudo tee /etc/apt/sources.list.d/gvisor.list > /dev/null
sudo apt-get update && sudo apt-get install -y runsc    # the package registers runsc in /etc/docker/daemon.json
sudo systemctl reload docker
docker info --format '{{json .Runtimes}}'               # must list "runsc"; then restart the gateway
```

Happy Agent, Claude Code (including its Bash tool) and Codex run under gVisor; Codex's own
bubblewrap sandbox works there too, while under `runc` it cannot create namespaces (the container
remains the boundary). Grok and OpenRouter conversations run shell commands in Happy's own sandbox,
which needs the same user namespaces: under `runc` with the defaults below those commands fail
(`create user namespace: Operation not permitted`), while chat, file tools and MCP tools work. Gemini's
shell commands run in Antigravity's own sandbox, which was not exercised in this release's tests. Docker's
embedded DNS does not answer inside gVisor sandboxes, so runtimes get
the gateway and the egress proxy by address, never by name. Expect a slower first start of a fresh
volume (Happy unpacks Claude Code once) and more processes per runtime in `docker stats`.

### 2. Locked-down runtime containers

| Setting | Default | Effect |
| --- | --- | --- |
| `RUNTIME_USER` | `10001:10001` | the image's `agent` user; empty = the image's own user |
| `RUNTIME_CAP_ADD` | empty | `CapDrop: ALL` always; add back only what you need (comma-separated) |
| `RUNTIME_NO_NEW_PRIVILEGES` | `true` | setuid binaries cannot raise privileges |
| `RUNTIME_READ_ONLY_ROOTFS` | `true` | read-only root filesystem; writable: the person's volume (`/home/agent`) and a `noexec` `/tmp` tmpfs of `RUNTIME_TMPFS_MB` (256) |
| `RUNTIME_MEMORY_MB`, `RUNTIME_CPUS`, `RUNTIME_PIDS` | `2048`, `2`, `512` | `0` lifts a limit |

`TMPDIR` points into the volume (`~/.cache/tmp`), so the 341 MiB Claude Code binary Happy unpacks lands
there once per person instead of in memory or a container layer. A stopped runtime is recreated when
any of these settings, the image or its network changes; a running one is never cut off.

### 3. Narrow Docker access for the gateway

The plain Engine socket is root on the host. The gateway detects whether its Docker API is filtered
and warns when it is not (`RUNTIME_DOCKER_PROXY=auto`); `required` refuses to start without a filter,
`none` accepts the plain socket silently. The optional filter is
[Sockguard](https://github.com/CodesWhat/sockguard), a maintained Docker API proxy that inspects
request bodies (path- or section-based proxies such as Tecnativa's or wollomatic's cannot refuse a
privileged container):

```sh
docker compose -f compose.yaml -f compose.socket-proxy.yaml up -d
```

The gateway then talks to a Unix socket on a private volume (the proxy has no network at all). The
policy, `deploy/sockguard.yaml`, is default-deny: the gateway may only create, start, stop, inspect,
exec into and copy files into containers, volumes and networks that carry Tandem's ownership label
(`<RUNTIME_PREFIX>.home=1`, which every person volume has always had; Sockguard stamps it on whatever
the gateway creates). It cannot see or touch other containers, run privileged containers, add
capabilities, share host namespaces or devices, mount host paths, run another image, or exec as root
or anything but its own few commands. Notes:

- `RUNTIME_IMAGE` must be fully qualified (`docker.io/library/tandem-runtime:…`, the default).
- If the proxy logs `permission denied on upstream socket`, set
  `DOCKER_SOCKET_GID=$(stat -c %g /var/run/docker.sock)`. Rootless Docker: set `DOCKER_SOCKET` to
  `$XDG_RUNTIME_DIR/docker.sock`.
- Relaxing a runtime setting (another user, capabilities, no limits, another OCI runtime) needs the
  matching change in `deploy/sockguard.yaml`.
- The policy lets the gateway give itself and the egress proxy fixed addresses on runtime networks
  (`endpoint_config.allow_static_addressing`; MAC addresses, links and endpoint driver options stay
  refused), and run two read-only commands inside runtimes: one that prints the addresses a runtime
  was created with (the proxy hides container environments) and one that asks its daemon whether a run
  is in progress (see Operations).
- Containers created before switching to the proxy lack the label: remove the stopped
  `<prefix>-rt-*` containers once (they hold no data); volumes keep working.

### 4. Network isolation and egress control

Each runtime gets its own internal Docker network (`<prefix>-net-<id>`) shared only with the gateway
and the egress proxy, at fixed addresses (see Operations): no route out, no access to other runtimes,
other apps' containers or the host.
On Docker Engine 28+ the network is created in isolated gateway mode, so the host has no address on
it either; older Engines keep one and the gateway warns that services listening on all host
interfaces are reachable. Networks are removed when a runtime stops. If Docker runs out of address
pools, runtimes fall back to one shared internal network with a warning
(`RUNTIME_NETWORK_ISOLATION=auto`; `per_runtime` never falls back, `shared` always shares); enlarge
`default-address-pools` in `daemon.json` for many concurrent people.

All outbound traffic goes through the egress proxy, Stripe's
[Smokescreen](https://github.com/stripe/smokescreen) (`egress/`), via `HTTPS_PROXY`/`HTTP_PROXY`, which
Claude Code, Codex, the Grok CLI, Happy, git and curl honour (`NO_PROXY` lists the gateway). It allows
only the hostnames in `egress/allowlist.txt` (Anthropic, OpenAI/ChatGPT, xAI's sign-in `auth.x.ai` and
Grok endpoint `cli-chat-proxy.grok.com`, `openrouter.ai`, the Gemini API
`generativelanguage.googleapis.com`, GitHub) and refuses private, loopback,
link-local and CGNAT addresses in every mode. Vendor telemetry outside the list (for example Datadog
log intake, Antigravity's `play.googleapis.com`) is refused. People open the vendors' sign-in pages (`accounts.x.ai` for Grok) in their own
browser, not in the runtime.

| Setting | Default | Effect |
| --- | --- | --- |
| `EGRESS_MODE` | `auto` | `auto`/`allowlist`: the allowlist; `open`: any public host; `off`: no proxy, runtimes get direct Internet access (and the host and LAN). `auto` falls back to `off` with a warning when the proxy container is missing; an explicit mode is required |
| `EGRESS_ALLOW_DOMAINS` | empty | extra hostnames, e.g. `registry.npmjs.org,pypi.org,files.pythonhosted.org,git.example.com`; `*.example.com` covers subdomains only |
| `EGRESS_ALLOW_RANGES` | empty | private CIDRs runtimes may reach anyway, e.g. an internal registry |
| `EGRESS_PROXY` | `<prefix>-egress:4750` | the egress proxy container and port |

People's MCP servers keep working: runtimes reach them only through the gateway's MCP proxy (the
gateway's address on the runtime's network, port `MCP_PROXY_PORT`, outside the egress proxy), and the
gateway makes the upstream calls itself, only to `MCP_ALLOWED_ORIGINS`.

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
- **The OpenRouter key** is the person's own: written by the gateway to the person's volume and put into
  the generated `happy.toml` as Happy's `api_key` at each start, like the Anthropic key, never into a
  process environment. The person's own agent can read it, as it can every file on the volume.

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
  production use `AUTH_MODE=oidc`. Development tokens (`AUTH_MODE=dev`) are for local use only, and
  `POST /dev/token` refuses requests from runtime networks.
- **Secrets in transit.** Login codes and API keys pass through the gateway in memory only: they are not
  logged, stored or echoed (unit-tested). Error responses never include request or daemon bodies.
- **Last-known provider state.** For a stopped runtime the gateway answers `GET /v1/providers` from the
  views it last read (status, method, account e-mail and plan, models, `checkedAt`), kept in memory per
  person: no tokens, keys or codes. It is not persisted. After a gateway restart the answer is `unknown`
  until the runtime has run, instead of reading the volume: a stopped runtime's container is removed, so
  reading its files would mean creating a container just for that, outside the gateway's narrow Docker
  access. Answering a read is never a reason to start a runtime: an app that prefetches at sign-in must
  not wake every person's container.
- **Application credentials.** `mcpAuth` values live only in the gateway's memory, keyed by person, and go
  only to that person's registered URL on an allowed origin (no redirects followed). The runtime's proxy
  token is in its environment, so the person's agent can read it; it is useless elsewhere, because the
  proxy port is not published and the proxy also checks the caller's address. With it the agent can do
  what its MCP tools already can. Keep `MCP_ALLOWED_ORIGINS` to your own app: the gateway can reach
  networks the runtimes cannot.
- **Images.** Every download in `runtime/Dockerfile` and `egress/Dockerfile` is pinned and
  checksum-verified; Sockguard is pinned by digest. Do not publish runtime images (see Vendor terms).

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

- Pinned to Happy Agent 2026.11.6-preview.7, Codex 0.160.1, Claude Code 2.1.321, the Grok CLI 1.0.89 and
  the Antigravity CLI 1.5.11, for linux/arm64 and linux/amd64. `RUNTIME_PLATFORM` can run the non-native variant under emulation, which is slow and only
  meant for testing.
- Happy's `claude_code` harness always starts the Claude Code copy embedded in Happy Agent (byte-identical
  to the official 2.1.321 build) and ignores the `executable` setting in this version.
- Claude Code and Codex turns with real accounts were not run under gVisor in this release's tests
  (sign-in flows, Claude Code's Bash tool against a stand-in API and Codex's sandbox were). Grok and
  OpenRouter were verified without real accounts: Grok's device sign-in up to the code, OpenRouter's key
  check against OpenRouter, and Happy's own loop (Auto review, file and MCP tools) against a stand-in
  OpenRouter API under `runc`. Gemini was verified up to Google's key check: the gateway's check, and a
  turn that reached the Gemini API through the egress proxy and came back "API key not valid"; no
  Gemini turn, tool call or MCP call has run with a real key.
- Gemini earlier read "not offered" here, because Antigravity's own sign-in fails under Happy (it needs a
  terminal) and Google's terms forbid it for third-party software. It is offered on the person's own
  Gemini API key instead (see Security, Gemini).
- The Docker runtime controller is for a single host. A Kubernetes implementation of the `Runtime`
  interface (`src/runtime.ts`) is the path to multiple hosts.
- Under gVisor, new outbound connections from running runtimes pause for about 30 seconds (up to a
  minute) after the egress proxy container is recreated (see Operations).
- Happy generates a conversation's title from its first messages, which include that message's
  `context`; set a `title` (or `PATCH` it) when the context must not show up there. Happy has no rename,
  so `PATCH` titles are kept by the gateway in the person's volume.
- MCP server and `enabledTools` changes apply after the automatic idle restart; standing instructions
  apply to new conversations.
- The signed registration file can be rolled back by the person's own agent to an earlier version the
  app registered for that same person; it cannot point anywhere the app did not.

## License

MIT. Third-party components and their terms: `THIRD_PARTY.md`.
