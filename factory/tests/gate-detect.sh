#!/usr/bin/env bash
# factory/tests/gate-detect.sh — prove per-tier gate detection is real.
#
# The T3 gate is supposed to be derived from the touched subproject by READING
# its manifest. If that detection is wrong, a loop is graded by the wrong
# command — the most dangerous failure mode the factory has, because it looks
# like it is working. So it gets its own test.
#
# Builds throwaway git repos with real manifests and asserts the chosen gate.
#
# shellcheck disable=SC2317
# ^ File-level: with `shellcheck -x` the sourced dispatch.sh contains an
#   `exit 0` on its DISPATCH_LIB_ONLY path, so static analysis treats everything
#   after the source as unreachable. At runtime that branch `return`s when
#   sourced (the exit is only the fallback for direct execution), so every line
#   below does run — as the passing assertions demonstrate.

set -uo pipefail

FACTORY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0

ok()  { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m  %s\n' "$1"; printf '        got: %s\n' "$2"; }
check() { # check <desc> <expected-substring> <actual>
  case "$3" in *"$2"*) ok "$1" ;; *) bad "$1 (expected to contain '$2')" "$3" ;; esac
}

# Load dispatch.sh's functions without running a dispatch pass.
export DISPATCH_LIB_ONLY=1
# shellcheck source-path=SCRIPTDIR
# shellcheck source=../dispatch.sh
# shellcheck disable=SC1091
. "$FACTORY_DIR/dispatch.sh"
unset DISPATCH_LIB_ONLY

mk_repo() { # mk_repo -> prints path to a fresh git repo
  local d
  d="$(mktemp -d)"
  git -C "$d" init -q
  git -C "$d" config user.email f@f; git -C "$d" config user.name f
  printf 'root\n' > "$d/README.md"
  git -C "$d" add -A; git -C "$d" commit -qm init
  printf '%s\n' "$d"
}

printf '\n\033[1m=== gate detection ===\033[0m\n'

# --- Node subproject with build + typecheck + test -------------------------
R="$(mk_repo)"
mkdir -p "$R/sdk/src"
cat > "$R/sdk/package.json" <<'EOF'
{ "name":"x","scripts":{"build":"tsc","typecheck":"tsc --noEmit","test":"vitest run"} }
EOF
printf 'export const a=1;\n' > "$R/sdk/src/a.ts"
git -C "$R" add -A; git -C "$R" commit -qm sdk
printf 'export const a=2;\n' > "$R/sdk/src/a.ts"   # uncommitted change under sdk/
G="$(detect_gate "$R")"
check "sdk diff -> npm ci"        "npm ci"        "$G"
check "sdk diff -> npm run build" "npm run build" "$G"
check "sdk diff -> npm run typecheck (read from package.json)" "npm run typecheck" "$G"
check "sdk diff -> npm test"      "npm test"      "$G"
check "sdk diff -> scoped to sdk" "cd sdk"        "$G"
case "$G" in *cargo*) bad "sdk gate must NOT be the cargo workspace gate" "$G" ;; *) ok "sdk gate is not the workspace fallback" ;; esac
rm -rf "$R"

# --- Node subproject with test only (no build/lint) ------------------------
R="$(mk_repo)"
mkdir -p "$R/indexer"
printf '{ "name":"i","scripts":{"test":"node --test"} }\n' > "$R/indexer/package.json"
printf 'x\n' > "$R/indexer/server.js"
git -C "$R" add -A; git -C "$R" commit -qm idx
printf 'y\n' > "$R/indexer/server.js"
G="$(detect_gate "$R")"
check "indexer test-only -> npm test" "npm test" "$G"
case "$G" in *"npm run build"*) bad "must not invent a build script that does not exist" "$G" ;; *) ok "does not invent a missing build script" ;; esac
rm -rf "$R"

# --- Node subproject with NO test script: must refuse and fall back --------
R="$(mk_repo)"
mkdir -p "$R/indexer"
printf '{ "name":"i","scripts":{"build":"tsc"} }\n' > "$R/indexer/package.json"
printf 'x\n' > "$R/indexer/a.js"
git -C "$R" add -A; git -C "$R" commit -qm idx2
printf 'y\n' > "$R/indexer/a.js"
G="$(detect_gate "$R")"
check "no test script -> falls back to the workspace gate" "cargo check --workspace" "$G"
ok "a subproject with no test script cannot form an honest gate, so it escalates"
rm -rf "$R"

# --- Python subproject (indexer/ is python today) --------------------------
R="$(mk_repo)"
mkdir -p "$R/indexer"
printf 'print(1)\n' > "$R/indexer/reconcile.py"
git -C "$R" add -A; git -C "$R" commit -qm py
printf 'print(2)\n' > "$R/indexer/reconcile.py"
G="$(detect_gate "$R")"
check "python subproject -> pytest" "pytest" "$G"
rm -rf "$R"

# --- Rust / mixed diffs must use the workspace gate -----------------------
R="$(mk_repo)"
mkdir -p "$R/pallets/emissions/src" "$R/sdk"
printf 'fn a(){}\n' > "$R/pallets/emissions/src/lib.rs"
printf '{ "name":"s","scripts":{"test":"vitest"} }\n' > "$R/sdk/package.json"
git -C "$R" add -A; git -C "$R" commit -qm mixed
printf 'fn b(){}\n' > "$R/pallets/emissions/src/lib.rs"
G="$(detect_gate "$R")"
check "rust diff -> workspace gate" "cargo check --workspace" "$G"
check "rust gate is flock-serialized" "flock" "$G"
# Mixed diff (rust + node) must also escalate to the workspace gate.
printf '{ "name":"s","scripts":{"test":"vitest","build":"x"} }\n' > "$R/sdk/package.json"
G="$(detect_gate "$R")"
check "mixed diff -> workspace gate (conservative)" "cargo check --workspace" "$G"
rm -rf "$R"

# --- tier routing ---------------------------------------------------------
printf '\n\033[1m=== tier -> gate routing ===\033[0m\n'
R="$(mk_repo)"
mkdir -p "$R/sdk"
printf '{ "name":"s","scripts":{"test":"vitest"} }\n' > "$R/sdk/package.json"
printf 'a\n' > "$R/sdk/a.ts"
git -C "$R" add -A; git -C "$R" commit -qm t
printf 'b\n' > "$R/sdk/a.ts"
check "tier:T2 always uses the workspace gate" "cargo check --workspace" "$(gate_for_tier tier:T2 "$R")"
check "tier:T2 gate builds tests too"           "cargo test --workspace --no-run" "$(gate_for_tier tier:T2 "$R")"
check "tier:T3 uses the detected subproject gate" "npm test" "$(gate_for_tier tier:T3 "$R")"
check "unknown tier falls back to workspace gate" "cargo check --workspace" "$(gate_for_tier tier:WAT "$R")"
rm -rf "$R"

printf '\n\033[1m===== GATE-DETECT SUMMARY: %d passed, %d failed =====\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
