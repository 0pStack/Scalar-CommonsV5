# ROUND 14 — Governance-farming and diversity-ordering: fixes, tests, and what moved

**Date:** 2026-08-03 · **Branch:** `fix/gov-and-diversity` · **Base:** `master` @ `6fd2169` · **spec_version:** 303 → 304
**Predecessors:** `ROUND12.md` (raised both vectors) · `ROUND13.md` (confirmed both from source, designed the fixes)
**Sim harness:** `experiments/sc-e1/scratchpad/round14_sim.py` (anchors on ROUND12 §3.3 before running)

---

## VERDICT UP FRONT

| Task | Status |
|---|---|
| 1. Gov fix — ROUND13 §4 Option 3 (credit bound to a distinct live referendum) | **Shipped** |
| 2. Behavioural coverage of the guard, all six mocks de-stubbed | **Shipped** — 9 new tests, 8 fail against the old behaviour |
| 3. Diversity fix — ROUND13 §5 Option 1 (reorder); B1 left open by design | **Shipped** |
| 4. Alpha 4,000 → 1,500 bps at its source of truth | **Shipped** — no migration, it is an auto-param |
| 5. Denominator quantification (not changed) | **Quantified** — see §5 |
| 6. spec_version 303 → 304, no data migration | **Shipped** |
| 7. Re-run the sim, confirm no honest cohort newly harmed | **Run — and I cannot confirm it.** See §7.3 |

**The one thing to read if you read nothing else.** The fixes do what they were asked to do: the
governance vector is closed and provably so. But the sim says the *economics* of closing it are not
neutral. Governance credit was a flat additive term, so it was worth proportionally more to
low-activity agents — and in a fixed-pool proportional game, shrinking it moves share **away from
low-volume honest agents** (−12% net/era) and **toward** high-volume agents *and toward the 5-sybil
wash ring* (+9%). The ring gains because it is a high-work-score profile whose diversity is faked;
it barely used the governance term, so it is untouched by both changes and simply collects the
share everyone else drops. **Neither this round's gov fix nor the alpha cut is an anti-wash
measure. B1 is the anti-wash measure, and B1 is still open.** Numbers in §7.

---

## 1. Fix A — governance credit is bound to a distinct LIVE referendum

Implements ROUND13 §4 **Option 3**.

### 1.1 What changed

| Where | Change |
|---|---|
| `pallets/agents/src/lib.rs:189-191` | Trait `GovVoteVerifier::is_actively_voting(who) -> bool` becomes `has_live_vote_on(who, poll_index: u32) -> bool` |
| `pallets/agents/src/lib.rs:176-180` (deleted) | The blanket `impl GovVoteVerifier for ()` — which returned `true` unconditionally — is **removed** |
| `pallets/agents/src/lib.rs:499` | New `EraGovVotedPolls: StorageDoubleMap<AccountId, u32, bool, ValueQuery>` — per-era dedup set |
| `pallets/agents/src/lib.rs:720` | New error `PollAlreadyCredited` |
| `pallets/agents/src/lib.rs:957` | `record_gov_vote(origin, agent, poll_index: u32)`; weight `reads_writes(2,1)` → `(3,2)` |
| `pallets/agents/src/lib.rs:1446` | `drain_era_maps` clears `EraGovVotedPolls` beside the other era maps |
| `runtime/src/lib.rs:1061-1077` | `ConvictionVotingBridge` now checks `Polls::as_ongoing(poll_index).is_some()` **and** that the agent's `Casting` votes contain `poll_index` |
| Event | `GovVoteRecorded` gains a `poll_index` field |

`EraGovParticipation` is unchanged and keeps its meaning as the count fed to `gov_score`. What
changed is what it counts: **distinct live referenda actually voted on this era**, capped at
`MaxProposalsPerEra`.

Guard order in the extrinsic is `Unauthorized` → `NotRegistered` → `PollAlreadyCredited` →
`NotActivelyVoting` → `GovVoteCapReached`. Dedup runs before the verifier because it is a single
cheap read that settles the commonest rejection.

### 1.2 The runtime bridge, and one deliberate exclusion

```rust
// runtime/src/lib.rs:1062-1076
fn has_live_vote_on(who: &AccountId, poll_index: u32) -> bool {
    type Polls = <Runtime as pallet_conviction_voting::Config>::Polls;
    if Polls::as_ongoing(poll_index).is_none() { return false; }
    VotingFor::<Runtime>::iter_prefix(who).any(|(_, voting)| match &voting {
        Voting::Casting(c) => c.votes.iter().any(|(idx, _)| *idx == poll_index),
        Voting::Delegating(_) => false,
    })
}
```

`type Polls = Referenda` was already wired (`runtime/src/lib.rs:570`), so `as_ongoing` reads
`pallet_referenda::ReferendumInfoFor` and returns `None` for approved / rejected / cancelled /
timed-out / killed referenda. That is what makes a stale vote stop paying.

**`Voting::Delegating` is deliberately not credited.** A delegation is not a per-referendum act and
carries no poll index to bind credit to; counting it would restore the exact "one action, unlimited
credits" shape this fix exists to close. This is a policy choice, not an oversight — flagging it
because it means a delegating voter earns no `gov_score` at all.

### 1.3 Tests that pin it

`pallets/agents/src/tests.rs` (unit) and `tests/gov_credit.rs` (integration, weight-level).

| Test | Pins | Fails pre-fix? |
|---|---|---|
| `gov_credit_on_live_referendum_works` | happy path, dedup entry written | ✅ (map absent) |
| `gov_credit_on_concluded_referendum_earns_nothing` | **A1 liveness** — vote still held, poll concluded | ✅ old code returns `Ok` |
| `gov_credit_on_removed_vote_earns_nothing` | vote withdrawn on a live poll | ❌ guard-rail — old code also rejected this |
| `gov_credit_requires_a_vote_on_that_specific_poll` | **A3 binding** — voted on 1, claims 2 | ✅ old code returns `Ok` |
| `one_live_vote_credits_exactly_once_per_era` | **A2 cardinality** — 20 calls, 1 vote | ✅ old code banked 20 |
| `distinct_live_referenda_each_credit_once_up_to_cap` | N distinct → N credits; second sweep pays nothing; cap holds | ✅ old code reached 6 on the second sweep |
| `gov_dedup_map_clears_each_era` | a long-running referendum pays again next era | ✅ (map absent) |
| `farmed_vote_loses_to_genuine_participation_in_emission_weight` | end-to-end: 1 farmed credit < 3 genuine, in `AgentWeightSnapshot` | ✅ |
| `a_held_vote_stops_paying_once_its_referendum_concludes` | end-to-end: stale voter ties an identical non-voter on weight | ✅ |

**Evidence that they fail without the fix.** The call signature changed, so "check out the old code"
is not available. Instead the old *semantics* were restored in place — the dedup guard removed from
`record_gov_vote`, and the mock verifier reverted to the old question ("does this account hold any
vote, anywhere?") — and the suite re-run:

```
test tests::distinct_live_referenda_each_credit_once_up_to_cap ... FAILED
test tests::gov_credit_on_concluded_referendum_earns_nothing ... FAILED
test tests::gov_credit_on_live_referendum_works ... FAILED
test tests::gov_dedup_map_clears_each_era ... FAILED
test tests::gov_credit_requires_a_vote_on_that_specific_poll ... FAILED
test tests::gov_credit_on_removed_vote_earns_nothing ... ok
test tests::one_live_vote_credits_exactly_once_per_era ... FAILED
test result: FAILED. 31 passed; 6 failed

test gov_credit::farmed_vote_loses_to_genuine_participation_in_emission_weight ... FAILED
  panicked: the same referendum must not pay twice in one era
test gov_credit::a_held_vote_stops_paying_once_its_referendum_concludes ... FAILED
  panicked: a concluded referendum must not pay again
```

Being precise about what that proves: three of those six unit failures are the vector itself
(concluded poll pays; wrong poll pays; same poll pays 20×). Two —
`gov_credit_on_live_referendum_works` and `gov_dedup_map_clears_each_era` — fail only because the
shim does not write the new map, so they are coverage, not exploit demonstrations. Both integration
failures are the vector.

### 1.4 The six mocks

`GovVoteVerifier = ()` is gone from all six (`tests/common.rs:150`,
`pallets/{agents,emissions,escrow,oracle,orchestrator}/src/tests.rs`). Each now carries a
`MockGovVoteVerifier` over two **separate** thread-local sets — held votes and ongoing polls —
because upstream keeps them separate and that gap is the vector: `conclude_poll()` ends the poll and
deliberately leaves the vote in place, exactly as `pallet-conviction-voting` does. `cast_live_vote`
/ `conclude_poll` / `reset_gov_state` helpers are present in all six; the four crates that do not
exercise the guard start empty, so they deny by default rather than passing by default.

---

## 2. Fix B — diversity credit is order-independent for honest buyers

Implements ROUND13 §5 **Option 1**. `pallets/agents/src/lib.rs:1320-1370`.

Two changes: the ratio is tested against the **pre-escrow** era total, and
`EraSeenBuyerSlots::insert` moved **inside** the `diversity_ok` branch — the slot now records
"already credited", not "seen".

| Test | Pins | Fails pre-fix? |
|---|---|---|
| `diversity_credits_buyer_whose_escrow_crosses_the_ratio_cap` | the boundary buyer is judged on volume *before* its own deal | ✅ `left: 1, right: 2` |
| `diversity_slot_not_burned_when_credit_is_denied` | a denied buyer can still earn credit later in the era once the agent raises stake | ✅ `left: 1, right: 2` |
| `diversity_still_denied_to_a_buyer_arriving_above_the_cap` | the cap still binds | ❌ guard-rail — passes both ways, by design |

Both regression tests are written so the *first* buyer is credited identically before and after,
which keeps each failure pinned to its own target assertion rather than to an incidental earlier one.

**Extra honest-harm found while writing these tests, not in ROUND13.** Under the old ordering, an
agent whose *first* escrow of the era already exceeded `stake × MaxVolToStakeRatio` got **no
diversity credit for its very first buyer** and burned that slot — the post-escrow total was over cap
before any buyer had been counted. The first draft of both tests failed on that assertion, which is
how it surfaced. B2 was slightly worse than reported.

**B1 remains open, by design.** Front-loading *k* minimum-size escrows from *k* sybil buyers while
volume is low still banks full diversity credit, after which volume is unbounded. This reordering
does not touch it and the code comment says so. See §8.

---

## 3. Governance weight right-sized: 4,000 → 1,500 bps

**Source of truth: `runtime/src/lib.rs:1301`, `pub const AutoInitialAlpha: u32 = 1_500;`** (was
`4_000`), consumed at `:1317` as `pallet_auto_params::Config::InitialAlpha`.

**No migration is needed, and here is exactly why.** `InitialAlpha` is read once, in auto-params'
`genesis_build` (`pallets/auto-params/src/lib.rs:188`), which writes the `Alpha` storage value. From
then on alpha is a live auto-param: governance moves it with `set_param(ParamId::Alpha, ..)`
(`:498`) and the era rules move it within `AlphaBounds` (`:447-470`). There is no storage-layout
change and no value to translate — for a chain that has already launched, the constant is inert and
alpha must be moved by governance instead. 1,500 sits inside the genesis `AlphaBounds` floor of
1,000 (`:201-205`), so the era rules retain full room to adjust it in both directions.

`tests/common.rs:288` mirrors the constant deliberately — the integration mock exists to model the
shipped chain. All 19 integration tests pass unchanged at 1,500.

The value is surfaced to clients through the existing `scalar_api` runtime API
(`runtime/src/scalar_api.rs:111`), whose shape is unchanged; only the reported number moves.

---

## 4. spec_version 303 → 304

`runtime/src/lib.rs:135-150`, with the rationale in-comment. It is required: `EraGovVotedPolls` is a
new storage map, `record_gov_vote`'s signature changes the call enum, and `GovVoteRecorded` gains a
field.

**No data migration, on two independent grounds.** First and sufficient: this runtime has never
launched on any network, so there is no live state to move. Second — and the reason Option 3 was the
cheapest fix that actually closes the vector — **every map it touches is ephemeral**.
`EraGovVotedPolls` starts empty, and both it and `EraGovParticipation` are cleared wholesale by
`drain_era_maps` each era. Even on a live chain there would be no per-agent data to translate; the
worst case is one era's governance counters resetting. The alpha change needs no migration either
(§3). The bump lands in the first commit of the series, matching the convention set at 302 → 303.

The new map's clear bound is `bound × MaxProposalsPerEra`, which is exact: `record_gov_vote` refuses
to add an entry once `EraGovParticipation` reaches the cap, so an agent can hold at most that many
keys. (The pre-existing `EraSeenBuyerSlots` bound of `bound × 128` is *not* exact — ROUND13 §3
flagged it as possibly under-covering. Untouched this round; still worth its own check.)

---

## 5. Denominator check — quantified, not changed

`gov_score = min(votes, D) × SCORE_SCALE / D` with `D = MaxProposalsPerEra = 20`. Now that credit is
honest, `votes` is bounded by **R = the number of concurrently live referenda**, not by the caller's
patience. With 3 tracks configured, R is small.

| live referenda R | `gov_score` | `gov_contribution` @ α=4,000 | @ α=1,500 (shipped) |
|---:|---:|---:|---:|
| 1 | 500 | 200 bps | **75 bps** |
| 2 | 1,000 | 400 bps | **150 bps** |
| 3 | 1,500 | 600 bps | **225 bps** |
| 4 | 2,000 | 800 bps | **300 bps** |
| 5 | 2,500 | 1,000 bps | **375 bps** |
| 20 (ceiling) | 10,000 | 4,000 bps | 1,500 bps |

The activity budget is `BPS_SCALE = 10,000`. **At R = 3, a fully participating honest agent now earns
225 bps — 2.25% of the activity budget, against 40% before.** ROUND13 §4's concern is confirmed: the
denominator was calibrated against a counter that could be trivially maxed, and at D = 20 the
governance term is close to decorative at realistic throughput.

Sensitivity, holding α = 1,500 and R = 3 (`round14_sim.py` PART 6):

| D | `gov_score` | `gov_contrib` | honest v100 net/1k | honest v5000 net/1k | ring 5cp net/1k |
|---:|---:|---:|---:|---:|---:|
| 20 (today) | 1,500 | 225 bps | 676.6 | 1,293.4 | 964.9 |
| 10 | 3,000 | 450 bps | 687.5 | 1,284.2 | 958.1 |
| 5 | 6,000 | 900 bps | 706.8 | 1,268.0 | 945.9 |
| 3 | 10,000 | 1,500 bps | 728.4 | 1,249.9 | 932.3 |
| ≤ R | 10,000 | 1,500 bps | 728.4 | 1,249.9 | 932.3 |

Lowering D helps the low-volume honest cohort and hurts the ring, monotonically — but it saturates
at D ≤ R, and even at saturation the low-volume cohort reaches 728.4 against 770.1 before. **The
denominator is a stronger lever than alpha (§7.4), and it is not sufficient on its own.** Not
changed this round, per instruction.

---

## 6. Gates

All four run on the final branch (locally; `cargo 1.85.0`, 16 cores):

```
=== FMT ===     cargo fmt --all -- --check          → 0 issues
=== CLIPPY ===  cargo clippy --workspace --all-targets -- -D warnings → exit 0
=== TEST ===    cargo test --workspace              → 109 passed, 0 failed
=== RELEASE === cargo build --release               → exit 0
```

109 total, up from 97 at `6fd2169` — exactly 12 `#[test]` functions added and none removed
(`git diff 6fd2169..HEAD -- pallets tests | grep -c '^+#\[test\]'` → 12): +10 unit (7 gov,
3 diversity) in `pallet-agents` (27 → 37) and +2 integration (17 → 19).

---

## 7. Re-run of the ROUND12 sim — before and after

`experiments/sc-e1/scratchpad/round14_sim.py`. The weight function is re-derived from
`pallets/emissions/src/lib.rs` with α and the governance rule as parameters.

### 7.1 Anchor first

The harness `raise SystemExit`s unless it reproduces ROUND12 §3.3 exactly at α = 4,000, gov = 20:

| ROUND12 §3.3 | weight | net/era | per 1k capital | reproduced |
|---|---:|---:|---:|:--:|
| honest worker, vol 100, 5 real buyers | 90.27 | +7,701 | 770.1 | ✅ |
| honest worker, vol 5,000, 5 real buyers | 138.00 | +11,836 | 1,183.6 | ✅ |
| washer, 1 sybil cp, no gov | 23.40 | +2,006 | 182.3 | ✅ |
| washer, 1 sybil cp, farms gov | 85.80 | +7,286 | 662.3 | ✅ |
| washer, 5 sybil cps, farms gov | 156.00 | +13,259 | 883.9 | ✅ |

*(My first transcription of `log2_scaled` and `diversity_score_bps` was wrong and the anchor caught
it — it was written from memory rather than from source. Corrected against
`pallets/emissions/src/lib.rs:672-695`. This is the anchor doing its job and is worth recording.)*

### 7.2 BEFORE → AFTER, α 4,000 → 1,500 and gov credit = R = 3 live referenda

The emission pool is fixed at 1e6/era for n ≥ 100, so this is a **share** game: absolute rewards move
only through relative weight. Both washer and honest agents are limited to R credits after the fix —
it is symmetric, not a targeted penalty.

| strategy | weight → | net/era → | **per 1k capital** → | Δ |
|---|---|---|---|---:|
| honest, vol 100, 5 buyers | 90.27 → 44.83 | +7,701 → +6,766 | **770.1 → 676.6** | **−93.5** |
| honest, vol 1,000, 5 buyers | 111.24 → 64.58 | +9,525 → +9,745 | **952.5 → 974.5** | +22.0 |
| honest, vol 5,000, 5 buyers | 138.00 → 85.91 | +11,836 → +12,934 | **1,183.6 → 1,293.4** | +109.8 |
| washer, 1 sybil cp | 85.80 → 26.91 | +7,286 → +4,019 | **662.3 → 365.4** | **−296.9** |
| washer, 5 sybil cps | 156.00 → 97.11 | +13,259 → +14,474 | **883.9 → 964.9** | **+81.0** |

Direction is stable across R ∈ {1, 2, 3, 5}; magnitudes move by a few percent.

The regressivity ROUND13 §2.4 measured is largely gone:

| profile | gov multiplier BEFORE | AFTER (R=3) |
|---|---:|---:|
| minimal work @ `MinQualifyingVol` | 4.33× | 1.19× |
| washer: vol 10,000, 1 buyer | 3.67× | 1.15× |
| honest low-vol: 100, 5 buyers | 2.14× | 1.06× |
| honest high-vol: 5,000, 5 buyers | 1.67× | 1.04× |
| **regressive spread (max/min)** | **2.60×** | **1.14×** |

### 7.3 "Confirm no honest cohort is newly harmed" — I cannot confirm this

**The low-volume honest cohort is harmed: −12.1% net/era (+7,701 → +6,766), −93.5 per 1,000 CMN
capital.** It remains solidly profitable and it is a share shift, not a viability question — but it
is a real loss and it should not be reported as neutral.

The mechanism is structural, not a bug in the fix. `gov_contribution` is a **flat additive term** in
the activity budget, so it is a larger *fraction* of a low-activity agent's weight than of a
high-activity one's. That is the same fact as "the term is regressive in work" (ROUND13 §2.4) read
in the other direction: the profiles that captured most of the subsidy are the ones that lose most
when it shrinks — and honest low-volume agents sit in the same structural position as the minimal-work
attacker the fix was aimed at. The chain cannot currently tell them apart, which is precisely
ROUND12 §6's open question.

**And the uncomfortable one: the 5-sybil wash ring gains, +9.2% per unit capital (883.9 → 964.9).**
It is a high-work-score profile — vol 10,000 with five *faked* counterparties giving
`diversity_bps = 10,000` — so it had only a 1.67× governance multiplier and barely used the term.
It is untouched by both changes and simply collects the share the low-activity cohort drops. It
still loses to the high-volume honest cohort per unit capital (964.9 vs 1,293.4), which is ROUND12
§3.3's framing and still holds; but the gap to the *low-volume* honest cohort widens.

**Read plainly: neither the gov fix nor the alpha cut is an anti-wash measure.** They close a
governance-farming vector, which was worth doing on its own terms — the 1-sybil washer loses 45%.
The 5-sybil ring is a diversity/identity problem, and B1 is what would bind it.

### 7.4 Decomposition — which change moves which cohort (R = 3, net per 1,000 CMN capital)

| scenario | honest v100 | honest v1,000 | honest v5,000 | washer 1cp | ring 5cp |
|---|---:|---:|---:|---:|---:|
| BEFORE (α=4,000, gov=20) | 770.1 | 952.5 | 1,183.6 | 662.3 | 883.9 |
| **fix only** (α=4,000, gov=3) | 694.3 | 973.7 | 1,278.5 | 415.6 | 953.8 |
| **alpha only** (α=1,500, gov=20) | 711.4 | 955.1 | 1,232.9 | 496.7 | 921.0 |
| **BOTH — shipped** (α=1,500, gov=3) | 676.6 | 974.5 | 1,293.4 | 365.4 | 964.9 |

Most of the movement is the **credit-distinctness fix**, not the alpha cut. And alpha is a weak
lever once credit is honest: sweeping it across the entire legal `AlphaBounds` range [1,000, 8,000]
at R = 3 moves the low-volume honest cohort only from 672.7 to **718.1** — it cannot reach 770.1
anywhere in range, because `gov_score` is 1,500/10,000 at R = 3 regardless of α. Raising alpha would
slightly help that cohort *and* slightly hurt the ring (967.4 at α=1,000 → 938.8 at α=8,000), i.e.
weakly opposite to the direction chosen. The effect is ≤7% across an 8× range, so this does not
argue against the decision; it argues that **α is close to spent as a lever and D is where the
leverage now sits** (§5).

---

## 8. Indexer / SDK impact of the `record_gov_vote` signature change

**Indexer: no impact — there is no indexer to break.** CLAUDE.md describes a Node.js event indexer
with 24 REST endpoints and a JS test suite. That code is **not in this tree**: `indexer/` contains a
single file, `reconcile.py`, which reconciles agent/escrow/per-era snapshots and never references
governance events. There are no `.js` files and no `package.json` under `indexer/`. Nothing was
updated because nothing consumes `GovVoteRecorded`. If the indexer lives in another repo, this is
the change it needs: `GovVoteRecorded` gains `poll_index` between `who` and `total_era_votes`.

**SDK: no break today, one concrete follow-up.** `sdk/src/` wraps `register`, `addStake`,
`heartbeat`, three escrow calls, `oracle.submitResponse`, `convictionVoting.vote`,
`emissions.settleEra` and `claim`. It does **not** wrap `record_gov_vote`, so nothing in the SDK
fails to compile or breaks at runtime. The follow-up is that a `recordGovVote` wrapper must now take
the poll index — which the SDK already has in hand, since `vote(pollIndex, vote)`
(`sdk/src/index.ts:198`) is the call that precedes it. The natural shape is
`recordGovVote(pollIndex, signer)` immediately after `vote()`.

**Anything using dynamic metadata** (Polkadot-JS apps, `@polkadot/api` against a live node) picks the
new signature up automatically from the runtime metadata after the 304 upgrade. Anything with a
hardcoded call encoding — `agents.recordGovVote(agent)` with one argument — breaks and must add the
poll index. `transaction_version` is left at 1, consistent with this runtime never having launched;
on a live chain this change would require a `transaction_version` bump too.

---

## 9. Still deferred

| Item | Status | Why it is deferred |
|---|---|---|
| **B1 — front-loading defeats the diversity cap** | **Open, by maintainer decision** | Closing it needs per-(agent, buyer) volume state and a decision on whether diversity means distinct `AccountId`s or *economic* distinctness. That is ROUND12 §6's question and it is not an engineering call. §7.3 shows it is now the binding constraint on the strongest ring |
| **`MaxProposalsPerEra = 20` as the gov denominator** | **Quantified, not changed** | §5. At R = 3 an honest full participant earns 225 bps of a 10,000 bps budget. Lowering D helps low-volume honest agents and hurts the ring, monotonically, saturating at D ≤ R |
| **Honest low-volume cohort −12%** | **Reported, not compensated** | §7.3. Intrinsic to making gov credit honest; no α in the legal range restores it. If it matters, D is the lever, and even D = 3 only reaches 728.4 of 770.1 |
| **`Voting::Delegating` earns no credit** | **Shipped as designed** | §1.2. A delegator earns zero `gov_score`. Crediting delegation needs a per-referendum binding that a delegation does not have |
| **`EraSeenBuyerSlots` clear bound of `bound × 128`** | **Untouched** | ROUND13 §3 flagged it as possibly under-covering with many agents × many buyers, leaving stale slots into the next era. Not analysed here; the new map's bound is exact by contrast |
| **`OracleScoreProvider = ()`** | **Untouched** | Inherited F-5. The +20% oracle term stays inert; rank 3 stays unreachable |

---

## 10. Confidence and limits

**High confidence — executed, not argued.** Unlike ROUND12 and ROUND13, this round ran code. The
guards are exercised by tests that fail without them, the workspace builds in release, and the sim
anchors bit-exactly on ROUND12's published table before producing anything. The gov vector is closed
in the sense that matters: there is now no path from one held vote to more than one credit, and none
at all from a concluded referendum.

**Medium confidence.**
- **R is an assumption.** Every "AFTER" number depends on how many referenda are concurrently live.
  I swept R ∈ {1..5} on the 3-track configuration; if real throughput is much higher, the honest-cohort
  harm in §7.3 shrinks and the denominator question in §5 softens. This cannot be settled from source.
- **The sim population is synthetic** — ROUND12's 200-agent steady state, all honest workers fully
  participating in governance. Real partial turnout changes Σ and therefore every share.
- **Costs carry ROUND12's model fee assumptions** (`TXFEE = 10 CMN`), never transcribed from the
  runtime. Fees are ~1–3% of rewards here, so this does not move conclusions, but the absolute net
  figures inherit it.

**Not verified.**
1. **No Substrate node was run.** No WASM, no zombienet, no live extrinsic against a real referendum.
   `ConvictionVotingBridge` is exercised only through its trait shape; the mocks model `VotingFor` and
   `Polling::as_ongoing` rather than calling them. A devnet test dispatching a real `vote` and a real
   `record_gov_vote` across a referendum's conclusion is the missing piece, and the ROUND10 3-validator
   devnet is the place to do it.
2. **Weight annotations are hand-estimated**, not benchmarked — `reads_writes(3, 2)` for the extra
   dedup read/write, and `drain_era_maps` now clears one more map. Directionally right, not measured.
3. **Gates were run locally,** not in Codespaces or Actions, contrary to CLAUDE.md's assumption. CI on
   the PR is the authoritative run.

**Where I could be wrong in the direction that matters.** Not in the fix — that is executed and
pinned. It is in §7.3: I claim the low-volume honest cohort's loss is *structural* to honest
governance credit rather than an artifact of α or D. That rests on the sim's population and on R = 3.
If the maintainer's read is that R will routinely be 10+, or that the low-volume cohort in the sim
does not represent the real one, then the harm is overstated and the denominator question in §5
mostly evaporates. That is the assumption most worth a second reader — and unlike the diagnosis, it
cannot be settled from source, only from governance data once the chain is live.
