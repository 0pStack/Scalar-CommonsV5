# Runtime 309 applied to prod — the record

**Applied 2026-10-05.** Every figure below was read back from the chain after
the fact, not copied from the build or from the apply log.

## What was applied

| | |
|---|---|
| spec_version | **309** (from 307) |
| transaction_version | **1**, unchanged — correct, no existing call changed |
| apply block | **#907929** |
| block hash | `0x4e4740eee241dbcb704d6a2aae204ef5a3754cfff2ca6a7569907f66f07763e4` |
| block timestamp | **2026-10-05T18:41:24.000Z** |
| extrinsic | `0xc3b1f6d9…6b9f` |
| on-chain `:code` size | 1,190,997 bytes |
| **`:code` sha256** | `699238c48e7b5fc7af0eda967a29a71cf10fefa1920a40e501e0e9509f7590c2` |
| **`:code` blake2_256** | `0x52a404fd85f4996734fe284cad00de70f6debbf03210cd434669f765df9e6292` |
| rollback | **NOT USED** |

### The blob on prod is byte-identical to the one that was rehearsed

The `:code` read back from block #907929 hashes to sha256
`699238c4…` — **the same digest as `~/lab/upgrade-kit-309/spec309.wasm`**, which
was built twice reproducibly from master `e02ea76`, carried through all six
gates, and rehearsed on a chopsticks fork of live 307 state. So what is running
on prod is the artefact that was tested, not a rebuild of it.

## The five validators

All five report spec 309, read from the chain rather than from any one node:

```
spec        309 | tx 1
head/fin    908024 / 908021   (lag 3)
validators  5
new calls   escrow.acceptAgreement true | escrow.expireAgreement true | messages.send true
```

Finality lag of 3 blocks is normal for this chain and was 3 before the upgrade.

## What 309 contains

Agent messaging; escrow provider consent and expiry.

- new pallet `messages` at `construct_runtime` index **42** (appended; every
  existing index byte-identical)
- `agents.set_messaging_key` (13), `agents.clear_messaging_key` (14)
- `escrow.accept_agreement` (6), `reject_agreement` (7), `cancel_pending` (8),
  `expire_agreement` (9)
- new storage `agents::MessagingKey`, `escrow::PendingAcceptance`
- **no migration**, because no existing storage changed shape. Agreements
  created under 307 have no `PendingAcceptance` entry and `consent_state()`
  reads absence as *accepted*, so they are grandfathered and continue exactly
  as before — verified on a fork of live state before the apply.

## Verification after the apply

- the operator-run swarm **switched itself to the 309 escrow flow mid-run**:
  `RUNTIME CHANGED at STEADY round 77: spec 307 -> 309, acceptAgreement false
  -> true, messages.send false -> true`. It was not restarted to notice.
- `escrow.AgreementAccepted` landing on public
- `messages.MessageSent` landing on public
- settlements continuing throughout

## Rollback

`rollback-310.wasm`, sha256
`e9d686d68c5cbd7b462c86ecce2e754e3f9fbbf9f7305ef41c87ae6a3f824048`, was staged
on prod and **was not used**. No trigger fired: all five validators reached 309,
finality never stalled, and no `Failed to execute`, panic or wasm trap appeared.

Its cost had been measured beforehand on a fork (`309-rehearsal/RESULT.md`
§4.3): nothing is lost or stuck, `PendingAcceptance`/`MessagingKey` become
orphaned bytes, and pending-acceptance agreements become ordinary 307
agreements.
