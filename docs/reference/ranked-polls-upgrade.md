# RankedPolls shutdown and upgrade gate

Issue [#59](https://github.com/0pStack/Scalar-CommonsV5/issues/59) closes the
Technical Council's separate proposal path to Root. The selected fix disables
Instance2 submissions and gives it an empty track list. It retains RankedPolls
at pallet index 41, its existing storage, and its cancellation and refund calls.
Stake-based Referenda is unchanged.

This is a shutdown of an unsafe authorization path. It does not introduce a new
Council origin, electorate, voting curve, or power to enact privileged calls.
Any replacement Council governance requires a separate reviewed design.

## Why the old route is unsafe

At the pinned `polkadot-stable2503` SDK, ranked support is the unweighted number
of eligible aye voters divided by the eligible collective member count for the
poll class. It is not CMN voting power or total CMN issuance. Class 2 selects
members with rank at least 2. Reusing a stake track's support percentages for
this electorate therefore does not preserve its authorization threshold.

Before [PR #109](https://github.com/0pStack/Scalar-CommonsV5/pull/109), a funded
account outside the collective could propose a Root call while one rank-2
member could approve it as the entire eligible electorate. PR #109 rejects new
proposal origins but retains the old track table. This follow-up also rejects
submissions at the authorization guard and removes the legacy track table,
which otherwise lets an already stored Root poll progress. Submission and
decision deposits are recoverable funding friction, not an authorization
boundary.

## Required checks before upgrading an existing chain

Do not deploy the shutdown runtime until the following checks pass against
fresh finalized state. Pin every paginated query to the same finalized block
hash. This PR does not perform an on-chain upgrade or cancel any existing
governance decision automatically.

1. Enumerate `rankedPolls.referendumInfoFor` with paginated storage queries and
   record the checked block hash and current runtime version.
2. Resolve every `Ongoing` Instance2 referendum using the existing privileged
   `rankedPolls.cancel` call. After cancellation, the existing submission and
   decision deposit refund calls remain available to signed callers. Preserve
   records and refund rights; do not clear storage or slash deposits.
3. For every historical Instance2 `Approved` index, derive its Scheduler task
   name and inspect `scheduler.lookup`. Also paginate every `scheduler.agenda`
   entry, including overdue or incomplete agendas, and inspect each remaining
   task's `maybe_id`. A matching task in either storage blocks the upgrade until
   its ownership is resolved and the task is gone.
4. Confirmed ranked enactments must be cancelled through Scheduler before the
   upgrade. If Lookup is absent but the task remains in Agenda, cancel it by
   its task address rather than relying on named cancellation. For an ambiguous
   collision, inspect historical referendum and Scheduler events plus the
   scheduled call and preimage. A legitimate stake-based task must either
   execute first or be explicitly cancelled and
   re-proposed under an agreed governance decision. Never delete it based only
   on a matching referendum number.
5. Recheck that Instance2 has no `Ongoing` entries and that no candidate
   enactment name has an outstanding entry in either Scheduler Lookup or Agenda.
   Repeat the check at the upgrade boundary and abort if governance state
   changed after the snapshot.
   Keep the checked block hashes, resolutions, and task evidence with the
   operator's upgrade record.

The pinned SDK's enactment task name is Blake2-256 of the SCALE encoding of
`(*b"assembly", "enactment", index)`, where `index` is the `u32` referendum index.
The referenda instance is not included. Both Referenda and RankedPolls use the
same Scheduler, so their task names can collide.

An `Approved` record stores completion time and deposits but no longer retains
its proposal or execution origin. Current referendum storage alone cannot
prove ownership of every colliding scheduled task. This is why the upgrade
requires an operator gate rather than an automatic name-based deletion or an
unbounded scan inside `on_runtime_upgrade`.

Lookup absence alone is not a safe gate. The pinned Scheduler removes Lookup
before fetching or executing a task; an overweight task can remain in Agenda
for later execution. Checking only future blocks or only named Lookup entries
can therefore miss a pending Root call.

## Behavior after the shutdown

New RankedPolls submissions fail before deposits, counters, or alarms change.
No proposal origin, including Root, maps to an Instance2 track. Historical
records and encoded call indices remain intact; cancellation and deposit
refunds remain usable.

An outstanding legacy `Ongoing` poll cannot progress once its track is absent.
It would remain frozen until cancellation, which is why it must be resolved
before deployment. Removing a track cannot revoke a previously scheduled Root
call: the Scheduler already holds the actual proposal and its original origin.

No storage layout is changed, so no storage translation or bulk deletion is
introduced. The runtime specification version is bumped for the changed
consensus behavior. The pre-upgrade gate is still mandatory.

## Gaming-vector analysis

Disabling this path prevents outsiders from submitting ranked proposals and
prevents rank farming, a shrinking eligible electorate, or recoverable deposit
financing from converting ranked headcount into Root authority. There is no
new minting, reward weighting, deposit amount, threshold, or balance arithmetic.

The fix does not remove other Root-capable mechanisms. The separate whitelist
and collective-origin work for [#18](https://github.com/0pStack/Scalar-CommonsV5/issues/18)
is outside this change and is preserved. Stake-based governance and historical
refund rights are preserved.

## Pinned SDK evidence

- [Ranked tally and support denominator](https://github.com/paritytech/polkadot-sdk/blob/0c0d4ceba45a70f4e8dc40b1ee0cfae1fd759454/substrate/frame/ranked-collective/src/lib.rs#L131)
- [Scheduling approved proposals and task names](https://github.com/paritytech/polkadot-sdk/blob/0c0d4ceba45a70f4e8dc40b1ee0cfae1fd759454/substrate/frame/referenda/src/lib.rs#L899)
- [Concluded referendum records](https://github.com/paritytech/polkadot-sdk/blob/0c0d4ceba45a70f4e8dc40b1ee0cfae1fd759454/substrate/frame/referenda/src/types.rs#L302)
- [Scheduler Lookup removal before execution](https://github.com/paritytech/polkadot-sdk/blob/0c0d4ceba45a70f4e8dc40b1ee0cfae1fd759454/substrate/frame/scheduler/src/lib.rs#L1292)
- [Overweight task retention in Agenda](https://github.com/paritytech/polkadot-sdk/blob/0c0d4ceba45a70f4e8dc40b1ee0cfae1fd759454/substrate/frame/scheduler/src/lib.rs#L1254)
