#!/usr/bin/env bash
# Take a consistent state snapshot of one devnet node.
#
#     ./deploy/snapshot.sh [node]      (default: alice; see deploy/nodes.env)
#
# RocksDB/ParityDB hold an exclusive lock and buffer writes in memory, so a tar
# of a RUNNING node's database can be torn and is not a supportable backup. This
# script therefore stops the node, copies, and starts it again.
#
# ROUND15 — finality now SURVIVES this. The old note here said taking one node
# down pauses finalization; that was true of the 3-authority set, where
# GRANDPA's supermajority threshold was 3 of 3 and any absence was fatal to
# finality (measured in ROUND10.md §2.5). The set is now five, so the threshold
# is 4 and the remaining four still finalize while this script has one node
# stopped. Block production and finalization both continue. See README.md
# "Fault tolerance" for the verbatim evidence.
#
# Still true: do not snapshot two nodes at once. Two down of five leaves three,
# which is below the threshold of 4, and finality stalls until one returns.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=nodes.env
source "${REPO}/deploy/nodes.env"

NODE="${1:-alice}"
valid=no
for n in "${NODES[@]}"; do [[ "${n}" == "${NODE}" ]] && valid=yes; done
[[ "${valid}" == yes ]] || { echo "ERROR: node must be one of: ${NODES[*]} (got '${NODE}')"; exit 1; }

BASE="${HOME}/scalar-testnet/${NODE}"
SNAP_DIR="${HOME}/scalar-snapshots"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${SNAP_DIR}/${NODE}-${STAMP}.tar.zst"

[[ -d "${BASE}" ]] || { echo "ERROR: ${BASE} does not exist"; exit 1; }
mkdir -p "${SNAP_DIR}"

was_active=no
if systemctl --user is-active --quiet "scalar-${NODE}.service"; then
    was_active=yes
fi

cleanup() {
    if [[ "${was_active}" == yes ]]; then
        echo "==> restarting scalar-${NODE}.service"
        systemctl --user start "scalar-${NODE}.service"
    fi
}
trap cleanup EXIT

if [[ "${was_active}" == yes ]]; then
    echo "==> stopping scalar-${NODE}.service for a consistent copy"
    systemctl --user stop "scalar-${NODE}.service"
fi

echo "==> archiving ${BASE} -> ${OUT}"
if command -v zstd >/dev/null 2>&1; then
    tar -C "${HOME}/scalar-testnet" -cf - "${NODE}" | zstd -T0 -3 -o "${OUT}"
else
    OUT="${OUT%.zst}.gz"
    echo "    (zstd not found, falling back to gzip -> ${OUT})"
    tar -C "${HOME}/scalar-testnet" -czf "${OUT}" "${NODE}"
fi

echo "==> snapshot complete:"
ls -lh "${OUT}"
echo
echo "Restore with the node stopped:"
echo "    systemctl --user stop scalar-${NODE}.service"
echo "    rm -rf ~/scalar-testnet/${NODE}"
echo "    tar -C ~/scalar-testnet -xf ${OUT}"
echo "    systemctl --user start scalar-${NODE}.service"
