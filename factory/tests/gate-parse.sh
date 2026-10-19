#!/usr/bin/env bash
# factory/tests/gate-parse.sh — prove a fenced gate block becomes a RUNNABLE
# single command.
#
# Why this test exists (F-05):
#   Issues #104 and #105 burned all three attempts and blocked on
#       bash: -c: line 1: syntax error near unexpected token `&&'
#   gate_from_issue() joined every physical line of the fence with " && ".
#   For a gate written with shell line-continuations:
#
#       cd landing && ! sed -n '...' src/content.mjs | grep -qE '...' \
#         && npm ci && npm test
#
#   ...that produced `... \ && && npm ci ...` — two defects compounding: the
#   trailing backslash was kept (mid-line it escapes a space instead of joining
#   lines) and a " && " was inserted before a line that already opened with
#   "&&". The result is a bash syntax error, so the gate could NEVER go green
#   no matter what the agent did. The worker was graded against a command that
#   cannot run.
#
# The bound being asserted: whatever a human writes in the fence, dispatch must
# hand bash something bash can parse, with the gate's MEANING unchanged.
#
# shellcheck disable=SC2317
# ^ File-level: with `shellcheck -x` the sourced dispatch.sh contains an
#   `exit 0` on its DISPATCH_LIB_ONLY path, so static analysis treats the rest
#   as unreachable. At runtime that branch `return`s when sourced.

set -uo pipefail

FACTORY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
PASS=0
FAIL=0
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

ok()  { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m  %s\n' "$1"; [ -n "${2:-}" ] && printf '        got: %s\n' "$2"; }

export DISPATCH_LIB_ONLY=1
# shellcheck source-path=SCRIPTDIR
# shellcheck source=../dispatch.sh
# shellcheck disable=SC1091
. "$FACTORY_DIR/dispatch.sh"
unset DISPATCH_LIB_ONLY

# fixture <number> <body> -> sets FACTORY_ISSUE_FIXTURE to a one-issue file
fixture() {
  local num="$1"
  local body="$2"
  local f="$TMP/issue-$num.json"
  python3 -c '
import json,sys
json.dump([{"number": int(sys.argv[1]), "title": "t", "body": sys.argv[2]}], open(sys.argv[3],"w"))
' "$num" "$body" "$f"
  export FACTORY_ISSUE_FIXTURE="$f"
}

# assert_runnable <desc> <gate>
# A gate must parse as bash. `bash -n` reads syntax WITHOUT executing, so this
# is safe for gates that would otherwise run npm/cargo.
assert_runnable() {
  local desc="$1" gate="$2" err
  if [ -z "$gate" ]; then bad "$desc — gate was empty"; return; fi
  if err="$(bash -n -c "$gate" 2>&1)"; then
    ok "$desc"
  else
    bad "$desc — bash cannot parse it" "$err"
  fi
}

assert_no() { # assert_no <desc> <needle> <haystack>
  case "$3" in
    *"$2"*) bad "$3 contains forbidden '$2' — $1" "$3" ;;
    *)      ok "$1" ;;
  esac
}

assert_has() { # assert_has <desc> <needle> <haystack>
  case "$3" in
    *"$2"*) ok "$1" ;;
    *)      bad "$1 — expected to contain '$2'" "$3" ;;
  esac
}

printf '\n\033[1m=== CASE 1: backslash continuation + leading && (the #104 blocker) ===\033[0m\n'
# Exactly the shape that blocked issue #104.
fixture 9104 '## Gate

```
cd landing && ! sed -n "/key: '"'"'faucet'"'"'/,/^    },/p" src/content.mjs | grep -qE "planned" \
  && node -e "process.exit(0)" \
  && npm ci && npm test
```
'
G1="$(gate_from_issue 9104 || true)"
printf '  gate: %s\n' "$G1"
assert_runnable "multi-line continuation gate parses as bash" "$G1"
assert_no "no stray backslash survives the join" '\' "$G1"
assert_no "no doubled operator" '&& &&' "$G1"
assert_has "the sed clause is preserved verbatim" 'src/content.mjs' "$G1"
assert_has "the final clause is preserved" 'npm ci && npm test' "$G1"

printf '\n\033[1m=== CASE 2: meaning is unchanged — separate lines still chain with && ===\033[0m\n'
# A fence whose lines are INDEPENDENT commands (no continuations) must still be
# ANDed: every line has to pass. This is the behaviour that must not regress.
fixture 9200 '## Gate

```
cd docs && npm run build
cd landing && npm run build
```
'
G2="$(gate_from_issue 9200 || true)"
printf '  gate: %s\n' "$G2"
assert_runnable "independent lines parse as bash" "$G2"
assert_has "independent lines are chained with &&" 'npm run build && cd landing' "$G2"

printf '\n\033[1m=== CASE 3: single-line gate is passed through untouched ===\033[0m\n'
fixture 9300 '## Gate

```
cd indexer && npm ci && npm test
```
'
G3="$(gate_from_issue 9300 || true)"
printf '  gate: %s\n' "$G3"
[ "$G3" = "cd indexer && npm ci && npm test" ] \
  && ok "single-line gate is byte-identical" \
  || bad "single-line gate was altered" "$G3"

printf '\n\033[1m=== CASE 4: real command prefixes are accepted, prose is not ===\033[0m\n'
# `test -f ...` (#103) and `shellcheck ...` (#102) are real gates. If the
# runnable-prefix allowlist rejects them, dispatch silently falls back to the
# workspace gate that is already green on master — the F-1 failure mode.
fixture 9400 '## Gate

```
test -f .github/workflows/pages.yml && cd docs && npm run build
```
'
G4="$(gate_from_issue 9400 || true)"
[ -n "$G4" ] && ok "a 'test -f' gate is accepted" || bad "a 'test -f' gate was rejected as prose"

fixture 9401 '## Gate

```
shellcheck deploy/products/*.sh && systemd-analyze verify deploy/products/*.service
```
'
G5="$(gate_from_issue 9401 || true)"
[ -n "$G5" ] && ok "a 'shellcheck' gate is accepted" || bad "a 'shellcheck' gate was rejected as prose"

fixture 9402 '## Gate

```
Make sure the tests all pass before merging this.
```
'
G6="$(gate_from_issue 9402 || true)"
[ -z "$G6" ] && ok "prose is still rejected" || bad "prose was accepted as a gate" "$G6"

printf '\n\033[1m=== CASE 5: trailing-backslash gate for issue #105 shape ===\033[0m\n'
fixture 9105 '## Gate

```
cd docs && node -e "const b=1; if(b<=400000){process.exit(1)}" \
  && npm ci && npm run lint && npm run build
```
'
G7="$(gate_from_issue 9105 || true)"
printf '  gate: %s\n' "$G7"
assert_runnable "#105-shape gate parses as bash" "$G7"
assert_no "no stray backslash" '\' "$G7"

printf '\n\033[1m--- gate-parse: %d passed, %d failed ---\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
