# ROUND 11 — Is OD-4 real, and is wash-trading unprofitable?

**Date:** 2026-08-03 · **Scope:** analysis only · **Repo state:** `master` @ `26b65a7`

---

## VERDICT UP FRONT

| Question | Answer |
|---|---|
| Is OD-4 implemented in the sim? | **No. Not one line.** |
| Does `test_od4_pool_scaling.py` exist? | **No.** The gate that checks for it was reverted. |
| Is the wash-trader unprofitable with OD-4 active? | **No — under any of the three mechanisms, at any legal parameter value.** |
| Can SEEV tab-01 P5 be locked? | **No.** |

**The launch gate is not green. It was never green. It is reporting green because the check was loosened back to a test suite that does not test OD-4.**

---

## 1. Is OD-4 actually implemented, or does the test pass vacuously?

**It passes vacuously, and worse than vacuously — the tightened gate was reverted.**

### 1.1 The test file does not exist

```
$ ls -la experiments/sc-e1/tests/
-rw-rw-r-- 1 dev dev 1177 Jul 29 10:23 test_analyze.py
```

`experiments/sc-e1/tests/test_od4_pool_scaling.py` is absent. `find . -name "*od4*"` returns
only factory logs and the task prompt — no source, no test.

### 1.2 The simulator contains zero mechanism code

```
$ grep -n "mechanism\|Mechanism\|od4\|OD-4\|pool_scal" experiments/sc-e1/SC-E1-phase0-sim.py
(no output)
```

All 305 lines of `SC-E1-phase0-sim.py` are the Phase-0 v2 baseline. There is no Mechanism A
(pool-indexed `MinQualifyingVol`), no Mechanism B (pool-scaled fee), no Mechanism C
(fee-burned weight cap), and no config object to switch them. `MIN_QUAL` is a module
constant at line 60; `COMPFEE` is a module constant at line 47. Neither is a function of `P`.

### 1.3 What the "passing" gate actually asserts

The 4 tests in `test_analyze.py` are:

| Test | What it asserts |
|---|---|
| `test_empty` | `compute_metrics([], manifest)` returns 8 metrics |
| `test_active_agent` | M1 counts one active agent as `1` |
| `test_missing_threshold_raises` | a missing threshold key raises `ValueError` |
| `test_schema_valid` | the verdict dict matches a JSON schema |

These test **JSON plumbing in `analyze.py`**. Not one of them touches emissions, weight,
pool size, wash trading, fees, or any economic quantity. `4 passed in 0.01s` is a true
statement about a schema validator and says nothing whatsoever about OD-4.

### 1.4 The gate was tightened, went red, and was then reverted

This is the part that matters most. Timeline from `factory/logs/trackC-od4-*.log`:

| Date | Gate | Result |
|---|---|---|
| 2026-07-31 | `pytest experiments/sc-e1/tests -q` | `gate already passes before any attempt — nothing to do. PASS` |
| 2026-08-01 09:04 | same | `gate already passes... PASS` |
| **2026-08-01 11:36** | **`test -f .../test_od4_pool_scaling.py && pytest ...`** | **red → 3 identical failures → BLOCKED** |
| **2026-08-02 21:07** | **`pytest experiments/sc-e1/tests -q`** (file check gone) | **`gate already passes... PASS`** |

The prompt file still carries the tightening note:

> `## GATE TIGHTENED (2026-08-01)`
> `The old gate passed with zero work. The gate now also requires a NEW file`
> `experiments/sc-e1/tests/test_od4_pool_scaling.py containing real assertions...`

Someone already diagnosed exactly this failure on 2026-08-01, tightened the gate correctly,
and the loop that ran on 2026-08-02 used the **old** gate again. The green on 2026-08-02 is
the *pre-tightening* gate re-reporting the same vacuous pass the tightening was written to stop.

### 1.5 Why no work was done

`factory/blocked/resolved/BLOCKED-trackC-od4.md` — all three attempts died instantly
(agent exited rc=1 after ~2s each) with:

```
API Error: 400 You have reached your specified API usage limits.
You will regain access on 2026-09-01 at 00:00 UTC.
```

The agent never executed. Wall time 0m6s of a 240m budget. This is not a case of an agent
doing bad work — it is a case of **no work at all**, followed by a gate revert that hid it.

---

## 2. THE PROFITABILITY TABLE

Because there is no OD-4 implementation to run, I implemented A/B/C myself from the RFC's own
algebra (§3.1, §4.1, §5.1) as an analysis harness. **See §6 — this is my code, not the
factory's, and it has had no independent review.**

**Anchor (this is what makes the numbers admissible).** The harness copies
`compute_weight` / `log2_scaled` / `diversity_score_bps` / `rank_bps_for` /
`onboarding_boost_bps` verbatim from `SC-E1-phase0-sim.py` and reproduces the published v2
verdicts **bit-exactly**:

| Published `SC-E1-phase0-v2-verdicts.json` | Value | Harness | Match |
|---|---|---|---|
| RUN-D wash net/era | `1556.4082243577097` | `1556.4082243577097` | ✅ |
| RUN-C sybil net | `-30.0` | `-30.0` | ✅ |
| RUN-A gini | `0.5260849509298967` | `0.5260849509298967` | ✅ |
| RUN-A top-1 share | `0.011796315117764638` | `0.011796315117764638` | ✅ |

The baseline was not moved.

### 2.1 All five archetypes — net CMN per agent per era

Combined 272-agent population (100 workers × 5 volume grades, 100 stakers, 50 sybils,
2 washers, 20 oracles), seed 1, 10 eras, **P = 1,000,000 CMN/era (the real capped pool)**.

| Config | A-1 honest | A-2 staker | A-3 sybil | **A-4 WASH** | A-5 oracle |
|---|---|---|---|---|---|
| **BASELINE (pre-OD-4)** | +7,339.3 | −10.0 | −10.0 | **+1,301.5** | +7,183.8 |
| **Mechanism A** (pool-indexed `V_min`) | +7,339.3 | −10.0 | −10.0 | **+1,301.5** | +7,183.8 |
| **Mechanism B** (pool-scaled fee) | +8,195.0 | −10.0 | −10.0 | **+1,401.4** | +7,432.6 |
| **Mechanism C** (reward ≤ fees burned) | **−0.1** | −10.0 | −10.0 | **0.0** | **−0.1** |
| **A + B + C** | **−0.1** | −10.0 | −10.0 | **0.0** | **−0.1** |

**Delta vs baseline** (negative = mechanism reduced profit):

| Mechanism | A-1 | A-2 | A-3 | **A-4 WASH** | A-5 |
|---|---|---|---|---|---|
| A | **+0.0** | +0.0 | +0.0 | **+0.0** | +0.0 |
| B | +855.7 | +0.0 | +0.0 | **+99.9** ⬆ | +248.8 |
| C | −7,339.4 | +0.0 | +0.0 | −1,301.5 | −7,184.0 |

Read that table carefully:

- **Mechanism A does exactly nothing.** Not "a little" — *bit-identical* to baseline.
- **Mechanism B makes the wash-trader ~8% MORE profitable.**
- **Mechanism C zeros the washer by zeroing everybody**, honest workers included.

### 2.2 Why Mechanism A is a literal no-op

`emission = clamp(10_000 × agent_count, 100_000, 1_000_000)` (VERIFIED-CONSTANTS §1.3, F-4).
At any population ≥ 100 agents, `10_000 × n ≥ 1,000,000`, so **`P` is pinned at the ceiling
and never varies.** Mechanism A sets `V_min = k·P`. Indexing a constant to a constant yields
a constant: at `k = 5e-5`, `V_min = 5e-5 × 1e6 = 50 CMN` — today's flat value, exactly.

**OD-4's entire premise is that `P` grows past a break-even. On this chain `P` cannot grow.**
The RFC (§1) reasons from "the v2 historical schedule ~20.5M CMN/day sits an order of
magnitude above both break-evens." The verified schedule caps at 1M CMN/era. The
v2 results already said this (line 51: *"F-4: break-evens above 1M are unreachable"*) — OD-4
was drafted against the superseded v1 pool model and never re-derived.

### 2.3 Pool sweep (P above 1M requires a governance `EmissionOverrides`, ≤10 eras)

| P (CMN/era) | A-4 base | A-4 Mech A | A-4 Mech B | A-4 Mech C | A-1 base | `V_min`(A) | fee_bps(B) |
|---|---|---|---|---|---|---|---|
| 250,000 | +220 | +190 | +320 | 0 | +989 | 12 | 25 |
| 500,000 | +581 | +550 | +681 | 0 | +3,106 | 25 | 25 |
| **1,000,000** ← real cap | **+1,301** | **+1,301** | **+1,401** | 0 | +7,339 | 50 | 25 |
| 1,120,000 ← RFC wash `P*` | +1,474 | +1,475 | +1,574 | 0 | +8,355 | 56 | 28 |
| 2,780,000 ← RFC sybil `P*` | +3,867 | +4,150 | +3,967 | 0 | +22,411 | 139 | 70 |
| 10,000,000 | +14,275 | +11,582 | +14,374 | 0 | +83,546 | 500 | 250 |

Even at 10× the ceiling, Mechanism A reduces wash profit by only 19% and it remains hugely
positive. Mechanism B is worse than baseline at **every** pool size.

---

## 3. THE GATE: is the wash-trader strictly unprofitable?

**No. Not under any mechanism, at any legal parameter value.**

The strongest honest statement available is: **Mechanism C reaches exactly 0.0, which is
break-even by construction, not "strictly unprofitable" — and it does so by driving honest
workers to −0.1 as well.** A cap of "claimable ≤ fees burned" means *nobody* can ever net a
profit. That is not an anti-wash mechanism; it is a chain-wide shutdown that would make CMN
emissions pointless. It also directly violates first principle #2 (reward verifiable work).

### 3.1 Where the edge is — Mechanism A against a *passive* washer

Sweeping `k_a` at the real P = 1M, with the washer pinned at the floor (as the current sim
hardcodes it):

| `k_a` | `MinQualifyingVol` | A-4 net | A-1 net | |
|---|---|---|---|---|
| 5e-5 | 50 (today) | +1,301 | +7,339 | |
| 2e-4 | 200 | +1,058 | +7,304 | |
| **1e-3** | **1,000** | **−27** | +7,435 | ← appears to close |
| 1e-2 | 10,000 | −11,171 | +7,339 | |

This is the number a less careful review would report: *"raise `MinQualifyingVol` 20× to
1,000 CMN and wash closes at −27/era, with no honest-worker damage."* **It is wrong.**

### 3.2 The edge collapses against a *rational* washer

The baseline sim hard-codes the washer at `work=MIN_QUAL` (line 170) and never lets it
re-optimise. **This is a genuine adversary-modelling gap.** A rational washer picks its
volume. Letting it do so, at `MinQualifyingVol = 1,000`:

| wash volume | A-4 net/era | |
|---|---|---|
| 10 | −76 | below floor |
| 50 | +116 | below floor |
| **100–150** | **+181 … +201** | **abandons the floor entirely** |
| 1,000 | −27 | clears floor (the sim's forced choice) |
| 5,000 | −4,976 | clears floor |

The washer **walks away from the floor** and washes ~150 CMN for `work_score` alone.
Sweeping `k_a` with re-optimisation, A-4 profit **asymptotes at +201/era and never goes
negative** — at `V_min` = 1,000, 10,000, 50,000, 100,000, even 200,000 CMN:

| `k_a` | `V_min` | wash V\* | A-4 net | A-1@100 | A-1@500 | A-1@1000 | A-1@2000 | A-1@5000 |
|---|---|---|---|---|---|---|---|---|
| 5e-5 | 50 | 150 | +1,366 | 8,946 | 7,183 | 7,093 | 7,112 | 6,357 |
| 1e-3 | 1,000 | 150 | +181 | 8,264 | 6,737 | 7,601 | 7,664 | 6,989 |
| 1e-2 | 10,000 | 150 | +201 | 8,771 | 7,169 | 7,135 | 7,214 | 6,531 |
| 2e-1 | 200,000 | 150 | **+201** | 8,771 | 7,169 | 7,135 | 7,214 | 6,531 |

**`MinQualifyingVol` gates only the `floor` component (STEP 5). It structurally cannot touch
`work_score`.** So Mechanism A has a hard ceiling on its own power — it can remove at most
1,000 bps of activity, and a washer that declines the floor is immune to it at any value.
**There is no `k_a` at which Mechanism A closes wash trading.**

### 3.3 Mechanism B cannot close it either

At P = 1M, sweeping the fee to the auto-params **hard maximum** (2,500 bps = 25%,
`pallets/auto-params/src/lib.rs:194`):

| fee_bps | A-4 net | A-1 net |
|---|---|---|
| 25 (genesis) | +1,401 | +8,195 |
| 500 | +1,399 | +8,113 |
| **2,500 (hard max)** | **+1,389** | +7,769 |

A 100× fee increase moves wash profit by **12 CMN**. The washer washes 50 CMN; 25% of 50 is
12.5 CMN against a ~1,400 CMN reward. The RFC admits this in §4.1 (*"a flat `f` never bites
the minimal washer"*) — the sweep confirms it is not a weakness but a total failure.
Mechanism B is also **counterproductive** because replacing the model's flat 100 CMN
completion fee with the *real* 25 bps fee (F-3: 0.125 CMN on a 50 CMN escrow) is a **fee cut**.

### 3.4 What *does* close it — and how it is defeated

Only the **conjunction** of a zeroed 1-buyer diversity tier and a raised floor works
(rational washer, P = 1M):

| Config | wash V\* | A-4 net | A-1 net | A-1@100 | |
|---|---|---|---|---|---|
| baseline (`div₁`=1,000, `V_min`=50) | 150 | +1,366 | 7,338 | 8,946 | |
| diversity gate only (`div₁`=0) | 150 | **+1,065** | 7,343 | 8,952 | still profitable |
| Mech A only (`V_min`=10k) | 150 | **+201** | 7,364 | 8,771 | still profitable |
| **`div₁`=0 AND `V_min`=10k** | 10 | **−140** | 7,370 | 8,778 | **closed** |

Note the v2 results' own recommendation — *"raising the 1-buyer tier toward 0 structurally
kills self-dealing"* (R-SC-0004-v2) — is **also false on its own**: at `div₁ = 0` the washer
still nets **+1,065/era**, because with `work_score = 0` it *still collects the 1,000 bps
activity floor* on its √stake. Two independent leaks, and each patch only plugs one.

**And then the washer buys the diversity back.** Registering sybil counterparties costs
`BaseRegistrationFee` = 50 CMN one-off + 10 CMN/era heartbeat (VERIFIED-CONSTANTS §2.3):

| washer's counterparties | `diversity_bps` | cost/era | A-4 net/era | |
|---|---|---|---|---|
| 1 | 0 | — | −140 | closed |
| **2** | 3,000 | **55** | **+866** | **reopens** |
| 3 | 6,000 | 110 | +1,867 | |
| 5 | 10,000 | 220 | **+3,186** | *better than baseline* |

**For 55 CMN/era the washer defeats the strongest configuration and ends up more profitable
than before the fix.**

### 3.5 The actual edge

| Cost per sybil counterparty per era | washer's best play | A-4 net/era |
|---|---|---|
| 60 (today: 50 reg + 10 hb) | 5 counterparties | +3,026 |
| 400 | 5 counterparties | +1,646 |
| 800 | 3 counterparties | +297 |
| **1,200** | **1 (gives up)** | **−140 — CLOSED** |

**The binding parameter is not in OD-4 at all.** It is the cost of creating a counterparty
identity, which must rise from ~60 CMN/era to **~1,200 CMN/era (20×)** — roughly the per-agent
emission share, which is the economically correct answer: a fake counterparty must cost about
what an agent earns.

And note what `BaseRegistrationFee` = 50 CMN is: **a flat CMN constant measured against a
pool-scaled reward.** OD-4 diagnosed the disease correctly in §1 and then applied all three
of its mechanisms to surfaces that are not the binding one.

---

## 4. Can the SEEV tab-01 thresholds be locked?

**No. Locking now would pre-register a prediction that is already known to be false, on a
gate that is known to be vacuous.** Specific recommendations:

| ID | Current | Recommendation | Reasoning |
|---|---|---|---|
| **P5** | *"wash net < 0 at genesis params"* | **DO NOT LOCK.** Re-specify, then lock at `net < 0 per era at P = 1,000,000, against a volume-and-counterparty-optimising washer`. | Measured **+1,301/era** at genesis. The threshold as written is falsified before pre-registration. Critically, the current wording does not bind the adversary's strategy — §3.2 shows a passive washer reports −27 and a rational one +201 **from the same code**. A P5 that does not specify a rational adversary is unfalsifiable. |
| **P1** | ratio ≥ 2.0 | **DO NOT LOCK.** Re-specify. | Already flagged by R-SC-0002-v2: undefined (staker earns exactly 0; division by ~0). Unchanged by this round. |
| **P2** | ρ ≥ 0.8 | **DO NOT LOCK** until the fee model is transcribed. | v2 measured ρ = −0.59, and v2 itself attributes the sign flip to the un-transcribed flat-fee model (MA'-7). Locking against a known confound pre-registers an artifact. |
| **P4** | sybil net < 0 by era 3 | **LOCK AS-IS.** | Genuinely passes, structurally: √stake + work-gating gives zero-work sybils weight 0 at any pool. Measured −10/era. This is the one clean result. |
| **P6** | uplift ≤ 5% | **LOCK, flagged un-testable.** | `OracleScoreProvider = ()` → bonus inert (F-5). Measured ~0. Lock it, but record that it tests nothing until a provider is wired. |
| **P7** | 100 eras, p95 lag ≤ 10% | **LOCK AS-IS.** | 100/100, p95 = 0.0065. Holds. |
| **P8** | OD-1: T, G by Keith | Blocked on OD-1 — unchanged. | Not addressed by this round. |

**And OD-4 §8 should not be filled in as written.** The RFC asks Keith to choose among A, B,
and C. This analysis says A is a no-op, B is counterproductive, and C is a shutdown. The
honest §8 entry is *"none of the above; the mechanism class was aimed at the wrong surface"*,
with a follow-up RFC on **identity/counterparty cost** (`BaseRegistrationFee`, minimum stake
per counterparty, or a Sybil-resistant diversity measure that counts *economic* distinctness
rather than distinct AccountIds).

**One parameter change is defensible on this evidence alone** and does not need OD-4:
set `diversity_score_bps(1) = 0` (require ≥2 distinct buyers for any `work_score`). It costs
honest workers ~nothing (A-1 +7,338 → +7,343; the low-volume A-1@100 cohort is unharmed at
8,946 → 8,952) and removes one of the two leaks. It is **not sufficient**, and must not be
sold as closing wash trading.

---

## 5. Recommended immediate actions

1. **Re-tighten the trackC-od4 gate and find out who reverted it.** The 2026-08-02 green ran
   the pre-tightening gate. Restore the `test -f .../test_od4_pool_scaling.py` requirement.
   The revert is a bigger problem than the missing feature — a gate that can be quietly
   loosened back to green is worse than no gate.
2. **Add a gate-integrity check to the factory:** a gate command should never be *weakened*
   between runs of the same track without an explicit recorded decision. Consider hashing the
   gate string into the loop log and failing loudly on change.
3. **Do not treat trackC-od4 as done.** It is blocked on an API quota that resets
   **2026-09-01**. Nothing will happen before then.
4. **Do not lock SEEV tab-01** (see §4).
5. **Re-derive OD-4 §1 against the capped pool.** Its break-even framing is inherited from
   the superseded v1 free-pool model.

---

## 6. How this analysis could be flattering itself

Stated plainly, worst first.

1. **I wrote the mechanisms I am judging.** There is no factory OD-4 implementation, so I did
   not verify *their* code — I verified *my reading of the RFC's algebra*. If I mis-implemented
   a mechanism, I would have found it ineffective for the wrong reason. The anchor test proves
   the *baseline* is faithful; it proves nothing about my A/B/C. **This needs independent
   review before any parameter decision.** Harness is at
   `/tmp/claude-1000/-home-dev-scalar-commons-v4/.../scratchpad/od4_harness.py` — not committed.
2. **The fee model overstates the washer's costs, so real wash profit is HIGHER than reported.**
   I inherited MA'-7 (flat 100 CMN completion fee). The real chain charges 25 bps — **0.125 CMN**
   on a 50 CMN escrow (F-3). The baseline charges the washer ~140 CMN/era; the real chain would
   charge ~40. Every "+1,301" in this report is **conservative by roughly 100 CMN/era in the
   chain's favour**. The sim flatters the chain, and I did not correct it, because correcting
   it would change the baseline the anchor test pins.
3. **Mechanism C's "exactly 0.0" is an artifact of my implementation choice.** I implemented
   the RFC §5.1 reward-space form as `min(gross, era_fees_burned)` per era. That is faithful to
   the RFC, but it makes the result trivially 0 for *everyone*, which is why the honest cohorts
   also collapse. A per-era-decaying or κ-scaled variant would behave differently and I did not
   sweep it. My "C is a shutdown" verdict applies to the RFC's stated form, not to every
   possible cap design.
4. **The rational-washer search is a coarse discrete grid** (~20 volumes, ≤5 counterparties).
   The true optimum is at least as good as what I found, so **wash profit is a lower bound** and
   the counterparty-cost edge (~1,200 CMN/era) is likely an **under**estimate.
5. **Zero variance.** Activity is deterministic; all three seeds give identical economics
   (seeds vary only settlement backoff). These are point estimates, not distributions. No
   confidence intervals are available and none should be implied.
6. **Static population.** 2 washers in a 272-agent population. A wash *cartel* at scale would
   dilute Σ`W` and change every number; I did not model attacker scale-up, adaptive honest
   agents, or entry/exit.
7. **Model ≠ chain, still.** No Substrate runtime, no zombienet, no extrinsics executed. The
   weight formula is transcribed (P0-1a) but the fee model, diversity inputs, heartbeat, and
   rank distribution (MA'-4..MA'-7) remain modelled. Sybil counterparty costs are my own
   addition and are not transcribed from the escrow pallet.
8. **`P` pinned at 1M assumes ≥100 registered agents.** Below that the pool is smaller and all
   magnitudes shrink (see the 250k/500k rows). Early-chain economics differ.
9. **I did not read the SEEV workbook's actual cells.** `SC-E1-SEEV-workbook.xlsx` is binary;
   my tab-01 threshold list comes from `SC-E1-SEEV-protocol-spec.md` §7, which
   VERIFIED-CONSTANTS §0 already flags as an unverified proxy for the workbook. If tab-01 has
   drifted from the spec, my §4 recommendations are keyed to the wrong numbers.

---

## Appendix — reproduction

Baseline anchor (must reproduce exactly, or discard everything above):

```
RUN-D wash net/era : [1556.4082243577097, 1556.4082243577097, 1556.4082243577097]
RUN-C sybil net    : [-30.0, -30.0, -30.0]
RUN-A gini         : 0.5260849509298967
RUN-A top1         : 0.011796315117764638
pool used          : 1000000.0
```

Sources read in full: `experiments/sc-e1/` (sim, analyze, tests, verdicts, results v1+v2,
SEEV protocol spec, archetypes), `docs/VERIFIED-CONSTANTS.md`,
`docs/rfcs/OD-4-pool-scaled-costs.md`, `factory/tasks/trackC-od4.prompt`,
`factory/logs/trackC-od4-*`, `factory/blocked/resolved/BLOCKED-trackC-od4.md`.
