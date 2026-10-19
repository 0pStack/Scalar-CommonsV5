# ROUND 12 — Independent adversarial verification of ROUND11's wash-trading finding

**Date:** 2026-08-03 · **Scope:** analysis only, no code or parameter changes · **Repo:** `master` @ `26b65a7`
**Method:** own harness written from scratch against primary sources; ROUND11's harness and report read **only after** every number below was produced.

Harnesses committed: `experiments/sc-e1/scratchpad/od4_harness_round12.py` (mine, runs end-to-end),
`experiments/sc-e1/scratchpad/od4_harness_round11.py` (ROUND11's, as found).
Raw output: `round12_output.txt` · machine-readable: `round12_results.json`.

---

## VERDICT UP FRONT

| Question | ROUND12 answer |
|---|---|
| Does my independent harness reproduce the published v2 anchors bit-exactly? | **Yes** — all 5 anchors, exact float equality |
| Is `P` pinned at the 1,000,000 CMN ceiling for n ≥ 100? | **Confirmed** (arithmetic and by run) |
| Is OD-4 Mechanism A a no-op? | **Confirmed for the pool-indexed variant — and I go further: no value of `MinQualifyingVol`, including infinity, can close wash.** Proven in closed form |
| Wash-trader net ≈ +1,301 CMN/era at baseline? | **Confirmed exactly** (+1,301.5, 272-agent population) |
| Does a rational washer stay profitable at any `MinQualifyingVol`? | **Confirmed — but ROUND11's stated mechanism is wrong.** It does not need to abandon the floor |
| Is the per-counterparty-era cost ≈ 1,200 CMN? | **Refuted.** At genesis parameters it is **≈ 7,286 CMN/era**, ~6× higher. ROUND11's figure is reproducible only under two attacker-weakening choices |
| Is wash-trading a launch blocker? | **Not on supply-safety grounds. Yes as a pre-registration blocker** — SEEV P5 as written is falsified |
| Is counterparty cost the right surface? | **Directionally yes, as ROUND11 says — but not as a *price*.** The required cost is not expressible under `MaxStakePerAgent` |

**Headline disagreement:** ROUND11's conclusion (OD-4 fails; counterparty cost is the binding surface) **survives verification**. Its central *number* does not, and its *reasoning* for the crux is wrong in a way that understates the problem.

---

## 0. Anchor — bit-exact, as required

My harness re-derives `compute_weight` from `pallets/emissions/src/lib.rs:536-666` and the pool clamp from `:255-272`, independently of the sim, then checks against the published verdicts:

| Published `SC-E1-phase0-v2-verdicts.json` | Value | ROUND12 harness | Exact |
|---|---|---|---|
| RUN-D wash net/era | `1556.4082243577097` | `1556.4082243577097` | ✅ |
| RUN-D wash gross/era | `1696.4082243577097` | `1696.4082243577097` | ✅ |
| RUN-C sybil net | `-30.0` | `-30.0` | ✅ |
| RUN-A gini | `0.5260849509298967` | `0.5260849509298967` | ✅ |
| RUN-A pool | `1000000.0` | `1000000.0` | ✅ |

The harness `raise SystemExit`s if any anchor misses, so nothing downstream can run against a broken transcription.

I also re-read the runtime source directly rather than trusting `VERIFIED-CONSTANTS.md`. **The transcription is faithful** — `compute_weight_cached` STEP 1–11, `log2_scaled`, `diversity_score_bps`, the emission clamp, and every constant in §2.1–2.4 match what is in the tree today. VERIFIED-CONSTANTS is reliable for this purpose.

---

## 1. Is `P` pinned at the ceiling? (Q1)

**Confirmed, both ways.**

Arithmetic: `emission(n) = clamp(10_000·n, 100_000, 1_000_000)`. `10_000·n ≥ 1_000_000 ⟺ n ≥ 100`. So `n* = 100`.

By run — smallest `n` with `P == ceiling` is **100**; `P = 1,000,000` for n = 100, 101, 200, 202, 1,000, 10,000, 1,000,000.

But **"Mechanism A is a no-op" is only true of the variant OD-4 §3 leads with.** The RFC offers three forms, and they behave differently:

| Mechanism A variant | Behaviour under the verified pool |
|---|---|
| `V_min = k·P` (pool-indexed) | **No-op for n ≥ 100.** `P` is the constant 1e6, so `k·P` is a constant — a re-parameterised flat guard |
| `V_min = k·P/active_agents` (per-capita) | **Worse than a no-op.** `1e6/n` *decreases* in `n`, so the guard *weakens* as the chain grows — the exact inversion of OD-4's design intent |
| `V_min = k·median_honest_volume` | Not a no-op (tracks a live quantity), but it is not pool-indexed at all — a different mechanism under Mechanism A's name, and OD-4 §3.3 already flags it as cartel-gameable |

ROUND11 §2.2 asserts the no-op for Mechanism A generally. **That is right for the headline variant and I confirm it, but it over-generalises**; the per-capita variant is not a no-op, it is actively backwards. This matters because §8 of the RFC asks Keith to choose, and "A does nothing" invites the reply "then use the per-capita form."

---

## 2. Baseline wash-trader profitability (Q2)

**+1,301.5 CMN/era is confirmed exactly.** Replicating ROUND11's declared 272-agent population (100 workers × 5 grades, 100 stakers, 50 sybils, 2 washers, 20 oracles; seed 1, 10 eras):

| Cohort | ROUND12 replication | ROUND11 published | Match |
|---|---|---|---|
| **A-4 WASH** | **+1,301.5** | **+1,301.5** | ✅ |
| A-1 honest | +7,339.3 | +7,339.3 | ✅ |
| A-2 staker | −10.0 | −10.0 | ✅ |
| A-3 sybil | −10.0 | −10.0 | ✅ |
| A-5 oracle | +7,183.8 | +7,183.8 | ✅ |

**But the number is window- and population-dependent, and neither report flagged it.** It is a 10-era *cumulative mean* that includes the +100% decaying onboarding boost, not a steady-state rate. My own per-era decomposition (202-agent population):

| Statistic | Value (CMN/era) |
|---|---|
| era 0 / era 1 / era 5 / era 9 marginal net | +1,818 / +1,892 / +1,537 / +1,136 |
| **steady state (era 15+, onboarding exhausted)** | **+1,135.5** |
| 10-era cumulative mean (= published RUN-D) | +1,556.4 |
| 20-era cumulative mean | +1,346.0 |
| 30-era cumulative mean | +1,275.8 |

So both published headline figures — `1556.4` (RUN-D, 202 agents) and `1301.5` (ROUND11, 272 agents) — are **transient artefacts of a 10-era window**. The decision-relevant steady-state rate is **~1,136 CMN/era**, ~13% below ROUND11's headline. Direction of the error is *toward* over-stating wash profit; it does not rescue the guard.

---

## 3. THE CRUX — the rational washer (Q3)

**ROUND11's conclusion is confirmed. Its stated mechanism is wrong, and the truth is worse.**

ROUND11 §3.2 claims the washer "walks away from the floor" and washes ~150 CMN for `work_score` alone, asymptoting at +201/era.

Under the **verified** chain fee (`CompletionFeeBps = 25`, i.e. 0.25% — F-3), a rational washer choosing volume, escrow count and governance participation **does not abandon the floor at any realistic `V_min`.** It simply *complies*, because compliance is nearly free:

| `V_min` | best V | qualifies? | weight | reward | cost | **NET** |
|---|---|---|---|---|---|---|
| 50 (today) | 10,000 | yes | 85.80 | 7,550.56 | 265.00 | **+7,285.56** |
| 5,000 | 10,000 | yes | 85.80 | 7,550.56 | 265.00 | **+7,285.56** |
| 50,000 | 50,000 | yes | 85.80 | 7,550.56 | 365.00 | **+7,185.56** |
| 100,000 | 100,000 | yes | 85.80 | 7,550.56 | 490.00 | **+7,060.56** |
| 1,000,000 | 10,000 | **no** | 70.20 | 6,186.22 | 265.00 | **+5,921.22** |

Clearing a **100,000 CMN** floor costs 250 CMN in completion fee against a 7,551 CMN reward. The washer only declines the floor when `V_min` exceeds ~100× its own stake — and even then it nets **+5,921/era**.

### 3.1 The closed form — why no `MinQualifyingVol` can ever work

This does not need a sweep. `MinQualifyingVol` gates **only** `effective_floor` (`pallets/emissions/src/lib.rs:594-596`). `floor_bps = 1,000` sits inside an activity budget capped at `BPS_SCALE = 10,000`:

```
washer activity, qualifying     = 1,000 (floor) + 4,000 (gov) + 500 (work) = 5,500 bps
washer activity, not qualifying =         0     + 4,000       + 500        = 4,500 bps
max weight ANY V_min can remove = 1,000/5,500 = 18.2%
```

**A guard that can remove at most 18.2% of the attacker's weight cannot drive a +7,286 CMN/era position negative at any parameter value.** This is independent of `P`, of the fee model, and of population. It is a structural bound, and it is a strictly stronger refutation of Mechanism A than ROUND11's numerical asymptote.

### 3.2 What ROUND11 missed — governance farming quadruples the attack

ROUND11's washer archetype has `gov_votes = 0` (`od4_harness_round11.py:137-138`: only `A-1`/`A-5` vote). **That under-powers the adversary, and it is the single biggest error in the round.**

`gov_contribution` is gated on `work_score > 0` (`emissions/src/lib.rs:606-610`) — a condition the washer *satisfies*. And the guard CLAUDE.md lists as load-bearing, `GovVoteVerifier` → `pallet_conviction_voting::VotingFor`, is a **single boolean**:

```rust
// runtime/src/lib.rs:1029-1036
VotingFor::<Runtime>::iter_prefix(who)
    .any(|(_, voting)| matches!(&voting, Voting::Casting(c) if !c.votes.is_empty()))
```

It checks that *at least one* non-empty vote exists in *any* class. It does not check distinctness, recency, or that 20 separate referenda were voted on. **One conviction vote, cast once and never unlocked, satisfies it forever** — after which the washer calls `record_gov_vote(self)` 20× per era to hit `MaxProposalsPerEra` and bank the full **+4,000 bps**, every era, for 20 extrinsic fees.

Effect on the same washer, genesis parameters, real chain fee:

| Washer strategy | weight | net CMN/era |
|---|---|---|
| 1 sybil counterparty, no governance (ROUND11's model) | 23.40 | **+2,006** |
| 1 sybil counterparty, **farms governance** | 85.80 | **+7,286** |
| 5 sybil counterparties, farms governance | 156.00 | **+13,259** |

Modelling the washer as a non-voter understates its profit by **3.6×**.

### 3.3 The decision-relevant comparison ROUND11 never made

"Wash trading is profitable" is close to tautological on this chain: a pure staker earns **exactly zero** (VERIFIED-CONSTANTS §3), so *any* positive-net strategy beats abstaining. The question that should drive a launch decision is whether washing beats **honest work at equal capital**:

| Strategy | weight | net/era | capital | **net per 1,000 CMN capital** |
|---|---|---|---|---|
| honest worker, vol 100, 5 real buyers | 90.27 | +7,701 | 10,000 | **+770.1** |
| honest worker, vol 5,000, 5 real buyers | 138.00 | +11,836 | 10,000 | **+1,183.6** |
| washer, 1 sybil cp, no gov | 23.40 | +2,006 | 11,000 | +182.3 |
| washer, 1 sybil cp, farms gov | 85.80 | +7,286 | 11,000 | +662.3 |
| **washer, 5 sybil cps, farms gov** | 156.00 | +13,259 | 15,000 | **+883.9** |

**A 5-sybil governance-farming ring beats the low-volume honest cohort (+884 vs +770) but loses to the high-volume honest cohort (+884 vs +1,184).** Wash trading is therefore a **dilution attack on small honest agents**, not a dominant strategy. That is a materially less alarming — and more actionable — framing than "wash is profitable, the gate is not green."

### 3.4 ROUND12-original: `MaxVolToStakeRatio` is order-dependent and evadable

`pallets/agents/src/lib.rs:1254-1281` accumulates `era_total` **first**, then credits a new buyer slot only if `era_total ≤ stake × MaxVolToStakeRatio`. A washer that front-loads *k* minimum-size escrows (10 CMN, `EscrowMinAmount`) banks full diversity credit **before** pushing real volume; every later escrow reuses an already-seen bloom slot and needs no credit. The stake-weighted diversity cap is defeated for ~50 CMN. Neither ROUND11 nor the RFC mentions this.

---

## 4. The counterparty cost (Q4) — **I do not land near 1,200**

**At genesis parameters the required per-counterparty-era cost is `c* ≈ 7,286 CMN/era`, not ~1,200.**

`c*` is the per-counterparty-era cost at which the washer's best strategy — optimising jointly over volume, counterparty count *k*, and governance — first goes non-positive:

| c (CMN/era) | best k | best V | reward | cost | NET |
|---|---|---|---|---|---|
| 0 | 5 | 10,000 | 13,644.00 | 385.00 | +13,259.00 |
| 500 | 5 | 10,000 | 13,644.00 | 2,885.00 | +10,759.00 |
| **1,200** ← ROUND11's answer | 5 | 10,000 | 13,644.00 | 6,385.00 | **+7,259.00** |
| 2,000 | 1 | 10,000 | 7,550.56 | 2,265.00 | +5,285.56 |
| 5,000 | 1 | 10,000 | 7,550.56 | 5,265.00 | +2,285.56 |
| 10,000 | 1 | 10,000 | 7,550.56 | 10,265.00 | **−2,714.44** |

At ROUND11's recommended 1,200 CMN/era the washer is still **+7,259/era** — the recommendation leaves the attack fully open.

### 4.1 Where ROUND11's ~1,200 comes from — two attacker-weakening choices, isolated

| Fee model | Washer farms governance? | `c*` |
|---|---|---|
| Real chain, 25 bps (F-3) | **Yes** | **7,285.56** ← ROUND12 |
| Real chain, 25 bps (F-3) | No | 2,005.61 |
| Sim MA'-7 flat 100 CMN | Yes | 5,241.78 |
| **Sim MA'-7 flat 100 CMN** | **No** | **1,194.67** ← reproduces ROUND11 |

ROUND11's figure requires **both** the fee model its own §6.2 disclaims as wrong **and** a washer that declines free governance weight. ROUND11 §6.4 predicted its estimate was low; it was low by **6.1×**.

There is a second, separate problem. ROUND11 §3.5 presents ~1,200 as "the actual edge", but that table is measured **after** also applying `diversity_bps(1) = 0` and `V_min = 10,000` (§3.4). It is the residual cost *conditional on two unshipped changes*, not the cost at genesis parameters. Reproducing that conditional setup I get `c* = 621` (gov off) / `2,374` (gov on) — so even within its own framing the published 1,200 is a coarse grid point, not a root.

### 4.2 The finding that undermines the recommendation: `c*` is not payable

ROUND11 calls ~1,200 CMN/era "roughly the per-agent emission share, which is the economically correct answer." Priced as a bond at opportunity cost *r*, `c* = 7,286 CMN/era` requires:

| Opportunity cost | Bond required per counterparty | vs `MaxStakePerAgent` (1,000,000 CMN) |
|---|---|---|
| 5% APR | 212,738,266 CMN | **212.7×** |
| 20% APR | 53,184,566 CMN | **53.2×** |
| 100% APR | 10,636,913 CMN | **10.6×** |

**No bond that large is expressible under the current stake cap.** As a flat fee it is 29,142 CMN/day *per counterparty relationship* — which would also be charged to every honest agent with 5 counterparties, i.e. exactly the population the diversity gate exists to reward.

Today's actual cost is ~20 CMN/era per counterparty (`BaseRegistrationFee` 50 CMN one-off + `MinStake` 1,000 CMN locked + ~2 tx/era). The gap to `c*` is **361×**.

**So: counterparty cost is the right *surface*, but not as a price.** A monetary counterparty cost cannot reach `c*` without destroying honest multi-counterparty trade. It only works as a **non-fungible identity constraint** — something unbuyable at any price — which is a different and much harder design problem than "raise `BaseRegistrationFee` 20×". ROUND11's framing makes the fix sound like a parameter change. It is not.

---

## 5. Agree / disagree ledger

| # | ROUND11 claim | ROUND12 | Who is right, and why |
|---|---|---|---|
| 1 | Anchors reproduce bit-exactly | **Agree** | Independently reproduced all 5 |
| 2 | OD-4 is not implemented in the sim; no `test_od4_pool_scaling.py` | **Agree** | Verified: no such file; no mechanism code in the sim |
| 3 | `P` pinned at 1e6 for n ≥ 100 | **Agree** | Confirmed by arithmetic (`n* = 100`) and by run |
| 4 | Mechanism A is a literal no-op | **Agree, with correction** | True of `k·P`. **Not** true of the per-capita variant, which is *backwards* (weakens as n grows). ROUND11 over-generalises |
| 5 | Baseline wash = +1,301.5/era | **Agree** | Replicated exactly. **But** it is a 10-era cumulative mean inflated by onboarding; steady state is **+1,136**. Neither report flagged this |
| 6 | Washer abandons the floor and profits at any `V_min` | **Conclusion agree, mechanism disagree** | ROUND12 right. Under the *real* 25 bps fee the washer **complies** with `V_min` up to ~100× its stake — compliance costs 250 CMN against a 7,551 CMN reward. It never needs to abandon anything |
| 7 | Mechanism A has a hard ceiling: gates only `floor`, ≤1,000 bps | **Agree, and strengthen** | ROUND11 states it qualitatively; ROUND12 gives the closed form — **≤18.2% of attacker weight removable at any parameter value**, pool- and fee-independent |
| 8 | Mechanism B is counterproductive (real 25 bps is a fee *cut*) | **Agree** | Confirmed: complying with a 100,000 CMN floor costs 250 CMN at 25 bps |
| 9 | Mechanism C zeros everyone; is a shutdown | **Agree** (not re-derived) | Follows directly from `R ≤ F`; ROUND11's own §6.3 caveat about the reward-space form stands |
| 10 | Counterparty cost is the binding surface | **Agree on direction** | Confirmed: `c*` scales with washer stake (1,715 → 56,362 CMN/era for 1k → 1M stake); it is the surface that actually binds |
| 11 | **`c* ≈ 1,200 CMN/era (20× today)`** | **DISAGREE — ROUND12 right** | **7,285.56 CMN/era** at genesis params. ROUND11's number needs the disclaimed flat-fee model *and* a non-voting washer, *and* is conditional on two unshipped changes. At 1,200 the washer still nets **+7,259** |
| 12 | ~1,200 is "the economically correct answer" (≈ per-agent emission share) | **DISAGREE — ROUND12 right** | Not payable: needs a 53M CMN bond at 20% APR against a 1M `MaxStakePerAgent` cap. Works only as a non-fungible identity constraint, not a price |
| 13 | Washer gov participation is zero | **DISAGREE — ROUND12 right** | Gov farming is reachable (one held conviction vote → 20 `record_gov_vote`/era forever) and **quadruples** wash profit, 2,006 → 7,286 |
| 14 | `div_bps(1) = 0` alone is insufficient | **Agree** | Confirmed |
| 15 | SEEV P5 must not be locked | **Agree** | P5 ("wash net < 0 at genesis params") is falsified at +1,301.5 / +7,286 |
| 16 | — (not raised) | **ROUND12 new** | `MaxVolToStakeRatio` diversity cap is order-dependent, defeated by front-loading ~50 CMN of minimum escrows |
| 17 | — (not raised) | **ROUND12 new** | Wash **loses** to the high-volume honest cohort per unit capital (+884 vs +1,184). It is a dilution attack on *small* agents, not a dominant strategy |
| 18 | Harness "needs independent review", path given as `/tmp/...` | **Process failure** | The file committed to `scratchpad/` is **scaffold only** — 213 lines of constants, config and `run()`, **no anchor test, no analysis driver, produces zero output**. Every table in ROUND11.md is unreproducible from the committed artefact |

---

## 6. Verdict

### Is wash-trading a real launch blocker?

**Not on supply-safety or thesis grounds. Yes on pre-registration grounds.**

- **The supply cap is untouched.** `P` is fixed at ≤1e6/era and wash trading is purely redistributive — it moves emission share between agents, it never mints. First principle #1 is not at risk. Nothing here justifies delaying launch for safety.
- **The thesis damage is real but bounded.** The strongest ring I found (5 sybil counterparties + governance farming) earns **+884 per 1,000 CMN capital** against **+770** for a low-volume honest worker and **+1,184** for a high-volume one. It out-earns the small-agent cohort — precisely the population `floor_bps` and the diversity gate exist to protect — but it does not dominate real high-volume work. This is a chronic dilution problem, not an acute one.
- **It IS a blocker for locking SEEV tab-01 P5.** P5 as written ("wash net < 0 at genesis params") is falsified before pre-registration, at every adversary model I tested. Locking it would pre-register a known-false prediction. I concur with ROUND11 §4 on P5, P1, P2 (do not lock) and P4, P6, P7 (lock).
- **The governance-farming vector (§3.2) is the finding that most deserves its own round.** It is not wash-specific: any agent clearing `work_score > 0` can bank +4,000 bps forever off one held conviction vote. That is a live gaming vector against a guard CLAUDE.md lists as load-bearing, and it was found only because ROUND12 widened the adversary model.

### Is counterparty cost the right surface?

**Yes as a diagnosis, no as a prescription — and ROUND11's number should not be used.**

`c*` scales with the attacker's stake (1,715 CMN/era at 1k stake → 56,362 at 1M), which is the signature of a surface that genuinely binds. But `c*` at genesis parameters is **7,286 CMN/era**, 361× today's ~20, and is not expressible as a bond under `MaxStakePerAgent` or as a fee without taxing honest multi-counterparty trade off the chain. **The honest OD-4 §8 entry is "none of A/B/C, and the follow-up is a Sybil-resistant identity/diversity measure — not a repricing."** ROUND11 reached the right door and put the wrong number on it.

**Recommended next step, on this evidence:** a follow-up RFC scoped to (a) governance-participation verification hardening, (b) economic — not `AccountId` — distinctness in `diversity_score_bps`, (c) making the `MaxVolToStakeRatio` diversity cap order-independent. `MinQualifyingVol` should be left alone; §3.1 proves it cannot be made to matter.

---

## 7. Confidence, and what remains unverified

**High confidence (re-derived from runtime source, reproduced independently):**
- Anchor reproduction; `P` pinning and `n* = 100`; the +1,301.5 replication; the ≤18.2% closed-form bound on Mechanism A; that `record_gov_vote` + `is_actively_voting` permit indefinite gov farming from one held vote; that the `MaxVolToStakeRatio` credit check is order-dependent; that `create_agreement` requires counterparties to be registered agents (`BuyerNotAgent`).

**Medium confidence (model-dependent, direction known):**
- `c* = 7,286 CMN/era`. Scales inversely with `Σ_W`: my honest population is the synthetic 200-agent steady state, and I gave *all* 100 honest workers full governance participation, which inflates `Σ_W` and makes `c*` a **lower** bound on the attacker's advantage. A real chain with partial governance turnout yields a *higher* `c*`.
- The wash-vs-honest per-capital comparison depends entirely on the synthetic population's volume mix.

**Explicitly unverified — do not treat as chain facts:**
1. **The 10 CMN base transaction fee is a model assumption** (inherited MA-7), never transcribed from the runtime. Today's "~20 CMN/era per counterparty" is dominated by it. `c*` is not sensitive to it (fees are ~3% of rewards), but the 361× gap figure is.
2. **No Substrate runtime was executed.** No extrinsics, no zombienet, no WASM. This is arithmetic over a transcribed formula, same class of evidence as ROUND11.
3. **CMN-vs-plancks truncation.** The chain computes `integer_sqrt` over plancks; the model (and the anchor that pins it) uses CMN. At `stake = 1,000` this understates `sqrt_stake` by **1.97%**; at 10,000 and 1,000,000 the error is exactly 0. Mostly cancels in a proportional distribution. Inherited from the v2 sim — correcting it would break the anchor.
4. **`OracleScoreProvider = ()`** — the +20% oracle term is inert (F-5). If a provider is ever wired, every number here moves and rank 3 (`rank_bps = 15,000`) becomes reachable.
5. **Static attacker.** One washer against a fixed honest population. A wash *cartel* at scale dilutes `Σ_W` and changes every magnitude; I did not model attacker scale-up, honest adaptation, or entry/exit. Same limitation ROUND11 declared in §6.6.
6. **Discrete strategy grid** (~29 volumes, k ∈ {1,2,3,4,5,8,20}, gov ∈ {0,20}). The true optimum is at least as good as what I found, so **every wash profit here is a lower bound and every `c*` an underestimate** — the same directional caveat ROUND11 gave, now applying to a 6× larger number.
7. **SEEV workbook tab-01 not read.** Binary `.xlsx`; my P5/P1/P2 references come from the protocol spec, which VERIFIED-CONSTANTS §0 already flags as an unverified proxy.

**Where I could be wrong in the direction that matters:** if `record_gov_vote` is in practice rate-limited by something I did not find, or if honest governance turnout is far below 100%, the gov-farming leg weakens and `c*` moves toward ROUND11's figure. I checked the extrinsic, the verifier bridge, and the per-era cap and found no such limit — but this is the single assumption most worth a second reader.
