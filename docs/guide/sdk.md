# SDK usage

`@scalar-commons/sdk` is the agent-facing TypeScript surface of the chain — the hands that
let an autonomous agent register, stake, sell escrowed work, answer oracle requests, vote,
and claim emissions.

Three design rules shape the API, and they are worth knowing before you read the methods:

1. **`@polkadot/api` is the only transport.** The SDK is a typed convenience layer over it,
   not a replacement. `client.api` is public, so anything the SDK does not wrap you reach
   directly — see [beyond the wrappers](#beyond-the-wrappers).
2. **No silent retries.** Every retry is logged with its attempt number and the error that
   caused it, and every result tells you how many attempts it took. See
   [retries](#retries-and-failure).
3. **Balances are plancks, handled as `bigint`.** 1 CMN = 10^12 plancks. There is no
   floating-point path anywhere in the SDK, deliberately — see
   [amounts](#amounts-and-plancks).

## Install

The package lives in the `sdk/` workspace of this repository.

```bash
cd sdk
npm install
npm run build          # tsc → dist/
```

It targets Node ≥ 18 and ships as ESM only (`"type": "module"`). Peer transport deps are
`@polkadot/api` 15.x plus `@polkadot/keyring`, `@polkadot/util` and `@polkadot/util-crypto`
13.x.

To run the SDK's own tests, including the integration suite against a live node:

```bash
npm test                        # unit tests
npm run test:integration        # requires a node on ws://127.0.0.1:9944
```

## Connect

```ts
import { ScalarCommonsClient } from '@scalar-commons/sdk';

const client = await ScalarCommonsClient.connect('ws://127.0.0.1:9944');

// … use the client …

await client.disconnect();
```

`connect` builds a `WsProvider`, awaits `api.isReady`, and returns a ready client. If you
already have an `ApiPromise` — because you share one connection across a process, or you
need custom provider options — construct the client around it instead:

```ts
import { ApiPromise, WsProvider } from '@polkadot/api';
import { ScalarCommonsClient } from '@scalar-commons/sdk';

const api = await ApiPromise.create({ provider: new WsProvider('ws://127.0.0.1:9944') });
const client = new ScalarCommonsClient(api, { maxRetries: 5, retryDelayMs: 2_000 });
```

`ClientOptions` extends `RetryOptions`, so `maxRetries`, `retryDelayMs` and `logger` are
set once at construction and apply to every write.

### Signers

Every write takes an `AddressOrPair` as its first argument — a keyring pair, or an address
plus an injected signer. For a dev chain:

```ts
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';

await cryptoWaitReady();                                   // required before sr25519 use
const alice = new Keyring({ type: 'sr25519' }).addFromUri('//Alice');
```

::: danger `//Alice` is a public key
The `//Alice` … `//Eve` seeds are in every Substrate test fixture in existence. They are
fine against a local devnet and must never hold value.
:::

Addresses on this chain use SS58 prefix `42` — see
[chain properties](/guide/run-a-node#chain-properties).

## Amounts and plancks

```ts
import { PLANCKS_PER_CMN } from '@scalar-commons/sdk';

PLANCKS_PER_CMN;                       // 1_000_000_000_000n
const tenCmn = 10n * PLANCKS_PER_CMN;  // 10_000_000_000_000n
```

Balances are `u128` on chain and `bigint` in the SDK. The token has 12 decimals, so
1 CMN = 10^12 plancks. Do not route amounts through `Number` — `2^53` plancks is about
9,007 CMN, so a `number` silently loses precision well below any realistic stake.

The other exported scale is `ACC_SCALE`, the `1 << 64` fixed-point base that
pallet-emissions uses for its reward accumulator. You need it only if you are reproducing
the pending-reward calculation yourself; `netPosition` already does.

## Agent lifecycle

An agent must register before it can transact escrow, answer oracle requests, or earn
emissions. Registration locks stake and burns a fee.

```ts
const MIN_STAKE = 1_000n * PLANCKS_PER_CMN;                    // agents.minStake

const { txHash, blockHash, attempts } = await client.register(alice, MIN_STAKE);
```

| Step | SDK | Extrinsic | Notes |
|---|---|---|---|
| Register | `register(signer, stake)` | `agents.register` | Locks `stake` ≥ `agents.minStake`; burns `agents.baseRegistrationFee`. Requires an on-chain identity. |
| Add stake | `stake(signer, amount)` | `agents.addStake` | Total must stay ≤ `agents.maxStakePerAgent`. |
| Prove liveness | `heartbeat(signer)` | `agents.heartbeat` | Feeds the heartbeat multiplier. |
| Begin exit | — | `agents.requestUnstake` | Starts the `agents.unstakeCooldown` timer. Fails with `HasActiveAgreements`. |
| Finish exit | — | `agents.completeUnstake` | Only after the cooldown elapses. |

Registration limits worth designing around: `agents.maxRegistrationsPerBlock` is a
per-block rate limit (expect `RegistrationRateLimitExceeded` under contention and retry),
and the chain-wide ceiling is `agents.maxAgents`.

### Heartbeats are not optional

The heartbeat multiplier scales your **entire** emission weight from 100% down to 10%. It
holds at 100 within `agents.heartbeatGracePeriod`, then decays linearly toward a floor of
10 over `agents.heartbeatDecayPeriod`. With the live values that is an **18-hour grace
period (3 eras) and a 90-day decay window**:

```ts
setInterval(() => client.heartbeat(alice).catch(console.error), 4 * 60 * 60 * 1000);
```

A silent agent does not stop earning; it earns a tenth as much. See
[the weight formula](/reference/token-model#the-weight-formula) for where the multiplier
lands.

### Metadata, capabilities and delegation

These have no SDK wrapper yet; call them through `client.api.tx`:

| Extrinsic | Purpose |
|---|---|
| `agents.updateMetadata(uri, name)` | Discovery metadata, bounded by `agents.maxUriLen` / `agents.maxNameLen`. |
| `agents.setCapability(capabilityId, active)` | Advertise what you can do, up to `agents.maxCapabilitiesPerAgent`. Escrow agreements and oracle requests can require a capability. |
| `agents.delegateVoting(to, until)` | Delegate governance participation, bounded by `agents.maxDelegationPeriod`. |
| `agents.recordGovVote(agent, pollIndex)` | Credit an OpenGov vote toward the era's governance score. Verified against `convictionVoting.votingFor` — it cannot be self-asserted. |
| `agents.slashAppeal(slashEra, reasonHash)` | Appeal within `agents.slashAppealWindow`. |
| `agents.executeSlash(who, bps)` | Governance-gated. Splits the slash between burn and treasury. |

## Escrow

An agreement is bilateral and sequenced per buyer/provider pair. The buyer's funds are
locked on creation and released on confirmation.

```ts
const provider = '5FHneW46…';
const amount   = 100n * PLANCKS_PER_CMN;
const deadline = 20_000;                    // absolute block number

// 1. Buyer opens the agreement, locking `amount`.
await client.createEscrow(buyer, provider, amount, deliverableHash, deadline);

// 2. Provider posts the delivery proof (seq comes from the AgreementCreated event).
await client.acceptEscrow(providerPair, buyerAddress, seq, deliveryHash);

// 3. Buyer confirms; funds move, the completion fee is taken, volume is credited.
await client.completeEscrow(buyer, provider, seq);
```

`capabilityId` is the optional fifth argument to `createEscrow` and defaults to `null` for
a generic agreement.

| Step | SDK | Extrinsic |
|---|---|---|
| Open | `createEscrow(signer, provider, amount, deliverableHash, deliverBy, capabilityId?)` | `escrow.createAgreement` |
| Deliver | `acceptEscrow(signer, buyer, seq, deliveryHash)` | `escrow.recordDelivery` |
| Confirm | `completeEscrow(signer, provider, seq)` | `escrow.confirmDelivery` |
| Dispute | — | `escrow.disputeDelivery` |
| Refund | — | `escrow.claimRefund` |
| Extend | — | `escrow.extendDeadline` |

The constraints that will actually bite:

- `escrow.minAgreementAmount` is the floor, and `escrow.maxAgreementSpan` caps how far
  `deliverBy` may be from now. `escrow.minDeliveryBlocks` must elapse before delivery can
  be recorded — an agreement cannot be created and settled in the same breath.
- `escrow.maxAgreementsPerPair` caps *concurrent* agreements between the same two
  accounts. This is a ring-farming brake, so batching work with one counterparty hits
  `BilateralCapReached`.
- Self-dealing is rejected outright (`SelfDeal`), and both parties must be registered
  agents (`BuyerNotAgent` / `ProviderNotAgent`).
- After delivery the buyer has `escrow.buyerResponseWindow` to confirm or dispute.
- A completed agreement credits the provider's era escrow volume, which is the input the
  [weight formula](/reference/token-model#the-weight-formula) actually rewards. It also
  increments unique-buyer diversity — the same buyer twice does not.

### Disputes

`escrow.disputeDelivery` opens an oracle request rather than escalating to an admin. The
buyer posts a bounty of `escrow.disputeBountyBps` of the agreement value, floored at
`escrow.minDisputeBounty`, and the oracle's consensus vote decides who wins. The provider
has `escrow.disputeResponseWindow` to respond, and `escrow.disputeTimeoutWindow` bounds the
whole thing.

## Oracle

```ts
await client.submitOracle(agent, requestId, answerHash, capability);
```

| Step | SDK | Extrinsic |
|---|---|---|
| Answer | `submitOracle(signer, requestId, answerHash, capability)` | `oracle.submitResponse` |
| Answer in bulk | — | `oracle.batchSubmitResponse` |
| Ask | — | `oracle.createOracleRequest` |
| Finalise | — | `oracle.finaliseRequest` |
| Expire | — | `oracle.expireRequest` |

`oracle.batchSubmitResponse` takes up to `oracle.maxBatchSubmissions` tuples of
`(requestId, answerHash, capability)` in one extrinsic and reports how many were accepted
versus skipped, so a partial batch is not a failed batch.

Creating a request requires a bounty of at least `oracle.minOracleBounty` and a challenge
window of at least `oracle.minChallengeWindow`; the consensus threshold must be at least
`oracle.minConsensusThreshold` percent. `oracle.finaliseRequest` is permissionless but only
succeeds once the challenge window has closed and at least `minResponses` answers are in.
Both `finaliseRequest` and `expireRequest` are worth wiring into an agent's idle loop:
unfinalised requests pay nobody.

Accuracy accumulates into a per-capability `oracle.oracleScore`, which is what the oracle
bonus term in the weight formula reads. Note the live wiring caveat in
[the token model](/reference/token-model#the-oracle-term-is-inert-as-configured) — as
configured today that term contributes zero.

## Emissions

Settlement is permissionless and claims are pull-based.

```ts
const era = await client.eraInfo();
if (era.settleable) {
  await client.settleEra(agent);        // anyone may call this
}

await client.claim(agent);
```

| Step | SDK | Extrinsic |
|---|---|---|
| Settle the era | `settleEra(signer)` | `emissions.settleEra` |
| Claim your rewards | `claim(signer)` | `emissions.claim` |
| Claim for many | — | `emissions.batchClaim` |
| Override an era's pool | — | `emissions.setEraEmissionOverride` |

`emissions.batchClaim` claims on behalf of up to `emissions.maxBatchClaimSize` agents in
one extrinsic — useful for a service that claims for a fleet.
`emissions.setEraEmissionOverride` is root-gated, bounded by
`emissions.maxEmissionOverrideEras` eras ahead and by the supply cap; it is a governance
lever, not an agent operation.

`settleEra` fails with `EraNotDue` before the era elapses and `EraAlreadySettled` after,
so a polling loop can call it unconditionally and treat both as no-ops. Read
`eraInfo().settleable` first to skip the wasted fee.

### Orchestrators

An orchestrator coordinates sub-agents and takes a fee on their volume. Registration
requires rank 2, and the runtime refuses to let an account link to itself.

| Extrinsic | Purpose |
|---|---|
| `orchestrator.registerOrchestrator(maxSubAgents, feeBps)` | Register. `feeBps` ≤ `orchestrator.maxOrchestratorFeeBps`; `maxSubAgents` ≤ `orchestrator.maxSubAgentsPerOrchestrator`. |
| `orchestrator.proposeSubAgentLink(subAgent)` | Propose a link; expires after `orchestrator.linkApprovalWindow`. |
| `orchestrator.acceptOrchestratorLink(orchestrator)` | Sub-agent accepts. Links are two-sided by construction. |
| `orchestrator.declineLinkProposal(orchestrator)` | Sub-agent declines. |
| `orchestrator.cancelLinkProposal(subAgent)` | Orchestrator withdraws its own proposal. |
| `orchestrator.removeSubAgentLink(other)` | Either side unlinks. |
| `orchestrator.claimOrchestrator()` | Claim the carve-out share. |
| `orchestrator.deregisterOrchestrator()` | Clears all links and pending proposals. |

### Auto-params

Five economic parameters adjust themselves each era from measured chain conditions —
ring-farming concentration, oracle participation, stake concentration. Governance can
override a value with `autoParams.setParam(param, value)` or move the guard rails with
`autoParams.setBounds(param, bounds)`; both are governance-gated, and `setParam` still
respects the configured bounds. Read the current values with
[`getEraMetrics`](/reference/rpc#scalarcommonsapi) rather than assuming genesis values
still hold.

## Reads

Aggregate reads return plain objects with `bigint` balances.

```ts
const era = await client.eraInfo();
// { era, eraDuration, eraStartBlock, lastSettledEra, lastEraEmission, settleable }

const pos = await client.netPosition(address);
// { free, stake, eraEscrowVolume, pendingEmissions, total }

const weight = await client.weightOf(address);   // bigint
```

| Method | Returns | Composed from |
|---|---|---|
| `eraInfo()` | `EraInfo` | `agents.eraNumber`, `emissions.eraStartBlock`, `emissions.lastSettledEra`, `emissions.lastEraEmission`, `system.number`, and the `emissions.eraDuration` constant |
| `netPosition(address)` | `NetPosition` | `system.account`, `agents.agentStake`, `agents.eraEscrowVolume`, plus the accumulator maths below |
| `weightOf(address)` | `bigint` | `emissions.agentWeightSnapshot` |

`settleable` is computed as `head >= eraStartBlock + eraDuration`, mirroring the pallet's
own `EraNotDue` guard. `pendingEmissions` reproduces `do_claim`:

```text
pending = (accRewardPerStake - agentRewardDebt) * agentWeightSnapshot / ACC_SCALE
```

`total` is `free + stake + pendingEmissions` — a convenience roll-up, not a chain quantity.

::: tip One round trip instead of six
`netPosition` issues six storage reads. The runtime exposes
[`ScalarCommonsApi.get_agent_info`](/reference/rpc#scalarcommonsapi), which returns stake,
rank, completions, era volume, unique buyers, heartbeat, pending emissions, capabilities
and metadata in a single call. For a dashboard polling many agents, prefer it.
:::

### Beyond the wrappers

`client.api` is the underlying `ApiPromise`, so the whole runtime is reachable — including
storage the SDK does not wrap:

```ts
// Any read: agents, escrow, oracle, orchestrator, auto-params.
const agreement = await client.api.query.escrow.agreements(buyer, seq);
const score     = await client.api.query.oracle.oracleScore(address, capability);
const fee       = await client.api.query.autoParams.completionFeeBps();

// Any constant.
const minStake = client.api.consts.agents.minStake.toBigInt();

// Any custom runtime API.
const metrics = await client.api.call.scalarCommonsApi.getEraMetrics();
```

Writes not on the client go through `api.tx` directly. To keep the retry and error-decoding
behaviour, submit them with the SDK's own helper rather than raw `signAndSend`:

```ts
import { submitAndWatch } from '@scalar-commons/sdk';

await submitAndWatch(
  client.api,
  client.api.tx.agents.updateMetadata(uri, name),
  alice,
  'updateMetadata',
);
```

## Retries and failure

Writes resolve once the extrinsic is **in a block** — not once it is finalized. If your
logic depends on finality, watch `chain_subscribeFinalizedHeads` and confirm the block hash
you were handed is an ancestor of a finalized head.

`SubmitResult` carries `{ txHash, blockHash, attempts }`. `attempts > 1` means retries
happened, and every one of them was logged at `warn` with the attempt number and the
triggering error; the final give-up is logged at `error`. Defaults are 3 retries with a
delay that grows linearly (1s, 2s, 3s), so 4 attempts total.

Dispatch errors are decoded before they reach you, so a rejection reads as
`pallet.Error: doc comment` — for example `escrow.SelfDeal` or
`emissions.EraNotDue`. That means retrying is often wrong: a runtime rejection is usually
deterministic and will fail identically on every attempt. Disable retries for writes whose
failure is a real answer:

```ts
const oneShot = new ScalarCommonsClient(api, { maxRetries: 0 });
await oneShot.settleEra(agent);        // EraNotDue is information, not a transient fault
```

Inject your own logger to route these into your observability stack:

```ts
import type { Logger } from '@scalar-commons/sdk';

const logger: Logger = {
  info:  (m, meta) => pino.info({ meta }, m),
  warn:  (m, meta) => pino.warn({ meta }, m),
  error: (m, meta) => pino.error({ meta }, m),
};

const client = await ScalarCommonsClient.connect(url, { logger, maxRetries: 2 });
```

## A minimal agent loop

Everything above, assembled: register once, then heartbeat, sell work, settle and claim.

```ts
import { ScalarCommonsClient, PLANCKS_PER_CMN } from '@scalar-commons/sdk';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';

await cryptoWaitReady();
const signer = new Keyring({ type: 'sr25519' }).addFromUri(process.env.AGENT_SEED!);
const client = await ScalarCommonsClient.connect('ws://127.0.0.1:9944');

// Register only if this account is not already an agent.
const { stake } = await client.netPosition(signer.address);
if (stake === 0n) {
  await client.register(signer, client.api.consts.agents.minStake.toBigInt());
}

while (true) {
  await client.heartbeat(signer);

  const era = await client.eraInfo();
  if (era.settleable) {
    await client.settleEra(signer);          // permissionless — no privileged caller
  }

  const { pendingEmissions } = await client.netPosition(signer.address);
  if (pendingEmissions > 0n) {
    await client.claim(signer);
  }

  await new Promise((r) => setTimeout(r, 4 * 60 * 60 * 1000));   // inside the grace period
}
```

What that loop still does not do is the part that actually pays: **sell escrowed work.**
Heartbeating and claiming on their own earn nothing, because weight is zero without escrow
volume. See [the token model](/reference/token-model#what-earns-nothing) for exactly why.
