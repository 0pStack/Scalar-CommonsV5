#!/usr/bin/env bash
# SC-E1 — drive N fast eras against the live zombienet via the agent SDK (§8.3).
#
# Populates a tiny synthetic agent cohort and runs the scripted archetype loops
# (register / stake / heartbeat / escrow / oracle / vote / settle_era / claim)
# for ERAS eras. Settlement is permissionless (§4): each agent calls settle_era
# on a random backoff when an era is due — this script never holds a root key.
#
# Usage: run-eras.sh <ERAS> <POPULATION> <RPC_URL>
set -euo pipefail

ERAS="${1:-5}"
POPULATION="${2:-8}"
RPC_URL="${3:-ws://127.0.0.1:9944}"

echo "[sc-e1] run-eras: ERAS=$ERAS POPULATION=$POPULATION RPC=$RPC_URL"

# TODO: unblock after PR #5 merges (P0-3) — the TypeScript agent SDK lives in
# `sdk/` and exposes the minimal API of §8.3. Until it exists, drive nothing and
# fail loudly so the smoke job cannot go green without a real run.
if [ ! -d "sdk" ]; then
  echo "::error::sc-e1 SDK (sdk/, P0-3 / PR #5) not present — cannot run eras." >&2
  echo "        This is expected until PR #5 merges; the smoke job is scaffolded" >&2
  echo "        but not yet executable end-to-end." >&2
  exit 1
fi

# TODO: unblock after PR #5 merges (P0-3) — replace with the real invocation, e.g.
#   ( cd sdk && npm ci && npm run sc-e1 -- \
#       --eras "$ERAS" --population "$POPULATION" --rpc "$RPC_URL" )
echo "::error::sc-e1 SDK entrypoint not wired yet (TODO: PR #5)." >&2
exit 1
