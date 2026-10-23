# Runtime 315 upgrade gate

Runtime specification 315 ships the quick-fix security bundle from issue
[#19](https://github.com/0pStack/Scalar-CommonsV5/issues/19). It appends
`pallet-proxy` at index 43, enables BABE and GRANDPA equivocation reporting,
blocks `sudo_as`, pauses automatic rank-3 promotion, and repairs stale
ranked-collective membership.

The bundle was first planned for spec 313. It ships at 315, after the Polkadot SDK move
(313) and the F14 oracle quorum change (314); see the version notes in
`runtime/src/lib.rs:240-249`. This page keeps its original file name so existing links
still resolve.

## Before the upgrade

Complete the
[RankedPolls shutdown gate](ranked-polls-upgrade.md) against fresh finalized
state. Every ongoing Root-origin RankedPolls referendum must be cancelled, and
every already scheduled RankedPolls enactment must be identified and removed
through Scheduler. Keep the checked block hashes and transaction evidence with
the release record. Abort the upgrade if governance state changes after the
final check.

F02, F05, and the rank-based cancel and whitelist restrictions are already part
of the runtime being upgraded. Runtime 315 does not duplicate their storage or
call changes.

## During the upgrade

The single-block migration enumerates ranked-collective members and removes
only accounts that no longer have an `agents.agentStake` entry. This covers
agents that completed unstaking or were fully slashed before the collective
cleanup fix. Registered agents retain their existing rank. The migration is
idempotent.

Monitor the upgrade block for migration weight and block execution errors.
After finalization, verify that every remaining collective member has an agent
stake and that the expected validator set remains live.

## Protecting the sudo account with a delay

The upgrade provides the proxy mechanism but does not modify the sudo key or
create a proxy automatically.

1. Fund the intended delegate for announcement deposits.
2. From the sudo account, add the delegate with proxy type `Governance` and the
   agreed non-zero block delay.
3. Announce a harmless sudo call, wait the full delay, and execute it with
   `proxyAnnounced`.
4. Record and review the proxy definition on chain before changing operational
   custody of the sudo key.

`Governance` allows the existing privileged governance and recovery calls.
All proxy types reject `sudo_as`; wrapper calls cannot use a proxy to restore
that impersonation path.

## Gaming-vector analysis

Proxy deposits reserve existing CMN and create no mint, burn, reward, or supply-cap
path. The base and per-item deposits make unbounded proxy and announcement state
costly, while the configured limits cap both lists at 32 entries per account.
A delegate cannot use `NonTransfer` or `Governance` to grant itself a broader
proxy type. Every proxy type also preserves the `sudo_as` ban, including calls
nested in Utility.

The delayed `Governance` proxy does not gain authority beyond the sudo account
that created it. Its announcement delay gives operators time to inspect and
reject an unexpected privileged call. An `Any` proxy remains equivalent to
delegating all signed powers of the real account and must be treated accordingly.

Pausing automatic rank-3 promotion prevents new agents from receiving the rank-3
reward multiplier and collective standing until F03 fixes that threshold. It
does not demote existing members or rewrite earned balances. This is the intended
temporary economic tradeoff in issue #19. Setting the runtime threshold above
the oracle's hard 10,000-point maximum keeps the brake explicit and reversible
in a later specification upgrade.

Equivocation reporting routes provable BABE and GRANDPA offences through the
existing offence and staking systems. Reports require historical key-ownership
proofs; arbitrary unsigned reports cannot slash a validator.
