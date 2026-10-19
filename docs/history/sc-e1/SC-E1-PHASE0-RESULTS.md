# SC-E1 Phase-0 Results — Emissions-Economy Model Execution

| Field | Value |
|---|---|
| Run date | 2026-07-02 |
| What executed | Pure-Python economic model of the v4 emissions design (SC-E1-phase0-sim.py), full run matrix RUN-A..F + NC-2/NC-3, deterministic, seeded |
| What did NOT execute | The chain. No Substrate runtime, no zombienet, no real extrinsics. All findings are claims about the MODEL (assumptions MA-1..MA-8 in the sim header), not about Scalar Commons v4 as implemented. They become chain claims only after P0-1 constant verification and R5-style model→implementation conformance. |
| Verdict file | SC-E1-phase0-verdicts.json |
| Population | 100 workers (5 graded volume sub-cohorts × 20) + 100 stakers, equal 100K CMN endowment; adversary cohorts per run |

## Findings

**R-SC-0001 — The instrument is valid; the P3 window was mis-specified. [instrument]**
Work-weighting on vs off produces cleanly separable signatures: earnings ratio 1.44 vs −0.02; volume-earnings Spearman ρ +0.98 vs −0.98. NC-3 label-shuffle: observed ρ 0.98 vs permutation 95th percentile 0.17 (not an analysis artifact). NC-2 zero-work run correctly reports worker metrics undefined. **However:** the pre-registered P3 window (ratio ∈ [0.8, 1.2] under stake-only weights) assumed work is *neutral* when unrewarded. It is not — work costs fees, so under stake-only weights workers are strictly net-negative (ratio −0.02). The control separates *more* strongly than specified. **Action:** revise the P3 window in workbook tab 01 to "ratio ≤ 0.2 AND ρ ≤ −0.5" before lock. Thresholds are not yet locked, so this is legal; it is exactly what Phase-0 is for.

**R-SC-0002 — P1 conditional FAIL: work out-earns equal capital by only 1.44×, not 2.0×. [C-1a]**
Under the modeled 60:40 work:stake split (MA-2), the equal-endowment worker/staker ratio converges to 1.44 (identical across seeds — the activity model is deterministic; seeds only vary settlement). The ratio is a direct function of two design levers: the W:S split, and the fact that a worker's escrowed working capital (90K of the 100K endowment) earns nothing in the stake pool. If the thesis requires ≥2×, either the work share must rise or committed working capital must count toward stake weight. **Conditional on MA-3; the real formula must be transcribed (tab 03) before this number means anything about the chain.**

**R-SC-0003 — P4 conditional PASS with a named cliff: sybil resistance is pool-size-dependent. [C-1b]**
At a 1M CMN/era pool, a 1,000-account sybil farm nets −19.2 CMN/account over 3 eras (burned fees exceed stake-pool share) — P4 passes. But the closed form `break-even pool = fee × total_stake / (S_split × sybil_stake)` gives **2.78M CMN/era**, confirmed by sweep (+78/account at 10M; +10,781 at 1B). The flat 10 CMN burned fee is a fixed cost while the reward scales with the pool. **For reference, the v2 design's historical emission schedule (~20.5M CMN/day, years 1–2) sits an order of magnitude above this break-even** — if v4's actual per-era pool is comparable, sybil farming is profitable in the model. Design levers: minimum-stake floor for S-pool participation, fee scaled to pool, or excluding sub-threshold stakes from emissions entirely.

**R-SC-0004 — P5 conditional FAIL above ~1.12M/era pool: MinQualifyingVol cannot hold as a flat constant. [C-1b — headline finding]**
Correctly measured on an incremental basis (washing vs. holding identical stake and not washing — the sim's raw +338/era conflated stake earnings the washer gets anyway): washing nets −14/era at a 1M pool, but turns profitable at **~1.12M CMN/era** (+15 at 1.25M, +1,029 at 10M, +11,458 at 100M). The structure is identical to R-SC-0003: qualification costs are flat (~140 CMN/era: one 50-CMN self-escrow cycle at completion fee 100 + tx fees) while the unlocked W-pool share is pool-proportional. A flat 50-CMN gate with flat fees is a guard that *expires as the chain succeeds*. Design levers: scale MinQualifyingVol with the pool or median honest volume; make the completion fee a percentage of escrow volume; or cap W-weight by cumulative fees burned (weight ≤ f(fees paid) makes wash profit structurally impossible).

**R-SC-0005 — P6 conditional PASS, weakest result: collusion at k=20% nets −2.4%. [C-1b]**
Colluders deviating on 30% of oracle questions lose accuracy bonus under MA-6, where consensus stays honest below 50%. This result is only as strong as the oracle scoring model, which was invented for the sim, not transcribed from the oracle pallet. Treat as untested until the real scoring logic is modeled.

**R-SC-0006 — P7 weakly informative in a model: 100/100 eras settled, p95 lag 0.003 era. [C-1c]**
Under MA-8 (rational call-if-benefit>fee + random backoff) settlement is near-tautological. The genuine content is the rationality precondition it makes explicit: settlement is incentive-compatible whenever some account's unclaimed earnings exceed the 10 CMN fee — true from era 1 in every run. The real liveness question (RUN-F on zombienet) remains open.

## Cross-cutting result

R-SC-0003 and R-SC-0004 are the same finding twice: **every anti-gaming guard priced as a flat CMN constant is measured against a reward that scales with the emission pool, so each guard has a pool-size expiry date** (sybil ≈ 2.78M/era, wash ≈ 1.12M/era, under MA-1..MA-8). The design-level fix is a single principle: *gaming costs must scale with the rewards they gate* — percentage fees, pool-indexed gates, or fee-bounded weights. This is precisely the class of parameter the auto-params pallet exists to adjust; the finding gives it its first two target functions.

## Hard limits on everything above

1. **Model ≠ chain.** MA-3's weight formula was invented from session-history fragments; the real formula in `pallets/emissions/src/lib.rs` was never transcribed (tab 03, P0-1). Every number above is conditional.
2. **No variance.** The activity model is deterministic; the three seeds produced identical economics. Point estimates, not distributions.
3. **Static adversaries** (HL-1) and **no fee-price realism** (HL-2) carry over from the protocol.
4. Break-evens assume the modeled population (11.1M total stake); they shift with real stake distribution — the closed forms in the verdict file are the durable result, not the specific numbers.

## Actions fed back

1. Revise P3 window in tab 01 (per R-SC-0001) — before lock.
2. Add P4b/P5b to tab 01: predictions about the *break-even pool sizes* on-chain, not just sign-at-fixed-pool — Phase-0's most falsifiable export.
3. P0-1 verification is now urgent for exactly three items: the weight formula's functional form, the era emission pool schedule, and whether sub-MinQualifyingVol accounts receive any stake-pool emissions.
4. Open a design decision (OD-4): adopt pool-scaled gaming costs (which mechanism) before mainnet parameters are set.
