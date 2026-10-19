#!/usr/bin/env bash
# Auto-format Rust files after any agent edit. Reads hook JSON from stdin.
f=$(jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -z "$f" ] && exit 0
case "$f" in
  *.rs) command -v rustfmt >/dev/null && rustfmt --edition 2021 "$f" 2>/dev/null ;;
esac
exit 0
