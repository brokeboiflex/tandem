#!/bin/sh
# Runtime entrypoint: install the controller-owned config, start the private bridge, then run the
# Happy Agent daemon in the foreground (PID 1 is Docker's --init).
set -eu
umask 077

mkdir -p "$HOME/happy/config" "$HOME/.codex" "$HOME/projects/chats" "$HOME/.agent-runtime" \
  "$HOME/.gemini/antigravity-cli"
# The gateway points TMPDIR into the volume: the root filesystem may be read-only, and Happy unpacks
# its 341 MiB Claude Code binary there (once per volume instead of once per container).
mkdir -p "${TMPDIR:-/tmp}"

# Install the gateway-owned config. API keys the person chose (written by the gateway to the
# private files below) become Happy's documented `api_key` of their account, with a display name
# the gateway reads back from GET /v0/config: an Anthropic key for the built-in Claude account, an
# OpenRouter key for the OpenRouter account, a Gemini key for the Antigravity harness's account.
# Without an OpenRouter key that account names a variable nothing sets, so it has no credential;
# without a Gemini key the Antigravity harness is off. Shell builtins only, so a key never appears
# in any process's argv, and only agy gets one in its environment (GEMINI_API_KEY, from Happy).
read_key() {
  key=""
  if [ -s "$1" ]; then
    IFS= read -r key < "$1" || true
    case $key in *[!A-Za-z0-9_-]*) key="" ;; esac
  fi
}
read_key "$HOME/.agent-runtime/anthropic-api-key"
anthropic_key=$key
read_key "$HOME/.agent-runtime/openrouter-api-key"
openrouter_key=$key
read_key "$HOME/.agent-runtime/gemini-api-key"
gemini_key=$key
key=""
while IFS= read -r line; do
  printf '%s\n' "$line"
  if [ "$line" = "[providers.claude]" ] && [ -n "$anthropic_key" ]; then
    printf 'name = "Anthropic API key"\napi_key = "%s"\n' "$anthropic_key"
  elif [ "$line" = "[providers.openrouter]" ]; then
    if [ -n "$openrouter_key" ]; then
      printf 'name = "OpenRouter API key"\napi_key = "%s"\n' "$openrouter_key"
    else
      printf 'name = "OpenRouter"\napi_key_env = "OPENROUTER_API_KEY"\n'
    fi
  elif [ "$line" = "[harnesses.antigravity]" ]; then
    if [ -n "$gemini_key" ]; then
      printf 'name = "Gemini API key"\napi_key = "%s"\n' "$gemini_key"
    else
      printf 'enabled = false\n'
    fi
  fi
done < /opt/agent-runtime/happy.toml > "$HOME/happy/config/happy.toml"
anthropic_key=""
openrouter_key=""
gemini_key=""
# Antigravity's CLI uses the Gemini API with GEMINI_API_KEY, never its own Google sign-in, once its
# settings name that backend. The gateway owns these settings: they are rewritten on every start.
printf '{ "modelProvider": "gemini" }\n' > "$HOME/.gemini/antigravity-cli/settings.json"
# The daemon writes live overrides (Tailcat, remote connections, defaults) to a generated
# runtime.toml that wins over happy.toml. Nothing here uses them, so the controller's policy is
# re-applied on every start.
rm -f "$HOME/.happy/agent/runtime.toml"

# MCP servers the application registered for this person (PUT /v1/mcp-servers). The gateway
# writes a template whose every server is the gateway's MCP proxy; the proxy address and token
# come from this container's environment. The gateway owns this file: it is rewritten on every
# start. Application credentials never come here: the proxy adds them on the way out. It is
# installed into the volume, which stays writable when the root filesystem is read-only.
mcp_template="$HOME/.agent-runtime/mcp.toml"
if [ -s "$mcp_template" ] && [ -n "${MCP_PROXY_URL:-}" ]; then
  sed "s|@MCP_PROXY_URL@|$MCP_PROXY_URL|g" "$mcp_template" > "$HOME/happy/config/mcp.toml"
else
  printf '# No MCP servers registered.\n' > "$HOME/happy/config/mcp.toml"
fi

# Standing instructions (PUT /v1/instructions): the gateway keeps the canonical copy and the
# chat workspace gets it as AGENTS.md (Codex, Gemini's Antigravity CLI, and Happy's own loop for Grok
# and OpenRouter) and CLAUDE.md (Claude Code), restored on every start.
instructions="$HOME/.agent-runtime/instructions.md"
if [ -f "$instructions" ]; then
  cp "$instructions" "$HOME/projects/chats/AGENTS.md"
  cp "$instructions" "$HOME/projects/chats/CLAUDE.md"
fi

# Codex keeps its sign-in in a file inside the volume (no OS keyring in a container).
if [ ! -e "$HOME/.codex/config.toml" ]; then
  printf 'cli_auth_credentials_store = "file"\n' > "$HOME/.codex/config.toml"
fi

# A SIGKILLed daemon (docker rm -f, OOM, host crash) leaves agent.lock/auto-agent.lock naming its
# PID. In a fresh PID namespace the new daemon usually gets that same PID, treats the lock as live
# and exits: "The Happy agent store is already owned by process 7" (a restart loop). This
# container is the volume's only user and no daemon runs yet, so any lock here is stale.
if ! pgrep -x happy-agent >/dev/null; then
  rm -f "$HOME/.happy/agent/agent.lock" "$HOME/.happy/agent/auto-agent.lock"
fi

# Private bridge: TCP 24790 -> the daemon's owner-only Unix socket. It forwards bytes only; the
# daemon still requires its bearer token on every request. Only the gateway's address may connect
# (HAPPY_BRIDGE_ALLOW, set by the gateway); unset means loopback only, i.e. nobody.
socat "TCP-LISTEN:24790,fork,reuseaddr,range=${HAPPY_BRIDGE_ALLOW:-127.0.0.1/32}" \
  UNIX-CONNECT:"$HOME/.happy/agent/server.sock" &

exec happy-agent run
