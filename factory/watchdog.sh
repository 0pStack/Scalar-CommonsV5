#!/usr/bin/env bash
# factory/watchdog.sh — belt-and-braces supervisor. Runs every 30 min via timer.
#
#   ./factory/watchdog.sh [--dry-run]
#
# loop.sh already enforces its own caps. This exists because a supervisor that
# trusts the supervised process is not a supervisor: if a loop wedges inside a
# syscall, loses its shell, or is SIGSTOPped, its internal deadline never fires.
# The watchdog enforces the same bounds from outside, using the pidfiles loops
# publish in factory/run/.
#
# Duties:
#   1. Kill any loop.sh past its own max_minutes (+2 min grace).
#   2. If ~/STOP_FACTORY exists: kill every factory process, log it, exit.
#   3. Disk guard: below MIN_FREE_DISK_GB, stop new dispatch and note it.
#   4. Rate guard: on a rate-limit/overloaded signature in recent logs, engage
#      the global back-off file that every loop honours.
#   5. Reap stale pidfiles and stale in-progress labels for dead workers.

set -uo pipefail

FACTORY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/common.sh
. "$FACTORY_DIR/lib/common.sh"

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

act() {   # act <description> <command…>
  local desc="$1"; shift
  if [ "$DRY" = "1" ]; then
    printf 'WOULD: %s\n' "$desc"
  else
    log "$desc"
    "$@"
  fi
}

log "=== watchdog pass ==="

# ---------------------------------------------- 2. kill switch (highest prio) --
# Checked first: if the operator hit stop, nothing else matters.
if stop_requested; then
  log "STOP_FACTORY present — terminating all factory processes."
  mapfile -t victims < <(pgrep -f "$FACTORY_DIR/lib/loop.sh" 2>/dev/null || true)
  mapfile -t more    < <(pgrep -f "$FACTORY_DIR/dispatch.sh" 2>/dev/null || true)
  victims+=("${more[@]}")
  if [ ${#victims[@]} -eq 0 ]; then
    log "no factory processes running; nothing to kill."
  else
    for pid in "${victims[@]}"; do
      [ -n "$pid" ] || continue
      act "killing factory pid $pid (TERM)" kill -TERM "$pid" 2>/dev/null || true
    done
    if [ "$DRY" != "1" ]; then
      sleep 5
      for pid in "${victims[@]}"; do
        [ -n "$pid" ] || continue
        if kill -0 "$pid" 2>/dev/null; then
          log "pid $pid survived TERM — sending KILL"
          kill -KILL "$pid" 2>/dev/null || true
        fi
      done
    fi
  fi
  # Kill claude children that outlived their parent loop.
  mapfile -t orphans < <(pgrep -f 'claude -p' 2>/dev/null || true)
  for pid in "${orphans[@]}"; do
    [ -n "$pid" ] || continue
    act "killing orphaned agent pid $pid" kill -TERM "$pid" 2>/dev/null || true
  done
  printf '%s\tSTOP_FACTORY honoured; %s process(es) terminated\n' "$(ts)" "${#victims[@]}" \
    >> "$LOG_DIR/watchdog.log"
  [ "$DRY" = "1" ] || "$FACTORY_DIR/tracker.sh" --quiet 2>/dev/null || true
  exit 0
fi

# --------------------------------------- 1. enforce max_minutes from outside --
# Pidfile format (written by loop.sh): "<pid> <name> <start_epoch> <max_minutes>"
KILLED=0
shopt -s nullglob
for pf in "$RUN_DIR"/*.pid; do
  read -r pid name start maxmin < "$pf" 2>/dev/null || continue
  [ -n "${pid:-}" ] || continue
  case "${start:-}${maxmin:-}" in ''|*[!0-9]*) continue ;; esac

  if ! kill -0 "$pid" 2>/dev/null; then
    log "reaping stale pidfile $(basename "$pf") (pid $pid gone)"
    [ "$DRY" = "1" ] || rm -f "$pf"
    continue
  fi

  now=$(date -u +%s)
  age=$(( now - start ))
  limit=$(( maxmin * 60 + 120 ))   # +2 min grace over the loop's own deadline
  if [ "$age" -gt "$limit" ]; then
    act "loop '$name' (pid $pid) is ${age}s old, past its ${maxmin}m cap +grace — killing" \
        kill -TERM "$pid"
    if [ "$DRY" != "1" ]; then
      sleep 5
      if kill -0 "$pid" 2>/dev/null; then
        kill -KILL "$pid" 2>/dev/null || true
      fi
      {
        printf '%s\n' "# BLOCKED: $name" "" \
          "- **reason**: killed by watchdog — exceeded ${maxmin}m wall cap (age ${age}s)" \
          "- **killed at**: $(ts)" "" \
          "The loop's internal deadline did not fire (wedged or stopped process)." \
          "This report was written by the watchdog, not the loop."
      } > "$BLOCKED_DIR/BLOCKED-${name}.md"
      rm -f "$pf"
    fi
    KILLED=$((KILLED+1))
    printf '%s\twatchdog killed %s (pid %s, age %ss > %sm)\n' "$(ts)" "$name" "$pid" "$age" "$maxmin" \
      >> "$LOG_DIR/watchdog.log"
  else
    log "loop '$name' (pid $pid) healthy: ${age}s of $(( maxmin * 60 ))s"
  fi
done
shopt -u nullglob

# ------------------------------------------------------------- 3. disk guard --
FREE="$(free_disk_gb)"
if ! disk_ok; then
  warn "DISK GUARD: ${FREE}GB free < ${MIN_FREE_DISK_GB}GB — new dispatch suspended"
  printf '%s\tdisk guard: %sGB free < %sGB\n' "$(ts)" "$FREE" "$MIN_FREE_DISK_GB" \
    >> "$LOG_DIR/watchdog.log"
  # Recorded in STATE.md via tracker (which reads the same guard).
  printf '%s  disk guard tripped: %sGB free\n' "$(ts)" "$FREE" >> "$LOG_DIR/dispatch-notes.log"
else
  log "disk OK: ${FREE}GB free (min ${MIN_FREE_DISK_GB}GB)"
fi

# ------------------------------------------------------------- 4. rate guard --
# Scan AGENT TRANSCRIPTS touched in the last 35 min (slightly wider than the
# 30 min timer, so nothing falls between passes) for rate-limit/overload
# signatures.
#
# Scope is deliberately narrow: *.agent.log only. Scanning every log in the
# directory produced a real false positive — a loop log captured under `bash -x`
# contains the detection regex itself in its trace output, and the watchdog's own
# log quotes the pattern when it reports a hit. Either would trip a 60-minute
# global back-off and silently halt the whole factory. Rate-limit errors only
# ever come from the API, so only the API transcripts are evidence.
if backoff_active; then
  log "back-off already active: $(backoff_remaining)s remaining"
else
  HIT=""
  while IFS= read -r f; do
    if looks_rate_limited "$f"; then HIT="$f"; break; fi
  done < <(find "$LOG_DIR" -maxdepth 1 -type f -name '*.agent.log' -newermt '-35 minutes' 2>/dev/null)
  if [ -n "$HIT" ]; then
    warn "rate-limit/overload signature in $(basename "$HIT")"
    if [ "$DRY" = "1" ]; then
      printf 'WOULD: engage %sm back-off for all loops\n' "$BACKOFF_MINUTES"
    else
      start_backoff "$BACKOFF_MINUTES"
      printf '%s\trate guard: backed off %sm (source %s)\n' "$(ts)" "$BACKOFF_MINUTES" "$(basename "$HIT")" \
        >> "$LOG_DIR/watchdog.log"
    fi
  else
    log "no rate-limit signatures in the last 35 min"
  fi
fi

# --------------------------------------- 5. stale in-progress label cleanup ---
# A worker killed mid-flight leaves in-progress set, which would freeze that
# issue out of future passes. Clear it when no live loop owns the issue.
if have_gh && [ "${ENABLE_DISPATCH:-false}" = "true" ]; then
  a=(); mapfile -t a < <(gh_repo_args)
  while read -r inum; do
    [ -n "$inum" ] || continue
    if [ ! -f "$RUN_DIR/issue-$inum.pid" ]; then
      act "clearing stale in-progress on issue #$inum (no live loop owns it)" \
          gh issue edit "$inum" --remove-label in-progress "${a[@]}"
    fi
  done < <(gh issue list --label in-progress --state open --limit 50 \
             --json number --jq '.[].number' "${a[@]}" 2>/dev/null || true)
fi

log "watchdog pass complete (killed $KILLED loop(s))"
[ "$DRY" = "1" ] || "$FACTORY_DIR/tracker.sh" --quiet 2>/dev/null || true
exit 0
