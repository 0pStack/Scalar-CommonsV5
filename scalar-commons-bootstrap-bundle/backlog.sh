#!/usr/bin/env bash
# First swarm backlog for Scalar Commons. Run from the repo root after the
# kit is committed:  bash backlog.sh
# Requires: gh CLI authenticated. Creates the `agent-task` label if missing.
set -euo pipefail
gh label create agent-task --color 1F4E79 --description "Claude swarm task" 2>/dev/null || true
gh label create full-ci --color BFD4F2 --description "Run full test suite on this PR" 2>/dev/null || true

new() { gh issue create --label agent-task --title "$1" --body "$2"; }

new "P0-1a: Transcribe the real emissions weight formula" \
"**Context:** SC-E1 protocol §4 + finding R-SC-0002. Phase-0 ran against an ASSUMED formula (MA-3); every result is conditional until the real one is transcribed.
**Acceptance:** docs/VERIFIED-CONSTANTS.md contains the exact weight formula from pallets/emissions/src/lib.rs (with file:line refs), every constant from workbook tab 03, and the sub-MinQualifyingVol stake-emission treatment. No code changes.
**Files in scope:** docs/ only (read everything).
**Constraints:** Report what IS, not what should be. Discrepancies vs the SC-E1 spec are findings, not fixes."

new "P0-1b: Verify era emission schedule and pool size per era" \
"**Context:** R-SC-0003/0004 break-evens (sybil ~2.78M, wash ~1.12M CMN/era) are pool-size-dependent. The actual per-era pool decides whether the guards are currently expired.
**Acceptance:** docs/VERIFIED-CONSTANTS.md section stating era length (blocks), per-era emission (CMN) by year, halving schedule, with file:line refs. Explicit comparison against both break-evens.
**Files in scope:** docs/ only."

new "Phase-0 v2: Re-run the SC-E1 simulator against the verified formula" \
"**Context:** experiments/sc-e1/SC-E1-phase0-sim.py, MA-1..MA-8. Depends on P0-1a/b.
**Acceptance:** MA block replaced with transcribed formula; sim re-run; SC-E1-PHASE0-V2-RESULTS.md with updated R-SC findings and break-evens; verdict JSON committed. Deltas vs v1 explicitly tabled.
**Files in scope:** experiments/sc-e1/ only.
**Constraints:** Pre-registered thresholds in the workbook remain untouched (not yet locked; only Keith locks)."

new "P0-2: sc-e1 fast-era chain-spec preset with uniform lambda scaling" \
"**Context:** protocol §8.2, HL-3. One unscaled block-denominated constant invalidates all time-dependent results.
**Acceptance:** sc-e1 preset in node/src/chain_spec.rs; a script or test that enumerates ALL block-denominated constants and asserts uniform lambda scaling; ci-fast green.
**Files in scope:** node/src/chain_spec.rs, scripts/, tests/.
**Constraints:** No changes to mainnet/testnet presets. Lambda value itself is OD-3 (Keith) — parameterize it."

new "P0-3: TypeScript agent SDK skeleton" \
"**Context:** protocol §8.3 — archetypes cannot exist without hands. Also the first real dogfood of the chain's agent-facing surface.
**Acceptance:** sdk/ package with register, stake, heartbeat, createEscrow, acceptEscrow, completeEscrow, submitOracle, vote, settleEra, claim + reads (eraInfo, weightOf, netPosition); polkadot-js based; integration tests green against a dev node in CI; no silent retries (retries logged).
**Files in scope:** sdk/, .github/workflows/ (test job only)."

new "P0-4: Runtime benchmarking for all seven custom pallets" \
"**Context:** protocol P0-4 / HL-2 — fees are part of the sybil defense; unbenchmarked weights mean the economics run at wrong prices.
**Acceptance:** benchmarking code + generated WeightInfo wired for agents, escrow, oracle, emissions, auto-params, orchestrator, constitution; placeholder weights removed; ci-full green.
**Files in scope:** pallets/*/src/, runtime/src/."

new "P0-5: Indexer measurement-plane reconciliation fixture" \
"**Context:** protocol §8.4 — the instrument must be validated before it measures. Chain events must reconcile 1:1 with indexer output.
**Acceptance:** scripted fixture drives a known extrinsic sequence on a dev node; test asserts indexer per-era export matches chain storage exactly; runs in CI.
**Files in scope:** indexer/, experiments/sc-e1/fixtures/."

new "OD-4 RFC: pool-scaled gaming costs (design doc, no code)" \
"**Context:** cross-cutting Phase-0 finding — every flat-CMN guard has a pool-size expiry. R-SC-0003/0004.
**Acceptance:** docs/rfcs/OD-4-pool-scaled-costs.md analyzing at least three mechanisms (pool-indexed MinQualifyingVol; percentage completion fee; W-weight capped by fees burned), each with break-even algebra, auto-params integration path, and attack surface it does NOT close. Recommendation section left for Keith.
**Files in scope:** docs/rfcs/ only."

new "Zombienet smoke test in CI" \
"**Context:** protocol §8.1. Prove the ephemeral-network path end-to-end before any counted run.
**Acceptance:** workflow spawns a 3-validator zombienet, runs 5 fast eras with a tiny population via the SDK, extracts indexer export, uploads artifact, green in CI.
**Files in scope:** experiments/sc-e1/, .github/workflows/sc-e1.yml.
**Constraints:** Depends on P0-2, P0-3, P0-5."

new "Archetype runners A-1..A-5" \
"**Context:** protocol §5 + workbook tab 02. Deterministic seeded loops; settle_era-with-backoff in every loop; no privileged keys.
**Acceptance:** experiments/sc-e1/archetypes/ implements all five against the SDK; replaying a manifest reproduces identical extrinsic sequences per seed.
**Files in scope:** experiments/sc-e1/.
**Constraints:** Depends on P0-3."

new "Knowledge-graph write-back bootstrap" \
"**Context:** parallel agent sessions coordinate through shared state, not conversation. Seed graph exists (91 entities / 120 relations).
**Acceptance:** knowledge/entities.jsonl + relations.jsonl seeded from the BLI-ecosystem generator output filtered to Scalar Commons entities, plus this experiment's artifacts and findings R-SC-0001..0006 and OD-1..OD-4; kg-updater agent conventions documented in knowledge/README.md.
**Files in scope:** knowledge/."

new "Analysis + verdict pipeline" \
"**Context:** protocol §8.4/§8.5, tab 04. Verdicts come from machine-readable files, never hand-summary.
**Acceptance:** experiments/sc-e1/analyze.py computes M1-M8 from indexer exports, reads thresholds ONLY from a run manifest, emits schema-validated verdict JSON; NC-2 and NC-3 runnable standalone; unit-tested.
**Files in scope:** experiments/sc-e1/."

echo "Backlog created. Human-only items NOT filed as issues: OD-1 thresholds, OD-2 repo visibility, OD-3 lambda, threshold LOCK, all merges."
