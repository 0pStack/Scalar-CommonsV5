# ROUND 13 — Governance-farming and diversity-ordering vectors: source confirmation and fix design

**Date:** 2026-08-03 · **Scope:** diagnosis + design only. **No runtime or pallet code was written or changed.** · **Repo:** `master` @ `1cce9ff` · `spec_version: 303`

Companion: `ROUND12.md` (which raised both vectors). Magnitude harness: `experiments/sc-e1/scratchpad/round13_magnitude.py`.

---

## VERDICT UP FRONT

| ROUND12 claim | ROUND13 verdict |
|---|---|
| One held conviction vote satisfies `is_actively_voting` **indefinitely** | **CONFIRMED** — votes leave `VotingFor` only via an explicit `remove_vote()`; poll completion never prunes them |
| No distinctness / recency / uniqueness check on the credit | **CONFIRMED** — the verifier returns a single `bool` and is consulted identically on every call |
| `record_gov_vote` callable up to `MaxProposalsPerEra` **every era, forever** | **CONFIRMED** — cap is per-era; `EraGovParticipation` is cleared each era in `drain_era_maps` |
| Worth **+4,000 bps** = 40% of the activity budget | **CONFIRMED** exactly |
| ~**4×** effect on a minimal-work agent | **CONFIRMED** — 4.33× at `MinQualifyingVol`; 3.67× for ROUND12's washer profile |
| `MaxVolToStakeRatio` diversity credit is order-dependent | **CONFIRMED** — accumulate-then-credit, quoted below |

**ROUND12 was conservative in three ways.** The vector is cheaper, more regressive, and less tested than reported:

1. **Capital cost is exactly zero, not "a conviction lock".** `try_vote` enforces no minimum vote balance.
2. **The benefit is regressive in real work** — worth 2.60× more to a minimal-work agent than to an honest high-volume one.
3. **The guard has zero behavioural test coverage.** All six test mocks wire `GovVoteVerifier = ()`, which returns `true` unconditionally, and no test anywhere calls `record_gov_vote`.

**One correction to ROUND12's framing:** the V4 "gov cannot substitute for work" gate *does* work as designed. What fails is that the bar for "work" is ~10 CMN. See §2.4.

---

## 1. Vector A — governance farming: source trace

### 1.1 The credit path — `pallets/emissions/src/lib.rs:598-616`

```rust
598            let gov_votes = agents_pallet::EraGovParticipation::<T>::get(who) as u128;
599            let gov_score = gov_votes.min(max_props).saturating_mul(SCORE_SCALE) / max_props;
600
601            // GOV SCORE GATING (V4 fix: was always additive).
602            // Gov participation amplifies work-based weight but cannot substitute for it.
603            // An agent with zero work_score earns zero from governance votes this era.
604            // This closes the gov farming attack: spamming record_gov_vote without doing
605            // any actual work no longer inflates weight by 4x.
606            // Legitimate governance participants who also do work still get full benefit.
607            let gov_contribution = if work_score > 0 {
608                alpha.saturating_mul(gov_score) / SCORE_SCALE
609            } else {
610                0
611            };
612
613            let activity = (effective_floor
614                .saturating_add(gov_contribution)
615                .saturating_add(beta.saturating_mul(work_score) / SCORE_SCALE))
616            .min(BPS_SCALE);
```

`gov_score` is derived **entirely** from `EraGovParticipation[who]` — a counter written by an extrinsic the agent calls on itself. Nothing here references a referendum.

### 1.2 The verifier — `runtime/src/lib.rs:1017-1035`

```rust
1017 /// Verifies an agent holds at least one active (non-empty) vote in any OpenGov
1018 /// referendum class. An agent that has never voted, or whose votes are all
1019 /// empty, fails the check. This prevents record_gov_vote() from being called
1020 /// without genuine participation.
...
1028 pub struct ConvictionVotingBridge;
1029 impl pallet_agents::pallet::GovVoteVerifier<AccountId> for ConvictionVotingBridge {
1030     fn is_actively_voting(who: &AccountId) -> bool {
1031         use pallet_conviction_voting::{Voting, VotingFor};
1032         VotingFor::<Runtime>::iter_prefix(who)
1033             .any(|(_, voting)| matches!(&voting, Voting::Casting(c) if !c.votes.is_empty()))
1034     }
1035 }
```

The word "active" in the doc comment means **non-empty**, not **live**. `c.votes` is a `BoundedVec<(PollIndex, AccountVote), MaxVotes>` (`conviction-voting/src/vote.rs:206-211`). The check is `!is_empty()` — it never inspects a `PollIndex` and never asks whether that poll is still ongoing.

### 1.3 Why "indefinitely" holds — upstream `pallet-conviction-voting`

Entries are added by `try_vote` and removed **only** by `try_remove_vote` (`conviction-voting/src/lib.rs:472-486`):

```rust
472 	fn try_remove_vote(
...
482 			if let Voting::Casting(Casting { ref mut votes, delegations, ref mut prior }) = voting {
483 				let i = votes
484 					.binary_search_by_key(&poll_index, |i| i.0)
485 					.map_err(|_| Error::<T, I>::NotVoter)?;
486 				let v = votes.remove(i);
```

reachable only from the `remove_vote` extrinsic (`:374-380`), which the **voter** must call. `unlock` (`:331-341`) touches locks, not `votes`.

**And no hook can prune them.** The runtime wires `type VotingHooks = ()` (`runtime/src/lib.rs:574`), whose upstream impl is a complete no-op (`conviction-voting/src/traits.rs:105-121`). More decisively, the `VotingHooks` trait exposes only `on_before_vote`, `on_remove_vote`, and `lock_balance_on_unsuccessful_vote` — **there is no on-poll-completion hook in the trait at all**, so no implementation could prune a concluded vote even if one were wired. There is no sweep and no reaper.

> **Confirmed:** a vote cast once on an ongoing poll remains in `VotingFor` after that poll concludes, forever, unless the attacker chooses to remove it. `is_actively_voting` therefore returns `true` forever.

### 1.4 The cost floor is zero — `conviction-voting/src/lib.rs:418-425`

```rust
418 	fn try_vote(
419 		who: &T::AccountId,
420 		poll_index: PollIndexOf<T, I>,
421 		vote: AccountVote<BalanceOf<T, I>>,
422 	) -> DispatchResult {
423 		ensure!(
424 			vote.balance() <= T::Currency::total_balance(who),
425 			Error::<T, I>::InsufficientFunds
426 		);
```

The **only** balance constraint is an upper bound. There is no minimum vote balance and no minimum conviction. A vote of ~0 balance at `Conviction::None` satisfies the verifier and locks nothing. **ROUND12 assumed a conviction lock cost; there is none.**

*Precondition ROUND12 did not state:* `try_vote` requires `poll_status.ensure_ongoing()` (`:431`), so the attacker needs **one** ongoing referendum to exist at the moment of casting — a one-time, trivially satisfiable requirement.

### 1.5 The extrinsic and its per-era cap — `pallets/agents/src/lib.rs:898-931`

```rust
898         #[pallet::call_index(5)]
...
901         pub fn record_gov_vote(origin: OriginFor<T>, agent: T::AccountId) -> DispatchResult {
902             let signer = ensure_signed(origin)?;
903             ensure!(signer == agent, Error::<T>::Unauthorized);
904             ensure!(
905                 AgentStake::<T>::contains_key(&agent),
906                 Error::<T>::NotRegistered
907             );
...
913             ensure!(
914                 T::GovVoteVerifier::is_actively_voting(&agent),
915                 Error::<T>::NotActivelyVoting
916             );
917             // V4: F-05 — cap at MaxProposalsPerEra to prevent gov_score farming by block producers
918             ensure!(
919                 EraGovParticipation::<T>::get(&agent) < T::MaxProposalsPerEra::get(),
920                 Error::<T>::GovVoteCapReached
921             );
922             let total = EraGovParticipation::<T>::mutate(&agent, |v| {
923                 *v = v.saturating_add(1);
924                 *v
925             });
```

The extrinsic takes **no referendum identifier**. There is no set of already-credited polls, so the same (unchanged, possibly long-concluded) vote satisfies the guard on call 1 and on call 20 identically. `EraGovParticipation` is cleared every era (`drain_era_maps`, `pallets/agents/src/lib.rs:1355`), so the 20-call budget refreshes each era in perpetuity.

Both `MaxProposalsPerEra` wirings resolve to the same constant — `runtime/src/lib.rs:1129` (agents) and `:1221` (emissions) both use `EmissionsMaxProposalsPerEra = 20` (`:1194`). **No mismatch there**; that guard is correctly wired.

### 1.6 Plain answer to the question asked

**Does ONE held conviction vote satisfy the verifier indefinitely, and can `record_gov_vote` be called up to the cap every era with no distinctness / recency / unlock / uniqueness check?**

**Yes, confirmed on all four counts.**

| Check | Present? | Where it would have to live |
|---|---|---|
| Distinctness (credit tied to a specific referendum) | **No** | `record_gov_vote` takes no poll index |
| Recency / liveness (poll still ongoing) | **No** | `is_actively_voting` never reads poll status |
| Unlock / vote-still-current | **No** | votes persist until voluntary `remove_vote` |
| Uniqueness (N votes → N credits) | **No** | verifier returns `bool`, consumed up to 20× |

---

## 2. Magnitude

Reproduced arithmetically from `emissions/src/lib.rs:598-616` (`round13_magnitude.py`):

```
gov_score        = min(votes,20) * 10000 / 20 = 10,000
gov_contribution = alpha(4,000) * gov_score / 10000 = 4,000 bps
as a fraction of BPS_SCALE (10,000) = 40%
marginal bps per record_gov_vote call = 200 bps
```

**Confirmed: +4,000 bps, exactly 40% of the activity budget.** Since `activity` enters `base_weight` linearly (`:618-627`), the activity ratio **is** the weight ratio exactly.

| Agent profile | activity, no gov | activity, gov=20 | **weight multiplier** |
|---|---|---|---|
| minimal work @ `MinQualifyingVol` (50 CMN), 1 buyer | 1,200 | 5,200 | **4.33×** |
| ROUND12 washer: vol 10,000, 1 buyer | 1,500 | 5,500 | **3.67×** |
| wash ring: vol 10,000, 5 buyers | 6,000 | 10,000 \* | 1.67× |
| honest low-vol: 100, 5 buyers | 3,500 | 7,500 | 2.14× |
| honest mid-vol: 1,000, 5 buyers | 5,000 | 9,000 | 1.80× |
| honest high-vol: 5,000, 5 buyers | 6,000 | 10,000 \* | 1.67× |

\* clamped at `BPS_SCALE`; gov credit is what pushes these to the ceiling.

**ROUND12's "~4×" is confirmed** (4.33× for the minimal-work profile).

### 2.4 The finding ROUND12 missed — the subsidy is regressive in work

The multiplier is **2.60× more valuable to a minimal-work agent than to an honest high-volume one** (4.33× vs 1.67×). High-work agents are already near the `BPS_SCALE` clamp, so they capture less of the 4,000 bps; low-work agents capture all of it. The governance term systematically favours exactly the profile a wash/sybil operator presents.

**And a correction to ROUND12's framing:** the V4 gate at `:607` (`if work_score > 0`) **does work as designed** — a zero-work agent gets zero governance credit, and the comment's claim at `:604-605` is accurate on its own terms. The defect is not that the gate is missing; it is that **`work_score > 0` costs ~10 CMN** (one `EscrowMinAmount` escrow, since `log2_scaled` returns 0 below `UnitVolume`). The gate stops free-riders with *no* work; it does not stop free-riders with *token* work.

### 2.5 Why it shipped — zero behavioural test coverage

```
pallets/agents/src/lib.rs:176-180
    impl<AccountId> GovVoteVerifier<AccountId> for () {
        fn is_actively_voting(_: &AccountId) -> bool { true }
    }
```

All six mocks wire `type GovVoteVerifier = ()` — `tests/common.rs:150`, `pallets/{agents,emissions,escrow,oracle,orchestrator}/src/tests.rs`. And a repo-wide search finds **no test that calls `record_gov_vote` at all**. The only verifier implementation ever exercised in CI is the one that unconditionally returns `true`. `ConvictionVotingBridge` has never been executed by a test.

---

## 3. Vector B — `MaxVolToStakeRatio` order dependence: source trace

`pallets/agents/src/lib.rs:1253-1281`:

```rust
1253            // Accumulate era volume (single storage read via mutate)
1254            let era_total = EraEscrowVolume::<T>::mutate(agent, |v| {
1255                *v = v.saturating_add(amount);
1256                *v
1257            });
1258
1259            // Buyer diversity via bloom filter
1260            let buyer_bytes = buyer.encode();
1261            let hash = sp_io::hashing::blake2_256(&buyer_bytes);
1262            let slot = u32::from_le_bytes([hash[0], hash[1], hash[2], hash[3]]) % 65_536;
1263            if !EraSeenBuyerSlots::<T>::get(agent, slot) {
1264                EraSeenBuyerSlots::<T>::insert(agent, slot, true);
1265                // Stake-weighted diversity cap: diversity credit stops above stake × ratio
1266                let ratio = T::MaxVolToStakeRatio::get() as u128;
1267                let diversity_ok = ratio == 0 || {
...
1276                    era_vol_u128 <= stake_u128.saturating_mul(ratio)
1277                };
1278                if diversity_ok {
1279                    EraUniqueBuyers::<T>::mutate(agent, |c| *c = c.saturating_add(1));
1280                }
1281            }
```

**Confirmed: accumulate-then-credit.** `era_total` is incremented at `:1254-1257` *before* the ratio test at `:1276` reads it. Two distinct consequences, in opposite directions:

- **B1 — attacker-favouring (ROUND12's finding).** Front-load *k* minimum escrows (10 CMN, `EscrowMinAmount`) from *k* distinct buyers while `era_total` is tiny; all *k* clear `:1276` and bank credit. Every subsequent escrow reuses an already-seen slot, short-circuits at `:1263`, and never re-tests the ratio. Full `diversity_bps = 10,000` for ~50 CMN, after which volume is unbounded. **The cap is defeated.**
- **B2 — honest-harming (not previously reported).** `EraSeenBuyerSlots::insert` at `:1264` happens **before** `diversity_ok` is evaluated at `:1267`. A genuine buyer whose first escrow lands when the agent is already over the ratio has its slot **permanently marked seen for that era with no credit granted**, and can never earn credit later in the era. An honest high-volume agent silently loses diversity for late-arriving legitimate counterparties.

The ordering bug is therefore **asymmetric**: it rewards the attacker who front-loads and penalises the honest agent whose counterparties arrive late.

*Adjacent observation, not verified this round:* `drain_era_maps` clears `EraSeenBuyerSlots` with a bound of `bound * 128` (`:1352`). With many agents × many buyers this bound may under-cover, leaving stale slots into the next era and silently suppressing diversity credit. Worth its own check; it is not part of this round's claims.

---

## 4. Fix design — Vector A (governance farming)

The defect decomposes into three independent failures. Any fix should be graded against all three.

| # | Failure | Consequence |
|---|---|---|
| A1 | **Liveness** — concluded polls count | vote once, satisfied forever |
| A2 | **Cardinality** — `bool` verifier consumed 20× | 1 real vote → 20 credits |
| A3 | **Self-attestation** — credit is claimed, not derived | no credit is bound to any referendum |

### Options

| # | Design | A1 | A2 | A3 | Storage / migration | Weight | Honest impact |
|---|---|:--:|:--:|:--:|---|---|---|
| **1** | **Derive at settle:** replace the verifier with `active_vote_count(who) -> u32` counting votes on *ongoing* polls; delete `record_gov_vote` + `EraGovParticipation` | ✅ | ✅ | ✅ | Removes a storage map → migration + `spec_version` | ❌ **Bad.** `MaxVotes = 512` × 3 tracks = up to 1,536 entries read **per agent** inside `settle_era`, which already loops every agent | Best UX — no extrinsic to remember |
| **2** | **Stopgap:** make `is_actively_voting` require a vote on an *ongoing* poll | ✅ | ❌ | ❌ | **None** — runtime-only | Negligible | None |
| **3** | **Bind credit to a distinct live referendum:** `record_gov_vote(agent, poll_index)`; verify a vote on that *ongoing* poll; dedup per era | ✅ | ✅ | ✅ | **Additive** storage only → migration + `spec_version` | +1 read/write per call; `settle_era` untouched | Must pass the poll index they just voted on |
| **4** | Scale credit by conviction locked | ✅ | ~ | ❌ | New per-agent state | Moderate | Converts governance into a stake-weighted term |
| **5** | Reduce `alpha` from 4,000 | ❌ | ❌ | ❌ | **None** — already an auto-param | None | Reduces payoff for everyone |

**Option 1 is disqualified on weight.** `settle_era` is permissionless by design (first principle #3) and must stay cheap enough that anyone can afford to call it; loading it with up to 1,536 storage reads per agent is a liveness risk, not a fix.

**Option 4 is disqualified on thesis.** Weighting governance by conviction-locked balance re-introduces a stake surface into a term that is supposed to measure participation, colliding with first principle #2 — and `√stake` is already the weight base.

**Option 5 is not a fix.** It is an economic dial that reduces the prize without closing the vector; it belongs to §6, not here.

### Recommendation: **Option 3**, with Option 2 as an immediate stopgap if there is schedule pressure

Option 3 closes all three failures, keeps `settle_era` untouched, and the migration is unusually cheap because the affected state is ephemeral.

**Shape (design only — not implemented):**
- `record_gov_vote(origin, agent, poll_index: u32)`.
- Verifier trait becomes `fn has_live_vote_on(who: &AccountId, poll_index: u32) -> bool`, implemented over `VotingFor` **and** `pallet_referenda::ReferendumInfoFor` / `Polls::as_ongoing` (the runtime already wires `type Polls = Referenda`, `runtime/src/lib.rs:570`).
- Add `EraGovVotedPolls: StorageDoubleMap<AccountId, u32, bool, ValueQuery>` for per-era dedup; **keep `EraGovParticipation` unchanged** as the count.
- Clear the new map in `drain_era_maps` alongside the others.

**Migration impact:**
- New storage item ⟹ **`spec_version` bump (303 → 304) + migration entry**, per CLAUDE.md. But `EraGovParticipation` and the new map are both **cleared every era**, so the migration is effectively a no-op on ephemeral state — no per-agent data to translate. This is the lightest storage change of any option that actually closes the vector.
- **Extrinsic signature change** ⟹ call encoding changes. Per CLAUDE.md's indexer rule, the 24 indexer endpoints and the JS tests must be checked in the same PR; `GovVoteRecorded` gains a poll index if the event is extended.
- **Verifier trait signature change** ⟹ all six test mocks must be updated (`tests/common.rs` + five `pallets/*/src/tests.rs`), per CLAUDE.md's "every new Config type must be added to every test mock".
- **Test debt must be paid in the same PR:** `ConvictionVotingBridge` currently has zero coverage. The mocks' `()` impl returning `true` must be replaced with a configurable mock so the guard is actually exercised.

**Effect on honest governance participants — this is the part that needs a decision.** Today an honest voter and a lazy attacker are indistinguishable: both cast one vote and claim 20 credits. After the fix, credit equals *the number of distinct live referenda you actually voted on this era*, capped at 20. If the chain rarely has 20 concurrent referenda — with only 3 tracks (`runtime/src/governance/tracks.rs:39`), it very likely does not — then **honest participants' gov_score falls sharply too**, because the denominator `max_props = 20` will rarely be reached.

That is not a defect of the fix; it is the fix revealing that `MaxProposalsPerEra = 20` was calibrated against a counter that could be trivially maxed. **The denominator must be re-tuned alongside** — see §6.

---

## 5. Fix design — Vector B (diversity ordering)

| # | Design | Fixes B1 (attacker) | Fixes B2 (honest) | Storage / migration |
|---|---|:--:|:--:|---|
| **1** | Evaluate the ratio against the **pre-escrow** total (`era_total − amount`), and move `EraSeenBuyerSlots::insert` **inside** the `diversity_ok` branch | ❌ | ✅ | **None** — reorder only |
| **2** | Re-test the ratio on **every** escrow, not only first-touch (drop the `!seen` short-circuit for the ratio check) | ~ partial | ✅ | None |
| **3** | Credit a buyer only once that buyer's **share** of the agent's era volume clears a floor | ✅ | ✅ | **New per-(agent,buyer) volume map** — heavy |
| **4** | Recompute diversity at drain time from a per-era (agent → buyer → volume) map | ✅ | ✅ | Same heavy storage + `settle_era` cost |

**Recommendation, split by nature of the defect:**

- **Ship Option 1 now as a bug fix.** Moving the `insert` inside the `diversity_ok` branch and testing the pre-escrow total is a pure reordering with no storage-layout change, no migration, and no economic reinterpretation. It removes the honest-agent harm (B2) outright. It **does not** close front-loading (B1) — say so plainly rather than claiming the cap is fixed.
- **B1 cannot be closed without redefining diversity.** Options 3/4 require tracking per-buyer volume and deciding *what diversity should measure*: distinct `AccountId`s (today, trivially sybilable) versus economic distinctness. That is precisely the open question ROUND12 §6 raised, and it is not an engineering call.

---

## 6. Code bug vs. human decision

| Item | Classification | Rationale |
|---|---|---|
| A1 — verifier accepts concluded polls | **CODE BUG** | `runtime/src/lib.rs:1017-1020` documents "prevents `record_gov_vote()` from being called without genuine participation". The implementation does not achieve its own stated intent. Fixable in the runtime; no economics involved |
| A2 — one vote yields 20 credits | **CODE BUG** | `pallets/agents/src/lib.rs:909-911` states the guard exists to stop "any agent can call `record_gov_vote()` 20×/era and claim full gov_score". It was written for exactly this attack and fails to prevent it |
| A3 — credit is self-attested | **CODE BUG** (same fix) | Structural cause of A2 |
| Zero test coverage of `ConvictionVotingBridge` | **CODE/PROCESS BUG** | Six mocks stub the guard to `true`; no test calls the extrinsic |
| B2 — slot burned before credit test | **CODE BUG** | Unambiguously unintended: penalises honest late-arriving buyers |
| B1 — front-loading defeats the ratio cap | **HUMAN DECISION (Keith)** | Closing it requires defining diversity as *economic* rather than *AccountId* distinctness, plus new per-buyer storage |
| `MaxProposalsPerEra = 20` as the gov denominator | **HUMAN DECISION (Keith)** | Once A2 is fixed, 20 becomes unreachable in practice with 3 tracks. Leaving it collapses honest gov_score; lowering it is an economic re-calibration |
| `alpha = 4,000` (40% of the activity budget) | **HUMAN DECISION (Keith)** | Already an auto-param — changeable with no migration. §2.4 shows the term is regressive in work, which bears on whether 40% is the right size |
| Whether governance should contribute to emissions weight at all | **HUMAN DECISION (Keith)** | First principle #2 lists governance participation in the thesis; §2.4 shows the current implementation subsidises low-work agents most |

### What needs Keith, stated as decisions

1. **`MaxProposalsPerEra`** — after the A2 fix, what denominator makes an honest participant's gov_score meaningful given realistic referendum throughput on 3 tracks? (Candidate: make it an auto-param tracking live referendum count.)
2. **`alpha`** — is 40% of the activity budget the intended weight for governance, given it is worth 2.60× more to a minimal-work agent than an honest high-volume one?
3. **Diversity semantics** — should `diversity_score_bps` count distinct `AccountId`s or economically distinct counterparties? This gates B1, and it is the same decision ROUND12 identified as the real anti-wash surface.

---

## 7. Confidence and limits

**High confidence — read directly from source this round, quoted above:** the gating path, the verifier implementation, vote persistence in upstream `pallet-conviction-voting`, the absence of any pruning hook (`VotingHooks = ()`, and no on-completion hook exists in the trait), the absence of a minimum vote balance, the extrinsic and its per-era cap, the matching `MaxProposalsPerEra` wirings, the +4,000 bps magnitude, the accumulate-then-credit ordering, and the absence of test coverage.

**Not verified this round:**
1. **Nothing was executed.** No runtime built, no extrinsic dispatched, no test written — this round is a source read plus arithmetic, per the no-code rule. The vector is confirmed *by construction*, not by exploit. A single integration test would settle it definitively and should accompany the fix.
2. **Referendum throughput is an assumption.** My claim that 20 concurrent referenda is unrealistic rests on the 3-track configuration, not on measured governance activity. If throughput is higher, the honest-impact concern in §4 shrinks.
3. **`EraSeenBuyerSlots` clear-bound sufficiency** (§3) is flagged, not analysed.
4. **Weight figures for Option 1** are derived from `MaxVotes = ConstU32<512>` and 3 tracks as an upper bound, not benchmarked.
**Where I could be wrong in the direction that matters:** the vector rests on a chain of four source facts — votes persist, no hook prunes them, the verifier ignores poll status, and the `bool` is consumed 20×. Each is quoted above and I consider A1/A2 settled. The residual risk is not in the diagnosis but in the **fix sizing**: if realistic referendum throughput is much higher than 3 tracks suggests, Option 3's honest-participant impact (§4) is overstated and the `MaxProposalsPerEra` re-tune in §6 may be unnecessary. That is the assumption most worth a second reader's attention — and unlike the diagnosis, it cannot be settled from source, only from governance data once the chain is live.
