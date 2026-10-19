#!/usr/bin/env bash
# Scalar Commons — persistent 5-validator devnet installer (user systemd, no sudo).
#
# Idempotent: safe to re-run. It does NOT delete chain data; use `reset-chain.sh`
# for that. Run from anywhere:
#
#     ./deploy/install.sh
#
# What it does:
#   1. creates ~/scalar-testnet/<node> for every node in deploy/nodes.env
#   2. writes the fixed per-node network keys (0600) — these fix each node's
#      peer id, so alice's bootnode multiaddr stays valid across restarts
#   3. installs the user systemd units into ~/.config/systemd/user/
#   4. enables the target + every service (survives reboot via linger)
#
# It does NOT start anything — see README.md.
#
# ROUND15: the node list moved to deploy/nodes.env so install/reset/snapshot
# cannot disagree about which nodes exist.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${HOME}/scalar-testnet"
UNIT_DIR="${HOME}/.config/systemd/user"
BIN="${REPO}/target/release/scalar-node"
SPEC="${REPO}/deploy/scalar-local-raw.json"

# shellcheck source=nodes.env
source "${REPO}/deploy/nodes.env"

echo "==> repo:      ${REPO}"
echo "==> base path: ${BASE}"
echo "==> units:     ${UNIT_DIR}"
echo "==> nodes:     ${NODES[*]} (${#NODES[@]} validators)"

# ── preflight ────────────────────────────────────────────────────────────────
[[ -x "${BIN}" ]] || { echo "ERROR: ${BIN} missing. Run: cargo build --release -p scalar-node"; exit 1; }
[[ -f "${SPEC}" ]] || { echo "ERROR: ${SPEC} missing. Run: ./deploy/build-spec.sh"; exit 1; }

if ! loginctl show-user "$(id -un)" 2>/dev/null | grep -q '^Linger=yes'; then
    echo "WARNING: linger is NOT enabled for $(id -un) — the devnet will NOT"
    echo "         survive a reboot. Fix with: sudo loginctl enable-linger $(id -un)"
fi

# ── 1 + 2. base paths and fixed node keys ────────────────────────────────────
for node in "${NODES[@]}"; do
    mkdir -p "${BASE}/${node}"
    keyfile="${BASE}/${node}/node-key"
    # printf, not echo: substrate wants the bare 64 hex chars.
    printf '%s' "${NODE_KEYS[$node]}" > "${keyfile}"
    chmod 600 "${keyfile}"
    peer_id="$("${BIN}" key inspect-node-key --file "${keyfile}")"
    echo "==> ${node}: ${BASE}/${node}  peer id ${peer_id}"
done

# ── 3. install units ─────────────────────────────────────────────────────────
mkdir -p "${UNIT_DIR}"
units=(scalar-devnet.target)
for node in "${NODES[@]}"; do units+=("scalar-${node}.service"); done

for unit in "${units[@]}"; do
    install -m 644 "${REPO}/deploy/systemd/${unit}" "${UNIT_DIR}/${unit}"
    echo "==> installed ${unit}"
done

systemctl --user daemon-reload

# ── 4. enable ────────────────────────────────────────────────────────────────
systemctl --user enable "${units[@]}"

echo
echo "Installed and enabled. Start with:"
echo "    systemctl --user start scalar-devnet.target"
