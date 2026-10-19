#!/usr/bin/env bash
# .claude/hooks-factory/reject-stubs.sh — PostToolUse hook on Edit|Write|MultiEdit.
#
# THE STANDING RULE THIS ENFORCES:
#   Never make a check pass by weakening code.
#
# An unsupervised agent under gate pressure has one cheap escape: fake the
# implementation. Stub the function, silence the lint, delete the test. Each
# turns a red gate green while destroying the value of the gate. This hook is
# the mechanical block on that path — it fires on the WRITE, before any gate
# runs, so the shortcut is never even available.
#
# Exit 2 = block the tool call and feed the message back to the agent, which
# then has to solve the actual problem.
#
# Reads the hook payload as JSON on stdin. Uses python3, NOT jq: jq is not
# installed on this host (the pre-existing .claude/hooks/post-edit.sh silently
# no-ops for exactly that reason). python3 is present and is the safer bet.

set -uo pipefail

PAYLOAD="$(cat)"

# Extract the edited file path. Covers Write/Edit (file_path) and MultiEdit.
FILE="$(printf '%s' "$PAYLOAD" | python3 -c '
import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
ti = d.get("tool_input") or {}
p = ti.get("file_path") or ti.get("path") or ""
if not p:
    edits = ti.get("edits") or []
    if edits and isinstance(edits, list):
        p = (edits[0] or {}).get("file_path", "")
print(p)
' 2>/dev/null)"

[ -n "$FILE" ] || exit 0
[ -f "$FILE" ] || exit 0

# Only police source we own. Never scan vendored code, build output, or the
# factory's own docs (which necessarily *name* these patterns to ban them).
case "$FILE" in
  */node_modules/*|*/target/*|*/.git/*|*/dist/*|*/build/*) exit 0 ;;
  */factory/*|*/.claude/hooks-factory/*)                   exit 0 ;;
  *.md|*.txt|*.prompt|*.log|*.lock)                        exit 0 ;;
esac

VIOLATIONS=""
add() { VIOLATIONS="${VIOLATIONS}  - $1
"; }

# ---- universal bans -------------------------------------------------------
# todo!()/unimplemented!() compile fine and pass `cargo check`, so a gate that
# only builds would go green over a hollow implementation.
if grep -nE '\btodo!\(' "$FILE" >/dev/null 2>&1; then
  add "todo!( — placeholder body. $(grep -cE '\btodo!\(' "$FILE") occurrence(s) on line(s): $(grep -nE '\btodo!\(' "$FILE" | cut -d: -f1 | paste -sd, -)"
fi
if grep -nE '\bunimplemented!\(' "$FILE" >/dev/null 2>&1; then
  add "unimplemented!( — placeholder body. line(s): $(grep -nE '\bunimplemented!\(' "$FILE" | cut -d: -f1 | paste -sd, -)"
fi
# #[allow(...)] is how a clippy gate gets silenced instead of satisfied.
if grep -nE '#\[allow\(' "$FILE" >/dev/null 2>&1; then
  add "#[allow( — suppresses a lint rather than fixing it. line(s): $(grep -nE '#\[allow\(' "$FILE" | cut -d: -f1 | paste -sd, -)"
fi
# SKIP_WASM_BUILD makes the runtime "build" without producing a runtime.
if grep -nE 'SKIP_WASM_BUILD' "$FILE" >/dev/null 2>&1; then
  add "SKIP_WASM_BUILD — disables the WASM runtime build. line(s): $(grep -nE 'SKIP_WASM_BUILD' "$FILE" | cut -d: -f1 | paste -sd, -)"
fi

# ---- path-scoped bans -----------------------------------------------------
# An empty main() in node/ or runtime/ is the classic "make it compile" gut.
case "$FILE" in
  */node/*|*/runtime/*|node/*|runtime/*)
    if grep -nE 'fn +main *\( *\) *\{ *\}' "$FILE" >/dev/null 2>&1; then
      add "fn main() {} — empty entrypoint in a node/runtime path. line(s): $(grep -nE 'fn +main *\( *\) *\{ *\}' "$FILE" | cut -d: -f1 | paste -sd, -)"
    fi
    ;;
esac

[ -z "$VIOLATIONS" ] && exit 0

cat >&2 <<EOF
BLOCKED by factory standing rule: never make a check pass by weakening code.

File: $FILE

Violations found in what you just wrote:
$VIOLATIONS
These patterns make a gate go green without the work being done, so they are
rejected at write time. Required action: implement the behaviour for real.

  - todo!/unimplemented!      -> write the actual logic
  - #[allow(...)]             -> fix the lint the code is tripping
  - fn main() {}              -> restore the real entrypoint
  - SKIP_WASM_BUILD           -> fix the build instead of skipping it

If you believe an occurrence is genuinely legitimate, STOP and say so in your
final message with the justification. Do not route around this hook, and do not
delete tests or weaken assertions to reach the same effect.
EOF
exit 2
