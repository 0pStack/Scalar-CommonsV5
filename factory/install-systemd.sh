#!/usr/bin/env bash
# factory/install-systemd.sh — install the factory's systemd USER units.
#
#   ./factory/install-systemd.sh [--dry-run] [--with-dispatch]
#
# USER units only — nothing here needs root. Lingering is what makes "24/7"
# real: without it, systemd tears down the user manager when you log out and
# every timer dies with it.
#
# By default installs the watchdog (30 min) and the nightly digest (05:30 UTC).
# The dispatcher timer is Stage 2 and is only installed with --with-dispatch;
# even then dispatch.sh still requires ENABLE_DISPATCH=true to do anything.

set -uo pipefail

FACTORY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/common.sh
. "$FACTORY_DIR/lib/common.sh"

DRY=0
WITH_DISPATCH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run|-n)     DRY=1 ;;
    --with-dispatch)  WITH_DISPATCH=1 ;;
    -h|--help)        sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

UNIT_DIR="$HOME/.config/systemd/user"
UNITS=(factory-watchdog.service factory-watchdog.timer
        factory-digest.service  factory-digest.timer)
TIMERS=(factory-watchdog.timer factory-digest.timer)
if [ "$WITH_DISPATCH" = "1" ]; then
  UNITS+=(factory-dispatch.service factory-dispatch.timer)
  TIMERS+=(factory-dispatch.timer)
fi

run() {
  if [ "$DRY" = "1" ]; then printf 'WOULD: %s\n' "$*"; else log "$*"; "$@"; fi
}

printf '\n=== installing factory systemd user units ===\n'
printf 'unit dir: %s\n' "$UNIT_DIR"
printf 'units:    %s\n\n' "${UNITS[*]}"

run mkdir -p "$UNIT_DIR"
for u in "${UNITS[@]}"; do
  src="$FACTORY_DIR/systemd/$u"
  [ -f "$src" ] || die "missing unit file $src"
  run cp "$src" "$UNIT_DIR/$u"
done

# Lingering: keeps the user manager (and therefore the timers) alive across
# logout and reboot. This is the difference between a factory and a foreground
# script that dies when the terminal closes.
if loginctl show-user "$USER" 2>/dev/null | grep -q 'Linger=yes'; then
  log "lingering already enabled for $USER"
else
  printf '\nLingering is NOT enabled. Without it the timers stop when you log out.\n'
  run loginctl enable-linger "$USER"
fi

run systemctl --user daemon-reload
for t in "${TIMERS[@]}"; do
  run systemctl --user enable "$t"
  run systemctl --user start "$t"
done

if [ "$DRY" = "1" ]; then
  printf '\nDry run complete; nothing installed.\n\n'
  exit 0
fi

printf '\n--- systemctl --user list-timers ---\n'
systemctl --user list-timers --all 'factory-*' || true
printf '\nInstalled. Useful commands:\n'
printf '  systemctl --user list-timers "factory-*"\n'
printf '  systemctl --user status factory-watchdog.service\n'
printf '  journalctl --user -u factory-watchdog.service -n 50\n'
printf '  systemctl --user start factory-digest.service   # run a digest now\n\n'
