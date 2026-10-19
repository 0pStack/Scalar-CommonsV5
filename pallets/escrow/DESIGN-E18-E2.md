# DESIGN — E18 (provider consent) + E2 (exit for stuck agreements)

Issue #180. Supersedes the design in draft PR #204, which stalled on the
`claim_refund` interaction (§4). Additive storage only: no layout change to an
existing item, therefore no migration and no `spec_version` bump.

## 1. The two findings

**E18.** `create_agreement` today reserves the buyer's funds *and* increments the
provider's `ActiveEscrowCount`, with no input from the provider. Since
`agents.request_unstake` refuses while `ActiveEscrowCount > 0`, any buyer can pin
any agent's stake indefinitely by opening agreements the agent never agreed to.
The cost to the attacker is a refundable reserve; the cost to the victim is its
entire stake. An agreement must not bind a provider who never consented.

**E2.** An agreement whose provider goes silent has no exit that does not depend
on the buyer. `claim_refund` is buyer-only, so a buyer who loses its key — or
simply stops running — leaves funds reserved and the provider's count pinned
forever. Per first principle 3 the exit must be permissionless.

## 2. Storage

```rust
PendingAcceptance: StorageDoubleMap<
    Blake2_128Concat, AccountId,          // buyer
    Blake2_128Concat, (AccountId, u32),   // (provider, seq)
    BlockNumberFor<T>,                    // created_at
    OptionQuery,
>
```

An entry means *created, not yet accepted*. Absence means accepted. That polarity
is deliberate and is what removes the need for a migration: every agreement that
exists before this change has no entry, so it reads as accepted and is
grandfathered. A `bool` field on `Agreement` would have been the obvious
encoding and is exactly what we cannot do — it changes an existing layout.

`EXPIRY_GRACE = 10` blocks is a pallet-level `const` in `pallets/escrow/src/lib.rs`,
not a `Config` type, because `runtime/src/lib.rs` is out of scope for this change.

## 3. Lifecycle

```
create_agreement            → reserved, PendingAcceptance entry, provider count NOT incremented
  ├─ accept_agreement       (provider) → entry removed, provider count incremented
  │    └─ record_delivery → confirm_delivery / dispute_delivery / claim_refund   (unchanged)
  ├─ reject_agreement       (provider) → entry removed, buyer refunded, agreement closed
  ├─ cancel_pending         (buyer)    → entry removed, buyer refunded, agreement closed
  └─ expire_agreement       (anyone, past this status's own window + EXPIRY_GRACE) → buyer refunded, closed
```

`create_agreement` keeps its signature and still counts toward
`MaxAgreementsPerPair` — a pending agreement occupies a bilateral slot, so the
pair cap still bounds how much storage a buyer can force. It no longer calls
`increment_active_escrow`. `record_delivery` gains
`ensure!(!PendingAcceptance::contains_key(..), Error::NotAccepted)`.

`request_unstake` is untouched. Pending agreements never enter
`ActiveEscrowCount`, so E18 closes by construction rather than by a new guard.

`accept_agreement` re-runs the E1 capability check — acceptance is the moment the
provider commits to the skill, so the capability must be held then, not merely at
creation. It also refuses after `deliver_by`: accepting an agreement that is
already expirable would pin the provider's count for work that can no longer be
delivered.

## 4. The `claim_refund` interaction

This is what blocked #204. Removing the increment from `create_agreement` left
`claim_refund` decrementing a count that, for a pending agreement, was never
incremented — so a sybil buyer could walk a victim provider's `ActiveEscrowCount`
down to 0 and unstake it out from under its real obligations. The E18 hole
reopened in the opposite direction.

### 4.1 The refund cases, enumerated

| # | Consent | Status | Provider count incremented? | Door | Earliest |
|---|---|---|---|---|---|
| A | never accepted | `Created` | no | `cancel_pending` (buyer) / `reject_agreement` (provider) | immediately |
| B | never accepted | `Created` | no | `expire_agreement` (anyone) | `deliver_by + EXPIRY_GRACE` |
| B2 | accepted | `Delivered` | yes | `expire_agreement` (anyone) | `deliver_by + BuyerResponseWindow + EXPIRY_GRACE` |
| B3 | accepted | `Disputed` | yes | `expire_agreement` (anyone) | `dispute_opened_at + DisputeTimeoutWindow + EXPIRY_GRACE` |
| C | accepted | `Created` | yes | `claim_refund` (buyer) | `deliver_by + BuyerResponseWindow` |
| D | accepted | `Created` | yes | `expire_agreement` (anyone) | `deliver_by + EXPIRY_GRACE` |
| E | accepted | `Delivered` | yes | `claim_refund` (buyer) | `deliver_by + BuyerResponseWindow` |
| F | accepted | `Disputed` | yes | `claim_refund` (buyer) | `dispute_opened_at + DisputeTimeoutWindow` |

Cases A/B refund without touching `ActiveEscrowCount`. Cases C–F must decrement
it. Conflating the two is the #204 defect.

### 4.2 Which guard fires first, and why

`claim_refund` classifies **consent before eligibility**. The consent check is
the first `ensure!` in the call, ahead of the deadline/timeout arithmetic:

1. `AgreementNotFound` — the agreement exists at all.
2. **`NotAccepted` — the agreement is not pending** (cases A/B are refused here).
3. `DisputeTimeoutNotElapsed` — the per-status timing window has elapsed.
4. *only then* `unreserve`, `decrement_active_escrow`, close.

Two reasons for that order, both load-bearing:

- **Correctness.** Past step 2, `claim_refund` is reachable only for an accepted
  agreement, so its unconditional `decrement_active_escrow` is sound by
  construction. The alternative — teach `claim_refund` to skip the decrement when
  pending — leaves the same call serving two economically different cases and
  makes the bookkeeping depend on a branch a future edit can drop.
- **Honest errors.** A buyer holding a pending agreement before its window has
  elapsed would otherwise be told `DisputeTimeoutNotElapsed`, i.e. "wait longer" —
  actively misleading, since waiting never makes `claim_refund` work for a
  pending agreement. `NotAccepted` points at `cancel_pending`, which is available
  to that buyer *now* and refunds the same amount. Refusing pending agreements
  from `claim_refund` therefore costs the buyer nothing.

So pending agreements exit through exactly three doors — `cancel_pending`,
`reject_agreement`, `expire_agreement` — and accepted ones through
`claim_refund`, `expire_agreement`, or normal settlement.

The classification lives in one function, `consent_state`, returning a two-armed
`ConsentState`. Both `claim_refund` and `expire_agreement` call it, so the
*classification* is stated once rather than re-derived.

They then use it differently, and this paragraph used to claim both `match` on
it:

- `expire_agreement` **matches**, because both arms are reachable: a pending
  agreement and an accepted one are each expirable and differ only in whether
  the provider's count is released.
- `claim_refund` **refuses** with an `ensure!`, because only one arm is valid
  there — a pending agreement has no business being refunded through the
  accepted path, and `cancel_pending` is open to that buyer for the same amount
  immediately. An `ensure!` says "this door is not for that case"; a `match`
  would imply it handles both.

So the count decision does not emerge from `ensure!` ordering, but the two calls
are not symmetric and the doc should not have implied they were.

### 4.3 No double refund

Every refund door — `claim_refund`, `reject_agreement`, `cancel_pending`,
`expire_agreement` — ends by removing the agreement from `Agreements` with
`swap_remove`, and every door begins with
`position(|a| a.seq == seq).ok_or(AgreementNotFound)`. The agreement's presence in
`Agreements` *is* the once-only token. A second call through the same door, or
through any other door, finds nothing and fails with `AgreementNotFound` before
reaching any `unreserve`. All of it runs inside `try_mutate`, so the failing call
writes nothing.

`expire_agreement` (case D, `deliver_by + 10`) becomes available before
`claim_refund` (case C, `deliver_by + 50`) under the runtime's current constants.
That is intended: both refund the buyer the same full amount, and whichever fires
first closes the agreement against the other. `e18e2_refund_cannot_be_claimed_twice_across_paths`
asserts this on reserved balances, not on return values.

## 5. Guards fire before funds move

In every new call all `ensure!`s precede the first `unreserve` /
`increment_active_escrow` / `PendingAcceptance` write. `expire_agreement`'s
`PendingAcceptance::take` sits after both its status and deadline guards.

## 6. Compatibility

- New calls appended at indices 6–9; nothing renumbered.
- New events appended after `DeadlineExtended`; new errors after `SpanTooLong`.
- No existing struct edited: `git diff master -- pallets/escrow/src/lib.rs | grep 'pub struct'` is empty.
- No new `Config` type, so no mock gains a field.
- `record_delivery` now requires acceptance, so existing create→deliver tests and
  the `complete_escrow` helper in `tests/common.rs` gain an `accept_agreement`
  step. No assertion is loosened.
- Storage version unchanged; `PendingAcceptance` is a fresh prefix.

## 7. Out of scope

`dispute_delivery` and `runtime/src/lib.rs` are untouched.

**The dispute→oracle bridge is NOT untouched, and this section used to say it
was.** A `Disputed` expiry clears `DisputeToAgreement` (`lib.rs`, in
`expire_agreement`), because without it a later oracle callback would resolve
against an agreement that no longer exists. Issue #180's amendment of
2026-10-01 permits exactly this one change and nothing else in the bridge. The
bounty is deliberately left reserved: `dispute_delivery` carves it out of the
agreement amount and `expire_request` releases it.

The SDK's missing `acceptAgreement` is a follow-up (#277). Indexer decoding for
the four new events is **in this change**, not a follow-up — CLAUDE.md requires
it in the same PR, and the activity classifier is an allow-list, so omitting
them would have silently reported every rejected, cancelled and expired
agreement as permanently open.

## 8. Gaming-vector analysis (first principle 4)

Four new extrinsics, so this section is a merge requirement, not a courtesy.

### 8.1 The `ActiveEscrowCount` invariant

Each agreement contributes 0 (pending) or 1 (accepted) to its provider's
`ActiveEscrowCount`, and releases that contribution exactly once when it closes.
Mechanically, in `pallets/escrow/src/lib.rs`:

- Exactly one `increment_active_escrow`, in `accept_agreement`, which removes the
  pending entry in the same call and so cannot run twice for one agreement.
- Five `swap_remove` sites, each of which either decrements or is provably
  unreachable for a pending agreement:

| Close path | Reached only when | Decrements? |
|---|---|---|
| `confirm_delivery` | `status == Delivered` | yes |
| `claim_refund` | `ConsentState::Accepted` | yes |
| `expire_agreement` | any status, past its own window + grace | only in the `Accepted` arm |
| `close_pending` (reject/cancel) | `ConsentState::Pending` | no — correctly |
| `settle_dispute_from_oracle` | `status == Disputed` | yes |

`Delivered` is written in exactly one place, `record_delivery`, which requires
`ConsentState::Accepted`; `Disputed` is only reachable from `Delivered`. So both
status-guarded paths are accepted-only by construction, not by inspection.

**Downward drift** (the #204 defect: walking a victim's count to 0 so it can
unstake while owing accepted deliveries) is closed by the `claim_refund` consent
guard and by `expire_agreement`'s `Pending` arm. Covered by
`e18e2_claim_refund_rejects_pending_agreement` and
`e18e2_expire_pending_agreement_leaves_provider_count_alone`, which both put a real
accepted obligation on the provider and assert the slot survives.

**Upward drift** (pinning a provider's stake forever) needs an agreement that
increments and never releases.

**This section previously claimed "There is no such path". That was wrong, and
it was the most serious defect in this design.** `expire_agreement` was
`status == Created` only, so a delivered-and-abandoned agreement had *no*
permissionless exit: `confirm_delivery`, `dispute_delivery` and `claim_refund`
are all buyer-signed. A buyer could create the minimum agreement, wait for the
provider to accept and deliver, and then go silent — leaving the provider's
count pinned at 1 and its whole stake (>= `MinStake`) frozen behind
`request_unstake`, for the price of a sacrificed minimum reserve. Better than
100:1 leverage, and the same attack E18 exists to prevent, relocated one step
later. `Disputed` had the same shape, reachable because the oracle's
`expire_request` can unreserve the bounty and drop the request without ever
invoking `DisputeCallback`.

It was also worse than a liveness bug: with no exit from `Delivered`, a
provider's *risky* move was doing the work, because refusing to deliver let the
agreement expire and released the slot. First principle 2 says emissions reward
verifiable work; nothing in this pallet may make delivering the dangerous
option.

Found by the `tokenomics-security-reviewer` subagent on PR #233, which is the
review CLAUDE.md requires for an escrow change and the reason it is required.

**Now** every status has a permissionless exit, each behind the window belonging
to that status plus `EXPIRY_GRACE`:

| Status | `expire_agreement` opens at |
|---|---|
| `Created` | `deliver_by + EXPIRY_GRACE` |
| `Delivered` | `deliver_by + BuyerResponseWindow + EXPIRY_GRACE` |
| `Disputed` | `dispute_opened_at + DisputeTimeoutWindow + EXPIRY_GRACE` |

The grace is added *on top of* the buyer's own window in every case, so a buyer
who is merely slow always outranks a stranger closing its agreement, and the
payee is the buyer of record either way — this adds liveness without moving
value. A `Disputed` expiry also clears `DisputeToAgreement`, so no oracle
callback can later resolve against an agreement that no longer exists. The
oracle's bounty is deliberately left reserved: `dispute_delivery` carves it out
of the agreement amount and `expire_request` is what releases it.

Upward drift now needs an agreement that increments and never releases, and
there is no such path: one increment site, and every removal from `Agreements`
is in the table above.

### 8.2 Vectors considered and why each fails

- **Buyer griefs a provider with pending agreements.** The point of E18: pending
  agreements no longer enter `ActiveEscrowCount`, so they cannot block
  `request_unstake`. What remains is a per-pair storage cost bounded by
  `MaxAgreementsPerPair`, each entry requiring ≥ `MinAgreementAmount` reserved.
  Strictly weaker than before this change.
- **Third party profits from expiring.** `expire_agreement` refunds the buyer of
  record and nobody else; the caller pays a fee and receives nothing. There is no
  bounty to farm.
- **Provider farms emissions via accept/reject churn.** None of
  `accept_agreement`, `reject_agreement`, `cancel_pending` or `expire_agreement`
  calls `add_era_escrow_volume`, so none moves `EraEscrowVolume`, the
  `MinQualifyingVol` floor, rank, or emissions weight.
  `e18e2_expire_agreement_is_permissionless_after_deadline` asserts
  `EraEscrowVolume == 0` after an expiry.
- **Provider escapes a commitment by rejecting late.** `reject_agreement` requires
  `ConsentState::Pending`, so it is unavailable once accepted.
- **Expiry races a provider that delivered.** Not prevented by refusing to expire
  delivered agreements — that was the original rule and it was the vulnerability
  (§8.1). It is prevented by WHEN expiry opens: each status waits for the
  buyer's own window and then `EXPIRY_GRACE` on top, so every door the provider
  or buyer could use is already open and has been open for at least the grace
  before a stranger can act. The payee is the buyer of record either way, so a
  racer gains nothing even if it wins.
- **`NextSeq` exhaustion by create/cancel churn.** `u32` behind the existing
  `SeqOverflow` guard, one tx fee per step; identical to the pre-existing
  create/`claim_refund` churn. Not a new surface.
- **Provider deregisters with pending agreements open.** It can (that is E18
  working). The buyer still exits via `cancel_pending`, or anyone via
  `expire_agreement`, whose `Pending` arm touches no count. No funds strand.

### 8.3 Supply cap and arithmetic

No new path mints, burns, or calls `on_unbalanced`: the only balance operation is
`unreserve`, which leaves `total_issuance` untouched.
`e18e2_expire_agreement_is_permissionless_after_deadline` asserts that directly.
Balance values are copied, never computed. The new arithmetic is BlockNumber
only, and all of it saturating — the amendment added two expressions beyond the
original one, so this paragraph listing "the one new expression" was stale:

```
Created    deliver_by.saturating_add(EXPIRY_GRACE.into())
Delivered  deliver_by.saturating_add(BuyerResponseWindow).saturating_add(EXPIRY_GRACE.into())
Disputed   dispute_opened_at.unwrap_or(created_at)
             .saturating_add(DisputeTimeoutWindow).saturating_add(EXPIRY_GRACE.into())
```

`unwrap_or(created_at)` is not new behaviour: `claim_refund` already resolves a
missing `dispute_opened_at` the same way, so expiry and refund agree on what a
`Disputed` agreement with no recorded open time means. Both
`ActiveAgreementCount` mutations use `saturating_sub`.
