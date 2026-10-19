#!/usr/bin/env bash
# factory/review.sh — fresh-context adversarial review of a factory PR.
#
#   ./factory/review.sh [--dry-run] <pr-number>
#
# Runs THREE separate `claude -p` calls, one per lens. Each is a brand-new
# process with a fresh context and is handed ONLY:
#   - the complete list of changed file NAMES
#   - the complete diff of every dependency manifest (package.json/Cargo.toml)
#   - a REVIEW DIFF: the PR diff with generated/vendored files excluded
#   - the body of the issue the PR closes
#   - its own lens prompt
#
# Why fresh context: the author agent has spent hours convincing itself the work
# is good. Reviewing inside that context inherits the rationalisation. A
# reviewer that has never seen the author's reasoning can only judge the diff.
#
# Each reviewer is run from a temp dir OUTSIDE the repo, so CLAUDE.md is not
# auto-discovered and no reviewer can wander the tree looking for excuses. The
# rules a reviewer needs are embedded in its lens prompt.
#
# ---------------------------------------------------------------------------
# PAST BUG — DO NOT REGRESS (fixed 2026-08-05; see FACTORY-REVIEW-FIX.md)
#
# This script used to invoke `claude -p "$(cat "$pf")"`, passing the whole
# prompt as ONE argv string. Linux caps a SINGLE argument at MAX_ARG_STRLEN =
# 32 pages = 131072 bytes — a limit that is entirely separate from ARG_MAX.
# PR #85's prompt was 317062 bytes, so execve() failed with E2BIG before
# `claude` ever started: exit 126, zero bytes of stdout. review.sh discarded
# that exit code (`|| warn`) and then scored the missing verdict as FAIL, so a
# perfectly good PR was reported as failing all three lenses.
#
# Two rules follow, and both are load-bearing:
#   1. The prompt is fed on STDIN (`claude -p < "$pf"`), never as an argument.
#      A redirect passes a file descriptor, so prompt size is irrelevant to
#      exec and E2BIG cannot recur AT ANY DIFF SIZE. This redirect — not the
#      size caps — is what makes the bug impossible. Do not "optimise" it into
#      `claude -p "$(cat …)"`; factory/tests/verdict-parse.sh asserts against
#      that exact regression and will go red.
#   2. The exit code is captured and a non-zero exit is ERROR, never FAIL.
#      "The reviewer could not run" and "the reviewer objects" are different
#      facts and must never be collapsed into one.
#
# MAX_REVIEW_DIFF_LINES / MAX_REVIEW_DIFF_BYTES bound the diff for
# REVIEWABILITY, not for exec safety. They are not a second E2BIG defence, and
# raising them cannot reintroduce the bug. They have their own hazard: at 1500
# lines the review of PR #85 had a file truncated out and the reviewer invented
# two findings from the gap, so a too-low cap does not merely lose coverage, it
# manufactures false findings. Truncation is therefore always disclosed.
#
# A second, independent bug lived here too: run_lens returned its verdict on
# stdout while also calling log(), which writes to stdout. The caller's
# `v="$(run_lens ...)"` therefore captured "[ts] running lens: …\nPASS", the
# `case "$v" in PASS)` matched neither arm, and the PASS/FAIL tally stayed at
# 0/0 regardless of what the models actually said. Lens results now travel in
# files ($WORK/<lens>.result), never on stdout, so the class of bug is gone.
# ---------------------------------------------------------------------------
#
# Verdicts: every lens must end with "VERDICT: PASS" or "VERDICT: FAIL". Three
# outcomes are distinguished, and the distinction matters:
#
#   PASS   the model returned VERDICT: PASS
#   FAIL   the model returned VERDICT: FAIL — a real objection
#   ERROR  the call failed, or exited 0 with no parseable verdict. The review
#          did not happen. This is NEVER reported as PASS and never as FAIL.
#
# A lens that ERRORs is RETRIED (up to REVIEW_LENS_RETRIES, default 2) before
# its ERROR is accepted — an infrastructure failure deserves another attempt.
# A PASS or FAIL is never retried; re-rolling a lens that already judged is the
# "keep going until it goes green" move the standing rule forbids.
#
# Overall status:
#   any ERROR (after retries)  -> INCONCLUSIVE: no agent-reviewed, NO
#                                 needs-human, comment the reason, exit 2
#   >=2 PASS and no ERROR      -> comment all verdicts + label agent-reviewed
#   any FAIL                   -> label needs-human + comment the objections
#
# The last two rules can BOTH apply (2 PASS + 1 FAIL). That is deliberate: the
# PR records that it cleared the bar AND that an unresolved objection exists.
#
# needs-human is ONLY for a real FAIL (changed 27 Sep 2026). It used to be
# applied for ERROR too, which was actively harmful: nothing in this system ever
# removes that label and merge-if-green.sh --scan excludes any PR carrying it,
# so a day when the lenses could not run left every open PR in a state no
# automation could leave and the merge pass logged "0 candidate PR(s)" every 5
# minutes for ~15 hours. An INCONCLUSIVE review still cannot merge — it gets no
# agent-reviewed, and gates/reviews-on-head.sh refuses it with a reason on every
# pass — but it no longer consumes a human's attention as if it were an
# objection.
#
# A reviewer that cannot review reports INCONCLUSIVE. It never reports PASS.
#
# review.sh NEVER MERGES. It has no merge code path at all, under any flag.

set -uo pipefail

FACTORY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/common.sh
. "$FACTORY_DIR/lib/common.sh"

# Defaults live in config.env; these are the belt-and-braces fallbacks so the
# script is still correct if it is ever sourced with a truncated config.
: "${MAX_REVIEW_DIFF_LINES:=2500}"
: "${MAX_REVIEW_DIFF_BYTES:=200000}"
: "${REVIEW_EXCLUDE_GLOBS:=**/package-lock.json **/pnpm-lock.yaml **/yarn.lock **/*.min.js **/*.min.css **/dist/** **/build/** **/node_modules/** **/*.map **/*snapshot.json}"
: "${REVIEW_MANIFEST_GLOBS:=**/package.json **/Cargo.toml}"
: "${REVIEW_LENS_TIMEOUT:=900}"

# Join a one-path-per-line file into "a, b, c" for a log line or a comment.
# (`paste -sd', '` would NOT do this: paste treats the operand as a cycling
# list of one-character delimiters, so it emits "a,b c".)
list_inline() {
  [ -s "$1" ] || { printf 'none'; return 0; }
  paste -sd, "$1" | sed 's/,/, /g'
}

# ---------------------------------------- the decision logic, in one place ---
# Everything that turns raw lens output into a verdict, a status and a labelling
# decision lives in these four functions, defined UP HERE so the self-test
# entrypoints below can reach them before the script does any work.
#
# They are deliberately pure: no globals, no side effects, no network. That is
# what makes factory/tests/verdict-parse.sh able to test THE REAL CODE instead
# of keeping a private copy that drifts out of agreement with it (which is
# exactly what happened before: the test stayed green while asserting rules
# review.sh no longer had).

# Robust against the ways a model actually writes the line: markdown emphasis
# (**VERDICT: PASS**), stray whitespace, lower case. Requires the colon form, so
# prose like "the verdict was a fail" cannot be mistaken for a verdict line.
# The LAST match wins — a model that reconsiders mid-answer is taken at its
# final word. Only ever run against the model's captured stdout.
# Prints PASS, FAIL, or nothing at all when there is no parseable verdict.
parse_verdict() {
  local f="$1" m
  [ -s "$f" ] || return 0
  m="$(grep -oiE 'verdict[[:space:]]*:[[:space:]]*[*_[:space:]]{0,6}(pass|fail)' "$f" | tail -1)"
  [ -n "$m" ] || return 0
  case "$(printf '%s' "$m" | tr '[:upper:]' '[:lower:]')" in
    *pass) printf 'PASS' ;;
    *fail) printf 'FAIL' ;;
  esac
}

# classify_lens_result <exit-code> <stdout-file> -> PASS | FAIL | ERROR
#
# The one rule that matters: a call that did not complete produced no
# judgement. Recording that as FAIL would invent an objection the model never
# made; recording it as PASS would be worse. It is ERROR.
classify_lens_result() {
  local rc="$1" f="$2" v
  case "$rc" in
    ''|*[!0-9-]*) printf 'ERROR'; return 0 ;;   # unusable exit code
  esac
  [ "$rc" -eq 0 ] || { printf 'ERROR'; return 0; }
  v="$(parse_verdict "$f")"
  [ -n "$v" ] || { printf 'ERROR'; return 0; }
  printf '%s' "$v"
}

# overall_status <passes> <fails> <errors> -> PASS | FAIL | INCONCLUSIVE
#
# An incomplete review is never a pass, whatever the tally of the lenses that
# did run.
overall_status() {
  local p="$1" f="$2" e="$3"
  if   [ "$e" -gt 0 ]; then printf 'INCONCLUSIVE'
  elif [ "$f" -gt 0 ]; then printf 'FAIL'
  elif [ "$p" -ge 2 ]; then printf 'PASS'
  else                      printf 'INCONCLUSIVE'
  fi
}

# review_labels <passes> <fails> <errors> -> "<agent-reviewed> <needs-human>"
# as two yes/no words.
#
# agent-reviewed requires >=2 PASS *and* that every lens actually ran: a review
# with a dead lens must not be labelled as having cleared the bar.
#
# needs-human is ONLY for a real FAIL — a lens that ran, judged, and objected.
# It is deliberately NOT applied for ERROR/INCONCLUSIVE (changed 27 Sep 2026).
#
# WHY, because the old behaviour cost a working day: `needs-human` is a one-way
# ratchet (nothing in this system ever removes it) and `merge-if-green.sh
# --scan` excludes any PR carrying it. So when the lenses could not run at all
# on 27 Sep, every open PR was ratcheted into a state no automation could leave,
# the merge pass reported "0 candidate PR(s)" every 5 minutes for ~15 hours, and
# the log looked like an idle queue rather than a wedged one. An infrastructure
# failure must not consume a human's attention budget as if it were a review
# objection.
#
# This does NOT make an incomplete review mergeable. agent-reviewed is still
# withheld (>=2 PASS and zero ERRORs), and gates/reviews-on-head.sh independently
# requires LAB_REQUIRED_PASS_LENSES verdicts bound to the current head. A PR
# whose review could not run therefore still cannot merge — it is refused by a
# gate, with a reason, on every pass, instead of being parked behind a label.
review_labels() {
  local p="$1" f="$2" e="$3" reviewed=no human=no
  { [ "$p" -ge 2 ] && [ "$e" -eq 0 ]; } && reviewed=yes
  [ "$f" -gt 0 ] && human=yes
  printf '%s %s' "$reviewed" "$human"
}

usage() {
  printf 'usage: review.sh [--dry-run] <pr-number>\n'
  printf '  --dry-run   run all three lenses and print exit code + verdict +\n'
  printf '              reasons, but post no comment, apply no label, merge\n'
  printf '              nothing. Lenses still cost spawns.\n'
  printf '\n'
  printf 'Self-test entrypoints (used by factory/tests/verdict-parse.sh so the\n'
  printf 'test exercises this file rather than a copy of it). Each prints one\n'
  printf 'line and exits without touching the network:\n'
  printf '  --parse-verdict <file>        PASS | FAIL | (empty)\n'
  printf '  --classify <rc> <file>        PASS | FAIL | ERROR\n'
  printf '  --status <pass> <fail> <err>  PASS | FAIL | INCONCLUSIVE\n'
  printf '  --labels <pass> <fail> <err>  "<agent-reviewed> <needs-human>"\n'
  printf '  --head-marker <sha>           the reviewed-head marker line\n'
}

# ------------------------------------------------- self-test entrypoints -----
# Placed immediately after the functions they expose and before any work is
# done, so a test invocation can never fetch a diff, spend a spawn, or touch a
# PR. Dispatched on $1 only.
case "${1:-}" in
  --parse-verdict)
    [ $# -eq 2 ] || die "--parse-verdict needs exactly one file"
    parse_verdict "$2"; printf '\n'; exit 0 ;;
  --classify)
    [ $# -eq 3 ] || die "--classify needs <rc> <file>"
    classify_lens_result "$2" "$3"; printf '\n'; exit 0 ;;
  --status)
    [ $# -eq 4 ] || die "--status needs <pass> <fail> <err>"
    overall_status "$2" "$3" "$4"; printf '\n'; exit 0 ;;
  --labels)
    [ $# -eq 4 ] || die "--labels needs <pass> <fail> <err>"
    review_labels "$2" "$3" "$4"; printf '\n'; exit 0 ;;
  --head-marker)
    [ $# -eq 2 ] || die "--head-marker needs <sha>"
    review_head_marker "$2"; printf '\n'; exit 0 ;;
esac

# ------------------------------------------------------------- arguments ----
# Flags are accepted in any position: `review.sh --dry-run 85` and
# `review.sh 85 --dry-run` are the same command.
PR=""
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)   DRY_RUN=1 ;;
    -h|--help)   usage; exit 0 ;;
    ''|*[!0-9]*) usage >&2; die "unrecognised argument: '$arg'" ;;
    *)           [ -z "$PR" ] || { usage >&2; die "more than one PR number given"; }
                 PR="$arg" ;;
  esac
done
[ -n "$PR" ] || { usage >&2; die "no PR number given"; }

stop_requested && { log "STOP_FACTORY present — not reviewing."; exit 0; }
have_gh || die "gh CLI required"

# ---- billing preflight -----------------------------------------------------
# Every lens below is a `claude -p` process, so review.sh spends exactly like
# lib/loop.sh does and must prove its billing source exactly like lib/loop.sh
# does. It did not, and the cost was concrete: under systemd the reviewer
# inherited neither ~/.factory/env's PATH nor ANTHROPIC_API_KEY, so all six
# systemd-launched reviews — 18 of 18 lenses — exited 127, and the next one
# would have found `claude` on PATH with no key and silently billed the
# interactive Max login, which common.sh's preflight exists to forbid.
#
# Placed here deliberately: after the kill switch (a stopped factory spends
# nothing), before the diff is fetched and long before any lens is spawned. It
# fails closed — no key, no review — because an unbilled review is worse than
# no review: it reports a verdict while draining the wrong account.
#
# factory/tests/review-billing.sh asserts both the ordering and the closure.
load_billing_env

GH_ARGS=()
mapfile -t GH_ARGS < <(gh_repo_args)

log "=== fresh-context review of PR #$PR ==="
[ "$DRY_RUN" = "1" ] && log "DRY RUN: lenses will run; nothing will be posted, labelled or merged."

WORK="$(mktemp -d)"        # reviewers run here: outside the repo, no CLAUDE.md
PRREF="refs/factory-review/pr-$PR"
BODY_FILE="$WORK/issue.md"

# shellcheck disable=SC2317  # invoked via trap
cleanup() {
  git -C "$REPO_DIR" update-ref -d "$PRREF" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# ------------------------------------------------------- build the diffs ----
# The review diff is built with a real git pathspec filter, not a line grep on
# the unified diff. That means fetching the PR head into a private ref and
# diffing it against the base branch with `:(exclude,glob)` pathspecs, so
# exclusion happens at the file level in git itself and cannot mis-slice a hunk.
EXCLUDE_SPECS=()
MANIFEST_SPECS=()
MANIFEST_EXCLUDE_SPECS=()
read -r -a _globs <<< "$REVIEW_EXCLUDE_GLOBS"
for g in "${_globs[@]}"; do EXCLUDE_SPECS+=( ":(exclude,glob)$g" ); done
read -r -a _mglobs <<< "$REVIEW_MANIFEST_GLOBS"
for g in "${_mglobs[@]}"; do
  MANIFEST_SPECS+=( ":(glob)$g" )
  MANIFEST_EXCLUDE_SPECS+=( ":(exclude,glob)$g" )
done

BASE_REF="$(gh pr view "$PR" --json baseRefName --jq .baseRefName "${GH_ARGS[@]}" 2>/dev/null || true)"
[ -n "$BASE_REF" ] || BASE_REF="$BASE_BRANCH"

DIFF_MODE="filtered"
if git -C "$REPO_DIR" fetch --quiet --no-tags origin \
      "+refs/pull/$PR/head:$PRREF" \
      "+refs/heads/$BASE_REF:refs/remotes/origin/$BASE_REF" 2>"$WORK/fetch.err"; then
  RANGE="refs/remotes/origin/$BASE_REF...$PRREF"
  git -C "$REPO_DIR" diff --no-color "$RANGE"                                  > "$WORK/raw.diff"
  git -C "$REPO_DIR" diff --name-only "$RANGE"                                 > "$WORK/allfiles.txt"
  git -C "$REPO_DIR" diff --no-color "$RANGE" -- "${EXCLUDE_SPECS[@]}" \
                                                "${MANIFEST_EXCLUDE_SPECS[@]}" > "$WORK/filtered.diff"
  git -C "$REPO_DIR" diff --no-color "$RANGE" -- "${MANIFEST_SPECS[@]}"        > "$WORK/manifests.diff"
  git -C "$REPO_DIR" diff --name-only "$RANGE" -- "${EXCLUDE_SPECS[@]}"        > "$WORK/kept.txt"
  comm -23 <(sort "$WORK/allfiles.txt") <(sort "$WORK/kept.txt")               > "$WORK/excluded.txt"
else
  # gh works but git could not fetch the PR ref (detached checkout, no origin,
  # restricted network). Rather than pretend, fall back to the unfiltered diff
  # and say so in the prompt: the cap below still bounds it, and the coverage
  # note still tells the reviewer exactly what it is not seeing.
  warn "git fetch of refs/pull/$PR/head failed — falling back to an UNFILTERED diff"
  warn "$(head -3 "$WORK/fetch.err" | tr '\n' ' ')"
  DIFF_MODE="unfiltered-fallback"
  gh pr diff "$PR" "${GH_ARGS[@]}" > "$WORK/raw.diff" 2>/dev/null \
    || die "could not fetch diff for PR #$PR (neither git nor gh could produce one)"
  gh pr diff "$PR" --name-only "${GH_ARGS[@]}" > "$WORK/allfiles.txt" 2>/dev/null || true
  cp "$WORK/raw.diff" "$WORK/filtered.diff"
  : > "$WORK/manifests.diff"
  : > "$WORK/excluded.txt"
fi

[ -s "$WORK/allfiles.txt" ] || die "PR #$PR has an empty diff"

# Which model the lenses run on, decided once from the diff and used by every
# lens so all three judge the same way. See run_lens for the reasoning.
#
# LENS_MODEL can be set in the environment to override, but ONLY to a name on
# this list. The standing-rule lens objected to the unvalidated version on this
# PR's own review, and it was right: without an allow-list, any caller — a
# script, a stray export, an agent editing a wrapper — can silently drop the
# reviewer to an arbitrary or nonexistent model. That is a way to weaken the
# gate without touching the gate, and a log line saying which model ran is not a
# control, because nobody is reading it at the moment it matters.
#
# An unknown value is fatal, never a fallback to a default: falling back would
# mean a typo silently reviews with something other than what was asked for.
#
# EXACT comparison, not a `case` substring match. The substring form accepted
# LENS_MODEL="opus sonnet" -- the pattern `*" opus sonnet "*` matches the
# allow-list string itself -- and then passed that whole string to --model as a
# single bogus value. Caught by the spec-conformance lens on this PR's review;
# an allow-list that can be satisfied by concatenating its own entries is not an
# allow-list.
LENS_MODEL_ALLOWED="opus sonnet"
if [ -n "${LENS_MODEL:-}" ]; then
  _lm_ok=0
  for _lm in $LENS_MODEL_ALLOWED; do
    [ "$LENS_MODEL" = "$_lm" ] && { _lm_ok=1; break; }
  done
  [ "$_lm_ok" = "1" ] || die "LENS_MODEL=$LENS_MODEL is not one of: $LENS_MODEL_ALLOWED"
  log "lens model overridden from the environment: $LENS_MODEL"
  unset _lm _lm_ok
else
  if grep -qE '^(runtime|pallets)/' "$WORK/allfiles.txt"; then
    LENS_MODEL=opus
  else
    LENS_MODEL=sonnet
  fi
fi
log "lens model: $LENS_MODEL ($(grep -cE '^(runtime|pallets)/' "$WORK/allfiles.txt" || true) of $(grep -c . "$WORK/allfiles.txt") changed path(s) under runtime/ or pallets/)"

# ------------------------------------------------- bind the review to a SHA --
# Record the exact commit these lenses are about to read. This is what makes
# `agent-reviewed` mean "THIS diff passed" rather than "some review once
# passed" — merge.sh reads the SHA back out of the verdict comment and refuses
# a PR whose head has moved since (audit finding I-13, cause 4).
#
# Prefer the ref that was actually diffed above; only fall back to the API when
# the fetch failed, because the ref is the ground truth for what the lenses see.
# If neither can be resolved, refuse BEFORE spending a single spawn: a review
# that cannot be bound cannot authorise a merge, so paying for it is waste.
if REVIEWED_SHA="$(git -C "$REPO_DIR" rev-parse --verify --quiet "$PRREF^{commit}" 2>/dev/null)" \
   && [ -n "$REVIEWED_SHA" ]; then
  log "reviewing PR #$PR at head $REVIEWED_SHA (from $PRREF)"
else
  REVIEWED_SHA="$(gh pr view "$PR" --json headRefOid --jq .headRefOid "${GH_ARGS[@]}" 2>/dev/null || true)"
  [ -n "$REVIEWED_SHA" ] || die "cannot resolve the head SHA of PR #$PR; refusing to review a diff \
that could not be bound to a commit"
  log "reviewing PR #$PR at head $REVIEWED_SHA (from the API; git fetch had failed)"
fi

RAW_LINES=$(wc -l < "$WORK/raw.diff")
FILTERED_LINES=$(wc -l < "$WORK/filtered.diff")
EXCLUDED_N="$(count_lines "$WORK/excluded.txt")"

# ------------------------------------------------------------- the caps -----
# Even after exclusion a diff can be enormous. TWO ceilings apply, whichever
# binds first:
#
#   MAX_REVIEW_DIFF_LINES  lines  — the ordinary size limit
#   MAX_REVIEW_DIFF_BYTES  bytes  — the pathological-input limit
#
# The byte ceiling exists because lines are a bad proxy for size. A diff of
# generated-but-not-globbed content (one-line JSON blobs, embedded base64, a
# minified file that dodged the exclusion list) can be a handful of lines and
# still megabytes, which would produce an unreviewably huge prompt. It is NOT
# there to keep an argv string under a limit — the prompt goes on stdin, so
# exec limits do not apply at any size.
#
# Truncation happens at FILE BOUNDARIES so the reviewer never sees half a hunk,
# and every file that fell off the end is recorded. Silent truncation would be
# worse than no truncation: it reads as full coverage when it is not.
: > "$WORK/omitted.txt"
: > "$WORK/trunc-reason.txt"
awk -v cap="$MAX_REVIEW_DIFF_LINES" -v bcap="$MAX_REVIEW_DIFF_BYTES" \
    -v omit="$WORK/omitted.txt" -v reason="$WORK/trunc-reason.txt" '
function flush(   i) {
  if (nrec == 0) return

  # Already stopped: every remaining file is simply declared omitted.
  if (stopped) { print curfile > omit; nrec = 0; rbytes = 0; return }

  # Whole file fits under both ceilings.
  if (total + nrec <= cap && bytes + rbytes <= bcap) {
    for (i = 1; i <= nrec; i++) print rec[i]
    total += nrec; bytes += rbytes; nrec = 0; rbytes = 0
    return
  }

  # It does not fit. Record WHICH ceiling stopped us, for the disclosure.
  if (total + nrec > cap) why = sprintf("line cap (%d lines)", cap)
  else                    why = sprintf("byte cap (%d bytes)", bcap)

  if (total == 0) {
    # A single file bigger than an entire ceiling. Emit the prefix that does
    # fit rather than nothing at all, and declare it cut mid-file.
    for (i = 1; i <= nrec; i++) {
      if (total + 1 > cap) break
      if (bytes + length(rec[i]) + 1 > bcap) break
      print rec[i]; total++; bytes += length(rec[i]) + 1
    }
    print curfile " (cut mid-file)" > omit
  } else {
    print curfile > omit
  }
  stopped = 1; nrec = 0; rbytes = 0
}
/^diff --git / {
  flush()
  curfile = $0
  sub(/^diff --git a\//, "", curfile)
  sub(/ b\/.*$/, "", curfile)
}
{ rec[++nrec] = $0; rbytes += length($0) + 1 }
END { flush(); if (stopped) print why > reason }
' "$WORK/filtered.diff" > "$WORK/review.diff"

REVIEW_LINES=$(wc -l < "$WORK/review.diff")
REVIEW_BYTES=$(wc -c < "$WORK/review.diff")
FILTERED_BYTES=$(wc -c < "$WORK/filtered.diff")
TRUNC_REASON="$(cat "$WORK/trunc-reason.txt" 2>/dev/null || true)"
TRUNCATED=0
[ -s "$WORK/omitted.txt" ] && TRUNCATED=1

log "diff: raw $RAW_LINES lines -> filtered $FILTERED_LINES ($FILTERED_BYTES B) -> review $REVIEW_LINES lines / $REVIEW_BYTES B (mode: $DIFF_MODE)"
log "caps: $MAX_REVIEW_DIFF_LINES lines / $MAX_REVIEW_DIFF_BYTES bytes"
log "$EXCLUDED_N file(s) excluded as generated/vendored; names still shown to every lens"
if [ "$TRUNCATED" = "1" ]; then
  warn "REVIEW DIFF TRUNCATED by the ${TRUNC_REASON:-cap} — coverage is PARTIAL."
  warn "shown: $REVIEW_LINES lines / $REVIEW_BYTES bytes of $FILTERED_LINES lines / $FILTERED_BYTES bytes"
  warn "omitted files: $(tr '\n' ' ' < "$WORK/omitted.txt")"
  warn "raise MAX_REVIEW_DIFF_LINES / MAX_REVIEW_DIFF_BYTES in factory/config.env to widen coverage"
fi

# ------------------------------------------------------------ the issue -----
# Resolve the issue this PR closes, so spec-conformance has something to judge
# the diff AGAINST. Without the issue text that lens is meaningless.
PRBODY="$(gh pr view "$PR" --json body --jq .body "${GH_ARGS[@]}" 2>/dev/null || true)"
ISSUE="$(printf '%s' "$PRBODY" | grep -oiE '(closes|fixes|resolves) #[0-9]+' | grep -oE '[0-9]+' | head -1)"
if [ -n "$ISSUE" ]; then
  gh issue view "$ISSUE" --json title,body \
    --jq '"# " + .title + "\n\n" + .body' "${GH_ARGS[@]}" > "$BODY_FILE" 2>/dev/null \
    || printf '(issue #%s could not be fetched)\n' "$ISSUE" > "$BODY_FILE"
  log "PR #$PR closes issue #$ISSUE"
else
  printf '(this PR does not reference an issue)\n' > "$BODY_FILE"
  warn "PR #$PR has no linked issue — spec-conformance review will be weaker"
fi

# ---------------------------------------------------- the shared material ---
# Built once and reused by all three lenses: identical evidence, three lenses.
MATERIAL="$WORK/material.txt"
{
  printf '================ CHANGED FILES IN THIS PR (COMPLETE LIST) ================\n'
  printf 'Every file the PR touches is listed here, including files whose diff body\n'
  printf 'was withheld. Nothing is hidden from you at the NAME level.\n\n'
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if grep -qxF "$f" "$WORK/excluded.txt" 2>/dev/null; then
      printf '  %s   [generated/vendored — diff body excluded]\n' "$f"
    elif grep -qF "$f" "$WORK/omitted.txt" 2>/dev/null; then
      printf '  %s   [diff body omitted by truncation]\n' "$f"
    else
      printf '  %s\n' "$f"
    fi
  done < "$WORK/allfiles.txt"

  printf '\n================ DEPENDENCY MANIFEST CHANGES (COMPLETE, NEVER TRUNCATED) ================\n'
  if [ -s "$WORK/manifests.diff" ]; then
    printf 'Lockfile bodies are excluded above, so dependency changes are reproduced\n'
    printf 'here IN FULL. A new or bumped dependency is reviewable from this section\n'
    printf 'alone — treat an unjustified dependency addition as a finding.\n\n'
    cat "$WORK/manifests.diff"
  else
    printf '(no package.json / Cargo.toml changes in this PR)\n'
  fi

  printf '\n================ COVERAGE NOTE — READ BEFORE JUDGING COMPLETENESS ================\n'
  case "$DIFF_MODE" in
    filtered)
      printf 'The diff below excludes generated and vendored files (lockfiles, minified\n'
      printf 'bundles, build output, source maps, chain snapshots). This is a file-level\n'
      printf 'git pathspec exclusion; no hunk is partially removed.\n' ;;
    *)
      printf 'WARNING: generated/vendored exclusion was UNAVAILABLE for this run (the PR\n'
      printf 'ref could not be fetched). The diff below is unfiltered.\n' ;;
  esac
  if [ "$EXCLUDED_N" -gt 0 ]; then
    printf '\nExcluded from the diff body (generated/vendored):\n'
    sed 's/^/  - /' "$WORK/excluded.txt"
  fi
  if [ "$TRUNCATED" = "1" ]; then
    printf '\ndiff truncated at %s lines; omitted files: %s\n' \
      "$REVIEW_LINES" "$(list_inline "$WORK/omitted.txt")"
    printf 'Ceiling that bound: %s. Shown %s lines / %s bytes of %s lines / %s bytes.\n' \
      "$TRUNC_REASON" "$REVIEW_LINES" "$REVIEW_BYTES" "$FILTERED_LINES" "$FILTERED_BYTES"
    printf '\nCOVERAGE IS PARTIAL. Judge the material you were actually given. Partial\n'
    printf 'coverage is not by itself a reason to FAIL; base your verdict on what is\n'
    printf 'visible, and state explicitly in your reasons which files you could not\n'
    printf 'see and what you therefore could not check.\n'
  else
    printf '\nNo truncation: every non-excluded file is shown in full below.\n'
  fi

  printf '\n================ ISSUE THE PR CLAIMS TO CLOSE ================\n'
  cat "$BODY_FILE"
  printf '\n================ REVIEW DIFF (PR #%s) ================\n' "$PR"
  if [ -s "$WORK/review.diff" ]; then
    cat "$WORK/review.diff"
  else
    printf '(no reviewable non-generated changes — see the file list and manifests above)\n'
  fi
  printf '\n================ END OF MATERIAL ================\n'
} > "$MATERIAL"

# --------------------------------------------------------------- the lenses --
lens_prompt() {
  case "$1" in
  correctness)
    cat <<'EOF'
LENS: CORRECTNESS AND SECURITY.

You are reviewing a diff from an autonomous agent on a Substrate/Polkadot SDK
blockchain (Scalar Commons) whose native token has a hard 100B supply cap.

Hunt specifically for:
  - Arithmetic that can overflow, underflow, or truncate. On this chain ALL
    balance arithmetic must use saturating_* or checked_*; a bare + - * on a
    Balance is a defect.
  - Any path that could mint beyond the supply cap, or mint outside the
    emissions pallet.
  - Guards that fire AFTER funds move rather than before (ensure! must precede
    reserve/transfer/mint).
  - Removed or weakened economic guards: self-link checks, minimum-volume
    floors, bonus caps, double-settlement guards.
  - A privileged/root caller introduced into an economically essential path
    (era settlement and reward claims must stay permissionless).
  - Panics, unwraps, or indexing that a hostile caller can reach.
  - Storage layout changes with no migration and no spec_version bump.
  - Off-by-one and boundary errors; incorrect rounding direction (rounding must
    never favour the claimant).

Be concrete: cite the file and the line from the diff. Do not speculate about
code you cannot see; judge what the diff actually does. If the diff is correct
and safe, say so plainly — a clean PASS is a valid and useful outcome.
EOF
    ;;
  conformance)
    cat <<'EOF'
LENS: SPEC CONFORMANCE — does the diff do what the issue asked, and NOTHING MORE?

Two failure modes, both of which you must treat as FAIL:
  1. UNDER-DELIVERY: the issue asked for something the diff does not do, or
     does only partially, or fakes (a stub that satisfies a signature without
     implementing behaviour).
  2. SCOPE CREEP: the diff changes things the issue never asked for —
     opportunistic refactors, renames, reformatting of untouched code, new
     dependencies, unrelated files, "while I was here" edits. In an autonomous
     factory, unrequested change is unreviewed risk, so it is a defect even
     when the change looks like an improvement.

The CHANGED FILES list and the DEPENDENCY MANIFEST CHANGES section are complete
even where the diff body is not: use them to judge scope creep and new
dependencies, which are exactly the things a truncated diff would otherwise
hide.

Go requirement by requirement through the issue and state, for each, whether
the diff satisfies it, citing diff lines. Then list every change in the diff
that no requirement asked for.

Judge only the issue text and the diff. If the issue is ambiguous, say which
reading you applied.
EOF
    ;;
  standing)
    cat <<'EOF'
LENS: STANDING-RULE VIOLATIONS.

The single standing rule of this factory:
  NEVER make a check pass by weakening code.

An agent under gate pressure has a cheap escape: make the check stop checking.
Your only job is to find every instance. List EVERY OCCURRENCE with file and
line — not a sample, not "several instances", every one.

Search the diff for:
  - Tests deleted, renamed away, commented out, #[ignore]d, skipped,
    it.skip/xit/describe.skip, or otherwise removed from execution.
  - Assertions weakened: assert_eq! -> assert!, a tightened bound loosened, an
    exact value replaced by a range or a truthiness check, an expected error
    changed to accept anything.
  - todo!(), unimplemented!(), unreachable!() used as an implementation, empty
    function bodies, `fn main() {}` in node/ or runtime/ paths.
  - #[allow(...)] or eslint-disable added to silence a lint rather than fix it.
  - SKIP_WASM_BUILD, or build steps disabled/short-circuited.
  - The gate or CI config itself relaxed: test commands narrowed, --no-run
    added, workspace scope reduced, failing checks removed, timeouts inflated
    to mask hangs, `|| true` appended to a failing command.
  - Error handling replaced by silent swallowing (empty catch, `let _ =`,
    unwrap_or_default hiding a real failure).

If you find NONE of these, that is a legitimate PASS; say so explicitly. If you
find even one, it is a FAIL. There is no severity threshold for this lens.
EOF
    ;;
  esac
}

VERDICT_FMT='
Finish your response with a final line that is EXACTLY one of:
VERDICT: PASS
VERDICT: FAIL
Nothing after it. If you are uncertain about the CODE, choose FAIL and explain
the doubt. Uncertainty caused by material you were not given is not a reason to
FAIL — say what you could not see instead.
Before that line, give your reasons concisely, citing file:line from the diff.'

# run_lens <name>
#
# Writes, and returns nothing on stdout:
#   $WORK/<name>.out     the model's stdout, verbatim
#   $WORK/<name>.err     the model's stderr, verbatim
#   $WORK/<name>.rc      the exit code of the claude call (-1 = never invoked)
#   $WORK/<name>.result  PASS | FAIL | ERROR
#   $WORK/<name>.note    why, when the result is ERROR
#
# Results travel in files ON PURPOSE. This function logs, log() writes to
# stdout, and a stdout-returned verdict would be silently concatenated with
# those log lines by the caller's command substitution — which is exactly the
# bug that kept the tally pinned at 0 PASS / 0 FAIL. See the header.
run_lens() {
  local name="$1"
  local out="$WORK/$name.out"
  local err="$WORK/$name.err"
  local pf="$WORK/$name.prompt"
  local rc v
  : > "$out"; : > "$err"; : > "$WORK/$name.note"

  {
    printf 'You are a strict, adversarial code reviewer. You were given no\n'
    printf 'context other than what follows. Judge only this material.\n\n'
    lens_prompt "$name"
    printf '\n%s\n\n' "$VERDICT_FMT"
    cat "$MATERIAL"
  } > "$pf"

  # Each lens is its own `claude -p` process, so each lens costs. A review is
  # three spawns, not one, and is charged as three — including under --dry-run,
  # which runs the models for real and only withholds the side effects.
  if ! spend_reserve "review:pr-$PR:lens-$name"; then
    spend_refusal "review lens $name for PR #$PR" >&2
    warn "lens $name not run — daily spawn cap. Recording ERROR (not FAIL): no"
    warn "review happened, so there is nothing to pass or fail."
    printf '%s\n' "-1" > "$WORK/$name.rc"
    printf 'ERROR\n'    > "$WORK/$name.result"
    printf 'lens not run: daily spawn cap reached (%s/%s). No verdict was formed.\n' \
      "$(spend_count)" "$DAILY_SPAWN_CAP" > "$WORK/$name.note"
    return 0
  fi

  log "running lens: $name ($(wc -l < "$pf")-line prompt, $(wc -c < "$pf") bytes)"

  # Fresh process, fresh context, run OUTSIDE the repo so no CLAUDE.md or repo
  # files leak in. --dangerously-skip-permissions keeps it non-interactive; the
  # reviewer has nothing to write anyway.
  #
  # THE PROMPT IS DELIVERED ON STDIN, AS A FILE REDIRECT — never as an argv
  # string. `claude -p "$(cat "$pf")"` would put the whole prompt in one argv
  # element, and Linux caps a single argument at MAX_ARG_STRLEN (131072 bytes),
  # so any large diff would fail execve() with E2BIG before claude started.
  # A redirect passes a file descriptor, so prompt size is irrelevant to exec
  # and E2BIG cannot recur at any diff size. The caps below exist for
  # reviewability, NOT to keep an argv string under a limit.
  #
  # MODEL: sonnet, except opus when this diff touches runtime/ or pallets/ —
  # the consensus and economic code, where the reviewer should not be weaker
  # than the change it is judging. Chosen explicitly rather than left to the
  # CLI default (LAB decision, 27 Sep 2026).
  #
  # It was briefly opus for EVERY lens. That was set when loops billed a
  # metered API key, where the cost of three opus calls per review is linear
  # and predictable. This box now bills a Max subscription, where the cost is a
  # rate limit instead — three opus lenses per review hit one within hours on
  # 27 Sep, and a rate limit pauses dispatch, every worker and every lens at
  # once. Sonnet by default keeps the review cadence affordable; the diffs that
  # actually warrant opus are named above.
  ( cd "$WORK" && timeout "$REVIEW_LENS_TIMEOUT" claude -p --model "$LENS_MODEL" --dangerously-skip-permissions ) \
    < "$pf" > "$out" 2> "$err"
  rc=$?
  printf '%s\n' "$rc" > "$WORK/$name.rc"

  if looks_rate_limited "$err" || looks_rate_limited "$out"; then
    warn "lens $name hit a rate limit — engaging back-off"
    start_backoff "$BACKOFF_MINUTES"
  fi

  v="$(classify_lens_result "$rc" "$out")"
  printf '%s\n' "$v" > "$WORK/$name.result"

  if [ "$v" = "ERROR" ]; then
    if [ "$rc" -ne 0 ]; then
      warn "lens $name: claude exited $rc — recording ERROR, not FAIL"
      {
        printf 'claude -p exited %s (timeout was %ss).\n' "$rc" "$REVIEW_LENS_TIMEOUT"
        [ "$rc" = "124" ] && printf 'Exit 124 is the timeout killing the call.\n'
        [ "$rc" = "126" ] && printf 'Exit 126 is an exec failure. NOTE: the prompt goes on stdin, so this is NOT a prompt-size problem — check the claude binary.\n'
        printf 'stdout captured: %s bytes. stderr (first 20 lines):\n' "$(wc -c < "$out")"
        head -20 "$err"
      } > "$WORK/$name.note"
    else
      warn "lens $name: exit 0 but no parseable VERDICT line — recording ERROR, not FAIL"
      {
        printf 'claude -p exited 0 but produced no parseable "VERDICT: PASS|FAIL" line.\n'
        printf 'stdout captured: %s bytes. Last 20 lines of stdout:\n' "$(wc -c < "$out")"
        tail -20 "$out"
      } > "$WORK/$name.note"
    fi
  fi
  return 0
}

LENSES=(correctness conformance standing)
declare -A VERDICT=()
declare -A RC=()
PASSES=0
FAILS=0
ERRORS=0

# A lens that could not run is retried before its ERROR is accepted (added
# 27 Sep 2026). An ERROR is an infrastructure failure, not a judgement, and the
# failures seen in practice were transient-shaped: the process exited in under a
# second having written nothing parseable. Retrying costs one spawn and converts
# most of them into an actual verdict, which is the difference between a review
# that happened and a PR nobody can merge.
#
# A FAIL or PASS is never retried: re-running a lens that already judged, hoping
# for a different answer, is exactly the "keep rolling until it goes green"
# behaviour the standing rule forbids.
#
# Both knobs are validated the SAME way, and a bad value is fatal.
#
# The first version silently coerced a non-numeric REVIEW_LENS_RETRIES to 2
# while asserting "an unknown value is fatal, never a fallback" three lines
# above, and left REVIEW_LENS_RETRY_SLEEP unvalidated entirely -- where a
# non-numeric value makes `sleep` fail inside the retry loop. Both were pointed
# out by the spec-conformance lens. A rule the file states about itself should
# hold everywhere in the file.
: "${REVIEW_LENS_RETRIES:=2}"
: "${REVIEW_LENS_RETRY_SLEEP:=15}"
case "$REVIEW_LENS_RETRIES" in ''|*[!0-9]*)
  die "REVIEW_LENS_RETRIES=$REVIEW_LENS_RETRIES is not a non-negative integer" ;;
esac
case "$REVIEW_LENS_RETRY_SLEEP" in ''|*[!0-9]*)
  die "REVIEW_LENS_RETRY_SLEEP=$REVIEW_LENS_RETRY_SLEEP is not a non-negative integer" ;;
esac

for l in "${LENSES[@]}"; do
  attempt=0
  while : ; do
    run_lens "$l"
    VERDICT[$l]="$(cat "$WORK/$l.result" 2>/dev/null || echo ERROR)"
    RC[$l]="$(cat "$WORK/$l.rc" 2>/dev/null || echo '?')"
    case "${VERDICT[$l]}" in
      PASS|FAIL) break ;;
    esac
    [ "$attempt" -ge "$REVIEW_LENS_RETRIES" ] && break
    attempt=$(( attempt + 1 ))
    warn "lens $l could not produce a verdict (claude exit ${RC[$l]}) — retry $attempt/$REVIEW_LENS_RETRIES in ${REVIEW_LENS_RETRY_SLEEP}s"
    sleep "$REVIEW_LENS_RETRY_SLEEP"
  done
  case "${VERDICT[$l]}" in
    PASS) PASSES=$((PASSES+1)) ;;
    FAIL) FAILS=$((FAILS+1))   ;;
    *)    ERRORS=$((ERRORS+1)) ;;
  esac
  log "lens $l => ${VERDICT[$l]} (claude exit ${RC[$l]}$([ "$attempt" -gt 0 ] && printf ', after %s retr%s' "$attempt" "$([ "$attempt" = 1 ] && echo y || echo ies)"))"
done

# An incomplete review is never a pass. agent-reviewed additionally requires
# that every lens actually ran.
if [ "$ERRORS" -gt 0 ]; then
  STATUS="INCONCLUSIVE"
elif [ "$FAILS" -gt 0 ]; then
  STATUS="FAIL"
elif [ "$PASSES" -ge 2 ]; then
  STATUS="PASS"
else
  STATUS="INCONCLUSIVE"
fi
log "review status: $STATUS ($PASSES PASS / $FAILS FAIL / $ERRORS ERROR)"

# ------------------------------------------------------------- dry run ------
if [ "$DRY_RUN" = "1" ]; then
  printf '\n===== DRY RUN — PR #%s — nothing posted, labelled, or merged =====\n' "$PR"
  printf 'diff:   raw %s lines -> filtered %s -> review %s lines / %s B  (mode: %s)\n' \
    "$RAW_LINES" "$FILTERED_LINES" "$REVIEW_LINES" "$REVIEW_BYTES" "$DIFF_MODE"
  printf 'caps:   %s lines / %s bytes\n' "$MAX_REVIEW_DIFF_LINES" "$MAX_REVIEW_DIFF_BYTES"
  printf 'excluded as generated/vendored: %s file(s)\n' "$EXCLUDED_N"
  if [ "$TRUNCATED" = "1" ]; then
    printf 'TRUNCATED by %s; shown %s lines / %s B; omitted: %s\n' \
      "$TRUNC_REASON" "$REVIEW_LINES" "$REVIEW_BYTES" "$(list_inline "$WORK/omitted.txt")"
  else
    printf 'not truncated\n'
  fi
  for l in "${LENSES[@]}"; do
    printf '\n--- lens %s: exit=%s verdict=%s ---\n' "$l" "${RC[$l]}" "${VERDICT[$l]}"
    if [ -s "$WORK/$l.note" ]; then
      printf 'note:\n'; sed 's/^/  /' "$WORK/$l.note"
    fi
    printf 'reasons (last 40 lines of the model stdout):\n'
    if [ -s "$WORK/$l.out" ]; then tail -40 "$WORK/$l.out" | sed 's/^/  /'; else printf '  (no stdout)\n'; fi
  done
  printf '\n===== DRY RUN SUMMARY: %s PASS / %s FAIL / %s ERROR => %s =====\n' \
    "$PASSES" "$FAILS" "$ERRORS" "$STATUS"
  printf 'WOULD: post a verdict comment on PR #%s\n' "$PR"
  [ "$PASSES" -ge 2 ] && [ "$ERRORS" -eq 0 ] && printf 'WOULD: label agent-reviewed\n'
  { [ "$FAILS" -gt 0 ] || [ "$ERRORS" -gt 0 ]; } && printf 'WOULD: label needs-human\n'
  printf 'WOULD NOT: merge — review.sh has no merge path, under any flag\n'
  case "$STATUS" in PASS) exit 0 ;; FAIL) exit 1 ;; *) exit 2 ;; esac
fi

# ------------------------------------------------------------- publish ------
# Literal Markdown backtick, passed as a printf ARGUMENT so format strings stay
# free of characters the shell would interpret.
BT='`'
COMMENT="$WORK/comment.md"
{
  printf '## Fresh-context adversarial review — PR #%s\n\n' "$PR"
  printf 'Three independent %sclaude -p%s reviewers, each a separate process with a\n' "$BT" "$BT"
  printf 'fresh context, each given the complete changed-file list, the complete\n'
  printf 'dependency-manifest diff, a generated-file-filtered review diff, the linked\n'
  printf 'issue body, and one lens.\n\n'
  printf '| Lens | Verdict | claude exit |\n|---|---|---|\n'
  for l in "${LENSES[@]}"; do
    printf '| %s | **%s** | %s |\n' "$l" "${VERDICT[$l]}" "${RC[$l]}"
  done
  printf '\n**Tally: %s PASS / %s FAIL / %s ERROR — status %s.**\n\n' \
    "$PASSES" "$FAILS" "$ERRORS" "$STATUS"
  if [ "$ERRORS" -gt 0 ]; then
    printf '> **INCONCLUSIVE.** %s lens/lenses did not produce a judgement after up to\n' "$ERRORS"
    printf '> %s retr%s each, so this PR has **not** been reviewed and is **not** merged.\n' \
      "$REVIEW_LENS_RETRIES" "$([ "$REVIEW_LENS_RETRIES" = 1 ] && echo y || echo ies)"
    printf '> A lens that reaches a verdict is never retried — only one that fails to\n'
    printf '> produce one, so a retry can never turn a FAIL into a PASS.\n'
    printf '>\n'
    printf '> It is not labelled %sagent-reviewed%s — a reviewer that cannot review does\n' "$BT" "$BT"
    printf '> not pass.\n'
    printf '>\n'
    # The label sentence MUST agree with review_labels(), which sets needs-human
    # whenever FAILS > 0 regardless of ERRORS. An earlier version of this block
    # printed "deliberately not labelled needs-human" unconditionally, so in a
    # mixed state (say 1 FAIL + 1 ERROR) the comment asserted the opposite of
    # what the code had just done — and this comment is the audit record, so a
    # wrong one is worse than none. Caught by the spec-conformance lens on this
    # PR's own review, which is the system working as intended.
    if [ "$FAILS" -gt 0 ]; then
      printf '> It **is** labelled %sneeds-human%s, because %s lens/lenses also returned a\n' "$BT" "$BT" "$FAILS"
      printf '> real FAIL. That objection stands on its own and a human has to clear it;\n'
      printf '> re-running the review will not, since the FAIL is a finding and not an\n'
      printf '> infrastructure failure. Read the objections below first — the ERROR above\n'
      printf '> means the review is ALSO incomplete, so the objections may not be all of\n'
      printf '> them.\n'
      printf '>\n'
      printf '> %sgates/reviews-on-head.sh%s refuses this PR on every merge pass regardless,\n' "$BT" "$BT"
      printf '> because the review did not complete. Fixing the cause of the ERROR and\n'
      printf '> re-running %sfactory/review.sh %s%s gets a complete review; the FAIL still\n' "$BT" "$PR" "$BT"
      printf '> has to be answered on its merits.\n'
    else
      printf '> It is deliberately **not** labelled %sneeds-human%s either: that\n' "$BT" "$BT"
      printf '> label is reserved for a real FAIL, where a lens ran and objected. An\n'
      printf '> infrastructure failure is not a review objection, and %sneeds-human%s is a\n' "$BT" "$BT"
      printf '> one-way ratchet that no automation removes, so applying it here would park\n'
      printf '> this PR in a state only a human could clear — which is how the merge queue\n'
      printf '> silently stalled for ~15 hours on 2026-09-27.\n'
      printf '>\n'
      printf '> What happens instead: %sgates/reviews-on-head.sh%s keeps refusing this PR on\n' "$BT" "$BT"
      printf '> every merge pass, with a reason, until a review actually completes. Re-run\n'
      printf '> %sfactory/review.sh %s%s to try again once the cause is fixed.\n' "$BT" "$PR" "$BT"
    fi
    printf '\n'
  fi
  printf '**Diff coverage:** raw %s lines -> %s after excluding generated/vendored -> %s reviewed (%s bytes; caps %s lines / %s bytes; mode: %s).\n' \
    "$RAW_LINES" "$FILTERED_LINES" "$REVIEW_LINES" "$REVIEW_BYTES" \
    "$MAX_REVIEW_DIFF_LINES" "$MAX_REVIEW_DIFF_BYTES" "$DIFF_MODE"
  if [ "$EXCLUDED_N" -gt 0 ]; then
    printf 'Excluded from the diff body (names and manifest diffs were still reviewed): %s\n' \
      "$(list_inline "$WORK/excluded.txt")"
  fi
  if [ "$TRUNCATED" = "1" ]; then
    printf '\n> **Partial coverage:** diff truncated at %s lines (%s); omitted files: %s\n' \
      "$REVIEW_LINES" "$TRUNC_REASON" "$(list_inline "$WORK/omitted.txt")"
  fi
  printf '\n'
  for l in "${LENSES[@]}"; do
    printf '<details><summary>%s — %s</summary>\n\n```\n' "$l" "${VERDICT[$l]}"
    [ -s "$WORK/$l.note" ] && cat "$WORK/$l.note"
    tail -c 25000 "$WORK/$l.out"
    printf '\n```\n\n</details>\n\n'
  done
  printf -- '---\n'
  printf '**Reviewed head:** %s%s%s — this verdict binds to that commit only. If the\n' "$BT" "$REVIEWED_SHA" "$BT"
  printf 'PR head moves, %sfactory/merge.sh%s refuses the PR until it is reviewed again.\n\n' "$BT" "$BT"
  printf '%s\n' "$(review_head_marker "$REVIEWED_SHA")"
  printf '\n*Posted by %sfactory/review.sh%s. This tool never merges.*\n' "$BT" "$BT"
} > "$COMMENT"

if gh pr comment "$PR" --body-file "$COMMENT" "${GH_ARGS[@]}" >/dev/null 2>&1; then
  log "posted verdict comment to PR #$PR"
else
  warn "could not post comment to PR #$PR"
fi

if [ "$PASSES" -ge 2 ] && [ "$ERRORS" -eq 0 ]; then
  if gh pr edit "$PR" --add-label agent-reviewed "${GH_ARGS[@]}" >/dev/null 2>&1; then
    log "labelled PR #$PR agent-reviewed ($PASSES/3 PASS)"
  else
    warn "could not add agent-reviewed (does the label exist? run bootstrap-labels.sh)"
  fi
elif [ "$PASSES" -ge 2 ]; then
  log "NOT labelling agent-reviewed: $ERRORS lens/lenses errored, so the review is incomplete"
fi

if [ "$FAILS" -gt 0 ] || [ "$ERRORS" -gt 0 ]; then
  gh pr edit "$PR" --add-label needs-human "${GH_ARGS[@]}" >/dev/null 2>&1 \
    || warn "could not add needs-human label"
  {
    if [ "$FAILS" -gt 0 ]; then
      printf '### Unresolved objections — human review required\n\n'
      printf '%s of 3 lenses returned FAIL. Regardless of the tally, a FAIL means an\n' "$FAILS"
      printf 'unresolved objection, so this PR is labelled %sneeds-human%s and\n' "$BT" "$BT"
      printf '%sfactory/merge.sh%s will refuse it.\n\n' "$BT" "$BT"
    fi
    if [ "$ERRORS" -gt 0 ]; then
      printf '### Review INCONCLUSIVE — human review required\n\n'
      printf '%s of 3 lenses failed to produce a judgement. This is not a finding\n' "$ERRORS"
      printf 'against the PR; it is a failure of the reviewer, and it means the PR is\n'
      printf 'unreviewed. Re-run %sfactory/review.sh %s%s once the cause below is fixed.\n\n' "$BT" "$PR" "$BT"
    fi
    for l in "${LENSES[@]}"; do
      case "${VERDICT[$l]}" in
        FAIL)
          printf '#### %s — FAIL\n\n```\n' "$l"
          tail -c 15000 "$WORK/$l.out"
          printf '\n```\n\n' ;;
        PASS) : ;;
        *)
          printf '#### %s — ERROR (claude exit %s)\n\n```\n' "$l" "${RC[$l]}"
          cat "$WORK/$l.note"
          printf '\n```\n\n' ;;
      esac
    done
  } > "$WORK/objections.md"
  gh pr comment "$PR" --body-file "$WORK/objections.md" "${GH_ARGS[@]}" >/dev/null 2>&1 || true
  log "PR #$PR flagged needs-human ($FAILS FAIL, $ERRORS ERROR)"
  [ "$ERRORS" -gt 0 ] && exit 2
  exit 1
fi

log "review complete: $PASSES/3 PASS, no objections. review.sh does not merge."
exit 0
