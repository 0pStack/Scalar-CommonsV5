#!/usr/bin/env bash
# DESTRUCTIVE. Wipe all devnet chain state and start from genesis again.
#
#     ./deploy/reset-chain.sh
#
# Use after regenerating the chainspec (a new genesis hash means the old
# database is a different chain and nodes will refuse it). Node keys are
# preserved so alice's bootnode peer id — and therefore the multiaddr baked
# into the other units — does not change.
#
# ROUND15: the node list comes from deploy/nodes.env. Previously it was a
# hardcoded `alice bob charlie` here and in two other scripts; a node missing
# from this loop would keep a database belonging to the OLD genesis and then
# fail to sync against the new one, which is a confusing way to find a typo.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${HOME}/scalar-testnet"

# shellcheck source=nodes.env
source "${REPO}/deploy/nodes.env"

echo "This will DELETE all chain data under ${BASE} for: ${NODES[*]}"
for node in "${NODES[@]}"; do
    [[ -d "${BASE}/${node}/chains" ]] && du -sh "${BASE}/${node}/chains" 2>/dev/null || true
done
echo
read -r -p "Type 'reset' to confirm: " confirm
[[ "${confirm}" == "reset" ]] || { echo "aborted"; exit 1; }

echo "==> stopping devnet"
systemctl --user stop scalar-devnet.target || true
for node in "${NODES[@]}"; do
    systemctl --user stop "scalar-${node}.service" || true
done

for node in "${NODES[@]}"; do
    # Delete only the chain database — keep node-key so peer ids are stable.
    rm -rf "${BASE:?}/${node}/chains"
    echo "==> wiped ${BASE}/${node}/chains"
done

echo "==> starting devnet from genesis"
systemctl --user start scalar-devnet.target
echo "Done. Watch with: journalctl --user -u scalar-alice -f"
