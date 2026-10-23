#!/usr/bin/env bash
# examples/matty-agent/setup-matty-agent.sh — one-time setup (beginner guide: examples/matty-agent/README.md).
#
# Installs the repository's npm workspace once at the root (one lockfile), builds
# the SDK and then the reference agent in agent/, runs the agent's
# offline tests, then either makes a new agent key (when no AGENT_MNEMONIC
# secret exists yet) or runs the read-only health check. Sends no transaction.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGENT="$ROOT/agent"

command -v node >/dev/null 2>&1 || { echo "Node.js is missing. In Replit, create the app from this repository and pick Node.js 22 or newer." >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm is missing (it comes with Node.js)." >&2; exit 1; }
major="$(node -p 'process.versions.node.split(".")[0]')"
if (( major < 22 )); then
  echo "Node $(node -v) is too old; the agent needs Node 22 or newer. In Replit, pick Node.js 22 or newer for this project." >&2
  exit 1
fi

step() { printf '\n==> %s\n' "$*"; }

step "1/4 installing the workspace packages at the repository root (about a minute)"
(cd "$ROOT" && npm ci --no-audit --no-fund --loglevel=error)

step "2/4 building the Scalar Commons SDK"
(cd "$ROOT" && npm run --silent build -w @scalar-commons/sdk)

step "3/4 building the agent"
(cd "$ROOT" && npm run --silent build -w @scalar-commons/reference-agent)

step "4/4 running the agent's self-tests"
(cd "$ROOT" && npm test --silent -w @scalar-commons/reference-agent)

chmod +x "$ROOT/examples/matty-agent/run-matty-agent.sh"
printf '\n  ✓ setup finished\n'

if [[ -z "${AGENT_MNEMONIC:-}" ]]; then
  node "$AGENT/dist/onboard.js" new-key
  printf '  Next: add the two secrets above (examples/matty-agent/README.md, STEP 4), open a NEW Shell tab, then run:\n\n    examples/matty-agent/run-matty-agent.sh start\n\n'
else
  printf '\n  Your AGENT_MNEMONIC secret is set. Health check (read-only):\n\n'
  bash "$ROOT/examples/matty-agent/run-matty-agent.sh" check
  printf '\n  Next:  examples/matty-agent/run-matty-agent.sh start\n\n'
fi
