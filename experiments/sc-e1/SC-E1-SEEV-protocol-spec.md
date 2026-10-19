# SC-E1 — Scalar Commons Emissions-Economy Validation (SEEV)

| Field | Value |
|---|---|
| Experiment ID | SC-E1 |
| Program | Scalar Commons (distinct from DLT program E0–E7; no dependency on the messaging bridge, VCS, or patent work) |
| Status | DESIGNED — not executed |
| Version | draft 1 (2026-07-02) |
| Standard | Held to RESEARCH-PRODUCTION-STANDARD: pre-registered falsifiable predictions, negative controls, named hard limits, reproducibility |
| Companion | SC-E1-SEEV-workbook.xlsx (12 tabs) |
| System under test | Scalar Commons v4 runtime — pallets: agents, escrow, oracle, emissions, auto-params, orchestrator, constitution |

---

## 1. Purpose and central claim

Scalar Commons was built on a set of economic first principles that are currently **implemented but untested**. SC-E1 converts each principle into a falsifiable prediction and tests it on ephemeral multi-validator networks populated by scripted synthetic agents.

**Central claim under test (C-1):** *Under the v4 emissions design, an agent performing verifiable work earns materially more than an equally capitalized passive staker, known gaming strategies are net-unprofitable at genesis parameters, and the economic core of the chain progresses permissionlessly without privileged intervention.*

C-1 decomposes into three sub-claims, tested in three phases:

- **C-1a (thesis):** emissions reward verifiable work, not raw stake.
- **C-1b (gaming resistance):** the audited guards (MinQualifyingVol, VelocityBonusBps cap, self-link guard, GovVoteVerifier, burned base fee, completion fee) make sybil farming, wash trading, and oracle collusion net-negative.
- **C-1c (permissionless liveness):** era settlement occurs from participant incentive alone, indefinitely, with no root or scripted-privileged calls.

## 2. Scope and non-goals

**In scope:** emissions weighting, escrow completion economics, oracle accuracy bonus, governance participation weight, velocity bonus, era settlement liveness, supply-cap integrity, earnings concentration.

**Out of scope (explicitly):** consensus-level attacks (nothing-at-stake, long-range, equivocation), network partitions and latency realism, the messaging bridge / VCS / any patent-adjacent subject matter, fiat-denominated attack economics (no CMN market price exists), auto-params adaptive behavior beyond logging (frozen for runs unless a run explicitly enables it), real adaptive adversaries (archetypes are scripted — see HL-1).

## 3. Preconditions (P0 gates — must be green before any run is pre-registration-locked)

| Gate | Requirement | Rationale |
|---|---|---|
| P0-1 | Every constant in workbook tab 03 verified against the current runtime source and marked VERIFIED | This spec's constants come from session history and may be stale (HL-8) |
| P0-2 | Fast-era chain spec exists with a single scale factor λ applied to **every** block-denominated constant (era length, rank windows, INCENTIVE_FRESHNESS_BLOCKS, heartbeat windows, EraNotDue horizon) | One unscaled constant invalidates all time-dependent results (HL-3) |
| P0-3 | TypeScript agent SDK implements the minimal API of §8.3 with integration tests against a dev node | Archetypes cannot exist without hands |
| P0-4 | Extrinsic weights benchmarked (`runtime-benchmarks`) **or** HL-2 formally accepted in the run's pre-registration record | Fee-dependent economics measured at wrong prices otherwise |
| P0-5 | Indexer measurement-plane check passes: event counts from the 24-endpoint API reconcile 1:1 with chain storage for a scripted fixture | The instrument must be validated before it measures anything |
| P0-6 | Predictions P1–P8 numeric thresholds locked (workbook tab 01 status → LOCKED) **before** the first counted run; open decisions OD-1..OD-3 resolved | Pre-registration discipline; no post-hoc thresholds |

## 4. System under test — economic constants

Values below are **from v3/v4 build-session history** and are inputs to verification (P0-1), not authority. The workbook (tab 03) is the single source of truth once verified.

| Constant | Session-history value | Notes |
|---|---|---|
| Token unit | 1 CMN = 10^12 plancks | |
| Supply cap | 100,000,000,000 CMN | Absolute; invariant M8 checks every era |
| Genesis mint | 18,000,000,000 CMN | |
| BASE_TX_FEE | 10 CMN, fully burned | Sybil cost floor; deflationary |
| AgreementCompletionFee | 100 CMN | Wash-trade cost floor |
| MinQualifyingVol | 50 CMN era escrow volume | Floor-emission qualification gate |
| VelocityBonusBps cap | +30% | Capital-velocity weight multiplier ceiling |
| Genesis validator stake | 10,000 CMN | Baseline earner ~33,333 CMN/era at floor (v4 audit) |
| MaxStake | 1,000,000 CMN | |
| Optimized-earner multiple | ~15× genesis baseline | Max stake + Rank 3 + oracle + gov (v4 audit finding) |
| Rank 3 gate | 50 completions / 30 days + oracle accuracy | Block-denominated → scales with λ |
| settle_era | permissionless (`ensure_signed`), EraNotDue, EraStartBlock, double-settlement guard F-04 | The liveness mechanism under test in Phase C |

**Weight formula (to verify at P0-1):** effective weight = f(stake, rank multiplier, oracle accuracy bonus, governance participation, velocity bonus ≤ +30%), gated by MinQualifyingVol for floor emissions. The exact functional form must be transcribed from `pallets/emissions/src/lib.rs` into tab 03 before lock.

## 5. Archetypes (the synthetic agent population)

All archetypes are deterministic scripted loops over the SDK, parameterized per run, seeded per cohort member. **No archetype ever holds a privileged key.** Full behavioral specs in workbook tab 02.

| ID | Archetype | Loop (per era) | Tests |
|---|---|---|---|
| A-1 | HONEST-WORKER | register → stake s_w → heartbeat → accept/complete n real escrows with counterparties → honest oracle votes → governance votes → claim | C-1a upside |
| A-2 | PASSIVE-STAKER | register → stake s_p (up to MaxStake) → heartbeat → claim. No work. | C-1a baseline |
| A-3 | SYBIL-FARM | N accounts (default 1,000), minimum stake each, heartbeat-only, attempt floor qualification | C-1b vs burned fees |
| A-4 | WASH-TRADER | two colluding accounts self-escrowing volume ≥ MinQualifyingVol per era to fabricate qualification + velocity bonus | C-1b vs completion+tx fees; self-link guard forces two-account structure |
| A-5 | ORACLE-COLLUDER | cohort of k accounts coordinating oracle answers to farm the accuracy bonus | C-1b oracle surface |

**Equal-endowment rule (critical for P1):** A-1 and A-2 cohorts receive identical total CMN endowments. A worker splits endowment between stake and working capital; a staker stakes it. Any earnings difference is then attributable to *work*, not capital.

**Settlement rule:** no run scripts a dedicated settler. Every archetype's loop includes "call `settle_era` if era is due and unsettled" with a per-agent random backoff — settlement must emerge from the same incentive the mainnet will rely on.

## 6. Run matrix

Each run × 3 seeds minimum. Full matrix with config deltas in workbook tab 05.

| Run | Population | Config delta | Eras | Tests |
|---|---|---|---|---|
| RUN-A | A-1 cohorts at graded work rates + A-2 | none (genesis params) | ≥ 20 | P1, P2, P8, M8 |
| RUN-B | identical to RUN-A | **work-weighting disabled** (stake-only weights) | ≥ 20 | P3 (negative control) |
| RUN-C | RUN-A population + A-3 | none | ≥ 10 | P4 |
| RUN-D | RUN-A population + A-4 | none | ≥ 10 | P5 |
| RUN-E | RUN-A population + A-5 at k = 10%, 20% of oracle set | none | ≥ 10 | P6 |
| RUN-F | RUN-A population, reduced telemetry | none; **zero privileged calls permitted** | ≥ 100 | P7 (liveness soak) |

## 7. Pre-registered predictions

Thresholds below are **proposed defaults** — adjustable by Keith until P0-6 lock, immutable after. Verdict rules in §12.

| ID | Prediction (falsifiable statement) | Threshold | Falsifies |
|---|---|---|---|
| P1 | Equal-endowment worker/staker per-capita earnings ratio | ≥ 2.0 by era 10 (RUN-A) | C-1a |
| P2 | Earnings increase monotonically with completed escrow volume across worker cohorts | Spearman ρ ≥ 0.8 (RUN-A) | C-1a dose-response |
| P3 | **Negative control:** with work-weighting disabled, P1 ratio ∈ [0.8, 1.2] and P2 collapses to ρ ≤ 0.3 (RUN-B) | as stated | *the instrument* — if RUN-A and RUN-B are indistinguishable, the harness cannot validate anything and all other results are void |
| P4 | 1,000-account sybil farm cumulative net position (emissions − burned fees) | < 0 by era 3 (RUN-C) | C-1b sybil guard |
| P5 | Wash-trade cycle: incremental emissions from qualification + velocity bonus < completion fee + tx fees per qualifying cycle | net < 0 at genesis params (RUN-D) | C-1b volume gate |
| P6 | Oracle-colluding cohort at k ≤ 20% of oracle set gains earnings uplift vs honest baseline | ≤ 5% uplift (RUN-E) | C-1b oracle guard |
| P7 | ≥ 100 consecutive eras settle with zero privileged/manual triggers; p95 settlement lag ≤ 10% of era length after era end (RUN-F) | as stated | C-1c |
| P8 | Earnings concentration at era 20: top-earner share ≤ T% and Gini ≤ G | **OD-1: T, G must be set by Keith before lock** | design-acceptability, not correctness |

A prediction *failing* is a **result**, not a program failure: P4/P5/P6 failures quantify the exact parameter gap (fee, gate, cap) and feed governance-parameter changes via auto-params, then re-run.

## 8. Harness specification

### 8.1 Network
Zombienet-spawned ephemeral 3-validator networks inside GitHub Actions (free on public repos; OD-2). One network per run per seed; destroyed after data extraction. No persistent testnet is required by SC-E1.

### 8.2 Fast-era chain spec
Dedicated `sc-e1` chain-spec preset with scale factor λ (OD-3; proposed λ such that one era ≈ 2–5 min wall-clock) applied uniformly per P0-2. The λ scaling table is workbook tab 03 column "scales with λ".

### 8.3 Agent SDK (minimal API)
TypeScript, polkadot-js based: `register`, `stake`, `heartbeat`, `createEscrow`, `acceptEscrow`, `completeEscrow`, `submitOracle`, `vote`, `settleEra`, `claim`, plus read APIs (`eraInfo`, `weightOf`, `netPosition`). Every extrinsic returns the inclusion block + events; the SDK never retries silently (retries are logged — they are fee-bearing economic events).

### 8.4 Measurement plane
The Node.js indexer is the instrument: per-era CSV/JSONL exports of per-account earnings, fees burned, escrow volume, oracle scores, settlement events. P0-5 validates it against chain storage before first use. The analysis script (Python, pinned deps) computes M1–M8 and emits a machine-readable verdict file per run.

### 8.5 Metrics
M1 per-account net position; M2 equal-endowment worker/staker ratio; M3 Spearman ρ(volume, earnings); M4 sybil aggregate net/era; M5 wash-cycle unit economics (see workbook tab 06 break-even model); M6 settlement-lag distribution; M7 Gini + top-k share; M8 total-issuance-vs-cap invariant (hard fail if ever violated — this is a CRITICAL finding, not a data point).

## 9. Negative controls

| ID | Control | Validates |
|---|---|---|
| NC-1 | RUN-B stake-only weights (P3) | that the metrics detect work-weighting at all |
| NC-2 | Zero-work run: A-2 only population; assert worker-metrics pipeline reports null/ratio-undefined rather than fabricating signal | analysis-script honesty on empty signal |
| NC-3 | Label-shuffle: recompute M2/M3 on RUN-A data with archetype labels randomly permuted; ρ must collapse toward 0 | that correlations are not artifacts of the analysis |

## 10. Reproducibility requirements

Pinned toolchain (rust-toolchain.toml, package-lock.json), chain-spec content hash recorded per run, per-cohort RNG seeds in the run manifest, one-command execution (`just sc-e1 RUN=A SEED=1`), raw exports + verdict files uploaded as CI artifacts and content-hashed, and the run manifest (config, hashes, seeds, thresholds snapshot) committed alongside results. A run that cannot be re-executed from its manifest alone does not count.

## 11. Hard limits (named honestly)

- **HL-1** Scripted archetypes are not adaptive adversaries. A pass on P4–P6 is a **lower bound** on attack resistance; a fail is a real fail.
- **HL-2** If weights are unbenchmarked (P0-4 waived), all fee-sensitive results carry a "wrong prices" confound; only the flat burned BASE_TX_FEE and flat completion fee are price-correct.
- **HL-3** Fast-era compression is valid only under uniform λ scaling; emergent time effects (e.g., rank-window strategy) may not compress linearly.
- **HL-4** 3 validators on one CI host ≠ a decentralized network. Consensus attacks and network realism are untested here by design.
- **HL-5** All ROI is CMN-denominated. Nothing here speaks to fiat-denominated attack profitability once CMN has a market price.
- **HL-6** RUN-F measures *incentive sufficiency* for settlement, not network resilience.
- **HL-7** Results are parameterized to the exact genesis constants of the run manifest; any auto-params drift mid-run must be logged or results do not generalize.
- **HL-8** §4 constants originate from build-session history, not from a fresh read of the runtime; P0-1 exists because of this.

## 12. Verdict rules

- **C-1a SUPPORTED** iff P1 ∧ P2 pass ∧ P3 (control) passes. If P3 fails → **INSTRUMENT INVALID**, no verdict on anything.
- **C-1b SUPPORTED** iff P4 ∧ P5 ∧ P6 pass. Any single failure → C-1b **REFUTED AT GENESIS PARAMETERS** with the measured break-even gap as the finding; parameter change + re-run path via auto-params/governance.
- **C-1c SUPPORTED** iff P7 passes. Any privileged call during RUN-F voids the run.
- **M8 violation at any point** → CRITICAL, halts the program pending emissions-pallet audit.
- P8 is reported against OD-1 thresholds as a design-acceptability finding, outside the C-1 verdict.
- Program-level finding SC-S-0001 (to be written only after execution): the empirical status of C-1, stated with the hard limits attached.

## 13. Open decisions (block P0-6 lock)

| ID | Decision | Owner |
|---|---|---|
| OD-1 | Concentration thresholds T (top-earner share) and G (Gini) for P8 | Keith |
| OD-2 | Public vs private repo (Actions minutes economics; IP-overlap check with Jacqueline recommended, though SC-E1 itself touches no patent subject matter) | Keith + Jacqueline |
| OD-3 | λ value and target wall-clock per era | Keith (with CI-runtime constraint) |

## 14. Artifact manifest

| Artifact | File | Status |
|---|---|---|
| This protocol | SC-E1-SEEV-protocol-spec.md | draft 1 |
| Workbook (12 tabs) | SC-E1-SEEV-workbook.xlsx | draft 1 |
| Fast-era chain spec | node/src/chain_spec.rs (`sc-e1` preset) | to build (P0-2) |
| Agent SDK | sdk/ (TypeScript) | to build (P0-3) |
| Archetype runners | experiments/sc-e1/archetypes/ | to build |
| Zombienet configs + CI workflow | experiments/sc-e1/, .github/workflows/sc-e1.yml | to build |
| Analysis + verdict script | experiments/sc-e1/analyze.py | to build |
| Run manifests + results | experiments/sc-e1/results/ | after execution |
