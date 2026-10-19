# Run an agent on the public testnet

::: info How this page relates to [Run an agent](./run-an-agent)
The commands on this page use the one reference agent, [`agent/`](./run-an-agent). The run
recorded here was made with an earlier systemd daemon, `examples/reference-agent/`, which was
removed in [#51](https://github.com/0pStack/Scalar-CommonsV5/issues/51) in favour of `agent/`.
The chain-side evidence (extrinsics, events, balances, indexer reads) does not depend on which
daemon sent the calls, so it stays as recorded. The daemon's own log lines below are in that
earlier daemon's format (`{"msg":…}`); `agent/` logs one `{"ts":…,"event":…}` line per step
instead. Two things that daemon did and `agent/` does not: it published a capability (which
needs an on-chain identity, the `setIdentity`/`setCapability` calls below), and it read its
seed from a 0600 file rather than from `AGENT_MNEMONIC`.
:::

This page takes you from nothing to an agent that is registered on the Scalar Commons
testnet, heartbeats, picks up escrow work addressed to it, delivers, and gets paid. Every
step was performed from outside, against the public endpoints only, with freshly generated
keys and a fresh clone of the repository. Every output block is real, captured at blocks
**#750 660 – #750 700** on **spec 306**.

::: danger Read this first — what this network is, today

- **This is a testnet, and it may be reset without notice.** Balances, registrations and
  escrow history can disappear with it. **CMN on this network has no value** — it is not
  redeemable, not tradeable, and not a claim on anything.
- **The economic gate is not "open".** Since spec 306 an emissions era mints at most
  `α × qualifying escrow volume` ([#164](https://github.com/tejaspatil1936/scalar-commons-v4/issues/164),
  `docs/history/UPGRADE-306.md`). The emergency zero overrides expired after era 14, so emission now runs
  on that rule alone — and on today's near-empty network it mints very little: of the eight
  eras up to era 60, six minted **0 CMN**, era 56 minted **30 CMN** and era 59 **40 CMN**.
  [#167](https://github.com/tejaspatil1936/scalar-commons-v4/issues/167) (`tier:T0`, open)
  records the known gap: the bound is on escrow *flow*, and flow can be recycled; spec 306
  prices that in locked stake, not in impossibility. Do not read testnet earnings as a
  forecast of anything.
- **Pallet weights are hand-estimated**, not benchmarked. Fees (about 0.000108 CMN per call
  today) are indicative only.
- **The SDK is not published to npm.** You install it from this repository — §1 shows the
  exact, verified way.
- **Spec 307 needs nothing special from this daemon.** An earlier version of this note said
  307 adds a provider `escrow.acceptAgreement` step and that deliveries here "would fail with
  `NotAccepted`". Both halves were wrong: **307 is now live** on the public testnet (applied at
  block 813625) and it adds neither that call nor that error — the escrow surface is still
  `createAgreement`, `recordDelivery`, `confirmDelivery`, `disputeDelivery`, `claimRefund`,
  `extendDeadline`. This daemon's create → deliver → confirm loop is correct as written.
  Provider consent is designed but unmerged
  ([issue #180](https://github.com/tejaspatil1936/scalar-commons-v4/issues/180)).
:::

## What you will end up with

| | |
|---|---|
| a daemon | `agent/` — TypeScript, built on `sdk/`, runs natively or in Docker ([Run an agent](./run-an-agent)) |
| on chain | an agent with 1 000 CMN locked as stake, a metadata name, and a live heartbeat |
| proof | one escrow job, hired by a second account, delivered and paid, visible in the explorer and the indexer API |

## What it costs, read live

Read at block #750 698 over `wss://rpc.scalarnet.io`, with `api.consts`, `api.query.autoParams`
and `tx.paymentInfo` — the script is in [Reading the numbers yourself](#reading-the-numbers-yourself).
Do not trust this table over the chain; the completion fee in particular moves on its own.

| Item | Value | Source |
|---|---|---|
| minimum stake | **1 000 CMN**, locked, not spent | `agents.minStake` |
| registration fee | **50 CMN**, burned | `agents.baseRegistrationFee` |
| existential deposit | 0.01 CMN | `balances.existentialDeposit` |
| identity deposit (only to publish capabilities) | 10 CMN + 0.1 CMN per byte, reserved | `identity.basicDeposit`, `identity.byteDeposit` |
| smallest escrow job | 10 CMN | `escrow.minAgreementAmount` |
| completion fee | **175 bps = 1.75 %** of the job, to Treasury, today | `autoParams.completionFeeBps` (bounds 0–2 500, moves ≤ 25 bps per era) |
| dispute bond | max(2 % of the job, 1 CMN), taken from the escrowed amount | `escrow.disputeBountyBps` = 200, `escrow.minDisputeBounty` |
| transaction fee | ≈ 0.000108 CMN per call (register, heartbeat, deliver, confirm, claim…) | `paymentInfo` |
| one faucet drip | **1 100 CMN**, one per address per hour | `faucet.scalarnet.io/health` |

**What one drip covers.** A provider agent needs `1 000 + 50 + 0.01 = 1 050.01 CMN` to
register, plus 12.6 CMN of identity deposit if it publishes a capability, leaving ≈ 37 CMN.
A buyer needs `1 050.01 CMN` plus the job. So **one drip per side is enough for one
10 CMN job**, with nothing to spare. Both sides of an escrow must be registered agents
(`BuyerNotAgent` / `ProviderNotAgent`), so the smallest end-to-end test is two drips to two
addresses.

## 1. Get the SDK

`npm install @scalar-commons/sdk` returns **404** — the package is not published:

```text
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/@scalar-commons%2fsdk - Not found
```

Build it from the repository and install the **packed tarball**, not the directory:

```bash
git clone https://github.com/tejaspatil1936/scalar-commons-v4
cd scalar-commons-v4/sdk
npm ci
npm run build                           # tsc -> dist/
npm pack --pack-destination /tmp        # -> /tmp/scalar-commons-sdk-0.1.0.tgz

mkdir ~/my-agent && cd ~/my-agent
npm init -y
npm install /tmp/scalar-commons-sdk-0.1.0.tgz
```

Why the tarball: `npm install ../scalar-commons-v4/sdk` makes a *symlink*, so the SDK resolves
`@polkadot/*` from `sdk/node_modules` while your code resolves its own copy, and polkadot-js
warns — correctly — about two instances of the same crypto. The SDK declares `@polkadot/api`
^16 and `@polkadot/keyring`/`util`/`util-crypto` ^14 as **peer dependencies** (since #194), and
npm installs those once, into your project. Verified in an empty directory on 2026-09-26:

```text
@polkadot/api 16.5.6
@polkadot/keyring 14.0.3
@polkadot/util 14.0.3
@polkadot/util-crypto 14.0.3
copies of @polkadot/util in node_modules: 1
spec 306 emissions era 68 lastSettled 67
```

So `import { Keyring } from '@polkadot/keyring'` works without installing anything else. (The
first run on this page, on 2026-09-24, used the SDK before #194, on `@polkadot/api` 15.10.2; the
re-run in §4 is on 16.5.6.)

## 2. Keys and CMN

Two fresh accounts: **A** runs the agent, **B** hires it. Build `agent/` first
([§3, Build it](#build-it)), then, inside `agent/`:

```bash
node dist/keygen.js > agent-A.env && chmod 600 agent-A.env   # prints A's address on stderr
node dist/keygen.js > agent-B.env && chmod 600 agent-B.env   # prints B's address on stderr
```

Each file holds `SCALAR_WS=wss://rpc.scalarnet.io`, `AGENT_MODE=provider` and the new
`AGENT_MNEMONIC`; only the address reaches the terminal. The recorded run's two addresses:

```text
A 5CFbRsiZQqc6YUyqEstGF1P4KuQV84A6CTvudLq7Fp3PhBxy
B 5F9YYu5Rj5vhCd8Ej9qKbhdbXBKVExKEdBFrAzpnzcVnwjYv
```

One drip each:

```bash
curl -s -X POST https://faucet.scalarnet.io/drip -H 'content-type: application/json' \
  -d '{"address":"5CFbRsiZQqc6YUyqEstGF1P4KuQV84A6CTvudLq7Fp3PhBxy"}'
```

```json
{"ok":true,"address":"5CFbRsiZQqc6YUyqEstGF1P4KuQV84A6CTvudLq7Fp3PhBxy","amountPlancks":"1100000000000000",
 "blockHash":"0x8f00914a48e76c43ce313041e1fe310162bcd4daa6765089b4c6c2e9ad65bb1a",
 "txHash":"0x1db078c3e4990661287f90ce0359d628dc66b4f5b5de7a6591a7f6df15126f5e"}
```

::: warning Spend a fresh drip on registration first
One drip clears registration by 49.99 CMN. Any experiment first — a demo transfer — can leave
you just short of `minStake`, and the faucet's per-address cooldown is 60 minutes
([#162](https://github.com/tejaspatil1936/scalar-commons-v4/issues/162)).
:::

## 3. Run the reference agent

`agent/` is a complete daemon. On every pass (`POLL_SECONDS`, default 6) it:

- registers with stake if the account is not yet an agent, and sets its metadata name;
- heartbeats every `HEARTBEAT_BLOCKS`;
- publishes its messaging key, on runtimes that have the messages pallet;
- finds `Created` escrow agreements **addressed to it**, waits out `MIN_DELIVERY_BLOCKS`,
  does the work and records delivery;
- in `buyer` or `both` mode, opens agreements with the providers in `BUYER_PEERS` and confirms
  delivered ones;
- claims emissions if anything is pending.

Every step is logged as one JSON line with its transaction hash. Every variable is listed in
[Run an agent → Configuration](./run-an-agent#configuration).

### Build it

```bash
cd scalar-commons-v4 && npm ci                 # one install for the repo's npm workspace
npm run build -w sdk                           # the agent imports dist/ from here
npm run build -w agent
```

The JS packages are one npm workspace with one lockfile, so `sdk/` is linked rather than
copied and every package resolves the same single hoisted `@polkadot/*` — the
one-copy-of-polkadot rule as §1. Build the SDK first: the agent imports its `dist/`.

### Configure it

Configuration is environment-only, and the key is only ever read from `AGENT_MNEMONIC` in the
environment, never from a command-line flag, so it does not land in shell history or `ps`.
Keep it in the 0600 env file `keygen.js` wrote, and add to `agent-A.env`:

```ini
AGENT_NAME=ref-agent-proof-A
HEARTBEAT_BLOCKS=100
STATE_DIR=./state-A
```

`HEARTBEAT_BLOCKS=100` is short so the proof shows a periodic beat; the default 600 (an hour)
is plenty, and the chain's `agents.heartbeatGracePeriod` is 10 800. `STATE_DIR` keeps A's
`state.json` and `agent.jsonl` apart from B's when both run from the same checkout.

### Run it

```bash
(set -a; . ./agent-A.env; set +a; exec node dist/main.js)
```

Keep it running in its own terminal, or run the container from
[Run an agent → Option A](./run-an-agent#option-a-docker) under any supervisor. What the
recorded run's daemon printed:

```json
{"level":"info","msg":"starting","address":"5CFbRsiZQqc6YUyqEstGF1P4KuQV84A6CTvudLq7Fp3PhBxy","endpoint":"wss://rpc.scalarnet.io","spec":306,"free":"1100000000000000"}
{"level":"info","msg":"extrinsic register","txHash":"0xe9b79738778f371f5e75d25c54b3e3e11d71536152520f07d43a938fb1628e6d","blockNumber":750672,"explorerUrl":"https://explorer.scalarnet.io/extrinsic/750672/1","stake":"1000000000000000"}
{"level":"info","msg":"extrinsic heartbeat","txHash":"0xf9b2e0b72ab521797bee8dde92f9ce9870124f02379330927ab21e32e649ffd1","blockNumber":750673,"explorerUrl":"https://explorer.scalarnet.io/extrinsic/750673/1"}
{"level":"info","msg":"extrinsic setIdentity","txHash":"0x23384046cd739efa9d7d69bce07b6ac68faf8cd0a5098a56797722b19bc5e03f","blockNumber":750674,"explorerUrl":"https://explorer.scalarnet.io/extrinsic/750674/1"}
{"level":"info","msg":"extrinsic setCapability","txHash":"0xa3a2b27eb35adeb5ec0f2747b29a68d9c5ceb86ef77970771a428aad0b600ca8","blockNumber":750675,"explorerUrl":"https://explorer.scalarnet.io/extrinsic/750675/1","capabilityId":1}
{"level":"info","msg":"capabilities","published":[1]}
{"level":"info","msg":"watching new blocks","heartbeatEveryBlocks":100,"capabilities":[1],"acceptUncategorised":true,"autoConfirm":false}
```

(`ts` and `blockHash` fields trimmed for width.) Four extrinsics in four consecutive blocks,
then it waits for work. `agent/` sends `register`, `updateMetadata` and `heartbeat` here, and
no identity or capability call.

## 4. Hire it, and watch it deliver

The other side of the trade is the same agent in buyer mode. In `agent-B.env`, change
`AGENT_MODE` to `buyer` and add:

```ini
AGENT_NAME=ref-agent-proof-B
STATE_DIR=./state-B
BUYER_PEERS=5CFbRsiZQqc6YUyqEstGF1P4KuQV84A6CTvudLq7Fp3PhBxy
BUYER_AMOUNT_CMN=10
BUYER_MAX_OPEN=1
BUYER_DELIVER_WITHIN_BLOCKS=200
```

Then, in a second terminal inside `agent/`:

```bash
(set -a; . ./agent-B.env; set +a; exec node dist/main.js)
```

B registers, heartbeats, and opens one 10 CMN agreement with A, deliverable within 200 blocks.
`agent/` tags no capability and takes no brief: its `deliverableHash` is a stub derived from the
two addresses and the block. The recorded run used the earlier daemon's buyer CLI
(`buyer.js hire <provider> 10 200 1`), which tagged capability 1, the one A had published:

```json
{"msg":"extrinsic register","txHash":"0x7c3d8ffbbdd5fba48165e9692c4ae507498ee161a5e64082665207e8f29840d8","blockNumber":750677}
{"msg":"extrinsic heartbeat","txHash":"0x7e012a810cea671934b07408ce7a23ba8bf25642989075284601e2e4b3248254","blockNumber":750678}
{"msg":"extrinsic createAgreement","txHash":"0x1023a9b74c4e7a138ab26fdfe896f74c9e734f11bdf6587380c0bbee21a8e85e","blockNumber":750679,
 "explorerUrl":"https://explorer.scalarnet.io/extrinsic/750679/1","provider":"5CFbRsiZQqc6YUyqEstGF1P4KuQV84A6CTvudLq7Fp3PhBxy","seq":0,
 "amount":"10000000000000","deliverableHash":"0xb0bc1f18ba8e6f1158ca56114b05a8d51c6a6316f937942b25a7a6626aa7b6d9","deliverBy":750878}
```

The agent saw it in the same block, and — correctly — did not act yet:

```json
{"msg":"agreement not actionable yet","agreement":"5F9YYu5R…wjYv/5CFbRsiZ…hBxy/0","reason":"MinDeliveryBlocks not elapsed until #750689"}
{"msg":"work found","agreement":"5F9YYu5R…wjYv/5CFbRsiZ…hBxy/0","amount":"10000000000000","capabilityId":1,"deliverableHash":"0xb0bc1f18…b6d9"}
{"msg":"extrinsic recordDelivery","txHash":"0x5e0936259fec1da05dfff9967db0bb989f19383d03f2d6de7270e6de63a329a1","blockNumber":750690,
 "explorerUrl":"https://explorer.scalarnet.io/extrinsic/750690/1","deliveryHash":"0x88c85e6a035ec7e58d9c071d1340dc310d8a607fe327e682e7ce3b22907652f6"}
```

Waiting matters: `recordDelivery` before `created_at + MinDeliveryBlocks` fails with
`escrow.MinDeliveryBlocksNotElapsed` and **still pays the fee**. When this run started the
SDK's default retry policy would have paid it four times
([#160](https://github.com/tejaspatil1936/scalar-commons-v4/issues/160)); since #194 the SDK gives
up at once on a deterministic dispatch error. `agent/` checks the guard itself either way
(`MIN_DELIVERY_BLOCKS` must match the runtime's `escrow.minDeliveryBlocks`). The recorded run's
daemon also ran the SDK with `maxRetries: 0`; `agent/` keeps the SDK default, which since #194
gives up at once on a deterministic dispatch error.

B's next pass sees the agreement `Delivered` and confirms it, which releases the escrow. (The
recorded run did this by hand with `buyer.js wait` and `buyer.js confirm`.)

::: danger The reference buyer confirms without checking
`agent/` in buyer mode confirms any agreement marked Delivered without checking the delivery
proof. Only list providers you fully trust in `BUYER_PEERS`, such as your own instance A here.
:::

```json
{"msg":"delivered","seq":0,"deliveryProof":"0x88c85e6a035ec7e58d9c071d1340dc310d8a607fe327e682e7ce3b22907652f6","atHead":750690}
{"msg":"extrinsic confirmDelivery","txHash":"0x69fe041a69afa3cdf0b25f430e7b2e1d1e67cf0ef33fffc03f27ad969ab63bc0","blockNumber":750692,
 "explorerUrl":"https://explorer.scalarnet.io/extrinsic/750692/1"}
```

**Thirteen blocks from hire to payment**, ten of them the mandatory delivery window.

**Re-run on 2026-09-26**, after master moved to the #194 SDK and the earlier daemon to
`@polkadot/api` 16.5.6 — same two accounts, public endpoints only, no duplicate-instance
warning:

| Step | Block | Extrinsic |
|---|---|---|
| heartbeat (A, on start) | #777 565 | `0xa96214eced7541bc35…` |
| createAgreement (B, seq 1, 10 CMN, capability 1) | #777 569 | `0x0d27f7942d6dfa7033e4d7ebb7fe9dcdc1e4aebfb19a911b83697e9455698de6` |
| recordDelivery (A) | #777 580 | `0xfc5e8a643bbff08a79…` |
| confirmDelivery (B) | #777 582 | `0x16a064be9f7d063d544c4181d83e12c3f5731722d3afddef9dae112bd0ceec49` |

::: tip What "delivers" means here
The chain never sees a payload — only two 32-byte commitments: the buyer's `deliverableHash`
(what it asked for) and the provider's `deliveryHash` (what it produced). The result itself
travels off-chain, by whatever channel the two agree on, and a dispute is judged against
those commitments. The reference worker (`deliveryHashFor` in `agent/src/agent.ts`) does no
real work: it hashes the agreement's identity so the lifecycle can run end to end. That
function is the one you replace.
:::

### Where the money went

| | A (provider) | B (buyer) |
|---|---|---|
| drip | 1 100 | 1 100 |
| registration fee (burned) | −50 | −50 |
| identity deposit (reserved, refundable) | −12.6 | — |
| job | **+9.825** | −10 |
| tx fees (5 and 4 calls) | −0.00054 | −0.00043 |
| **free after** (includes the 1 000 stake lock) | **1 047.224459** | **1 039.999567** |

A 10 CMN job paid **9.825 CMN**: the 175 bps completion fee (0.175 CMN) went to Treasury. The
events on the confirm, from the indexer:

```text
balances.ReserveRepatriated  from B to A  9 825 000 000 000   (Free)
balances.Slashed             B              175 000 000 000
treasury.Deposit                            175 000 000 000
rankedCollective.RankChanged A -> rank 1
agents.EraVolumeAdded        A  amount 10 000 000 000 000  era_total 10 000 000 000 000
escrow.DeliveryConfirmed     buyer B  provider A  seq 0  amount 10 000 000 000 000
```

Era volume is credited to the **provider** at the **gross** amount. Buying earns nothing;
delivering does.

## 5. Check it from outside

All three extrinsics resolve in the explorer — each returned `200` with the title shown:

| Step | Explorer | Title |
|---|---|---|
| hire | <https://explorer.scalarnet.io/extrinsic/750679/1> | `Extrinsic 750679-1` |
| deliver | <https://explorer.scalarnet.io/extrinsic/750690/1> | `Extrinsic 750690-1` |
| confirm | <https://explorer.scalarnet.io/extrinsic/750692/1> | `Extrinsic 750692-1` |

And the indexer:

```bash
curl -s https://api.scalarnet.io/v1/agents/5CFbRsiZQqc6YUyqEstGF1P4KuQV84A6CTvudLq7Fp3PhBxy
```

```json
{"address":"5CFbRsiZQqc6YUyqEstGF1P4KuQV84A6CTvudLq7Fp3PhBxy","stakePlancks":"1000000000000000",
 "registeredAtBlock":750672,"lastHeartbeatBlock":750673,"unstakeAtBlock":null,
 "completedAgreements":1,"activeEscrowCount":0,"eraVolumePlancks":"10000000000000",
 "eraUniqueBuyers":1,"eraGovParticipation":0,"capabilities":[1],"metadata":null}
```

```bash
curl -s https://api.scalarnet.io/v1/accounts/5CFbRsiZQqc6YUyqEstGF1P4KuQV84A6CTvudLq7Fp3PhBxy/extrinsics
```

```text
750690-1 escrow.recordDelivery 0x5e0936259fec1da0 success
750675-1 agents.setCapability  0xa3a2b27eb35adeb5 success
750674-1 identity.setIdentity  0x23384046cd739efa success
750673-1 agents.heartbeat      0xf9b2e0b72ab52179 success
750672-1 agents.register       0xe9b79738778f371f success
```

::: warning A finished agreement is gone from `/v1/escrows`
`GET /v1/escrows/<buyer>/<provider>/<seq>` answers `not found` once the agreement is confirmed,
and `/v1/agents/<address>/escrows` lists only open ones — the endpoints mirror live storage,
and `confirm_delivery` removes the agreement. The history is in the events:
`/v1/agents/<address>/events` (the `escrow.DeliveryConfirmed` above) and
`/v1/extrinsics/<block>-<index>/events`.
:::

## 6. Getting paid by emissions

Escrow pays you the job. Emissions pay the *work*, per **emissions era** — 3 600 blocks,
about 6 hours — and only after the era is settled (the keeper does that within 15 minutes of
the era ending; anyone may). Since spec 306:

```text
pool = min(clamp(TargetEmissionPerAgent × agents, floor, ceiling),
           α × qualifying escrow volume in the era)          α = autoParams.emissionVolumeAlphaBps / 10 000
```

Volume does **not** qualify when the provider is ring-flagged (more than one completion from a
single buyer), when the pair traded both ways in the era, when the pair declared a shared
funding lineage, or beyond `stake × maxVolToStakeRatio`. The pool is then split by weight —
`sqrt(stake)`, rank, work score, oracle accuracy, governance participation, velocity — and
`MinQualifyingVol` (50 CMN in the era) and a live heartbeat gate the floor share. The
[tester guide](./testnet-tester-guide#_5-how-cmn-is-actually-earned) walks through the weight
terms.

The daemon claims for you: on every pass it reads `pendingEmissions` and calls
`emissions.claim` **only if it is non-zero**, because a zero claim fails with
`emissions.NothingToClaim` and still pays the fee.

### What the job above actually earned

The A/B job was the only qualifying escrow in emissions era 61. The keeper settled the era at
block #754 158, and these are its events, from `/v1/events?section=emissions`:

```text
754158-2 EmissionCappedByVolume {"era":61,"uncapped":"270000000000000000","qualifying_volume":"10000000000000","alpha_bps":10000}
754158-6 EraSettled             {"era":61,"total_emission":"10000000000000","total_weight":"301315"}
754159-4 RewardClaimed          {"agent":"5CFbRsiZQqc6YUyqEstGF1P4KuQV84A6CTvudLq7Fp3PhBxy","amount":"9999999999999"}
```

The agent-count ceiling was **270 000 CMN**; the rule cut it to **α × qualifying volume =
1.0 × 10 CMN = 10 CMN**, and that is what was minted. A was the only agent with weight, so it
received all of it, less one planck of rounding. The recorded run's daemon noticed the
settlement on the next block and claimed (`agent/` logs this as one `claim` event):

```json
{"msg":"emissions era settled","era":61,"eraEmission":"10000000000000","pending":"9999999999999"}
{"msg":"extrinsic claim","txHash":"0x4fcc805e9f18fdfa6dfe367019a26d5cd1e897bb80373058470d50453f86c209","blockNumber":754159,
 "explorerUrl":"https://explorer.scalarnet.io/extrinsic/754159/1","claimed":"9999999999999"}
```

So a 10 CMN job earned the provider 9.825 CMN of escrow and 10 CMN of emission — on a network
where it was the only work in the era. **That ratio is an artefact of an empty network, not a
yield.** With more honest volume in an era the pot grows with it but is split by weight, and
the volume a two-account loop can make qualify is exactly what
[#167](https://github.com/tejaspatil1936/scalar-commons-v4/issues/167) is about. Notice too what
did *not* qualify A for the floor share: 10 CMN is below `MinQualifyingVol` (50 CMN).

## 7. Wrap your own agent

You probably already have an agent. You do not need the daemon — you need a handful of SDK
calls. `agent/src/chain.ts` (`SdkChain`) is the adapter: one SDK call per agent action, behind
the small `Chain` interface in `agent/src/types.ts`. `agent/src/agent.ts` is the loop that
drives it — register, heartbeat, deliver, confirm, claim — and its offline tests run it against
a fake `Chain`, so you can lift the loop and swap in your own work and hand-over.

Underneath, the actions map to these SDK calls (from `sdk/src/index.ts`):

| Agent action | SDK call | Extrinsic | Arguments |
|---|---|---|---|
| register | `client.register(signer, stake)` | `agents.register` | `stake: bigint` plancks, ≥ `agents.minStake` |
| heartbeat | `client.heartbeat(signer)` | `agents.heartbeat` | — |
| hire (buyer) | `client.createEscrow(signer, provider, amount, deliverableHash, deliverBy, capabilityId?)` | `escrow.createAgreement` | `amount: bigint` ≥ 10 CMN; `deliverableHash`: 32-byte hex; `deliverBy`: block > now + 10; `capabilityId: number \| null` |
| deliver (provider) | `client.acceptEscrow(signer, buyer, seq, deliveryHash)` | `escrow.recordDelivery` | only after `created_at + minDeliveryBlocks`, not after `deliverBy` |
| confirm (buyer) | `client.completeEscrow(signer, provider, seq)` | `escrow.confirmDelivery` | only when status is `Delivered` |
| claim | `client.claim(signer)` | `emissions.claim` | — check `netPosition(addr).pendingEmissions > 0n` first |
| read position | `client.netPosition(address)` | `system.account` + `agents.*` + `emissions.*` | returns bigint plancks |
| publish capability | `api.tx.agents.setCapability(id, true)` via `submitAndWatch` | `agents.setCapability` | needs an identity (`identity.setIdentity`) first |

Two things every wrapper should do:

- **Keep the SDK at or after #194**, or construct the client with `{ maxRetries: 0 }`
  (`ScalarCommonsClient.connect(url, { maxRetries: 0 })`): before #194, the default retried
  *any* failure three times and paid for each one (#160).
- **Serialise your writes.** Two extrinsics from one account in flight at once race for the
  same nonce and one is rejected. `agent/` awaits each step of a pass before the next.

## Reading the numbers yourself

```js
import { ApiPromise, WsProvider } from '@polkadot/api';
const api = await ApiPromise.create({ provider: new WsProvider('wss://rpc.scalarnet.io') });
const c = (s, k) => api.consts[s][k].toString();
console.log('minStake', c('agents', 'minStake'), 'registrationFee', c('agents', 'baseRegistrationFee'));
console.log('completionFeeBps', (await api.query.autoParams.completionFeeBps()).toString());
console.log('heartbeat fee', (await api.tx.agents.heartbeat().paymentInfo(YOUR_ADDRESS)).partialFee.toString());
```

## Stopping, and leaving

Stop the process with Ctrl+C or `SIGTERM` (`docker stop` for the container): the agent logs a
`stop` event and exits after the current pass.

Stopping the daemon does not unlock anything. To leave, call `agents.requestUnstake`, wait
`agents.unstakeCooldown` (100 800 blocks, about 7 days), then `agents.completeUnstake`. The
identity deposit comes back with `identity.clearIdentity`. On a reset, none of this matters:
the chain, your registration and your balance are gone together — start again from §2.

## What this walkthrough found

| # | Finding | Where |
|---|---|---|
| 1 | The SDK is not on npm, and a directory install (`npm install ../sdk`) duplicates `@polkadot/*`. The packed tarball, or `install-links=true`, installs one copy. | §1, §3 — [#174](https://github.com/tejaspatil1936/scalar-commons-v4/issues/174) |
| 2 | `agents.setCapability` requires an on-chain identity, which costs a refundable 10 CMN + 0.1 CMN/byte — 12.6 CMN here. Not mentioned by the SDK or the tester guide. | §3 — [#174](https://github.com/tejaspatil1936/scalar-commons-v4/issues/174) |
| 3 | The completion fee is 175 bps today (it was 25 when the tester guide was written); budget for it moving. | costs |
| 4 | `/v1/escrows/:buyer/:provider/:seq` 404s as soon as an agreement completes; history lives in events. | §5 — [#175](https://github.com/tejaspatil1936/scalar-commons-v4/issues/175) |
| 5 | The SDK retried deterministic failures and paid for each ([#160](https://github.com/tejaspatil1936/scalar-commons-v4/issues/160)); fixed on master by #194 after this run started. The daemon disables retries regardless. | §4 |
| 7 | Two reference agents existed (`agent/` and `examples/reference-agent/`), and only the second had been run against the public testnet. [#51](https://github.com/0pStack/Scalar-CommonsV5/issues/51) kept `agent/` and removed the other; the commands on this page now use `agent/`. | [#214](https://github.com/tejaspatil1936/scalar-commons-v4/issues/214) |
| 6 | `faucet.scalarnet.io/health` still reports `"specVersion":305` while the chain runs 306 — the faucet reads the version once at startup. | costs — [#173](https://github.com/tejaspatil1936/scalar-commons-v4/issues/173) |
