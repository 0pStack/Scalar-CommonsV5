#!/usr/bin/env bash
# factory/tests/selftest.sh — proves the harness's own safety bounds.
#
# The factory's guarantees are only worth what they can be demonstrated to do,
# so each bound gets an executable test with an asserted outcome. Uses a STUB
# `claude` on PATH: these tests must be free, fast, and deterministic. Real API
# billing is verified separately (see FACTORY-REPORT.md).
#
#   ./factory/tests/selftest.sh          # run all
#   ./factory/tests/selftest.sh 3        # run one case
#
# Exit 0 = every bound behaved as specified.

set -uo pipefail

FACTORY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOOP="$FACTORY_DIR/lib/loop.sh"
TMP="$(mktemp -d)"
STUB="$TMP/bin"
WORK="$TMP/work"
PROMPT="$TMP/p.txt"
PASS=0
FAIL=0
ONLY="${1:-}"

mkdir -p "$STUB" "$WORK"
echo "do nothing; this is a harness self-test" > "$PROMPT"

# Stub agent: never edits anything, so any gate that is red stays red. This is
# exactly the "agent makes no progress" case the bounds must survive. It also
# dumps its own received environment before each run, so a case (7b) can
# assert on what a spawned claude actually sees, not just what got logged.
cat > "$STUB/claude" <<EOF
#!/usr/bin/env bash
env > "$TMP/last-claude-env.txt"
echo "STUB AGENT: pretending to work. I claim everything is fixed and perfect!"
exit 0
EOF
chmod +x "$STUB/claude"
export PATH="$STUB:$PATH"

# Isolate the factory's own state so a self-test never touches real logs/blocks.
export FACTORY_DIR
TESTHOME="$TMP/home"
mkdir -p "$TESTHOME/.factory"
echo 'export ANTHROPIC_API_KEY=sk-ant-selftest-stub-key' > "$TESTHOME/.factory/env"

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

run_case() {  # run_case <n> <desc>
  local n="$1"
  [ -z "$ONLY" ] || [ "$ONLY" = "$n" ]
}

ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }
assert_eq()   { if [ "$1" = "$2" ]; then ok "$3 (got $1)"; else bad "$3 (expected $2, got $1)"; fi; }
assert_grep() { if grep -qE "$1" "$2"; then ok "$3"; else bad "$3 — pattern '$1' absent from $2"; fi; }

hdr() { printf '\n\033[1m=== CASE %s: %s ===\033[0m\n' "$1" "$2"; }

# Each case gets a private HOME so STOP_FACTORY / logs / blocked dirs are clean.
run_loop() { # run_loop <name> <gate> <attempts> <minutes>
  HOME="$TESTHOME" "$LOOP" "$1" "$WORK" "$PROMPT" "$2" "$3" "$4" >"$TMP/$1.out" 2>&1
  echo $?
}

# --------------------------------------------------------------------------
if run_case 1; then
  hdr 1 "attempt cap — gate output VARIES so same-error stop cannot mask it"
  # Varying gate output (counter + nanosecond stamp) isolates the attempt cap
  # from the same-error stop. Single quotes are REQUIRED: the gate string must
  # reach the gate's own shell unexpanded.
  # shellcheck disable=SC2016
  GATE='c=$(cat .n 2>/dev/null || echo 0); c=$((c+1)); echo "$c" > .n; echo "failure number $c at $(date -u +%s%N)"; exit 1'
  rm -f "$WORK/.n"
  rc=$(run_loop capcheck "$GATE" 3 30)
  BF="$FACTORY_DIR/blocked/BLOCKED-capcheck.md"
  assert_eq "$rc" 1 "exits 1 when attempt cap hit"
  n=$(grep -c -- '--- attempt' "$TMP/capcheck.out")
  assert_eq "$n" 3 "ran exactly max_attempts=3 attempts, never more"
  assert_grep 'attempt cap reached \(3 attempts\)' "$TMP/capcheck.out" "logs the attempt-cap reason"
  assert_grep 'attempt cap reached' "$BF" "BLOCKED-capcheck.md written with the reason"
  assert_grep 'Last gate output \(authoritative\)' "$BF" \
    "BLOCKED report leads with the authoritative gate output"
  # Gate call #1 is the up-front pre-gate, so 3 attempts means the last gate
  # output is "failure number 4". Asserting 4 pins BOTH the pre-gate
  # short-circuit and "the report carries the final gate output, not an
  # earlier one".
  assert_grep 'failure number 4' "$BF" "BLOCKED report contains the LAST gate output (pre-gate + 3 attempts)"
  assert_grep 'STUB AGENT' "$BF" "BLOCKED report contains the last agent summary"
  assert_grep 'Do not resolve this by' "$BF" "BLOCKED report restates the ABSOLUTE RULE"
  rm -f "$WORK/.n"
fi

# --------------------------------------------------------------------------
if run_case 2; then
  hdr 2 "same-error stop — identical gate output 3x halts early (burn control)"
  # max_attempts=10 but identical output every time => must stop at 3.
  rc=$(run_loop stuckcheck 'echo "the very same error every time"; exit 1' 10 30)
  assert_eq "$rc" 1 "exits 1 when stuck"
  n=$(grep -c -- '--- attempt' "$TMP/stuckcheck.out")
  assert_eq "$n" 3 "stopped after 3 attempts despite max_attempts=10 (saved 7)"
  assert_grep 'byte-identical gate failure 3 times' "$TMP/stuckcheck.out" "logs the stuck reason"
  assert_grep 'identical-output streak = 3' "$TMP/stuckcheck.out" "tracks the identical-output streak"
fi

# --------------------------------------------------------------------------
if run_case 3; then
  hdr 3 "kill switch — ~/STOP_FACTORY blocks before ANY attempt"
  touch "$TESTHOME/STOP_FACTORY"
  rc=$(run_loop killcheck 'echo nope; exit 1' 5 30)
  assert_eq "$rc" 1 "exits 1 immediately"
  n=$(grep -c -- '--- attempt' "$TMP/killcheck.out" || true)
  assert_eq "$n" 0 "made ZERO attempts — no spend after kill switch"
  assert_grep 'STOP_FACTORY present' "$TMP/killcheck.out" "logs the kill switch"
  rm -f "$TESTHOME/STOP_FACTORY"
fi

# --------------------------------------------------------------------------
if run_case 4; then
  hdr 4 "gate passes => exit 0 the moment it goes green"
  # Red on the pre-gate, green after attempt 1: proves the loop exits on pass
  # and does NOT keep burning attempts.
  # shellcheck disable=SC2016  # must stay unexpanded for the gate's shell
  GATE='c=$(cat .g 2>/dev/null || echo 0); c=$((c+1)); echo "$c" > .g; if [ "$c" -ge 2 ]; then echo GREEN; exit 0; fi; echo RED; exit 1'
  rm -f "$WORK/.g"
  rc=$(run_loop passcheck "$GATE" 10 30)
  assert_eq "$rc" 0 "exits 0 on gate pass"
  n=$(grep -c -- '--- attempt' "$TMP/passcheck.out")
  assert_eq "$n" 1 "stopped immediately at 1 attempt (did not use all 10)"
  assert_grep 'GATE PASSED on attempt 1' "$TMP/passcheck.out" "logs the pass"
  if [ -f "$FACTORY_DIR/blocked/BLOCKED-passcheck.md" ]; then
    bad "stale BLOCKED file left behind after a pass"
  else
    ok "no BLOCKED file left behind after a pass"
  fi
  rm -f "$WORK/.g"
fi

# --------------------------------------------------------------------------
if run_case 5; then
  hdr 5 "already-green gate => zero agent spend"
  rc=$(run_loop nogatework 'echo all good; exit 0' 5 30)
  assert_eq "$rc" 0 "exits 0"
  n=$(grep -c -- '--- attempt' "$TMP/nogatework.out" || true)
  assert_eq "$n" 0 "spent NOTHING when the tree was already green"
  assert_grep 'gate already passes' "$TMP/nogatework.out" "logs the short-circuit"
fi

# --------------------------------------------------------------------------
if run_case 6; then
  hdr 6 "logging — output tee'd to factory/logs/<name>-<date>.log"
  today=$(date -u +%Y%m%d)
  lf="$FACTORY_DIR/logs/logcheck-${today}.log"
  rm -f "$lf"
  run_loop logcheck 'echo nope; exit 1' 1 30 >/dev/null
  if [ -f "$lf" ]; then ok "log file created: logs/logcheck-${today}.log"; else bad "log file missing: $lf"; fi
  assert_grep 'loop "logcheck" starting' "$lf" "log contains the run header"
  assert_grep 'gate=' "$lf" "log records the gate command"
fi

# --------------------------------------------------------------------------
# Policy flip, 27 Sep 2026 (LAB decision 002 amendment, Max-subscription
# cutover): loops now bill the Max login on purpose, not an API key. No key
# reachable is the NORMAL case and must not block a single attempt; a stray
# key left over from the retired proxy is what now gets scrubbed, since it
# would silently point billing at a dead proxy (see the 217/219/223/225
# incident, 2026-09-27 ~01:51-02:36 UTC).
if run_case 7; then
  hdr 7 "billing — no API key present means Max billing, loop still runs"
  EMPTY="$TMP/nokey"; mkdir -p "$EMPTY/.factory"
  : > "$EMPTY/.factory/env"
  HOME="$EMPTY" env -u ANTHROPIC_API_KEY -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN \
    "$LOOP" billcheck "$WORK" "$PROMPT" 'exit 1' 2 5 \
    >"$TMP/billcheck.out" 2>&1
  rc=$?
  assert_eq "$rc" 1 "exits non-zero once its attempt budget is spent (gate never green)"
  n=$(grep -c -- '--- attempt' "$TMP/billcheck.out" || true)
  assert_eq "$n" 2 "made both allotted attempts — billing did not block any of them"
  assert_grep 'billing: Max subscription login' "$TMP/billcheck.out" "logs that it is billing the Max subscription"
fi

if run_case 7b; then
  hdr 7b "billing — a stray leftover key is cleared, never used"
  STRAY="$TMP/straykey"; mkdir -p "$STRAY/.factory"
  echo 'export ANTHROPIC_API_KEY=sk-ant-dead-proxy-stub' > "$STRAY/.factory/env"
  rm -f "$TMP/last-claude-env.txt"
  HOME="$STRAY" "$LOOP" straycheck "$WORK" "$PROMPT" 'exit 1' 1 5 \
    >"$TMP/straycheck.out" 2>&1
  assert_grep 'clearing it so billing goes through the Max login' "$TMP/straycheck.out" "warns about and clears the stray key"
  assert_grep 'billing: Max subscription login' "$TMP/straycheck.out" "still proceeds on Max billing"
  # The load-bearing check: not just that it logged, but that the claude
  # process actually spawned never saw the key in its own environment.
  if [ -f "$TMP/last-claude-env.txt" ] && ! grep -q '^ANTHROPIC_API_KEY=' "$TMP/last-claude-env.txt"; then
    ok "the spawned claude's actual environment did not contain ANTHROPIC_API_KEY"
  else
    bad "the spawned claude's environment still contained ANTHROPIC_API_KEY (or was never captured)"
  fi
fi

# --------------------------------------------------------------------------
if run_case 8; then
  hdr 8 "bad input rejected"
  HOME="$TESTHOME" "$LOOP" x /nonexistent-dir "$PROMPT" 'true' 1 1 >"$TMP/v1.out" 2>&1
  assert_eq "$?" 1 "rejects a missing workdir"
  HOME="$TESTHOME" "$LOOP" x "$WORK" /nonexistent-prompt 'true' 1 1 >"$TMP/v2.out" 2>&1
  assert_eq "$?" 1 "rejects a missing promptfile"
  HOME="$TESTHOME" "$LOOP" x "$WORK" "$PROMPT" 'true' abc 1 >"$TMP/v3.out" 2>&1
  assert_eq "$?" 1 "rejects a non-numeric max_attempts"
  HOME="$TESTHOME" "$LOOP" >"$TMP/v4.out" 2>&1
  assert_eq "$?" 2 "exits 2 on missing arguments (usage)"
fi

printf '\n\033[1m===== SELFTEST SUMMARY: %d passed, %d failed =====\033[0m\n' "$PASS" "$FAIL"
# Clean the artifacts these cases created so real state stays uncluttered.
rm -f "$FACTORY_DIR"/blocked/BLOCKED-{capcheck,stuckcheck,killcheck,logcheck,passcheck}.md
[ "$FAIL" -eq 0 ]
