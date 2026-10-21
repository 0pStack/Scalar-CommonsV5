# Atomic dispute settlement

Oracle finalisation and escrow settlement must either complete together or leave
all on-chain state unchanged. This fixes [#61](https://github.com/0pStack/Scalar-CommonsV5/issues/61)
and propagates the callback/payout errors described in
[#17](https://github.com/0pStack/Scalar-CommonsV5/issues/17).

## Transaction boundaries

The pinned FRAME version (`polkadot-stable2503`) wraps pallet dispatchable bodies
in a storage layer. Returning an error from oracle finalisation therefore rolls
back juror payments, accuracy scores, results, request/response deletion, counters,
events and callback storage writes.

`settle_dispute_from_oracle` is also a public Rust helper, not a dispatchable. It
has its own transaction so even a caller that catches its error cannot retain a
partial provider payment, treasury fee, agent volume/completion update, agreement
change or event. A storage-map `try_mutate` alone only protects that map's value.
Volume credit, including fallible rank promotion, precedes fund movement.

Every `repatriate_reserved`, `unreserve` and `slash_reserved` in escrow and oracle
must report a zero currency remainder. An error or a nonzero remainder aborts the
transaction instead of closing a partly funded agreement or request. Fee
imbalances are consumed or dropped inside that transaction, before rollback.

## Late results and repeated callbacks

A disputed agreement can legitimately time out before its oracle is finalised.
Its disappearance must not strand an already answered oracle request's juror
bounty. Callback behaviour is:

- An existing agreement must be `Disputed`; other live states return `WrongStatus`.
- A missing agreement with `seq < NextSeq(buyer, provider)` was previously issued
  and closed. Return success without payments, refunds, volume, counter/mapping
  changes or a second settlement event.
- Unknown pairs and sequences that were never issued return `AgreementNotFound`.

This relies on existing storage invariants: creation allocates monotonically
increasing sequence numbers with checked addition, failed creation rolls back the
allocation, no ordinary exit resets `NextSeq`, and numbers are never reused.
Migrations must preserve those invariants. Trusted Root storage edits remain
outside this guarantee.

## Gaming-vector review

- **Pay, fail, then refund:** a provider that is evicted or cannot be promoted
  cannot retain payment while leaving the agreement refundable. The entire helper
  and its oracle caller roll back on error.
- **Partial reserve payment:** short reserve operations cannot count as settlement
  or delete an obligation. Earlier payouts and fee issuance effects roll back.
- **Repeated verdict / opposite verdict:** a closed sequence is a no-op, even if
  another agreement for the same buyer/provider remains active. It cannot consume
  that agreement's backing or earn another completion/volume credit.
- **Premature callback:** an issued but pending, active or merely delivered
  agreement cannot be treated as a disputed agreement.
- **Failed oracle callback:** juror payouts and scores remain retryable and are
  applied once after the underlying error is resolved. A timed-out escrow permits
  finalisation without reopening its payment obligation.

Runtime spec version is 312 (after main's 311). No storage migration is needed.
No fee rates, reward weights, minting, privilege requirements, storage layouts,
call indices or event encodings change. The existing buyer timeout and
permissionless expiry remain available.

## Limits and separate work

These checks validate the amount actually moved by a currency operation. Reserves
are still pooled per account: a sufficiently large pool can mask which obligation
owns the funds. This is not reserve segregation or repair of historical deficits.
The double-reserved dispute bounty and recovery of previously stranded reserves
remain [#16](https://github.com/0pStack/Scalar-CommonsV5/issues/16).

A currency API remainder is different from integer-division dust when splitting
a bounty. Divisional dust, dispute-ID overwrite and the dispute completion-fee
policy remain [#34](https://github.com/0pStack/Scalar-CommonsV5/issues/34).
No historical state repair is performed by this change.

## Regression coverage

Unit tests cover the direct helper's eviction and late promotion failures,
treasury rollback, all escrow reserve exits, oracle callback writes and payout
failures, short bounty reserves, a successful retry, repeated verdicts, and
unknown/live sequences. State-root equality checks include balances, issuance,
agent storage, agreements, mappings, oracle state and events.

The integration test uses the real Oracle -> Escrow -> Agents bridge with two
agreements: a provider credit failure preserves the whole state; after timeout,
the oracle still finalises and pays jurors without paying the provider again or
releasing the second agreement's reserve. Builds and tests run in GitHub Actions.