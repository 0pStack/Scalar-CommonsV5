#!/usr/bin/env bash
# SC-E1 — artifact guard. The smoke test's whole point is to prove the
# ephemeral-network path yields a real export; an empty or missing export is a
# failed smoke test, not a green one. Fail the job if $EXPORT_DIR is absent or
# contains no non-empty files.
#
# Usage: check-export.sh <EXPORT_DIR>
set -euo pipefail

EXPORT_DIR="${1:-experiments/sc-e1/export}"

if [ ! -d "$EXPORT_DIR" ]; then
  echo "::error::sc-e1 export dir '$EXPORT_DIR' is missing — smoke test failed." >&2
  exit 1
fi

# Any regular file with size > 0 counts as a real export.
non_empty="$(find "$EXPORT_DIR" -type f -size +0c | head -n 1 || true)"
if [ -z "$non_empty" ]; then
  echo "::error::sc-e1 export dir '$EXPORT_DIR' has no non-empty files — smoke test failed." >&2
  exit 1
fi

file_count="$(find "$EXPORT_DIR" -type f -size +0c | wc -l | tr -d ' ')"
echo "[sc-e1] export OK — $file_count non-empty file(s) under $EXPORT_DIR"
