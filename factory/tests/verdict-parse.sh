#!/usr/bin/env bash
# factory/tests/verdict-parse.sh — prove review.sh's verdict logic fails CLOSED.
#
# The reviewer's tally decides whether a PR gets labelled agent-reviewed, which
# is a precondition for merge. If a garbled, missing, or never-produced verdict
# were read as PASS, an unreviewed diff could reach the trunk. So this logic is
# safety-critical and gets its own test.
#
# ---------------------------------------------------------------------------
# THIS TEST INVOKES THE REAL review.sh. IT DOES NOT KEEP A COPY OF ITS LOGIC.
#
# It used to. The old version pasted review.sh's grep/awk pipeline into itself
# and asserted against the paste. When review.sh's rules changed in #86, this
# file kept passing while asserting rules review.sh no longer had —
# green-but-wrong, the worst state for a safety test, because it reports
# confidence it has not earned.
#
# Everything below therefore drives review.sh's own self-test entrypoints:
#   review.sh --parse-verdict <file>        PASS | FAIL | (empty)
#   review.sh --classify <rc> <file>        PASS | FAIL | ERROR
#   review.sh --status <pass> <fail> <err>  PASS | FAIL | INCONCLUSIVE
#   review.sh --labels <pass> <fail> <err>  "<agent-reviewed> <needs-human>"
#
# Those entrypoints dispatch on $1 before review.sh does any work, so this test
# makes no API call, spends no spawn budget, and touches no PR. If the parser
# regresses, this test goes RED — that is the whole point of it existing.
# ---------------------------------------------------------------------------

set -uo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REVIEW="$TESTS_DIR/../review.sh"
[ -x "$REVIEW" ] || { printf 'FATAL: %s not found or not executable\n' "$REVIEW" >&2; exit 1; }

PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

# ---------------------------------------------------------------------------
# 1. Verdict parsing — the REAL parser, via review.sh --parse-verdict
#
# Current rules (all four are asserted below):
#   - the LAST verdict line wins
#   - case-insensitive
#   - markdown emphasis and stray whitespace tolerated
#   - the colon form is REQUIRED, so prose cannot be mistaken for a verdict
# A file with no parseable verdict yields empty output, which classify turns
# into ERROR (section 2) — never into PASS.
# ---------------------------------------------------------------------------
printf '\n\033[1m=== verdict parsing (review.sh --parse-verdict) ===\033[0m\n'

expect() { # expect <desc> <expected|-none-> <content>
  printf '%s' "$3" > "$T/o"
  local got
  got="$("$REVIEW" --parse-verdict "$T/o")"
  [ -n "$got" ] || got="-none-"
  if [ "$got" = "$2" ]; then ok "$1 -> $got"; else bad "$1 (expected $2, got $got)"; fi
}

expect "clean PASS on its own line" PASS 'Looks fine.
VERDICT: PASS'
expect "clean FAIL on its own line" FAIL 'Test deleted at foo.rs:12.
VERDICT: FAIL'

# Case-insensitivity is a CURRENT rule. The old test asserted the opposite
# ("lowercase verdict fails closed (strict)") and was wrong about the code.
expect "lowercase is accepted"                      PASS 'verdict: pass'
expect "mixed case with padding is accepted"         FAIL '  Verdict :   Fail  '

# Markdown tolerance: models emphasise the line constantly.
expect "bold around the whole line"                 PASS 'reasons
**VERDICT: PASS**'
expect "bold on the label only"                     PASS '**VERDICT:** PASS'
expect "bold on the value only"                     FAIL 'VERDICT: **FAIL**'
expect "underscore emphasis"                        PASS '_VERDICT: PASS_'
expect "markdown heading form"                       PASS '## VERDICT: PASS'
expect "trailing punctuation"                        FAIL 'VERDICT: FAIL.'

# Last-match-wins, in both directions, so a model that reconsiders is taken at
# its final word rather than its first.
expect "last verdict wins (PASS then FAIL)"         FAIL 'VERDICT: PASS
wait, on reflection:
VERDICT: FAIL'
expect "last verdict wins (FAIL then PASS)"         PASS 'A weaker reviewer might say VERDICT: FAIL here, but no.
VERDICT: PASS'
expect "indented verdict still detected"            PASS '   VERDICT: PASS'
expect "verdict inside a sentence"                  FAIL 'My conclusion is VERDICT: FAIL because of the stub.'

# No parseable verdict -> empty. The colon form is required, so prose about a
# verdict is not a verdict.
expect "empty output"                               -none- ''
expect "no verdict line at all"                     -none- 'I reviewed it and it seems okay to me.'
expect "prose mentioning pass but no verdict"       -none- 'This should pass CI without problems.'
expect "prose 'the verdict was fail' is not a verdict" -none- 'In my view the verdict was fail, roughly.'
expect "malformed verdict word"                     -none- 'VERDICT: MAYBE'
expect "truncated output mid-verdict"               -none- 'reasons...
VERDICT: PAS'

# ---------------------------------------------------------------------------
# 2. Lens classification — the REAL classifier, via review.sh --classify
#
# THE load-bearing rule: a call that did not complete produced no judgement.
# It is ERROR, never FAIL (which would invent an objection no model made) and
# never PASS (which would let an unreviewed diff through).
# ---------------------------------------------------------------------------
printf '\n\033[1m=== lens classification (review.sh --classify) ===\033[0m\n'

cls() { # cls <desc> <expected> <rc> <content>
  printf '%s' "$4" > "$T/c"
  local got
  got="$("$REVIEW" --classify "$3" "$T/c")"
  if [ "$got" = "$2" ]; then ok "$1 -> $got"; else bad "$1 (expected $2, got $got)"; fi
}

cls "exit 0 + PASS verdict"                    PASS  0 'VERDICT: PASS'
cls "exit 0 + FAIL verdict"                    FAIL  0 'VERDICT: FAIL'
cls "exit 0 + empty output => ERROR"           ERROR 0 ''
cls "exit 0 + no verdict => ERROR"             ERROR 0 'I had a look and it seems fine.'

# A non-zero exit means the call failed. Even if stdout happens to contain a
# verdict, the run is not trustworthy: ERROR wins over the text.
cls "exit 1 overrides a PASS in stdout"        ERROR 1 'VERDICT: PASS'
cls "exit 124 (timeout) => ERROR"              ERROR 124 'partial reasoning...'
cls "exit 126 (the old E2BIG exec failure)"    ERROR 126 ''
cls "exit -1 (lens never invoked)"             ERROR -1 ''
cls "unusable exit code => ERROR"              ERROR 'x' 'VERDICT: PASS'

# ---------------------------------------------------------------------------
# 3. Overall status and labelling — the REAL functions
#
# An incomplete review is never a pass. agent-reviewed requires >=2 PASS AND
# that every lens ran; needs-human fires on any FAIL or any ERROR.
# ---------------------------------------------------------------------------
printf '\n\033[1m=== status (review.sh --status) ===\033[0m\n'

st() { # st <desc> <expected> <p> <f> <e>
  local got; got="$("$REVIEW" --status "$3" "$4" "$5")"
  if [ "$got" = "$2" ]; then ok "$1 -> $got"; else bad "$1 (expected $2, got $got)"; fi
}
st "3 PASS"                          PASS         3 0 0
st "2 PASS 1 FAIL"                   FAIL         2 1 0
st "1 PASS 2 FAIL"                   FAIL         1 2 0
st "3 FAIL"                          FAIL         0 3 0
st "2 PASS 1 ERROR => INCONCLUSIVE"  INCONCLUSIVE 2 0 1
st "1 FAIL 2 ERROR => INCONCLUSIVE"  INCONCLUSIVE 0 1 2
st "3 ERROR => INCONCLUSIVE"         INCONCLUSIVE 0 0 3
st "1 PASS only => INCONCLUSIVE"     INCONCLUSIVE 1 0 0

printf '\n\033[1m=== labels (review.sh --labels) ===\033[0m\n'

lb() { # lb <desc> <expected "reviewed human"> <p> <f> <e>
  local got; got="$("$REVIEW" --labels "$3" "$4" "$5")"
  if [ "$got" = "$2" ]; then ok "$1 -> reviewed/human = $got"; else bad "$1 (expected '$2', got '$got')"; fi
}
lb "3 PASS: reviewed, no escalation"           "yes no"  3 0 0
lb "2 PASS 1 FAIL: reviewed AND escalated"     "yes yes" 2 1 0
lb "1 PASS 2 FAIL: not reviewed, escalated"    "no yes"  1 2 0
lb "3 FAIL: not reviewed, escalated"           "no yes"  0 3 0
# ERROR is an infrastructure failure, not an objection: no agent-reviewed (the
# review did not happen) and NO needs-human (changed 27 Sep 2026 — see
# review_labels' comment; the old "no yes" here is what wedged the merge queue
# for ~15 hours, because nothing ever removes that label).
lb "2 PASS 1 ERROR: NOT reviewed, NOT escalated" "no no"  2 0 1
lb "3 ERROR: not reviewed, NOT escalated"        "no no"  0 0 3

# MIXED FAIL + ERROR. Left unspecified and untested until the spec-conformance
# lens pointed out that the verdict comment asserted the opposite of what
# review_labels does here. A FAIL is a real objection whatever else happened, so
# needs-human is set; agent-reviewed is withheld because the review is also
# incomplete. Pinned in both directions so neither half can drift back.
lb "1 FAIL 1 ERROR: escalated (the FAIL stands)"        "no yes" 0 1 1
lb "1 PASS 1 FAIL 1 ERROR: escalated"                   "no yes" 1 1 1
lb "2 PASS 1 FAIL 0 ERROR stays escalated"              "yes yes" 2 1 0

printf '\n  note: 2 PASS + 1 FAIL sets BOTH labels; merge.sh requires\n'
printf '  agent-reviewed AND no needs-human, so any FAIL blocks the merge.\n'
printf '  An ERROR sets NEITHER label: the review did not happen, so it has not\n'
printf '  cleared the bar (no agent-reviewed) — but an infrastructure failure is\n'
printf '  not a human decision, so it does not burn needs-human either. Such a PR\n'
printf '  stays unmerged because reviews-on-head.sh refuses it, not because of a\n'
printf '  sticky label.\n'

# ---------------------------------------------------------------------------
# 4. Prompt delivery — the E2BIG regression guard
#
# The #86 bug was `claude -p "$(cat "$pf")"`: the whole prompt in one argv
# element, which execve() rejects with E2BIG above MAX_ARG_STRLEN (131072
# bytes). The fix is a stdin redirect, and it is the ONLY thing that makes the
# bug impossible at any diff size — the size caps are for reviewability. So
# assert the delivery mechanism directly: if someone turns it back into an
# argument, this goes red.
# ---------------------------------------------------------------------------
printf '\n\033[1m=== prompt delivery (E2BIG regression guard) ===\033[0m\n'

# Inspect CODE only. review.sh's header quotes the bad invocation verbatim as a
# do-not-regress warning, and that comment must not trip the guard.
CODE="$T/review.code"
grep -vE '^[[:space:]]*#' "$REVIEW" > "$CODE"

if grep -qE 'claude -p[^|<>]*"\$\(cat ' "$CODE"; then
  bad "prompt is passed as an argv string (E2BIG regression: use a stdin redirect)"
else
  ok "prompt is not passed via \"\$(cat ...)\" as an argv string"
fi

# shellcheck disable=SC2016  # the pattern must match the literal text "$pf" in
# review.sh, so it deliberately must NOT expand here.
if grep -qE '^[[:space:]]*<[[:space:]]*"\$pf"' "$CODE"; then
  ok "prompt is delivered by stdin redirect from the prompt file"
else
  bad "no stdin redirect from \$pf found — how is the prompt being delivered?"
fi

# The redirect must be able to carry a prompt larger than MAX_ARG_STRLEN. Prove
# the mechanism on a 200000-byte file (the #86 prompt was 317062) without
# calling the API: `cat` fails identically to `claude` if the payload is passed
# as an argument, and succeeds identically if it is redirected.
BIGFILE="$T/big.prompt"
head -c 200000 /dev/zero | tr '\0' 'x' > "$BIGFILE"
if ( cat < "$BIGFILE" ) >/dev/null 2>&1; then
  ok "a $(wc -c < "$BIGFILE")-byte prompt survives stdin delivery (> 131072 limit)"
else
  bad "stdin delivery failed on a $(wc -c < "$BIGFILE")-byte prompt"
fi
if ( cat "$(cat "$BIGFILE")" ) >/dev/null 2>&1; then
  bad "argv delivery unexpectedly succeeded — MAX_ARG_STRLEN assumption is wrong here"
else
  ok "argv delivery of the same prompt fails (E2BIG) — confirms why stdin is required"
fi

# ---------------------------------------------------------------------------
# 5. The self-test entrypoints must not do real work
#
# They exist so this test can exercise the real code. If one ever fell through
# into the review path it would fetch diffs and spend spawns from a test run,
# so assert they exit cleanly on their own.
# ---------------------------------------------------------------------------
printf '\n\033[1m=== self-test entrypoints are side-effect free ===\033[0m\n'

printf 'VERDICT: PASS' > "$T/e"
for mode in "--parse-verdict $T/e" "--classify 0 $T/e" "--status 3 0 0" "--labels 3 0 0"; do
  # shellcheck disable=SC2086  # deliberate word splitting of the mode string
  if out="$("$REVIEW" $mode 2>&1)" && [ -n "$out" ]; then
    if printf '%s' "$out" | grep -qiE 'fresh-context review|running lens|gh pr'; then
      bad "$mode leaked into the real review path"
    else
      ok "$mode exits with a single result and does no review work"
    fi
  else
    bad "$mode failed or produced nothing (got: '$out')"
  fi
done

printf '\n\033[1m===== VERDICT-PARSE SUMMARY: %d passed, %d failed =====\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
