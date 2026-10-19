#!/usr/bin/env bash
# factory/bootstrap-labels.sh — create the label vocabulary the factory needs.
#
#   ./factory/bootstrap-labels.sh --dry-run   # show what is missing
#   ./factory/bootstrap-labels.sh             # create the missing labels
#
# Idempotent: existing labels are left exactly as they are (no colour or
# description churn). NOT run automatically — creating labels mutates shared
# repo state, so it is an explicit operator step before Stage 1.
#
# The factory reads no state except these labels, so this vocabulary IS the
# control surface. Descriptions are written for humans who will be reading them
# in the GitHub UI at 2am.

set -uo pipefail

FACTORY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/common.sh
. "$FACTORY_DIR/lib/common.sh"

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
have_gh || die "gh CLI required"

GH_ARGS=()
mapfile -t GH_ARGS < <(gh_repo_args)

# name|colour|description
LABELS=(
  "ready|0e8a16|Factory may pick this up. Removing this label is the per-issue off switch."
  "tier:T0|b60205|NEVER autonomous. Consensus/economic core: emissions, escrow, supply cap."
  "tier:T1|d93f0b|NEVER autonomous. Runtime or pallet logic needing human judgement."
  "tier:T2|fbca04|Autonomous work + review; merge stays manual until MERGE_T2 is enabled."
  "tier:T3|0e8a16|Lowest risk. Autonomous work, review, and (once protected) auto-merge."
  "blocked|000000|Factory skips this issue. Human says not yet."
  "in-progress|1d76db|A factory worker owns this right now. Set at dispatch, cleared on finish."
  "agent-reviewed|5319e7|Passed >=2/3 fresh-context adversarial review lenses."
  "needs-human|e99695|A review lens objected, or a loop blocked. Human attention required."
)

EXISTING="$(gh label list --limit 200 --json name --jq '.[].name' "${GH_ARGS[@]}" 2>/dev/null || true)"

CREATED=0
SKIPPED=0
for spec in "${LABELS[@]}"; do
  IFS='|' read -r name colour desc <<< "$spec"
  if printf '%s\n' "$EXISTING" | grep -qxF "$name"; then
    printf 'exists  %s\n' "$name"; SKIPPED=$((SKIPPED+1)); continue
  fi
  if [ "$DRY" = "1" ]; then
    printf 'WOULD CREATE  %-16s #%s  %s\n' "$name" "$colour" "$desc"
  else
    if gh label create "$name" --color "$colour" --description "$desc" "${GH_ARGS[@]}" >/dev/null 2>&1; then
      printf 'created %s\n' "$name"
    else
      warn "could not create label $name"
      continue
    fi
  fi
  CREATED=$((CREATED+1))
done

printf '\n%s: %s to create, %s already present.\n' \
  "$([ "$DRY" = 1 ] && echo 'Dry run' || echo 'Done')" "$CREATED" "$SKIPPED"

# cluster:<name> labels are created ad hoc by whoever groups the issues; the
# dispatcher reads any label with the cluster: prefix, so no fixed list exists.
printf 'Note: cluster:<name> labels are created as needed; any cluster: prefix works.\n'
