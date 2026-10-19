#!/usr/bin/env bash
# factory/tests/merge-binding.sh — prove the review/merge contract is mechanical.
#
# WHY THIS TEST EXISTS (audit findings I-13 causes 3 and 4)
#
# Two defects, one test file, because they meet in the same decision:
#
#   cause 4 — `agent-reviewed` was a naked label. dispatch.sh re-pushes from a
#   reused worktree every hour, so commits nobody reviewed could land on a PR
#   that kept the label. "Any FAIL from any lens blocks the merge" held by
#   convention, not by mechanism. The fix binds the label to a head SHA:
#   review.sh records the SHA it actually reviewed in its verdict comment, and
#   merge.sh refuses when the PR head has moved on.
#
#   cause 3 — both open PRs were BEHIND, and with
#   `required_status_checks.strict: true` GitHub blocks out-of-date branches
#   while merge.sh had no update-branch step. Even a perfectly clean, fully
#   reviewed PR could never merge. The fix runs `gh pr update-branch`, waits
#   for the new checks, and only then merges.
#
# Those two fixes collide, and the collision is the interesting case: an
# update-branch MOVES the head, which by cause 4's rule invalidates the review
# binding. Refusing there would put the factory straight back where the audit
# found it — permanently unable to merge anything. Accepting anything with the
# reviewed SHA somewhere in its history would hand back the hole cause 4 closed.
#
# So the exception is narrow and mechanically checked, not asserted: the new
# head is accepted only if it is a merge commit whose FIRST parent is exactly
# the reviewed SHA and whose SECOND parent is already contained in the base
# branch — the precise shape `gh pr update-branch` produces, and a shape that
# cannot introduce a line of unreviewed change. Anything else is STALE.
#
# Everything below drives merge.sh's own self-test entrypoints and a real
# throwaway git repo. No network, no API spend, no PR is touched.

set -uo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FACTORY_DIR="$(cd "$TESTS_DIR/.." && pwd)"
MERGE="$FACTORY_DIR/merge.sh"
REVIEW="$FACTORY_DIR/review.sh"
[ -x "$MERGE" ]  || { printf 'FATAL: %s not found or not executable\n' "$MERGE" >&2; exit 1; }
[ -x "$REVIEW" ] || { printf 'FATAL: %s not found or not executable\n' "$REVIEW" >&2; exit 1; }

PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }
assert_eq() { if [ "$1" = "$2" ]; then ok "$3 (got '$1')"; else bad "$3 (expected '$2', got '$1')"; fi; }

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

A=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
B=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

# ---------------------------------------------------------------------------
# 1. The marker round-trips: what review.sh writes is what merge.sh reads.
#
# Both sides use the shared helpers in lib/common.sh, so this asserts one
# format rather than two that agree today and drift tomorrow.
# ---------------------------------------------------------------------------
printf '\n\033[1m=== the reviewed-SHA marker round-trips ===\033[0m\n'

MARKER="$("$REVIEW" --head-marker "$A")"
if printf '%s' "$MARKER" | grep -q "$A"; then
  ok "review.sh --head-marker emits the SHA: $MARKER"
else
  bad "review.sh --head-marker did not emit the SHA (got '$MARKER')"
fi

GOT="$(printf 'blah blah\n%s\nmore text\n' "$MARKER" | "$MERGE" --reviewed-sha)"
assert_eq "$GOT" "$A" 'merge.sh --reviewed-sha reads back the marker review.sh wrote'

# A comment stream with several reviews: the LAST marker wins, because the last
# review is the one that judged the current state of the PR.
GOT="$(printf '%s\nchit chat\n%s\n' "$(printf '<!-- factory-review-head: %s -->' "$A")" "$(printf '<!-- factory-review-head: %s -->' "$B")" | "$MERGE" --reviewed-sha 2>/dev/null)"
assert_eq "$GOT" "$B" 'the most recent marker wins when a PR has been reviewed twice'

GOT="$(printf 'a PR with no review comment at all\n' | "$MERGE" --reviewed-sha)"
assert_eq "$GOT" "" 'no marker present yields the empty string, not a false match'

# Prose that merely mentions a SHA must not be mistaken for a binding.
GOT="$(printf 'I reviewed %s by hand, looks fine to me\n' "$A" | "$MERGE" --reviewed-sha)"
assert_eq "$GOT" "" 'a bare SHA in prose is not a binding'

# ---------------------------------------------------------------------------
# 2. The binding decision, in isolation.
# ---------------------------------------------------------------------------
printf '\n\033[1m=== binding states ===\033[0m\n'

assert_eq "$("$MERGE" --binding-state "$A" "$A")" OK       'head equals the reviewed SHA => OK'
assert_eq "$("$MERGE" --binding-state "$A" "$B")" STALE    'head has moved past the reviewed SHA => STALE'
assert_eq "$("$MERGE" --binding-state ""   "$A")" UNBOUND  'agent-reviewed with no recorded SHA => UNBOUND'
assert_eq "$("$MERGE" --binding-state "$A" ""  )" UNBOUND  'no readable head => UNBOUND, never OK'

# ---------------------------------------------------------------------------
# 3. The mergeable-state decision.
#
# The audit's rule: refuse only on CONFLICTING; `behind` is a thing to FIX, not
# a thing to refuse. Every pre-existing refusal stays a refusal.
# ---------------------------------------------------------------------------
printf '\n\033[1m=== mergeable-state decisions ===\033[0m\n'

assert_eq "$("$MERGE" --state-decision CONFLICTING DIRTY)"   'REFUSE:has merge conflicts' 'CONFLICTING is still refused'
assert_eq "$("$MERGE" --state-decision MERGEABLE   DIRTY)"   'REFUSE:has merge conflicts' 'a DIRTY state is refused even if mergeable says otherwise'
assert_eq "$("$MERGE" --state-decision MERGEABLE   BEHIND)"  'UPDATE_BRANCH'              'BEHIND is updated, not refused'
assert_eq "$("$MERGE" --state-decision MERGEABLE   BLOCKED)" 'MERGE'                      'BLOCKED falls through to the CI check, which is the real gate'
assert_eq "$("$MERGE" --state-decision MERGEABLE   CLEAN)"   'MERGE'                      'CLEAN merges'
assert_eq "$("$MERGE" --state-decision MERGEABLE   UNSTABLE)" 'MERGE'                     'UNSTABLE falls through to the CI check'
assert_eq "$("$MERGE" --state-decision CONFLICTING BEHIND)"  'REFUSE:has merge conflicts' 'conflicts beat behind — never update a conflicted branch'

# ---------------------------------------------------------------------------
# 4. The update-branch exception, against a real git repo.
#
# Build the exact shape `gh pr update-branch` produces and three shapes that
# only resemble it, and assert the checker separates them.
# ---------------------------------------------------------------------------
printf '\n\033[1m=== the update-branch lineage exception ===\033[0m\n'

R="$T/repo"
mkdir -p "$R"
git -C "$R" init -q -b master
git -C "$R" config user.email t@t; git -C "$R" config user.name t
echo base1 > "$R/base.txt"; git -C "$R" add -A; git -C "$R" commit -qm base1
git -C "$R" branch -q feature
echo feat > "$R/feat.txt"; git -C "$R" -c advice.detachedHead=false checkout -q feature
git -C "$R" add -A; git -C "$R" commit -qm feat
REVIEWED="$(git -C "$R" rev-parse HEAD)"
git -C "$R" checkout -q master
echo base2 >> "$R/base.txt"; git -C "$R" add -A; git -C "$R" commit -qm base2

# (a) the real thing: master merged INTO feature, first parent = reviewed head
git -C "$R" checkout -q feature
git -C "$R" merge -q --no-ff -m "Merge branch 'master' into feature" master
UPDATED="$(git -C "$R" rev-parse HEAD)"

run_check() { REPO_DIR="$R" "$MERGE" --lineage-check "$1" "$2" master; }

assert_eq "$(run_check "$REVIEWED" "$UPDATED")" OK \
  'a base-merge whose first parent is the reviewed SHA is accepted'
assert_eq "$(run_check "$REVIEWED" "$REVIEWED")" OK \
  'the reviewed SHA itself is accepted'

# (b) an ordinary unreviewed commit on top of the reviewed head
echo sneaky > "$R/sneaky.txt"; git -C "$R" add -A; git -C "$R" commit -qm sneaky
SNEAKY="$(git -C "$R" rev-parse HEAD)"
assert_eq "$(run_check "$REVIEWED" "$SNEAKY")" STALE \
  'an unreviewed commit pushed on top is REJECTED (this is the hole cause 4 left open)'

# (c) an unreviewed commit hidden UNDER a later base merge — the head is once
#     again a merge commit, so a naive "is it a merge?" test would wave it
#     through. Its first parent is the sneaky commit, not the reviewed SHA.
git -C "$R" checkout -q master
echo base3 >> "$R/base.txt"; git -C "$R" add -A; git -C "$R" commit -qm base3
git -C "$R" checkout -q feature
git -C "$R" merge -q --no-ff -m "Merge branch 'master' into feature" master
HIDDEN="$(git -C "$R" rev-parse HEAD)"
assert_eq "$(run_check "$REVIEWED" "$HIDDEN")" STALE \
  'a base merge that buries an unreviewed commit is REJECTED'

# (d) a merge whose second parent is NOT in the base branch — i.e. someone
#     merged an arbitrary branch in and called it an update.
git -C "$R" checkout -q -b rogue "$REVIEWED"
echo rogue > "$R/rogue.txt"; git -C "$R" add -A; git -C "$R" commit -qm rogue
git -C "$R" checkout -q -b feature2 "$REVIEWED"
git -C "$R" merge -q --no-ff -m "Merge branch 'rogue' into feature2" rogue
ROGUE="$(git -C "$R" rev-parse HEAD)"
assert_eq "$(run_check "$REVIEWED" "$ROGUE")" STALE \
  'a merge of an arbitrary branch is REJECTED even with the right first parent'

# (e) an unknown SHA must not crash into an accept
assert_eq "$(run_check "$REVIEWED" 0000000000000000000000000000000000000000)" STALE \
  'an unresolvable head is REJECTED'
assert_eq "$(run_check "" "$UPDATED")" STALE \
  'an empty reviewed SHA is REJECTED'

# ---------------------------------------------------------------------------
# 5. The self-test entrypoints must not do real work.
# ---------------------------------------------------------------------------
printf '\n\033[1m=== self-test entrypoints are side-effect free ===\033[0m\n'
for mode in "--binding-state $A $A" "--state-decision MERGEABLE CLEAN" "--lineage-check $A $A master"; do
  # shellcheck disable=SC2086
  out="$(REPO_DIR="$R" "$MERGE" $mode 2>&1)"
  if printf '%s' "$out" | grep -qiE 'factory merge|branch protection|gh pr|REFUSING'; then
    bad "$mode leaked into the real merge path"
  else
    ok "$mode exits with a single result and does no merge work"
  fi
done

# ---------------------------------------------------------------------------
# 6. End to end, through merge.sh's real loop, against a stub `gh`.
#
# Sections 2-4 test the decision functions. This section tests the WIRING: that
# the loop actually consults them, in the right order, and refuses. A pure-unit
# suite would stay green if someone wired the functions up and never called
# them, which is precisely the "green but wrong" state this repo has been
# burned by before.
#
# The stub answers only the reads merge.sh makes and FAILS LOUDLY on
# `gh pr merge` — so if a case here ever reaches a merge, the test says so
# instead of silently passing.
# ---------------------------------------------------------------------------
printf '\n\033[1m=== merge.sh refuses through its real loop ===\033[0m\n'

STUB="$T/bin"; mkdir -p "$STUB"
MERGE_ATTEMPTED="$T/merge-was-attempted"
UPDATED_FLAG="$T/update-branch-ran"

make_stub_gh() {  # make_stub_gh <headsha> <mergeable> <mergestate> <comment> [sha-after-update]
  cat > "$STUB/gh" <<EOF
#!/usr/bin/env bash
HEADSHA='$1'; MERGEABLE='$2'; MERGESTATE='$3'; COMMENT='$4'; MOVED_SHA='${5:-}'
case "\$*" in
  *"repo view"*)          echo master; exit 0 ;;
  *protection*)           echo '{"required_status_checks":{"strict":false,"contexts":["gate"]}}'; exit 0 ;;
  *"pr list"*)            printf '[{"number":900,"title":"stub","labels":[{"name":"agent-reviewed"},{"name":"tier:T3"}],"isDraft":false,"mergeable":"%s","mergeStateStatus":"%s","headRefOid":"%s","headRefName":"stub"}]' "\$MERGEABLE" "\$MERGESTATE" "\$HEADSHA"; exit 0 ;;
  *"issues/900/comments"*) printf '%s\n' "\$COMMENT"; exit 0 ;;
  *"pr checks"*)          echo "gate  pass  1s"; exit 0 ;;
  *"pr merge"*)           touch "$MERGE_ATTEMPTED"; exit 0 ;;
  *"pr update-branch"*)   [ -n "\$MOVED_SHA" ] && touch "$UPDATED_FLAG"; exit 0 ;;
  *"pr view"*headRefOid*) if [ -f "$UPDATED_FLAG" ]; then echo "\$MOVED_SHA"; else echo "\$HEADSHA"; fi; exit 0 ;;
  *"pr view"*mergeable*)  if [ -f "$UPDATED_FLAG" ]; then echo "MERGEABLE CLEAN"; else echo "\$MERGEABLE \$MERGESTATE"; fi; exit 0 ;;
  *"pr view"*)            echo '{}'; exit 0 ;;
  *) exit 0 ;;
esac
EOF
  chmod +x "$STUB/gh"
}

# MERGE_LOG is redirected to a scratch file. Without it these cases append
# fabricated rows to the REAL factory/logs/merges.log — which is evidence, not
# scratch: the audit's finding that merge.sh has never merged a pull request
# rests on that ledger. A test that writes to it corrupts what it is testing.
# Section 7 asserts the real ledger stayed untouched.
TEST_MERGE_LOG="$T/merges.log"
run_loop() {  # stdout of a real ENABLE_MERGE=true, non-dry-run pass
  rm -f "$MERGE_ATTEMPTED" "$UPDATED_FLAG"
  PATH="$STUB:$PATH" REPO_DIR="$R" ENABLE_MERGE=true MERGE_T3=true \
    MERGE_UPDATE_WAIT_SECS="${W:-4}" MERGE_UPDATE_POLL_SECS=1 \
    MERGE_LOG="$TEST_MERGE_LOG" \
    "$MERGE" 2>&1
}

# (a) reviewed SHA matches the head -> the binding does not block it
make_stub_gh "$UPDATED" MERGEABLE CLEAN "$(printf '<!-- factory-review-head: %s -->' "$UPDATED")"
OUT="$(run_loop)"
if printf '%s' "$OUT" | grep -q 'not the reviewed SHA'; then
  bad 'a correctly bound PR was refused on its binding'
else
  ok 'a PR whose head is the reviewed SHA passes the binding check'
fi

# (b) the head has moved to an unreviewed commit -> REFUSED, nothing merged
make_stub_gh "$SNEAKY" MERGEABLE CLEAN "$(printf '<!-- factory-review-head: %s -->' "$REVIEWED")"
OUT="$(run_loop)"
if printf '%s' "$OUT" | grep -q 'not the reviewed SHA'; then
  ok 'an unreviewed head is refused by the real loop'
else
  bad "the loop did not refuse an unreviewed head; got: $(printf '%s' "$OUT" | tail -3 | tr '\n' ' ')"
fi
if [ -e "$MERGE_ATTEMPTED" ]; then
  bad 'merge.sh attempted a merge on an unreviewed head'
else
  ok 'no merge was attempted on the unreviewed head'
fi

# (c) agent-reviewed with no marker at all -> UNBOUND -> REFUSED
make_stub_gh "$UPDATED" MERGEABLE CLEAN 'looks good to me, merging'
OUT="$(run_loop)"
if printf '%s' "$OUT" | grep -q 'not bound to a head SHA'; then
  ok 'an unbound agent-reviewed label is refused by the real loop'
else
  bad "the loop accepted an unbound label; got: $(printf '%s' "$OUT" | tail -3 | tr '\n' ' ')"
fi
if [ -e "$MERGE_ATTEMPTED" ]; then bad 'merge.sh merged an unbound PR'; else ok 'no merge was attempted on the unbound PR'; fi

# (d) conflicts are still refused, and are checked before any update-branch
make_stub_gh "$UPDATED" CONFLICTING BEHIND "$(printf '<!-- factory-review-head: %s -->' "$UPDATED")"
OUT="$(run_loop)"
if printf '%s' "$OUT" | grep -q 'has merge conflicts'; then
  ok 'CONFLICTING is still refused by the real loop (pre-existing refusal intact)'
else
  bad "the loop did not refuse a conflicted PR; got: $(printf '%s' "$OUT" | tail -3 | tr '\n' ' ')"
fi
if printf '%s' "$OUT" | grep -q 'updating the branch'; then
  bad 'merge.sh tried to update-branch a CONFLICTING PR'
else
  ok 'no update-branch was attempted on a conflicted PR'
fi

# (e) BEHIND, update-branch works, head moves, checks green -> it MERGES.
#     This is the whole point of I-13 cause 3: before the fix, this PR was
#     refused hourly forever and factory/logs/merges.log never came to exist.
make_stub_gh "$REVIEWED" MERGEABLE BEHIND "$(printf '<!-- factory-review-head: %s -->' "$REVIEWED")" "$UPDATED"
OUT="$(run_loop)"
if printf '%s' "$OUT" | grep -q 'is BEHIND master'; then
  ok 'a BEHIND PR reaches the update-branch path instead of being refused'
else
  bad "BEHIND did not reach update-branch; got: $(printf '%s' "$OUT" | tail -3 | tr '\n' ' ')"
fi
if [ -e "$MERGE_ATTEMPTED" ]; then
  ok 'the updated PR then merged — a BEHIND branch is no longer a dead end'
else
  bad "the updated PR still did not merge; got: $(printf '%s' "$OUT" | tail -3 | tr '\n' ' ')"
fi

# (f) BEHIND, but the head never moves (update-branch silently did nothing, or
#     the API read failed). "We do not know" must never resolve to a merge.
make_stub_gh "$UPDATED" MERGEABLE BEHIND "$(printf '<!-- factory-review-head: %s -->' "$UPDATED")"
OUT="$(run_loop)"
if printf '%s' "$OUT" | grep -q 'no new head SHA could be read'; then
  ok 'an update-branch whose head never moves is refused, not merged'
else
  bad "the loop did not fail closed on a stuck head; got: $(printf '%s' "$OUT" | tail -3 | tr '\n' ' ')"
fi
if [ -e "$MERGE_ATTEMPTED" ]; then
  bad 'merge.sh merged after an update-branch it could not verify'
else
  ok 'no merge was attempted after an unverifiable update-branch'
fi

# ---------------------------------------------------------------------------
# 7. The suite must not have written to the real merge ledger.
#
# An earlier version of this file did exactly that: nine fabricated "merged
# #900 stub" rows landed in factory/logs/merges.log, in a file whose emptiness
# is the audit's evidence that merge.sh has never merged anything. Caught by
# reading the ledger, not by any assertion — hence this one.
# ---------------------------------------------------------------------------
printf '\n\033[1m=== the real merge ledger was not touched ===\033[0m\n'

REAL_LOG="$FACTORY_DIR/logs/merges.log"
if [ -s "$TEST_MERGE_LOG" ]; then
  ok "merges were recorded to the scratch ledger ($(grep -c '' "$TEST_MERGE_LOG") row(s))"
else
  bad 'no merge reached any ledger — section 6 case (e) should have recorded one'
fi
if grep -q 'stub' "$REAL_LOG" 2>/dev/null; then
  bad "this suite wrote a stub row into the REAL ledger $REAL_LOG"
else
  ok 'the real factory/logs/merges.log carries no row from this test run'
fi

printf '\n\033[1m===== MERGE-BINDING SUMMARY: %d passed, %d failed =====\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
