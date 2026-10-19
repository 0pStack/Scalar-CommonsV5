#!/usr/bin/env bash
# Render the nginx templates by substituting values from domain.env.
#
# Writes only into deploy/public/rendered/ inside the repo. It does NOT copy
# anything into /etc/nginx, does not reload nginx, and does not touch the
# firewall. A human does those steps — see INSTALL.md.
#
# PRECEDENCE: environment > domain.env. An exported variable always wins, so a
# host can render without editing — or dirtying — a tracked file:
#
#   DOMAIN=example.org LANDING_DIST=/var/www/site/landing \
#     DOCS_DIST=/var/www/site/docs ACME_WEBROOT=/var/www/acme ./render-config.sh
#
# This is how the scalarnet.io reproduction in INSTALL.md is checked, and it is
# why the real domain of a deployment never has to be committed here.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$HERE/domain.env"
OUT_DIR="$HERE/rendered"

[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }

# Remember anything the caller exported, so sourcing the file cannot clobber it.
_env_DOMAIN="${DOMAIN-}"
_env_LANDING_DIST="${LANDING_DIST-}"
_env_DOCS_DIST="${DOCS_DIST-}"
_env_ACME_WEBROOT="${ACME_WEBROOT-}"

# shellcheck source=/dev/null
set -a; . "$ENV_FILE"; set +a

# ...then put it back. Environment wins over the file, never the other way.
# Written as if/fi, not `[ -n x ] && VAR=y`: under `set -e` a false AND-list is
# itself a failing command and would abort the script on the first unset var.
if [ -n "$_env_DOMAIN" ];       then DOMAIN="$_env_DOMAIN"; fi
if [ -n "$_env_LANDING_DIST" ]; then LANDING_DIST="$_env_LANDING_DIST"; fi
if [ -n "$_env_DOCS_DIST" ];    then DOCS_DIST="$_env_DOCS_DIST"; fi
if [ -n "$_env_ACME_WEBROOT" ]; then ACME_WEBROOT="$_env_ACME_WEBROOT"; fi

: "${DOMAIN:?DOMAIN unset in domain.env and not in the environment}"
: "${LANDING_DIST:?LANDING_DIST unset in domain.env and not in the environment}"
: "${DOCS_DIST:?DOCS_DIST unset in domain.env and not in the environment}"
: "${ACME_WEBROOT:?ACME_WEBROOT unset in domain.env and not in the environment}"

if [ "$DOMAIN" = "example.com" ]; then
    echo "refusing to render: DOMAIN is still the placeholder 'example.com'." >&2
    echo "Edit $ENV_FILE first." >&2
    exit 1
fi

mkdir -p "$OUT_DIR"

for tpl in "$HERE"/nginx/*.conf.template; do
    out="$OUT_DIR/$(basename "${tpl%.template}")"
    sed -e "s|<DOMAIN>|$DOMAIN|g" \
        -e "s|<LANDING_DIST>|$LANDING_DIST|g" \
        -e "s|<DOCS_DIST>|$DOCS_DIST|g" \
        -e "s|<ACME_WEBROOT>|$ACME_WEBROOT|g" \
        "$tpl" > "$out"
    echo "rendered $out"
done

if grep -rn '<DOMAIN>\|<LANDING_DIST>\|<DOCS_DIST>\|<ACME_WEBROOT>' "$OUT_DIR"; then
    echo "ERROR: unsubstituted placeholders remain (above)." >&2
    exit 1
fi

echo
echo "OK. Nothing has been installed. Next: INSTALL.md step 6."
