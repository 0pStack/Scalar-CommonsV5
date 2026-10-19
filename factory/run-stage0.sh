#!/usr/bin/env bash
# factory/run-stage0.sh — launch the four Stage-0 named loops in tmux.
#
#   ./factory/run-stage0.sh [--dry-run] [--only <name>]
#
# STAGE 0 is the conservative starting configuration: only these four named
# loops run. No dispatcher, no auto-merge, no autonomous issue triage. Each loop
# works in its OWN GIT WORKTREE, so four agents editing four components cannot
# corrupt each other's diffs, and none of them touches your checkout.
#
# One tmux window per loop in session "loops", so you can attach and watch:
#   tmux attach -t loops        (then ctrl-b n / ctrl-b w to move around)
#
# Each loop is bounded by loop.sh: DEFAULT_MAX_ATTEMPTS attempts and
# DEFAULT_MAX_MINUTES wall clock, gate-decided, kill-switch aware.
#
# Loops run concurrently, but every cargo invocation serializes behind one
# flock (see lib/worktree.sh) so the shared target dir is never raced. Three of
# these four gates are npm/pytest, so contention is low in practice.

set -uo pipefail

FACTORY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/common.sh
. "$FACTORY_DIR/lib/common.sh"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/worktree.sh
. "$FACTORY_DIR/lib/worktree.sh"

SESSION=loops
DRY=0
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run|-n) DRY=1 ;;
    --only)       ONLY="${2:-}"; shift ;;
    -h|--help)    sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

# name | prompt file | gate command
# Gates are the per-component test suites the prompts require the agent to
# create. Rust-touching gates would be wrapped with gate_locked; none here are.
TASKS=(
  "trackB-indexer|trackB-indexer.prompt|cd indexer && npm ci --no-audit --no-fund && npm test"
  "trackB-sdk|trackB-sdk.prompt|cd sdk && npm ci --no-audit --no-fund && npm run typecheck && npm test"
  "trackB-explorer|trackB-explorer.prompt|cd explorer && npm ci --no-audit --no-fund && npm run build && npm test"
  "trackC-od4|trackC-od4.prompt|python3 -m pytest experiments/sc-e1/tests -q"
)

if stop_requested; then
  die "STOP_FACTORY exists ($STOP_FILE). Remove it before starting Stage 0."
fi
if ! disk_ok; then
  die "only $(free_disk_gb)GB free, need ${MIN_FREE_DISK_GB}GB. Not starting."
fi
command -v tmux >/dev/null || die "tmux not installed"

# Billing must be provable before we start anything: no key, no loops.
if [ ! -f "$HOME/.factory/env" ]; then
  die "missing $HOME/.factory/env — loops must bill the API key, not the Max login.
Create it:  printf 'export ANTHROPIC_API_KEY=sk-ant-…\\n' > ~/.factory/env && chmod 600 ~/.factory/env"
fi
# shellcheck source=/dev/null
if ! grep -q 'ANTHROPIC_API_KEY=..' "$HOME/.factory/env"; then
  die "$HOME/.factory/env does not define a non-empty ANTHROPIC_API_KEY"
fi

printf '\n=== Stage 0 launch %s ===\n' "$(ts)"
printf 'session:   %s\n' "$SESSION"
printf 'caps:      %s attempts / %s minutes per loop\n' "$DEFAULT_MAX_ATTEMPTS" "$DEFAULT_MAX_MINUTES"
printf 'window:    %s\n' "$(is_night && echo 'night (heavy parallelism OK)' || echo 'day (loops still allowed; dispatcher would throttle)')"
printf 'base:      %s\n' "$BASE_BRANCH"
printf 'cargo dir: %s (shared, flock-serialized)\n\n' "$SHARED_CARGO_TARGET"

if [ "$DRY" != "1" ] && tmux has-session -t "$SESSION" 2>/dev/null; then
  warn "tmux session '$SESSION' already exists."
  warn "Attach with: tmux attach -t $SESSION   (or kill it: tmux kill-session -t $SESSION)"
  exit 1
fi

STARTED=0
for spec in "${TASKS[@]}"; do
  IFS='|' read -r name promptfile gate <<< "$spec"
  [ -z "$ONLY" ] || [ "$ONLY" = "$name" ] || continue

  prompt="$FACTORY_DIR/tasks/$promptfile"
  [ -f "$prompt" ] || { warn "missing prompt $prompt — skipping $name"; continue; }

  if [ "$DRY" = "1" ]; then
    printf 'WOULD START %s\n' "$name"
    printf '        worktree: %s\n' "$(wt_path "$name")"
    printf '        prompt:   %s (%s lines)\n' "$prompt" "$(wc -l < "$prompt")"
    printf '        gate:     %s\n' "$gate"
    printf '        log:      factory/logs/%s-%s.log\n\n' "$name" "$(date -u +%Y%m%d)"
    STARTED=$((STARTED+1))
    continue
  fi

  wt="$(new_worktree "$name")" || { warn "could not create worktree for $name"; continue; }

  # Each loop gets its own window; the shell stays open after exit so a BLOCKED
  # run leaves its output on screen instead of vanishing.
  cmd="$(printf '%q %q %q %q %q %q %q; echo; echo "[loop %s exited rc=$?]"; exec bash' \
    "$FACTORY_DIR/lib/loop.sh" "$name" "$wt" "$prompt" "$gate" \
    "$DEFAULT_MAX_ATTEMPTS" "$DEFAULT_MAX_MINUTES" "$name")"

  if [ "$STARTED" -eq 0 ]; then
    tmux new-session -d -s "$SESSION" -n "$name" "bash -lc $(printf '%q' "$cmd")"
  else
    tmux new-window -t "$SESSION" -n "$name" "bash -lc $(printf '%q' "$cmd")"
  fi
  log "started $name in tmux window (worktree $wt)"
  log "  gate: $gate"
  STARTED=$((STARTED+1))
done

if [ "$DRY" = "1" ]; then
  printf 'Dry run: %s loop(s) would start. Nothing was created.\n\n' "$STARTED"
  exit 0
fi

[ "$STARTED" -gt 0 ] || die "no loops started"

printf '\nStarted %s loop(s) in tmux session "%s".\n\n' "$STARTED" "$SESSION"
printf '  watch:   tmux attach -t %s\n' "$SESSION"
printf '  logs:    tail -f factory/logs/*-%s.log\n' "$(date -u +%Y%m%d)"
printf '  state:   ./factory/tracker.sh\n'
printf '  STOP:    touch %s\n\n' "$STOP_FILE"
