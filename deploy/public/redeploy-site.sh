#!/usr/bin/env bash
# Rebuild the two static sites and publish them into the nginx webroots.
#
# RUN THIS AFTER EVERY MERGE THAT TOUCHES landing/ OR docs/. Neither site is
# built by CI into the webroot and nginx serves files, not a repo — so until
# this runs, scalarnet.io is still serving the previous merge. That is exactly
# how the landing page came to advertise spec 304 while the chain ran 305.
#
# NO ROOT. It writes only into the two webroots, which are owned by the deploy
# user (see INSTALL.md step 5). It does not touch nginx, systemd, the firewall
# or any chain service; nothing here needs a reload, because nginx re-reads
# static files on every request.
#
# The two build settings are not optional and are the whole reason this script
# exists rather than a line in a README:
#   * landing MUST be built with LANDING_OUT_DIR pointing at the webroot;
#     a bare `npm run build` writes landing/dist and publishes nothing.
#   * docs MUST be built with DOCS_BASE=/docs/. A default build emits absolute
#     /assets/... URLs that 404 under the /docs/ prefix, and the pages render
#     unstyled with every internal link broken.
# Both are verified below, after the fact, against the files actually published.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LANDING_DEST="${LANDING_DEST:-/var/www/scalarnet/landing}"
DOCS_DEST="${DOCS_DEST:-/var/www/scalarnet/docs}"

die() { echo "redeploy-site: FAILED — $*" >&2; exit 1; }
say() { echo "redeploy-site: $*"; }

# --- refuse to run as root -------------------------------------------------
# Building as root leaves root-owned node_modules and webroot files that the
# deploy user can then never overwrite, turning the next run into a puzzle.
[ "$(id -u)" -ne 0 ] || die "do not run this as root; it is a non-root script by design"

# --- guard the destinations before anything is removed ---------------------
for d in "$LANDING_DEST" "$DOCS_DEST"; do
    case "$d" in
        ""|"/"|"/var"|"/var/www") die "refusing to publish into '$d'" ;;
    esac
    [ -d "$d" ] || die "destination does not exist: $d (create it first, see INSTALL.md step 5)"
    [ -w "$d" ] || die "destination not writable by $(id -un): $d"
done

# ===========================================================================
#  landing
# ===========================================================================
say "building landing -> $LANDING_DEST"
( cd "$REPO/landing" && npm ci --silent && LANDING_OUT_DIR="$LANDING_DEST" npm run build )

[ -f "$LANDING_DEST/index.html" ] || die "no index.html at $LANDING_DEST — the landing build published nothing"
[ -s "$LANDING_DEST/index.html" ] || die "$LANDING_DEST/index.html is empty"
[ -f "$LANDING_DEST/styles.css" ] || die "no styles.css at $LANDING_DEST — the landing build is incomplete"

# ===========================================================================
#  docs
# ===========================================================================
say "building docs (DOCS_BASE=/docs/) -> $DOCS_DEST"
( cd "$REPO/docs" && npm ci --silent && DOCS_BASE=/docs/ npm run build )

DOCS_DIST="$REPO/docs/.vitepress/dist"
[ -f "$DOCS_DIST/index.html" ] || die "no index.html in $DOCS_DIST — the docs build produced nothing to publish"

say "publishing $DOCS_DIST -> $DOCS_DEST"
# Clear the destination's contents (not the directory itself: it may be owned
# by another user, and nginx has it open).
find "$DOCS_DEST" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -a "$DOCS_DIST/." "$DOCS_DEST/"

[ -f "$DOCS_DEST/index.html" ] || die "no index.html at $DOCS_DEST — the copy did not land"
[ -s "$DOCS_DEST/index.html" ] || die "$DOCS_DEST/index.html is empty"

# --- the DOCS_BASE regression guard ----------------------------------------
# A build without DOCS_BASE=/docs/ is not a crash; it is a site that 200s and
# renders unstyled. The only way to catch it is to look at the emitted URLs.
# `|| true` is load-bearing: grep exits 1 when it finds nothing, which is the
# PASSING case here, and `set -o pipefail` would turn that into a script abort.
bare="$( { grep -rhoE '(src|href)="/assets/' "$DOCS_DEST" --include='*.html' || true; } | wc -l )"
[ "$bare" -eq 0 ] || die "$bare asset URL(s) under $DOCS_DEST point at /assets/ instead of /docs/assets/ — rebuilt without DOCS_BASE=/docs/"
grep -qE '(src|href)="/docs/assets/' "$DOCS_DEST/index.html" || die "no /docs/-prefixed asset URLs in $DOCS_DEST/index.html — DOCS_BASE did not take effect"

say "OK"
say "  landing: $LANDING_DEST/index.html ($(wc -c <"$LANDING_DEST/index.html") bytes)"
say "  docs:    $DOCS_DEST/index.html ($(wc -c <"$DOCS_DEST/index.html") bytes), 0 bare /assets/ refs"
