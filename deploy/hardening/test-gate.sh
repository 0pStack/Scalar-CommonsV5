#!/usr/bin/env bash
# deploy/hardening/test-gate.sh — prove the I-24 gate reads the EFFECTIVE
# sshd configuration, not just /etc/ssh/sshd_config.
#
# WHY THIS TEST EXISTS
#
# The gate filed with issue #138 was:
#
#   ! grep -qE '^[[:space:]]*PasswordAuthentication[[:space:]]+yes' /etc/ssh/sshd_config
#     && ! grep -qE '^[[:space:]]*PermitRootLogin[[:space:]]+yes' /etc/ssh/sshd_config
#
# It greps ONE FILE. The fix for #138 is a drop-in in
# /etc/ssh/sshd_config.d/, deliberately, because the two bad directives sit at
# the END of sshd_config and sshd takes the FIRST value it obtains — so the
# correct fix leaves those two lines exactly where they are. The gate therefore
# stayed RED on a host that was genuinely hardened. It was measuring the wrong
# thing.
#
# It also failed in the dangerous direction, which is the half that matters:
# a host whose sshd_config says `no` while a drop-in that outranks it says
# `yes` is WIDE OPEN, and the old gate called it GREEN. That is case C below.
#
# The replacement asks sshd itself what it will actually do:
#
#   test "$(/usr/sbin/sshd -G 2>/dev/null | grep -cE '^(passwordauthentication|permitrootlogin|kbdinteractiveauthentication) no$')" = 3
#
# Every case below runs THE REAL GATE from sshd.gate, with only the config path
# redirected at a fixture, so the test cannot drift from the gate it checks.
# Nothing here needs root, touches /etc, or reloads anything.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE_FILE="$HERE/sshd.gate"
[ -f "$GATE_FILE" ] || { printf 'FATAL: %s not found\n' "$GATE_FILE" >&2; exit 1; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

# ---------------------------------------------------------------------------
# 1. The factory's own constraint on gate text.
#
# A two-line gate becomes a bash syntax error in the runner and can never go
# green, so this is not a style rule.
# ---------------------------------------------------------------------------
printf '\n\033[1m=== the gate is one line with no backslashes ===\033[0m\n'

NLINES="$(grep -c '' "$GATE_FILE")"
if [ "$NLINES" -eq 1 ]; then ok "sshd.gate is exactly one line"
else bad "sshd.gate is $NLINES lines — the factory runner mangles multi-line gates"; fi

if grep -q '\\' "$GATE_FILE"; then bad 'sshd.gate contains a backslash'
else ok 'sshd.gate contains no backslash'; fi

GATE="$(cat "$GATE_FILE")"
if printf '%s' "$GATE" | grep -q 'sshd -G'; then
  ok 'the gate asks sshd for the effective configuration (sshd -G)'
else
  bad 'the gate does not use sshd -G — it cannot be reading the effective config'
fi
if printf '%s' "$GATE" | grep -qE "grep [^|]*/etc/ssh/sshd_config( |'|\"|$)"; then
  bad 'the gate greps /etc/ssh/sshd_config directly — that is the stale check'
else
  ok 'the gate does not grep /etc/ssh/sshd_config directly'
fi

# ---------------------------------------------------------------------------
# 2. Behaviour, against fixture configurations.
#
# The gate is rewritten only to point sshd at a fixture instead of the real
# config. If that substitution does not apply, the run is aborted rather than
# silently testing the live host.
# ---------------------------------------------------------------------------
run_gate() {  # run_gate <main-config-path> -> exit status of the real gate
  local cfg="$1" g
  g="${GATE//sshd -G/sshd -G -f $cfg}"
  [ "$g" != "$GATE" ] || { printf 'FATAL: could not point the gate at %s\n' "$cfg" >&2; exit 1; }
  bash -c "$g"
}

fixture() {  # fixture <name> <main-body> <dropin-body|-->  -> prints config path
  local name="$1" main="$2" drop="$3"
  mkdir -p "$T/$name/dropins"
  { printf 'Include %s/%s/dropins/*.conf\n' "$T" "$name"; printf '%s\n' "$main"; } > "$T/$name/sshd_config"
  [ "$drop" = "--" ] || printf '%s\n' "$drop" > "$T/$name/dropins/10-h.conf"
  printf '%s/%s/sshd_config' "$T" "$name"
}

check() {  # check <desc> <config> <expected 0|1>
  local desc="$1" cfg="$2" want="$3" rc
  run_gate "$cfg"; rc=$?
  local wantword; [ "$want" = 0 ] && wantword=GREEN || wantword=RED
  local gotword;  [ "$rc"   = 0 ] && gotword=GREEN  || gotword=RED
  if [ "$rc" = "$want" ]; then ok "$desc -> $gotword"
  else bad "$desc -> $gotword (expected $wantword)"; fi
}

printf '\n\033[1m=== the gate tracks the effective configuration ===\033[0m\n'

# A. The real host's shape: bad directives still in sshd_config, drop-in wins.
#    The OLD gate called this RED. It is the state #138 asks for.
A="$(fixture hardened \
  'PasswordAuthentication yes
PermitRootLogin yes' \
  'PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no')"
check 'hardened by drop-in, bad lines still in sshd_config' "$A" 0

# B. Nothing hardened at all.
B="$(fixture open \
  'PasswordAuthentication yes
PermitRootLogin yes' '--')"
check 'no drop-in, passwords and root login enabled' "$B" 1

# C. THE DANGEROUS ONE. sshd_config reads `no`, but a drop-in included ABOVE it
#    says `yes` and therefore wins. The host is wide open. The old file-grep
#    gate would have called this GREEN.
C="$(fixture trap \
  'PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no' \
  'PasswordAuthentication yes
PermitRootLogin yes')"
check 'sshd_config says no but an outranking drop-in says yes' "$C" 1

# D. Partial: passwords closed, root login left open.
D="$(fixture partial \
  'PermitRootLogin yes' \
  'PasswordAuthentication no
KbdInteractiveAuthentication no')"
check 'passwords off but PermitRootLogin still yes' "$D" 1

# E. permitrootlogin prohibit-password is NOT no. Key-based root login is still
#    root login, and #138 asks for none.
E="$(fixture prohibitpw \
  '' \
  'PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password')"
check 'PermitRootLogin prohibit-password is not accepted as no' "$E" 1

# F. Keyboard-interactive left open — the second route to a password prompt
#    while UsePAM is yes.
F="$(fixture kbd \
  '' \
  'PasswordAuthentication no
PermitRootLogin no
KbdInteractiveAuthentication yes')"
check 'KbdInteractiveAuthentication yes is refused' "$F" 1

# G. sshd cannot parse the config at all. "We could not tell" must never be
#    GREEN.
G="$(fixture broken 'ThisIsNotADirective banana' '--')"
check 'an unparseable config fails closed' "$G" 1

# H. sshd binary missing entirely — same rule.
BROKEN_GATE="${GATE//\/usr\/sbin\/sshd/$T/definitely-not-sshd}"
if [ "$BROKEN_GATE" != "$GATE" ]; then
  bash -c "$BROKEN_GATE"; RC=$?
  if [ "$RC" -ne 0 ]; then ok 'a missing sshd binary fails closed -> RED'
  else bad 'a missing sshd binary produced GREEN'; fi
else
  bad 'could not substitute the sshd path to test the missing-binary case'
fi

printf '\n\033[1m===== GATE SUMMARY: %d passed, %d failed =====\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
