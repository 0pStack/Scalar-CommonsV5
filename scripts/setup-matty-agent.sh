#!/usr/bin/env bash
# scripts/setup-matty-agent.sh — one-time setup (beginner guide: README-MATTY.md).
#
# Installs and builds the SDK and the reference agent in agent/ (the documented
# native build: npm ci, npm run setup:sdk, npm run build), runs the agent's
# offline tests, then either makes a new agent key (when no AGENT_MNEMONIC
# secret exists yet) or runs the read-only health check. Sends no transaction.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT="$ROOT/agent"

command -v node >/dev/null 2>&1 || { echo "Node.js is missing. In Replit, create the app from this repository and pick Node.js." >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm is missing (it comes with Node.js)." >&2; exit 1; }
major="$(node -p 'process.versions.node.split(".")[0]')"
if (( major < 18 )); then
  echo "Node $(node -v) is too old; the agent needs Node 18 or newer." >&2
  exit 1
fi

step() { printf '\n==> %s\n' "$*"; }

step "1/4 installing the agent's packages (about a minute)"
(cd "$AGENT" && npm ci --no-audit --no-fund --loglevel=error)

step "2/4 building the Scalar Commons SDK"
(cd "$AGENT" && npm run --silent setup:sdk)

step "3/4 building the agent"
(cd "$AGENT" && npm run --silent build)

step "4/4 running the agent's self-tests"
(cd "$AGENT" && npm test --silent)

chmod +x "$ROOT/scripts/run-matty-agent.sh"
printf '\n  ✓ setup finished\n'

if [[ -z "${AGENT_MNEMONIC:-}" ]]; then
  node "$AGENT/dist/onboard.js" new-key
  printf '  Next: add the two secrets above (README-MATTY.md, STEP 4), open a NEW Shell tab, then run:\n\n    scripts/run-matty-agent.sh start\n\n'
else
  printf '\n  Your AGENT_MNEMONIC secret is set. Health check (read-only):\n\n'
  bash "$ROOT/scripts/run-matty-agent.sh" check
  printf '\n  Next:  scripts/run-matty-agent.sh start\n\n'
fi
