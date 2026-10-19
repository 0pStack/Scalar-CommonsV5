# ROUND 8b — Permissive propose: **BLOCKED at the safety check, not shipped**

Date: 2026-08-02
Branch: `rebuild/runtime` (PR #66). Context: `ROUND8.md` failure 6.

**Task 2 fails. The pending-proposal queue is unbounded, so per the round's own
instruction I stopped and did not remove the guard.**

> "If UNBOUNDED: stop, do not ship the guard removal, and report — an unbounded
> queue writable by any signed origin is a storage-exhaustion attack and the
> decision needs revisiting with a cap."

Task 1 not shipped. Task 3 not applicable (conditional on shipping). Task 4
(documentation) **done** — it was the root cause of failure 6 and is valuable
under either design. One commit, documentation only: **68 insertions, 0
deletions, zero behavioural change.**

---

## 1. The spam-bound analysis

### Answer: UNBOUNDED. No BoundedVec, no enforced cap, no deposit, no reaper.

`PendingLinkProposals` is a plain `StorageDoubleMap<orchestrator, sub_agent,
BlockNumber>` (`lib.rs:108`). Every touchpoint in the pallet:

| Op | Site | Notes |
|---|---|---|
| **write** | `insert` — `propose_sub_agent_link` | the only growth path; **no deposit, nothing reserved** |
| read | `get` — `accept_orchestrator_link` | |
| remove | `remove` — `accept_orchestrator_link` | **only on a *successful* accept** |
| bulk remove | `clear_prefix(&who, 1000, None)` — `deregister_orchestrator` | capped at 1,000, **result discarded** (`let _ =`) |

There is **no `on_idle`, `on_initialize`, or `on_finalize`** — `Hooks` implements
only `on_runtime_upgrade`, returning `Weight::zero()`. Nothing sweeps expired
proposals.

### The two constants that look like caps and are not

This is the part I'd most want a second pair of eyes on. Both are declared in
`Config`, configured in `runtime/src/lib.rs`, and **never read** — `::get()`
appears nowhere in the pallet for either:

| Constant | Runtime value | Enforcement sites |
|---|---|---|
| `MaxPendingProposals` | `ConstU32<20>` (`runtime:1229`) | **none** |
| `MaxSubAgentsPerOrchestrator` | `ConstU32<50>` (`runtime:1226`) | **none** |

`MaxPendingProposals` is the cap this change needed. It does not exist as code —
only as a name.

`MaxSubAgentsPerOrchestrator` matters too, because the one gate that *looks* like
it limits proposals is:

```rust
ensure!(record.active_sub_count < record.max_sub_agents, Error::<T>::SubAgentCapFull);
```

`max_sub_agents` is **caller-supplied at `register_orchestrator` and validated
against nothing**, so an orchestrator may register with `u32::MAX`. And
`active_sub_count` only increments on *accept*, never on propose — so this gate
does not bound outstanding proposals even in principle.

### What the removal would actually expose

Attacker cost: register one agent (`MinStake` 1,000 CMN + 50 CMN fee), reach rank
2, `register_orchestrator` with `max_sub_agents = u32::MAX`. Then call
`propose_sub_agent_link` once per target. `AgentsMaxAgents = 10_000_000`
(`runtime:1072`), so the ceiling is **~10 million permanent storage entries from
a single account, paying only transaction fees.**

Re-proposing to the same pair overwrites one key, so growth is one entry per
`(orchestrator, sub_agent)` pair — but that is still `#orchestrators ×
#agents`, with no term under the chain's control.

**The sharp part is not the volume — it is that the victim cannot clear it.**
After removing the propose-side guard, for an already-linked sub-agent:

* they **cannot accept** — the accept-side `AlreadyLinked` guard (correctly) fires;
* they **cannot decline** — there is no decline/reject/cancel extrinsic. Call
  indices 0–5 are `register_orchestrator`, `propose_sub_agent_link`,
  `accept_orchestrator_link`, `remove_sub_agent_link`, `deregister_orchestrator`,
  `claim_orchestrator`. That is the complete set;
* they **cannot wait it out** — expiry is only *checked* at accept; expired
  entries are never removed;
* `remove_sub_agent_link` does not touch `PendingLinkProposals` either.

So the inbox becomes append-only with no owner-side drain. And if the attacker
then deregisters, `clear_prefix(&who, 1000, None)` removes at most 1,000 while
`OrchestratorRegistration::remove(&who)` succeeds unconditionally — **orphaning
the remainder permanently**, with no orchestrator record left to attribute or
clean them up.

### Being fair about what is pre-existing

The propose-side guard is **not** currently doing much of this work. Today an
orchestrator can already spam proposals at every *unlinked* agent, uncapped and
undeposited. **The storage-exhaustion surface already exists and already needs
the cap.**

What the guard does provide is the only *terminal state*: today, once an agent
accepts a link, their inbox can never grow again. Removing the guard deletes that
property and replaces it with unbounded monotonic growth the victim cannot stop.

**Recommendation:** the cap is needed regardless of which way the propose
decision goes. Shipping permissive propose without it converts a latent,
partially-mitigated issue into an actively exploitable one.

### What a fix needs (maintainer's call — I did not design or implement it)

1. A counter enforcing `MaxPendingProposals`, per sub-agent **and** per
   orchestrator. Per-sub-agent is the one that matters for the victim; a new
   storage item means a **migration and a `spec_version` bump**.
2. A `decline_link_proposal` (or `clear_expired_proposals`) extrinsic so a
   sub-agent can drain their own inbox. Without this a cap just converts
   exhaustion into denial-of-service — fill the victim's 20 slots and no
   legitimate orchestrator can ever reach them.
3. Either a reaper or making the bulk-clear paths unbounded/complete, so expired
   entries do not accumulate; and `deregister_orchestrator` should not silently
   orphan past its 1,000 limit.
4. Enforce `MaxSubAgentsPerOrchestrator` in `register_orchestrator`, or delete it.

Items 1–3 are storage-layout and extrinsic-signature changes, both outside this
round's scope and outside ROUND8's standing constraints.

---

## 2. The diff explained

Documentation only. `git diff --stat`: **1 file, 68 insertions, 0 deletions.**
No `ensure!` added or removed; both `AlreadyLinked` guards are byte-identical to
before (`lib.rs:328` propose, `lib.rs:369` accept).

Task 4 asked for the rule to be written down, because its absence is exactly why
failure 6 existed. I wrote down the rule **that is actually in force**, plus the
maintainer's decision and why it is deferred — documenting "propose =
permissive" while the code rejects would have re-created the same source-of-truth
gap in the opposite direction.

* **`SubAgentToOrchestrator`** — the exclusivity invariant (at most one
  orchestrator per sub-agent), that `accept_orchestrator_link` is the
  authoritative enforcement point, how links are cleared, that propose is
  *currently* also strict, that this is what failure 6 turned on, and the
  2026-08-02 decision to go permissive with its blocker.
* **`PendingLinkProposals`** — that it is unbounded, every write/remove path, the
  1,000-entry discarded-result clear, the absence of a reaper, and that any cap
  must come with a sub-agent-side drain.
* **`propose_sub_agent_link`** — proposing links nothing; current strict
  behaviour; the pending relaxation.
* **`accept_orchestrator_link`** — marked as *the* enforcement point, noting the
  guard runs before the proposal lookup, and that it must survive any future
  relaxation of propose.
* **`MaxPendingProposals` / `MaxSubAgentsPerOrchestrator`** — marked
  **NOT CURRENTLY ENFORCED**, with what that implies. A `Config` constant that
  silently binds nothing is precisely the hazard that produced this round.
* **`LinkApprovalWindow`** — clarified that it bounds a proposal's usefulness,
  not its storage lifetime.

---

## 3. Test results

Unchanged, because behaviour is unchanged.

```
$ cargo test --workspace --no-fail-fast     90 passed   1 failed
$ cargo fmt --all -- --check                FMT_EXIT=0
$ cargo clippy --workspace --all-targets -- -D warnings
                                            CLIPPY_EXIT=0
$ cargo build --release                     BUILD_EXIT=0
    Finished `release` profile [optimized] target(s) in 4m 14s
```

| Crate | Passed | Failed |
|---|--:|--:|
| `pallet-agents` | 27 | 0 |
| `pallet-emissions` | 10 | 0 |
| `pallet-escrow` | 13 | 0 |
| `pallet-oracle` | 10 | 0 |
| `pallet-orchestrator` | 9 | **1** |
| `scalar-commons-integration-tests` | 17 | 0 |
| `scalar-commons-runtime` | 4 | 0 |
| **Total** | **90** | **1** |

**The gate is not met and cannot be met without shipping the blocked change.**
The round asked for 0 failures across 92+ tests; the suite is 91 tests with 1
failure. `sub_agent_cannot_link_to_two_orchestrators` still fails on its
`assert_ok!(propose(CAROL, BOB))`, exactly as ROUND8 described. It is now failing
for a *known and decided* reason — it encodes the semantics the maintainer wants
— but the implementation is blocked on the cap. It will pass unchanged, as the
round predicted, the moment permissive propose ships safely.

I did not add the two tests from task 3. Both describe permissive behaviour that
does not exist yet, so they could only be written as `#[ignore]` placeholders or
as tests of the opposite semantics. On the unlink path task 3 asked about: it
**does** exist — `remove_sub_agent_link` (call index 3), callable by either
party. Worth recording for the future implementation: **it does not clear pending
proposals**, so the "link ends → can now accept the queued offer" flow will work
only if the original proposal has not expired, and the stale entry it leaves
behind is part of why the reaper is needed.

---

## 4. What I did NOT do

**The blocked task:**

1. Did **not** remove the `AlreadyLinked` ensure from `propose_sub_agent_link`.
   This is the whole point of the round; the safety check said stop, so I
   stopped. Both guards remain byte-identical.
2. Did **not** ship it "with a TODO", behind a feature flag, or with a comment
   promising a follow-up cap. A storage-exhaustion vector is not a follow-up.

**Not designed around it:**

3. Did **not** add a cap, counter, deposit, reaper, or `decline_link_proposal`
   extrinsic. Each is a storage-layout or extrinsic-signature change requiring a
   migration and `spec_version` bump, outside this round's scope — and the
   instruction says the *decision* needs revisiting, which is the maintainer's
   call, not a gap for me to fill.
4. Did **not** enforce `MaxPendingProposals` or `MaxSubAgentsPerOrchestrator`,
   though both are one-line `ensure!`s. Enforcing a previously-dead constant
   changes behaviour for anyone already relying on its absence, and
   `MaxSubAgentsPerOrchestrator` in particular would start rejecting
   registrations that succeed today.

**Scope:**

5. Did **not** touch `runtime/**`, `node/**`, `tests/common.rs`, or any pallet
   other than `orchestrator` — and within it, changed only comments.
6. Did **not** change any economic constant, extrinsic signature, storage layout,
   pallet index, or `spec_version`.
7. Did **not** modify `sub_agent_cannot_link_to_two_orchestrators`, or apply the
   strict-side patch ROUND8 had verified. The maintainer has now decided against
   strict, so that patch is dead; the test stays as the accurate record of the
   intended semantics.
8. Did **not** revisit any ROUND6/ROUND7 gap.
9. Did **not** open a PR, merge, force-push, or touch `master`.
