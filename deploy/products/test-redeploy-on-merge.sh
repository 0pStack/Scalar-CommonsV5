#!/usr/bin/env bash
# Offline test for redeploy-on-merge.sh — no network, no real site, no npm.
#
# Builds a throwaway origin repo, a fake build command and two fake webroots,
# then drives the real script through the four cases #158 names:
#   1. first run            -> deploys, records the SHA
#   2. idle tick             -> origin/master unmoved: no build
#   3. merge touching neither landing/ nor docs/ -> no build, SHA advanced
#   4. merge touching docs/  -> build, swap, SHA advanced
#   5. merge touching docs/ whose build FAILS -> previous site untouched, SHA NOT advanced
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/redeploy-on-merge.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

git init -q -b master "$T/origin"
git -C "$T/origin" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
commit() { mkdir -p "$T/origin/$(dirname "$1")"; echo "$2" > "$T/origin/$1"; git -C "$T/origin" add -A; git -C "$T/origin" -c user.email=t@t -c user.name=t commit -q -m "$1"; }
commit docs/index.md v1

mkdir -p "$T/www/landing" "$T/www/docs"
echo OLD > "$T/www/landing/index.html"; echo OLD > "$T/www/docs/index.html"

# Fake build: writes the checked-out docs/index.md into both destinations,
# or fails when the checkout says FAIL. Counts its invocations.
cat > "$T/build.sh" <<'B'
#!/usr/bin/env bash
set -euo pipefail
echo x >> "$COUNTER"
c="$(cat "$REPO_UNDER_TEST/docs/index.md")"
[ "$c" != FAIL ] || { echo "build failed on purpose" >&2; exit 1; }
echo "$c" > "$LANDING_DEST/index.html"; echo "$c" > "$DOCS_DEST/index.html"
B
chmod +x "$T/build.sh"

run() {
  COUNTER="$T/count" REPO_UNDER_TEST="$T/src" \
  REDEPLOY_REMOTE="$T/origin" REDEPLOY_SRC="$T/src" REDEPLOY_STATE="$T/state" \
  SITE_ROOT="$T/www" REDEPLOY_BUILD_CMD="$T/build.sh" "$SCRIPT"
}
builds() { [ -f "$T/count" ] && wc -l < "$T/count" | tr -d ' ' || echo 0; }
head_sha() { git -C "$T/origin" rev-parse HEAD; }

run >/dev/null
[ "$(builds)" = 1 ] || fail "first run should build once, built $(builds)"
[ "$(cat "$T/www/docs/index.html")" = v1 ] || fail "first run did not publish"
[ "$(cat "$T/state/last-deployed-sha")" = "$(head_sha)" ] || fail "first run did not record SHA"
pass "1 first run deploys and records $(head_sha | cut -c1-8)"

run >/dev/null
[ "$(builds)" = 1 ] || fail "idle tick built"
pass "2 idle tick: no build"

commit pallets/x.rs code
run >/dev/null
[ "$(builds)" = 1 ] || fail "non-site merge built"
[ "$(cat "$T/state/last-deployed-sha")" = "$(head_sha)" ] || fail "non-site merge did not advance SHA"
pass "3 merge outside landing/ and docs/: no build, SHA advanced"

commit docs/index.md v2
run >/dev/null
[ "$(builds)" = 2 ] || fail "docs merge did not build"
[ "$(cat "$T/www/docs/index.html")" = v2 ] || fail "docs merge not published"
[ "$(cat "$T/www/landing/index.html")" = v2 ] || fail "landing not published"
[ -z "$(ls -A "$T/www" | grep -v '^landing$\|^docs$' || true)" ] || fail "staging left behind: $(ls -A "$T/www")"
pass "4 docs merge: built, swapped, no staging left"

good="$(cat "$T/state/last-deployed-sha")"
commit docs/index.md FAIL
if run >/dev/null 2>&1; then fail "failed build exited 0"; fi
[ "$(cat "$T/www/docs/index.html")" = v2 ] || fail "failed build touched the live docs"
[ "$(cat "$T/www/landing/index.html")" = v2 ] || fail "failed build touched the live landing"
[ "$(cat "$T/state/last-deployed-sha")" = "$good" ] || fail "failed build advanced the SHA"
[ -z "$(ls -A "$T/www" | grep -v '^landing$\|^docs$' || true)" ] || fail "failed build left staging: $(ls -A "$T/www")"
pass "5 failed build: live site untouched, SHA not advanced, staging removed"
echo "ALL PASS"
