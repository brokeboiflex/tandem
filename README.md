# Tandem

Tandem gives every person their own private, always-resumable AI workspace behind one small HTTP API:
Claude Code, Codex, Grok, Gemini and OpenRouter models. Each person signs in with **their own**
Claude, ChatGPT or Grok account through the vendor's own sign-in, or brings **their own** Anthropic,
Gemini or OpenRouter API key, inside **their own** sandbox. Your application talks to Tandem; Tandem
never sees passwords and never shares an account between people.

Tandem is **one container** that runs on any Docker host: deploy it once (Docker Compose, Dokploy)
and talk to it over HTTP. Inside it, the gateway runs every vendor program a person uses as a
sandboxed process through [crun](https://github.com/containers/crun) (their own uid and Linux
namespaces over a read-only system), started for a turn in well under a second and ended when idle.
No KVM, no Docker socket, no container per person, and nothing running for a person who is not using
it.

The agents are the vendors' own, unmodified: Claude Code through the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), Codex through
[`codex app-server`](https://developers.openai.com/codex/app-server), and Google's Antigravity CLI,
xAI's [Grok Build](https://github.com/xai-org/grok-build) and [goose](https://github.com/block/goose)
(for OpenRouter models) through the [Agent Client Protocol](https://agentclientprotocol.com). Tandem
adds the parts a multi-user service needs: authentication, a sandbox per process and limits per
person, its own conversation store, sign-in flows, and one API over all five.

## How it is isolated

- **One uid and one home per person.** Each person's home is `DATA_DIR/homes/<id>` (owner-only),
  where `<id>` is an HMAC of the person's id (`sub` of the service JWT) under `SERVICE_SECRET`; each
  person gets their own uid, recorded in `DATA_DIR/uids.json`. The gateway derives the person only from
  the verified token, so one person can never address another's.
- **A sandbox per process.** Every vendor program, sign-in and helper command runs in a sandbox of its
  own (`<prefix>-<id>-<label>-<n>`): its own PID, network, IPC, UTS, cgroup and mount namespaces; the
  runtime system read-only; only the person's home and temporary directory writable; no capabilities,
  `no_new_privs` and Docker's seccomp filter for unprivileged containers. Other people's files and
  processes do not exist inside it.
- **Limits per person.** Each person has a cgroup holding their memory and process limits for all of
  their processes together (`RUNTIME_MEMORY_MB`, `RUNTIME_PIDS`), and every process runs in a child of
  it: a runaway tool ends only its own process tree, never the person's other processes, other people,
  the gateway or the server. CPU is shared equally between the people who need it, and the gateway gets
  more than all sandboxes together.
- **The gateway keeps its own state outside every home.** Conversations, messages, the people's API
  keys and MCP registrations live in the gateway's own database (`DATA_DIR/tandem.db`, owner-only),
  which no sandbox can see. A home is writable from that person's sandboxes, so the gateway never reads
  a secret or a setting back from it.
- **Vendor sign-ins stay in the person's home.** `claude auth login`, `codex login` and
  `grok login --device-auth` run in the person's sandbox and keep their sign-in there; Tandem does not
  read, copy or log it. A person's API key goes only into the environment of their own vendor process.
- **No network but two sockets.** A sandbox has loopback only. Its ways out are two Unix sockets of the
  gateway: the egress proxy ([Smokescreen](https://github.com/stripe/smokescreen), an allowlist of
  vendor hosts) and the person's own MCP proxy socket. It cannot reach other people, the gateway's API,
  the host, private networks or cloud metadata (see [Security](#security)).
- **Application credentials stay in gateway memory.** The token your app sends for its own MCP server
  (`mcpAuth`) is held in the gateway's memory for that person only, never written to a sandbox, a file
  or a log. Agents reach your MCP server only through the gateway's MCP proxy, on a socket that exists
  for that person's sandboxes only, and the proxy adds the person's latest credential on the way out
  (see [Connecting your app's MCP server](#connecting-your-apps-mcp-server)).
- **Quiet vendor programs.** Telemetry, error reporting, auto-updates, plugin marketplaces and the
  vendors' own sandboxes (which cannot run inside Tandem's) are turned off in the runtime system:
  Claude Code's managed settings, Codex's system `requirements.toml`, and the Grok, Antigravity and
  goose settings their agents start with.

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
bun run typecheck && bun test       # unit tests (fake vendor programs and crun, real claude/codex when
                                    # installed, scripted vendor APIs, a stub MCP server)
sudo BUN=$HOME/.bun/bin/bun scripts/e2e/run.sh   # on a Docker host: builds the image, starts it with
                                    # scripted vendor APIs, and drives /v1 for all five providers (sign-in,
                                    # turns with shell commands in the sandboxes, questions, abort, MCP
                                    # through the proxy, restarts, isolation probes), then measures capacity;
                                    # output in evidence/e2e.txt and evidence/capacity.txt
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
4. Deploy. The build compiles the runtime system into the Tandem image (about 1.7 GB; build time is
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

**When something runs.** Reads (`GET`) answer from the gateway's own store and never start anything,
so an app may prefetch with them when the person signs in to it. A person's vendor programs run only
while they are needed: a turn starts the conversation's agent (Claude Code, `codex app-server`, or the
ACP agent) in a sandbox and keeps it for `IDLE_MINUTES` after the turn (default 2: starting again takes
well under a second), a sign-in keeps its CLI until it ends, and opening `GET /v1/events` reads the
accounts of the person's connected providers when they were not read in the last 15 minutes (each
read starts that vendor's program for a moment). Nothing runs for a person between uses.

| Method and path | Purpose |
| --- | --- |
| `GET /v1/providers` | `{ providers: [{ id: "claude"\|"codex"\|"grok"\|"openrouter"\|"gemini", status: "connected"\|"not_connected"\|"connecting"\|"unknown", method: "subscription"\|"api_key"\|null, account: { email, plan }\|null, models: [{ id, name, default, efforts, defaultEffort }], checkedAt }] }`. Models come from the account's live catalog, read from the vendor's own program, and are empty until connected. A model's `name` is what the vendor calls it, without a harness prefix ("Opus 5.5", "GPT-6-Luna"); Claude's are read from the person's own Claude Code; OpenRouter's are OpenRouter's own ("DeepSeek: DeepSeek V4.1 Flash 1017"); Gemini's are those Google's agent reports for the key ("Gemini 4 Carbon", IDs such as `antigravity/gemini-4-carbon`). `default: true` marks the vendor's default (Claude's `claude-code/default`; the other vendors have none): its `name` is the model it currently resolves to ("Sonnet 5.5"), or `null` until known, and the client labels it as the default in its own language. `checkedAt` (ISO time) is when this was read from the vendor. Never starts anything: the answer is what the gateway can see itself (a sign-in or key in place, a sign-in in progress) and what it last read from the vendor, kept in its store across restarts, with that read's `checkedAt`. A provider that is set up but whose account has not been read yet (just connected, or never read since the person's last sign-in) is `status: "unknown"` with `checkedAt: null`, `method: null`, `account: null` and no models: show it as loading, not as signed out; open `/v1/events` and the live state follows as `provider.updated`. A provider whose turn failed with `signin_required` reports `not_connected` until the person signs in again. |
| `POST /v1/providers/:id/connect` | Starts the vendor sign-in, answers `{ connection }` once the vendor page is ready. Claude also accepts `{ "method": "api_key", "apiKey": "sk-ant-…" }`; OpenRouter and Gemini accept only `{ "method": "api_key", "apiKey": "sk-or-…" }` and `{ "method": "api_key", "apiKey": "AIza…" }`. |
| `GET /v1/providers/:id/connect` | Current `{ connection }` (or `null`). |
| `POST /v1/providers/:id/connect/code` | `{ code }` from the Claude page. A rejected code answers `status: "waiting"` with `error.code` `wrong_code` (paste the whole code again) or `wrong_code_reissued` (Claude refused it for good: `url` is a new sign-in page to open again). |
| `DELETE /v1/providers/:id/connect` | Cancels the sign-in. |
| `DELETE /v1/providers/:id` | Signs out with the vendor CLI and removes its credentials from the home (for OpenRouter and Gemini: the key). |
| `GET /v1/events` | Server-Sent Events for this person only: `provider.updated`, `conversation.run`, `conversation.message`, `conversation.delta`, `conversation.question`, `conversation.context` (`{ conversationId, context }`, the same `context` as above after each measurement, `null` after compaction). Its first `provider.updated` for each provider comes at once, from what the gateway knows; a provider whose account was not read in the last 15 minutes is read from the vendor, and its live state follows. The stream closes when the token expires; reconnect with a fresh one. |
| `POST /v1/conversations` | `{ provider, model, effort?, title? }` → `201 { conversation }`. |
| `GET /v1/conversations` | `{ conversations, nextCursor }`, newest activity first. `?limit=` (1-200, default 50), `?cursor=<nextCursor>` for the next page, `?query=` to search titles (case-insensitive). |
| `PATCH /v1/conversations/:id` | `{ title }` (1-200 characters, or `null` for the generated title) → `{ conversation }`. |
| `DELETE /v1/conversations/:id` | Archives the conversation → `204`. It leaves every list and takes no messages; Tandem keeps its history. |
| `GET /v1/conversations/:id/messages` | `{ conversation, messages, runs, hasMore, question, context, usage }`; `?before=<runId>&limit=` pages back. `context` is `{ usedTokens, limitTokens, approximate }`: the latest measured conversation size against the point where the agent compacts it automatically (so 100% is when compaction happens), or `null` before the first measurement and right after compaction. `usage` is the conversation's lifetime `{ input, output, cacheRead, cacheWrite }` tokens on that measured model, or `null`. |
| `POST /v1/conversations/:id/messages` | `{ text, model?, effort?, mcpAuth?, context? }` → `202 { message, conversation }`. `text` is at most 100 000 characters. `mcpAuth` is `{ "<server name>": "<Authorization header value>" \| null }` for registered MCP servers: held in gateway memory only, latest wins, `null` forgets it, and all are cleared after `IDLE_MINUTES` without use or when the gateway restarts. `context` (at most 16 000 characters) is a hidden preamble for this message only: the agent receives it, but it is never returned as user text by `GET …/messages` or in events. A message sent while a run is in progress waits for it and runs next. |
| `POST /v1/conversations/:id/abort` | Stops the current run. |
| `POST /v1/conversations/:id/questions/:questionId` | `{ answer }`: an option label, a list of labels, or `{ "<promptId>": [...] }`. Used for permission questions, including those an MCP server asks. |
| `GET /v1/mcp-servers` | `{ servers: [{ name, url, enabledTools, description, hasCredential }] }`. |
| `PUT /v1/mcp-servers/:name` | `{ url, enabledTools?, description? }` → `201` (new) or `200 { server }`. Registers a Streamable HTTP MCP server for this person; no credentials here. `name`: a lowercase letter, then up to 31 lowercase letters, digits or `_`. `url`: `http` or `https`, an origin allowed by `MCP_ALLOWED_ORIGINS`. `enabledTools`: only these tools are offered and callable. At most 20 servers. |
| `DELETE /v1/mcp-servers/:name` | Removes the server and forgets its credential → `204`. |
| `GET /v1/instructions` | `{ text }`: the person's standing instructions (empty when none). |
| `PUT /v1/instructions` | `{ text }` (at most 64 000 characters; empty clears them) → `{ text }`. Kept by the gateway and written into the chat workspace as `AGENTS.md` (Codex, Antigravity, Grok Build, goose) and `CLAUDE.md` (Claude Code), so every agent loads them in new conversations. |

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

Tandem 0.4 no longer sends `runtime_stopped` (reads always answer), `conflict` or
`conversation_has_no_model`.

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
| `not_waiting_for_code` | HTTP 409 | A code was sent, but no sign-in of this provider is waiting for one. | |
| `signin_required` | HTTP 409 | A new conversation on a provider that isn't connected. | `provider` |
| `question_not_pending` | HTTP 409 | The question isn't waiting for an answer (any more): answered meanwhile, ended with its run, or unknown. | |
| `too_many_servers` | HTTP 409 | The person already has as many MCP servers as allowed. | `maxServers` |
| `model_unavailable` | HTTP 422 | The connected account doesn't offer this model (any more); pick another. | |
| `invalid_effort` | HTTP 422 | The model doesn't offer this effort. | `efforts`: the ones it offers |
| `runtime_unavailable` | HTTP 503 | Tandem couldn't do this right now (a sandbox or a vendor program failed); try again shortly. | |
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
   first view. Both answer at once from what the gateway knows; apply the `provider.updated` events that
   follow. A sign-in starts the vendor's own CLI in the person's sandbox and answers once its page is
   known.
2. **Claude** (`flow: "paste_code"`): open `url` in a new tab. After approving, Claude's page shows a code;
   the person pastes it and you send it to `/connect/code`. A code Claude refuses comes back as
   `wrong_code` with the sign-in still waiting. When Anthropic itself refuses the code, Tandem starts a
   fresh attempt automatically and returns its new `url` with `wrong_code_reissued`: the person opens
   the sign-in page again and pastes the new code.
3. **Codex** and **Grok** (`flow: "device_code"`): show `userCode` large, with a copy button and a link to
   `url`, and a countdown to `expiresAt`. The connection turns `connected` on its own; listen for
   `provider.updated`. They run the vendors' own `codex login --device-auth` and
   `grok login --device-auth`; the person confirms the code on OpenAI's or xAI's page. Codex forgets an
   earlier sign-in as soon as a new one starts.
4. **Claude, OpenRouter or Gemini with an API key**: `POST /connect` with `method: "api_key"`
   (OpenRouter and Gemini have no other way). The key is checked first with one request that costs
   nothing, sent from the person's sandbox (Anthropic's model list, OpenRouter's key endpoint, Google's
   model list); only a key the provider accepts is kept, in the gateway's own store. A refused key leaves
   an earlier one in place. Create a Gemini key in Google AI Studio.
5. After a successful sign-in or a new key, Tandem reads the account and its models from the vendor
   (a moment of `connecting`, then `provider.updated`), and a vendor program still running on the old
   account is restarted once its turn ends.

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

   The registration is kept in the gateway's store and survives restarts; every turn from then on
   gets the person's current servers. Optionally `PUT /v1/instructions` with standing instructions
   about your app.
3. **Send the person's current credential with every message**, exactly the `Authorization` header your
   MCP server expects, plus any per-message context:

   ```json
   POST /v1/conversations/:id/messages
   { "text": "Who is my next client?",
     "mcpAuth": { "app": "Bearer <the person's current token>" },
     "context": "The person is on the calendar page, viewing 2026-11-17." }
   ```

   Send a fresh credential each time: the latest one wins, and Tandem forgets them all once the person
   has been idle for `IDLE_MINUTES`. The agent sees the context in front of the message; the person never sees it in history or
   events.

The agent sees your tools under the server's name (Claude Code: `mcp__app__<tool>`). How a call travels:

- Every agent gets your server as `http://127.0.0.1:8790/mcp/<person id>/app` with a per-person proxy
  token as its `Authorization` header (in Claude Code's initialize request, an environment variable of
  `codex app-server`, or the ACP session; never a command line). Inside the sandbox that port is relayed
  to a Unix socket of the gateway that is mounted into this person's sandboxes only. Your URL and the
  person's credential never enter a sandbox.
- The proxy accepts a request only with the right token **and** on that person's own socket, looks up
  the person's registration, and forwards the request to your `url` with the person's latest `mcpAuth`
  value as `Authorization`. JSON responses and SSE streams pass through unchanged, including questions
  your server asks mid-call (MCP elicitation), which Claude Code and Codex turn into questions for the
  person on `GET /v1/events`, answered through `/v1/.../questions`.
- Before the first credential arrives, the proxy holds the agent's MCP handshake (up to about ten
  minutes) instead of failing it, and a message that brings the credential waits briefly until the tools
  are listed.
- With no credential, or when your server answers `401`, the agent's tool call returns the error
  `Sign-in for <name> expired or is missing. Send a new message to continue.`, which the agent relays; the
  spent credential is dropped. Your server's `403` becomes `<name> refused this request (access denied).`
  The proxy never answers `401` to an agent, so the connection stays usable for the next credential.
- `enabledTools` is enforced by the proxy for every agent, and also given to the agents that take a tool
  list (Claude Code, Codex, goose).

**Who decides a call.** Each agent applies its own permission rules to MCP calls, as it does to its own
tools; what it asks becomes a permission question. Claude Code runs the tools in `enabledTools` without
asking (they are pre-approved) and refuses the server's others. Codex asks before tools your server does
not mark read-only. Antigravity and goose ask before calls they consider sensitive; Grok Build calls MCP
tools through its own tool search. Your MCP server's own authorization, with the person's own
credential, remains what limits what a call can do.

## Configuration

All settings are environment variables, documented with defaults in `.env.example`. The important ones:
`AUTH_MODE` (`oidc` with `OIDC_ISSUER`/`OIDC_AUDIENCE`/`OIDC_JWKS_URL`, or `dev`), `SERVICE_SECRET`,
`IDLE_MINUTES` (default 2: how long a vendor program stays after its last turn; never while a run, a
question or a sign-in is open), `PERMISSION_MODE`, `MCP_ALLOWED_ORIGINS` for application MCP servers,
the limits per person (`RUNTIME_MEMORY_MB`, `RUNTIME_PIDS`; defaults 1024 MiB and 512 processes, for all
of a person's processes together), and the egress settings under [Security](#security).
`RUNTIME_PREFIX` names every sandbox of one instance.

`PERMISSION_MODE` (default `auto`) is how much an agent may do without asking, in each vendor's own
terms; never use `full_access` for people's chats:

| Mode | Claude Code | Codex | Antigravity, Grok Build, goose |
| --- | --- | --- | --- |
| `read_only` | `plan` | asks before every command and edit (`untrusted`) | read and search only; everything else asks |
| `workspace_write` | `acceptEdits` | asks before what it considers dangerous (`on-request`) | the agent's asking mode |
| `auto` | `auto` (Claude Code's own classifier) | `on-request` | the agent's asking mode (goose: `smart_approve`) |
| `full_access` | `bypassPermissions` | never asks (`never`) | never asks |

Codex always runs with `sandboxPolicy: externalSandbox`: Tandem's sandbox is the boundary, because
Codex's own (bubblewrap) cannot run inside it.

**Where state lives.** The gateway's own store, `DATA_DIR/tandem.db` (SQLite, owner-only): conversations,
their messages and runs, titles, the last-read provider state, API keys, MCP registrations and standing
instructions. Each person's home, `DATA_DIR/homes/<id>`: the vendor sign-ins, the vendors' own session
files (what lets a later turn resume a conversation) and the agents' working folder. Both are on the
`tandem-data` volume; back it up as a whole.

### Capacity

Measured with the real image and gateway on a 2-vCPU, 4 GiB, no-KVM, no-swap VM like the target
servers, against scripted vendor APIs (`evidence/capacity.txt`):

- **The image** is 1.80 GB (Tandem 0.3 with Happy Agent: 2.11 GB). **The gateway at rest** (with the
  egress proxy) uses 47 MiB.
- **A person between uses** costs no process: 15 connected people without a turn ran none. A vendor
  program that ran a turn (or read the account) stays for `IDLE_MINUTES`, then ends.
- **A turn** starts the vendor's program in about 0.1-0.2 s (median cold first turn: Claude 216 ms,
  Codex 143, Grok 91, OpenRouter 178, Gemini 192; later turns 10-30 ms of Tandem), so the model's own
  response time is what a person notices. Each person's peak while a program runs: Claude Code
  143-176 MiB, Antigravity 112-138, goose 68-70, Codex 21-31, Grok Build 12-14.
- **Many at once:** 5 people starting their first Claude turn at the same moment finished in under a
  second, with the whole container at 845 MiB (about 155 MiB per person); 5 people on the five
  providers at once peaked at 442 MiB. Nothing was killed. Size a server by the people active within
  `IDLE_MINUTES` of each other: roughly 155 MiB each for Claude Code, less for the others.
- **Limits:** each person's cgroup caps the memory and processes of all of their sandboxes
  together; at `RUNTIME_MEMORY_MB` the kernel first reclaims their caches, then ends one process tree
  (the one using the most), not the person's others. There is deliberately no `memory.high`: without
  swap it throttles a runaway instead of ending it, and the person's other processes with it. CPU is
  shared by weight (no per-person quota, which would only leave CPUs idle): the gateway's own cgroup
  weighs four times all sandboxes together and keeps 128 MiB protected from reclaim. The gateway sets
  this up inside its own container at startup (cgroup v2 hosts, which current Ubuntu and Debian are);
  on a host without cgroup v2 it logs a `WARNING:` and only the per-uid process limit applies.
  `RUNTIME_MEMORY_MB` is per person, so for a server shared with other apps also cap the whole
  container (`mem_limit` in `compose.yaml` or Dokploy's resource settings); sandboxed processes are
  ended before the gateway when the container runs out of memory.

## Operations and upgrades

**Restarting or redeploying.** On `SIGTERM` the gateway ends every sandbox, then exits
(`stop_grace_period: 60s` in `compose.yaml`; `init: true` reaps processes). After a restart nothing runs
until it is used again; reads answer from the store as before. What a restart interrupts:

- Runs in progress end as `failed` (recorded when the gateway starts again); the next message continues
  the same conversation, with the vendor's own session.
- Open `/v1/events` streams close. Reconnect them (as `EventSource` does).
- `mcpAuth` credentials live in the gateway's memory only. Until the next message brings them again,
  MCP tool calls answer `Sign-in for <name> expired or is missing`.
- Sandboxes a killed gateway left behind are removed when it starts again.

**Upgrading.** Rebuild and recreate the container (`docker compose up -d --build`, or redeploy in
Dokploy). The runtime system is part of the image, so every vendor program started afterwards runs the
new version; homes and the store are kept.

**Upgrading from Tandem 0.3 (Happy Agent).** Homes, sign-ins and uids carry over; people stay signed in
to Claude, Codex and Grok. Not carried over: conversations made under Happy Agent (its database stays in
each home, unused), API keys (they were files in the homes; people enter them again, and the old files
can be deleted: `bun src/cli.ts exec <id> -- rm -f /home/agent/.agent-runtime/*-api-key`), MCP
registrations (your app registers them again, as it does when a person opens its chat) and standing
instructions (`PUT /v1/instructions` again).

**Upgrading from Tandem 0.1 (Docker volumes).** Copy each `tandem-home-<id>` volume's contents to
`DATA_DIR/homes/<id>` in the new data volume (same `<id>`, same `SERVICE_SECRET`); the gateway hands
each home to the person's new uid on first use. Then remove the old `tandem-rt-*` containers,
`tandem-net-*` networks, the egress proxy container and, if used, the socket proxy.

## Security

The threat Tandem is built against: an agent with a shell inside its sandbox (possibly steered by
prompt injection) tries to reach other people's files, processes or secrets, the gateway or the host,
or what it should not over the network. The gateway logs one `security:` line at startup; `GET /healthz` reports the egress mode.

### 1. A sandbox per process

Every process Tandem starts for a person runs under crun with the OCI spec in `src/security.ts`: the person's own uid, no
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

The vendors' own sandboxes need user namespaces, which Tandem's sandbox does not grant, so they are
off: Codex runs with `externalSandbox`, and Claude Code's managed settings turn its sandbox off.
Tandem's sandbox is the boundary for every agent.

### 2. What a sandbox can reach

A sandbox's network namespace has loopback only. Its two ways out are Unix sockets of the gateway,
mounted into it and relayed to loopback ports by `agent-run`, the first program in every sandbox:

- **The Internet, through the egress proxy** (`HTTPS_PROXY`/`HTTP_PROXY`, honoured by every vendor
  program, git and curl): Stripe's [Smokescreen](https://github.com/stripe/smokescreen),
  run by the gateway on the container's loopback. It allows only the hostnames in
  `runtime/egress-allowlist.txt` (Anthropic, OpenAI/ChatGPT, xAI's sign-in `auth.x.ai` and Grok
  endpoint `cli-chat-proxy.grok.com`, `openrouter.ai`, the Gemini API
  `generativelanguage.googleapis.com`, GitHub) plus `EGRESS_ALLOW_DOMAINS`, and refuses private,
  loopback, link-local and CGNAT addresses in every mode. Vendor telemetry outside the list is refused.
  `EGRESS_MODE=open` allows any public host.
- **The gateway's MCP proxy**, through a socket that is mounted into this person's sandboxes only
  (`DATA_DIR/run/<id>/mcp.sock`): a request on it can only come from that person's own processes.

Other people's sandboxes, the gateway's API and every other address are unreachable. People open the
vendors' sign-in pages (`accounts.x.ai` for Grok) in their own browser, not in a sandbox. The
gateway itself (not the sandboxes) calls your app's MCP servers, only at `MCP_ALLOWED_ORIGINS`.

| Setting | Default | Effect |
| --- | --- | --- |
| `EGRESS_MODE` | `allowlist` | `allowlist`: the hosts above; `open`: any public host |
| `EGRESS_ALLOW_DOMAINS` | empty | extra hostnames, e.g. `registry.npmjs.org,pypi.org,files.pythonhosted.org,git.example.com`; `*.example.com` covers subdomains only |
| `EGRESS_ALLOW_RANGES` | empty | private IPv4 CIDRs sandboxes may reach anyway, e.g. an internal registry |

### 3. The agents

- **Claude Code** runs through the Claude Agent SDK inside the gateway, which starts the image's
  official `claude` in the person's sandbox for each conversation in use (`spawnClaudeCodeProcess`), with
  only Claude Code's own variables; never the SDK's bundled copy (its optional packages are not
  installed).
- **Codex** runs as one `codex app-server` per person in use, a conversation per thread.
- **Gemini** runs on Google's own agent, the Antigravity CLI (`agy acp`), on the person's own Gemini API
  key, which goes into that process's environment as `GEMINI_API_KEY`; `agy` is pointed at the Gemini
  API (`modelProvider` in `~/.gemini/antigravity-cli/settings.json`), so its own Google sign-in is never
  used. Google's terms forbid that sign-in for third-party software: "Using third-party software, tools,
  or services to access Antigravity is a violation of our Terms of Service … To use a third-party coding
  agent with Gemini, we recommend using a Gemini Enterprise or Google AI Studio API key."
  (<https://antigravity.google/docs/faq>). Antigravity makes extra "safety rater" model calls per
  command, billed to the person's key.
- **Grok** runs on xAI's own Grok Build agent (`grok agent stdio`) on the person's own
  `grok login --device-auth`.
- **OpenRouter** runs on goose (`goose acp`, provider `openrouter`) on the person's own OpenRouter key,
  in that process's environment as `OPENROUTER_API_KEY`. Its models are a fixed list in
  `src/agents/acp-vendors.ts` (`OPENROUTER_MODELS`), with names and efforts from OpenRouter's public
  model list.

A person's own agent can read its own process environment, and so its own API key; it cannot reach
anyone else's.

### Other notes

- **Tokens.** Service JWTs are verified on every request; event streams close when the token expires. In
  production use `AUTH_MODE=oidc`. Development tokens (`AUTH_MODE=dev`) are for local use only;
  sandboxes cannot reach `POST /dev/token` (or any gateway route) at all.
- **Secrets in transit.** Login codes and API keys pass through the gateway in memory only: they are not
  logged or echoed (unit-tested); an accepted API key is kept in the store, owner-only, and checked from
  the person's sandbox through standard input, never a command line. Error responses never include
  request bodies or vendor output.
- **Application credentials.** `mcpAuth` values live only in the gateway's memory, keyed by person, and go
  only to that person's registered URL on an allowed origin (no redirects followed). The per-person
  proxy token is given to that person's agents, so the person's agent can read it; it is useless
  elsewhere, because the proxy accepts it only on that person's own socket. With it the agent can do
  what its MCP tools already can. Keep `MCP_ALLOWED_ORIGINS` to your own app: the gateway can reach
  networks the sandboxes cannot.
- **Images.** Every download in the `Dockerfile` is pinned and checksum-verified, and the npm
  dependencies are locked in `bun.lock`. Do not publish Tandem images (see Vendor terms).

## Vendor terms

Each person signs in with their own account to the unmodified official CLIs, through the vendors' own
sign-in pages, or uses their own API key; Tandem never pools or shares accounts. Operators are
responsible for complying with Anthropic's, OpenAI's, xAI's, Google's and OpenRouter's terms for their
deployment, including which accounts and plans may be used this way:

- Claude Code: <https://code.claude.com/docs/en/legal-and-compliance>
- Codex: <https://learn.chatgpt.com/docs/app-server#auth-endpoints>
- Grok: <https://x.ai/legal/terms-of-service> (the Grok CLI's source: <https://github.com/xai-org/grok-build>)
- goose: <https://github.com/block/goose> (Apache-2.0)
- Gemini: <https://ai.google.dev/gemini-api/terms> (API keys) and Antigravity's terms for its CLI
  (<https://antigravity.google/docs/faq>; Tandem never uses an Antigravity sign-in)
- OpenRouter: <https://openrouter.ai/terms>

Claude Code and the Claude Agent SDK are proprietary to Anthropic. The image downloads Claude Code from
Anthropic's official npm package at build time and installs the SDK from npm; prebuilt images
containing them must not be published. See `THIRD_PARTY.md`.

## Limitations

- Sandboxes share the host kernel (as containers do). They are not virtual machines; the isolation is
  Linux namespaces, a uid per person, no capabilities and seccomp (see Security).
- One Tandem container serves one server's capacity. Several Tandem containers on several servers need
  your app to send each person to the same one.
- Pinned to the Claude Agent SDK 0.3.330, Claude Code 2.1.330, Codex 0.160.1, Grok Build 1.0.89, the
  Antigravity CLI 1.5.11, goose 1.60.2 and Smokescreen 0.1.0, for linux/arm64 and linux/amd64; crun
  comes from Debian trixie. Only linux/arm64 has been run.
- Verified end to end against scripted vendor APIs in real sandboxes (`evidence/e2e.txt`), not yet with
  real accounts: Claude's sign-in page and plan names, Claude Code's `auto` classifier (it asks
  Anthropic's server, which a scripted API cannot stand in for; Claude's shell, questions and abort were
  run under `workspace_write`), streamed text over the vendors' HTTPS, real usage-limit texts, the
  Codex, Grok and Gemini model catalogs, and every vendor's account e-mail and plan.
- A conversation's title is its first message's first line (or the `title` given at creation); set a
  `title` (or `PATCH` it) when that line must not show up in lists.
- Antigravity and Grok Build cannot be limited to `enabledTools` themselves; the MCP proxy still refuses
  every other tool of the server.
- If a vendor's own session files are removed from a home, the conversation cannot continue; start a
  new one.

## License

MIT. Third-party components and their terms: `THIRD_PARTY.md`.
