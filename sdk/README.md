# @scalar-commons/sdk

TypeScript agent SDK for the **Scalar Commons** chain — the agent-facing surface
described in protocol §8.3 ("archetypes cannot exist without hands"). Built on
[`@polkadot/api`](https://github.com/polkadot-js/api).

> **Pre-1.0.** The method surface: register/stake/heartbeat,
> the escrow lifecycle, oracle submission, governance voting, era settlement, and
> emission claims, plus read helpers.

## Install

```bash
npm install @scalar-commons/sdk @polkadot/api@^16 @polkadot/keyring@^14 \
  @polkadot/util@^14 @polkadot/util-crypto@^14
```

The `@polkadot/*` packages are **peer dependencies**, so your project and the SDK share
one copy of each. Two copies of `@polkadot/util` make polkadot-js warn
`@polkadot/util has multiple versions` and break `instanceof` checks between them.

## Tester-guide flow

The path in the [testnet tester guide](../docs/guide/testnet-tester-guide.md): get CMN from the
faucet, register two agents, run one escrow job. Registration costs 1 050.01 CMN
per agent (1 000 stake lock + 50 burned fee + 0.01 existential deposit), and
`escrow.createAgreement` needs **both** sides registered.

```ts
import { ScalarCommonsClient, PLANCKS_PER_CMN as CMN } from '@scalar-commons/sdk';
import { blake2AsHex } from '@polkadot/util-crypto';

const client = await ScalarCommonsClient.connect('wss://rpc.scalarnet.io');
// a, b: funded KeyringPairs (buyer b, provider a)

await client.register(a, 1_000n * CMN);
await client.register(b, 1_000n * CMN);
await client.heartbeat(a);
await client.heartbeat(b);

const head = (await client.api.rpc.chain.getHeader()).number.toNumber();
const hash = blake2AsHex('deliverable v1', 256);
await client.createEscrow(b, a.address, 10n * CMN, hash, head + 200, null);
// wait MinDeliveryBlocks (10 blocks, ~60 s) before the provider records delivery
await client.acceptEscrow(a, b.address, 0, hash);
await client.completeEscrow(b, a.address, 0);
```

## Retries and deterministic errors

Transient failures (transport, `Dropped`/`Invalid`/`Usurped` pool statuses) are retried
up to `maxRetries` times, each retry logged. Dispatch errors whose verdict the runtime
reaches from the call's own arguments and a runtime constant are **never** retried: they
arrive as a `DispatchFailure` (with `section` and `errorName`) after one attempt, because
resubmitting only pays another fee (#160). `isDeterministicFailure(err)` exposes the rule.

The classified set:

| Error | Why retrying cannot help |
|---|---|
| `MinDeliveryBlocksNotElapsed` | Delivery inside `MinDeliveryBlocks` of creation (#160). |
| `BadOrigin` | The signer is the wrong origin for the call (#160). |
| `Insufficient*` | Balance/stake below what the call needs (#160). |
| `escrow.SpanTooLong` | `deliverBy` is beyond `MaxAgreementSpan` (#225). |
| `escrow.DeadlineTooEarly` | `deliverBy` is inside `MinDeliveryBlocks` (#225). |
| `escrow.SelfDeal` | Buyer equals provider — signer against an argument (#225). |
| `escrow.AmountTooLow` | `amount` is below `MinAgreementAmount` (#225). |

`SpanTooLong` became reachable with E21, which replaced spec 306's silent deadline clamp
with an error — see the release note for
[#219](https://github.com/tejaspatil1936/scalar-commons-v4/issues/219) for what that means
for a client that used to rely on the clamp.

The set is an allowlist, not "every module error". Errors that can clear between attempts
stay retryable — `agents.NotRegistered`, `escrow.BuyerNotAgent`,
`escrow.ProviderLacksCapability` all pass once a registration or a capability lands, and
classifying one of those would turn a recoverable failure into a hard one.

## Build from source

```bash
cd sdk
npm ci
npm run build      # tsc -> dist/
npm run typecheck  # tsc --noEmit
npm test           # vitest — mock-driven, no node required
```

`npm test` is mock-driven and needs no node. The live checks against a real
devnet are opt-in — see [Integration tests against a real node](#integration-tests-against-a-real-node).

## Design rules

- **polkadot-js only** for transport.
- **No silent retries.** Every retry is logged with its attempt number and the
  triggering error (`src/retry.ts`); the final give-up logs at `error` and rethrows.
- **Balances are `bigint` plancks** (1 CMN = 10¹² plancks).

## Usage

```ts
import { ScalarCommonsClient, PLANCKS_PER_CMN } from '@scalar-commons/sdk';
import { Keyring } from '@polkadot/keyring';

const client = await ScalarCommonsClient.connect('ws://127.0.0.1:9944');
const alice = new Keyring({ type: 'sr25519' }).addFromUri('//Alice');

await client.register(alice, 100n * PLANCKS_PER_CMN);
await client.heartbeat(alice);

const pos = await client.netPosition(alice.address);
console.log(pos.stake, pos.pendingEmissions);

await client.disconnect();
```

## Method → chain mapping

| SDK method | Extrinsic / query |
|---|---|
| `register(signer, stake)` | `agents.register(stake)` |
| `stake(signer, amount)` | `agents.addStake(amount)` |
| `heartbeat(signer)` | `agents.heartbeat()` |
| `createEscrow(signer, provider, amount, hash, deliverBy, cap?)` | `escrow.createAgreement(...)` |
| `acceptEscrow(signer, buyer, seq, hash)` | `escrow.recordDelivery(...)` |
| `completeEscrow(signer, provider, seq)` | `escrow.confirmDelivery(...)` |
| `submitOracle(signer, requestId, answerHash, capability)` | `oracle.submitResponse(...)` |
| `vote(signer, pollIndex, vote)` | `convictionVoting.vote(...)` |
| `recordGovVote(signer, pollIndex)` | `agents.recordGovVote(signerAddress, pollIndex)` |
| `settleEra(signer)` | `emissions.settleEra()` |
| `claim(signer)` | `emissions.claim()` |
| `eraInfo()` | `agents.eraNumber` + `emissions.*` + `EraDuration` const |
| `weightOf(addr)` | `emissions.agentWeightSnapshot(addr)` |
| `totalIssuance()` | `balances.totalIssuance` |
| `netPosition(addr)` | `system.account` + `agents.agentStake/eraEscrowVolume` + pending calc |
| `setMessagingKey(signer, key)` | `agents.setMessagingKey(key)` (spec 308+) |
| `clearMessagingKey(signer)` | `agents.clearMessagingKey()` (spec 308+) |
| `sendMessage(signer, args)` | `messages.send(to, kind, agreement, payloadHash, payload)` (spec 308+) |
| `messagingKeyOf(addr)` | `agents.messagingKey(addr)` (spec 308+) |

### Reading the chain honestly

Two shapes bite anyone who assumes them instead of reading the metadata:

- `emissions.lastSettledEra` is an `Option<u32>`. `EraInfo.lastSettledEra` is
  therefore `number | null` — `null` (nothing has ever settled) is not era `0`.
- Agent stake is a **lock** (`Currency::set_lock`), so it lives *inside*
  `system.account.data.free` and shows up as `frozen`. `NetPosition` reports
  `free`, `reserved`, `frozen` and a `total` of `free + pendingEmissions` —
  adding `stake` on top would report tokens that were never issued. It reports
  no "transferable" figure: what a transfer can move also depends on the
  existential deposit, and an advisory number that ignores it is worse than none.

Since `record_gov_vote` is self-only on chain, `recordGovVote` derives the
`agent` argument from `signer`; passing any other account earns `Unauthorized`
— which the live suite proves by submitting exactly that mismatched call.

## Messaging (spec 308)

Signed envelopes (v1), X25519 messaging keys and transports, all usable
offline. The wire format is the envelope spec, `docs/reference/messaging.md`.
This SDK mirrors its Rust reference, `pallets/messages/src/envelope.rs`, and the
tests pin the Rust vector byte for byte. For a walkthrough, see
[`docs/guide/messaging-sdk.md`](../docs/guide/messaging-sdk.md).

- `createMessage(pair, input)` builds and signs an envelope, with
  `payload_hash` computed over the plaintext. `encodeSignedMessage` /
  `decodeSignedMessage` convert it to and from `SCALE((envelope, signature, body))`.
- `MessageInbox.receive(bytes, bestBlock, opts)` applies every verification
  rule in the spec's order, including checking the on-chain `send` call against
  the envelope. It throws `MessageRejected` with a stable `reason`.
- `deriveMessagingKey(suri, { rotation })` derives the X25519 key from the
  agent's own mnemonic or URI. `sealBody` / `openBody` implement a NaCl `box`,
  interoperable with libsodium's `crypto_box`.
- `OnChainTransport`, `subscribeMessages` (finalized blocks, gap-filling) and
  `HttpsTransport` move bytes. They never decide validity.

Test vectors: `tests/vectors/envelope.json`, regenerated by `npm run vectors`
and re-verified by `npm test`.

## Integration tests against a real node

`tests/live.test.ts` asserts, against the node's own metadata: the runtime spec
version, that `agents.recordGovVote` takes `(agent, pollIndex)`, that
`emissions.lastSettledEra` is `Option<u32>`, that `balances.totalIssuance` is a
`u128`, and that `netPosition` does not double-count the stake lock. It also
submits two real `recordGovVote` calls — one that the runtime must reject on a
*guard* (`NotActivelyVoting`), proof the call encoded with the right arity that
a stale signature could not manage, and one with `agent != signer` that must be
rejected with `Unauthorized`, proof of the self-only rule the docs claim.

It is opt-in, so `npm test` stays node-free. When enabled it **fails rather than
skips** if the node is unreachable — an SDK that cannot be checked against the
chain it wraps is a finding, not a pass:

```bash
RUN_INTEGRATION=1 SCALAR_WS=ws://127.0.0.1:9944 npm run test:integration   # WS_ENDPOINT also works
```
