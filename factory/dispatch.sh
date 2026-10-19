#!/usr/bin/env bash
# factory/dispatch.sh — the issue-driven dispatcher (STAGE 2 component).
#
# OFF BY DEFAULT. Refuses to do anything mutating unless ENABLE_DISPATCH=true
# in factory/config.env. `--dry-run` always works and never mutates anything.
#
#   ./factory/dispatch.sh --dry-run    # print the plan, touch nothing
#   ./factory/dispatch.sh              # execute (needs ENABLE_DISPATCH=true)
#
# ------------------------------------------------------------------ LABELS ---
# The label set IS the work queue. Conventions, all required:
#
#   ready          Candidate for autonomous work. Nothing is dispatched without
#                  it. Removing it is the per-issue off switch.
#   tier:T3        Lowest risk. Auto-dispatch, auto-review, auto-merge eligible.
#   tier:T2        Medium risk. Auto-dispatch + auto-review; merge stays manual
#                  until MERGE_T2=true AND branch protection exists.
#   tier:T0/T1     NEVER dispatched autonomously. Consensus-critical or
#                  economic code (emissions, escrow, runtime, supply cap).
#                  Skipped with an explicit log line every single pass.
#   cluster:<name> Issues sharing a cluster touch overlapping code. At most ONE
#                  cluster member runs at a time; enforced with a real flock,
#                  not just scheduling order, so a stale process cannot double up.
#   blocked        Skip. Human says not yet.
#   in-progress    Skip. A worker already owns it. Set at dispatch, cleared on
#                  finish, so a crashed run cannot silently re-dispatch.
#
# ------------------------------------------------------------------- GATES ---
# The gate decides success, never the agent's self-report.
#   T3: build + lint + test of the touched subproject, auto-detected from the
#       diff (see detect_gate). Narrow diff => fast, precise gate.
#   T2: cargo check --workspace && cargo test --workspace --no-run (minimum).
# Unknown or mixed diffs fall back to the T2 workspace gate: when in doubt the
# broader gate is the safe one.

set -uo pipefail

FACTORY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/common.sh
. "$FACTORY_DIR/lib/common.sh"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/worktree.sh
. "$FACTORY_DIR/lib/worktree.sh"

: "${ENABLE_DISPATCH:=false}"
: "${DISPATCH_TIERS:=tier:T3}"

DRY_RUN=0
LIMIT_ISSUE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run|-n) DRY_RUN=1 ;;
    --issue)      LIMIT_ISSUE="${2:-}"; shift ;;
    -h|--help)
      sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

# ---------------------------------------------------------------- preflight --
preflight() {
  if stop_requested; then
    log "STOP_FACTORY present — dispatcher exiting without dispatching."
    exit 0
  fi
  if ! disk_ok; then
    warn "free disk $(free_disk_gb)GB < ${MIN_FREE_DISK_GB}GB — refusing to dispatch new work."
    note_state "disk guard tripped: $(free_disk_gb)GB free, need ${MIN_FREE_DISK_GB}GB"
    exit 0
  fi
  if backoff_active; then
    warn "rate-limit back-off active ($(backoff_remaining)s remaining) — not dispatching."
    exit 0
  fi
  if [ "$DRY_RUN" != "1" ] && [ "$ENABLE_DISPATCH" != "true" ]; then
    cat >&2 <<EOF
dispatch.sh is DISABLED (ENABLE_DISPATCH=$ENABLE_DISPATCH).

This is Stage 2 machinery and ships off on purpose. To turn it on:
  1. Confirm Stage 1 preconditions (chain builds, CI armed) — see factory/README.md
  2. Create the label vocabulary:  ./factory/bootstrap-labels.sh
  3. Set ENABLE_DISPATCH=true in factory/config.env

Meanwhile: ./factory/dispatch.sh --dry-run shows exactly what it would do.
EOF
    exit 1
  fi
  have_gh || die "gh CLI not found; dispatcher needs it"
}

note_state() { printf '%s  %s\n' "$(ts)" "$*" >> "$FACTORY_DIR/logs/dispatch-notes.log"; }

# ------------------------------------------------------------ issue fetching --
# FACTORY_ISSUE_FIXTURE is a TEST-ONLY escape hatch: point it at a JSON file
# shaped like `gh issue list --json number,title,labels,body` to exercise the
# label logic without touching GitHub. Used by factory/tests/dispatch-dryrun.sh.
fetch_issues() {
  if [ -n "${FACTORY_ISSUE_FIXTURE:-}" ]; then
    warn "using issue FIXTURE ${FACTORY_ISSUE_FIXTURE} (test mode, no GitHub calls)"
    cat "$FACTORY_ISSUE_FIXTURE"
    return
  fi
  local args=()
  mapfile -t args < <(gh_repo_args)
  gh issue list --label ready --state open --limit 100 \
     --json number,title,labels,body "${args[@]}" 2>/dev/null || echo '[]'
}

# Emit one row per issue: number, tier, cluster, flags, title.
# Delimiter is ASCII Unit Separator (0x1f), NOT tab: tab counts as IFS
# whitespace, so `read` collapses runs of tabs and an absent field (e.g. no
# cluster label) would shift every later column left — which silently broke the
# blocked/in-progress/needs-human skip rules.
parse_issues() {
  python3 -c '
import json,sys
try:
    issues = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for it in issues:
    labels = {l["name"] for l in it.get("labels") or []}
    tier = next((l for l in sorted(labels) if l.startswith("tier:")), "")
    cluster = next((l[len("cluster:"):] for l in sorted(labels) if l.startswith("cluster:")), "")
    flags = ",".join(sorted(l for l in labels if l in
                            ("blocked","in-progress","needs-human","ready")))
    title = (it.get("title") or "").replace("\t"," ").strip()
    print("\x1f".join([str(it["number"]), tier, cluster, flags, title]))
'
}

issue_body() {
  local n="$1" args=()
  if [ -n "${FACTORY_ISSUE_FIXTURE:-}" ]; then
    python3 -c '
import json,sys
n=sys.argv[1]
for it in json.load(open(sys.argv[2])):
    if str(it["number"])==n:
        print(it.get("body") or "")
' "$n" "$FACTORY_ISSUE_FIXTURE"
    return
  fi
  mapfile -t args < <(gh_repo_args)
  gh issue view "$n" --json body --jq .body "${args[@]}" 2>/dev/null
}

# ------------------------------------------------------------------- gates ---
# T2 minimum: the workspace must at least compile and its tests must at least
# build. Run under the cargo flock so parallel workers never race the cache.
# Single-quoted rather than %q-escaped: this string is echoed into logs, BLOCKED
# reports, and PR bodies, and "cargo\ check\ --workspace" is hostile to read.
# The inner command contains no single quotes, so quoting is safe here.
t2_gate() {
  printf "flock %s bash -c 'cargo check --workspace && cargo test --workspace --no-run'" \
    "$(printf '%q' "$CARGO_LOCKFILE")"
}

# T3: detect the touched subproject from the diff and use ITS commands, read
# out of package.json / Cargo.toml rather than hardcoded. Falls back to the T2
# workspace gate for mixed or unrecognised diffs.
detect_gate() {
  local wt="$1" changed sub
  changed="$(git -C "$wt" diff --name-only "$(git -C "$wt" merge-base HEAD "origin/$BASE_BRANCH" 2>/dev/null || echo HEAD)" 2>/dev/null)"
  [ -n "$changed" ] || changed="$(git -C "$wt" status --porcelain | awk '{print $2}')"

  # Which top-level subprojects does this diff touch?
  sub="$(printf '%s\n' "$changed" | awk -F/ 'NF>1{print $1}' | sort -u | tr '\n' ' ' | sed 's/ *$//')"

  case "$sub" in
    indexer)  node_gate "$wt/indexer"  "indexer"  && return 0 ;;
    sdk)      node_gate "$wt/sdk"      "sdk"      && return 0 ;;
    frontend) node_gate "$wt/frontend" "frontend" && return 0 ;;
    explorer) node_gate "$wt/explorer" "explorer" && return 0 ;;
  esac

  # Rust-only subprojects, or anything else: use the workspace gate.
  t2_gate
}

# Build a build+lint+test command for a Node/Python subproject by READING its
# manifest, so the gate matches what the subproject actually defines.
node_gate() {
  local dir="$1" name="$2" cmds=()
  if [ -f "$dir/package.json" ]; then
    local scripts
    scripts="$(python3 -c '
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: sys.exit(0)
print(" ".join((d.get("scripts") or {}).keys()))
' "$dir/package.json" 2>/dev/null)"
    case " $scripts " in *" build "*) cmds+=("npm run build") ;; esac
    case " $scripts " in
      *" lint "*)      cmds+=("npm run lint") ;;
      *" typecheck "*) cmds+=("npm run typecheck") ;;
    esac
    case " $scripts " in
      *" test "*) cmds+=("npm test") ;;
      *) return 1 ;;   # no test script => cannot form an honest gate
    esac
    printf 'cd %s && npm ci --no-audit --no-fund && %s' \
      "$(printf '%q' "$name")" "$(IFS=' && '; echo "${cmds[*]}")"
    return 0
  fi
  # Python subproject (indexer/ is python today: reconcile.py, no package.json).
  if compgen -G "$dir/*.py" >/dev/null 2>&1; then
    printf 'cd %s && python3 -m pytest -q' "$(printf '%q' "$name")"
    return 0
  fi
  return 1
}

# ---------------------------------------------------- gate from issue body ---
# THE GATE MUST COME FROM THE ISSUE, NOT FROM THE WORKTREE.
#
# detect_gate() infers a gate from the files a diff touches. That is useless at
# dispatch time, because the worktree is a pristine copy of master and the diff
# is EMPTY: every issue fell through to the workspace cargo gate, which is
# already green on master. loop.sh then short-circuits ("gate already passes
# before any attempt — nothing to do. PASS") and the issue is reported done with
# zero work performed. That was F-1 in STAGE1-SETUP.md.
#
# So the gate is read from the issue body, where a human wrote it deliberately:
# the first fenced code block under a "## Gate" heading.
gate_from_issue() {
  local num="$1"
  issue_body "$num" | python3 -c '
import re, subprocess, sys

body = sys.stdin.read()
lines = body.splitlines()

# Find a "## Gate ..." heading, then the first fenced block after it.
start = None
for i, ln in enumerate(lines):
    if re.match(r"^#{1,6}\s+gate\b", ln.strip(), re.I):
        start = i
        break
if start is None:
    sys.exit(1)

fence = None
block = []
for ln in lines[start + 1:]:
    stripped = ln.strip()
    if fence is None:
        # Another heading before any fence => no gate block under this heading.
        if re.match(r"^#{1,6}\s", stripped):
            sys.exit(1)
        m = re.match(r"^(`{3,}|~{3,})", stripped)
        if m:
            fence = m.group(1)[0]
        continue
    if re.match(r"^(`{3,}|~{3,})", stripped):
        break
    block.append(ln)

# Physical lines in a fence are NOT independent commands.
#
# F-05: this used to be `" && ".join(line.strip() for line in block)`, which
# broke any gate written with shell line-continuations:
#
#     cd landing && ! sed -n '...' src/content.mjs | grep -qE '...' \\
#       && npm ci && npm test
#
# Two defects compounded. The trailing backslash was kept, but mid-line it
# escapes a space instead of joining lines; and " && " was inserted before a
# line that already opened with "&&". Result: `... \\ && && npm ci ...`, a bash
# syntax error. The gate could never go green whatever the agent did, so
# issues #104 and #105 burned all three attempts and blocked. Join
# continuations FIRST, before any chaining decision.
logical = []
for ln in block:
    stripped_line = ln.strip()
    if logical and logical[-1].endswith("\\"):
        logical[-1] = logical[-1][:-1].rstrip() + " " + stripped_line
    else:
        logical.append(stripped_line)

cmds = [l for l in logical if l and not l.startswith("#")]
if not cmds:
    sys.exit(1)

# Every remaining logical line must pass, so chain with &&. But a line that
# already opens with a shell operator is a continuation of the command before
# it — appending " && " there is what produced the `&& &&` above.
gate = cmds[0]
for c in cmds[1:]:
    if re.match(r"^(&&|\|\||\||;|&)", c):
        gate += " " + c
    else:
        gate += " && " + c

# Reject prose. A gate that is not runnable is worse than no gate: bash would
# fail on it for the wrong reason and the agent would burn every attempt trying
# to satisfy a sentence. Require the first word to be an actual command.
#
# The allowlist covers the assertion commands real gates open with. `test -f`
# (#103) and `shellcheck` (#102) were absent, so those gates were rejected
# outright and the issue refused for a reason no worker could act on.
first = gate.split()[0].lstrip("$").strip()
RUNNABLE = ("cd", "npm", "npx", "yarn", "pnpm", "cargo", "python", "python3",
            "pytest", "make", "just", "bash", "sh", "flock", "docker", "node",
            "test", "[", "shellcheck", "systemd-analyze", "grep", "sed", "awk",
            "git", "curl", "jq", "diff", "find")
if not (first in RUNNABLE or first.startswith("./") or first.startswith("/")):
    sys.exit(2)

# Belt and braces: hand bash nothing bash cannot parse. `bash -n` reads syntax
# without executing, so this is free and side-effect-free. This is what would
# have caught F-05 at dispatch time instead of three attempts later.
if subprocess.run(["bash", "-n", "-c", gate],
                  capture_output=True).returncode != 0:
    sys.exit(3)

print(gate)
'
}

# tier -> gate. The issue body wins; detect_gate is the fallback for issues that
# predate the convention.
gate_for_tier() {
  local tier="$1" wt="$2" num="${3:-}" gate=""

  if [ -n "$num" ]; then
    gate="$(gate_from_issue "$num" 2>/dev/null)"
    if [ -n "$gate" ]; then
      printf '%s' "$gate"
      return 0
    fi
  fi

  case "$tier" in
    tier:T3)
      # No GATE block. detect_gate may still find a real subproject gate from a
      # non-empty diff — but if it falls through to the workspace cargo gate for
      # a T3 task, that is the F-1 trap again: already green, so it would pass
      # without work. Refuse instead, and say why.
      gate="$(detect_gate "$wt")"
      if [ "$gate" = "$(t2_gate)" ]; then
        return 1
      fi
      printf '%s' "$gate" ;;
    tier:T2) t2_gate ;;
    *)       t2_gate ;;
  esac
}

# ------------------------------------------------------------------ prompts ---
# The preamble is not decoration: it is the contract the worker is held to, and
# it names the gate so the agent knows exactly what "done" means. It also warns
# about the hook, so the agent does not waste attempts discovering it.
build_prompt() {
  local num="$1" tier="$2" gate="$3" body="$4" out="$5"
  cat > "$out" <<EOF
You are an autonomous worker in a bounded factory loop on the Scalar Commons
repository. You are working on GitHub issue #${num} (${tier}).

################  ABSOLUTE RULE — NON-NEGOTIABLE  ################
NEVER make a check pass by weakening code. Specifically forbidden:
  - deleting, skipping, or commenting out tests
  - weakening an assertion so it can no longer fail
  - stubbing an implementation with todo!(), unimplemented!(), or an empty body
  - adding #[allow(...)] to silence a lint instead of fixing it
  - setting SKIP_WASM_BUILD or otherwise disabling the runtime build
  - relaxing the gate command itself
A PostToolUse hook mechanically rejects these patterns at write time, and a
fresh-context adversarial reviewer looks for them again in the diff afterwards.
Both are cheaper to satisfy honestly than to fight. If the task cannot be done
without one of the above, STOP and explain why in your final message — being
blocked is an acceptable, expected outcome. Faking completion is not.
###################################################################

THE GATE (the only definition of success):

    ${gate}

Your work is judged by that command's exit code, not by your own summary. It
will be run after you stop, in this directory. Run it yourself before
finishing. If it fails, keep working.

REPOSITORY RULES (from CLAUDE.md — these still bind you):
  - Balance arithmetic uses saturating_*/checked_* only; never bare + - *.
  - Guards (ensure!) fire before any funds move.
  - construct_runtime pallet indices are append-only; never renumber or reuse.
  - Every new Config type must be added to EVERY test mock, including
    tests/common.rs. BlockNumber constants use ConstU64, not ConstU32.
  - Storage layout changes need a migration plus a spec_version bump.
  - Rust doc comments on every pallet/extrinsic/storage item, explaining the
    economic *why*.
  - Write the failing test FIRST, then implement until the gate is green.

SCOPE DISCIPLINE: implement exactly what the issue asks. No opportunistic
refactors, no drive-by renames, no unrelated files. A reviewer will explicitly
check the diff for scope creep and fail it.

Commit your work with git (small, scoped commits; reference the pallet or
component in the message). Do not push, do not open a PR, do not touch git
remotes — the factory does that after the gate passes.

################  ISSUE #${num} BODY  ################
${body}
######################################################
EOF
}

# ------------------------------------------------------------------ worker ---
# One issue, start to finish. Runs in a background subshell; cluster-mates
# serialize on a real flock so overlapping code is never edited concurrently.
run_worker() {
  local num="$1" tier="$2" cluster="$3" title="$4"
  local wt gate prompt rc branch
  local id="$num"

  if [ -n "$cluster" ]; then
    local clock="$RUN_DIR/cluster-$cluster.lock"
    exec 9>"$clock"
    log "#$num waiting for cluster lock '$cluster' …"
    flock 9 || { warn "#$num could not take cluster lock"; return 1; }
    log "#$num holds cluster lock '$cluster'"
  fi

  stop_requested && { log "#$num aborting: STOP_FACTORY"; return 1; }

  wt="$(new_worktree "$id")" || { warn "#$num worktree failed"; return 1; }

  if ! gate="$(gate_for_tier "$tier" "$wt" "$num")" || [ -z "$gate" ]; then
    warn "#$num NO USABLE GATE — refusing to dispatch"
    warn "#$num add a '## Gate' heading with a fenced, runnable command to the issue body"
    comment_issue "$num" "Factory refused to dispatch: no usable gate. The issue body needs a \`## Gate\` heading followed by a fenced code block containing the exact command that proves the work done. Falling back to the workspace gate is not allowed for tier:T3 — it is already green on master, so it would report success without any work being performed."
    return 1
  fi

  prompt="$wt/.factory-prompt.md"
  build_prompt "$num" "$tier" "$gate" "$(issue_body "$num")" "$prompt"

  # Reserve budget BEFORE the loop starts. loop.sh reserves again per attempt,
  # so a worker that grinds through 10 attempts is charged 10, not 1.
  if ! spend_reserve "dispatch:issue-$num"; then
    warn "#$num $(spend_refusal "worker for issue #$num" | tr '\n' ' ')"
    return 1   # not yet marked in-progress, so nothing to unwind
  fi

  mark_in_progress "$num"

  log "#$num dispatching loop (tier=$tier cluster=${cluster:-none})"
  log "#$num gate: $gate"
  "$FACTORY_DIR/lib/loop.sh" "issue-$num" "$wt" "$prompt" "$gate" \
      "$DEFAULT_MAX_ATTEMPTS" "$DEFAULT_MAX_MINUTES"
  rc=$?

  if [ "$rc" -ne 0 ]; then
    warn "#$num BLOCKED (loop rc=$rc) — leaving worktree $wt for inspection"
    unmark_in_progress "$num"
    comment_issue "$num" "Factory loop did **not** pass its gate; issue left open and \`in-progress\` cleared. See \`factory/blocked/BLOCKED-issue-${num}.md\`. Gate was: \`${gate}\`"
    return 1
  fi

  # Gate passed. Publish the branch and open the PR.
  branch="task/$num"
  log "#$num gate PASSED — pushing $branch"
  if ! git -C "$wt" push -u origin "HEAD:refs/heads/$branch" 2>&1; then
    warn "#$num push failed"
    unmark_in_progress "$num"
    return 1
  fi
  open_pr "$num" "$branch" "$title" "$gate" "$wt"
  unmark_in_progress "$num"
}

mark_in_progress()   { local a=(); mapfile -t a < <(gh_repo_args); gh issue edit "$1" --add-label in-progress    "${a[@]}" >/dev/null 2>&1 || warn "could not add in-progress to #$1"; }
unmark_in_progress() { local a=(); mapfile -t a < <(gh_repo_args); gh issue edit "$1" --remove-label in-progress "${a[@]}" >/dev/null 2>&1 || true; }
comment_issue()      { local a=(); mapfile -t a < <(gh_repo_args); gh issue comment "$1" --body "$2" "${a[@]}" >/dev/null 2>&1 || true; }

open_pr() {
  local num="$1" branch="$2" title="$3" gate="$4" wt="$5" url a=()
  mapfile -t a < <(gh_repo_args)
  local body
  body="$(cat <<EOF
Closes #${num}

Autonomous factory PR. Gate that had to pass before this branch was published:

\`\`\`
${gate}
\`\`\`

- Worker: \`factory/lib/loop.sh\` (bounded: ${DEFAULT_MAX_ATTEMPTS} attempts / ${DEFAULT_MAX_MINUTES} min)
- Base: \`${BASE_BRANCH}\`
- Standing rule enforced at write time by \`.claude/hooks-factory/reject-stubs.sh\`

Awaiting fresh-context adversarial review (\`factory/review.sh\`). Not merged by
the worker: \`factory/merge.sh\` is the only component permitted to merge, and
only for reviewed T3 PRs with green CI.
EOF
)"
  url="$(gh pr create --head "$branch" --base "$BASE_BRANCH" \
          --title "[factory] ${title} (#${num})" --body "$body" "${a[@]}" 2>&1)" \
    || { warn "#$num gh pr create failed: $url"; return 1; }
  log "#$num PR opened: $url"

  local prnum
  prnum="$(printf '%s' "$url" | grep -oE '[0-9]+$' | tail -1)"
  if [ -n "$prnum" ]; then
    log "#$num running fresh-context review on PR #$prnum"
    "$FACTORY_DIR/review.sh" "$prnum" || warn "#$num review.sh reported problems on PR #$prnum"
  else
    warn "#$num could not parse PR number from: $url"
  fi
}

# -------------------------------------------------------------------- main ---
# Sourcing with DISPATCH_LIB_ONLY=1 loads the functions without running a pass,
# so the gate-detection logic can be unit-tested (factory/tests/gate-detect.sh).
if [ "${DISPATCH_LIB_ONLY:-0}" = "1" ]; then
  # `return` succeeds when sourced; the exit is the fallback for direct
  # execution. shellcheck cannot see that both paths are live.
  # shellcheck disable=SC2317
  return 0 2>/dev/null || exit 0
fi

preflight

RAW="$(fetch_issues)"
ROWS="$(printf '%s' "$RAW" | parse_issues)"

MAXP="$(effective_parallel)"
if is_night; then WINDOW="night (heavy parallelism)"; else WINDOW="day (throttled to keep the box interactive)"; fi

printf '\n=== factory dispatch %s ===\n' "$(ts)"
printf 'mode:        %s\n' "$([ "$DRY_RUN" = 1 ] && echo 'DRY RUN (no mutations)' || echo EXECUTE)"
printf 'window:      %s, MAX_PARALLEL=%s\n' "$WINDOW" "$MAXP"
printf 'base branch: %s\n' "$BASE_BRANCH"
printf 'free disk:   %sGB (min %sGB)\n' "$(free_disk_gb)" "$MIN_FREE_DISK_GB"
printf 'spawn budget: %s/%s used today (%s remaining) — %s\n\n' \
  "$(spend_count)" "$DAILY_SPAWN_CAP" "$(spend_remaining)" "$(spend_ledger)"

if [ -z "$ROWS" ]; then
  printf 'No open issues carry the "ready" label. Nothing to dispatch.\n'
  printf 'To queue work: gh issue edit <n> --add-label ready --add-label tier:T3\n\n'
  exit 0
fi

DISPATCHED=0
declare -A CLUSTER_SEEN=()
PIDS=()

while IFS=$'\x1f' read -r num tier cluster flags title; do
  [ -n "$num" ] || continue
  if [ -n "$LIMIT_ISSUE" ] && [ "$num" != "$LIMIT_ISSUE" ]; then continue; fi

  # ---- skip rules, each with an explicit, auditable log line --------------
  case ",$flags," in
    *,blocked,*)     printf 'SKIP  #%-4s %-8s blocked label present — human says not yet\n'  "$num" "$tier"; continue ;;
    *,in-progress,*) printf 'SKIP  #%-4s %-8s in-progress — a worker already owns it\n'       "$num" "$tier"; continue ;;
    *,needs-human,*) printf 'SKIP  #%-4s %-8s needs-human — review escalated it\n'            "$num" "$tier"; continue ;;
  esac

  case "$tier" in
    tier:T3|tier:T2)
      # Hard rule above says T3/T2 *may* be dispatched; DISPATCH_TIERS says
      # which of them this stage actually dispatches. The allowlist can only
      # narrow, never widen: T0/T1 fall through to the refusal below no matter
      # what DISPATCH_TIERS contains.
      case " $DISPATCH_TIERS " in
        *" $tier "*) : ;;
        *) printf 'SKIP  #%-4s %-8s not in DISPATCH_TIERS="%s" — out of scope for this stage\n' \
             "$num" "$tier" "$DISPATCH_TIERS"; continue ;;
      esac ;;
    tier:T0|tier:T1)
      printf 'SKIP  #%-4s %-8s TIER TOO RISKY for autonomy — never dispatched (consensus/economic code)\n' "$num" "$tier"
      continue ;;
    '')
      printf 'SKIP  #%-4s %-8s no tier: label — refusing to guess the risk level\n' "$num" "(none)"
      continue ;;
    *)
      printf 'SKIP  #%-4s %-8s unrecognised tier label\n' "$num" "$tier"
      continue ;;
  esac

  if [ -n "$cluster" ] && [ -n "${CLUSTER_SEEN[$cluster]:-}" ]; then
    printf 'DEFER #%-4s %-8s cluster:%s already has #%s running — serialized, not parallel\n' \
      "$num" "$tier" "$cluster" "${CLUSTER_SEEN[$cluster]}"
    continue
  fi

  if [ "$DISPATCHED" -ge "$MAXP" ]; then
    printf 'DEFER #%-4s %-8s MAX_PARALLEL=%s reached this pass\n' "$num" "$tier" "$MAXP"
    continue
  fi

  # ---- dispatch ----------------------------------------------------------
  [ -n "$cluster" ] && CLUSTER_SEEN[$cluster]="$num"
  DISPATCHED=$((DISPATCHED+1))

  if [ "$DRY_RUN" = "1" ]; then
    printf 'DISPATCH #%-3s %-8s cluster=%-10s %s\n' "$num" "$tier" "${cluster:-none}" "$title"
    printf '        WOULD: create worktree ../wt-%s from origin/%s\n' "$num" "$BASE_BRANCH"
    printf '        WOULD: add label in-progress to #%s\n' "$num"
    if DRY_GATE="$(gate_for_tier "$tier" "$REPO_DIR" "$num")" && [ -n "$DRY_GATE" ]; then
      printf '        WOULD: gate = %s\n' "$DRY_GATE"
      printf '        WOULD: gate source = %s\n' \
        "$(gate_from_issue "$num" >/dev/null 2>&1 && echo 'issue body (## Gate block)' || echo 'detect_gate fallback')"
    else
      printf '        WOULD: REFUSE — no usable gate in the issue body, and the\n'
      printf '               detect_gate fallback is the already-green workspace gate\n'
    fi
    printf '        WOULD: run loop.sh issue-%s (caps: %s attempts / %s min)\n' "$num" "$DEFAULT_MAX_ATTEMPTS" "$DEFAULT_MAX_MINUTES"
    printf '        WOULD: on gate PASS -> push task/%s, gh pr create (Closes #%s), then review.sh\n' "$num" "$num"
    printf '        WOULD: on gate FAIL -> write BLOCKED-issue-%s.md, clear in-progress, comment on the issue\n' "$num"
    printf '        WOULD: NOT merge (merge.sh is the only merger, and it is off)\n'
    continue
  fi

  run_worker "$num" "$tier" "$cluster" "$title" &
  PIDS+=($!)
  log "dispatched #$num as pid ${PIDS[-1]}"
done <<< "$ROWS"

if [ "$DRY_RUN" = "1" ]; then
  printf '\nDry run complete: %s issue(s) would be dispatched, 0 mutations performed.\n\n' "$DISPATCHED"
  exit 0
fi

log "waiting on ${#PIDS[@]} worker(s)…"
FAILED=0
for p in "${PIDS[@]}"; do wait "$p" || FAILED=$((FAILED+1)); done
log "dispatch pass complete: ${#PIDS[@]} worker(s), $FAILED did not pass their gate"
"$FACTORY_DIR/tracker.sh" --quiet 2>/dev/null || true
exit 0
