#!/usr/bin/env bash
# deploy/hardening/apply.sh — install the sshd hardening drop-in.
#
#   sudo ./deploy/hardening/apply.sh --dry-run   # show everything, change nothing
#   sudo ./deploy/hardening/apply.sh             # install, validate, reload
#
# Turns off password authentication, keyboard-interactive authentication and
# root login on this host. See sshd.conf for why, and
# TESTNETAUDIT.md §6 I-24 / issue #138 for how it was found.
#
# THE FAILURE MODE THIS SCRIPT EXISTS TO PREVENT
#
# Disabling password login on a box you reach BY password locks you out of it
# permanently, and on a rented host that means a rescue console or a rebuild.
# So every precondition below is checked BEFORE anything is written, and any
# one of them failing aborts with a loud message and a non-zero exit. The
# script never writes a partial configuration: it validates the merged config
# with `sshd -t` and only then reloads, and if validation fails it restores
# what was there before.
#
# It also does not trust that installing a file changed a setting. After the
# reload it re-reads the EFFECTIVE configuration with `sshd -G` and fails if
# any of the three values is not what was asked for.

set -uo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SRC_DIR/sshd.conf"
DEST_DIR="/etc/ssh/sshd_config.d"
DEST="$DEST_DIR/10-scalar-hardening.conf"
MAIN="/etc/ssh/sshd_config"

# sshd lives in /usr/sbin, which is not on a normal user's PATH — and --dry-run
# is meant to be runnable without sudo. Resolve it once rather than hoping.
SSHD="$(command -v sshd 2>/dev/null || true)"
[ -n "$SSHD" ] || SSHD=/usr/sbin/sshd
[ -x "$SSHD" ] || { printf 'FATAL: cannot find the sshd binary (looked for sshd on PATH and %s)\n' "$SSHD" >&2; exit 1; }

DRY_RUN=0
for a in "$@"; do
  case "$a" in
    --dry-run|-n) DRY_RUN=1 ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$a" >&2; exit 2 ;;
  esac
done

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\n'; red "REFUSING TO PROCEED — $*"; printf '\n'; exit 1; }

FAILED=0
check() {  # check <description> <0|1 ok>
  if [ "$2" = "0" ]; then printf '  \033[32mOK  \033[0m %s\n' "$1"
  else printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; fi
}

bold ""
bold "=== sshd hardening — preconditions ==="
printf '\n'

# ---------------------------------------------------------------- 1. source --
[ -f "$SRC" ] || die "$SRC not found — run this from a checkout of the repository."
check "drop-in source present: $SRC" 0

# ------------------------------------------------- 2. THE key precondition ---
# Somebody must be able to log in without a password AFTER this runs. The
# account that matters is the one that owns this checkout, not root and not
# whoever is running sudo, so resolve its home directly.
TARGET_USER="${SUDO_USER:-$(id -un)}"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
# Overridable ONLY so deploy/hardening/test-apply.sh can drive the missing
# / empty / comments-only cases against this script instead of a copy of it.
AK="${SSHD_HARDENING_AUTHORIZED_KEYS:-$TARGET_HOME/.ssh/authorized_keys}"

if [ -z "$TARGET_HOME" ]; then
  check "resolve home directory of '$TARGET_USER'" 1
elif [ ! -f "$AK" ]; then
  check "$AK exists" 1
  printf '       There is no authorized_keys file for %s. Turning off password\n' "$TARGET_USER"
  printf '       authentication now would lock every human out of this host.\n'
elif [ ! -s "$AK" ]; then
  check "$AK is non-empty" 1
  printf '       The file exists but is empty. Same outcome: no way back in.\n'
else
  # `grep -c` PRINTS 0 and EXITS 1 when nothing matches, so `|| echo 0` would
  # append a second line and make NKEYS "0\n0" — which then fails the numeric
  # test with an error and falls through to the OK branch. That bug was in the
  # first draft of this file and it passed a comments-only authorized_keys,
  # i.e. it would have locked the operator out via the check that exists to
  # stop exactly that. Take grep's output as-is and default only if empty.
  NKEYS="$(grep -c '^[^#[:space:]]' "$AK" 2>/dev/null)"
  [ -n "$NKEYS" ] || NKEYS=0
  if [ "$NKEYS" -lt 1 ]; then
    check "$AK contains at least one key (found $NKEYS)" 1
    printf '       The file has content but no usable key lines (all blank or comments).\n'
  else
    check "$AK holds $NKEYS key(s) for user '$TARGET_USER'" 0
  fi
fi

# ------------------------------------------- 3. pubkey auth must be enabled --
# Turning off passwords and keyboard-interactive while public-key auth is off
# would leave no enabled method at all.
PUBKEY="$("$SSHD" -G -f "$MAIN" 2>/dev/null | awk '$1=="pubkeyauthentication"{print $2}')"
if [ "$PUBKEY" = "yes" ]; then
  check "PubkeyAuthentication is enabled (the only method left after this)" 0
else
  check "PubkeyAuthentication is enabled (got '${PUBKEY:-unreadable}')" 1
  printf '       With passwords and keyboard-interactive off and pubkey off too,\n'
  printf '       there would be no working authentication method.\n'
fi

# ------------------------------------------------ 4. the Include must exist --
# Without it the drop-in directory is never read and this whole exercise is
# theatre: the file lands, nothing changes, and the host looks hardened.
if grep -qE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf' "$MAIN" 2>/dev/null; then
  INCLUDE_LINE="$(grep -nE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf' "$MAIN" | head -1 | cut -d: -f1)"
  check "sshd_config includes $DEST_DIR (line $INCLUDE_LINE)" 0
  # sshd takes the FIRST value it obtains, so the Include must come before any
  # later line that sets these keywords, or the drop-in is silently outranked.
  for kw in PasswordAuthentication PermitRootLogin KbdInteractiveAuthentication; do
    LAST="$(grep -nE "^[[:space:]]*${kw}[[:space:]]" "$MAIN" 2>/dev/null | tail -1 | cut -d: -f1)"
    if [ -n "$LAST" ] && [ "$LAST" -lt "$INCLUDE_LINE" ]; then
      check "$kw at line $LAST is BEFORE the Include — the drop-in cannot win" 1
    fi
  done
else
  check "sshd_config includes $DEST_DIR" 1
  printf '       Add this line near the TOP of %s:\n' "$MAIN"
  printf '           Include /etc/ssh/sshd_config.d/*.conf\n'
  printf '       Without it the drop-in is inert and the host is not hardened.\n'
fi

# ------------------------------------------------------------ 5. privileges --
if [ "$DRY_RUN" = "1" ]; then
  check "root privileges (not needed for --dry-run)" 0
elif [ "$(id -u)" -eq 0 ]; then
  check "running as root" 0
else
  check "running as root (re-run with sudo)" 1
fi

printf '\n'
[ "$FAILED" -eq 0 ] || die "one or more preconditions failed. Nothing was written."
grn "All preconditions passed."

# ---------------------------------------------------------------- the plan ---
printf '\n'
bold "=== what this will do ==="
printf '\n'
printf '  install : %s\n' "$SRC"
printf '       to : %s (mode 0644, root:root)\n' "$DEST"
printf '  then    : sshd -t          (validate the MERGED configuration)\n'
printf '  then    : systemctl reload ssh\n'
printf '  then    : sshd -G          (verify the values actually took effect)\n'
printf '\n'
printf '  effective settings now:\n'
"$SSHD" -G -f "$MAIN" 2>/dev/null \
  | grep -iE '^(passwordauthentication|permitrootlogin|kbdinteractiveauthentication) ' \
  | sed 's/^/       /'
printf '\n'
printf '  contents to be installed:\n'
grep -vE '^[[:space:]]*(#|$)' "$SRC" | sed 's/^/       /'
printf '\n'

if [ "$DRY_RUN" = "1" ]; then
  bold "DRY RUN — nothing was written, nothing was reloaded."
  printf '\n'
  exit 0
fi

bold "=== KEEP THIS SESSION OPEN ==="
printf '\n'
printf '  A reload does not drop existing connections. Before you close this one,\n'
printf '  open a SECOND terminal and confirm you can still get in:\n\n'
printf '      ssh %s@<this-host>\n\n' "$TARGET_USER"
printf '  If that fails you still have this session to undo it with:\n\n'
printf '      sudo rm %s && sudo systemctl reload ssh\n\n' "$DEST"

# ----------------------------------------------------------------- install ---
BACKUP=""
if [ -f "$DEST" ]; then
  BACKUP="$DEST.bak.$(date -u +%Y%m%dT%H%M%SZ)"
  cp -p "$DEST" "$BACKUP" || die "could not back up the existing $DEST"
  printf 'backed up existing drop-in to %s\n' "$BACKUP"
fi

install -d -m 0755 -o root -g root "$DEST_DIR" || die "could not create $DEST_DIR"
install -m 0644 -o root -g root "$SRC" "$DEST"  || die "could not write $DEST"
printf 'installed %s\n' "$DEST"

# ---------------------------------------------------------------- validate ---
# `sshd -t` parses the whole merged configuration, drop-ins included. If it is
# unhappy, put things back exactly as they were rather than reloading a broken
# config — a reload with a bad config is how a host stops accepting ssh at all.
if ! TESTOUT="$("$SSHD" -t 2>&1)"; then
  printf '\n%s\n' "$TESTOUT"
  if [ -n "$BACKUP" ]; then mv -f "$BACKUP" "$DEST"; else rm -f "$DEST"; fi
  die "sshd -t rejected the merged configuration. The drop-in was removed and nothing was reloaded."
fi
grn "sshd -t: configuration is valid"

# ------------------------------------------------------------------ reload ---
if ! RELOADOUT="$(systemctl reload ssh 2>&1)"; then
  printf '\n%s\n' "$RELOADOUT"
  if [ -n "$BACKUP" ]; then mv -f "$BACKUP" "$DEST"; else rm -f "$DEST"; fi
  systemctl reload ssh >/dev/null 2>&1 || true
  die "systemctl reload ssh failed. The drop-in was removed and the previous config reloaded."
fi
grn "systemctl reload ssh: done"

# ------------------------------------------------------------------ verify ---
# Installing a file is not the same as changing a setting. Read back what sshd
# will actually use and fail loudly if any of the three is not what was asked.
printf '\n'
bold "=== effective settings after reload ==="
printf '\n'
VERIFY_FAILED=0
expect() {  # expect <keyword> <wanted>
  local got; got="$("$SSHD" -G -f "$MAIN" 2>/dev/null | awk -v k="$1" '$1==k{print $2}')"
  if [ "$got" = "$2" ]; then printf '  \033[32mOK  \033[0m %s = %s\n' "$1" "$got"
  else printf '  \033[31mFAIL\033[0m %s = %s (wanted %s)\n' "$1" "${got:-unreadable}" "$2"; VERIFY_FAILED=1; fi
}
expect passwordauthentication no
expect kbdinteractiveauthentication no
expect permitrootlogin no
printf '\n'

if [ "$VERIFY_FAILED" -ne 0 ]; then
  die "the drop-in installed but did not take effect. Check for another file in \
$DEST_DIR that sorts earlier, or a directive before the Include in $MAIN. \
The file is still in place; remove it with: rm $DEST && systemctl reload ssh"
fi

grn "sshd is hardened: no passwords, no keyboard-interactive, no root login."
printf '\n'
printf 'Now go and confirm the second terminal still works before closing this one.\n\n'
