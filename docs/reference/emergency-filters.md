# Emergency filters and supply-cap recovery

Issue [#60](https://github.com/0pStack/Scalar-CommonsV5/issues/60) wires the
runtime's emergency brakes into real call dispatch without making block
production depend on the current issuance being below the cap.

## Filter composition

The base filter is the intersection of the call-aware constitutional admission
check, SafeMode and TxPause. A call must pass all three. Ordinary nested
dispatch, including Utility batches, retains the origin's filters.

SafeMode and TxPause protect these recovery and coordination surfaces:

- All Timestamp, System, Sudo, SafeMode and TxPause calls.
- Referenda, ConvictionVoting, RankedCollective and Whitelist governance calls,
  preserving the existing SafeMode recovery policy.
- Emissions `settle_era`, `claim` and `batch_claim`.
- Orchestrator `claim_orchestrator`.
- NominationPools `claim_payout`, `claim_payout_other` and `claim_commission`.
- Staking `payout_stakers` and `payout_stakers_by_page`, subject to constitutional
  mint admission below.

Being whitelisted does not grant dispatch authority: the pallet still checks
its origin and other guards. A signed user cannot obtain Root from this list.
The claim and settlement exceptions keep economically essential operations
independent of an operator choosing to lift an emergency pause.

TxPause rejects attempts to pause protected names with `Unpausable`. Older
stored pauses for those names are ignored by the SDK's whitelist check; their
storage is not deleted. Review those records before any future whitelist
reduction. Other existing paused names start taking effect when this runtime
is installed, even if they were inert under the old filter.

## Cap checks belong on mint paths

An over-cap pre-state does not make every call unsafe. Timestamp inherents,
transfers, burns and recovery must still dispatch. The constitution canary
continues reporting a breach without halting the chain. Its historical
`SupplyCapBreachBlocked` event name is retained for encoding compatibility; it
reports detection and is not proof that a mutation was blocked.

The current native-CMN mint paths reachable by ordinary signed calls are:

| Path | Admission or mint guard |
|---|---|
| Emissions claim and batch claim | Actual deposit is clamped to remaining cap headroom inside the pallet. |
| Orchestrator claim | Actual deposit is clamped to remaining cap headroom inside the pallet. |
| Historical staking payout, either entry call | Admission checks a conservative payout bound before any claim marker, ledger mutation or deposit. |

Staking `EraPayout = ()` still prevents new era inflation. Previously booked
rewards remain claimable; this fix does not clear rewards or change their
storage, and it does not pretend those liabilities disappeared.

### Historical staking and rounding

The legacy payout admission bound is twice the recorded whole-era reward pot,
using checked multiplication. Overflow rejects admission. Zero-pot calls need
no headroom, including when issuance is already over the cap.

The whole era pot alone is not a strict bound on a page: the pinned SDK rounds
`Perbill * Balance` to nearest. A two-planck pot split into three equal shares
can mint three plancks. For consistent exposure snapshots, every rounded share
is at most twice its exact share; the exact own, nominator and commission shares
sum to at most the validator reward, which is at most the whole era pot. Twice
the pot therefore bounds a payout even for historical clipped exposures with
more recipients than the current page limit.

This is deliberately conservative. A small page can be refused even when its
actual payout would fit. Refusal happens before state changes, so its claim
marker, ledger and beneficiary balances remain intact. A caller can retry when
headroom exists; normal staking history expiry still applies. There is no
partial payout or adapter that silently discards an unpaid reward.

Both external payout entry calls are checked. The pinned StakingInterface has
no separate payout method; nomination pools do not expose an internal bypass.
After each completed nested payout, the next normal dispatch checks headroom
again. Transaction fees remain an outstanding Credit until post-dispatch, so
admission does not spend headroom from an anticipated fee burn.

## Privileged trust boundary

FRAME Root dispatch bypasses BaseCallFilter. Root balance/issuance mutation,
`system.set_storage`, `system.set_code` and genesis construction are therefore
not constrained by this admission filter. This change does not claim otherwise.
A privileged over-mint or malformed genesis must remain recoverable rather than
making the next mandatory inherent fail. Production genesis allocations and
Root authority require their separate deployment reviews.

## Upgrade and verification

The specification version advances to 311; transaction version and existing
storage/call encodings stay unchanged. No storage translation is introduced.
Before upgrading, inspect SafeMode state and all paused call names: previously
inert noncritical pauses will start enforcing immediately. Preserve an
operational recovery signer and review the exact built runtime artifact.

Follow [the operator verification procedure](https://github.com/0pStack/Scalar-CommonsV5/blob/main/deploy/public/VERIFY.md#g-emergency-filters-enforce-calls-and-preserve-recovery).
A stored pause flag or a successful pause extrinsic alone is insufficient:
verify that an ordinary signed call is rejected, cleanup restores it, blocks
continue, and recovery remains available. Test over-cap states only in isolated
Executive regression fixtures, never by deliberately over-minting a live chain.

## Gaming-vector analysis

- Wrapping a paused call in ordinary Utility dispatch does not bypass the
  inherited filter. Root bypass is explicit and remains trusted.
- Protected claims and settlement cannot be turned into operator-controlled
  liveness gates by TxPause or SafeMode.
- Near-cap historical claims cannot consume rounding headroom beyond the
  conservative bound; admission occurs before reward markers or funds move.
- The shared cap still makes remaining headroom order-dependent across claim
  paths. This fix adds no new reward weighting, issuance entitlement, payout
  priority or economic constant.
- Existing reward records are preserved. The conservative legacy bound can
  delay a payout and does not extend its staking history lifetime; this tradeoff
  is preferred to forfeiting rewards through a currency adapter after marking
  a page claimed.
- Breached issuance no longer gives an attacker an additional chain-wide halt
  through the next timestamp inherent. It still triggers the canary and requires
  operator investigation and recovery.

## Pinned SDK references

- [Staking payout implementation](https://github.com/paritytech/polkadot-sdk/blob/0c0d4ceba45a70f4e8dc40b1ee0cfae1fd759454/substrate/frame/staking/src/pallet/impls.rs)
- [Perbill multiplication and rounding](https://github.com/paritytech/polkadot-sdk/blob/0c0d4ceba45a70f4e8dc40b1ee0cfae1fd759454/substrate/primitives/arithmetic/src/per_things.rs)
- [Transaction fee Credit lifetime](https://github.com/paritytech/polkadot-sdk/blob/0c0d4ceba45a70f4e8dc40b1ee0cfae1fd759454/substrate/frame/transaction-payment/src/payment.rs)
