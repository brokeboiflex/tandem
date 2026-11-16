# Tandem

Tandem gives every person their own private, always-resumable Claude Code and Codex workspace behind
one small HTTP API. Each person signs in with **their own** Claude or ChatGPT account through the vendor's
own sign-in, inside **their own** Linux container. Your application talks to Tandem; Tandem never
sees passwords and never shares an account between people.

Under the hood each workspace runs one unmodified [Happy Agent](https://github.com/slopus/happy-agent)
daemon with the official Claude Code and Codex CLIs. Tandem adds the parts a multi-user service needs:
authentication, one container per person, start-on-demand and idle stop, a narrow façade over Happy's
owner-level API, and a friendlier sign-in flow.

## How it is isolated

- **One container and one volume per person.** Names are `tandem-rt-<id>` and `tandem-home-<id>`,
  where `<id>` is an HMAC of the person's id (`sub` of the service JWT) under `SERVICE_SECRET`. The
  gateway derives the runtime only from the verified token, so one person can never address another's.
- **Vendor credentials stay in the person's volume.** `claude auth login` and `codex login` run inside
  the container and store their sign-in there. Tandem does not read, copy or log them.
- **The daemon token never leaves the gateway.** Happy's owner token (shutdown, drain, debug, config,
  bots, remote connections) is read once per runtime through the Docker exec API and kept in memory. The
  gateway can send only an allowlisted set of daemon requests (`src/happy.ts`).
- **Private network, no published ports.** Runtimes join the `tandem-runtimes` network only. Inside
  each, a tiny `socat` bridge forwards TCP 24790 to the daemon's Unix socket and accepts connections from
  the gateway's address only; the daemon still requires its token on every request.
- **Hardened defaults.** Built-in admin bot archived on every start, Happy relay/mobile/Tailcat off,
  sub-agents limited to their own harness (a Claude chat cannot start Codex work), no Linux capabilities,
  `no-new-privileges`, memory/CPU/process limits.

Containers are not virtual machines. For untrusted workloads run runtimes on a VM-isolated container
runtime (for example Kata Containers or gVisor) through a different `Runtime` implementation.

## Quick start (local)

Requirements: Docker Engine or Docker Desktop with Compose and Buildx, Bun 1.3.9, about 3 GB for
images. Runtimes build for **linux/arm64** and **linux/amd64**.

```sh
bun install --frozen-lockfile
docker buildx build --load -t tandem-runtime:2026.11.6-preview.7 runtime   # person runtime, host platform
docker buildx build --load -t tandem-gateway:0.1.0 .                       # gateway
# Both platforms (needs the containerd image store; never push these images):
#   docker buildx build --platform linux/arm64,linux/amd64 --load -t tandem-runtime:2026.11.6-preview.7 runtime
cp .env.example .env    # then set AUTH_MODE=dev, DEV_TOKEN_ROUTE=true and two random secrets:
                        #   DEV_AUTH_SECRET and SERVICE_SECRET (e.g. `openssl rand -hex 32` each)
docker compose up -d --no-build
open http://127.0.0.1:8787/connect                              # demo sign-in page
```

Checks:

```sh
bun run typecheck && bun test       # unit tests (fixtures from the pinned daemon)
bun scripts/e2e.ts                  # against the running stack
bun scripts/page-check.ts           # drives /connect in headless Chromium, screenshots to evidence/
                                    # (BROWSER_EXECUTABLE=/path/to/chromium if Playwright has none)
```

`bun scripts/token.ts <person>` prints a local development token for `curl`.

## API

Every `/v1` request needs `Authorization: Bearer <service JWT>`; `sub` is the person. Anything else is
`404`. Errors are `{ "error": "<code>", "message": "<readable sentence>" }`.

| Method and path | Purpose |
| --- | --- |
| `GET /v1/providers` | `{ providers: [{ id: "claude"\|"codex", status: "connected"\|"not_connected"\|"connecting", method: "subscription"\|"api_key"\|null, account: { email, plan }\|null, models: [{ id, name, efforts, defaultEffort }] }] }`. Models come from the account's live catalog and are empty until connected. |
| `POST /v1/providers/:id/connect` | Starts the vendor sign-in, answers `{ connection }` once the vendor page is ready. Claude also accepts `{ "method": "api_key", "apiKey": "sk-ant-…" }`. |
| `GET /v1/providers/:id/connect` | Current `{ connection }` (or `null`). |
| `POST /v1/providers/:id/connect/code` | `{ code }` from the Claude page. A rejected code answers `status: "waiting"` with `error.code: "wrong_code"`. |
| `DELETE /v1/providers/:id/connect` | Cancels the sign-in. |
| `DELETE /v1/providers/:id` | Signs out with the vendor CLI and removes its credentials from the volume. |
| `GET /v1/events` | Server-Sent Events for this person only: `provider.updated`, `conversation.run`, `conversation.message`, `conversation.delta`, `conversation.question`. |
| `POST /v1/conversations` | `{ provider, model, effort?, title? }` → `201 { conversation }`. |
| `GET /v1/conversations` | `{ conversations }`, newest activity first. |
| `GET /v1/conversations/:id/messages` | `{ conversation, messages, runs, hasMore, question }`; `?before=<runId>&limit=` pages back. |
| `POST /v1/conversations/:id/messages` | `{ text, model?, effort? }` → `202 { message, conversation }`. |
| `POST /v1/conversations/:id/abort` | Stops the current run. |
| `POST /v1/conversations/:id/questions/:questionId` | `{ answer }`: an option label, a list of labels, or `{ "<promptId>": [...] }`. Used for permission questions. |

`connection` is `{ status: "waiting"|"connected"|"failed"|"cancelled"|"expired", flow: "paste_code"|"device_code"|"api_key", url, userCode, expiresAt, error: { code: "wrong_code"|"expired"|"sign_in_failed"|"unavailable"|"invalid_api_key", message }|null, account }`.

Messages are normalized for a chat UI: `{ id, runId, role: "user"|"assistant"|"error", createdAt, text, tools: [{ id, name, status }], failure }`.
Runs are `{ id, status: "running"|"completed"|"aborted"|"failed", failure }`, and failures are typed:
`signin_required`, `model_unavailable`, `aborted` or `failed`, each with a readable `message`.

Other unauthenticated routes: `GET /healthz`, `GET /connect` (demo page), and `POST /dev/token` only when
`AUTH_MODE=dev` and `DEV_TOKEN_ROUTE=true`.

## The connect flow

1. Call `GET /v1/providers` (or open `/v1/events`) when the person opens your settings screen. It starts
   their runtime in the background (about 2 s for a new person, about 1 s for a stopped one), so the
   sign-in itself starts in well under a second.
2. **Claude** (`flow: "paste_code"`): open `url` in a new tab. After approving, Claude's page shows a code;
   the person pastes it and you send it to `/connect/code`. A code Claude refuses comes back as
   `wrong_code` with the sign-in still waiting. When Anthropic itself refuses the code, Tandem starts a
   fresh attempt automatically and returns its new `url` with the same `wrong_code` status.
3. **Codex** (`flow: "device_code"`): show `userCode` large, with a copy button and a link to `url`, and a
   countdown to `expiresAt`. The connection turns `connected` on its own; listen for `provider.updated`.
4. **Claude with an API key**: `POST /connect` with `method: "api_key"`. The key is written to the
   person's volume, becomes Happy's documented `api_key` setting for the Claude account, and is verified
   with Happy's own provider check; a refused key is removed again.
5. After any successful sign-in Tandem restarts that runtime once it is idle, so the vendor harnesses
   load the new account and its real model list. This is invisible apart from a few seconds of
   `connecting`.

`public/connect.html` is a framework-free reference implementation of these screens.

## Configuration

All settings are environment variables, documented with defaults in `.env.example`. The important ones:
`AUTH_MODE` (`oidc` with `OIDC_ISSUER`/`OIDC_AUDIENCE`/`OIDC_JWKS_URL`, or `dev`), `SERVICE_SECRET`,
`RUNTIME_DOCKER_HOST`, `RUNTIME_IMAGE`, `IDLE_MINUTES` (default 5; a runtime never stops while a run, a
question or a sign-in is open) and `PERMISSION_MODE` (default `workspace_write`: actions the agent asks
about become permission questions).

Each runtime keeps all its state on its volume: Happy's database, the conversations, the vendor sign-ins
and the agents' working folder. Tandem has no database of its own.

## Security notes

- **Docker socket.** The local compose file mounts `/var/run/docker.sock`, which is root on the host. In
  production put a restricted proxy in front of it, for example
  [Tecnativa docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) with only
  `CONTAINERS=1 EXEC=1 VOLUMES=1 POST=1 ALLOW_START=1 ALLOW_STOP=1 ALLOW_RESTARTS=1`, on a network that
  runtimes cannot reach, and set `RUNTIME_DOCKER_HOST=tcp://socket-proxy:2375`. Such proxies filter by API
  section, not by request body, so the gateway can still create containers; treat the gateway host as
  privileged.
- **Tokens.** Service JWTs are verified on every request; event streams close when the token expires. In
  production use `AUTH_MODE=oidc`. Development tokens (`AUTH_MODE=dev`) are for local use only.
- **Secrets in transit.** Login codes and API keys pass through the gateway in memory only: they are not
  logged, stored or echoed (unit-tested). Error responses never include request or daemon bodies.
- **Egress.** Runtimes need outbound HTTPS to the vendors (Anthropic, OpenAI, GitHub for some tools). They
  should not reach your internal networks: add egress firewall rules or an egress proxy for
  `tandem-runtimes`. A person's agent can run commands inside their own container.
- **Images.** Every download in `runtime/Dockerfile` is pinned and checksum-verified. Do not publish
  runtime images (see Vendor terms).

## Vendor terms

Each person signs in with their own account to the unmodified official CLIs, through the vendors' own
sign-in pages; Tandem never pools or shares accounts. Operators are responsible for complying with
Anthropic's and OpenAI's terms for their deployment, including which accounts and plans may be used this
way:

- Claude Code: <https://code.claude.com/docs/en/legal-and-compliance>
- Codex: <https://learn.chatgpt.com/docs/app-server#auth-endpoints>

Claude Code is proprietary to Anthropic. The runtime image downloads it from Anthropic's official npm
package at build time; prebuilt images containing it must not be published. See `THIRD_PARTY.md`.

## Limitations

- Pinned to Happy Agent 2026.11.6-preview.7, Codex 0.160.1 and Claude Code 2.1.321, for linux/arm64 and
  linux/amd64. `RUNTIME_PLATFORM` can run the non-native variant under emulation, which is slow and only
  meant for testing.
- Happy's `claude_code` harness always starts the Claude Code copy embedded in Happy Agent (byte-identical
  to the official 2.1.321 build) and ignores the `executable` setting in this version.
- The Docker runtime controller is for a single host. A Kubernetes implementation of the `Runtime`
  interface (`src/runtime.ts`) is the path to multiple hosts.

## License

MIT. Third-party components and their terms: `THIRD_PARTY.md`.
