#!/usr/bin/env bash
# Regenerate the committed raw chainspec from the `local` preset.
#
#     ./deploy/build-spec.sh
#
# The raw spec is committed so every node on this box (and any future node that
# joins) boots byte-identical genesis, independent of the binary that happens to
# be on disk. Regenerating it after a runtime change produces a DIFFERENT
# genesis hash — that is a new chain. Existing ~/scalar-testnet data will not be
# compatible; see README.md "Resetting the chain".

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${REPO}/target/release/scalar-node"
OUT="${REPO}/deploy/scalar-local-raw.json"

[[ -x "${BIN}" ]] || { echo "ERROR: ${BIN} missing. Run: cargo build --release -p scalar-node"; exit 1; }

echo "==> building raw spec from --chain local"
"${BIN}" build-spec --chain local --raw --disable-default-bootnode > "${OUT}.tmp"
mv "${OUT}.tmp" "${OUT}"

echo "==> wrote ${OUT}"
echo "==> genesis / spec identity:"
grep -oE '"(id|name|protocolId)": *"[^"]*"' "${OUT}" | head -5
