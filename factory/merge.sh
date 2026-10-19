#!/usr/bin/env bash
# factory/merge.sh — the ONLY component permitted to merge. OFF BY DEFAULT.
#
#   ./factory/merge.sh --dry-run      # evaluate every candidate, merge nothing
#   ./factory/merge.sh                # execute (needs ENABLE_MERGE=true)
#   ./factory/merge.sh --pr 123       # restrict to one PR
#
# A PR is merged only if EVERY one of these holds:
#   1. branch protection with required status checks exists on the default
#      branch                              <- gate on the REPO, checked first
#   2. label agent-reviewed                <- review.sh got >=2/3 PASS
#   3. label tier:T3                       <- (or tier:T2 with MERGE_T2=true)
#   4. NO needs-human label                <- no unresolved objection
#   5. `gh pr checks` all passing          <- CI is green, not merely started
#   6. PR is OPEN and mergeable, no conflicts
#   7. the head SHA matches the SHA review.sh recorded in its verdict comment
#                                          <- the label alone is not authority
#
# ON CONDITION 7: `agent-reviewed` used to be a naked label — it said "a review
# passed", not "THIS diff passed" — while dispatch.sh re-pushed from a reused
# worktree every hour. Unreviewed commits could therefore land on a PR that
# kept the label. review.sh now records the SHA it read; merge.sh refuses a head
# that has moved. The single exception is the base merge this script performs
# itself, and it is proved from the commit graph (lineage_ok), not assumed.
#
# ON BEING BEHIND: with required_status_checks.strict=true GitHub blocks every
# out-of-date branch. merge.sh had no update step, so both open PRs were
# refused hourly and factory/logs/merges.log never came into existence. Being
# BEHIND is now something this script FIXES — `gh pr update-branch`, wait for
# the new checks, re-read the state, then merge. CONFLICTING is still the hard
# refusal, and no existing refusal was relaxed to get here.
#
# WHY CONDITION 1 IS ABSOLUTE: without branch protection and required checks,
# a squash-merge to master is unreviewable and unrevertable-by-policy — nothing
# would have stopped a bad merge, and nothing would require checks on the next
# one. Auto-merge without protection is not automation, it is an unguarded write
# to the trunk. So if protection is absent this script refuses to merge ANYTHING
# and prints why, no matter how the MERGE_* flags are set.
#
# THIS REPO, AS OF 2026-09-08: master HAS protection with six required contexts
# (gate, full, landing, faucet, docs, sdk), so condition 1 is satisfied and the
# remaining gates are the per-PR ones above.

set -uo pipefail

FACTORY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/common.sh
. "$FACTORY_DIR/lib/common.sh"

: "${ENABLE_MERGE:=false}"
: "${MERGE_T2:=false}"
: "${MERGE_T3:=true-only-after-protection}"
# How long to wait for the checks on a freshly updated branch before giving up
# and leaving the PR for the next pass. Generous by design: CI here takes
# minutes, and abandoning a correctly-updated PR just means another hour.
: "${MERGE_UPDATE_WAIT_SECS:=1800}"
: "${MERGE_UPDATE_POLL_SECS:=30}"
# Where a completed merge is recorded. Overridable ONLY so the test suite can
# point it at a scratch file: factory/tests/merge-binding.sh drives merge.sh's
# real loop against a stub `gh`, and without this every one of those cases
# appended a fabricated row to the real ledger. That ledger is evidence — the
# audit's finding that "merge.sh has never merged a pull request" rests on it —
# so a test that writes to it corrupts the thing it is meant to protect.
: "${MERGE_LOG:=$FACTORY_DIR/logs/merges.log}"

# ------------------------------------------- the decision logic, in one place --
# Pure functions: no globals, no network, no side effects. They are defined UP
# HERE, before any work, so factory/tests/merge-binding.sh can drive THE REAL
# CODE through the self-test entrypoints below instead of keeping a private
# copy that quietly stops agreeing with this file.

# binding_state <reviewed_sha> <head_sha> -> OK | STALE | UNBOUND
#
# UNBOUND is not a softer STALE: it means the PR carries `agent-reviewed` from
# before reviews were bound at all, or that the head could not be read. Both
# are "we do not know what was reviewed", and both must refuse. Fail closed.
binding_state() {
  local reviewed="${1:-}" head="${2:-}"
  if [ -z "$reviewed" ] || [ -z "$head" ]; then printf 'UNBOUND'; return 0; fi
  if [ "$reviewed" = "$head" ]; then printf 'OK'; else printf 'STALE'; fi
}

# state_decision <mergeable> <mergeStateStatus> -> MERGE | UPDATE_BRANCH | REFUSE:<why>
#
# `behind` is a condition to FIX, not to refuse. With
# required_status_checks.strict=true GitHub blocks every out-of-date branch,
# and merge.sh had no update step — which is why both open PRs sat refused
# hourly and factory/logs/merges.log never came into existence (I-13, cause 3).
#
# Conflicts remain the one hard refusal, checked FIRST: a conflicted branch
# must never be handed to update-branch. Everything else falls through to the
# CI gate below, which is where "is this actually green" is decided.
state_decision() {
  local mergeable="${1:-}" state="${2:-}"
  case "$mergeable" in CONFLICTING) printf 'REFUSE:has merge conflicts'; return 0 ;; esac
  case "$state" in
    DIRTY)  printf 'REFUSE:has merge conflicts' ;;
    BEHIND) printf 'UPDATE_BRANCH' ;;
    *)      printf 'MERGE' ;;
  esac
}

# lineage_ok <reviewed_sha> <head_sha> <base_ref> -> OK | STALE   (reads git)
#
# The one exception to strict SHA equality, and it is narrow on purpose.
#
# `gh pr update-branch` moves the head, so after merge.sh updates a branch the
# binding no longer matches by equality. Refusing there would leave the factory
# exactly where the audit found it: unable to merge anything, forever. But
# accepting "the reviewed SHA is somewhere in the history" would hand back the
# hole the binding closed — an unreviewed commit followed by a base merge has
# the reviewed SHA in its history too.
#
# So the accepted shape is exactly the one update-branch produces and nothing
# else: a two-parent merge whose FIRST parent is the reviewed SHA itself, and
# whose SECOND parent is already contained in the base branch. Such a commit
# cannot carry a line of change that the reviewed SHA and the base branch did
# not already carry between them. Anything else — an extra commit on top, a
# merge of some other branch, an unreadable SHA — is STALE.
lineage_ok() {
  local reviewed="${1:-}" head="${2:-}" base="${3:-}"
  [ -n "$reviewed" ] && [ -n "$head" ] || { printf 'STALE'; return 0; }
  [ "$reviewed" != "$head" ] || { printf 'OK'; return 0; }

  local parents p1 p2
  parents="$(git -C "$REPO_DIR" rev-list --parents -n 1 "$head" 2>/dev/null)"     || { printf 'STALE'; return 0; }
  # "<commit> <parent1> <parent2>" — exactly three fields, i.e. a 2-parent merge.
  [ "$(printf '%s' "$parents" | wc -w)" -eq 3 ] || { printf 'STALE'; return 0; }
  p1="$(printf '%s' "$parents" | awk '{print $2}')"
  p2="$(printf '%s' "$parents" | awk '{print $3}')"
  [ "$p1" = "$reviewed" ] || { printf 'STALE'; return 0; }
  git -C "$REPO_DIR" merge-base --is-ancestor "$p2" "$base" 2>/dev/null     || { printf 'STALE'; return 0; }
  printf 'OK'
}

# ------------------------------------------------- self-test entrypoints -----
# Dispatched on $1 before merge.sh reads a config flag, contacts GitHub, or
# evaluates a single PR. A test invocation can never merge anything.
case "${1:-}" in
  --reviewed-sha)
    [ $# -eq 1 ] || die "--reviewed-sha reads comment bodies on stdin"
    parse_review_head_sha; printf '\n'; exit 0 ;;
  --binding-state)
    [ $# -eq 3 ] || die "--binding-state needs <reviewed-sha> <head-sha>"
    binding_state "$2" "$3"; printf '\n'; exit 0 ;;
  --state-decision)
    [ $# -eq 3 ] || die "--state-decision needs <mergeable> <mergeStateStatus>"
    state_decision "$2" "$3"; printf '\n'; exit 0 ;;
  --lineage-check)
    [ $# -eq 4 ] || die "--lineage-check needs <reviewed-sha> <head-sha> <base-ref>"
    lineage_ok "$2" "$3" "$4"; printf '\n'; exit 0 ;;
esac

DRY_RUN=0
ONLY_PR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run|-n) DRY_RUN=1 ;;
    --pr)         ONLY_PR="${2:-}"; shift ;;
    -h|--help)    sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

stop_requested && { log "STOP_FACTORY present — merging nothing."; exit 0; }
have_gh || die "gh CLI required"

GH_ARGS=()
mapfile -t GH_ARGS < <(gh_repo_args)

DEFAULT_BRANCH="$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name "${GH_ARGS[@]}" 2>/dev/null || echo master)"

printf '\n=== factory merge %s ===\n' "$(ts)"
printf 'mode:           %s\n' "$([ "$DRY_RUN" = 1 ] && echo 'DRY RUN' || echo EXECUTE)"
printf 'default branch: %s\n' "$DEFAULT_BRANCH"
printf 'ENABLE_MERGE=%s  MERGE_T3=%s  MERGE_T2=%s\n\n' "$ENABLE_MERGE" "$MERGE_T3" "$MERGE_T2"

# ---------------------------------------------------- condition 1: protection --
# Require protection AND at least one required status check. Protection with no
# required checks would let a red PR through, which defeats the purpose.
PROT_JSON="$(gh api "repos/:owner/:repo/branches/$DEFAULT_BRANCH/protection" "${GH_ARGS[@]}" 2>&1)"
PROT_RC=$?
REQUIRED_CHECKS=""
if [ "$PROT_RC" -eq 0 ]; then
  REQUIRED_CHECKS="$(printf '%s' "$PROT_JSON" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
rsc = d.get("required_status_checks") or {}
print(",".join(rsc.get("contexts") or [c.get("context","") for c in (rsc.get("checks") or [])]))
' 2>/dev/null)"
fi

if [ "$PROT_RC" -ne 0 ] || [ -z "$REQUIRED_CHECKS" ]; then
  cat <<EOF
REFUSING TO MERGE ANYTHING — branch protection precondition not met.

  branch:            $DEFAULT_BRANCH
  protection API:    $([ "$PROT_RC" -ne 0 ] && printf 'not configured (%s)' "$(printf '%s' "$PROT_JSON" | head -c 200)" || echo 'present')
  required checks:   ${REQUIRED_CHECKS:-<none>}

Auto-merge is only safe when the trunk itself enforces the rules. Without
protection and at least one REQUIRED status check, a squash-merge from this
script would be an unguarded write to $DEFAULT_BRANCH: nothing would compel CI
to be green, and nothing would stop the next bad merge either. The factory
would be trading a reviewable PR queue for an unreviewable trunk.

So merging stays off — regardless of MERGE_T3/MERGE_T2 — until a human sets up:

  1. Branch protection on $DEFAULT_BRANCH
  2. At least one required status check (e.g. the ci-fast workflow)
  3. Ideally: require PRs, dismiss stale approvals, no force-push

  gh api -X PUT repos/:owner/:repo/branches/$DEFAULT_BRANCH/protection \\
    --input factory/branch-protection.json

Until then: PRs still get built, gated, and adversarially reviewed. A human
clicks merge. That is Stage 1, and it is a perfectly good place to live.
EOF
  exit 1
fi

log "branch protection present on $DEFAULT_BRANCH; required checks: $REQUIRED_CHECKS"

if [ "$DRY_RUN" != "1" ] && [ "$ENABLE_MERGE" != "true" ]; then
  cat >&2 <<EOF
merge.sh is DISABLED (ENABLE_MERGE=$ENABLE_MERGE).

Branch protection is satisfied, so the remaining step is the explicit opt-in:
set ENABLE_MERGE=true in factory/config.env. Use --dry-run to see decisions.
EOF
  exit 1
fi

# ------------------------------------------------------------ candidate PRs ---
PRS_JSON="$(gh pr list --state open --limit 100 \
    --json number,title,labels,isDraft,mergeable,mergeStateStatus,headRefOid,headRefName \
    "${GH_ARGS[@]}" 2>/dev/null || echo '[]')"

ROWS="$(printf '%s' "$PRS_JSON" | python3 -c '
import json,sys
try: prs=json.load(sys.stdin)
except Exception: sys.exit(0)
for p in prs:
    labels={l["name"] for l in p.get("labels") or []}
    tier=next((l for l in sorted(labels) if l.startswith("tier:")),"")
    print("\x1f".join([
        str(p["number"]), tier,
        "1" if "agent-reviewed" in labels else "0",
        "1" if "needs-human" in labels else "0",
        "1" if p.get("isDraft") else "0",
        str(p.get("mergeable") or ""),
        str(p.get("mergeStateStatus") or ""),
        str(p.get("headRefOid") or ""),
        (p.get("title") or "").replace("\t"," "),
    ]))
')"

if [ -z "$ROWS" ]; then
  printf 'No open PRs.\n\n'; exit 0
fi

MERGED=0
REFUSED=0

while IFS=$'\x1f' read -r num tier reviewed needshuman draft mergeable mergestate headsha title; do
  [ -n "$num" ] || continue
  [ -z "$ONLY_PR" ] || [ "$num" = "$ONLY_PR" ] || continue

  refuse() { printf 'REFUSE #%-4s %s\n' "$num" "$1"; REFUSED=$((REFUSED+1)); }

  # The tier label may live on the issue rather than the PR; fall back to the
  # linked issue so a correctly-tiered task is not merged as "untiered".
  if [ -z "$tier" ]; then
    body="$(gh pr view "$num" --json body --jq .body "${GH_ARGS[@]}" 2>/dev/null || true)"
    iss="$(printf '%s' "$body" | grep -oiE '(closes|fixes|resolves) #[0-9]+' | grep -oE '[0-9]+' | head -1)"
    if [ -n "$iss" ]; then
      tier="$(gh issue view "$iss" --json labels \
        --jq '[.labels[].name] | map(select(startswith("tier:"))) | first // ""' \
        "${GH_ARGS[@]}" 2>/dev/null || true)"
      [ -n "$tier" ] && log "#$num tier resolved from linked issue #$iss: $tier"
    fi
  fi

  [ "$draft" = "1" ]      && { refuse "is a draft"; continue; }
  [ "$needshuman" = "1" ] && { refuse "has needs-human (unresolved review objection)"; continue; }
  [ "$reviewed" = "1" ]   || { refuse "missing agent-reviewed (run factory/review.sh $num)"; continue; }

  case "$tier" in
    tier:T3)
      if [ "$MERGE_T3" != "true" ] && [ "$MERGE_T3" != "true-only-after-protection" ]; then
        refuse "tier:T3 but MERGE_T3=$MERGE_T3"; continue
      fi ;;
    tier:T2)
      if [ "$MERGE_T2" != "true" ]; then
        refuse "tier:T2 and MERGE_T2=false (T2 auto-merge stays off by policy)"; continue
      fi ;;
    tier:T0|tier:T1)
      refuse "$tier is never auto-merged"; continue ;;
    '') refuse "no tier label on PR or linked issue"; continue ;;
    *)  refuse "unrecognised tier '$tier'"; continue ;;
  esac

  # ---- the review must be bound to THIS head ------------------------------
  # `agent-reviewed` alone only says a review once passed. Before this check
  # existed, dispatch.sh's hourly re-push from a reused worktree could land
  # commits nobody reviewed on a PR that kept the label (I-13, cause 4). The
  # binding is the SHA review.sh recorded in its own verdict comment, which is
  # not settable by adding a label.
  REVIEWED_SHA="$(gh api "repos/:owner/:repo/issues/$num/comments" --paginate \
      --jq '.[].body' "${GH_ARGS[@]}" 2>/dev/null | parse_review_head_sha)"
  case "$(binding_state "$REVIEWED_SHA" "$headsha")" in
    OK) : ;;
    UNBOUND)
      refuse "agent-reviewed is not bound to a head SHA (re-run factory/review.sh $num)"
      continue ;;
    STALE)
      # The one accepted exception is a base merge this script itself performs;
      # lineage_ok proves that shape from the commit graph rather than trusting
      # it. Fetch the head first — the ref may not be local yet.
      git -C "$REPO_DIR" fetch --quiet --no-tags origin \
          "+refs/pull/$num/head:refs/factory-merge/pr-$num" \
          "+refs/heads/$DEFAULT_BRANCH:refs/remotes/origin/$DEFAULT_BRANCH" 2>/dev/null || true
      if [ "$(lineage_ok "$REVIEWED_SHA" "$headsha" "refs/remotes/origin/$DEFAULT_BRANCH")" = "OK" ]; then
        log "#$num head $headsha is a base-merge of reviewed $REVIEWED_SHA — binding carried forward"
      else
        refuse "head $headsha is not the reviewed SHA $REVIEWED_SHA (re-run factory/review.sh $num)"
        git -C "$REPO_DIR" update-ref -d "refs/factory-merge/pr-$num" >/dev/null 2>&1 || true
        continue
      fi
      git -C "$REPO_DIR" update-ref -d "refs/factory-merge/pr-$num" >/dev/null 2>&1 || true ;;
  esac

  # ---- conflicts refuse; being merely BEHIND gets fixed --------------------
  DECISION="$(state_decision "$mergeable" "$mergestate")"
  case "$DECISION" in
    REFUSE:*) refuse "${DECISION#REFUSE:}"; continue ;;
    UPDATE_BRANCH)
      if [ "$DRY_RUN" = "1" ]; then
        printf 'WOULD UPDATE #%-4s %-8s branch is BEHIND %s; then re-check CI and merge\n' \
          "$num" "$tier" "$DEFAULT_BRANCH"
        printf '            gh pr update-branch %s\n' "$num"
        continue
      fi
      log "#$num is BEHIND $DEFAULT_BRANCH — updating the branch before merging"
      if ! gh pr update-branch "$num" "${GH_ARGS[@]}" >/dev/null 2>&1; then
        refuse "gh pr update-branch failed (branch cannot be brought up to date)"; continue
      fi

      # The head has moved, so the checks that matter are the ones GitHub is
      # about to create. Wait for the new head to appear, THEN for its checks
      # to settle. Treating "no checks reported yet" as green here would merge
      # a commit no CI has seen, so it counts as pending for the whole window.
      # Every read below must fail CLOSED. An API hiccup that returns an empty
      # string is "we do not know", and "we do not know" must never resolve to
      # a merge — so the new head is accepted only when it reads back as a real
      # 40-hex SHA that differs from the one we started with.
      NEW_SHA=""
      WAIT_UNTIL=$(( $(date -u +%s) + MERGE_UPDATE_WAIT_SECS ))
      while [ "$(date -u +%s)" -lt "$WAIT_UNTIL" ]; do
        CUR="$(gh pr view "$num" --json headRefOid --jq .headRefOid "${GH_ARGS[@]}" 2>/dev/null || true)"
        if printf '%s' "$CUR" | grep -qE '^[0-9a-f]{40}$' && [ "$CUR" != "$headsha" ]; then
          NEW_SHA="$CUR"; break
        fi
        sleep "$MERGE_UPDATE_POLL_SECS"
      done
      if [ -z "$NEW_SHA" ]; then
        refuse "update-branch returned success but no new head SHA could be read"; continue
      fi
      log "#$num head moved $headsha -> $NEW_SHA; waiting for fresh checks"

      SETTLED=0
      while [ "$(date -u +%s)" -lt "$WAIT_UNTIL" ]; do
        C="$(gh pr checks "$num" "${GH_ARGS[@]}" 2>&1)"
        if ! printf '%s' "$C" | grep -qiE 'no checks reported|no check runs|pending|queued|in_progress'; then
          SETTLED=1; break
        fi
        sleep "$MERGE_UPDATE_POLL_SECS"
      done
      if [ "$SETTLED" != "1" ]; then
        refuse "checks on the updated head did not settle within ${MERGE_UPDATE_WAIT_SECS}s — leaving for the next pass"
        continue
      fi

      # Re-read the state: an update-branch can surface a conflict that the
      # stale mergeable field did not show.
      RE="$(gh pr view "$num" --json mergeable,mergeStateStatus \
            --jq '.mergeable + " " + .mergeStateStatus' "${GH_ARGS[@]}" 2>/dev/null || true)"
      RE_M="${RE%% *}"; RE_S="${RE##* }"
      if [ -z "$RE_M" ] || [ -z "$RE_S" ] || [ "$RE_M" = "$RE_S" ]; then
        refuse "could not re-read mergeability after update-branch (got '$RE')"; continue
      fi
      RE_DECISION="$(state_decision "$RE_M" "$RE_S")"
      case "$RE_DECISION" in
        MERGE) log "#$num updated and ready ($RE)" ;;
        *)     refuse "after update-branch the PR is still not mergeable ($RE -> $RE_DECISION)"; continue ;;
      esac
      headsha="$NEW_SHA" ;;
    MERGE) : ;;
    *) refuse "unrecognised merge-state decision '$DECISION'"; continue ;;
  esac

  # ---- CI must be GREEN, not merely present -------------------------------
  # `gh pr checks` exits non-zero when anything is failing or pending, but we
  # also parse it: a PR with zero checks must never count as "green".
  CHECKS="$(gh pr checks "$num" "${GH_ARGS[@]}" 2>&1)"
  CHECKS_RC=$?
  if printf '%s' "$CHECKS" | grep -qiE 'no checks reported|no check runs'; then
    refuse "no CI checks reported — cannot call that green"; continue
  fi
  if [ "$CHECKS_RC" -ne 0 ]; then
    NOTPASS="$(printf '%s' "$CHECKS" | grep -viE '^\s*$' | grep -icE 'fail|pending|cancel|skipping|in_progress|queued' || true)"
    refuse "CI not green ($NOTPASS check(s) failing/pending)"; continue
  fi

  # ---- all conditions satisfied ------------------------------------------
  if [ "$DRY_RUN" = "1" ]; then
    printf 'WOULD MERGE #%-4s %-8s %s\n' "$num" "$tier" "$title"
    printf '            gh pr merge %s --squash --delete-branch\n' "$num"
    MERGED=$((MERGED+1))
    continue
  fi

  log "merging #$num ($tier): $title"
  if gh pr merge "$num" --squash --delete-branch "${GH_ARGS[@]}" >/dev/null 2>&1; then
    printf 'MERGED #%-4s %-8s %s\n' "$num" "$tier" "$title"
    MERGED=$((MERGED+1))
    printf '%s\tmerged\t#%s\t%s\t%s\n' "$(ts)" "$num" "$headsha" "$title" >> "$MERGE_LOG"
  else
    refuse "gh pr merge failed"
  fi
done <<< "$ROWS"

printf '\n%s: %s merged, %s refused.\n\n' \
  "$([ "$DRY_RUN" = 1 ] && echo 'Dry run' || echo 'Merge pass')" "$MERGED" "$REFUSED"
exit 0
