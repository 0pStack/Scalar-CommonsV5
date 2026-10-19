# SC-E1 Phase-0 **v2** Results — Re-run against the *verified* emissions formula

| Field | Value |
|---|---|
| Run date | 2026-07-06 |
| Supersedes | `SC-E1-PHASE0-RESULTS.md` (v1, run 2026-07-02) |
| What executed | `SC-E1-phase0-sim.py` with the **real** `compute_weight` transcribed from `docs/VERIFIED-CONSTANTS.md` (a read of `pallets/emissions/src/lib.rs:432-536`, `pallets/agents/src/lib.rs`, `runtime/src/lib.rs`). Full matrix RUN-A/C/D/E/F + NC-2/NC-3, deterministic, seeded (1,2,3). |
| What did NOT execute | The chain. No Substrate runtime, no zombienet, no real extrinsics. Findings are claims about the MODEL under assumptions **MA'-1..MA'-8** (sim header), now built on the **verified weight formula** but still with the **v1 flat-fee model (MA'-7) held fixed** to isolate the weight-formula delta. |
| Verdict files | `SC-E1-phase0-v2-verdicts.json` (full run), `verdict.json` (curated deltas) |
| Population | 100 workers (5 graded volume sub-cohorts × 20, 10K CMN stake) + 100 stakers (100K CMN, no work); adversary cohorts per run |
| Pre-registered thresholds | **Untouched** (workbook tab-01 not yet locked — only Keith locks). |

> **The headline of v2 is that P0-1 changed the object under study.** The v1 numbers were
> computed against MA-3, an *assumed* formula invented from session-history fragments. This
> run replaces MA-3 with the transcribed runtime formula. **Six of the eight v1 findings
> move, and three flip sign.** Every v1 caveat ("Model ≠ chain") still applies — plus a new
> one below (the fee model is now load-bearing and is itself still un-transcribed).

---

## What changed in the model (v1 → v2)

| Model element | v1 (MA-3 assumed) | v2 (verified) | Source |
|---|---|---|---|
| Weight functional form | `vol · rank · (1+.1·oracle) · (1+.05·gov) · (1+vel)`, linear in volume | `√stake · rank_bps · activity · hb/100 · (oracle) · onboarding · velocity`; volume enters only via **log2-scaled work_score gated by buyer diversity** | VC §1.2, F-1 |
| Stake in the weight | absent from work weight | **√stake base** (anti-whale: 100× stake → 10× weight) | VC §1.2 STEP 1 |
| Pool split | 60:40 work:stake, **separate stake pool** (MA-2/MA-4) | **no split, no stake pool** — one weight, whole pool distributed pro-rata | VC §1, F-1 |
| Pool size | free parameter `E_era`, swept 1e6→1e9 (MA-1) | **capped schedule** `clamp(10K·agents, 100K, 1M)` — hard ceiling **1,000,000 CMN/era** | VC §1.3, F-4 |
| Rank | binary 1.0 / 1.5 (MA-5) | graded `rank_bps` {1.0,1.0,1.2,1.5}; modeled 1.2 (rank 2) above FullFloorStake, 1.5 unreachable (oracle gate inert) | VC §1.2 STEP 2, F-5/F-6 |
| Oracle bonus | `(1+.1·oracle)` active | **inert on-chain** (`OracleScoreProvider=()`, best_score=0) | VC §1.2 STEP 9, F-5 |
| New terms | — | **heartbeat multiplier** (hb/100) and **onboarding boost** (+100% decaying over first 10 completions) | VC §1.2 STEP 3/10, F-7 |
| Fee model (MA-7 / MA'-7) | flat 10 CMN tx + 100 CMN completion | **unchanged** (deliberately, to isolate the formula delta; real chain uses 0.25% bps, F-3) | VC F-3 |

---

## Delta table (v1 vs v2)

| Metric (pre-reg) | v1 | v2 | Δ | Reading |
|---|---|---|---|---|
| **P1** worker/staker earnings ratio | **1.44** | **undefined** (staker earns **0**) | n/a | A pure staker's weight is 0 → zero emissions. The "1.44×" was a stake-pool artifact that no longer exists (F-1/F-2). |
| **P2/instrument** volume→earnings Spearman ρ (workers) | **+0.98** | **−0.59** | −1.57 | **Sign flip.** log2 saturation + onboarding boost + flat fees invert monotonicity (see R-SC-0001-v2 — partly a fee-model artifact). |
| gini (all agents, 20 eras) | 0.429 | 0.526 | +0.097 | More concentrated: earnings now track √stake·work, not a broad stake pool. |
| top-1 share | 0.0194 | 0.0118 | −0.0076 | √stake compresses the single largest earner. |
| **NC-3** observed ρ vs perm-95 | 0.98 vs 0.17 | −0.59 vs 0.19 | — | \|ρ\| still ≫ perm-95 → the (now negative) association is real, not a shuffle artifact. |
| **P4** sybil net @ pool (per acct) | −19.2 @1M | −30.0 @1M (**earn 0**) | — | Zero-work sybils get weight 0. |
| **P4** sybil break-even pool | **2.78M CMN/era** | **∞** (no pool earns them anything) | — | **The v1 cliff is gone.** √stake + work-gating kills pure-stake sybil farming outright. |
| **P5** wash net / era @ pool | −14 @1M (incremental) | **+1,556 @1M** | +1,570 | **Sign flip — worse.** Wash is profitable at the *only* pool the chain uses (the 1M ceiling). See R-SC-0004-v2. |
| **P5** wash break-even pool | ~1.12M CMN/era | **< 1M** (profitable at ceiling) | — | Diversity gate discounts 10× but does not zero it; onboarding boost *helps* the slow washer. |
| **P6** oracle collusion uplift | −2.4% | ~0 (±7e-6) | +2.4pp | Oracle bonus inert on-chain (F-5) → collusion has no reward surface to attack. |
| **P7** eras settled / p95 lag | 100/100, 0.0030 | 100/100, 0.0065 | — | Liveness precondition unchanged. |
| pool ceiling assumption | swept to 1e9 | **hard 1e6** | — | F-4: break-evens above 1M are unreachable via the base schedule. |
| **NC-2** zero-work worker metric | undefined | undefined | — | Unchanged (correct null). |

---

## Findings (v2)

**R-SC-0001-v2 — The instrument no longer produces a clean positive volume→earnings signal;
ρ flips to −0.59, and the cause is diagnostic. [instrument]**
Under the verified formula, work enters as `work_score = log2_scaled(volume) · diversity`,
which **saturates** (a 50× volume span maps to only a 5,000→10,000 bps work_score, and
`activity` clamps at 100%). The **onboarding boost** (+100% decaying over the first 10
completions) then *favors low-volume workers*, who accrue completions slowly and stay in the
boosted band for many eras, while high-volume workers exhaust it in era 1. Layer the retained
flat fee model on top — high-volume workers pay linearly more fees (n_esc ∝ volume) for a
logarithmically-compressed reward — and net earnings **decrease** with volume. NC-3 confirms
the −0.59 is a real relationship (\|ρ\| ≫ perm-95 = 0.19), not shuffle noise. **Caveat / action:**
this sign flip is *dominated by pairing the verified (log-compressed) weight with the
un-transcribed v1 flat-fee model (MA'-7).* The runtime's real completion fee is **0.25% of
escrow value (F-3)**, ~0.125 CMN on a 50-CMN escrow — negligible — which would remove the fee
term and likely restore ρ > 0. **The load-bearing next task is transcribing the fee model
(F-3), exactly as P0-1 did for the weight formula.**

**R-SC-0002-v2 — P1 is undefined against the real formula; there is no stake pool. [C-1a]**
Confirms VERIFIED-CONSTANTS F-2. A passive staker earns **exactly zero** (weight 0 without
escrow work). The equal-endowment worker/staker ratio (v1: 1.44×) is a quotient by ~0 →
**undefined**, and the ">= 2×" thesis is either trivially satisfied or ill-posed. The v1
number was an artifact of the assumed 40% stake pool (MA-2/MA-4), which does not exist. **P1
as pre-registered needs re-specification** before it can be tested against the chain — but
the threshold is **not yet locked**, so this is flagged, not changed.

**R-SC-0003-v2 — P4 PASSES unconditionally: the sybil break-even cliff is gone. [C-1b]**
v1's central sybil result was a pool-size cliff (`break-even ≈ 2.78M CMN/era`). Under the
verified formula, a pure-stake sybil does **no escrow work → work_score 0 → weight 0 → zero
emissions at any pool size**. Break-even pool = **infinite**. The `√stake` base further means
that even *if* a sybil worked, splitting stake across many accounts yields
`Σ√(stake/k) = √k · √stake` weight — sublinear, i.e. splitting is penalized, not rewarded.
**This is the clearest improvement of the real design over the model.**

**R-SC-0004-v2 — P5 FAILS harder: wash trading is profitable at the ceiling pool. [C-1b — headline]**
A self-dealing washer at exactly `MinQualifyingVol` (50 CMN, 1 counterparty → diversity 1,000
bps) nets **+1,556 CMN/era at the 1M ceiling pool** (v1: −14/era at 1M, profitable only above
1.12M). Three verified-formula mechanics combine against the guard: (1) the `MinQualifyingVol`
gate only zeroes the *floor* component — `work_score` still flows once volume clears
`UnitVolume` (10 CMN), so 50 CMN earns; (2) the **diversity gate discounts 10× but not to
zero** (1 buyer → 1,000 bps, not 0); (3) the **onboarding boost helps the low-throughput
washer**. Because the pool is capped at 1M (F-4), this does *not* worsen with scale (unlike
v1), but it is already positive at the only pool the chain will use. **Design levers (from VC
§3 and F-3): the real anti-wash defense is the diversity gate — raising the 1-buyer tier
toward 0, or requiring ≥2–3 distinct buyers for *any* work_score, structurally kills
self-dealing. The 0.25% bps completion fee (F-3) does *not* help here (it is tiny at 50 CMN).**
**Caveat:** magnitude is sensitive to the retained flat-fee model and to the modeled
1-buyer diversity; treat the sign (profitable), not the exact +1,556, as the result.

**R-SC-0005-v2 — P6 is moot: the oracle bonus is inert on-chain. [C-1b]**
`OracleScoreProvider = ()` → `best_score = 0` (F-5), so the +20% `OracleBonusBps` contributes
**exactly zero** today. Modeled collusion uplift is ~0 (±7e-6, fee noise). v1's −2.4% has **no
on-chain counterpart** until an oracle score provider is wired in; the collusion question is
un-testable against the chain as currently configured.

**R-SC-0006-v2 — P7 unchanged: 100/100 eras settled, p95 lag 0.0065 era. [C-1c]**
The settlement rationality precondition (some account's unclaimed earnings > 10 CMN fee) holds
from era 1. Near-tautological in a model; the real liveness test remains a zombienet task.

---

## Cross-cutting result (v2)

The v1 thesis — *"every anti-gaming guard priced as a flat CMN constant expires as the pool
grows"* — is **half-vindicated and half-overtaken** by the real formula:

- **Overtaken for sybil (R-SC-0003-v2):** the `√stake · work-gated` weight makes pure-stake
  farming unprofitable at *any* pool. The guard here is structural, not a flat constant.
- **Vindicated but *inverted* for wash (R-SC-0004-v2):** the pool is now *capped* at 1M, so
  the guard no longer "expires with scale" — instead it is **already breached at the ceiling**.
  The binding defense is the **buyer-diversity gate**, a *ratio*, not a flat CMN constant —
  which is the right shape. Its current 1-buyer tier (1,000 bps) is just set too generously.

**The single most actionable v2 export:** the wash result is now gated by *diversity*, and
the volume→earnings instrument is now confounded by the *fee model*. Both point to the same
next task — **transcribe the fee model and the diversity/heartbeat sub-functions (F-3) and
re-run**, the direct sequel to this P0-1 weight transcription.

## Hard limits on everything above (v2)

1. **Model ≠ chain** still holds — but the *weight* is now transcribed, not invented. The
   remaining invented pieces are the **fee model (F-3)** and the **population/diversity/
   heartbeat inputs** (MA'-4..MA'-6).
2. **The fee model is now load-bearing** (R-SC-0001-v2, R-SC-0004-v2 magnitudes). It is the
   next P0-1 transcription target.
3. **No variance.** Activity is deterministic; the three seeds produced identical economics
   (seeds vary only settlement backoff). Point estimates, not distributions.
4. **Static adversaries** and **modeled diversity/rank inputs** (MA'-4/MA'-5): rank capped at
   2 and diversity fixed per cohort; real values come from agent behavior on-chain.

## Actions fed back

1. **P0-1 (fees):** transcribe `CompletionFeeBps` / fee flow (F-3) and re-run — this run shows
   the fee model now drives two of the headline numbers.
2. **Re-specify P1** in tab-01 (per R-SC-0002-v2): a stake-only ratio is undefined against the
   real formula — before lock.
3. **Re-specify P5 defense** around the **buyer-diversity gate**, not `MinQualifyingVol` (per
   R-SC-0004-v2): consider requiring ≥2 distinct buyers for any work_score.
4. **Retire P4's pool-cliff prediction** (per R-SC-0003-v2): sybil break-even is infinite under
   the real weight; the prediction is falsified in the model's favor.
5. **Flag P6 as un-testable** until an `OracleScoreProvider` is wired (F-5).
