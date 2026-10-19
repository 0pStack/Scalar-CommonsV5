# RPC reference

A Scalar Commons node serves **108 JSON-RPC methods** over both HTTP and WebSocket on the
same port (`9944` on the reference devnet). That is the count on a default, pruning node; an
archive node (the reference devnet's alice) also serves the ten `archive_v1_*` methods, 118 in
total. On top of the standard Substrate surface, the
runtime declares one custom runtime API, `ScalarCommonsApi`, reachable through `state_call`.

Verified against `scalar-commons` spec 306, metadata v15.

## Endpoints and transports

| Transport | URL | Use for |
|---|---|---|
| WebSocket | `ws://127.0.0.1:9944` | Anything with subscriptions, and all `@polkadot/api` work |
| HTTP | `http://127.0.0.1:9944` | One-shot `curl` queries, health checks, scripts |

Subscriptions (`*_subscribe*`) require WebSocket. `@polkadot/api` needs it for its own
runtime-upgrade subscription, so prefer `ws://` for anything programmatic.

The reference devnet endpoint — alice, port 9944 — runs with `--rpc-methods safe`, set
explicitly in `deploy/systemd/scalar-alice.service`. That withholds the unsafe method set —
`author_insertKey`, `author_rotateKeys`, `author_hasKey`, `author_hasSessionKeys`,
`babe_epochAuthorship`, `system_addReservedPeer` and friends — which answer with
`-32601 RPC call is unsafe to be called externally`.

**A node you start yourself does not behave that way.** The flag defaults to `auto`, and
`auto` serves the *full* method set, unsafe methods included, whenever RPC is listening on
loopback; it falls back to the safe subset only when the listener is not local. So the
keystore-mutating surface is exposed by default on any ordinary `127.0.0.1` node — no
`--rpc-methods unsafe` opt-in required, and not binding `--rpc-external` does not withhold
it. Anything that can open a loopback connection to the RPC port — another user on the box,
a container sharing the network namespace, the far end of somebody's SSH tunnel — can call
`author_insertKey`.

To get the devnet's posture on your own node, pass `--rpc-methods safe` yourself. See
[running a validator](/guide/run-a-node#run-as-a-validator), which does, and which covers
the one case where you need the unsafe set back.

::: warning A node's RPC port is not a public API
`safe` still exposes chain state and transaction submission. Put it behind a reverse proxy
with TLS and rate limiting, or reach it through an SSH tunnel, rather than binding
`0.0.0.0`.
:::

## ScalarCommonsApi

An agent deciding whether to contract with a counterparty needs that counterparty's
economic standing without replaying chain state itself. That data is spread across five
pallets and two accumulator formulas, so the runtime assembles it in one call — which is
also how off-chain agents and the indexer end up sharing one authoritative view instead of
each deriving their own.

The API is read-only by construction: nothing here mints, moves or reserves.

| Method | Signature |
|---|---|
| `ScalarCommonsApi_get_agent_info` | `get_agent_info(who: AccountId32) -> Option<AgentInfo>` |
| `ScalarCommonsApi_get_era_metrics` | `get_era_metrics() -> EraSnapshot` |
| `ScalarCommonsApi_get_oracle_score` | `get_oracle_score(who: AccountId32, capability: u32) -> u32` |
| `ScalarCommonsApi_get_pending_emissions` | `get_pending_emissions(who: AccountId32) -> u128` |

::: warning Not surfaced as named JSON-RPC methods
These four are implemented in the runtime and exported by the WASM blob, but the node does
**not** register JSON-RPC wrappers for them — that was explicitly out of scope when the RPC
module was written. They are reachable via `state_call` (below), or as
`api.call.scalarCommonsApi.*` in `@polkadot/api`, which does the encoding for you. Looking
for `scalar_getAgentInfo` in `rpc_methods` will not find it, and that is expected.
:::

### Calling them from the SDK

`@polkadot/api` reads the runtime API declarations out of metadata v15, so the typed path
needs no manual SCALE work:

```ts
const info    = await api.call.scalarCommonsApi.getAgentInfo(address);
const metrics = await api.call.scalarCommonsApi.getEraMetrics();
const score   = await api.call.scalarCommonsApi.getOracleScore(address, capability);
const pending = await api.call.scalarCommonsApi.getPendingEmissions(address);

console.log(info.isSome ? info.unwrap().toJSON() : 'not an agent');
```

### Calling them over raw JSON-RPC

`state_call` takes the runtime API method name and hex-encoded SCALE arguments. For a
no-argument method the payload is `"0x"`:

```bash
curl -sH 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"state_call",
          "params":["ScalarCommonsApi_get_era_metrics","0x"]}' \
     http://127.0.0.1:9944
```

```json
{"jsonrpc":"2.0","id":1,"result":"0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000190000\
00dc05000088130000e803000000000000"}
```

The result is a SCALE-encoded `EraSnapshot` — 64 bytes, fixed-width, no length prefix
because every field is fixed-size:

| Offset | Bytes | Field | Type | Decoded above |
|---|---|---|---|---|
| 0 | 4 | `era_number` | `u32` | 0 |
| 4 | 4 | `active_agents` | `u32` | 0 |
| 8 | 4 | `ring_count` | `u32` | 0 |
| 12 | 16 | `total_weight` | `u128` | 0 |
| 28 | 16 | `last_era_emission` | `u128` | 0 |
| 44 | 4 | `completion_fee_bps` | `u32` | 25 |
| 48 | 4 | `alpha` | `u32` | 1500 |
| 52 | 4 | `beta` | `u32` | 5000 |
| 56 | 4 | `floor_bps` | `u32` | 1000 |
| 60 | 4 | `active_orchestrators` | `u32` | 0 |

All integers are little-endian. `state_callAt` takes a block hash as a third parameter for
historical reads — which needs an archive node for anything beyond the pruning window.

Methods that take arguments need SCALE-encoded input, so `AccountId32` is the 32-byte
public key — not the SS58 string. Decode the address first
(`decodeAddress` from `@polkadot/util-crypto`) and concatenate arguments in declaration
order. This is the point at which using `api.call.*` stops being a convenience and starts
being the sensible choice.

### `EraSnapshot` fields

| Field | Type | Meaning |
|---|---|---|
| `era_number` | `u32` | Current era. |
| `active_agents` | `u32` | Agents with any volume in the era preceding the last drain. |
| `ring_count` | `u32` | Ring-suspect agents at the last drain: active, established, ≤ 1 counterparty. |
| `total_weight` | `u128` | Sum of all agent weight snapshots — the denominator of your share. |
| `last_era_emission` | `Balance` | CMN emitted in the last settled era, in plancks. |
| `completion_fee_bps` | `u32` | Live escrow completion fee. |
| `alpha` | `u32` | Live governance-score weight in the emissions formula. |
| `beta` | `u32` | Live work-score weight. |
| `floor_bps` | `u32` | Live activity floor for qualifying agents. |
| `active_orchestrators` | `u32` | Registered orchestrators. |

`total_weight` is deliberately `u128` and not `Balance`: it is a sum of scaled scores, not
a token amount. Typing it as `Balance` would imply it is denominated in CMN. The last four
fields are the auto-params values the chain has adjusted itself to — read them here rather
than assuming genesis values still hold.

### `AgentInfo` fields

`get_agent_info` returns `None` when the account holds no stake, meaning it is not a
registered agent. An agent with stake but no metadata returns `Some` with empty `uri` and
`name` — a different state, reported as such.

| Field | Type | Meaning |
|---|---|---|
| `stake` | `Balance` | Locked agent stake. One factor of the weight, never the whole of it. |
| `rank` | `u32` | Ranked-collective rank 0–3. `0` also covers "not a member". |
| `completions` | `u32` | Lifetime completed agreements. Drives rank promotion. |
| `era_volume` | `Balance` | Escrow volume this era. Reset on era drain. |
| `unique_buyers` | `u32` | Distinct counterparties this era — the anti-ring signal. |
| `last_heartbeat` | `BlockNumber` | Block of the last heartbeat. |
| `pending_emissions` | `Balance` | Claimable right now. Advisory — see below. |
| `heartbeat_multiplier` | `u32` | Liveness multiplier, 10–100. |
| `capabilities` | `Vec<u32>` | Declared capability IDs. |
| `uri` | `Vec<u8>` | Off-chain endpoint. Empty when unset. |
| `name` | `Vec<u8>` | Display name. Empty when unset. |
| `orchestrator` | `Option<AccountId>` | Orchestrator this agent is a sub-agent of. |

A high `era_volume` with `unique_buyers` ≤ 1 is the ring-farming shape, which is exactly
why [the weight formula](/reference/token-model#activity-what-makes-stake-count-at-all)
multiplies volume by buyer diversity.

::: warning `pending_emissions` is advisory
It is computed from the reward accumulator at the instant of the call and clamped to
remaining headroom under the supply cap. It is what you *would* receive claiming now — not
a reservation. It moves with every era settlement.
:::

## The standard surface

Everything below is stock Substrate. Listed here because "which of these actually exist on
this node" is otherwise a guess — `mmr`, `beefy`, `statement`, `mixnet`, `sync_state`, `dev`
and `state_trie_migration` are all **absent**, either because the runtime has no
corresponding pallet or because they were deliberately not wired.

Get the authoritative list from the node itself:

```bash
curl -sH 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"rpc_methods","params":[]}' \
     http://127.0.0.1:9944
```

### Chain and system

| Method | Purpose |
|---|---|
| `system_health` | Peer count, `isSyncing`. First call when debugging a node. |
| `system_syncState` | `startingBlock`, `currentBlock`, `highestBlock`. |
| `system_chain`, `system_name`, `system_version` | Chain and client identity. |
| `system_properties` | `ss58Format`, `tokenDecimals`, `tokenSymbol`. |
| `system_chainType` | `Development` / `Local` / `Live`. |
| `system_peers`, `system_localPeerId`, `system_localListenAddresses` | Networking state. |
| `system_accountNextIndex` | Next nonce for an account, pending extrinsics included. |
| `system_dryRun`, `system_dryRunAt` | Apply an extrinsic without submitting it. |
| `chain_getBlock`, `chain_getBlockHash`, `chain_getHeader` | Block retrieval. |
| `chain_getFinalizedHead` | Latest finalized hash. Not the same as `chain_getHead`. |
| `chain_subscribeNewHeads`, `chain_subscribeFinalizedHeads` | Head subscriptions. |

`system_accountNextIndex` — exposed as `account_nextIndex` too — accounts for extrinsics
still in the pool, which is what makes it the right source for a nonce when submitting
several transactions back to back.

::: tip Best height is not finalized height
`chain_getHead` advances even when finality has stalled. A node that produces blocks
without finalizing them looks healthy to a check that only reads best height. Watch
`chain_getFinalizedHead` — that is what `deploy/finality-check.sh` samples.
:::

### State and storage

| Method | Purpose |
|---|---|
| `state_getMetadata` | Runtime metadata. The source of truth for every type shape. |
| `state_getRuntimeVersion` | `specName`, `specVersion`, `transactionVersion`, API hashes. |
| `state_getStorage`, `state_getStorageAt` | Raw storage by key. |
| `state_getKeys`, `state_getKeysPaged` | Key enumeration. Use the paged form. |
| `state_queryStorageAt` | Batch several keys at one block. |
| `state_call`, `state_callAt` | Invoke a runtime API — including `ScalarCommonsApi`. |
| `state_subscribeStorage` | Storage change subscription. |
| `state_getReadProof` | Merkle proof for a key set. |
| `state_subscribeRuntimeVersion` | Fires on runtime upgrade. |

Never hand-write type shapes. Read `state_getMetadata` — or let `@polkadot/api` read it —
because the runtime is the only authority on layout, and it changes with `spec_version`.

### Author and transaction pool

| Method | Purpose |
|---|---|
| `author_submitExtrinsic` | Fire-and-forget submission. |
| `author_submitAndWatchExtrinsic` | Submission with status updates. What the SDK uses. |
| `author_pendingExtrinsics` | Current pool contents. |
| `author_rotateKeys` | Generate session keys in the node's keystore. **Unsafe.** |
| `author_insertKey` | Insert a key into the keystore. **Unsafe.** |
| `author_hasKey`, `author_hasSessionKeys` | Check what the keystore holds. **Unsafe.** |
| `transaction_v1_broadcast`, `transactionWatch_v1_submitAndWatch` | New JSON-RPC spec equivalents. |

### Consensus, payment, and the new JSON-RPC spec

| Method | Purpose |
|---|---|
| `babe_epochAuthorship` | Slots this node is due to author. **Unsafe.** |
| `grandpa_roundState` | Current GRANDPA round and voter state. |
| `grandpa_proveFinality` | Finality proof for a block range. |
| `grandpa_subscribeJustifications` | Justification stream. |
| `payment_queryInfo` | Estimated weight, class and partial fee for an encoded extrinsic. |
| `payment_queryFeeDetails` | Inclusion-fee breakdown plus tip. |
| `chainHead_v1_*`, `chainSpec_v1_*`, `archive_v1_*` | The new JSON-RPC spec surface, used by light clients. |

The `*_v1_*` families are the modern spec and coexist with the legacy methods. Light-client
work should target them; `@polkadot/api` still uses the legacy set.

## Runtime APIs

Thirteen runtime APIs are declared in metadata. Twelve are standard; the thirteenth is this
chain's own.

| API | Methods | Notes |
|---|---|---|
| `Core` | 3 | `version`, `execute_block`, `initialize_block` |
| `Metadata` | 3 | Includes `metadata_versions` |
| `BlockBuilder` | 4 | |
| `TaggedTransactionQueue` | 1 | `validate_transaction` |
| `OffchainWorkerApi` | 1 | |
| `SessionKeys` | 2 | `generate_session_keys`, `decode_session_keys` |
| `BabeApi` | 6 | Includes equivocation reporting |
| `GrandpaApi` | 4 | Includes equivocation reporting |
| `AuthorityDiscoveryApi` | 1 | Current and next authority set |
| `AccountNonceApi` | 1 | `account_nonce` |
| `TransactionPaymentApi` | 4 | Fee estimation |
| `GenesisBuilder` | 3 | `build_state`, `get_preset`, `preset_names` |
| **`ScalarCommonsApi`** | **4** | [Above](#scalarcommonsapi) |

`AuthorityDiscoveryApi` returning the current *and next* authority set is what lets devnet
validators find each other over the DHT with only one bootnode configured.

## Pallet indices

Storage keys are derived from pallet names, but `RuntimeCall` and `RuntimeEvent` encoding
uses the index. Anything decoding raw extrinsics or events needs these.

**These indices are append-only.** A renumbered or reused index silently changes what every
encoded call means. A past bug in this repo had SafeMode, TxPause and Constitution
duplicating 34–36 with Staking, Babe and Grandpa — which is why 38–41 are used and 34–36
are not what you would guess from reading declaration order.

<!-- chain-check:pallet-index -->

| Pallet | Index | Role |
|---|---|---|
| `System` | 0 | |
| `Timestamp` | 1 | |
| `Balances` | 4 | CMN balances |
| `Historical` | 6 | `pallet_session::historical` |
| `AuthorityDiscovery` | 8 | |
| `Offences` | 9 | |
| `VoterList` | 10 | `pallet_bags_list` |
| `TransactionPayment` | 13 | |
| `Vesting` | 14 | |
| `Treasury` | 15 | Completion fees, slash share |
| `Sudo` | 16 | Held by operator; removal scheduled for mainnet |
| `Utility` | 17 | |
| `Multisig` | 18 | |
| `Scheduler` | 19 | |
| `Preimage` | 20 | |
| `Referenda` | 21 | OpenGov |
| `ConvictionVoting` | 22 | OpenGov; the governance-score source |
| `RankedCollective` | 23 | Technical Council; the rank source |
| `Identity` | 25 | Required to register as an agent |
| `Agents` | 26 | **Custom** |
| `Escrow` | 27 | **Custom** |
| `Oracle` | 28 | **Custom** |
| `Emissions` | 29 | **Custom** |
| `AutoParams` | 30 | **Custom** |
| `Orchestrator` | 31 | **Custom** |
| `NominationPools` | 32 | |
| `Whitelist` | 33 | |
| `Staking` | 34 | |
| `Babe` | 35 | |
| `Grandpa` | 36 | |
| `Session` | 37 | |
| `SafeMode` | 38 | |
| `TxPause` | 39 | |
| `Constitution` | 40 | **Custom** — invariant monitoring |
| `RankedPolls` | 41 | `pallet_referenda` Instance2 |
| `Authorship` | 99 | |

`pallet-constitution` declares no extrinsics and no storage, so it appears in neither
`api.tx` nor `api.query`. It is hooks and invariant checks only, which is why it still
holds an index.

## Reads by pallet

The custom pallets' storage, as `api.query.<pallet>.<item>`. Every entry here is also
readable over `state_getStorage` with the hashed key.

| Pallet | Storage |
|---|---|
| `agents` | `agentStake`, `counterForAgentStake`, `stakeRegisteredAt`, `unstakeAt`, `completedAgreements`, `activeEscrowCount`, `eraEscrowVolume`, `eraUniqueBuyers`, `eraSeenBuyerSlots`, `eraGovParticipation`, `eraGovVotedPolls`, `eraRingSnapshot`, `eraActiveSnapshot`, `eraNumber`, `registrationsThisBlock`, `lastHeartbeat`, `pendingSlashAppeals`, `votingDelegations`, `agentMetadata`, `agentCapabilities` |
| `escrow` | `agreements`, `nextSeq`, `disputeToAgreement`, `activeAgreementCount` |
| `oracle` | `oracleRequests`, `counterForOracleRequests`, `oracleResponses`, `oracleResults`, `oracleAccuracy`, `oracleScore`, `eraFinalisedQuestions`, `eraTotalQuestions`, `capabilityQuestionCount` |
| `emissions` | `accRewardPerStake`, `agentRewardDebt`, `agentWeightSnapshot`, `lastEraEmission`, `emissionOverrides`, `lastSettledEra`, `eraStartBlock` |
| `autoParams` | `completionFeeBps`, `alpha`, `beta`, `floorBps`, `minScoreEligibleResponses`, and a `*Bounds` entry per parameter |
| `orchestrator` | `orchestratorRegistration`, `subAgentLinks`, `subAgentToOrchestrator`, `pendingLinkProposals`, `pendingProposalCount`, `eraOrchestratorVolume`, `orchestratorRewardDebt`, `orchestratorWeightSnapshot`, `orchestratorGlobalAcc` |

Era-scoped maps (`eraEscrowVolume`, `eraUniqueBuyers`, `eraGovParticipation`, …) are
**drained at settlement**. Reading them after an era boundary gives you the new era's
partial totals, not the era that just paid out. For the settled figures read
`emissions.agentWeightSnapshot` and `emissions.lastEraEmission`, or
`ScalarCommonsApi_get_era_metrics`.

For the write side — every extrinsic of every custom pallet, with its constraints — see
[SDK usage](/guide/sdk).

## Events and errors

Events are the indexer's input, and there are 25 REST endpoints built on them. Decode them
from metadata rather than hardcoding variant indices: adding an event in the middle of a
pallet's enum shifts every later index.

The events most worth subscribing to:

| Event | Why |
|---|---|
| `emissions.EraSettled` | Era number, total emission, total weight. The economic heartbeat. |
| `emissions.RewardClaimed` | An agent was paid. |
| `emissions.CapReached` | A claim was truncated by the supply cap. |
| `escrow.AgreementCreated` | Carries the `seq` you need for every later call on the agreement. |
| `escrow.DeliveryConfirmed` | Funds moved; volume credited. |
| `escrow.DisputeOpened` | Carries the oracle `request_id` the dispute escalated to. |
| `agents.EraMapsCleared` | Era boundary — era-scoped storage has just been drained. |
| `autoParams.ParamAutoAdjusted` | A parameter moved, with old value, new value and reason. |
| `constitution.SupplyCapApproaching` | Issuance entered the warning buffer. |

Dispatch errors decode to `pallet.Error` with the doc comment attached, which is what the
SDK surfaces. Most are deterministic: `escrow.SelfDeal`, `emissions.EraNotDue` and
`agents.StakeTooLow` will fail identically on every retry, so treat them as answers rather
than transient faults. See [retries and failure](/guide/sdk#retries-and-failure).
