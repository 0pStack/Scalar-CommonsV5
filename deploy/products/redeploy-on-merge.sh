#!/usr/bin/env bash
# Redeploy scalarnet.io when a merge to master touches landing/ or docs/.
# Run every 10 minutes by scalar-redeploy.timer (issue #158).
#
# WHY: deploy/public/redeploy-site.sh is the reproducible path from a repo state
# to the live site, and nothing ran it. A merged docs fix sat on origin/master
# while the public site served the previous build until someone ssh'd in.
#
# WHAT A TICK DOES
#   1. `git fetch` a DEDICATED clone ($REDEPLOY_SRC) — never the working
#      checkout, which may sit on any branch with local edits.
#   2. origin/master == last deployed SHA  ->  exit 0. An idle tick is one fetch.
#   3. Moved: if none of the NEW commits (last..origin/master) touch landing/ or
#      docs/, record the new SHA and exit 0 without building.
#   4. Otherwise check out origin/master and build BOTH sites into a staging
#      directory next to the live webroots. Only when that build exits 0 are the
#      staging directories swapped into place with `mv --exchange` (renameat2
#      RENAME_EXCHANGE: atomic, no moment with a missing or half-written site).
#      A failing build removes staging and leaves the live site and the recorded
#      SHA untouched, so the next tick tries again.
#   5. Log the deployed SHA to the journal.
#
# NO PRIVILEGE. It reads a public repo and writes two directories the deploy
# user already owns. No credential, no sudo, no nginx reload (nginx re-reads
# static files per request).
set -euo pipefail

REDEPLOY_REMOTE="${REDEPLOY_REMOTE:-https://github.com/tejaspatil1936/scalar-commons-v4.git}"
REDEPLOY_SRC="${REDEPLOY_SRC:-$HOME/scalar-products/site-src}"
REDEPLOY_STATE="${REDEPLOY_STATE:-$HOME/scalar-products/redeploy}"
SITE_ROOT="${SITE_ROOT:-/var/www/scalarnet}"
BRANCH="${REDEPLOY_BRANCH:-master}"

say() { echo "redeploy: $*"; }
die() { echo "redeploy: FAILED — $*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "do not run as root"
[ -d "$SITE_ROOT/landing" ] && [ -d "$SITE_ROOT/docs" ] || die "$SITE_ROOT must already contain landing/ and docs/"
[ -w "$SITE_ROOT" ] || die "$SITE_ROOT is not writable by $(id -un); staging and the swap happen there"

mkdir -p "$REDEPLOY_STATE"
SHA_FILE="$REDEPLOY_STATE/last-deployed-sha"

if [ ! -d "$REDEPLOY_SRC/.git" ]; then
    say "cloning $REDEPLOY_REMOTE -> $REDEPLOY_SRC"
    git clone --quiet "$REDEPLOY_REMOTE" "$REDEPLOY_SRC"
fi
git -C "$REDEPLOY_SRC" fetch --quiet origin "$BRANCH"
NEW="$(git -C "$REDEPLOY_SRC" rev-parse "origin/$BRANCH")"
LAST="$(cat "$SHA_FILE" 2>/dev/null || true)"

if [ "$NEW" = "$LAST" ]; then
    say "origin/$BRANCH still at ${NEW:0:12}; nothing to do"
    exit 0
fi

touches_site=yes
if [ -n "$LAST" ] && git -C "$REDEPLOY_SRC" cat-file -e "$LAST^{commit}" 2>/dev/null \
   && git -C "$REDEPLOY_SRC" merge-base --is-ancestor "$LAST" "$NEW"; then
    changed="$(git -C "$REDEPLOY_SRC" diff --name-only "$LAST" "$NEW" -- landing docs)"
    [ -n "$changed" ] || touches_site=no
else
    # First run, or history was rewritten past the recorded SHA: we cannot say
    # what changed, so rebuild rather than risk a missed deploy.
    say "no usable last-deployed SHA (${LAST:-none}); deploying unconditionally"
fi

if [ "$touches_site" = no ]; then
    say "origin/$BRANCH ${LAST:0:12}..${NEW:0:12} touches neither landing/ nor docs/; not rebuilding"
    echo "$NEW" > "$SHA_FILE"
    exit 0
fi

say "deploying ${NEW:0:12} ($(git -C "$REDEPLOY_SRC" log -1 --format=%s "$NEW"))"
git -C "$REDEPLOY_SRC" checkout --quiet --force --detach "$NEW"

STAGE="$(mktemp -d "$SITE_ROOT/.staging.XXXXXX")"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT
mkdir -m 755 "$STAGE/landing" "$STAGE/docs"

BUILD_CMD="${REDEPLOY_BUILD_CMD:-$REDEPLOY_SRC/deploy/public/redeploy-site.sh}"
if ! LANDING_DEST="$STAGE/landing" DOCS_DEST="$STAGE/docs" "$BUILD_CMD"; then
    die "build of ${NEW:0:12} failed; live site left untouched, last deployed SHA stays ${LAST:0:12}"
fi

# Build succeeded. Swap each staged tree with the live one atomically; the
# previous site ends up in $STAGE and is removed by the trap.
mv --no-target-directory --exchange "$STAGE/landing" "$SITE_ROOT/landing"
mv --no-target-directory --exchange "$STAGE/docs" "$SITE_ROOT/docs"
echo "$NEW" > "$SHA_FILE"
say "deployed $NEW"
