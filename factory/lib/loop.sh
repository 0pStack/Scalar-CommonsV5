#!/usr/bin/env bash
# factory/lib/loop.sh — the bounded worker ("Ralph loop").
#
#   loop.sh <name> <workdir> <promptfile> <gatecmd> [max_attempts] [max_minutes]
#
# Runs a claude agent against a prompt, then runs the GATE. The gate — not the
# agent's transcript — decides success. This inversion is the whole point:
#
#   ABSOLUTE RULE: never make a check pass by weakening code.
#
# The loop cannot be talked out of a failure. An agent that says "all done!"
# while the gate is red has failed, and the loop keeps going or blocks. The
# agent never sees a success path that does not run through the gate command.
#
# Bounds (all hard):
#   - max_attempts       (default DEFAULT_MAX_ATTEMPTS)
#   - max_minutes        wall clock, enforced here AND by watchdog.sh
#   - same-error stop    identical gate output SAME_ERROR_LIMIT times => BLOCKED
#   - kill switch        ~/STOP_FACTORY, checked before and between attempts
#   - back-off           ~/.factory/backoff pauses loops after rate limits
#
# Exit codes: 0 = gate passed. 1 = blocked (cap hit / stuck / stopped).

set -uo pipefail

FACTORY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=common.sh
. "$FACTORY_DIR/lib/common.sh"

usage() {
  cat <<'EOF'
usage: loop.sh <name> <workdir> <promptfile> <gatecmd> [max_attempts] [max_minutes]

  name          identifier used for logs and BLOCKED reports
  workdir       directory the agent and the gate both run in
  promptfile    file whose contents become the agent prompt
  gatecmd       shell command; exit 0 == success. THE GATE DECIDES.
  max_attempts  default from config.env (DEFAULT_MAX_ATTEMPTS)
  max_minutes   default from config.env (DEFAULT_MAX_MINUTES)
EOF
}

[ $# -ge 4 ] || { usage >&2; exit 2; }

NAME="$1"
WORKDIR="$2"
PROMPTFILE="$3"
GATECMD="$4"
MAX_ATTEMPTS="${5:-$DEFAULT_MAX_ATTEMPTS}"
MAX_MINUTES="${6:-$DEFAULT_MAX_MINUTES}"

[ -d "$WORKDIR" ]    || die "workdir does not exist: $WORKDIR"
[ -f "$PROMPTFILE" ] || die "promptfile does not exist: $PROMPTFILE"
case "$MAX_ATTEMPTS" in ''|*[!0-9]*) die "max_attempts must be an integer: $MAX_ATTEMPTS" ;; esac
case "$MAX_MINUTES"  in ''|*[!0-9]*) die "max_minutes must be an integer: $MAX_MINUTES" ;; esac
[ "$MAX_ATTEMPTS" -gt 0 ] || die "max_attempts must be > 0"
[ "$MAX_MINUTES"  -gt 0 ] || die "max_minutes must be > 0"

LOG_FILE="$LOG_DIR/${NAME}-$(date -u +%Y%m%d).log"
BLOCKED_FILE="$BLOCKED_DIR/BLOCKED-${NAME}.md"
PIDFILE="$RUN_DIR/${NAME}.pid"

# All output tee'd to the per-name daily log.
exec > >(tee -a "$LOG_FILE") 2>&1

# Publish our identity so watchdog.sh can enforce max_minutes independently.
printf '%s %s %s %s\n' "$$" "$NAME" "$(date -u +%s)" "$MAX_MINUTES" > "$PIDFILE"

START_TS=$(date -u +%s)
DEADLINE=$(( START_TS + MAX_MINUTES * 60 ))

AGENT_LOG=""
LAST_GATE_OUT=""
LAST_HASH=""
SAME_COUNT=0
ATTEMPT=0
BLOCK_REASON=""

cleanup() { rm -f "$PIDFILE"; }
trap cleanup EXIT
trap 'log "received SIGTERM/SIGINT — aborting loop \"$NAME\""; exit 1' TERM INT

# Write the BLOCKED report: last gate output + last agent summary. This is the
# artifact a human reads in the morning, so it leads with the gate, not the
# agent's self-assessment.
write_blocked() {
  local reason="$1"
  local elapsed=$(( $(date -u +%s) - START_TS ))
  # Content is passed as printf ARGUMENTS, never as format strings. Two traps
  # this avoids: a format string starting with "-" is parsed as an option
  # ("printf: - : invalid option"), and a backtick inside double quotes is
  # command substitution. BT holds a literal Markdown backtick.
  local BT='`'
  local fence="${BT}${BT}${BT}"
  {
    printf '%s\n' \
      "# BLOCKED: $NAME" \
      "" \
      "- **reason**: $reason" \
      "- **attempts used**: $ATTEMPT / $MAX_ATTEMPTS" \
      "- **wall time**: $(( elapsed / 60 ))m$(( elapsed % 60 ))s / ${MAX_MINUTES}m" \
      "- **workdir**: ${BT}${WORKDIR}${BT}" \
      "- **gate**: ${BT}${GATECMD}${BT}" \
      "- **blocked at**: $(ts)" \
      "" \
      "## Last gate output (authoritative)" \
      "" \
      "$fence"
    if [ -n "$LAST_GATE_OUT" ] && [ -f "$LAST_GATE_OUT" ]; then
      tail -n 120 "$LAST_GATE_OUT"
    else
      printf '%s\n' "(no gate output captured)"
    fi
    printf '%s\n' \
      "$fence" \
      "" \
      "## Last agent summary (advisory only)" \
      "" \
      "$fence"
    if [ -n "$AGENT_LOG" ] && [ -f "$AGENT_LOG" ]; then
      tail -n 60 "$AGENT_LOG"
    else
      printf '%s\n' "(no agent output captured)"
    fi
    printf '%s\n' \
      "$fence" \
      "" \
      "---" \
      "The gate output above is the ground truth. Do not resolve this by" \
      "weakening the gate, deleting tests, or stubbing the implementation." \
      "Fix the code so the gate passes honestly, or escalate to a human."
  } > "$BLOCKED_FILE"
  log "wrote $BLOCKED_FILE"
}

log "=== loop \"$NAME\" starting ==="
log "workdir=$WORKDIR promptfile=$PROMPTFILE"
log "gate=$GATECMD"
log "caps: attempts=$MAX_ATTEMPTS minutes=$MAX_MINUTES (deadline $(date -u -d "@$DEADLINE" '+%H:%M:%SZ' 2>/dev/null || echo "$DEADLINE"))"

# Kill switch BEFORE any attempt, before touching billing.
if stop_requested; then
  log "STOP_FACTORY present — exiting before first attempt."
  exit 1
fi

# Fails closed if no API key: loops never run on the interactive subscription.
load_billing_env

# Run the gate once up front: if the tree is already green there is nothing to
# do, and we should not pay an agent to find that out.
GATE_PRE="$LOG_DIR/${NAME}-gate-pre.out"
if (cd "$WORKDIR" && bash -c "$GATECMD") >"$GATE_PRE" 2>&1; then
  log "gate already passes before any attempt — nothing to do. PASS"
  rm -f "$BLOCKED_FILE"
  exit 0
fi
log "gate is red at start (expected) — beginning attempts"
LAST_GATE_OUT="$GATE_PRE"

while :; do
  # --- pre-attempt guards -------------------------------------------------
  if stop_requested; then
    log "STOP_FACTORY appeared — stopping between attempts."
    BLOCK_REASON="kill switch (~/STOP_FACTORY) engaged"
    write_blocked "$BLOCK_REASON"
    exit 1
  fi

  NOW=$(date -u +%s)
  if [ "$NOW" -ge "$DEADLINE" ]; then
    BLOCK_REASON="wall-clock cap reached (${MAX_MINUTES}m)"
    log "$BLOCK_REASON"
    write_blocked "$BLOCK_REASON"
    exit 1
  fi

  if [ "$ATTEMPT" -ge "$MAX_ATTEMPTS" ]; then
    BLOCK_REASON="attempt cap reached ($MAX_ATTEMPTS attempts)"
    log "$BLOCK_REASON"
    write_blocked "$BLOCK_REASON"
    exit 1
  fi

  # Back-off: wait it out, but never past our own deadline.
  while backoff_active; do
    if stop_requested; then
      log "STOP_FACTORY during back-off — exiting."
      exit 1
    fi
    REMAIN=$(backoff_remaining)
    NOW=$(date -u +%s)
    if [ $(( NOW + REMAIN )) -ge "$DEADLINE" ]; then
      BLOCK_REASON="rate-limit back-off (${REMAIN}s) outlasts wall-clock cap"
      log "$BLOCK_REASON"
      write_blocked "$BLOCK_REASON"
      exit 1
    fi
    log "backing off ${REMAIN}s (rate limit) …"
    sleep "$(( REMAIN < 60 ? REMAIN + 1 : 60 ))"
  done

  # Every attempt is a `claude -p` process, so every attempt costs. Reserve
  # before spawning: the cap is meaningless if a loop can spend 10x its
  # dispatch reservation.
  if ! spend_reserve "loop:$NAME:attempt$(( ATTEMPT + 1 ))"; then
    BLOCK_REASON="daily spawn cap reached ($(spend_count)/$DAILY_SPAWN_CAP) — stopping before attempt $(( ATTEMPT + 1 ))"
    log "$BLOCK_REASON"
    spend_refusal "attempt $(( ATTEMPT + 1 )) of $NAME"
    write_blocked "$BLOCK_REASON"
    exit 1
  fi

  ATTEMPT=$(( ATTEMPT + 1 ))
  NOW=$(date -u +%s)
  REMAIN_SECS=$(( DEADLINE - NOW ))
  log "--- attempt $ATTEMPT/$MAX_ATTEMPTS (${REMAIN_SECS}s of wall budget left) ---"

  # --- run the agent ------------------------------------------------------
  # Bound the agent by whatever wall budget remains, so a single hung call
  # cannot blow through max_minutes.
  AGENT_LOG="$LOG_DIR/${NAME}-attempt${ATTEMPT}.agent.log"
  set +e
  (
    cd "$WORKDIR" || exit 1
    timeout --signal=TERM --kill-after=30s "${REMAIN_SECS}s" \
      claude -p "$(cat "$PROMPTFILE")" --dangerously-skip-permissions
  ) >"$AGENT_LOG" 2>&1
  AGENT_RC=$?
  set -e
  log "agent exited rc=$AGENT_RC (transcript: $AGENT_LOG)"

  if [ "$AGENT_RC" -eq 124 ] || [ "$AGENT_RC" -eq 137 ]; then
    log "agent hit the remaining wall budget and was killed"
  fi

  # Rate-limit / overload detection: engage global back-off for all loops.
  if looks_rate_limited "$AGENT_LOG"; then
    warn "rate-limit/overload signature in attempt $ATTEMPT — engaging ${BACKOFF_MINUTES}m back-off"
    start_backoff "$BACKOFF_MINUTES"
  fi

  # --- run the gate: this is what decides ---------------------------------
  GATE_OUT="$LOG_DIR/${NAME}-attempt${ATTEMPT}.gate.out"
  set +e
  (cd "$WORKDIR" && bash -c "$GATECMD") >"$GATE_OUT" 2>&1
  GATE_RC=$?
  set -e
  LAST_GATE_OUT="$GATE_OUT"
  log "gate exited rc=$GATE_RC (output: $GATE_OUT)"

  if [ "$GATE_RC" -eq 0 ]; then
    ELAPSED=$(( $(date -u +%s) - START_TS ))
    log "GATE PASSED on attempt $ATTEMPT after ${ELAPSED}s. PASS"
    rm -f "$BLOCKED_FILE"
    exit 0
  fi

  # --- same-error detection ----------------------------------------------
  # Identical gate output means the agent is not responding to the feedback.
  HASH=$(sha256sum "$GATE_OUT" | cut -d' ' -f1)
  if [ "$HASH" = "$LAST_HASH" ]; then
    SAME_COUNT=$(( SAME_COUNT + 1 ))
  else
    SAME_COUNT=1
    LAST_HASH="$HASH"
  fi
  log "gate failed; identical-output streak = $SAME_COUNT (limit $SAME_ERROR_LIMIT)"

  if [ "$SAME_COUNT" -ge "$SAME_ERROR_LIMIT" ]; then
    BLOCK_REASON="stuck: byte-identical gate failure $SAME_COUNT times consecutively (agent is not making progress; further attempts are pure burn)"
    log "$BLOCK_REASON"
    write_blocked "$BLOCK_REASON"
    exit 1
  fi
done
