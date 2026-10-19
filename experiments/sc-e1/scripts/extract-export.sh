#!/usr/bin/env bash
# SC-E1 — extract the indexer measurement export (§8.4) after the run.
#
# The Node.js indexer is the instrument: it produces per-era CSV/JSONL of
# per-account earnings, fees burned, escrow volume, oracle scores and settlement
# events. This script pulls that export to $OUT_DIR so the workflow can upload it
# as the run artifact.
#
# Usage: extract-export.sh <RPC_URL> <OUT_DIR>
set -euo pipefail

RPC_URL="${1:-ws://127.0.0.1:9944}"
OUT_DIR="${2:-experiments/sc-e1/export}"

mkdir -p "$OUT_DIR"
echo "[sc-e1] extract-export: RPC=$RPC_URL OUT_DIR=$OUT_DIR"

# TODO: unblock after PR #7 merges (P0-5) — the indexer lives in `indexer/` and
# validates itself against chain storage before first use. Until it exists there
# is nothing to export; fail so check-export.sh reports an empty/missing artifact.
if [ ! -d "indexer" ]; then
  echo "::error::sc-e1 indexer (indexer/, P0-5 / PR #7) not present — no export." >&2
  echo "        Expected until PR #7 merges; smoke job is scaffolded only." >&2
  exit 1
fi

# TODO: unblock after PR #7 merges (P0-5) — replace with the real export call, e.g.
#   ( cd indexer && npm ci && npm run export -- \
#       --rpc "$RPC_URL" --out "../$OUT_DIR" --format jsonl )
echo "::error::sc-e1 indexer export entrypoint not wired yet (TODO: PR #7)." >&2
exit 1
