#!/bin/sh
# The end-to-end run on a Docker host, from a copy of this repository (as root, e.g. sudo):
#
#   sudo BUN=$HOME/.bun/bin/bun scripts/e2e/run.sh          build, start, scenarios, measurements
#   sudo BUN=... scripts/e2e/run.sh scenarios|capacity       only one of the two
#
# Builds the image, writes a test .env (fresh random secrets, dev tokens, the mock's MCP origin and
# address) when there is none, starts compose.yaml + scripts/e2e/compose.yaml, then runs
# scripts/e2e.ts and saves its output in evidence/e2e.txt and evidence/capacity.txt.
set -eu
cd "$(dirname "$0")/../.."
BUN=${BUN:-bun}
PROJECT=${E2E_PROJECT:-tandem-agents-e2e}
IMAGE=${TANDEM_IMAGE:-tandem:agents-e2e}
what=${1:-all}
if [ ! -f .env ]; then
  cat > .env <<ENV
AUTH_MODE=dev
DEV_AUTH_SECRET=$(openssl rand -hex 32)
SERVICE_SECRET=$(openssl rand -hex 32)
MCP_ALLOWED_ORIGINS=http://mock.tandem.test:4798
EGRESS_ALLOW_RANGES=172.29.77.10/32
TANDEM_IMAGE=$IMAGE
ENV
fi
docker build -t "$IMAGE" .
docker compose -p "$PROJECT" -f compose.yaml -f scripts/e2e/compose.yaml up -d --wait
export E2E_PROJECT=$PROJECT
if [ "$what" = all ] || [ "$what" = scenarios ]; then
  "$BUN" scripts/e2e.ts 2>&1 | tee evidence/e2e.txt
fi
if [ "$what" = all ] || [ "$what" = capacity ]; then
  "$BUN" scripts/e2e.ts capacity 2>&1 | tee evidence/capacity.txt
fi
