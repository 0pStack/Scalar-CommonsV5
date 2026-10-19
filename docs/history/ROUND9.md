# ROUND 9 — Permissive propose, shipped with the safety kit

Date: 2026-08-02
Branch: `rebuild/runtime` (PR #66). Predecessors: `ROUND8.md` (failure 6),
`ROUND8B.md` (why it could not ship unbounded).

All six tasks complete. **Workspace: 97 passed, 0 failed.** Six commits, one per
task. The standing failure from ROUND8 is resolved — and resolved by the code
moving to the test, not the test moving to the code.

---

## 1. Storage, extrinsic and version changes — FOR HUMAN REVIEW

Everything a reviewer needs to sign off on, in one place.

### `spec_version` 302 → 303

Landed in the **first** commit of the series (`7becf83`) so that no intermediate
commit carries a storage-layout change without a bump. **No migration code is
written and none is needed** — this runtime has never launched on any network,
so there is no live state to move. That fact is recorded in the version comment
alongside the 300→301 and 301→302 precedents.

### New storage item

| Item | Type | Key |
|---|---|---|
| `PendingProposalCount` | `StorageMap<_, Blake2_128Concat, AccountId, u32, ValueQuery>` | **sub-agent** |

Keyed by sub-agent, not orchestrator, because the sub-agent is the party who
cannot otherwise defend themselves: an orchestrator chooses who to propose to, a
sub-agent cannot stop offers arriving.

No existing storage item changed type or key.

### New extrinsics — call indices are append-only

| Index | Extrinsic | Origin | Effect |
|---|---|---|---|
| **6** | `decline_link_proposal(orchestrator)` | sub-agent | removes one offer, `-1` |
| **7** | `cancel_link_proposal(sub_agent)` | orchestrator | removes one offer, `-1` |

Indices 0–5 are untouched. Both return `ProposalNotFound` when there is nothing
to remove, and **both deliberately operate on expired entries** — expiry is
consulted only at accept and nothing reaps expired rows, so refusing them would
let an expired proposal wedge a capped slot permanently.

### New errors and events

* Errors: `TooManyPendingProposals`, `MaxSubAgentsTooHigh` (appended).
* Events: `LinkProposalDeclined`, `LinkProposalCancelled` (appended).
* **`OrchestratorDeregistered` gains a field**: `proposals_cleared: u32`. This is
  the one change to an *existing* event. Checked for indexer coupling before
  making it — `indexer/` still contains only `reconcile.py` and references no
  orchestrator events, so no endpoint and no JS test is affected.

### Behavioural changes to existing extrinsics

| Extrinsic | Change |
|---|---|
| `propose_sub_agent_link` | **`AlreadyLinked` ensure removed** (permissive). Gains the per-sub-agent cap and the counter increment. |
| `accept_orchestrator_link` | **Byte-identical guard.** Only `remove` → `Self::remove_proposal`. |
| `register_orchestrator` | New `max_sub_agents <= MaxSubAgentsPerOrchestrator` ensure. |
| `deregister_orchestrator` | `clear_prefix(.., 1000, ..)` → complete `drain_prefix`, decrementing counters. |

### Weights

Per the task, the new calls follow the pallet's **existing hand-set inline
pattern** — `T::DbWeight::get().reads_writes(r, w).saturating_add(Weight::from_parts(n, 0))`
— not a benchmarked `T::WeightInfo`. Both are `reads_writes(1, 2)` + 40 ms, below
`accept_orchestrator_link`'s `(4, 4)` + 80 ms, since they do strictly less work
(one `take`, one counter mutate, one event).

Worth flagging: the pallet's `WeightInfo` trait and `PlaceholderWeights` mirror
the call set but **are not wired into `Config` anywhere** — no `type WeightInfo`
exists. The trait is vestigial. I added matching entries to preserve the mirror
rather than leave it partial, but no extrinsic reads them. Real benchmarks remain
a ROUND6 gap (all six `benchmarks.rs` files are still single comment lines).

---

## 2. Counter-correctness argument

The claim: **`PendingProposalCount[s]` always equals the number of
`PendingLinkProposals` entries whose second key is `s`.**

`PendingLinkProposals` is written in exactly **four** places. Every one is
enumerated below; `grep -n "PendingLinkProposals" lib.rs` confirms the list is
complete.

| # | Path | Map op | Counter op | Why it is correct |
|---|---|---|---|---|
| 1 | `propose_sub_agent_link` | `insert` | `+1` **iff new pair** | `is_new_pair` is computed with `contains_key` *before* the insert. Re-proposing overwrites one key and adds no entry, so it must not count — and the cap `ensure!` is likewise skipped, so refreshing an expiring offer still works at a full inbox. |
| 2 | `accept_orchestrator_link` | via `remove_proposal` | `-1` iff removed | — |
| 3 | `decline_link_proposal` / `cancel_link_proposal` | via `remove_proposal` | `-1` iff removed | — |
| 4 | `deregister_orchestrator` | `drain_prefix` | `-1` per row drained | `drain_prefix` yields each `sub_agent` key as it removes, which is precisely why `clear_prefix` could not be kept — it returns no keys, so correct decrements were impossible. |

**Paths 2 and 3 share one function.** `Self::remove_proposal` is the only
single-entry removal in the pallet:

```rust
fn remove_proposal(orchestrator: &T::AccountId, sub_agent: &T::AccountId) -> bool {
    if PendingLinkProposals::<T>::take(orchestrator, sub_agent).is_some() {
        PendingProposalCount::<T>::mutate(sub_agent, |c| *c = c.saturating_sub(1));
        true
    } else {
        false
    }
}
```

Three properties fall out of writing it once:

* **`take()` makes read-and-remove atomic**, so a decrement can never fire for an
  entry that was not present. The decline/cancel `ensure!` reads this function's
  return value rather than doing its own `contains_key`, so the check and the
  removal cannot disagree.
* **A new removal path cannot forget the counter** — it would have to duplicate
  this function to get it wrong.
* **`saturating_sub` cannot underflow.** This is load-bearing, not defensive
  habit: `tests/orchestrator_flow.rs` and `tests/common.rs` fixtures seed
  `PendingLinkProposals` *directly*, bypassing propose, so accept legitimately
  removes entries that were never counted. Those 17 integration tests still pass.

**Increment side:** the cap `ensure!` precedes the `insert`, per CLAUDE.md's
guards-fire-first rule, and `saturating_add` is used on the way up.

**Test coverage of the argument:** path 1's no-double-count is
`reproposing_same_pair_refreshes_without_consuming_a_second_slot`; path 2 is
asserted in the succession test (count returns to 0 on accept); path 3 in the
decline/cancel test, including the not-found case; path 4 in the 1,001-proposal
deregister test, which checks all 1,001 counters individually.

---

## 3. Known residual — flagged, not fixed

**Proposals are capped per sub-agent, not per orchestrator.** That is what task 1
specified, and it is the right priority: the sub-agent is the party who cannot
refuse delivery. But it leaves one consequence the maintainer should see.

An orchestrator can still hold one slot on every registered agent
(`AgentsMaxAgents = 10_000_000`). `deregister_orchestrator` now drains *all* of
them in a single extrinsic — that is task 4's explicit requirement, and shipping
a complete drain is strictly better than the old silent 1,000-row orphan — but it
makes that call **O(open proposals) against a fixed declared weight of 150 ms**.
A maximally-loaded orchestrator deregistering is a block-weight problem.

This is not a regression: the same unbounded `drain_prefix` shape already existed
for `SubAgentLinks` directly above it. But it is now reachable at larger scale.

Options, in the order I would consider them: a per-orchestrator cap (simplest,
symmetric with the per-sub-agent one); a multi-block/cursored drain that leaves
the registration in place until complete; or a bounded drain per call that
*requires* repeated calls and refuses to remove the registration until the prefix
is empty — that last one preserves "no orphan" without the unbounded loop.

Also still absent: **no `on_idle`/`on_initialize` reaper.** An expired proposal
keeps its slot until someone declines or cancels it. The drains accepting expired
entries is what makes this survivable rather than a wedge, but a reaper would be
better than relying on either party to act.

---

## 4. Test evidence

```
$ cargo test --workspace --no-fail-fast
                                  97 passed   0 failed
$ cargo fmt --all -- --check       FMT_EXIT=0
$ cargo clippy --workspace --all-targets -- -D warnings
                                   CLIPPY_EXIT=0
$ cargo build --release            BUILD_EXIT=0
    Finished `release` profile [optimized] target(s) in 4m 14s
```

| Crate | Passed | Failed | ROUND8 |
|---|--:|--:|---|
| `pallet-agents` | 27 | 0 | 27 / 0 |
| `pallet-emissions` | 10 | 0 | 10 / 0 |
| `pallet-escrow` | 13 | 0 | 13 / 0 |
| `pallet-oracle` | 10 | 0 | 10 / 0 |
| `pallet-orchestrator` | **16** | **0** | 9 / **1** |
| `scalar-commons-integration-tests` | 17 | 0 | 17 / 0 |
| `scalar-commons-runtime` | 4 | 0 | 4 / 0 |
| **Total** | **97** | **0** | 90 / **1** |

Six new orchestrator tests (+6), and the standing failure now passes.

### (a) The ROUND8 test passes unchanged — verified, not asserted

```
$ git diff 98f326f -- pallets/orchestrator/src/tests.rs
(no output)      # ...as of task 5, before task 6 appended new tests
```

`sub_agent_cannot_link_to_two_orchestrators` was never edited. Its `assert_ok!`
on propose and `assert_noop!` on accept **are** permissive semantics — that test
has been the accurate specification all along, and ROUND8's decision to leave it
failing rather than rewrite it to match the code was the right call. This is the
round where the code caught up.

### (b)–(f)

| Test | Proves |
|---|---|
| `pending_proposal_cap_is_enforced_per_sub_agent` | 20 offers accepted with the counter asserted after each; 21st → `TooManyPendingProposals` with the count unmoved; decline one → 21st succeeds. The last step is the point: a bound, not a lockout. |
| `reproposing_same_pair_refreshes_without_consuming_a_second_slot` | same pair twice → count stays 1, `expires_at` moves forward |
| `decline_and_cancel_drain_expired_entries_and_decrement` | both drains work on **expired** rows; both decrement; second attempt → `ProposalNotFound` with no further decrement |
| `succession_flow_queued_offer_taken_up_after_link_ends` | linked sub-agent **receives** an offer (impossible before this round), cannot accept it, existing link intact, unlinks, then accepts — ending linked to the new orchestrator |
| `deregister_drains_every_proposal_past_the_old_1000_cap` | 1,001 proposals → **zero** rows left (checked by prefix iter *and* whole-map iter) and all 1,001 counters back to 0. Exactly one row survived under the old code. |
| `register_orchestrator_rejects_max_sub_agents_above_the_constant` | `cap + 1` → `MaxSubAgentsTooHigh`; exactly `cap` gets past and fails later on `AgentMustBeRank2`. The *change of error* is what proves the boundary is inclusive. |

Two helpers: `orchestrator()` writes the registration directly (the `()`
`AgentCollective` mock always reports rank 0, so `register_orchestrator` can
never succeed in this mock — the pattern the pre-existing tests already use), and
`seed_agent()` writes `AgentStake`, which is exactly what `is_agent` reads, so
the 1,001-target test needs no endowed balances.

### Both dead constants are now live

ROUND8B's headline finding was that `MaxPendingProposals` and
`MaxSubAgentsPerOrchestrator` were declared, configured, and never read. Both are
now enforced, each with a test that fails if the enforcement is removed. Their
doc comments no longer say **NOT CURRENTLY ENFORCED**.

---

## 5. What I did NOT do

**Scope:**

1. Did **not** touch any pallet other than `orchestrator`. `runtime/src/lib.rs`
   was touched for the `spec_version` bump and its comment **only** — no Config
   wiring line was needed, since both constants already existed.
2. Did **not** change any economic constant, weight curve, emission parameter, or
   pallet index. No `construct_runtime` change.
3. Did **not** modify `tests/common.rs` or the integration tests. All 17 pass
   unchanged, including the two that seed `PendingLinkProposals` directly.
4. Did **not** touch the indexer — checked first and confirmed nothing there
   references orchestrator events.

**Deliberately not widened:**

5. Did **not** add a per-orchestrator proposal cap, a multi-block drain, or an
   expiry reaper. All three are flagged in §3 as maintainer decisions; none was
   in the six tasks, and each changes storage or dispatch semantics.
6. Did **not** write a migration. The round states the chain has never launched;
   the `spec_version` comment records that reasoning rather than leaving it
   implicit.
7. Did **not** benchmark the new extrinsics or wire `WeightInfo` into `Config`.
   The task specified the existing hand-set pattern; the vestigial trait is
   flagged in §1 instead.
8. Did **not** rewrite `sub_agent_cannot_link_to_two_orchestrators`, or any
   pre-existing test, to accommodate the new code.

**Never on the table:**

9. Did **not** weaken the accept-side `AlreadyLinked` guard — byte-identical, and
   diffed to prove it. Exclusivity is still absolute; only its enforcement stage
   moved to being singular.
10. No `#[allow]`, `todo!()`, `unimplemented!()`, `#[ignore]`, or placeholder
    test. Every assertion in the six new tests is real.
11. Did **not** open a PR, merge, force-push, or touch `master`.
