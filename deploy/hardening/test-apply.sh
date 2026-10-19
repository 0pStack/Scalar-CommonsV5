#!/usr/bin/env bash
# deploy/hardening/test-apply.sh — prove apply.sh refuses to lock you out.
#
# apply.sh turns off every password-based way into this host. If its
# authorized_keys precondition is wrong in the permissive direction, the result
# is not a failed test — it is a machine nobody can log into, which on a rented
# host means a rescue console or a rebuild. So the refusal gets a test.
#
# It is not hypothetical. The first draft of that check read:
#
#     NKEYS="$(grep -c '^[^#[:space:]]' "$AK" 2>/dev/null || echo 0)"
#
# `grep -c` PRINTS 0 and EXITS 1 when nothing matches, so both sides ran and
# NKEYS became "0\n0". The numeric comparison then errored and fell through to
# the OK branch — an authorized_keys containing nothing but comments PASSED.
# Case 4 below is that exact input.
#
# Everything here runs --dry-run against the REAL script. Nothing is installed,
# /etc is never written, and sshd is never reloaded.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLY="$HERE/apply.sh"
[ -x "$APPLY" ] || { printf 'FATAL: %s not found or not executable\n' "$APPLY" >&2; exit 1; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

run() {  # run <authorized_keys path>  -> stdout+stderr, sets RC
  SSHD_HARDENING_AUTHORIZED_KEYS="$1" "$APPLY" --dry-run 2>&1
}

expect_refusal() {  # expect_refusal <desc> <ak-path> <expected-substring>
  local desc="$1" ak="$2" want="$3" out rc
  out="$(run "$ak")"; rc=$?
  if [ "$rc" -eq 0 ]; then
    bad "$desc — script exited 0; it must refuse"
    return
  fi
  if printf '%s' "$out" | grep -q 'REFUSING TO PROCEED'; then
    if printf '%s' "$out" | grep -qF "$want"; then
      ok "$desc — refused, and said why"
    else
      bad "$desc — refused but did not mention '$want'"
    fi
  else
    bad "$desc — non-zero exit without the loud refusal banner"
  fi
  if printf '%s' "$out" | grep -qE 'installed /etc|systemctl reload'; then
    bad "$desc — it claimed to touch /etc despite refusing"
  fi
}

printf '\n\033[1m=== apply.sh refuses without a usable authorized_keys ===\033[0m\n'

# 1. no file at all
expect_refusal 'authorized_keys missing' "$T/nope/.ssh/authorized_keys" 'exists'

# 2. file present but zero bytes
mkdir -p "$T/empty/.ssh"; : > "$T/empty/.ssh/authorized_keys"
expect_refusal 'authorized_keys empty' "$T/empty/.ssh/authorized_keys" 'non-empty'

# 3. whitespace only — non-zero size, still no key
mkdir -p "$T/blank/.ssh"; printf '\n\n   \n' > "$T/blank/.ssh/authorized_keys"
expect_refusal 'authorized_keys is only whitespace' "$T/blank/.ssh/authorized_keys" 'at least one key'

# 4. comments only — THE REGRESSION. Non-zero size, no usable key line.
mkdir -p "$T/comments/.ssh"
printf '# my laptop key goes here one day\n# ssh-ed25519 AAAA... someone@example\n' \
  > "$T/comments/.ssh/authorized_keys"
expect_refusal 'authorized_keys is only comments (the grep -c regression)' \
  "$T/comments/.ssh/authorized_keys" 'at least one key'

printf '\n\033[1m=== and it proceeds when there IS a key ===\033[0m\n'

# 5. a real-looking key line
mkdir -p "$T/good/.ssh"
printf '# a comment\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP0000000000000000000000000000000000000000 dev@host\n' \
  > "$T/good/.ssh/authorized_keys"
OUT="$(run "$T/good/.ssh/authorized_keys")"; RC=$?
if [ "$RC" -eq 0 ]; then ok 'a valid authorized_keys passes the preconditions'
else bad "a valid authorized_keys was refused (exit $RC): $(printf '%s' "$OUT" | tail -3 | tr '\n' ' ')"; fi
if printf '%s' "$OUT" | grep -q 'holds 1 key(s)'; then
  ok 'it counted exactly the one usable key, ignoring the comment'
else
  bad "wrong key count: $(printf '%s' "$OUT" | grep -i 'key(s)' | head -1)"
fi
if printf '%s' "$OUT" | grep -q 'DRY RUN — nothing was written'; then
  ok 'the passing case still wrote nothing'
else
  bad 'the passing case did not confirm it wrote nothing'
fi

printf '\n\033[1m===== APPLY.SH SUMMARY: %d passed, %d failed =====\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
