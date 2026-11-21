# Agent layer without Happy Agent (design, 2026-11-21)

Tandem stops running Happy Agent. The gateway talks to each vendor's own program directly:

| Provider | Program in the image | Interface | Catalog ids |
| --- | --- | --- | --- |
| claude | `/usr/local/bin/claude` | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, in the gateway) with `spawnClaudeCodeProcess` | `claude-code/<alias>` (`default`, `opus`, `sonnet`, `haiku`, …) |
| codex | `/usr/local/bin/codex` | `codex app-server` (JSON-RPC over stdio) | `codex-cli/<model>` |
| gemini | `/usr/local/bin/agy` | ACP (`agy acp`) on the person's Gemini API key | `antigravity/<model>` (effort suffixes become efforts) |
| grok | `/usr/local/bin/grok` | ACP (`grok agent stdio`, xAI's own Grok Build agent) | `xai/<model>` |
| openrouter | `/usr/local/bin/goose` | ACP (`goose acp`, provider `openrouter`) on the person's OpenRouter key | the OpenRouter slug (`deepseek/deepseek-v4.1-flash-1017`) |

The `/v1` API stays as README documents it, so applications (the CRM) do not change.

## Why (measured on a 2 vCPU / 4 GiB arm64 VM without KVM, Ubuntu 24.04, kernel 6.8, Docker 28.5)

- Every Happy daemon start read and hashed its embedded 341 MB Claude Code: the person's cgroup
  peaked at 1.26-1.29 GiB and the daemon held ~770 MiB for 10-30 s, then settled at ~115 MiB. With
  Happy's Claude Code harness off the peak was 218-239 MiB (so the embedded copy is the cause).
  Runtimes stop after idle minutes, so this repeated through the day; two at once on a 3 GB server
  would hit out-of-memory.
- Happy sends Codex `sandboxPolicy: workspaceWrite`; inside Tandem's sandbox Codex's bubblewrap
  cannot create namespaces, so **every Codex shell command failed** ("bwrap: No permissions to create
  a new namespace"). With `externalSandbox` the same command runs (exit 0) as the person's uid.
- Proofs with the real programs in Tandem's sandboxes against scripted vendor APIs
  (`evidence/poc/*.ts`, `scripts/mock-vendor/`), each a full turn with one shell tool call:
  Claude 372 ms (init 248 ms, person's peak 229 MiB), Codex 170 ms, agy 223 ms, Grok Build 71 ms,
  goose 170 ms. Each tool ran as uid 100000 with `CapEff 0`, `NoNewPrivs 1`, `Seccomp 2`, and the
  egress proxy refused a non-allowlisted host.
- No daemon per person: an idle person costs nothing; a turn costs the vendor process
  (claude ~190 MiB, codex ~120-175 MiB, grok ~77 MiB, agy ~175 MiB, goose ~40 MiB).

## Processes and sandboxes

- **One sandbox per process.** `Sandboxes.spawn(key, args)` (`src/agents/types.ts`) runs the program
  with `crun run` in a sandbox of its own: the person's uid, their home, the read-only rootfs, no
  capabilities, no_new_privs, Docker's seccomp filter, own PID/network/IPC/UTS/mount namespaces,
  stdio piped. (`crun exec` into a running sandbox is refused without `CAP_SYS_PTRACE`, which the
  gateway should not have.) `exec()` is the existing one-shot command.
- **The person's cgroup** `/sandboxes/<prefix>-<key>` holds the person's limits (memory.max =
  `RUNTIME_MEMORY_MB`, pids.max = `RUNTIME_PIDS`, cpu.weight 100); each process is a child cgroup
  `/sandboxes/<prefix>-<key>/<label>-<n>` with `memory.oom.group=1`. The gateway's own leaf gets a
  higher cpu.weight and a memory.min. No memory.high: measured without swap, a runaway above it is
  throttled for minutes instead of OOM-killed, and the person's other processes stall with it
  (`evidence/sandbox-check.txt`).
- **Relays.** Every sandbox starts under `tini` with `agent-run` (replaces `with-egress` and the
  Happy entrypoint): socat 127.0.0.1:4750 → `/run/tandem/egress.sock` (HTTPS_PROXY) and, when the
  person has MCP servers, 127.0.0.1:8790 → `/run/tandem/mcp.sock`; then `exec "$@"`. Base env:
  PATH, HOME, TMPDIR, HTTPS_PROXY/HTTP_PROXY (both cases), `NO_PROXY=127.0.0.1,localhost` (Claude sent
  loopback MCP through the proxy without it). Nothing from the gateway's environment.
- **Lifetime.** An agent keeps a person's process while it is in use and for `IDLE_MINUTES` after
  the last turn (default 2: starting again costs 0.05-0.45 s). Sign-in CLIs live until they finish.
  On SIGTERM the gateway ends every sandbox. After a gateway restart, leftover sandboxes of this
  prefix are deleted.

## Ownership

- **Gateway** (`src/gateway.ts`, `src/store.ts`): the façade, a SQLite store in `DATA_DIR`
  (conversations: provider, model, effort, vendor session id, title, archived, activity, last
  context and usage; messages; runs), event fan-out, pending questions, sign-in state, provider
  cache (`checkedAt`), MCP registrations and the MCP proxy (unchanged), instructions
  (AGENTS.md + CLAUDE.md in the chat workspace, unchanged), idle sweep. Reads answer from the store
  and never start a process.
- **Agents** (`src/agents/<vendor>.ts`): implement `Agent` from `src/agents/types.ts`. They never
  touch the store or the façade; they run turns and read accounts/models.
- **Sign-in** (`src/signin.ts` + vendor parts): long-lived CLI processes in sandboxes, as Happy
  ran them (`/tmp/ha-src/packages/happy-agent-modules/sources/providerClis/`):
  `claude auth login --claudeai` (URL from output, the pasted code to stdin), `codex login
  --device-auth`, `grok login --device-auth` (URL and user code from output). API keys stay files
  in `~/.agent-runtime/` written by the gateway, verified by a minimal vendor request from a
  sandbox.

## Vendor notes (read the sources; Happy's MIT code is a good map of each vendor)

- **Claude.** `query()` in streaming-input mode per conversation, kept while active, `resume:
  <session>` after; `pathToClaudeCodeExecutable: /usr/local/bin/claude`; `spawnClaudeCodeProcess`
  → `Sandboxes.spawn` with only `CLAUDE*`/`ANTHROPIC*`/SDK variables from the SDK's env;
  `mcpServersDelivery: 'initialize'` (headers never on argv); `settingSources: ["user","project",
  "local"]`, `systemPrompt: {type:"preset", preset:"claude_code"}`; `canUseTool` → permission
  question (AskUserQuestion → a real question with its options); permission modes as Happy maps them
  (read_only→plan, workspace_write→acceptEdits, auto→auto, full_access→bypassPermissions);
  models via `supportedModels()`, account via `accountInfo()`, context via `getContextUsage()`,
  usage from `result` messages. API key: `ANTHROPIC_API_KEY` from `~/.agent-runtime/anthropic-api-key`
  read by the gateway (env of that process only). Reference: Happy's
  `happy-providers/sources/vendors/claudeAgent/claudeAgentConnect.ts`,
  `vendors/claude/` (usage limits), `foreignAgents/claudeCodeAgent.ts`.
- **Codex.** One `codex app-server` per person while active, threads per conversation
  (`thread/start`, `thread/resume`), `turn/start` with `sandboxPolicy: {type:"externalSandbox",
  networkAccess:"enabled"}` (Tandem's sandbox and egress proxy are the boundary) and `approvalPolicy`
  per mode (auto→`on-request`, full_access→`never`); approvals and `mcpServer/elicitation/request` →
  questions; `thread/tokenUsage/updated` → context and usage; `model/list`, `account/read`; MCP via
  `-c mcp_servers.<name>.url=…` + `bearer_token_env_var` (token in the env, not argv). Errors carry
  `codexErrorInfo` (usage limit, unauthorized, context window). Protocol types:
  `/tmp/research/codex/codex-rs/app-server-protocol/schema/typescript/v2/` (rust-v0.160.1 = the
  image). Reference: Happy's `vendors/codexAppServer/`.
- **ACP** (`src/agents/acp.ts` + one config each). `initialize`, `session/new {cwd, mcpServers}`,
  `session/load`/`session/resume` for an existing session, `session/prompt`, `session/cancel`;
  `session/update` (`agent_message_chunk`, `tool_call`, `tool_call_update`, `usage_update`);
  `session/request_permission` → permission question. Models from `session/new` (`models` /
  `configOptions`), set with `session/set_model` or the config option. agy takes `mcpServers` though
  it does not advertise it, and never asks before MCP tools. Grok Build and goose advertise HTTP
  MCP. Schema: `/tmp/tandem-research/acp/src/agent-client-protocol/`. References: Happy's
  `protocol/acp/AcpSession.ts`, `foreignAgents/antigravityAgent.ts`; Grok Build source
  `/tmp/research/grok-build`; goose source `/tmp/tandem-research/servers/src/goose`.

## Vendor settings baked into the rootfs

- Claude `/etc/claude-code/managed-settings.json`: `env` with
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`,
  `DISABLE_UPDATES`, `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL` = "1"; `sandbox.enabled:
  false` (Tandem's sandbox is the boundary). Process env adds `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC=1`,
  `CLAUDE_CODE_PROXY_RESOLVES_HOSTS=1`.
- Codex `/etc/codex/config.toml` (+ `requirements.toml` where it must win): `[features] plugins =
  false, apps = false`, `[analytics] enabled = false`, `[feedback] enabled = false`,
  `cli_auth_credentials_store = "file"`.
- Grok env: `DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1`, `GROK_MANAGED_CONFIG=0`,
  `GROK_MEMTRACE=0`, `GROK_DISABLE_AUTOUPDATER=1`.
- agy: `--disable-telemetry` for `acp`; `~/.gemini/antigravity-cli/settings.json` `{ "modelProvider":
  "gemini" }` as today.
- goose: `GOOSE_DISABLE_KEYRING=1`, `GOOSE_TELEMETRY_ENABLED=false`, provider `openrouter`, model from
  the conversation.

## Tests

- Unit tests per agent against a fake vendor process (a Bun script speaking the protocol) through a
  `Sandboxes` that spawns directly (no crun), so they run on any machine.
- Integration on the VM: the real programs in real sandboxes against `scripts/mock-vendor/`
  (scripted Anthropic Messages, OpenAI Responses and chat completions, Gemini generateContent): a
  turn with a shell tool call, a permission question answered, abort, resume of a second turn, and
  for Codex a file written in the workspace. `scripts/e2e.ts` runs them with the gateway.
- Real accounts (sign-in, plan, account models, usage limits) are checked by a person; record what
  was and was not checked.
