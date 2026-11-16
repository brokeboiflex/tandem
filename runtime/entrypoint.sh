#!/bin/sh
# Runtime entrypoint: install the controller-owned config, start the private bridge, then run the
# Happy Agent daemon in the foreground (PID 1 is Docker's --init).
set -eu
umask 077

mkdir -p "$HOME/happy/config" "$HOME/.codex" "$HOME/projects/chats" "$HOME/.agent-runtime"

# Install the gateway-owned config. If the person chose their own Anthropic API key (written by
# the gateway to the private file below), add it to the built-in Claude account as Happy's
# documented `api_key`, with a display name the gateway reads back from GET /v0/config. Shell
# builtins only, so the key never appears in any process's argv.
key_file="$HOME/.agent-runtime/anthropic-api-key"
api_key=""
if [ -s "$key_file" ]; then
  IFS= read -r api_key < "$key_file" || true
  case $api_key in *[!A-Za-z0-9_-]*) api_key="" ;; esac
fi
while IFS= read -r line; do
  printf '%s\n' "$line"
  if [ "$line" = "[providers.claude]" ] && [ -n "$api_key" ]; then
    printf 'name = "Anthropic API key"\napi_key = "%s"\n' "$api_key"
  fi
done < /opt/agent-runtime/happy.toml > "$HOME/happy/config/happy.toml"
api_key=""
# The daemon writes live overrides (Tailcat, remote connections, defaults) to a generated
# runtime.toml that wins over happy.toml. Nothing here uses them, so the controller's policy is
# re-applied on every start.
rm -f "$HOME/.happy/agent/runtime.toml"

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
