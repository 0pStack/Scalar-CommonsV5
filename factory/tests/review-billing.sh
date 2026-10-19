#!/usr/bin/env bash
# factory/tests/review-billing.sh — prove review.sh loads its billing env.
#
# WHY THIS TEST EXISTS (audit finding P6-03 / I-13 cause 1)
#
# `lib/loop.sh` calls `load_billing_env` before it spends anything; `review.sh`
# did not. Under systemd the reviewer therefore inherited neither
# `~/.factory/env`'s PATH nor whatever billing env was current, and all six
# systemd-launched reviews — 18 of 18 lenses — exited 127.
#
# POLICY FLIP (LAB decision 002 amendment, 27 Sep 2026 Max-subscription
# cutover): this box's inference proxy is retired; `~/.factory/env` no longer
# sets ANTHROPIC_API_KEY/ANTHROPIC_BASE_URL, and loops now bill the Claude Max
# subscription on purpose, via `lib/common.sh:load_billing_env`. The OLD
# policy (fail closed if no key reachable, to stop loops silently drawing on
# the interactive subscription) is inverted: the interactive subscription IS
# now the billing source, and a stray API key left in the environment is the
# thing that gets scrubbed, because it would silently point billing at a dead
# proxy (see the 217/219/223/225 incident, 2026-09-27 ~01:51-02:36 UTC).
#
# So there are two properties, and both are asserted here:
#   1. review.sh calls load_billing_env — the same function loop.sh calls, not
#      a private re-implementation that could drift.
#   2. It calls it BEFORE any lens is spawned, and it never lets a stray key
#      reach the child process: present or absent, load_billing_env clears
#      ANTHROPIC_API_KEY/BASE_URL/AUTH_TOKEN and proceeds on Max billing.
#
# Property 2 is the load-bearing one. A structural grep alone would pass if the
# call sat after the lens loop, which would be no protection at all.
#
# No network, no real API spend: `gh` and `claude` are stubs on PATH.

set -uo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FACTORY_DIR="$(cd "$TESTS_DIR/.." && pwd)"
REVIEW="$FACTORY_DIR/review.sh"
[ -x "$REVIEW" ] || { printf 'FATAL: %s not found or not executable\n' "$REVIEW" >&2; exit 1; }

PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

# ---------------------------------------------------------------------------
# 0. Direct: load_billing_env actually scrubs the environment, not just the
#    log. Sections 2/3 below exercise review.sh end to end, but its stub `gh`
#    refuses before any lens spawns, so neither proves what environment a
#    spawned `claude` would actually see — a regression that logs the warning
#    but still exports the key would pass both. This calls load_billing_env
#    directly and inspects the resulting environment, closing that gap.
# ---------------------------------------------------------------------------
printf '\n\033[1m=== load_billing_env actually clears the environment, not just the log ===\033[0m\n'

ENVCHECK="$T/envcheck.txt"
ISOLATED_HOME="$T/isolated-home"; mkdir -p "$ISOLATED_HOME"   # never the real ~/.factory/env
(
  HOME="$ISOLATED_HOME"
  ANTHROPIC_API_KEY=sk-ant-should-be-cleared
  ANTHROPIC_BASE_URL=https://dead-proxy.example
  ANTHROPIC_AUTH_TOKEN=should-also-clear
  export HOME ANTHROPIC_API_KEY ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN
  # shellcheck source=/dev/null
  . "$FACTORY_DIR/lib/common.sh"
  load_billing_env >/dev/null 2>&1
  env
) > "$ENVCHECK" 2>&1

for var in ANTHROPIC_API_KEY ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN; do
  if grep -q "^${var}=" "$ENVCHECK"; then
    bad "$var is still exported after load_billing_env — a spawned claude would still see it"
  else
    ok "$var is gone from the environment after load_billing_env"
  fi
done

# ---------------------------------------------------------------------------
# 1. Structural: review.sh uses the shared helper, not a copy of it.
# ---------------------------------------------------------------------------
printf '\n\033[1m=== review.sh sources the shared billing preflight ===\033[0m\n'

if grep -q 'load_billing_env' "$REVIEW"; then
  ok 'review.sh calls load_billing_env'
else
  bad 'review.sh never calls load_billing_env (this is finding I-13 cause 1)'
fi

# The call must precede the lens definitions; if it came after, a spawn could
# already have happened on the wrong billing source.
CALL_LINE="$(grep -n '^[[:space:]]*load_billing_env[[:space:]]*$' "$REVIEW" | head -1 | cut -d: -f1)"
LENS_LINE="$(grep -n '^LENSES=' "$REVIEW" | head -1 | cut -d: -f1)"
# Flag-agnostic on purpose: this assertion is about WHERE the spawn happens
# relative to the billing preflight, not about which flags it carries. Pinning
# the exact flag string silently broke this check twice when --model was added.
RUN_LINE="$(grep -nE 'claude -p .*--dangerously-skip-permissions' "$REVIEW" | head -1 | cut -d: -f1)"
if [ -n "$CALL_LINE" ] && [ -n "$LENS_LINE" ] && [ "$CALL_LINE" -lt "$LENS_LINE" ]; then
  ok "load_billing_env at line $CALL_LINE precedes LENSES at line $LENS_LINE"
else
  bad "load_billing_env (line ${CALL_LINE:-none}) does not precede LENSES (line ${LENS_LINE:-none})"
fi
if [ -n "$CALL_LINE" ] && [ -n "$RUN_LINE" ] && [ "$CALL_LINE" -lt "$RUN_LINE" ]; then
  ok "load_billing_env at line $CALL_LINE precedes the claude -p spawn at line $RUN_LINE"
else
  bad "load_billing_env (line ${CALL_LINE:-none}) does not precede the spawn (line ${RUN_LINE:-none})"
fi

# ---------------------------------------------------------------------------
# 2. Behavioural: no key reachable => Max billing, preflight does not block.
#
# review.sh is expected to fail later — PR #999 does not exist, so its own
# diff fetch (git first, real gh calls only as its fallback) refuses — but
# that failure must come from the missing PR, never from the billing
# preflight — Max login with no key present is now the normal, expected case.
# ---------------------------------------------------------------------------
printf '\n\033[1m=== with no API key reachable, review.sh proceeds on Max billing ===\033[0m\n'

STUB="$T/bin"; mkdir -p "$STUB"
# `claude` is present so PATH resolution succeeds, but it is never reached in
# this section: review.sh refuses (PR #999 doesn't exist) before any lens
# spawns. That is what proves the billing preflight is what let the run get
# this far, not a spawned lens.
cat > "$STUB/claude" <<'EOF'
#!/usr/bin/env bash
echo "FATAL: claude should never be spawned in this test (PR #999 does not exist)" >&2
exit 1
EOF
cat > "$STUB/gh" <<'EOF'
#!/usr/bin/env bash
# Present so have_gh() succeeds, in case review.sh's diff-fetch fallback
# reaches it for a nonexistent PR; a real call still fails deliberately.
echo "STUB gh called: $*" >&2
exit 1
EOF
chmod +x "$STUB/claude" "$STUB/gh"

TESTHOME="$T/home"; mkdir -p "$TESTHOME"   # no ~/.factory/env at all
OUT="$T/out.txt"
env -i \
  PATH="$STUB:/usr/bin:/bin" \
  HOME="$TESTHOME" \
  bash "$REVIEW" --dry-run 999 >"$OUT" 2>&1
RC=$?

if [ "$RC" -ne 0 ]; then
  ok "review.sh exited non-zero ($RC)"
else
  bad "review.sh exited 0 despite PR #999 not existing — something short-circuited"
fi

# The two checks that actually justify "failed fetching the diff, not on
# billing": PR #999 doesn't exist, so review.sh's own diff-fetch (git first,
# falling back toward gh) must be what refused, and claude must never have
# been reached — a bare non-zero RC alone doesn't distinguish those from a
# billing refusal.
if grep -q 'could not fetch diff for PR #999' "$OUT"; then
  ok 'review.sh failed fetching the (nonexistent) PR diff, not on billing'
else
  bad "review.sh did not fail where expected; got: $(head -5 "$OUT" | tr '\n' ' ')"
fi
if grep -q 'FATAL: claude should never be spawned' "$OUT"; then
  bad 'review.sh spawned a lens before the diff fetch failed — billing preflight let it get further than it should have'
else
  ok 'no lens was spawned (the stub claude was never invoked)'
fi

if grep -qi 'billing: Max subscription login' "$OUT"; then
  ok 'billing preflight logged Max subscription login with no key present'
else
  bad "billing preflight did not run/log as expected; got: $(head -5 "$OUT" | tr '\n' ' ')"
fi

if grep -qi 'ANTHROPIC_API_KEY not set' "$OUT"; then
  bad 'review.sh still refuses on a missing key — billing policy was not inverted'
else
  ok 'review.sh did not refuse for lack of an API key'
fi

# ---------------------------------------------------------------------------
# 3. With a STRAY key in ~/.factory/env, load_billing_env clears it rather
#    than using it — a leftover key must never silently redirect billing to a
#    dead proxy (this is exactly how issue-217/219/223/225 died in GATING).
# ---------------------------------------------------------------------------
printf '\n\033[1m=== with a stray key in ~/.factory/env, it is cleared, not used ===\033[0m\n'

mkdir -p "$TESTHOME/.factory"
echo 'export ANTHROPIC_API_KEY=sk-ant-billing-test-stub' > "$TESTHOME/.factory/env"
OUT2="$T/out2.txt"
env -i \
  PATH="$STUB:/usr/bin:/bin" \
  HOME="$TESTHOME" \
  bash "$REVIEW" --dry-run 999 >"$OUT2" 2>&1 || true

if grep -qi 'clearing it so billing goes through the Max login' "$OUT2"; then
  ok 'billing preflight warned and cleared the stray key'
else
  bad "stray key was not detected/cleared as expected; got: $(head -5 "$OUT2" | tr '\n' ' ')"
fi
if grep -qi 'billing: Max subscription login' "$OUT2"; then
  ok 'review.sh proceeded on Max billing despite the stray key'
else
  bad "review.sh did not confirm Max billing after clearing the stray key"
fi

printf '\n\033[1m===== REVIEW-BILLING SUMMARY: %d passed, %d failed =====\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
