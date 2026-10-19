#!/usr/bin/env bash
# scripts/run-matty-agent.sh — run your Scalar Commons agent (beginner guide: README-MATTY.md).
#
#   scripts/run-matty-agent.sh start      check everything, get test CMN if needed, start the agent
#                                         in the background, and verify its first transaction on chain
#   scripts/run-matty-agent.sh status     is it running, and what has it done
#   scripts/run-matty-agent.sh verify     prove the agent's latest transaction is on chain (explorer link)
#   scripts/run-matty-agent.sh stop       stop the agent
#   scripts/run-matty-agent.sh restart    stop, then start
#   scripts/run-matty-agent.sh logs       follow the agent's activity (Ctrl+C stops watching, not the agent)
#   scripts/run-matty-agent.sh check      read-only health check; spends nothing
#   scripts/run-matty-agent.sh new-key    make a new agent key (only when none is configured)
#
# It runs the reference agent in agent/ (agent/src/main.ts) unchanged. What this
# wrapper adds: it pins the public TESTNET and provider mode, refuses to start a
# key whose address was not approved (APPROVED_AGENT_ADDRESS), asks the testnet
# faucet once when the approved agent cannot afford registration yet, restarts
# the agent after a crash or a lost connection, and verifies on chain.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT="$ROOT/agent"
ONBOARD="$AGENT/dist/onboard.js"
MAIN="$AGENT/dist/main.js"
SELF="$ROOT/scripts/run-matty-agent.sh"

# ── Fixed for this onboarding: the public testnet, provider mode, the minimum stake. ──
# Not read from secrets on purpose: the approval Matty gives is for exactly this.
export SCALAR_WS="wss://rpc.scalarnet.io"
export SCALAR_INDEXER="https://api.scalarnet.io"
export SCALAR_FAUCET="https://faucet.scalarnet.io"
export EXPLORER_BASE="https://explorer.scalarnet.io"
export AGENT_MODE="provider"   # buyer mode spends escrow on its own; not part of this onboarding
export STAKE_CMN="1000"        # agents.minStake on the testnet
export STATE_DIR="$AGENT/state" # gitignored by agent/.gitignore
export AGENT_NAME="${AGENT_NAME:-matty-agent}"
export HEARTBEAT_BLOCKS="${HEARTBEAT_BLOCKS:-600}"

PIDFILE="$STATE_DIR/supervisor.pid"
SUPLOG="$STATE_DIR/supervisor.log"
mkdir -p "$STATE_DIR"

say() { printf '%s\n' "$*"; }
die() { printf '\n  ✗ %s\n\n' "$*" >&2; exit 1; }

need_build() {
  [[ -f "$ONBOARD" && -f "$MAIN" ]] || die "Not set up yet. Run:  bash scripts/setup-matty-agent.sh"
}

need_key() {
  if [[ -n "${AGENT_URI:-}" ]]; then
    die "AGENT_URI is set. This onboarding only uses your own AGENT_MNEMONIC secret — remove the AGENT_URI secret."
  fi
  if [[ -z "${AGENT_MNEMONIC:-}" ]]; then
    die "No AGENT_MNEMONIC secret found. Add it in Replit Secrets (see README-MATTY.md, STEP 4), then open a NEW Shell tab and try again."
  fi
}

running_pid() {
  [[ -f "$PIDFILE" ]] || return 1
  local pid
  pid="$(cat "$PIDFILE")"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    printf '%s' "$pid"
    return 0
  fi
  rm -f "$PIDFILE"
  return 1
}

# Keeps the agent alive: restart after an exit (crash, lost connection at start-up),
# waiting 10 s, doubling up to 5 min; a run that lasted 10 min resets the wait.
supervise() {
  local child="" wait=10 started
  trap 'say "$(date -u +%FT%TZ) supervisor: stopping"; [[ -n "$child" ]] && kill -TERM "$child" 2>/dev/null; wait "$child" 2>/dev/null; exit 0' TERM INT
  while true; do
    say "$(date -u +%FT%TZ) supervisor: starting agent"
    started=$(date +%s)
    node "$MAIN" >/dev/null &
    child=$!
    set +e
    wait "$child"
    local code=$?
    set -e
    child=""
    (( $(date +%s) - started >= 600 )) && wait=10
    say "$(date -u +%FT%TZ) supervisor: agent exited with code $code; restarting in ${wait}s"
    sleep "$wait" &
    wait $! || true
    wait=$(( wait * 2 > 300 ? 300 : wait * 2 ))
  done
}

start() {
  need_build
  need_key
  local pid
  if pid="$(running_pid)"; then
    say "The agent is already running (process $pid)."
    node "$ONBOARD" status
    return 0
  fi
  # The gate: testnet only, approved address only, funded before registering.
  node "$ONBOARD" check --for-start

  local since
  since="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  if command -v setsid >/dev/null 2>&1; then
    setsid nohup bash "$SELF" __supervise >>"$SUPLOG" 2>&1 </dev/null &
  else
    nohup bash "$SELF" __supervise >>"$SUPLOG" 2>&1 </dev/null &
  fi
  echo $! >"$PIDFILE"
  say ""
  say "  ✓ agent started in the background (process $(cat "$PIDFILE"))"
  say ""
  node "$ONBOARD" wait-first --since "$since" --timeout 180 || true
  say "Your agent keeps running while this Repl is awake."
  say "  status:  scripts/run-matty-agent.sh status"
  say "  stop:    scripts/run-matty-agent.sh stop"
}

stop() {
  local pid
  if ! pid="$(running_pid)"; then
    say "The agent is not running."
    return 0
  fi
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    # The supervisor did not exit in 20 s: kill it and the agent under it.
    pkill -KILL -P "$pid" 2>/dev/null || true
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
  say "  ✓ agent stopped. It stays registered on chain; start it again any time."
}

cmd="${1:-help}"
[[ $# -gt 0 ]] && shift
case "$cmd" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status)
    need_build; need_key
    if pid="$(running_pid)"; then say "  ✓ agent is RUNNING (process $pid)"; else say "  ✗ agent is NOT running — start it with: scripts/run-matty-agent.sh start"; fi
    node "$ONBOARD" status
    ;;
  verify) need_build; need_key; node "$ONBOARD" verify "$@" ;;
  check) need_build; need_key; node "$ONBOARD" check ;;
  logs)
    [[ -f "$STATE_DIR/agent.jsonl" ]] || die "No activity yet. Start the agent first."
    tail -n 20 -f "$STATE_DIR/agent.jsonl"
    ;;
  new-key) need_build; node "$ONBOARD" new-key ;;
  __supervise) supervise ;;
  *)
    say "usage: scripts/run-matty-agent.sh start | status | verify | stop | restart | logs | check | new-key"
    [[ "$cmd" == "help" ]] || exit 2
    ;;
esac
