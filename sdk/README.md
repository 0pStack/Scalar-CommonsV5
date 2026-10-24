# @scalar-commons/sdk

TypeScript agent SDK for the **Scalar Commons** chain — the agent-facing surface
described in protocol §8.3 ("archetypes cannot exist without hands"). Built on
[`@polkadot/api`](https://github.com/polkadot-js/api).

> **Pre-1.0.** The method surface: register/stake/heartbeat,
> the escrow lifecycle, oracle submission, governance voting, era settlement, and
> emission claims, plus read helpers.

## Install

The package is **not published to npm**: `npm install @scalar-commons/sdk` returns 404. Build
it in this repository, which is one npm workspace with one lockfile at the root:

```bash
npm ci                                   # at the repository root
npm run build -w @scalar-commons/sdk     # tsc -> sdk/dist/
```

To use it from your own project, install the packed tarball, not the directory (a directory
install is a symlink, which resolves a second copy of `@polkadot/*`):

```bash
npm pack -w @scalar-commons/sdk --pack-destination /tmp   # -> /tmp/scalar-commons-sdk-0.1.0.tgz
mkdir -p ~/my-agent && cd ~/my-agent && npm init -y
npm install /tmp/scalar-commons-sdk-0.1.0.tgz
```

The `@polkadot/*` packages (`@polkadot/api` ^16; `@polkadot/keyring`, `@polkadot/util` and
`@polkadot/util-crypto` ^14) are **peer dependencies**, so your project and the SDK share
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
// spec 309+: the provider must consent first, or recordDelivery fails with NotAccepted
await client.acceptAgreement(a, b.address, 0);
// wait MinDeliveryBlocks (10 blocks, ~60 s) after creation before the provider records delivery
await client.recordDelivery(a, b.address, 0, hash);
await client.completeEscrow(b, a.address, 0);
```

Instead of accepting, the provider can decline a pending agreement with
`rejectAgreement(a, b.address, 0)`, or the buyer can withdraw it with
`cancelPending(b, a.address, 0)`. Either refunds the buyer in full.

## Connection and submission deadlines

`ScalarCommonsClient.connect(endpoint, options)` fails with a typed `TimeoutError`
when the provider or API does not become ready within `connectTimeoutMs` (10 seconds
by default). Write calls have a 60-second per-attempt `submitTimeoutMs` default.
Both values must be positive finite milliseconds.

Submission failures are typed as `SubmitError` subclasses: `TimeoutError`,
`SubmitStatusError`, and `SubmitTransportError`. `DispatchFailure` remains the
runtime dispatch-error type. `Retracted`, `FinalityTimeout`, timeout, and ambiguous
transport errors stop immediately. Before retrying `Dropped`, `Invalid`, `Usurped`,
or a known-hash transport failure, the SDK scans the blocks produced since the
submission began. If the transaction is already present, the call succeeds without
resubmitting it.

```ts
const client = await ScalarCommonsClient.connect(endpoint, {
  connectTimeoutMs: 10_000,
  submitTimeoutMs: 60_000,
  maxRetries: 1,
  retryDelayMs: 500,
});
```

## Retry policy

Only recognized transport failures and `Dropped`/`Invalid`/`Usurped` pool statuses
are retried, up to `maxRetries` times. Every retry is logged with its attempt
number and the triggering error. Known WebSocket connection/response-timeout
messages and Node socket error codes identify transport failures.

**Every runtime dispatch error stops after one attempt**, including module
variants unknown to this SDK and non-module errors such as Token or Arithmetic.
The original `DispatchFailure` exposes `section` and `errorName`. Dispatch already
paid a fee; the SDK must not pay again automatically just because a registration,
capability or other chain state might change (#29). The caller can inspect the
failure, resolve its cause and explicitly decide whether to submit a new call.

Unknown errors also stop immediately. `isRetryableFailure(err)` exposes the
transport/pool allowlist. The compatibility export `isDeterministicFailure(err)`
now returns true for every `DispatchFailure`; its historical name describes the
retry policy, rather than promising that chain state can never change.

## Build from source

```bash
npm ci                                     # at the repository root
npm run build -w @scalar-commons/sdk       # tsc -> sdk/dist/
npm run typecheck -w @scalar-commons/sdk   # tsc --noEmit
npm test -w @scalar-commons/sdk            # vitest — mock-driven, no node required
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

await client.register(alice, 1_000n * PLANCKS_PER_CMN); // agents.minStake; less fails with StakeTooLow
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
| `acceptAgreement(signer, buyer, seq)` | `escrow.acceptAgreement(buyer, seq)` — provider signs (spec 309+) |
| `rejectAgreement(signer, buyer, seq)` | `escrow.rejectAgreement(buyer, seq)` — provider signs (spec 309+) |
| `cancelPending(signer, provider, seq)` | `escrow.cancelPending(provider, seq)` — buyer signs (spec 309+) |
| `recordDelivery(signer, buyer, seq, hash)` | `escrow.recordDelivery(...)` |
| `acceptEscrow(signer, buyer, seq, hash)` | Deprecated alias of `recordDelivery`; it never accepted anything |
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

`../e2e/sdk/sdk.live.test.ts` asserts, against the node's own metadata: the runtime spec
version, that `agents.recordGovVote` takes `(agent, pollIndex)`, that
`emissions.lastSettledEra` is `Option<u32>`, that `balances.totalIssuance` is a
`u128`, and that `netPosition` does not double-count the stake lock. It also
submits two real `recordGovVote` calls — one that the runtime must reject on a
*guard* (`NotActivelyVoting`), proof the call encoded with the right arity that
a stale signature could not manage, and one with `agent != signer` that must be
rejected with `Unauthorized`, proof of the self-only rule the docs claim.

It lives in the E2E workspace, so `npm test -w @scalar-commons/sdk` stays node-free
and skips nothing. The live command **fails rather than skips** if the node is
unreachable unless `E2E_ALLOW_SKIP=1` is explicitly set:

```bash
SCALAR_WS=ws://127.0.0.1:9944 npm run test:live:sdk -w @scalar-commons/e2e   # WS_ENDPOINT also works
```

In PowerShell, set the endpoint first:

```powershell
$env:SCALAR_WS = 'ws://127.0.0.1:9944'; npm run test:live:sdk -w @scalar-commons/e2e
```
