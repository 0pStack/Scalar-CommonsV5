# OD-4 — Pool-scaled gaming costs

| Field | Value |
|---|---|
| RFC ID | OD-4 |
| Status | DRAFT — for review; **no recommendation adopted** (see §8, reserved for Keith) |
| Scope | Design only. No code, no parameter changes, no storage migrations proposed for merge. |
| Origin | SC-E1 Phase-0 cross-cutting finding — R-SC-0003, R-SC-0004 (`experiments/sc-e1/SC-E1-PHASE0-RESULTS.md`) |
| System under discussion | `pallets/emissions`, `pallets/escrow`, `pallets/auto-params` |
| Author | Claude (agent-task, issue #8) |
| Companion | `SC-E1-SEEV-protocol-spec.md`, `SC-E1-phase0-verdicts.json` |

---

## 1. Problem statement

Phase-0's headline cross-cutting result:

> **Every anti-gaming guard priced as a flat CMN constant is measured against a reward that scales with the emission pool, so each guard has a pool-size expiry date.**
> (`SC-E1-PHASE0-RESULTS.md`, "Cross-cutting result")

R-SC-0003 (sybil) and R-SC-0004 (wash) are the same finding twice. Both attacks pay a **fixed** cost per era and collect a **pool-proportional** reward, so both flip from net-negative to net-positive once the per-era emission pool `P` crosses a break-even:

| Attack | Fixed cost per era (model) | Break-even pool `P*` (model) | State above `P*` |
|---|---|---|---|
| Sybil stake farm (R-SC-0003) | ~10 CMN base fee / account | **~2.78M CMN/era** | Profitable |
| Wash-to-qualify (R-SC-0004) | ~140 CMN / account | **~1.12M CMN/era** | Profitable |

For reference, the v2 historical emission schedule (~20.5M CMN/day years 1–2) sits **an order of magnitude above** both break-evens. If v4's real per-era pool lands anywhere near that, the flat guards `MinQualifyingVol = 50 CMN` (`runtime/src/lib.rs`, `EmissionsMinQualifyingVol`) and the flat base fee are guards that *expire as the chain succeeds*.

The single design principle Phase-0 extracts:

> **Gaming costs must scale with the rewards they gate.**

This RFC analyses three mechanisms that implement that principle on the **work pool**, each of which appears as a design lever in R-SC-0004. It does **not** recommend one — §8 is reserved for Keith.

### 1.1 What is *not* in scope of the three mechanisms

All three issue-specified mechanisms act on the **work (W) pool**. **None of them closes the sybil-on-stake vector (R-SC-0003)**, which farms the **stake (S) pool** and never touches escrow, work weight, or completion fees. R-SC-0003's own levers — a minimum-stake floor for S-pool participation, or excluding sub-threshold stakes from emissions entirely — are a different mechanism class (stake-side). This is called out per mechanism in each "Attack surface NOT closed" subsection and summarised in §6. Treat the S-pool sybil vector as an open companion decision, not something any option below resolves.

---

## 2. Notation and baseline algebra

All quantities are per era unless noted. Symbols are chosen to match the Phase-0 closed forms and the code.

| Symbol | Meaning | Source in code |
|---|---|---|
| `P` | Per-era emission pool (CMN) | `emission` at `settle_era` time, `pallets/emissions/src/lib.rs` |
| `w`, `s` | Work-pool / stake-pool fraction, `w + s = 1` | Modelled 60:40 (MA-2); real split is emergent from the weight formula, not a literal constant |
| `Σ_S` | Total stake weight across S-pool participants | Σ of `sqrt_stake`-derived weight |
| `Σ_W` | Total work weight across W-pool participants | Σ of `work_score`-derived weight |
| `σ` | Attacker stake | — |
| `f` | Completion fee fraction = `fee_bps / 10_000` | `CompletionFeeBps` (auto-params) → `CompletionFeeProvider` (escrow) |
| `b` | Flat burned base tx fee per escrow cycle (~10 CMN, model) | network base fee |
| `V_min` | `MinQualifyingVol` floor for W-pool floor eligibility | `EmissionsMinQualifyingVol = 50 CMN` |
| `u` | `UnitVolume` for the log work-score | `EmissionsUnitVolume = 10 CMN` |

**Work-score shape (from `compute_weight_cached`, lines ~452–460).** Work score is *logarithmic* in escrow volume:

```
work_score(V) ∝ log2(V / u) · diversity_bps
```

This sub-linearity is the crux of the whole finding: an attacker's **reward** rises like `log2(V)` in the volume they push, but a flat guard's **cost** does not rise at all. Clear the flat gate once, harvest a pool-proportional reward forever.

### 2.1 The two break-evens, derived

**Sybil (S-pool), R-SC-0003.** A sybil account stakes `σ`, does zero qualifying work, and still draws its S-pool share (Phase-0 assumes sub-threshold stakes *do* receive S-pool emissions — flagged as P0-1 verification item #3; see §7). Net per account:

```
reward  = s · P · (σ / Σ_S)
cost    = b                       (existence / minimal heartbeat)
break-even:  s · P · σ / Σ_S = b   ⟹   P* = b · Σ_S / (s · σ)
```

which is exactly the Phase-0 closed form `break-even pool = fee × total_stake / (S_split × sybil_stake)` ≈ 2.78M CMN/era at the modelled `Σ_S = 11.1M`, `s = 0.4`.

**Wash (W-pool), R-SC-0004.** A washer self-escrows exactly `V_min` to unlock floor + W-pool eligibility, harvesting the work weight of a fixed `work_score(V_min)`:

```
reward  = w · P · (work_score(V_min) / Σ_W)
cost    = f · V_min + b            (completion fee on the wash + base fee)
break-even:  w · P · work_score(V_min) / Σ_W = f · V_min + b
```

The left side scales with `P`; the right side is flat. Above `P* ≈ 1.12M CMN/era` (model) it is positive. **This is the template every mechanism below must break: make the right side (cost) scale with `P` at least as fast as the left side (reward).**

> **Hard limit carried from Phase-0 (do not launder away):** every number above is a claim about the *model* (assumptions MA-1..MA-8), not the chain. MA-3's weight formula was invented from session fragments and never transcribed from `pallets/emissions/src/lib.rs`. The **closed forms** are the durable export; the **specific break-even CMN figures** shift with the real stake distribution and the real (log) work-score already confirmed above. Re-derive against transcribed constants (tab 03 / P0-1) before any of these break-evens is treated as a chain fact.

---

## 3. Mechanism A — Pool-indexed `MinQualifyingVol`

**Idea.** Replace the flat `V_min = 50 CMN` with a floor that tracks the pool (or a proxy for it):

```
V_min(P) = k · P            (pool-indexed)
     or  = k · median_honest_volume
     or  = k · P / active_agents   (per-capita indexed)
```

so that the volume a washer must push to qualify rises with the reward on offer.

### 3.1 Break-even algebra

Substitute `V_min(P) = k · P` into the wash break-even:

```
reward  = w · P · work_score(k·P) / Σ_W  =  w · P · log2(k·P / u) / Σ_W
cost    = f · k · P + b
```

The cost now grows **linearly** in `P` (`f·k·P`), while the reward grows like `P · log2(P)` — but the *washer's own* reward is bounded by the fixed slice of `Σ_W` they can occupy, and the marginal qualification cost `f·k·P` climbs without bound. Concretely, the wash margin

```
margin(P) = w · P · log2(k·P/u) / Σ_W − f·k·P − b
```

is dominated for large `P` by the linear cost term `−f·k·P` whenever `f·k > w·log2(k·P/u)/Σ_W`, i.e. once `k` is chosen so the per-unit fee outruns the per-unit (log) work reward. **The flat-cost/scaling-reward asymmetry that created the expiry is removed to first order, and inverted for large `P`** — the guard gets *stronger* as the chain grows rather than expiring.

### 3.2 Auto-params integration path

`MinQualifyingVol` today is a runtime `#[pallet::constant]` (`EmissionsMinQualifyingVol`, `runtime/src/lib.rs`), read in `compute_weight_cached` via `T::MinQualifyingVol::get()`. It is **not** currently an auto-param. To pool-index it:

1. Move the live value into `pallets/auto-params`: add `MinQualifyingVol<T>` (`StorageValue`, `ValueQuery`), `MinQualifyingVolBounds<T>` (`ParamBounds`), `InitialMinQualifyingVol` config constant, and genesis wiring — mirroring the existing `FloorBps` pattern (lines 137–139, 92–94).
2. Extend `AutoParamsProvider` with `fn min_qualifying_vol() -> BalanceOf` and a `live_min_qualifying_vol()` helper; have emissions read it through the provider (exactly as it already reads `floor_bps()`, line 873) instead of the constant.
3. Add `era_emission: Balance` (the pool `P`) to `EraMetrics` (`pallets/auto-params/src/lib.rs:43`). Emissions already has `emission` in hand at `settle_era`; pass it into `run_era_rules(EraMetrics { … })` (`pallets/emissions/src/lib.rs:301`).
4. Add a rule `rule_qualifying_vol(m)` computing `target = k · m.era_emission` (or `k · median`), stepping `MinQualifyingVol` toward it clamped by `max_step`/`min`/`max`, emitting `ParamAutoAdjusted` — same shape as `rule_ring_farming` (lines 293–329).

**Migration weight.** New storage items ⟹ **storage-layout change ⟹ migration + `spec_version` bump** (per CLAUDE.md hard rule). Moderate: the constant simply becomes a live value; no per-agent state.

### 3.3 Attack surface it does NOT close

- **S-pool sybil (R-SC-0003) — untouched.** Sybils farm the stake pool and never qualify for anything; a work-side gate is invisible to them.
- **Median-indexing is itself a gaming surface.** `V_min = k · median_honest_volume` can be pushed up by a cartel transacting coordinated large volume they can afford, pricing out honest *small* agents (a griefing / centralisation vector that raises the entry bar for legitimate low-volume workers — the exact population the floor was meant to include).
- **Pool-read volatility.** If `P` swings era-to-era, the gate whipsaws; an agent mid-escrow can drop below a newly raised floor and lose the era's floor share through no fault. `max_step` bounding dampens but does not eliminate this.
- **Raises the entry bar, does not invert for the whale.** A washer with enough capital to clear the higher gate still profits on the *marginal* wash whenever their marginal (log) work reward exceeds the marginal fee. Mechanism A moves `P*` up (buys time); it does not make wash *structurally* impossible the way Mechanism C aims to.

---

## 4. Mechanism B — Percentage / pool-scaled completion fee

**Idea.** The completion fee is *already* a percentage of escrow volume (`amount · fee_bps / 10_000`, `pallets/escrow/src/lib.rs:245–248`). The lever here is to make that percentage the **primary** anti-wash cost and let auto-params **raise it with the pool** (and/or make it progressive in washed volume), so the fee a washer pays tracks the reward they extract.

### 4.1 Break-even algebra

A flat percentage fee alone does *not* close wash, and the algebra shows why. A washer choosing volume `V` faces:

```
reward(V) = w · P · log2(V/u) / Σ_W        (concave, log)
cost(V)   = f · V + b                        (linear)
```

Because reward is concave and cost linear, the washer's optimum is **small** `V` (just clear the gate) — a flat `f` never bites the minimal washer. To invert the *minimal* washer you need the fee on the qualifying volume to exceed the unlocked reward:

```
f · V_min ≥ w · P · log2(V_min/u) / Σ_W
     ⟹   f(P) ≥ w · P · log2(V_min/u) / (Σ_W · V_min)
```

The required fee rate `f` **grows linearly with `P`**. That is the whole point: a *pool-scaled* fee (auto-params raising `fee_bps` as `P` grows) keeps the deterrent alive; a *frozen* `fee_bps` does not. For large-volume washers, the fee's linear-in-`V` cost eventually dominates the log reward regardless — Mechanism B's weakness is entirely at the low-volume (minimal-qualify) end, which is why it pairs naturally with Mechanism A.

### 4.2 Auto-params integration path

**Least invasive of the three** — the plumbing already exists:

1. `CompletionFeeBps<T>` already lives in auto-params with `CompletionFeeBounds`, and `rule_ring_farming` already steps it up on ring detection (lines 293–329). Escrow already reads it via `CompletionFeeProvider` (line 104, 245).
2. Add `era_emission` to `EraMetrics` (as in §3.2 step 3) and either (a) extend `rule_ring_farming` with a pool-indexed target, or (b) add a small `rule_fee_pool_scaling(m)` that steps `fee_bps` toward `g(m.era_emission)` within existing bounds.
3. **No new storage, no per-agent state, no weight-formula change.** If bounds/step already cover the needed range, this may not even require a migration (only a rule addition + config) — confirm before claiming so.

### 4.3 Attack surface it does NOT close

- **Taxes honest trade.** The completion fee is paid by *every* real counterparty. Raising it to price out washers imposes deadweight loss on genuine escrow — there is a ceiling above which honest volume simply leaves. This directly trades off against the chain's coordination-infrastructure purpose (CLAUDE.md first principle #5).
- **S-pool sybil (R-SC-0003) — untouched.** Sybils never `confirm_delivery`, so they never pay a completion fee.
- **Fee routing softens the deterrent.** The completion fee is currently routed to **Treasury** (`FeeDestination`, `pallets/escrow/src/lib.rs:254–259`), not burned. A washer who is also a large staker/treasury beneficiary partially **recycles** the fee back to themselves. For the fee to be a true dead cost it must be **burned**, or routed to a pool the payer cannot reach.
- **Intra-cartel wash.** If both escrow sides are cartel-controlled and the fee lands in a pool the cartel draws from, the "cost" is an internal transfer. Only burning makes it a genuine loss.

---

## 5. Mechanism C — W-weight capped by cumulative fees burned

**Idea.** Bound each agent's work-pool weight (or claimable W-pool reward) by the fees that agent has actually **burned**:

```
work_weight_agent ≤ κ · fees_burned_agent          (weight-space cap)
     or, cleaner:  W-reward claimable ≤ fees_burned_agent   (reward-space cap)
```

R-SC-0004 states the intent precisely: *"weight ≤ f(fees paid) makes wash profit structurally impossible."*

### 5.1 Break-even algebra

Take the reward-space form. If an agent's claimable W-pool reward `R` is capped at its burned fees `F`:

```
R ≤ F   ⟹   R − F ≤ 0   for all P
```

Wash profit is **structurally impossible at every pool size** — no break-even exists, because the reward is definitionally bounded by the cost. This is the only one of the three with no `P*`.

For the weight-space form `ŵ ≤ κ·F`, the reward is `R = w·P·(κ·F)/Σ_W`, and `R ≤ F` requires

```
κ ≤ Σ_W / (w · P)
```

i.e. `κ` must itself be **pool-indexed** to preserve the guarantee — the flat-constant expiry re-appears in `κ` unless auto-params tracks it. The reward-space form avoids this entirely and is therefore the stronger construction.

### 5.2 Auto-params integration path

**Most invasive of the three.** The core is not an auto-param at all — it is new per-agent state plus a weight-formula change:

1. **New per-agent, per-era storage** `EraFeesBurned<T>` accumulated where the fee is charged (`escrow::confirm_delivery`), attributed to the provider, drained each era exactly like `EraEscrowVolume` (`pallets/emissions/src/lib.rs` era-map drain, line ~275).
2. **Weight-formula change** in `compute_weight_cached` to clamp the work contribution (or `do_claim` to clamp the reward). Load-bearing economic edit ⟹ mandatory `tokenomics-security-reviewer` pass.
3. **Requires the fee to be truly burned**, not Treasury-routed (see §4.3) — otherwise "fees burned" overstates real cost and the cap leaks.
4. auto-params' role is secondary: it could tune `κ` (bounds + rule) in the weight-space form, but the reward-space form needs almost none.

**Migration weight.** New per-agent storage + weight-formula change ⟹ **migration + `spec_version` bump + full tokenomics review.** Heaviest of the three.

### 5.3 Attack surface it does NOT close

- **Punishes efficient honest work — thesis tension.** An honest agent delivering genuinely high value at *low* fee is capped by fees paid, i.e. rewarded for **fees**, not **work** — in direct tension with first principle #2 ("reward verifiable work, not raw stake" — and not raw fees either). The most efficient honest agents hit the cap first. This is the sharpest cost of Mechanism C.
- **Rich-attacker workaround.** An attacker can *burn real fees* to lift their own cap, then farm the W-pool up to it. In the reward-space form this nets ≤ 0 (safe by construction); in the weight-space form with mis-set `κ > Σ_W/(wP)` it is profitable. Correctness hinges entirely on the cap constant.
- **Lifetime vs per-era.** A *cumulative-lifetime* fee cap lets an agent bank fee history in cheap eras then farm at a high-pool era — the flat-constant expiry reincarnated in the **time** dimension. The cap must be per-era or decaying.
- **Cold-start / onboarding conflict.** New honest agents have zero fee history ⟹ zero W-weight ⟹ cannot bootstrap. Directly collides with the per-agent `onboarding_boost` (10,000 bps for first 10 completions, `pallets/emissions/src/lib.rs:245–247`, 512–515), which exists precisely to reward newcomers before they have a track record.
- **S-pool sybil (R-SC-0003) — untouched.** Work-pool cap; sybils farm stake.

---

## 6. Comparison summary

| Dimension | A: Pool-indexed `V_min` | B: Pool-scaled completion fee | C: Fee-burned weight cap |
|---|---|---|---|
| Closes wash (R-SC-0004)? | Raises & can invert `P*` | Only if fee scales with `P`; weak at minimal-qualify | **Structurally** (reward-space), no `P*` |
| Closes S-pool sybil (R-SC-0003)? | No | No | No |
| Auto-params fit | New live param + rule | **Reuses existing** `CompletionFeeBps` + rule | Secondary; core is new storage + formula |
| Storage migration / `spec_version` | Yes (moderate) | Possibly none (rule-only) | Yes (heaviest) |
| Hits honest participants? | Small honest workers (entry bar) | All honest trade (fee tax) | Efficient low-fee workers (thesis tension) |
| Primary residual risk | Median-index gaming; whipsaw | Fee recycling if not burned; deadweight loss | Cold-start; lifetime-banking; fees≠work |
| Key precondition | Live `P` in `EraMetrics` | Fee **burned**, not Treasury-routed | Fee **burned** + per-era cap |

**Cross-cutting gap (all three):** none addresses the stake-pool sybil vector (R-SC-0003). Whichever work-side mechanism is chosen, a stake-side companion (min-stake floor for S-pool participation, or exclusion of sub-threshold stakes) remains an open, separate decision.

---

## 7. Open questions (must resolve before any implementation RFC)

1. **P0-1 verification, item #3:** *do sub-`MinQualifyingVol` accounts receive S-pool emissions at all?* If they do not, R-SC-0003's break-even changes materially and Mechanism selection shifts. This is unresolved in Phase-0 and gates the sybil algebra in §2.1.
2. **Real per-era pool schedule `P(t)`.** All three mechanisms' urgency depends on whether the live `P` approaches the ~1.12M / ~2.78M break-evens. The emission schedule must be transcribed (tab 03) before sizing any constant.
3. **Burn vs Treasury for the completion fee.** Mechanisms B and C are only as strong as the fee being a *real* dead cost. Changing `FeeDestination` to burn is itself an economic change requiring its own gaming-vector analysis (and interacts with the supply cap — burns are deflationary, never mint, so cap-safe).
4. **Weight-formula transcription (MA-3).** The log work-score is confirmed present (§2), but the full functional form and the emergent `w:s` split must be transcribed before the break-even CMN figures are treated as chain facts rather than model outputs.
5. **Composition.** A and B are complementary (A fixes the minimal-qualify low end where B is weak; B scales the cost B-side). C can stack on either. Whether to adopt one or a layered pair is a §8 decision.

---

## 8. Recommendation

> **Reserved for Keith.**
>
> This RFC deliberately stops at analysis. It presents the three mechanisms, their break-even algebra, their auto-params integration paths, and the attack surface each leaves open, without selecting among them. The selection — one mechanism, a layered pair (e.g. A+B), or C's structural cap, plus the separate stake-side companion for R-SC-0003 — is left for Keith, to be recorded here with rationale before mainnet parameters are locked.

---

## 9. References

- `experiments/sc-e1/SC-E1-PHASE0-RESULTS.md` — R-SC-0003, R-SC-0004, cross-cutting result, action #4 (open OD-4).
- `experiments/sc-e1/SC-E1-SEEV-protocol-spec.md` — C-1b guard inventory, P0 gates, hard limits.
- `pallets/emissions/src/lib.rs` — `compute_weight_cached` (work-score log shape, `MinQualifyingVol` gate, velocity bonus), `settle_era`, `run_era_rules` call site.
- `pallets/auto-params/src/lib.rs` — `EraMetrics`, `ParamBounds`, `AutoParamsProvider`, `rule_ring_farming` / `rule_oracle_participation` / `rule_emission_concentration` (rule pattern), `apply_param_checked`.
- `pallets/escrow/src/lib.rs` — completion-fee application (`CompletionFeeProvider`, `FeeDestination` → Treasury).
- `runtime/src/lib.rs` — `EmissionsMinQualifyingVol` (50 CMN), `EmissionsUnitVolume` (10 CMN), `EmissionsVelocityBonusBps` (3000), auto-params initial constants.
- `CLAUDE.md` — first principles (supply cap, work-not-stake, no root-gated liveness, every parameter is a gaming surface), hard rules (storage migration + `spec_version`, load-bearing guards).
