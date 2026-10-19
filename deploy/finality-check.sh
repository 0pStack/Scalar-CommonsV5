#!/usr/bin/env bash
# Sample every devnet node's best and FINALIZED height.
#
#     ./deploy/finality-check.sh              # one sample of every node
#     ./deploy/finality-check.sh 12 5         # 12 samples, 5s apart
#
# ROUND15 exists because ROUND10 could only show block PRODUCTION continuing
# when a validator went down — finalized height sat still, and the two are easy
# to confuse when you are only watching `journalctl` scroll. This script prints
# both side by side so a stall is unmistakable:
#
#     [ 12:00:05Z] alice best=  120 final=  117   bob best=  120 final=  117
#
# `final` climbing is the property that matters. If `best` climbs while `final`
# is pinned, the chain is producing blocks nobody can rely on.
#
# Nodes whose RPC does not answer print `DOWN` — that is the expected reading
# for the validator you deliberately stopped, not an error.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=nodes.env
source "${REPO}/deploy/nodes.env"

SAMPLES="${1:-1}"
INTERVAL="${2:-5}"

# Hex block number out of a header for the given block hash method.
height_for() {
    local port="$1" hash_method="$2"
    local hash header
    hash="$(curl -s --max-time 3 -H 'Content-Type: application/json' \
        -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"${hash_method}\",\"params\":[]}" \
        "http://127.0.0.1:${port}" | sed -n 's/.*"result":"\([^"]*\)".*/\1/p')" || return 1
    [[ -n "${hash}" ]] || return 1
    header="$(curl -s --max-time 3 -H 'Content-Type: application/json' \
        -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"chain_getHeader\",\"params\":[\"${hash}\"]}" \
        "http://127.0.0.1:${port}" | sed -n 's/.*"number":"\([^"]*\)".*/\1/p')" || return 1
    [[ -n "${header}" ]] || return 1
    printf '%d' "${header}"   # 0x-prefixed hex → decimal
}

for ((s = 1; s <= SAMPLES; s++)); do
    line="[$(date -u +%H:%M:%SZ)]"
    for node in "${NODES[@]}"; do
        port="${RPC_PORTS[$node]}"
        if best="$(height_for "${port}" chain_getBlockHash 2>/dev/null)" &&
           final="$(height_for "${port}" chain_getFinalizedHead 2>/dev/null)"; then
            line+="$(printf '  %-8s best=%5d final=%5d' "${node}" "${best}" "${final}")"
        else
            line+="$(printf '  %-8s %-22s' "${node}" "DOWN")"
        fi
    done
    echo "${line}"
    # `if`, not `(( … )) && sleep`: on the final iteration the test is false, so
    # the && form would leave a non-zero status and `set -e` would exit 1 on an
    # otherwise successful run.
    if (( s < SAMPLES )); then sleep "${INTERVAL}"; fi
done
