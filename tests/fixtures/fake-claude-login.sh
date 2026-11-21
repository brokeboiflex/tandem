#!/bin/sh
# A stand-in for `claude auth login --claudeai` and `claude auth logout` in sign-in tests. It prints
# Claude Code's own lines (the page, its prompt, its verdicts on a code) and never touches a network.
#   good…     signs in (writes ~/.claude/.credentials.json) and exits 0
#   refused…  Claude refuses the code for good: the attempt ends (exit 1)
#   crash…    fails for another reason (exit 1)
#   anything else is a malformed code: Claude Code 2.1.330's own refusal, and it keeps waiting
set -u
dir="$HOME/.claude"
case "${1:-} ${2:-}" in
  "auth logout") rm -f "$dir/.credentials.json"; echo "Successfully logged out from your Anthropic account."; exit 0 ;;
  "auth login") ;;
  *) echo "unexpected arguments: $*" >&2; exit 2 ;;
esac
mkdir -p "$dir"
n=$(( $(cat "$dir/.fake-attempts" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$dir/.fake-attempts"
echo "Opening browser to sign in…"
echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=attempt$n"
printf "Paste code here if prompted > "
while IFS= read -r code; do
  case "$code" in
    good*) echo '{"claudeAiOauth":{}}' > "$dir/.credentials.json"; echo "Login successful."; exit 0 ;;
    refused*) echo "Login failed: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code."; exit 1 ;;
    crash*) echo "Login failed: connect ECONNREFUSED 160.79.104.10:443"; exit 1 ;;
    *) echo "That doesn't look like the full code. Copy all of it, including the # in the middle."; printf "Paste code here if prompted > " ;;
  esac
done
exit 1
