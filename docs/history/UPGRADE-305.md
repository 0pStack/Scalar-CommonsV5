# UPGRADE-305.md — runtime upgrade to spec 305

**Date:** 2026-09-09
**Issues:** #120 (I-2, staking mints outside the supply cap), #136 (I-20, forkless upgrade never rehearsed)
**Outcome:** **Part 1 complete and merged. Part 2 ABORTED at the apply step.**

> **Status in one line:** the code is on `master`, the wasm is built and verified as spec 305, and
> the upgrade **was not applied** — the extrinsic was rejected at submission because the rotated
> sudo account holds **0 CMN** and cannot pay a transaction fee. The chain is untouched and healthy.

---

## ABORT — what stopped it

```
RPC-CORE: submitAndWatchExtrinsic(extrinsic: Extrinsic): ExtrinsicStatus::
  1010: Invalid Transaction: Inability to pay some fees , e.g. account balance too low
FATAL: 1010: Invalid Transaction: Inability to pay some fees , e.g. account balance too low
APPLY_EXIT=1
```

That is verbatim. The round's abort rule — *"ABORT and report if the extrinsic fails"* — fired, so
nothing was retried and nothing was weakened to get around it.

### Root cause

```
operator (Sudo::Key)   5DFASjqmCBrMfRsHDzQyXGodfWL4Bj1uK6X2U3jBEEoPh8ZN
  free     : 0.0000 CMN
  reserved : 0.0000 CMN
  nonce    : 0   providers: 0
existentialDeposit : 0.0100 CMN
```

**The account does not exist on chain.** `sudo.sudo` dispatches with `paysFee: No`, but that is a
*post-dispatch* property. The `ChargeTransactionPayment` signed extension runs in
`validate_transaction`, **before** the call is ever dispatched, and it requires the signer to cover
the estimated fee. A zero-balance, zero-provider account fails that check and the extrinsic never
enters the pool.

**This is a defect introduced by the sudo rotation in the previous round (#119), not by this one.**
Root was moved to a freshly generated key and that key was never funded, so **root has been unusable
for any fee-bearing call since the rotation**. The rotation itself was correct and is not in
question — the account was verified to control the key, and `Sudo::Key` is genuinely no longer
`//Alice`. What was missed is that holding root is not the same as being able to *use* it. Nothing
in that round exercised root afterwards, which is exactly why it went unnoticed.

### What unblocks it

Fund the operator account above the existential deposit plus a fee margin. `//Alice` still holds
1 000 047 364.88 CMN free and is now an ordinary account:

```bash
# not run — this moves tokens on a live chain and was not in this round's scope
node -e "..."   # balances.transferKeepAlive(5DFASj…Ph8ZN, 1_000 CMN) signed by //Alice
```

Then re-run step 4 of `deploy/upgrade.md` unchanged. Everything else is already verified and in
place. I did not do this myself: moving balances is a different class of action from the one
authorised here, and the round's own abort rule says to stop and report.

---

## Part 1 — merged

**PR [#147](https://github.com/tejaspatil1936/scalar-commons-v4/pull/147)**, squash-merged to
`master` as `36b7468` after all six required checks passed.

| check | result |
|---|---|
| gate | pass (19m24s) |
| full | pass (19m8s) |
| landing / faucet / docs / sdk | pass |

### The change

`type EraPayout` on `pallet_staking::Config` moves from `ConvertCurve<RewardCurve>` to `()`.
`spec_version` 304 → 305. No storage layout change, no migration.

### Three defects caught before merge

Two were in my own first commit; the tokenomics-security-reviewer pass CLAUDE.md requires found the
first two.

1. **The staking era is 18 hours, not 6.** `ERA_BLOCKS` is six hours, but that is the *emissions*
   era. A *staking* era is `SessionsPerEra` (6) × `EpochDuration` (`ERA_BLOCKS/2` = 3h) = **18h**.
   My tests passed a six-hour duration, understating the payout they asserted against by 3×.
   Corrected — and the corrected figure is corroborated by the chain itself: the negative control
   computes **310 780.84 CMN** per era, and the chain's actual booking for era 45 is
   **312 187.07 CMN**.

2. **"pallet-emissions is the only mint path" is still false after 305**, and I had written it into
   both published docs pages as though 305 made it true. `pallet-orchestrator` mints directly at
   `pallets/orchestrator/src/lib.rs:659`. It *is* cap-gated, so the cap held — but that sentence is
   the same class of published falsehood this audit exists to catch. Both pages now state the
   accurate invariant, "every mint site is cap-gated", with all three sites tabulated and the one
   ungated path marked.

3. **`apply-upgrade.mjs` would have rejected the correct file.** Its magic-number guard accepted
   only raw wasm, but the blob you submit is zstd-wrapped (`0x52bc5376…`). Caught by dry-running
   against the blob pulled from on-chain `:code` before the new one existed. Had this not been
   caught, the real apply would have aborted at the last step with a misleading error.

The reviewer also reported a clippy `unnecessary_cast` failure on the test casts. Checked rather
than accepted: `clippy --workspace --all-targets -- -D warnings` is clean. That finding was wrong.

### Tests, and proof they aren't vacuous

The runtime crate had **no tests at all** before this. Four now run against the real `Runtime`, so
they exercise the concrete `u128` Balance that `tests/common.rs` cannot. Reverting the Config type:

```
test tests::era_payout_is_zero_at_live_values ... FAILED
test tests::era_payout_is_zero_across_the_stake_curve ... FAILED

assertion `left == right` failed
  left: (310780843101823000, 932305568321469000)
 right: (0, 0)
```

310 780.84 CMN of payout plus 932 305.57 CMN of remainder — **1 243 086.41 CMN per staking era**.

---

## Part 2 — what completed before the abort

### Build ✅

```
Finished `release` profile [optimized] target(s) in 6m 25s
```

```
file       : target/release/wbuild/scalar-commons-runtime/scalar_commons_runtime.compact.compressed.wasm
bytes      : 1 153 409
blake2-256 : 0xdc0855f41037a8dbc681d4c26e34ff854b8f0509a166ade5fce4b5542025e058
```

### Embedded spec_version gate ✅

Read from the blob's `runtime_version` custom section, not from `lib.rs`:

```
spec_name       : scalar-commons
spec_version    : 305
OK — embedded spec_version is 305.
```

### Rollback point ✅

`~/upgrade-backup/20260909T071446Z/`

| artefact | detail |
|---|---|
| `code-before.wasm` | the live on-chain `:code`, 1 158 717 bytes, **verified spec 304** |
| `finalized-head.json` / `finalized-header.json` | head **#526694** |
| `scalar-local-raw.json` | committed chainspec |
| `eve-20260909T071409Z.tar.zst` | 1.1 GB database snapshot |

The database snapshot was taken on **eve, not alice** — `deploy/snapshot.sh` stops and starts the
node it snapshots, and doing that to alice would have reset the uptime that verification (b) depends
on. Baselines were recorded after eve came back, so the "nothing restarted" evidence covers the
upgrade window cleanly. The rollback path for a runtime upgrade is `code-before.wasm`, not the
database; `deploy/upgrade.md` explains why and when each applies.

### Dry run ✅ — the signer gate passed

```
signer              : 5DFASjqmCBrMfRsHDzQyXGodfWL4Bj1uK6X2U3jBEEoPh8ZN
on-chain Sudo::Key  : 5DFASjqmCBrMfRsHDzQyXGodfWL4Bj1uK6X2U3jBEEoPh8ZN
signer is root      : YES

inner call hash     : 0x9255514767d749136b29311ac5ff04d3875f7c06659ab1a46ae86225650a9a34
outer call hash     : 0xc571f69122ce61701b9bf0f710afadf7161075f33df98069721d1437be988934
```

Matches the address the round required. **The dry run cannot detect the fee problem** — it never
submits, so it never runs `validate_transaction`. Worth adding a balance precondition to the script;
noted below.

### Apply ❌ — aborted, see above

---

## Chain state after the abort — unchanged and healthy

### specVersion, all five ports

```
port 9944  specVersion 304
port 9945  specVersion 304
port 9946  specVersion 304
port 9947  specVersion 304
port 9948  specVersion 304
```

### Nothing restarted

```
alice    NRestarts=0  Mon 2026-08-03 19:19:17 CEST
bob      NRestarts=0  Wed 2026-09-02 20:44:17 CEST
charlie  NRestarts=0  Wed 2026-09-02 20:44:37 CEST
dave     NRestarts=0  Wed 2026-09-02 20:44:57 CEST
eve      NRestarts=0  Wed 2026-09-09 09:14:32 CEST   (the snapshot, before the apply attempt)
```

Byte-identical to the pre-apply baseline.

### Blocks producing and finalizing — two samples 11s apart

```
[07:46:07Z]  alice best=527010 final=527008   bob best=527010 final=527008   charlie best=527010 final=527008   dave best=527010 final=527008   eve best=527010 final=527008
[07:46:18Z]  alice best=527012 final=527009   bob best=527012 final=527009   charlie best=527012 final=527009   dave best=527012 final=527009   eve best=527012 final=527009
```

### `:code` still equals genesis

```
head    :code hash  0x1a978681b5c7bba350dcb8bb292fdeefba94dc4cc5fb9cd88972e3f64a3da1f8
genesis :code hash  0x1a978681b5c7bba350dcb8bb292fdeefba94dc4cc5fb9cd88972e3f64a3da1f8
```

Identical — confirming directly that **no upgrade was applied**. This is also the assertion #136
turns on: it goes GREEN only when these two differ.

---

## Verification (a)–(d) — status

| | check | status |
|---|---|---|
| a | specVersion 305 on all five ports | ❌ all report 304 — not applied |
| b | no node restarted | ✅ uptimes identical to baseline (vacuous — nothing was applied) |
| c | blocks producing and finalizing | ✅ two samples, both advancing |
| d | no `staking.EraPaid` with non-zero `validator_payout` after the next era boundary | ⏳ **not yet checkable** |

**#136 is NOT closed.** (a) fails, so the forkless upgrade still has not been rehearsed. That is the
honest state.

**On (d):** the next staking era boundary is **block ~529143**, about 4 hours out at the time of the
attempt — over the 2-hour threshold, so it was to be a noted re-check rather than a wait. It is now
moot until the upgrade actually applies. Once it does, re-check at the first era boundary after the
apply block.

---

## Live figures, measured today

These have moved since the audit and the docs still quote the audit's numbers:

| | audit (2026-09-08) | today (2026-09-09) |
|---|---|---|
| `ErasValidatorReward` entries | 47 | **48** |
| sum | 14 623 530.33 CMN | **14 935 812.93 CMN** |
| `ClaimedRewards` keys | 0 | **0** — still nobody has claimed |
| `TotalIssuance` | 6 053 831 090.07 CMN | **6 054 761 778.23 CMN** |

The liability grows by roughly **312 000 CMN every 18 hours** until spec 305 is actually applied.
Each hour of delay is measurable.

---

## Follow-ups this round produced

1. **Fund the operator account** — the only thing blocking the upgrade. Not done here; see above.
2. **`apply-upgrade.mjs` should refuse early on an unfunded signer.** The dry run reported "signer
   is root: YES" and gave no hint the call could not be paid for. A balance-vs-estimated-fee check
   in the preflight would have caught this before the build, not after.
3. **Docs snapshot refresh after the upgrade.** `docs/scripts/check-chain-values.mjs` pins the docs
   to a committed snapshot, and `token-model.md:404` carries the literal `spec 304`. Once the chain
   is on 305 those become false and need `npm run snapshot:chain`.
4. **Update the audit-derived figures in the docs** to the measured values above, with a date.
5. **#119 should record that rotating root to an unfunded key made root unusable.** The rotation is
   sound; the omission is that nothing exercised root afterwards.

---
---

# RESUMED — 2026-09-09, second attempt: **APPLIED**

The block above stands as the record of the first attempt. This section is what happened after
the operator account was funded.

## 1. Funding the operator ✅

`balances.transferKeepAlive(5DFASj…Ph8ZN, 10 000 CMN)` signed by `//Alice`:

```
operator BEFORE : 0.0000 CMN  providers=0
call hash       : 0x34c9d4fc0e28815df14fc1dcd05aafa933e0c91690b570f3aa84380dffe732bf
event           : system.NewAccount {"account":"5DFASjqmCBrMfRsHDzQyXGodfWL4Bj1uK6X2U3jBEEoPh8ZN"}
event           : balances.Endowed  {"freeBalance":"10,000,000,000,000,000"}
event           : balances.Transfer {"from":"5Grwva…KutQY","to":"5DFASj…Ph8ZN","amount":"10,000,000,000,000,000"}
event           : system.ExtrinsicSuccess
finalized in    : 0xa80059ac41384e9f4e18e54dee6d10b8139cd2de402559f58a36cac6e2896cc0  (#527265)

operator AFTER  : 10000.0000 CMN   nonce: 0   providers=1
```

`system.NewAccount` confirms the account genuinely did not exist before — which is exactly why the
first attempt could not pay a fee.

## 2. Preflight fix ✅

`scripts/apply-upgrade.mjs` now queries the signer's free balance and `paymentInfo`'s estimate and
refuses **before submitting** if `free < fee + existential deposit`. It runs in `--dry-run` too,
because that is the mode where you want to find out.

The subtlety it encodes: `sudo.sudo` dispatches `paysFee: No`, but that is *post-dispatch*.
`ChargeTransactionPayment` runs inside `validate_transaction`, **before** the call is dispatched, and
still requires the signer to cover the estimated fee. A `paymentInfo` call that throws — what a
non-existent account does — is treated as a zero estimate so the comparison still refuses, never as
"no fee required".

Dry run after the fix:

```
signer free balance : 10000.0000 CMN
estimated fee       : 0.0001 CMN
existential deposit : 0.0100 CMN
required (fee + ED) : 0.0101 CMN
can pay             : YES

DRY RUN — nothing submitted. The chain is unchanged.
```

## 3. Apply ✅

Same wasm as the first attempt — rebuilt nothing, re-verified the hash and embedded version first:

```
blake2-256          : 0xdc0855f41037a8dbc681d4c26e34ff854b8f0509a166ade5fce4b5542025e058   (matches)
embedded spec_version: 305                                                                 (matches)
```

```
call                : sudo.sudo(system.setCode(<wasm>))
inner call hash     : 0x9255514767d749136b29311ac5ff04d3875f7c06659ab1a46ae86225650a9a34
outer call hash     : 0xc571f69122ce61701b9bf0f710afadf7161075f33df98069721d1437be988934

events              : balances.Withdraw, system.CodeUpdated, sudo.Sudid,
                      balances.Deposit, transactionPayment.TransactionFeePaid,
                      system.ExtrinsicSuccess
finalized in        : 0x0d951e7493a16e18a19ea34ebd88f2d9a67f1afef172a1a7ec4e44f133965795
APPLIED AT BLOCK    : #527277

  port 9944: specVersion 305
  port 9945: specVersion 305
  port 9946: specVersion 305
  port 9947: specVersion 305
  port 9948: specVersion 305

OK — all 5 nodes report specVersion 305.
```

All five switched within the same polling pass, far inside the 20-block budget.

## 4. Verification

### (a) specVersion 305 on all five ports ✅

```
port 9944  specVersion 305
port 9945  specVersion 305
port 9946  specVersion 305
port 9947  specVersion 305
port 9948  specVersion 305
```

### (b) NRestarts unchanged on all five ✅

```
alice    NRestarts=0  Mon 2026-08-03 19:19:17 CEST
bob      NRestarts=0  Wed 2026-09-02 20:44:17 CEST
charlie  NRestarts=0  Wed 2026-09-02 20:44:37 CEST
dave     NRestarts=0  Wed 2026-09-02 20:44:57 CEST
eve      NRestarts=0  Wed 2026-09-09 09:14:32 CEST
```

Byte-identical to the snapshot taken immediately before submitting. **alice has been up since
2026-08-03 — 37 days — straight through the upgrade.** That is what forkless means, and it is now
demonstrated rather than asserted. (eve's later timestamp is the pre-upgrade database snapshot,
hours earlier, not a restart caused by the upgrade.)

### (c) Two finality samples 12s apart ✅

```
[08:13:14Z]  alice best=527281 final=527279   bob best=527281 final=527279   charlie best=527281 final=527279   dave best=527281 final=527279   eve best=527281 final=527279
[08:13:35Z]  alice best=527284 final=527282   bob best=527284 final=527282   charlie best=527284 final=527282   dave best=527284 final=527282   eve best=527284 final=527282
```

Both best and finalized advanced on all five, in lockstep.

### `:code` vs genesis — they now differ ✅

```
head    :code hash  0xdc0855f41037a8dbc681d4c26e34ff854b8f0509a166ade5fce4b5542025e058
genesis :code hash  0x1a978681b5c7bba350dcb8bb292fdeefba94dc4cc5fb9cd88972e3f64a3da1f8
```

This is the assertion that had never been true. Before today the on-chain `:code` at the finalized
head was byte-identical to genesis, which is what proved the five earlier "bumps" (300 → 304) were
compiled into fresh geneses rather than applied.

**The head `:code` hash is exactly the blake2-256 of the blob that was built and submitted**, so the
code now running is provably the artefact from `cargo build --release` on `36b7468` — not something
that merely claims to be.

### (d) — outstanding

**Re-check at block ~529143**, the start of staking era 49 and the first era boundary after the apply
block:

```
head block  527287     CurrentEra 48     session 292  (era 48 started at session 288)
era 49 starts at session 294 = 2 sessions away  =>  ~529143, about 3.1 hours out
```

Assert there is no `staking.EraPaid` event carrying a non-zero `validator_payout`. A staking era is
18 h (`SessionsPerEra` 6 × `EpochDuration` 3 h), not the six-hour emissions era — which is why this
is hours away rather than minutes.

### Dependent services survived the metadata change ✅

A spec bump changes the runtime metadata, and the indexer, explorer and faucet all hold long-lived
`@polkadot/api` connections. None of them needed restarting:

```
scalar-indexer     active  NRestarts=0
scalar-explorer    active  NRestarts=0
scalar-faucet      active  NRestarts=0

indexer sees spec 305 | synced 527321 | finalized 527321
```

The indexer picked up the new metadata on its own and stayed in sync through the switch. Worth
recording because it was a real risk and `deploy/upgrade.md`'s ROLLBACK section warns that a
*downgrade* would need them restarted — that asymmetry now has evidence behind one half of it.

## 5. Issues

- **#136 CLOSED.** (a), (b) and (c) all pass. ENDGOAL §3.1's forkless-upgrade requirement is met.
- **#120 open**, commented with the apply evidence and the block at which to re-check (d). It also
  stays open for the two residues: `payout_stakers` is the one live staking mint path left and has
  no cap check at its own call site, and the ~14.9 M CMN booking expires as those eras fall outside
  `HistoryDepth`.
- **#119** was commented earlier with the root cause of the first failure — rotating root to an
  unfunded key made root unusable, and nothing exercised root afterwards to notice.

## 6. Docs — PR #148

Snapshot regenerated (spec **305** @ #527298), the three `spec 304` literals the snapshot check does
not reach corrected, and every audit-era figure re-measured and dated:

| | audit (2026-09-08) | measured 2026-09-09 |
|---|---|---|
| `TotalIssuance` | 6 053 831 090.07 CMN | **6 054 761 778.23 CMN** |
| minted by staking | 43 581 090 CMN | **44 511 778 CMN** |
| `ErasValidatorReward` | 47 entries | **48 entries** |
| sum | 14 623 530.33 CMN | **14 935 812.93 CMN** |
| `ClaimedRewards` | 0 keys | **0 keys** |
| staking path total | ~58.2 M CMN | **~59.4 M CMN** |

Those figures are now frozen: the upgrade stopped new bookings.

`docs lint` 0 errors against the spec-305 snapshot; `docs build` clean.

**PR #148 merged** to `master` as `b26e4f7` after all six required checks passed (gate 19m5s,
full 20m20s, landing / faucet / docs / sdk green).

## What this round cost, and what it bought

Two attempts. The first failed on a precondition nobody had checked — root had been rotated to an
account that could not pay a fee, and had been unusable since. The second succeeded, and the
mechanism that caught the first failure is now a preflight that runs before the build's worth of
time is spent.

The chain has upgraded itself in place for the first time. Staking inflation is off as of block
#527277.
