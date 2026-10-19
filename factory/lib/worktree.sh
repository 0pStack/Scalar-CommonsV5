#!/usr/bin/env bash
# factory/lib/worktree.sh — git worktree isolation for parallel agents.
#
# Source it for the helpers, or call it directly:
#   worktree.sh new <task-id>      # prints the worktree path on stdout
#   worktree.sh cleanup <task-id>
#   worktree.sh list
#   worktree.sh cargo <task-id> -- <cargo args…>
#
# WHY WORKTREES: two agents editing one checkout corrupt each other's diffs.
# Each task gets ../wt-<task-id> cut from $BASE_BRANCH.
#
# THE SHARED-CACHE TRADEOFF (deliberate, documented):
#   CARGO_TARGET_DIR=~/shared-target is shared by every worktree. A cold
#   Substrate build is very expensive, so N worktrees with N private target
#   dirs would mean N cold builds and tens of GB of duplicate artifacts.
#   Sharing one cache makes builds after the first nearly free.
#   The cost: cargo does NOT support concurrent invocations against one target
#   dir. Two parallel `cargo build`s race on the same artifacts and produce
#   corrupt or spuriously-failing builds — which, in a factory, reads as a
#   flaky gate and burns attempts on a phantom failure.
#   Mitigation: ALL cargo invocations serialize behind flock on
#   $CARGO_LOCKFILE (see cargo_locked). Net effect: builds are serial, but
#   agent thinking, editing, and non-cargo gates stay parallel — and thinking
#   is the dominant cost, so throughput stays high.
#   If you ever need genuinely parallel builds, give each worktree its own
#   target dir and accept the disk + cold-build cost. Do not remove the lock.

set -uo pipefail

FACTORY_DIR="${FACTORY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=common.sh
. "$FACTORY_DIR/lib/common.sh"

export CARGO_TARGET_DIR="$SHARED_CARGO_TARGET"
mkdir -p "$CARGO_TARGET_DIR"

wt_path() { printf '%s/wt-%s\n' "$(cd "$REPO_DIR/.." && pwd)" "$1"; }

# new_worktree <task-id> -> prints path
# Cut from the latest $BASE_BRANCH (origin's tip if reachable, else local).
new_worktree() {
  local id="$1" path base
  [ -n "$id" ] || { warn "new_worktree: task-id required"; return 1; }
  path="$(wt_path "$id")"

  if [ -d "$path" ]; then
    log "worktree already exists: $path (reusing)" >&2
    printf '%s\n' "$path"
    return 0
  fi

  base="$BASE_BRANCH"
  if git -C "$REPO_DIR" fetch --quiet origin "$BASE_BRANCH" 2>/dev/null; then
    base="origin/$BASE_BRANCH"
  else
    warn "could not fetch origin/$BASE_BRANCH — cutting from local $BASE_BRANCH"
    git -C "$REPO_DIR" rev-parse --verify "$BASE_BRANCH" >/dev/null 2>&1 \
      || { warn "base branch $BASE_BRANCH not found"; return 1; }
  fi

  log "creating worktree $path from $base" >&2
  if ! git -C "$REPO_DIR" worktree add --detach "$path" "$base" >&2; then
    warn "git worktree add failed for $id"
    return 1
  fi
  printf '%s\n' "$path"
}

# cleanup_worktree <task-id> — call after the PR is merged (or abandoned).
# Refuses to discard uncommitted work unless FORCE=1.
cleanup_worktree() {
  local id="$1" path
  [ -n "$id" ] || { warn "cleanup_worktree: task-id required"; return 1; }
  path="$(wt_path "$id")"

  if [ ! -d "$path" ]; then
    log "no worktree to clean for $id"
    return 0
  fi

  if [ "${FORCE:-0}" != "1" ] && [ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ]; then
    warn "worktree $path has uncommitted changes — refusing to remove (FORCE=1 to override)"
    return 1
  fi

  log "removing worktree $path"
  git -C "$REPO_DIR" worktree remove --force "$path" 2>/dev/null || rm -rf "$path"
  git -C "$REPO_DIR" worktree prune
}

list_worktrees() { git -C "$REPO_DIR" worktree list; }

# cargo_locked <args…> — the ONLY sanctioned way to run cargo in a worktree.
# Serializes every cargo invocation across all worktrees behind one flock.
cargo_locked() {
  log "waiting for cargo lock ($CARGO_LOCKFILE) …" >&2
  flock "$CARGO_LOCKFILE" cargo "$@"
}

# gate_locked <shell-command> — run an arbitrary gate command under the cargo
# lock. Used by dispatch.sh for Rust gates so two workspace builds never race.
gate_locked() {
  flock "$CARGO_LOCKFILE" bash -c "$1"
}

# Direct CLI use.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  cmd="${1:-}"; shift || true
  case "$cmd" in
    new)     new_worktree "${1:-}" ;;
    cleanup) cleanup_worktree "${1:-}" ;;
    list)    list_worktrees ;;
    cargo)
      id="${1:-}"; shift || true
      [ "${1:-}" = "--" ] && shift
      p="$(wt_path "$id")"
      [ -d "$p" ] || die "no worktree for $id"
      (cd "$p" && cargo_locked "$@")
      ;;
    path)    wt_path "${1:-}" ;;
    *) cat >&2 <<'EOF'
usage: worktree.sh {new|cleanup|list|path} <task-id>
       worktree.sh cargo <task-id> -- <cargo args…>
EOF
       exit 2 ;;
  esac
fi
