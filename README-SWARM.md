# Scalar Commons — Swarm Bootstrap Bundle (v2, complete)

**This bundle unzips directly at the repo root.** Every path is final — no
rearranging. Supersedes the earlier swarm-kit zip (which lacked the SC-E1
experiment files, .mcp.json, and the knowledge graph seed).

## Contents (all repo-relative)

| Path | What it is |
|---|---|
| `CLAUDE.md` | First principles + hard rules (v3/v4 audit history encoded) |
| `.claude/settings.json` | Agent permission allowlist + deny rules + hooks |
| `.claude/hooks/post-edit.sh` | Auto-rustfmt on every agent edit |
| `.claude/agents/tokenomics-security-reviewer.md` | Econ/security review subagent (read-only) |
| `.claude/agents/test-runner.md` | Evidence-based test subagent (Haiku) |
| `.claude/agents/kg-updater.md` | Knowledge-graph write-back subagent |
| `.mcp.json` | Project MCP: Context7 (live library docs). KG server slot documented in knowledge/README.md |
| `.github/workflows/claude.yml` | Swarm engine: agent-task label / @claude -> agent -> PR |
| `.github/workflows/ci-fast.yml` | Every-PR gate: fmt, clippy, check, indexer tests |
| `.github/workflows/ci-full.yml` | Merge gate: full workspace tests |
| `.github/ISSUE_TEMPLATE/agent-task.yml` | Forces context/acceptance/file-scope on every task |
| `experiments/sc-e1/SC-E1-SEEV-protocol-spec.md` | The experiment protocol (draft 1) |
| `experiments/sc-e1/SC-E1-SEEV-workbook.xlsx` | 12-tab workbook — thresholds NOT locked |
| `experiments/sc-e1/SC-E1-PHASE0-RESULTS.md` | Findings R-SC-0001..0006 (model results) |
| `experiments/sc-e1/SC-E1-phase0-sim.py` | Phase-0 simulator (assumptions MA-1..MA-8) |
| `experiments/sc-e1/SC-E1-phase0-verdicts.json` | Machine-readable Phase-0 verdicts |
| `knowledge/README.md` | Graph conventions + KG-server wiring instructions |
| `knowledge/entities.jsonl` | Seed graph: 35 entities (findings, decisions, gates, pallets, artifacts, people) |
| `knowledge/relations.jsonl` | Seed graph: 28 relations |
| `backlog.sh` | Files the first 12 agent-task issues via gh (run once from repo root) |

## Order of operations

1. Unzip at repo root -> one PR: "swarm bootstrap". Human-review and merge.
2. Browser: install the Claude GitHub App (github.com/apps/claude), scope to
   this repo. Add `ANTHROPIC_API_KEY` in Settings -> Secrets -> Actions.
3. Branch protection on main: require ci-fast + one human review; agents
   never merge; no force-push.
4. `bash backlog.sh` (Codespaces or Cowork terminal with gh auth).
5. Label the P0-1a issue `agent-task`. Swarm is on.
6. Restart any open Claude Code session so .claude/ and .mcp.json load.

## Division of labor
Agents: implement issues, open PRs, review, test, maintain knowledge/.
Keith only: OD-1/OD-2/OD-3/OD-4, locking workbook tab 01 thresholds, merges.

## Verify on install
- anthropics/claude-code-action@v1 input names vs the action README.
- Actions minutes are unlimited only on public repos (OD-2).
- backlog.sh assumes gh CLI is authenticated with repo scope.
