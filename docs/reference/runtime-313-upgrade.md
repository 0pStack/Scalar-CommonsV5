# Runtime 316 upgrade gate

Runtime specification 316 ships the quick-fix security bundle from issue
[#19](https://github.com/0pStack/Scalar-CommonsV5/issues/19). It appends
`pallet-proxy` at index 43, enables BABE and GRANDPA equivocation reporting,
filters top-level `sudo_as`, narrows the `Governance` proxy, and pauses automatic
rank-3 promotion.

The bundle was first planned for spec 313 and first built as spec 315, after the
Polkadot SDK move (313) and the F14 oracle quorum change (314). Spec 315 was never
enacted. 316 is 315 with the corrections from
[#125](https://github.com/0pStack/Scalar-CommonsV5/issues/125) and
[#126](https://github.com/0pStack/Scalar-CommonsV5/issues/126); see the version
notes in `runtime/src/lib.rs`. This page keeps its original file name so existing
links still resolve.

## Before the upgrade

Complete the
[RankedPolls shutdown gate](ranked-polls-upgrade.md) against fresh finalized
state. Every ongoing Root-origin RankedPolls referendum must be cancelled, and
every already scheduled RankedPolls enactment must be identified and removed
through Scheduler. Keep the checked block hashes and transaction evidence with
the release record. Abort the upgrade if governance state changes after the
final check.

Rehearse the upgrade against live state with `try-runtime ... on-runtime-upgrade
--checks all` (see [#123](https://github.com/0pStack/Scalar-CommonsV5/issues/123)).
Runtime 316 runs no migration of its own, so the rehearsal must confirm that every
pallet's on-chain storage version already matches the version in code.

F02, F05, and the rank-based cancel and whitelist restrictions are already part
of the runtime being upgraded. Runtime 316 does not duplicate their storage or
call changes.

## During the upgrade

Runtime 316 runs no migration. Monitor the upgrade block for execution errors and
confirm after finalization that the expected validator set remains live.

## After the upgrade

Do these in order. The orphan cleanup needs Root several times, so finish it while
the sudo key can still sign directly; after the key moves behind a delay, every
removal waits out that delay.

### 1. Remove orphaned collective members

Before the collective bridge learned to clean up, agents that finished unstaking
or were fully slashed kept their ranked-collective membership. Such an orphan has
no power today: rank-based origins are not wired to any call, and emissions apply
rank only to staked agents. The harm is that it cannot register again, because
registration inducts the account into the collective and that fails for an
existing member.

On chain an orphan looks exactly like a member Root added on purpose, for example
a Technical Council member, so the runtime does not guess. The operator removes
the orphans by hand:

1. List every `rankedCollective.members` entry and keep those with no
   `agents.agentStake` entry.
2. Review that list and drop every account that was added to the collective on
   purpose. Record the reviewed list with the release record.
3. For each remaining account, submit `rankedCollective.removeMember(who, rank)`
   as Root, with `rank` equal to the member's current rank.
4. Confirm each `MemberRemoved` event and that every remaining member either has
   an agent stake or is on the reviewed keep list.

### 2. Put the sudo key behind a delay

A delayed proxy only binds the sudo key when nobody holds a private key for the
sudo account. The procedure moves sudo to a keyless pure proxy. Rehearse the whole
path before the irreversible step:

1. Fund the delegate account for the pure-proxy and announcement deposits.
2. From the delegate, call `proxy.createPure(Governance, delay, 0)` with the
   agreed non-zero block delay. Read the new account from the `PureCreated` event
   and confirm the delay with `proxy.proxies(<pure account>)`.
3. Fund the pure account, then rehearse: announce a harmless call the pure
   account can make on its own, such as `preimage.notePreimage` with a small
   payload, wait the full delay, and execute it with `proxy.proxyAnnounced`.
   Confirm the `ProxyExecuted` event reports success.
4. Only then, from the current sudo key, call `sudo.setKey(<pure account>)`.
   This cannot be undone with the old key. If the delegate cannot act, the only
   way back to Root is a Root-track referendum, which takes at least 22 days.
5. Confirm that the old key now gets `RequireSudo` on `sudo.sudo`, then announce,
   wait out and execute one harmless `sudo.sudo` call. Record the block numbers
   with the release record.

The delegate key now controls Root. If it is lost, Root is lost until a
referendum restores it. If it is stolen, the thief gets Root after the delay.
Keep it in custody that matches that.

## What the sudo key can do

The sudo key is full Root. No call filter constrains it:

- `sudo` dispatches its inner call with `dispatch_bypass_filter`, so filters never
  see what is wrapped inside it.
- `sudo_as`, `set_key` and `remove_key` accept a Root origin, so
  `sudo(sudo_as(..))` impersonates any account and `sudo(set_key(..))` moves the
  key.
- Root can also call `utility.dispatchAs`, `balances.forceTransfer`,
  `balances.forceSetBalance`, `system.setStorage` and `system.setCode`.

The `sudo_as` filter only rejects `sudo_as` as a top-level call, and the
`Governance` proxy exclusions only apply to the call the delegate submits.
`Governance` allows `sudo.sudo` but not `sudo.setKey`, `sudo.removeKey` or
`sudo.sudoUncheckedWeight` as direct calls, and every proxy type rejects
`sudo_as`. A delegate can still reach all of them through `sudo.sudo`. Treat the
filters as guard rails against mistakes, not as limits on Root.

## What the delay does and does not give

Once the key sits on the pure proxy, every Root action has to be announced and
then wait out the delay. That is a notice period, not a veto:

- **An announcement shows only a call hash.** Observers learn that some Root
  call is coming, not which one, until it executes. Operator rule: publish the
  full call data alongside every announcement so anyone can check it against the
  hash.
- **Announcements do not expire.** Up to 32 can be pending at once. Each hash
  waits out the delay once and can then be executed at any later time, so a
  delegate can stockpile approved calls. Watch `proxy.Announced` events and the
  `proxy.announcements` storage, and treat an unexplained announcement as an
  incident.
- **Nobody can simply reject an announcement.** A pure proxy cannot sign, so
  `proxy.rejectAnnouncement` is out of reach except through Root itself, which
  is behind the same delay, or a Root-track referendum, which takes at least 22
  days. A delay shorter than that leaves only social and operational responses,
  such as validators declining a runtime they do not accept. The delegate can
  withdraw its own announcement with `proxy.removeAnnouncement`.

## Gaming-vector analysis

Proxy deposits reserve existing CMN and create no mint, burn, reward, or supply-cap
path. The base and per-item deposits make unbounded proxy and announcement state
costly, while the configured limits cap both lists at 32 entries per account.
A delegate cannot use `NonTransfer` or `Governance` to grant itself a broader
proxy type, and `Governance` cannot call the proxy pallet at all, so it cannot
add a zero-delay proxy on the pure account without first waiting out the delay.

The sudo key remains a single point of control over issuance: Root can mint up to
and past the supply cap through `balances.forceSetBalance` or `system.setStorage`.
The delay makes such a call announced before it executes; it does not prevent it,
and the hash alone does not reveal it. Removing that power requires retiring sudo
in favour of governance, which is outside this upgrade. An `Any` proxy remains
equivalent to delegating all signed powers of the real account and must be
treated accordingly.

Pausing automatic rank-3 promotion prevents new agents from receiving the rank-3
reward multiplier and collective standing until F03 fixes that threshold. It
does not demote existing members or rewrite earned balances. This is the intended
temporary economic tradeoff in issue #19. Setting the runtime threshold above
the oracle's hard 10,000-point maximum keeps the brake explicit and reversible
in a later specification upgrade.

Removing orphaned collective members by hand changes no balance, reward weight or
vote: rank-based origins are not wired to any call today. Keeping an orphan only
keeps that account from registering again; removing a member wrongly takes away
collective standing that Root can restore by adding it back.

Equivocation reporting routes provable BABE and GRANDPA offences through the
existing offence and staking systems. Reports require historical key-ownership
proofs; arbitrary unsigned reports cannot slash a validator.
