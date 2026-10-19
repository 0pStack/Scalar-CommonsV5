#!/usr/bin/env bash
# Scalar Commons — product installer (indexer, explorer, faucet).
#
# User systemd, no sudo — same model as deploy/install.sh, which installs the
# validators. This one installs the three things that read *from* that devnet:
#
#     indexer   127.0.0.1:8080   REST API over chain events
#     explorer  127.0.0.1:8081   web UI
#     faucet    127.0.0.1:8082   devnet CMN drip
#
# All three are pointed at ws://127.0.0.1:9944 (alice, the archive node) and
# all three bind loopback only. Idempotent: safe to re-run. It never overwrites
# an existing env file, because faucet.env holds a signing key.
#
# It does NOT start anything — see README.md.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="${REPO}/deploy/products"
UNIT_DIR="${HOME}/.config/systemd/user"
ENV_DIR="${HOME}/.config/scalar-commons"
STATE_DIR="${HOME}/scalar-products/indexer"

# product -> the entrypoint its unit executes, relative to the product dir.
# Checked before install so a missing explorer build fails here, loudly, rather
# than as a restart loop in the journal an hour later.
PRODUCTS=(indexer explorer faucet)
declare -A ENTRYPOINTS=(
    [indexer]=src/index.ts
    [explorer]=dist/index.js
    # The faucet runs its BUILT entrypoint. src/index.ts under
    # --experimental-strip-types fails outright — type-stripping does not
    # rewrite './x.js' specifiers to './x.ts' — which is what put the unit in a
    # 71-restart crash loop on 2026-09-07. Issues #115 and #127.
    [faucet]=dist/index.js
)

echo "==> repo:     ${REPO}"
echo "==> units:    ${UNIT_DIR}"
echo "==> env:      ${ENV_DIR}"
echo "==> products: ${PRODUCTS[*]}"

# ── preflight ────────────────────────────────────────────────────────────────
command -v node >/dev/null || { echo "ERROR: node not found; the units call /usr/bin/node"; exit 1; }

for product in "${PRODUCTS[@]}"; do
    entry="${REPO}/${product}/${ENTRYPOINTS[$product]}"
    if [[ ! -f "${entry}" ]]; then
        echo "ERROR: ${entry} missing."
        if [[ "${product}" == "explorer" || "${product}" == "faucet" ]]; then
            echo "       ${product} is compiled ahead of time. Run: (cd ${REPO}/${product} && npm ci && npm run build)"
        else
            echo "       Run: (cd ${REPO}/${product} && npm ci)"
        fi
        exit 1
    fi
    [[ -d "${REPO}/${product}/node_modules" ]] || echo "WARNING: ${product}/node_modules missing — run 'npm ci' in ${REPO}/${product}"
done

# The units hardcode their WorkingDirectory, exactly as deploy/systemd/*.service
# hardcode the validator paths. Installing from a different checkout (a git
# worktree, say) would install units that run someone else's code, so say so.
unit_repo="$(sed -n 's|^WorkingDirectory=\(.*\)/indexer$|\1|p' "${SRC}/scalar-indexer.service")"
if [[ "${unit_repo}" != "${REPO}" ]]; then
    echo "WARNING: units point at ${unit_repo} but this script ran from ${REPO}."
    echo "         The installed services will run the code in ${unit_repo}."
fi

if ! loginctl show-user "$(id -un)" 2>/dev/null | grep -q '^Linger=yes'; then
    echo "WARNING: linger is NOT enabled for $(id -un) — the products will NOT"
    echo "         survive a reboot. Fix with: sudo loginctl enable-linger $(id -un)"
fi

# ── 1. state directory ───────────────────────────────────────────────────────
# The indexer writes its SQLite index here. Keeping it out of the checkout is
# what lets the repo be rebuilt, or the worktree thrown away, without losing
# the index.
mkdir -p "${STATE_DIR}"
echo "==> state: ${STATE_DIR}"

# ── 2. env files ─────────────────────────────────────────────────────────────
# 0600 and never clobbered: faucet.env is where a real FAUCET_SEED goes, and
# re-running the installer must not overwrite the operator's key with a
# template full of commented-out dev defaults.
mkdir -p "${ENV_DIR}"
chmod 700 "${ENV_DIR}"
for product in "${PRODUCTS[@]}"; do
    envfile="${ENV_DIR}/${product}.env"
    if [[ -e "${envfile}" ]]; then
        echo "==> kept ${envfile} (already exists)"
    else
        install -m 600 "${SRC}/${product}.env.example" "${envfile}"
        echo "==> wrote ${envfile}"
    fi
done

# ── 3. install units ─────────────────────────────────────────────────────────
mkdir -p "${UNIT_DIR}"
units=()
for product in "${PRODUCTS[@]}"; do units+=("scalar-${product}.service"); done

for unit in "${units[@]}"; do
    install -m 644 "${SRC}/${unit}" "${UNIT_DIR}/${unit}"
    echo "==> installed ${unit}"
done

systemctl --user daemon-reload

# ── 4. enable ────────────────────────────────────────────────────────────────
systemctl --user enable "${units[@]}"

echo
echo "Installed and enabled. Start with:"
echo "    systemctl --user start ${units[*]}"
echo
echo "Then:"
echo "    curl -s http://127.0.0.1:8080/v1/status"
echo "    curl -sI http://127.0.0.1:8081/"
echo "    curl -s http://127.0.0.1:8082/health"
