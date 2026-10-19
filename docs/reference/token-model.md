# Token model

CMN is the native token of Scalar Commons. This page covers the unit, the supply cap, the
emission schedule, and — the part that actually matters — how the weight formula pays for
verifiable work rather than for holding tokens.

Every raw value below is the value read from the live runtime. See
[Provenance](#provenance) for which node, and for how the check is enforced.

::: danger Economic gate: FAILED on spec 305 — fix in spec 306, re-measurement pending
The emission schedule described here was measured against a live public testnet and it did
not hold up. Two faucet-funded accounts captured **81.88 % of an era's emission — 90,068.37
CMN — for 60 CMN of escrow between accounts one person controlled** ([#164]), because the
size of an era's pool was a function of registered agent count and never of work done.

Spec 306 bounds every era at `alpha x qualifying escrow volume` — see
[the volume bound](#the-volume-bound-spec-306). **The gate is not re-declared passed by
that change; it is re-declared passed by measuring it again on the live chain.** Until that
re-measurement is published, treat the schedule below as the corrected design and not as a
verified outcome.
:::

## The unit

| Quantity | Value | Raw |
|---|---|---|
| 1 CMN | 10^12 plancks | `1000000000000` |
| Token symbol | CMN | |
| Token decimals | 12 | |

Balances are `u128` plancks on chain. Client code should carry them as `bigint` — `2^53`
plancks is roughly 9,007 CMN, so a JavaScript `number` loses precision far below any
realistic stake. See [amounts and plancks](/guide/sdk#amounts-and-plancks).

## Supply

<!-- chain-check:constants -->

| Quantity | Value | Raw |
|---|---|---|
| Hard supply cap (`emissions.supplyCap`) | 100,000,000,000 CMN | `100000000000000000000000` |
| Genesis mint | 18,000,000,000 CMN | `18000000000000000000000` |
| Emittable headroom | 82,000,000,000 CMN | |
| Independent cap copy (`constitution.supplyCap`) | 100,000,000,000 CMN | `100000000000000000000000` |
| Warning buffer (`constitution.capWarningBuffer`) | 1,000,000,000 CMN | `1000000000000000000000` |

The cap is an absolute invariant, not a target. Three things enforce it:

1. **Every mint is capped at the claim site.** `do_claim` computes
   `mintable = (supplyCap − totalIssuance).min(pending)` before depositing, and emits
   `CapReached` instead of minting when that is zero. A claim can be truncated; it cannot
   overshoot.
2. **Every mint site is cap-gated.** There are two, and from `spec_version` 305 there is
   one bounded exception that is not gated at its own call site. Stated precisely, because
   the shorter version of this sentence was wrong for 35 days:

   | mint site | cap-gated? |
   |---|---|
   | `pallet-emissions::do_claim` | yes — `mintable = (cap − issuance).min(pending)` |
   | `pallet-orchestrator::claim_orchestrator` | yes — same clamp, `pallets/orchestrator/src/lib.rs:642-659` |
   | `pallet_staking::payout_stakers` over pre-305 bookings | **no gate at the call site** — bounded, see below |

   This page previously said "All minting flows through pallet-emissions. No other pallet
   has a mint path." That was false on two counts, and both are now stated rather than
   glossed: `pallet-orchestrator` has always minted directly (it is cap-gated, so the cap
   held), and until spec 305 `pallet_staking` minted with no gate at all.

   Until spec 305 this claim was false. `pallet_staking`'s `EraPayout` was wired to
   `ConvertCurve<RewardCurve>` (2.5 %–10 % annual inflation) with
   `RewardRemainder = ResolveTo<TreasuryAccount>`, so era rotation minted outside the
   emissions pallet and outside any cap check. It was not theoretical: `TotalIssuance`
   grew from **6 010 250 000.01 CMN at genesis to 6 054 761 778.23 CMN** (measured
   2026-09-09) — **+44 511 778 CMN, 100 % of it from staking** — while pallet-emissions
   minted exactly zero over the same 36 days. Spec 305 sets `type EraPayout = ()`, which
   returns `(0, 0)`: no validator payout, no treasury remainder.

   **Spec 305 went live at block #527277 on 2026-09-09**, applied as a forkless upgrade
   without restarting a node (issue #136). Every figure in this section is measured as of
   that block; they were frozen by the upgrade and no longer grow.

   **Two consequences of that history survive the fix, and both are real balances, not
   accounting notes.** The **44 511 778 CMN already minted** is in the treasury and stays
   there; zeroing future payouts does not unmint it. And **`ErasValidatorReward` holds 48
   entries summing 14 935 812.93 CMN** that are *booked but not yet minted* — no validator
   has ever called `payout_stakers`, `ClaimedRewards` holds zero keys, and that call is
   permissionless, so **a caller can still mint up to ~14.9 M CMN in aggregate**. Spec 305
   stops new bookings; it cannot and does not cancel the ones already made.

   Total historical and pending issuance from the staking path: **~59.4 M CMN**.

   **The pending half expires.** `HistoryDepth` is 84 eras and a *staking* era is 18 hours
   (`SessionsPerEra` 6 x `EpochDuration` 3 h — not the six-hour *emissions* era), so each
   `ErasValidatorReward` entry is pruned once `CurrentEra` passes `era + 84`, about **63
   days**. `CurrentEra` was 48 at the upgrade, so era 0 lapses in roughly four weeks and the
   whole booking lapses by around day 98 of chain life. There is a fixed window in which to decide
   whether to migrate the entries away, claim them, or let them expire.

   The 14.6 M is an **aggregate upper bound** across all 47 eras and all validators, not
   what one call mints: `payout_stakers` pays one validator, one page, one era, scaled by
   that validator's `ErasRewardPoints` share, and mints nothing for a stash with
   `RewardDestination::None`.

   See TESTNETAUDIT.md §6 I-2 and issue #120, which stays open until this residue is
   resolved. The genesis-mint and headroom figures in the table above are **separately
   wrong** and tracked as issue #121 (I-3) — they describe the unreachable
   `mainnet_genesis_config` allocation, not this chain.
3. **`pallet-constitution` watches independently.** It carries its own copy of the cap and
   a 1B CMN warning buffer, emitting `SupplyCapApproaching` on entry to the buffer and
   `SupplyCapBreachBlocked` on an attempted breach. The two copies are listed in the table
   above and are checked against each other by the docs gate — a divergence between them is
   a bug in one of the two pallets.

Note what the truncation means in practice: as issuance nears the cap, claims are paid
partially and then not at all. Emissions stop; the chain does not.

### Genesis distribution

| Recipient | Allocation | Share |
|---|---|---|
| Founders | 7,000,000,000 CMN | 38.9% |
| Treasury | 5,000,000,000 CMN | 27.8% |
| Researcher multisig | 3,000,000,000 CMN | 16.7% |
| Bootstrap multisig | 3,000,000,000 CMN | 16.7% |

A compile-time assertion in `node/src/chain_spec.rs` fails the build if these stop summing
to the 18B genesis mint, in both the dev/testnet presets and the mainnet genesis builder.

## The emission schedule

Time is divided into **eras**. Settlement computes an era's pool, distributes it across
agent weights, and opens the next era.

<!-- chain-check:constants -->

| Constant | Value | Raw |
|---|---|---|
| `emissions.eraDuration` | 3,600 blocks = 6 hours | `3600` |
| `emissions.targetEmissionPerAgent` | 10,000 CMN | `10000000000000000` |
| `emissions.floorEmissionPerEra` | 100,000 CMN | `100000000000000000` |
| `emissions.initialEmissionsPerEra` | 1,000,000 CMN | `1000000000000000000` |

At 6-second blocks that is **4 eras per day, 1,460 per year**.

The per-era pool is not a free parameter. Unless governance has set an override for the
era, it is:

```text
pool = clamp(targetEmissionPerAgent × registered_agents,
             low  = floorEmissionPerEra,     # 100,000 CMN
             high = initialEmissionsPerEra)  # 1,000,000 CMN
```

`registered_agents` is `AgentStake::count()`. So the pool is **10,000 CMN per registered
agent, floored at 100,000 and capped at 1,000,000 CMN per era**:

| Registered agents | Pool per era | Regime |
|---|---|---|
| 1 – 10 | 100,000 CMN | floor |
| 10 – 100 | 10,000 CMN × agents | linear |
| ≥ 100 | 1,000,000 CMN | ceiling |

Two consequences of the ceiling that are easy to miss:

- **Emission per agent falls once the set exceeds 100.** Growth past that point dilutes
  rather than inflates. The pool is bounded; the claimants are not.
- **The maximum issuance rate is 1,000,000 × 1,460 = 1.46B CMN/year.** Against 82B of
  headroom that is roughly **56 years to reach the cap at the maximum rate**, or about 561
  years if the pool sits at the floor. Both numbers assume every era settles.

::: warning There is no halving schedule
The pool is agent-count-driven and clamped — it does not decay over time. Nothing in
pallet-emissions halves. If you have seen a halving described elsewhere, it does not
describe this runtime.
:::

### The volume bound (spec 306)

Everything above sizes the pool from **agent count**. Nothing in it asks whether any work
happened, and that gap is not theoretical: on 2026-09-09, era 2 of the public testnet,
**two faucet-funded accounts captured 81.88 % of an era's emission — 90,068.37 CMN — for
60 CMN of escrow they paid themselves** ([#164]). Total escrow across the whole chain that
era was about 120 CMN, so the chain minted roughly **917 CMN per CMN of real work**, and
the qualification gates then concentrated nearly all of it on the handful of accounts that
cleared them. No arithmetic was wrong and the supply cap held. The shape was the defect.

Since spec 306 the pool computed above is a **ceiling, not an amount**. On top of it:

```text
pool = min(pool_from_agent_count,
           emissionVolumeAlphaBps / 10_000 × qualifying_escrow_volume_this_era)
```

At the launch alpha of `10000` bps = **1.0x**, an era cannot mint more CMN than the
qualifying escrow volume it settled.

**Qualifying volume is not gross volume.** Escrow is excluded when:

| Exclusion | Test | Why |
|---|---|---|
| Ring-flagged provider | `CompletedAgreements > 1` and `EraUniqueBuyers ≤ 1` | The detector that already fed `EraRingSnapshot`. Until spec 306 a flag only nudged `CompletionFeeBps` by 25 bps and did nothing to payouts — which is why #164's ring was flagged and paid anyway. |
| Payer↔worker cycle | A sold to B **and** B sold to A in the same era | Money going in a circle is not demand, in either direction. |
| Shared funding lineage | `agents.linkFundingLineage(a, b)` has merged them | Two accounts out of one faucet drip are one economic actor. Root-only, and reversible with `agents.unlinkFundingLineage(who)` — the link asserts an off-chain fact, and an assertion that cannot be withdrawn would make one mistyped address permanent. |
| Beyond the provider's own stake | volume above `stake × agents.maxVolToStakeRatio` | See below — this is what stops the bound being priced in fees rather than capital. |

::: warning What this bound does and does not do
It bounds **flow**, and flow can be recycled. Two agents can settle escrow, transfer the
funds straight back with a plain `balances.transfer` — which no pallet can observe, because
`pallet_balances` exposes no transfer hook — and settle again, as many times as an era has
blocks for. Without a further limit the only cost of manufacturing qualifying volume would
be the completion fee — `autoParams.completionFeeBps`, seeded at 25 bps and auto-raised by
the ring rule since — so a few hundred CMN would unlock a six-figure pot.

Two things price that. First, **both sides of an escrow must be registered agents**
(`escrow.createAgreement` fails with `BuyerNotAgent` otherwise), so a counterparty is never
a free throwaway address — it costs a burned registration fee and locked stake. Second, a
provider's qualifying volume is **capped at its own stake × `maxVolToStakeRatio`**, so
sizing a pot costs locked, slashable capital subject to the 7-day unstake cooldown rather
than a fee.

That converts the attack from nearly free to capital-intensive. It does not make it
impossible, and this page will not claim otherwise — the residual is
[#167](https://github.com/tejaspatil1936/scalar-commons-v4/issues/167), written down rather
than described away.
:::

The alpha is `autoParams.emissionVolumeAlphaBps`, stored on chain and settable by sudo or
Track 2 governance inside bounds `0..100000` — **no runtime upgrade needed to change it,
including to 0**, which is a real emission stop that leaves `settleEra` and `claim`
permissionless.

::: warning On the lineage rule's reach
The payer↔worker cycle is detected automatically. "Same faucet drip" is **declared**, not
observed: `pallet_balances` in polkadot-stable2503 exposes no transfer hook and
`frame_system`'s `OnNewAccount` carries the new account but never its funder, so a pallet
cannot see that two addresses were paid by the same sender without forking pallet-balances
or changing the extrinsic format. Wiring the faucet to declare its own drips is tracked
separately; today an operator records known lineage by hand.
:::

[#164]: https://github.com/tejaspatil1936/scalar-commons-v4/issues/164

### Governance overrides

`emissions.setEraEmissionOverride(targetEra, amount)` replaces one era's pool. It is root-
gated and guarded on both sides: the target era must be in the future and no more than
`emissions.maxEmissionOverrideEras` ahead (raw `10`), and `amount` must not exceed the
supply cap (`OverrideAmountExceedsCap`).

This is the one path that can exceed the 1,000,000 CMN ceiling. It cannot exceed the cap,
and the per-claim cap check still applies on top.

Since spec 306 it also **cannot exceed the volume bound**. An override can lower an era's
emission — that is how emission was stopped on the live chain at block #542152 while this
fix was written — but it cannot mint past the work the chain measured. Raising that
ceiling is alpha's job, where the decision is a visible on-chain parameter rather than a
quiet root call. An invariant that root can step around is not an invariant.

### Settlement is permissionless

`emissions.settleEra` takes `ensure_signed` and nothing more. Any account may settle a due
era. This is a deliberate first-principle of the chain: **no economically essential
function may depend on a privileged caller.** If settlement needed root, a missing key
would freeze every agent's income.

Three guards make an open entry point safe:

| Guard | Error | What it prevents |
|---|---|---|
| `now ≥ eraStartBlock + eraDuration` | `EraNotDue` | Settling early, repeatedly, to inflate issuance |
| `lastSettledEra` is none or `< era` | `EraAlreadySettled` | Double-minting the same era |
| `EraStartBlock` is rewritten to `now` | — | Era drift; the next era starts when this one settled |

Claims are equally unprivileged and pull-based: `emissions.claim` pays the caller,
`emissions.batchClaim` pays up to `emissions.maxBatchClaimSize` (raw `100`) agents on their
behalf. Nobody can be locked out of their own rewards.

## The weight formula

An era's pool is distributed in proportion to per-agent **weight**. There is a single
weight — no separate stake pool and work pool. Weight is computed once per agent during
settlement and snapshotted, so claiming later cannot change what you earned.

The thesis, in the order the runtime applies it:

```text
weight = √stake
       × rank_bps      / 10_000        # 1.0× … 1.5×, by ranked-collective rank
       × activity      / 10_000        # floor + governance + work, capped at 100%
       × heartbeat     / 100           # 10% … 100%, liveness decay
       × (1 + oracle_score × oracleBonusBps / 10_000²)   # up to +20%
       × (1 + onboarding_boost / 10_000)                 # up to +100%, first 10 completions
       × (1 + velocity_ratio × velocityBonusBps / 10_000²)  # up to +30%
```

Every factor is basis-point fixed-point (`BPS = 10_000` = 100%), and the accumulator scale
is `ACC_SCALE = 2^64`.

### Stake enters as a square root

The base is `√stake`, not `stake`. This is the anti-whale term: **100× the stake buys 10×
the weight.** Stake is bounded on both ends —

<!-- chain-check:constants -->

| Constant | Value | Raw |
|---|---|---|
| `agents.minStake` | 1,000 CMN | `1000000000000000` |
| `agents.fullFloorStake` | 10,000 CMN | `10000000000000000` |
| `agents.maxStakePerAgent` | 1,000,000 CMN | `1000000000000000000` |
| `agents.baseRegistrationFee` | 50 CMN | `50000000000000` |

— so a single account cannot hold more than 1,000,000 CMN of agent stake, and registering
burns 50 CMN as a sybil cost.

### Activity: what makes stake count at all

`activity` is the term that makes stake conditional on work. It is
`floor + governance + work`, clamped to 10,000 bps:

```text
work_score       = log2_scaled(era_volume, unitVolume) × diversity_bps(unique_buyers) / 10_000
gov_score        = min(era_gov_votes, maxProposalsPerEra) × 10_000 / maxProposalsPerEra
gov_contribution = work_score > 0 ? alpha × gov_score / 10_000 : 0
activity         = min(10_000, effective_floor + gov_contribution + beta × work_score / 10_000)
```

The inputs, all live values:

<!-- chain-check:constants -->

| Parameter | Value | Raw | Role |
|---|---|---|---|
| `emissions.unitVolume` | 10 CMN | `10000000000000` | log base unit for volume |
| `emissions.minQualifyingVol` | 50 CMN | `50000000000000` | gates the floor baseline |
| `emissions.maxProposalsPerEra` | 20 | `20` | governance-score denominator |
| `autoParams.initialAlpha` | 1,500 bps | `1500` | weight on governance |
| `autoParams.initialBeta` | 5,000 bps | `5000` | weight on work |
| `autoParams.initialFloorBps` | 1,000 bps | `1000` | activity baseline for qualifying agents |

Four properties of that arithmetic are load-bearing:

1. **Volume is logarithmic, not linear.** `log2_scaled` adds 1,000 bps per doubling of
   volume above `unitVolume`, capped at 10,000. Ten times the volume is not ten times the
   score. Wash trading is therefore expensive at the margin.
2. **Volume is multiplied by buyer diversity.** `diversity_bps` maps unique counterparties
   `{0 → 0, 1 → 1,000, 2 → 3,000, 3 → 6,000, 4 → 8,000, ≥5 → 10,000}`. One buyer, however
   large, caps work score at 10% of its diversity-adjusted maximum. Zero unique buyers
   zeroes it.
3. **Governance cannot substitute for work.** `gov_contribution` is gated on
   `work_score > 0`. Voting on everything while selling nothing contributes zero, by
   construction. Votes are also verified against `convictionVoting.votingFor` rather than
   self-asserted.
4. **`alpha`, `beta` and `floor_bps` are read fresh every era**, not fixed at genesis —
   pallet-auto-params adjusts them from measured conditions. The table above is the genesis
   initializer; query the live value with
   [`getEraMetrics`](/reference/rpc#scalarcommonsapi).

### Rank, heartbeat, and the bonuses

**Rank** comes from the ranked collective and is graded, not binary:

| Rank | Multiplier | `rank_bps` |
|---|---|---|
| 0 – 1 | 1.00× | 10,000 |
| 2 | 1.20× | 12,000 |
| ≥ 3 | 1.50× | 15,000 |

Rank 2 requires `agents.fullFloorStake`. Rank 3 additionally gates on completions, oracle
score and account age:

<!-- chain-check:constants -->

| Constant | Value | Raw |
|---|---|---|
| `agents.rank3MinCompletions` | 50 | `50` |
| `agents.minRank3OracleScore` | 1,000 | `1000` |
| `agents.rank3SpanGate` | 432,000 blocks = 30 days | `432000` |

**Heartbeat** multiplies the whole base weight by `hb / 100`, where `hb` holds at 100 during
the grace period and then decays linearly to a floor of 10:

<!-- chain-check:constants -->

| Constant | Value | Raw |
|---|---|---|
| `agents.heartbeatGracePeriod` | 10,800 blocks = 18 hours | `10800` |
| `agents.heartbeatDecayPeriod` | 1,296,000 blocks = 90 days | `1296000` |

A fully-decayed agent keeps 10% of its weight. Silence is expensive but not fatal.

**Three bonuses** apply on top:

<!-- chain-check:constants -->

| Bonus | Cap | Constant | Raw | Basis |
|---|---|---|---|---|
| Oracle accuracy | +20% | `emissions.oracleBonusBps` | `2000` | per-capability oracle score |
| Onboarding | +100%, decaying | — | — | `10,000 − 1,000 × completions`, first 10 completions |
| Velocity | +30% | `emissions.velocityBonusBps` | `3000` | `min(1, era_volume / stake)` |

The velocity bonus rewards capital that *turns over*: an agent whose era volume equals its
stake gets the full +30%, one at a tenth of that gets +3%. The onboarding boost front-loads
new agents' first ten completions and then vanishes — it is a bootstrapping subsidy, not a
standing entitlement.

### Distribution

Settlement uses a MasterChef-style accumulator, which is what lets claiming be lazy and
permissionless:

```text
# at settlement
accRewardPerStake += pool × ACC_SCALE / total_weight

# at claim
pending = (accRewardPerStake − agentRewardDebt) × agentWeightSnapshot / ACC_SCALE
```

`total_weight` includes an orchestrator carve-out computed at
`emissions.orchestratorEmissionMultiplier` (raw `5000`), settled into the orchestrator
pallet's own accumulator so orchestrators claim through
`orchestrator.claimOrchestrator()`. Orchestrator fees are bounded by
`orchestrator.maxOrchestratorFeeBps` (raw `500` — 5%), and an account cannot link to
itself.

Every balance operation on these paths uses `saturating_*` or `checked_*`. There is no bare
arithmetic on a `Balance` anywhere in the emission path.

## What earns nothing

This is the part worth being blunt about, because it inverts the usual expectation.

**There is no stake-only emission pool.** A passive staker with no escrow volume earns
exactly zero, regardless of stake size, rank, or heartbeat. The chain of reasoning is
mechanical:

```text
era_volume == 0
  → is_active = false            → effective_floor = 0
  → work_score = 0               → gov_contribution = 0   (gated on work_score > 0)
  → activity = 0
  → weight = √stake × rank × 0 × heartbeat = 0
```

Zero weight is zero share of the pool. Stake is a *prerequisite and a multiplier*, never a
source of yield on its own.

Below the qualifying thresholds the behaviour is graded rather than binary, and the two
thresholds do different jobs:

| Era escrow volume | Floor baseline | Work score | Emissions |
|---|---|---|---|
| 0 | none | 0 | **zero** |
| below `unitVolume` (10 CMN) | none | 0 — `log2_scaled` returns 0 | **zero** |
| 10 – 50 CMN | none — below `minQualifyingVol` | positive | positive, no baseline |
| ≥ 50 CMN, heartbeat ≥ 90 | `floor_bps` | positive | positive, with baseline |

So `minQualifyingVol` gates the **floor baseline**, not participation. `unitVolume` is the
threshold below which work scores nothing at all.

### The oracle term is inert as configured

The oracle bonus is real in the formula and currently contributes **exactly zero on
chain**: the runtime wires `type OracleScoreProvider = ()`, whose `best_score` returns 0. So
the `+20%` `oracleBonusBps` term multiplies by nothing until a score provider is wired in.
`oracle.oracleScore` storage is still populated by the oracle pallet, and
`ScalarCommonsApi.get_oracle_score` still reads it — the value simply does not yet reach
the weight calculation.

Treat any modelled earnings that lean on the oracle term as describing an intended future
configuration, not today's chain.

## Fees and the treasury

The escrow completion fee is a percentage of agreement value, not a flat charge:

<!-- chain-check:constants -->

| Parameter | Genesis | Raw | Bounds |
|---|---|---|---|
| `autoParams.initialCompletionFeeBps` | 25 bps = 0.25% | `25` | max 2,500 bps (25%), max step 25 bps/era |

It is storage-backed and auto-params-adjustable within those bounds, so read
`autoParams.completionFeeBps` rather than assuming 25. Completion fees and the treasury half
of any slash accrue to the treasury, which starts with 5B CMN from genesis and is spent
through OpenGov Track 1 proposals.

Slashes split between burn and treasury. A slashed agent may appeal within
`agents.slashAppealWindow` (raw `10`).

### Message fees (spec 309)

From spec 309, each on-chain coordination message (`messages.send`) burns a protocol fee on
top of its transaction fee:

```text
message_fee = 0.02 CMN + 0.0001 CMN × payload_len      (at most 0.2248 CMN at 2 KiB)
```

The fee is **burned, not paid to the treasury**. Messages earn nothing and feed no emission
weight, so the fee is purely a spam price, and routing it anywhere would make message volume
someone's revenue. It is withdrawn from free balance with `WithdrawReasons::FEE`, which the
agent stake lock forbids, so it can never be paid out of stake. Like every other burn it can
only lower total issuance. See [Messages pallet](./messages#fee) for the constants and the
fee table.

## Constitutional floors

`pallet-constitution` holds minimums that other parameters may not undercut, as a
second line of defence against a governance change that guts a gaming guard:

<!-- chain-check:constants -->

| Constant | Value | Raw |
|---|---|---|
| `constitution.minUnstakeCooldown` | 100,800 blocks = 7 days | `100800` |
| `constitution.minChallengeWindow` | 600 blocks = 1 hour | `600` |
| `constitution.minRegistrationBurn` | 10 CMN | `10000000000000` |
| `agents.unstakeCooldown` — the value being floored | 100,800 blocks = 7 days | `100800` |
| `oracle.minChallengeWindow` — the value being floored | 600 blocks = 1 hour | `600` |
| `agents.baseRegistrationFee` — the value being floored | 50 CMN | `50000000000000` |

The lower half of that table is the point: each configured value is compared against its
constitutional floor, so the gate fails if a parameter change drops one below its minimum.
`agents.unstakeCooldown` sits *exactly* at the floor, so exit takes 7 days from
`agents.requestUnstake` to `agents.completeUnstake` — and an agent with active agreements
cannot start the clock at all. The registration burn has more headroom, at 50 CMN against a
10 CMN floor.

## Provenance

Every raw value on this page is read from a live node and mechanically re-checked.

| Field | Value |
|---|---|
| Chain | Scalar Commons Local Testnet |
| Runtime | `scalar-commons` spec 306 |
| Metadata | v15 |
| Token | CMN, 12 decimals, SS58 42 |
| Validators | 5 |

The mechanism, in order:

1. `npm run snapshot:chain` connects to a node (default `ws://127.0.0.1:9944`), reads
   metadata, and writes `docs/.chain/snapshot.json` — pallet indices, every pallet
   constant, the extrinsic and storage surface, runtime API signatures, and the RPC method
   list, with a provenance block recording endpoint, block height, genesis hash and node
   version.
2. `npm run lint` runs `scripts/check-chain-values.mjs`, which fails if any documented raw
   value disagrees with the snapshot, if a pallet index is wrong, if a custom pallet's
   extrinsic is undocumented, or if a `ScalarCommonsApi` method is missing from the RPC
   reference.

Only runtime-*defined* facts are snapshotted. Volatile state — issuance, era number,
balances — is deliberately excluded: documenting it would guarantee it goes stale. Where
this page cites live state (the validator count above), read it as an observation of the
reference devnet, not an invariant.

::: tip Re-verify against your own node

```bash
cd docs
npm run snapshot:chain -- ws://your-node:9944
npm run lint
```

A failure here is a real finding: either the docs are stale or the runtime changed
without the docs following.
:::

### Known discrepancy in older records

`docs/VERIFIED-CONSTANTS.md` records `InitialAlpha = 4,000`. The live runtime sets
**1,500** (`runtime/src/lib.rs`, `AutoInitialAlpha`), confirmed against both
`autoParams.initialAlpha` and the live `autoParams.alpha()` storage value at spec 305. That
document was authored against an earlier commit and has not been re-verified since; this
page's value is the current one. Its formula transcription and its findings list remain
accurate and are worth reading alongside this page.
