#!/usr/bin/env bash
# factory/tests/count-lines.sh — pin count_lines(), because the idiom it
# replaces has caused three separate defects in this repo.
#
# `grep -c '' "$f" 2>/dev/null || echo 0` looks obviously correct and is not. On
# a file that exists but is EMPTY, grep prints "0" AND exits 1, so `|| echo 0`
# fires and the value becomes the two-line string "0\n0".
#
# What that broke:
#   * `"attempts": "0\n0"` stored under a numeric key in two task state files;
#   * shell errors printed into review bodies via review.sh's EXCLUDED_N;
#   * `[ "0\n0" -ge 40 ]` in spend_reserve, which throws "integer expression
#     expected" and is therefore FALSE — so `&& exit 3` never ran and the daily
#     spawn cap failed OPEN.
#
# The empty-file case is the one to hold onto: every assertion below passes with
# the old idiom EXCEPT that one, which is exactly why it survived so long.

set -uo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FACTORY_DIR="$(cd "$TESTS_DIR/.." && pwd)"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }

# shellcheck source=../lib/common.sh
. "$FACTORY_DIR/lib/common.sh" >/dev/null 2>&1 || {
  printf 'FATAL: cannot source lib/common.sh\n' >&2; exit 1; }
declare -F count_lines >/dev/null || {
  printf 'FATAL: count_lines() is not defined by lib/common.sh\n' >&2; exit 1; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

cl() { # cl <label> <expected> <file>
  local got; got="$(count_lines "$3")"
  if [ "$got" = "$2" ]; then ok "$1 -> $got"
  else bad "$1 -> $(printf '%q' "$got") (expected $2)"; fi
}

printf '\ncount_lines\n'

: > "$T/empty"
cl "EMPTY file (the case the old idiom got wrong)" 0 "$T/empty"

printf 'a\n'            > "$T/one";    cl "one line"            1 "$T/one"
printf 'a\nb\nc\n'      > "$T/three";  cl "three lines"          3 "$T/three"
printf 'a\nb'           > "$T/noeol";  cl "no trailing newline"  2 "$T/noeol"
printf '\n\n'           > "$T/blanks"; cl "two blank lines"      2 "$T/blanks"
cl "missing file"        0 "$T/does-not-exist"
cl "no argument at all"  0 ""
cl "a directory"         0 "$T"

# The output must be usable as a NUMBER without quoting games — that is the
# whole point, and what the old idiom broke.
printf '\narithmetic usability\n'
n="$(count_lines "$T/empty")"
if [ "$n" -ge 0 ] 2>/dev/null; then ok "empty-file result works in [ -ge ]"
else bad "empty-file result is not an integer: $(printf '%q' "$n")"; fi
n="$(count_lines "$T/three")"
if [ "$n" -eq 3 ] 2>/dev/null; then ok "three-line result works in [ -eq ]"
else bad "three-line result is not 3: $(printf '%q' "$n")"; fi

# And the regression itself, stated as a property: exactly one line of output.
printf '\nexactly one line of output\n'
for f in "$T/empty" "$T/three" "$T/does-not-exist"; do
  lines="$(count_lines "$f" | wc -l | tr -d ' ')"
  if [ "$lines" = "1" ]; then ok "one line for $(basename "$f")"
  else bad "$(basename "$f") produced $lines lines — the 0\\n0 bug is back"; fi
done

# No caller may reintroduce the idiom.
printf '\nthe idiom is gone from the tree\n'
if grep -rn "grep -c.*|| echo 0" "$FACTORY_DIR" --include='*.sh' \
     | grep -v 'tests/count-lines.sh' | grep -vE '^\S+: *#' | grep -q .; then
  bad "grep -c ... || echo 0 still present:"
  grep -rn "grep -c.*|| echo 0" "$FACTORY_DIR" --include='*.sh' \
    | grep -v 'tests/count-lines.sh' | grep -vE '^\S+: *#' | sed 's/^/        /'
else
  ok "no live 'grep -c ... || echo 0' remains under factory/"
fi

printf '\n-------------------------------------------\n'
printf 'count-lines: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
