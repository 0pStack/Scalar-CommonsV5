# UPGRADE-306.md — the economic gate

**Date:** 2026-09-10
**Issues:** [#164] (a two-account tester captured 82 % of an era's emission), [#161] (`register` never initialises `LastHeartbeat`)
**Decisions applied:** D7 (emission ≤ α × qualifying escrow volume), D8 (register starts the heartbeat clock), D9 (use any zero-emission lever that exists today)

> **Status in one line:** emission was stopped on the live chain at **block #542152** with the
> lever that already existed, spec 306 replaced that stopgap with a rule at **block #543472**,
> and the gate is re-declared passed only by re-measuring it on chain — not by the code
> merging.

| | |
|---|---|
| Pause block (D9, spec 305) | **#542152** — eras 5..14 overridden to zero |
| Upgrade block (spec 306) | **#543472** — all five validators, none restarted |
| PR | [#168](https://github.com/tejaspatil1936/scalar-commons-v4/pull/168), squash-merged as `5f5e3c9` |
| Live re-test | **PASS** — 60 CMN of escrow, **0 CMN** minted (#164 took 90 068.37 CMN for the same 60 CMN) |

---

## §1 — Discovery, and the pause

### 1.1 The exact current formula (spec 305)

`pallets/emissions/src/lib.rs`, `settle_era`. Two independent halves, and only one of them
was ever about work.

**The size of the pot:**

```text
pool = EmissionOverrides.take(era)                       # if root set one
     | clamp(TargetEmissionPerAgent × AgentStake::count(),
             low  = FloorEmissionPerEra,                 # 100 000 CMN
             high = InitialEmissionsPerEra)              # 1 000 000 CMN
```

**The split of the pot**, per agent, `compute_weight_cached`:

```text
weight = integer_sqrt(stake)
       × rank_bps / 10 000                               # 10 000 / 12 000 / 15 000 by rank
       × activity / 10 000
       × heartbeat_multiplier / 100                      # 100 down to 10
       × (1 + oracle_score × OracleBonusBps / 10 000²)   # inert: OracleScoreProvider = ()
       × (1 + onboarding_boost_bps / 10 000)             # +100 % → 0 over first 10 completions
       × (1 + min(1, era_vol/stake) × VelocityBonusBps / 10 000)   # up to +30 %

activity = min(10 000,
               effective_floor                           # FloorBps if the agent qualifies, else 0
             + alpha × gov_score / 10 000                # zero unless work_score > 0
             + beta  × work_score / 10 000)

work_score = log2_scaled(era_vol, UnitVolume) × diversity_score_bps(unique_buyers) / 10 000
```

Payment is a MasterChef accumulator: `AccRewardPerStake += pool × 2^64 / total_weight`, and
`claim` pays `(acc − debt) × weight_snapshot / 2^64`, capped at `SupplyCap − TotalIssuance`.

### 1.2 Where agent count enters

`let agent_count = agents_pallet::AgentStake::<T>::count() as u128;` —
`pallets/emissions/src/lib.rs`. It enters **once**, and it is the only input to the size of
the pot. It is a count of *registrations*, not of active agents, not of qualifying agents,
and not of anything anybody did. Registration costs 1 050 CMN once; the count it increments
is permanent until unstake.

Nothing else in the formula reads it. So an era mints the same amount whether the chain
settled a million CMN of escrow or nothing at all, and #164's arithmetic follows directly:
11 registered agents → `10 000 × 11 = 110 000 CMN`, against ~120 CMN of gross escrow chain-wide
that era. **~917 CMN minted per CMN of work.** The split then concentrated 81.88 % of it on
one agent, because `MinQualifyingVol` and the `hb >= 90` gate had disqualified nearly
everyone else — the gates concentrate rather than dilute.

### 1.3 What the ring-farming flag did to payouts

**Nothing. Confirmed by reading every consumer of the signal.**

`pallets/agents/src/lib.rs`, `drain_era_maps` computes:

```rust
let is_established = completions > 1;
if is_established && EraUniqueBuyers::<T>::get(&agent) <= 1 {
    ring_snap = ring_snap.saturating_add(1);
}
```

`ring_snap` goes to `EraRingSnapshot`, which is read in exactly one place —
`pallet-auto-params::rule_ring_farming` — where a ring ratio over 30 % raises
`CompletionFeeBps` by `max_step` (**25 bps**, capped at 2 500).

This is not a reading of the source alone. It is happening on the live chain right now:

```text
agents.eraRingSnapshot      = 1
agents.eraActiveSnapshot    = 1      -> ring ratio 100 %, threshold 30 %
autoParams.completionFeeBps = 75     (genesis 25 -> 50 at era 2 -> 75 at era 4)
```

Issue #166 recorded the first step of that climb. **Every era since #164's ring appeared the
detector has correctly flagged it, and the only thing the chain has done about it is raise
an escrow fee by a quarter of a basis point.** The ring kept being paid.

So the entire consequence of being detected as a ring was that the *escrow completion fee*
rose by a quarter of a basis point per era, chain-wide, for everyone. It did not reduce the
ring's weight, its volume credit, its claim, or the size of the pot. #164's ring **was**
detectable — the issue notes `eraUniqueBuyers` was 1 — and it was paid in full.

Two further gaps in the flag itself:

- It is computed **after** the weight loop, in `drain_era_maps`, so it could not have
  affected the settlement it was computed during even if something consumed it.
- The `is_established` clause means a ring's **first** era is never flagged at all.

### 1.4 Does a zero-emission lever exist today? — **Yes, one, and it is bounded**

| Candidate | Root-callable today? | Can it zero emission? |
|---|---|---|
| `emissions.setEraEmissionOverride(era, 0)` | yes, `ensure_root` | **Yes** — `settle_era` does `EmissionOverrides::take(era)`, and `Some(0)` is an override of zero, not an absence. |
| `autoParams.setParam(Alpha/Beta/FloorBps, …)` | yes | **No.** These are weight terms, not pot size, and their bounds floor at `Alpha` 1 000 / `Beta` 1 000 / `FloorBps` 100 — none reaches zero, and none touches the pot. |
| `txPause.pause(("Emissions","settleEra"))` or `("Emissions","claim")` | yes — `PauseOrigin = EnsureRoot`, `WhitelistedCalls = ()` | Yes, but **refused**. See below. |
| A dedicated pause | — | Does not exist. Not invented here. |

**`txPause` was available and was deliberately not used.** CLAUDE.md first principle #3:
*no economically essential function (era settlement, reward claims) may depend on a
privileged caller.* Pausing `settleEra` or `claim` makes both depend on one. Zeroing the pot
achieves the same end while settlement stays permissionless and claims stay open — there is
simply nothing to concentrate.

**The one limit of the lever, stated rather than worked around.** The guard is
`target_era > current_era && target_era <= current_era + MaxEmissionOverrideEras`, and
`settle_era` reads `EraNumber` — which *is* `current_era`. **So the era that settles next
cannot be overridden.** Writing `EmissionOverrides` directly through `system.setStorage`
would have covered it; that bypasses a check rather than satisfying one, and the round's
rule is not to weaken a check to pass.

### 1.5 D9 executed — **pause block #542152**

`scripts/emissions-zero-override.mjs`, new in this round, built on the fee-preflight pattern
`apply-upgrade.mjs` earned the hard way in UPGRADE-305 (`sudo.sudo` dispatches `paysFee: No`,
but `ChargeTransactionPayment` runs in `validate_transaction` **before** dispatch, so an
unfunded root key cannot get the extrinsic into the pool at all).

```text
chain               : Scalar Commons Local Testnet
spec_version        : 305
head block          : #542151
agents.EraNumber    : 4
EraStartBlock       : #538914  EraDuration 3600  next settlement due at #542514
MaxEmissionOverride : 10 eras

NOT REACHABLE       : era 4 — settle_era reads EraNumber, and the runtime guard is
                      target_era > current_era. Era 4 mints its pot at #542514.
overriding eras     : 5..14 to 0.0000 CMN

signer              : 5DFASjqmCBrMfRsHDzQyXGodfWL4Bj1uK6X2U3jBEEoPh8ZN
on-chain Sudo::Key  : 5DFASjqmCBrMfRsHDzQyXGodfWL4Bj1uK6X2U3jBEEoPh8ZN
signer is root      : YES

call                : sudo.sudo(utility.batchAll(10 x emissions.setEraEmissionOverride))
inner call hash     : 0x8e6f3312c70ddabb3a4d6011b7f8b96cc7280f2b9fb8c94650fbb28dd6fb607c
outer call hash     : 0xf772e326728c5b04a974d49d041689cd0bd010810d8a2e344a81bf6adca1f941

signer free balance : 10000.0000 CMN
estimated fee       : 0.0001 CMN
required (fee + ED) : 0.0101 CMN
can pay             : YES
```

Submitted; `utility.BatchCompleted`, `sudo.Sudid` with no `Err`, then read back from storage
rather than trusted:

```text
finalized in        : 0x85df915465151ca3811a4c5624383c8441f9892f37d57c11e4c543a763c3a2a1
PAUSE BLOCK         : #542152

EmissionOverrides[5..14] = 0    (all ten read back as 0)

OK — eras 5..14 will mint 0.0000 CMN.
Era 4 is NOT covered and mints at #542514.
Overrides are consumed on read: re-run before era 14 settles.
```

**What this does not cover, said plainly:** era 4 settles at **#542514** and mints its
agent-count pot — 110 000 CMN at 11 registered agents — because the existing lever's guard
cannot reach the era that is settling. Ten eras of cover is 60 hours, which is the window
spec 306 has to land in. The override is consumed on read, so it is a stopgap with an expiry,
not a fix. **The fix is §2.**

[#161]: https://github.com/tejaspatil1936/scalar-commons-v4/issues/161
[#164]: https://github.com/tejaspatil1936/scalar-commons-v4/issues/164

---

## §2 — What changed in spec 306

**PR [#168](https://github.com/tejaspatil1936/scalar-commons-v4/pull/168)**, three commits.

### D7 — an era may mint at most `α × qualifying escrow volume`

`pallets/emissions/src/lib.rs`, `settle_era`. The agent-count pot is now a **ceiling, not an
amount**:

```text
base  = EmissionOverrides.take(era) | clamp(TargetEmissionPerAgent × agent_count, floor, ceiling)
pool  = min(base, EmissionVolumeAlphaBps / 10_000 × qualifying_era_volume)
```

α is `autoParams.emissionVolumeAlphaBps`, launch value **10 000 bps = 1.0x**, stored on chain,
settable by sudo or Track 2 governance inside bounds `0..100 000` with no runtime upgrade.
Qualifying volume is accumulated in the pass that already walks `AgentStake`, so the rule
costs no extra iteration.

The bound is applied to the **root override path too**. The temptation was to let root out of
it; but an invariant root can step around is not an invariant, and the lever for a deliberate
subsidy already exists and is the honest one — governance raises α, on chain, where it is
visible, rather than quietly minting past the measurement.

### Qualifying volume ≠ gross volume

`pallets/agents/src/lib.rs`, `qualifying_volume_of`. Four exclusions:

| Exclusion | Test |
|---|---|
| Ring-flagged provider | `CompletedAgreements > 1` **and** `EraUniqueBuyers ≤ 1` — the detector that already existed |
| Payer↔worker cycle | a reciprocal `EraPairVolume` edge in the same era |
| Declared funding lineage | `agents.linkFundingLineage(a, b)` has merged them |
| Beyond the provider's own stake | anything above `stake × maxVolToStakeRatio` |

The ring flag is **the existing detector, made load-bearing**. Until spec 306 the entire
consequence of being flagged was that `CompletionFeeBps` rose by 25 bps chain-wide. #164's
ring *was* flagged and was paid in full.

The `established` clause (`completions > 1`) is deliberately kept rather than tightened.
Dropping it would zero every genuinely new agent's first era — the honest-onboarding case,
not the attack — and a first-era ring is already bounded by α itself: its volume qualifies at
most 1:1, so it can never mint more than the escrow it settled.

### D8 — registration starts the heartbeat clock

`agents::register` now writes `LastHeartbeat`. The pallet-agents v2 migration backfills every
agent that has no entry, capped at 10 000 per pass, and **never moves a real timestamp
forward** — an agent that has heartbeated keeps its own.

### On funding lineage, and what the pallets can actually see

`pallet_balances` in polkadot-stable2503 exposes no transfer hook — its `Config` carries only
`DustRemoval` and `AccountStore` — and `frame_system`'s `OnNewAccount` carries the new account
but never its funder. **A pallet cannot see that two addresses came out of the same faucet
drip** without forking pallet-balances or adding a `TransactionExtension`, which changes the
extrinsic format and every wallet with it. Neither belongs in a fix for #164.

So the rule is split along the line of what is observable:

- **payer↔worker cycles within the era** — observable from escrow flow, detected
  automatically, no storage;
- **shared funding lineage** — not observable, therefore **declared** by root via
  `agents.linkFundingLineage`, with `unlinkFundingLineage` as its inverse because an
  assertion about off-chain facts can be wrong and one mistyped address should not be
  permanent.

### Storage, migrations, versions

| Pallet | Version | Added | Migration |
|---|---|---|---|
| `pallet-agents` | 1 → 2 | `EraPairVolume` (era-scoped `(provider, buyer) → (era, volume)`), `LineageParent` | backfills `LastHeartbeat` |
| `pallet-auto-params` | 1 → 2 | `EmissionVolumeAlphaBps`, `EmissionVolumeAlphaBounds` | seeds α and its bounds |
| `pallet-emissions` | unchanged | — | none; reads the two new agents maps |

`spec_version` **305 → 306**. `transaction_version` **unchanged** — `link_funding_lineage` and
`unlink_funding_lineage` are appended at call indices 11 and 12 and
`ParamId::EmissionVolumeAlphaBps` at discriminant 5, so no existing call encoding moves.

The auto-params migration is **load-bearing, not cosmetic**: `EmissionVolumeAlphaBps` is
`ValueQuery`, so an unseeded chain would read α = 0 and bound every era's emission at
`0 × volume` — forever.

### The review caught a critical defect before merge

CLAUDE.md requires a `tokenomics-security-reviewer` pass for economic changes. It found that
**the α lever was wired to nothing.**

`AutoParamsImpl` in `runtime/src/lib.rs` implements five `AutoParamsProvider` methods and did
not implement the sixth, so it silently inherited a trait default I had added *"so the mocks
keep compiling"*. `EmissionVolumeAlphaBps`, its genesis seeding, its migration, its bounds and
`set_param(EmissionVolumeAlphaBps, ..)` were all live and all dead. Governance could have set
α to 0, watched `ParamSetByGovernance` fire, read the new value back out of storage — and
`settle_era` would have gone on using 1.0. **The documented emergency stop would have reported
success and done nothing**, and every unit test passed while the path was disconnected,
because the integration mock omitted the same method in the same way.

The method is now **required with no default**, so a missing impl is a compile error — which
is exactly what the default was suppressing — and `tests/emission_volume_cap.rs` drives α
through `set_param` and asserts on what `settle_era` actually minted.

Five further findings fixed in the same commit:

| | Finding | Why it mattered |
|---|---|---|
| HIGH | `EraPairVolume` residue could re-qualify forever | `drain_era_maps` clears with a limit sized off `AgentStake::count()`, but buyers need not be providers, so nothing tied the map's cardinality to the agent count. Unstamped residue reads as fresh volume every era: monotonic, self-compounding inflation with no escrow behind it. Values are now `(era, volume)` and stale stamps are inert on sight. |
| HIGH | the bound was on **flow**, and flow recycles | A provider and a cooperating buyer could settle escrow, transfer the funds back where no pallet can see them, and settle again — the only cost being the 25 bps completion fee. Qualifying volume is now capped per provider at `stake × maxVolToStakeRatio`, pricing it in locked, slashable capital. It does **not** close it; see §4. |
| MEDIUM | `settle_era` could mint past its own bound | A dormant agent kept its last non-zero `AgentWeightSnapshot` while being absent from `total_weight`, so the accumulator advanced as if it were not there and `do_claim` paid it anyway. The D7 invariant held at the accumulator and broke at the mint site. Zero weight now clears the snapshot, as `on_slashed` and `on_stake_changed` already do. |
| MEDIUM | `lineage_root` truncation failed **open** | Under D7, "these two are unlinked" is the pay-more answer. It now returns `Option` and an undecidable walk reports them as linked. |
| MEDIUM | two unbounded loops | `settle_era` is permissionless, so an unbounded walk over attacker-funded pairs is a liveness attack on settlement itself; `MaxAgents` is 10 000 000, so an unbounded backfill does not produce an honest weight, it produces an unexecutable block. Both capped, both overshooting toward paying less. |
| LOW | two `try_into` fallbacks pointed at "mint more" | The cap fell back to the **uncapped** emission and the event reported the supply cap as qualifying volume. Both unreachable today; both now fall back to zero. |

Guards the review verified intact and this round did not touch: orchestrator self-link,
`GovVoteVerifier` wiring, `MinQualifyingVol`, `VelocityBonusBps`, and `settle_era`'s
`ensure_signed` / `EraNotDue` / `EraStartBlock` / F-04 quartet.

### RED before, GREEN after

Pallet sources reverted to master, tests kept:

```text
issue_164_two_account_ring_cannot_mint_more_than_its_own_escrow ... FAILED
  two accounts recycling 60 CMN of their own escrow minted 99999 CMN
  — 1666x the work they can point at (#164)

honest_agents_with_real_counterparties_earn_proportionally ... FAILED
  an era must mint alpha x qualifying volume, alpha = 1.0
  left: 100000000000  right: 500000000

freshly_registered_agent_is_not_penalised_against_one_that_heartbeats ... FAILED
  registering starts the heartbeat clock       left: 64   right: 100

register_initialises_last_heartbeat_to_the_current_block ... FAILED
  left: 0  right: 534527
```

The `64` is #161's own measurement reproduced exactly. The #164 reproduction runs against a
mock carrying the **live runtime's** emissions constants — `UnitVolume` 10 CMN,
`MinQualifyingVol` 50 CMN, the auto-params genesis α/β/floor, an 18-hour heartbeat grace — so
its numbers are the chain's numbers rather than round test numbers.

| gate | result |
|---|---|
| `cargo test --workspace` | **152 passed, 0 failed** (113 on master) |
| `cargo fmt --all -- --check` | clean |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| indexer `npm test` | 107 passed |
| landing `npm test` | 12/12 |
| docs `npm run lint` | 0 errors |
| gitleaks | no leaks found |

One existing test changed setup, flagged rather than buried:
`emission_override_replaces_formula_for_targeted_era` did no era work, so under D7 there was
no volume for the override to be measured against. Its assertions are unchanged; it now
supplies the qualifying volume the emission is a payment for, and the capped case is covered
separately by `emission_override_is_still_bounded_by_qualifying_volume`.

### Migration verification, and why it is not try-runtime

`try-runtime-cli` is not installed on this host and the node carries no `try-runtime`
feature, so the equivalent check is five unit tests that reconstruct the pre-306 storage
shape — version 1, `LastHeartbeat` keys absent, `EmissionVolumeAlphaBps` reading its
`ValueQuery` default of 0 — and assert the outcome, idempotence on a re-run, and the two
things a migration must never do: move a real heartbeat forward, or undo a governance choice.
The stronger check is in §3: the post-migration state read back off the live chain.

---

## §3 — Apply log

### Build, from merged master

```text
5f5e3c9 runtime: spec 306 — bound era emission by qualifying escrow volume (#164), start
        the heartbeat clock at register (#161) (#168)

Finished `release` profile [optimized] target(s) in 5m 45s

file       : target/release/wbuild/scalar-commons-runtime/scalar_commons_runtime.compact.compressed.wasm
bytes      : 1 163 692
blake2-256 : 0xd5a37c1b5ded9369e821c63ae1683ed5a2cecfe76a78b49a529505d2a6880005
```

Embedded version gate — read from the blob's `runtime_version` custom section, not from
`lib.rs`, so a stale target directory cannot pass:

```text
spec_name       : scalar-commons
spec_version    : 306
OK — embedded spec_version is 306.
```

The blob built from the squash-merged master is **byte-identical** to the one built from the
branch before merging — same blake2-256. Worth recording: it means the merge moved no code,
and that this build is reproducible rather than incidental.

### Rollback point — `~/upgrade-backup/20260910T110628Z/`

| artefact | detail |
|---|---|
| `code-before.wasm` | live on-chain `:code`, 1 153 409 bytes, **verified spec 305** |
| | blake2-256 `0xdc0855f41037a8dbc681d4c26e34ff854b8f0509a166ade5fce4b5542025e058` |
| `finalized-head.json` | head **#543408** |
| `scalar-local-raw.json` | committed chainspec |
| `services-before.txt` | the five validators' `NRestarts` / `ActiveEnterTimestamp`, plus a finality sample |
| `scalar_commons_runtime.compact.compressed.wasm` | the blob submitted |

The saved `code-before.wasm` hashes to **exactly the blob UPGRADE-305 applied**. That is a
clean chain of custody: the chain was provably running the artefact from the previous
upgrade, not something that merely claimed to be.

No database snapshot. `deploy/upgrade.md` explains why it is not the rollback path for a
runtime upgrade, and `deploy/snapshot.sh` stops and starts the node it snapshots — which
would have reset an uptime that verification (b) depends on.

### Preflight and apply

The fee preflight passed on the first attempt, which is the whole point of it existing —
UPGRADE-305's first attempt died at this step after a six-minute build:

```text
signer              : 5DFASjqmCBrMfRsHDzQyXGodfWL4Bj1uK6X2U3jBEEoPh8ZN
on-chain Sudo::Key  : 5DFASjqmCBrMfRsHDzQyXGodfWL4Bj1uK6X2U3jBEEoPh8ZN
signer is root      : YES
signer free balance : 10000.0000 CMN
estimated fee       : 0.0001 CMN
required (fee + ED) : 0.0101 CMN
can pay             : YES
```

```text
call                : sudo.sudo(system.setCode(<wasm>))
inner call hash     : 0xeb2993cd667d7c78a19873e330f959fd8a8a0d0958a18e2c6a4d2aa6892516b4
outer call hash     : 0x66f276e114c15ba2dd1347347495c051a34467b35b10f28ddbf93c23adc46570

events              : balances.Withdraw, system.CodeUpdated, sudo.Sudid, balances.Deposit,
                      transactionPayment.TransactionFeePaid, system.ExtrinsicSuccess
finalized in        : 0x8b6938cbfe56130f4377534dde030581eba2abaaf9cdffef6cfc0925b70378d4
APPLIED AT BLOCK    : #543472
```

### Verification

**(a) specVersion 306 on all five ports** ✅ — all five inside a single polling pass, far
under the 20-block budget.

```text
port 9944: specVersion 306      port 9947: specVersion 306
port 9945: specVersion 306      port 9948: specVersion 306
port 9946: specVersion 306
```

**(b) Nothing restarted** ✅ — byte-identical to the snapshot taken before submitting.

```text
alice    NRestarts=0  Wed 2026-09-09 12:59:49 CEST
bob      NRestarts=0  Wed 2026-09-09 12:58:07 CEST
charlie  NRestarts=0  Wed 2026-09-09 12:58:33 CEST
dave     NRestarts=0  Wed 2026-09-09 12:58:58 CEST
eve      NRestarts=0  Wed 2026-09-09 12:59:23 CEST
```

**(c) Producing and finalizing, two samples nine seconds apart** ✅ — all five, in lockstep,
both heights advancing.

```text
[11:13:01Z]  alice best=543476 final=543474   bob best=543476 final=543474   charlie best=543476 final=543474   dave best=543476 final=543474   eve best=543476 final=543474
[11:13:10Z]  alice best=543477 final=543475   bob best=543477 final=543475   charlie best=543477 final=543475   dave best=543477 final=543475   eve best=543477 final=543475
```

**(d) `:code` is the blob that was submitted, and is not genesis** ✅

```text
head    :code hash  0xd5a37c1b5ded9369e821c63ae1683ed5a2cecfe76a78b49a529505d2a6880005
genesis :code hash  0x1a978681b5c7bba350dcb8bb292fdeefba94dc4cc5fb9cd88972e3f64a3da1f8
```

The head hash equals the blake2-256 of the file that came out of `cargo build --release` on
`5f5e3c9`, so the code now running is provably that artefact.

### The migrations, read back off the chain

This is the check that `try-runtime` would have approximated. It is the real state:

```text
autoParams.emissionVolumeAlphaBps    : 10000        (1.0x — an era mints at most the work it measured)
autoParams.emissionVolumeAlphaBounds : {"min":0,"max":100000,"maxStep":1000}
Agents      storage version          : 2
AutoParams  storage version          : 2
Emissions   storage version          : 1            (unchanged — it added no storage)

registered agents                    : 13
agents still at LastHeartbeat = 0    : 0
```

Per-agent, the two rows that matter are the ones #161 was written about:

| agent | lastHeartbeat | lifetime completions |
|---|---|---|
| `5FHneW46…M694ty` | **543472** (the upgrade block) | **172** |
| `5FLSigC9…XcS59Y` | **543472** (the upgrade block) | **58** |

Both were established, productive agents sitting below the `hb >= 90` activity gate purely
because nothing had ever written the key — #161 measured one of them at 171 completions. The
migration backfilled exactly those, and left every agent that *had* heartbeated on its own
timestamp.

### Dependent services survived the metadata change

```text
scalar-indexer     active  NRestarts=0
scalar-explorer    active  NRestarts=0
scalar-faucet      active  NRestarts=0
scalar-keeper      timer healthy, ran at 13:20:45 post-upgrade and read the new metadata

indexer /v1/status : spec 306, synced 543480, 24 endpoints
```

The indexer picked up the new metadata by itself and stayed in sync through the switch, as
it did at 305.

**One defect found here, filed as [#169]:** `https://faucet.scalarnet.io/health` still
advertises `"specVersion":305`. It reads `api.runtimeVersion` **once at connect** and caches
it, so a forkless upgrade under a long-lived connection leaves the number stale until the
process restarts. Display-only — signing and submission use the live api and the faucet kept
working throughout — but it is a public surface stating something untrue about the chain,
the same class of problem as #165, and it will recur on every upgrade until it is read live.

[#169]: https://github.com/tejaspatil1936/scalar-commons-v4/issues/169

---

## §4 — The live re-test

**Verdict: PASS. 60 CMN of escrow, 0 CMN minted.** #164's arithmetic was 60 CMN of escrow
and 90 068.37 CMN claimed.

### The scenario, reproduced move for move

Three fresh accounts, funded only by the public faucet at `https://faucet.scalarnet.io`, and
the walk from `docs/guide/testnet-tester-guide.md` §4:

| | |
|---|---|
| A (provider) | `5EezSTqZ…ouiAa` — one drip, registered with 1 000 CMN |
| B (buyer) | `5Fhj8P5g…fBU44` — one drip, registered with 1 000 CMN |
| C | `5HWJQswK…tABA` — one drip, exists only to top B up |

C exists because of **#162**: one drip is 1 100 CMN, registration costs 1 050.01, and the
49.99 CMN left is a hundredth of a CMN short of a single 50 CMN job. Its top-up is a plain
`balances.transfer`, which is also a live demonstration of **#167** — no pallet can see it.

Then the two jobs from the issue, B → A and nobody else:

```text
escrow 10.000000 CMN B -> A settled (seq 0)
escrow 50.000000 CMN B -> A settled (seq 1)
A eraEscrowVolume 60.000000 CMN, eraUniqueBuyers 1, completions 2
```

`eraUniqueBuyers 1, completions 2` is precisely the ring shape: established, single
counterparty.

To make the measurement mean anything, era 6's emergency zero was first replaced with
**exactly what the un-overridden formula would have paid** — `10 000 CMN × 13 agents =
130 000 CMN`, inside the floor/ceiling clamp:

```text
node scripts/emissions-zero-override.mjs --era 6 --schedule-for 6
  registered agents   : 13
  clamped [floor,ceil]: 130000.0000 CMN
  EmissionOverrides[6] = 130000000000000000
```

**A re-test that passes because emission was switched off proves nothing**, and that trap was
of my own making — I had zeroed eras 5..14 in §1.

### The settlement

`settle_era` submitted by account A, an ordinary signed account, because it is permissionless
and this is what any agent can do:

```text
event emissions.EmissionCappedByVolume {"era":"6","uncapped":"130,000,000,000,000,000",
                                        "qualifyingVolume":"0","alphaBps":"10,000"}
event emissions.NextEraScheduled       {"block":"553,567","scheduled":false}
event emissions.EraSettled             {"era":"6","totalEmission":"0","totalWeight":"6,953,468"}
```

```text
claim A -> emissions.NothingToClaim     A weightSnapshot 6953468   balance delta -0.000108 CMN
claim B -> emissions.NothingToClaim     B weightSnapshot 0         balance delta -0.000108 CMN
```

| | #164 on spec 305 | this re-test on spec 306 |
|---|---|---|
| escrow volume settled | 60 CMN | **60 CMN** |
| era emission | 110 000 CMN | **0 CMN** |
| claimed by the two accounts | **90 068.37 CMN** | **0 CMN** (−0.000216 CMN in fees) |
| share of the era captured | 81.88 % | **0 %** |

### The number that settles it

`totalWeight` at settlement was **6 953 468**. #164 reports its agent's weight as
**6 953 468**. The same to the unit.

Nothing about the weight formula changed, and that is the point: the attacker still has
exactly the weight they had, and the split still works exactly as before. What changed is
that **the pot is now sized by qualifying volume, and a ring's volume qualifies for nothing**.
The fix is not a nerf applied to one account; it is the pot no longer being a free-standing
number.

### The other half — does it still admit honest work?

Era 6 blocked a ring, but it did so with qualifying volume of zero **chain-wide**, and on its
own that reading is equally consistent with "the rule zeroes everything". So the same
provider was given a second distinct buyer in era 7, and the rule's inputs read back out of
live storage:

```text
  era                        : 7
  eraEscrowVolume            : 20.000000 CMN
  eraUniqueBuyers            : 2
  completedAgreements        : 4
  ring-flagged?              : false
  stake ceiling              : 10000.000000 CMN
  eraPairVolume (provider -> buyer):
    C  5HWJQswK…  era 7  10.000000 CMN  reciprocal=false  qualifies=true
    B  5Fhj8P5g…  era 7  10.000000 CMN  reciprocal=false  qualifies=true
  => qualifying volume for A : 20.000000 CMN
```

**The same agent that qualified for nothing with one buyer qualifies for its full 20 CMN with
two.** The rule discriminates; it has not bricked emission.

**What this control does NOT show, stated plainly:** era 7 still carries a zero override, so
it will mint zero regardless, and no *observed mint* against non-zero qualifying volume has
happened on this chain. The step from qualifying volume to minted amount is covered by
`tests/emission_volume_cap.rs`, which asserts `LastEraEmission` equals the qualifying volume
exactly and tracks α in both directions, and by era 6's `EmissionCappedByVolume` event showing
the path executing on chain. A full live positive control — one era handed back to the
schedule with honest multi-buyer work in it — is the obvious next measurement and has not
been done.

### D8 confirmed live, three times

`register` now writes `LastHeartbeat`, observed before any `heartbeat()` call:

```text
A lastHeartbeat immediately after register = 543503
B lastHeartbeat immediately after register = 543506
C lastHeartbeat immediately after register = 549992
```

The tester guide records this field as `0` on spec 305 and tells readers to heartbeat
immediately or earn nothing. That warning is now obsolete.

---

## Where this leaves the gate

**#161 — closed.** `register` starts the clock, the migration cleared the stranded
population, and zero agents remain at `LastHeartbeat = 0`.

**#164 — the specific vector is closed and measured.** The exact scenario from the issue now
pays nothing, and it does so through a stated rule rather than a parameter tweak.

**The gate is not "open".** Three things are true at once and all three belong in the record:

1. The chain currently mints **zero**, because the only escrow happening on it is a ring, and
   eras 7..14 still carry the emergency zero override. That is the rule working, not a
   failure — but nobody should read "0 CMN minted" as "emissions are healthy".
2. **#167** is open and is `tier:T0`: the bound is on flow, and flow can be recycled. Spec
   306 prices that in locked, slashable stake instead of a 25 bps fee, which is a change in
   kind from #164's two free faucet drips — but it is not the invariant "an era cannot mint
   more than the work it measured", and neither the code nor the docs claim it is.
3. The overrides expire. `EmissionOverrides` is consumed on read and reaches only ten eras
   ahead, so eras 7..14 are covered and **era 15 is not**. Before then, someone has to decide
   whether emission resumes on the α rule alone — which is the decision this round was meant
   to make possible, not the decision it makes.
