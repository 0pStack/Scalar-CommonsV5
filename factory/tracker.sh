#!/usr/bin/env bash
# factory/tracker.sh — state file + nightly digest.
#
#   ./factory/tracker.sh            # regenerate factory/STATE.md
#   ./factory/tracker.sh --quiet    # same, no stdout (called from dispatch)
#   ./factory/tracker.sh --digest   # STATE.md + new BLOCKED files -> secret gist
#
# STATE.md is the morning-coffee view: what the factory touched in the last 24h,
# what is stuck and why, what it cost in attempts and wall time. It is derived
# ENTIRELY from logs, BLOCKED files, and the GitHub API — never from an agent's
# claim about its own work. Regenerated wholesale each run, so it cannot drift.
#
# --digest runs from a systemd timer at 05:30 UTC and gists STATE.md plus any
# BLOCKED reports that appeared since the last digest, appending the URL to
# factory/digests.log.

set -uo pipefail

FACTORY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/common.sh
. "$FACTORY_DIR/lib/common.sh"

QUIET=0
DIGEST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --quiet)  QUIET=1 ;;
    --digest) DIGEST=1 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

STATE="$FACTORY_DIR/STATE.md"
DIGEST_LOG="$FACTORY_DIR/digests.log"
DIGEST_STAMP="$RUN_DIR/.last-digest"
BT='`'

# ------------------------------------------------------- loop stats from logs --
# Attempts, outcome, and wall time come from what loop.sh actually LOGGED — if a
# loop's agent claimed success while the gate stayed red, the log still shows the
# gate exit codes, and that is what appears here.
#
# Two subtleties this handles:
#   - Logs are per-name-per-DAY and appended, so one file can hold several runs.
#     Stats are scoped to the LAST run (from the final "loop ... starting"
#     header), otherwise attempt counts silently accumulate across runs and
#     overstate the burn.
#   - Only real loop logs qualify. watchdog.log, dispatch-notes.log, and
#     merges.log live in the same directory and are not loops; requiring the
#     loop header excludes them without a filename blocklist to maintain.
loop_stats() {
  find "$LOG_DIR" -maxdepth 1 -name '*.log' -newermt '-24 hours' 2>/dev/null \
    | sort | while read -r f; do
    python3 - "$f" <<'PY'
import sys, os, re, datetime

path = sys.argv[1]
name = os.path.basename(path)[:-4]
try:
    lines = open(path, errors="replace").read().splitlines()
except Exception:
    sys.exit(0)

# Scope to the last run: everything after the final start header.
starts = [i for i, l in enumerate(lines) if 'loop "' in l and "starting" in l]
if not starts:
    sys.exit(0)                      # not a loop log (watchdog, notes, merges)
run = lines[starts[-1]:]
body = "\n".join(run)

attempts = sum(1 for l in run if "--- attempt" in l)

if "GATE PASSED" in body:                        outcome = "gate PASSED"
elif "gate already passes" in body:              outcome = "already green"
elif "attempt cap reached" in body:              outcome = "BLOCKED (attempt cap)"
elif "wall-clock cap reached" in body:           outcome = "BLOCKED (time cap)"
elif "byte-identical" in body:                   outcome = "BLOCKED (stuck)"
elif "STOP_FACTORY" in body:                     outcome = "stopped (kill switch)"
elif "ANTHROPIC_API_KEY not set" in body:        outcome = "refused (no API key)"
else:                                            outcome = "running / unknown"

stamps = [m.group(1) for m in (re.match(r"^\[([0-9T:-]+Z)\]", l) for l in run) if m]
wall = "?"
if len(stamps) >= 2:
    try:
        fmt = "%Y-%m-%dT%H:%M:%SZ"
        d = datetime.datetime.strptime(stamps[-1], fmt) - datetime.datetime.strptime(stamps[0], fmt)
        m_, s_ = divmod(int(d.total_seconds()), 60)
        wall = f"{m_}m{s_}s"
    except Exception:
        pass

print(f"| {name} | {attempts} | {outcome} | {wall} | {stamps[-1] if stamps else '?'} |")
PY
  done
}

# ------------------------------------------------------------ GitHub context --
gh_tasks() {
  have_gh || { printf '| _gh unavailable_ | | | |\n'; return; }
  local a=()
  mapfile -t a < <(gh_repo_args)
  # Issues the factory has touched: in-progress, or a factory PR references them.
  gh issue list --state all --limit 100 --search 'updated:>=@1' \
     --json number,title,labels,updatedAt,state "${a[@]}" 2>/dev/null \
  | python3 -c '
import json,sys,datetime
try: issues=json.load(sys.stdin)
except Exception: issues=[]
cut = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=24)
rows=0
for it in issues:
    labels={l["name"] for l in it.get("labels") or []}
    if not (labels & {"ready","in-progress","agent-reviewed","needs-human","blocked"}):
        continue
    try:
        u=datetime.datetime.fromisoformat(it["updatedAt"].replace("Z","+00:00"))
    except Exception:
        continue
    if u < cut: continue
    tier=next((l for l in sorted(labels) if l.startswith("tier:")),"—")
    if it.get("state")=="CLOSED": status="shipped"
    elif "in-progress" in labels: status="in-progress"
    elif "needs-human" in labels: status="needs-human"
    elif "blocked" in labels: status="blocked"
    else: status="queued"
    print(f'"'"'| #{it["number"]} | {tier} | {status} | {(it.get("title") or "")[:60]} |'"'"')
    rows+=1
if rows==0:
    print("| _no labelled issue activity in 24h_ | | | |")
'
}

gh_prs() {
  have_gh || { printf '| _gh unavailable_ | | | |\n'; return; }
  local a=()
  mapfile -t a < <(gh_repo_args)
  gh pr list --state open --limit 50 --json number,title,labels,headRefName "${a[@]}" 2>/dev/null \
  | python3 -c '
import json,sys
try: prs=json.load(sys.stdin)
except Exception: prs=[]
rows=0
for p in prs:
    labels={l["name"] for l in p.get("labels") or []}
    head=p.get("headRefName") or ""
    if not head.startswith("task/") and not (labels & {"agent-reviewed","needs-human"}):
        continue
    state="agent-reviewed" if "agent-reviewed" in labels else "awaiting review"
    if "needs-human" in labels: state="needs-human"
    print(f'"'"'| #{p["number"]} | {head} | {state} | {(p.get("title") or "")[:55]} |'"'"')
    rows+=1
if rows==0: print("| _no open factory PRs_ | | | |")
'
}

merges_yesterday() {
  local f="$LOG_DIR/merges.log" y
  y="$(date -u -d 'yesterday' +%Y-%m-%d 2>/dev/null || echo 0000-00-00)"
  # Same class of bug as count_lines() documents: a pattern that matches nothing
  # makes grep -c print 0 and exit 1, so `|| echo 0` emits "0\n0".
  if [ -f "$f" ]; then
    local n; n="$(grep -c "^$y" "$f" 2>/dev/null)" || n=0
    case "$n" in ''|*[!0-9]*) n=0 ;; esac
    printf '%s\n' "$n"
  else echo 0; fi
}

# ------------------------------------------------------------- write STATE.md --
{
  printf '# Factory STATE — %s\n\n' "$(ts)"
  printf '_Generated by %stracker.sh%s from logs, BLOCKED reports, and the GitHub API._\n' "$BT" "$BT"
  printf '_Nothing here comes from an agent self-report; gate outcomes are read from logs._\n\n'

  # Guards up top: if the factory is throttled or stopped, that is the headline.
  printf '## Health\n\n'
  if stop_requested; then
    printf -- '- **KILL SWITCH ENGAGED** — %s exists. No loops will start.\n' "$STOP_FILE"
  else
    printf -- '- kill switch: clear\n'
  fi
  if backoff_active; then
    printf -- '- **RATE-LIMIT BACK-OFF ACTIVE** — %ss remaining\n' "$(backoff_remaining)"
  else
    printf -- '- rate-limit back-off: clear\n'
  fi
  free="$(free_disk_gb)"
  if disk_ok; then
    printf -- '- disk: %sGB free (min %sGB) — OK\n' "$free" "$MIN_FREE_DISK_GB"
  else
    printf -- '- **DISK GUARD TRIPPED**: %sGB free < %sGB required — new dispatch suspended\n' "$free" "$MIN_FREE_DISK_GB"
  fi
  if is_night; then
    printf -- '- window: night (heavy parallelism, MAX_PARALLEL=%s)\n' "$MAX_PARALLEL"
  else
    printf -- '- window: day (throttled to %s to keep the box interactive)\n' "$DAY_MAX_PARALLEL"
  fi
  printf -- '- dispatcher: %s | merge: %s (MERGE_T2=%s)\n' \
    "${ENABLE_DISPATCH:-false}" "${ENABLE_MERGE:-false}" "${MERGE_T2:-false}"
  printf -- '- merges yesterday: **%s**\n\n' "$(merges_yesterday)"

  printf '## Tasks touched in the last 24h\n\n'
  printf '| issue | tier | status | title |\n|---|---|---|---|\n'
  gh_tasks
  printf '\n## Open factory PRs\n\n'
  printf '| PR | branch | state | title |\n|---|---|---|---|\n'
  gh_prs

  printf '\n## Loop stats (last 24h, scoped to each loop last run)\n\n'
  printf '| loop | attempts used | outcome | wall time | last activity |\n|---|---|---|---|---|\n'
  loop_stats

  printf '\n## Open BLOCKED reports\n\n'
  shopt -s nullglob
  blocked=("$BLOCKED_DIR"/BLOCKED-*.md)
  if [ ${#blocked[@]} -eq 0 ]; then
    printf '_None. Every loop either passed its gate or has not run._\n'
  else
    for b in "${blocked[@]}"; do
      printf '### %s\n\n' "$(basename "$b")"
      grep -E '^- \*\*(reason|attempts used|wall time|gate|blocked at)' "$b" 2>/dev/null \
        || printf '_(unparseable report)_\n'
      printf '\n'
      # First few lines of the authoritative gate output — the actual error.
      awk '/^## Last gate output/{flag=1;next} /^```$/{if(flag==1){flag=2;next}} flag==2 && !/^```/{print; n++; if(n>=12) exit}' "$b" \
        | sed 's/^/    /'
      printf '\n'
    done
  fi
  shopt -u nullglob

  printf '\n---\n'
  printf 'Stop everything now: %stouch %s%s\n' "$BT" "$STOP_FILE" "$BT"
} > "$STATE"

[ "$QUIET" = "1" ] || log "wrote $STATE"

# ---------------------------------------------------------------- the digest --
if [ "$DIGEST" = "1" ]; then
  have_gh || die "gh required for --digest"
  files=("$STATE")
  # Include BLOCKED reports newer than the last digest (or all, on first run).
  shopt -s nullglob
  for b in "$BLOCKED_DIR"/BLOCKED-*.md; do
    if [ ! -f "$DIGEST_STAMP" ] || [ "$b" -nt "$DIGEST_STAMP" ]; then
      files+=("$b")
    fi
  done
  shopt -u nullglob

  # gh creates SECRET gists by default; there is no --secret flag (passing one
  # makes gh print usage and create nothing, which would have silently broken
  # the nightly digest). --public is the opt-out, and we never pass it.
  log "gisting ${#files[@]} file(s) as a secret gist"
  url="$(gh gist create \
          --desc "Scalar Commons factory digest $(date -u +%Y-%m-%d)" \
          "${files[@]}" 2>&1 | tail -1)"
  if printf '%s' "$url" | grep -q '^https://'; then
    printf '%s\t%s\t%s files\n' "$(ts)" "$url" "${#files[@]}" >> "$DIGEST_LOG"
    log "digest: $url"
    touch "$DIGEST_STAMP"
  else
    warn "gist creation failed: $url"
    exit 1
  fi
fi

if [ "$QUIET" != "1" ] && [ "$DIGEST" != "1" ]; then
  printf '\n--- %s ---\n' "$STATE"
  cat "$STATE"
fi
