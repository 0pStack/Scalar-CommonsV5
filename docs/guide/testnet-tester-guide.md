# Testnet tester guide

Everything on this page was performed against the public endpoints, from a throwaway
directory, using freshly generated keys — no developer key, no `sudo`, no loopback RPC except
where a step is *only* possible on loopback and says so. Every command is copy-pastable and
every output block is real output, captured while writing this page against **spec 305** at
block ~534 500.

Where a step did not work, or worked only barely, this page says so and links the issue. A
tester guide that hides its own friction is not a test.

::: warning Read this before you spend any time here

- This is a **public testnet**. It **may be reset without notice**, and any balance,
  agent registration or escrow history you build can disappear with it.
- **CMN on this network has no value.** It is not redeemable, not tradeable, and not a
  claim on anything. Do not buy it from anyone; there is nothing to buy.
- The **economic gate is OPEN** — emissions are live and settling (era 2 settled under
  observation while this page was written, paying 110 000 CMN), but the full live economic
  run is still pending. The numbers you observe are early data on a near-empty network, not
  a track record, and §5 shows exactly how misleading they can be.
- **Pallet weights are hand-estimated**, not benchmarked. Fees and block capacity on this
  network are indicative only and will change.
- The chain still identifies itself as `Scalar Commons Local Testnet` with
  `chainType: Local`. That name is a leftover from its origin as a single-host devnet, not
  a statement that it is private.
:::

## The endpoints

| What | URL |
|---|---|
| JSON-RPC (WebSocket) | `wss://rpc.scalarnet.io` |
| Indexer REST API | `https://api.scalarnet.io` |
| Faucet | `https://faucet.scalarnet.io` |
| Explorer | `https://explorer.scalarnet.io` |
| Raw chain spec | `https://scalarnet.io/docs/chainspec.json` |

A quick liveness check, and the two facts worth knowing before anything else:

```bash
curl -s -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"system_chain","params":[]}' \
  https://rpc.scalarnet.io
```

```json
{"jsonrpc":"2.0","id":1,"result":"Scalar Commons Local Testnet"}
```

```bash
curl -s https://faucet.scalarnet.io/health
```

```json
{
  "ok": true,
  "chain": "Scalar Commons Local Testnet",
  "specName": "scalar-commons",
  "specVersion": 305,
  "tokenSymbol": "CMN",
  "tokenDecimals": 12,
  "faucetAddress": "5Ff3A2zFHT5zYujb2gaF4s8z5CALoCdizSVstTqTtttCjezQ",
  "faucetFreePlancks": "5000000000000000000",
  "dripAmountPlancks": "1100000000000000",
  "reservePlancks": "1000000000000000"
}
```

**1 CMN = 10¹² plancks.** Every balance in every API on this chain is in plancks, and it
crosses the wire as a **string** — JSON numbers are IEEE doubles and would silently round a
real balance. Parse them with `BigInt`, never `Number`.

## Set up a workspace

```bash
mkdir -p /tmp/scalar-tester && cd /tmp/scalar-tester
npm init -y
npm install @polkadot/api@16.5.6
```

::: tip Install `@polkadot/api` alone — do not add `keyring` and `util-crypto` yourself
`@polkadot/api` pins the exact `@polkadot/keyring`, `@polkadot/util` and
`@polkadot/util-crypto` it was built against, and npm hoists them where your own code can
import them. Asking for them explicitly is how you get two copies:

```text
@polkadot/util has multiple versions, ensure that there is only one installed.
    esm 13.5.9    node_modules/@polkadot/keyring/node_modules/@polkadot/util/
    esm 14.0.3    node_modules/@polkadot/util/
```

That warning is not cosmetic — duplicated WASM crypto is a real source of signature
failures. Installing only `@polkadot/api@16.5.6` yields one clean set (`keyring`, `util`
and `util-crypto` all at 14.0.3) and no warning.
:::

## 1. Make a wallet

Two accounts, because the escrow flow in §4 genuinely needs two — see the note there.

```js
// 01-keys.mjs
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady, mnemonicGenerate } from '@polkadot/util-crypto';
import { writeFileSync } from 'node:fs';

await cryptoWaitReady();
const keyring = new Keyring({ type: 'sr25519', ss58Format: 42 });

const accounts = {};
for (const name of ['A', 'B']) {
  const mnemonic = mnemonicGenerate(12);
  const pair = keyring.addFromUri(mnemonic, { name }, 'sr25519');
  accounts[name] = { mnemonic, address: pair.address };
  console.log(`${name}: ${pair.address}`);
}
writeFileSync('accounts.json', JSON.stringify(accounts, null, 2));
```

```bash
node 01-keys.mjs
```

```text
A: 5HittaW1bxyNsuCd6zxJd84D1Td4UDUMBgAY54fUEs4fmt8x
B: 5GBZjWmRwC2K2D9u9X7wusNgwwxRtNoYcJWjPVVshF9ZvxT9
```

`ss58Format: 42` is the chain's prefix (`system.ss58Prefix = 42`), so addresses start with
`5`. Those are the two accounts used for the rest of this page.

::: warning `accounts.json` holds unencrypted mnemonics
Fine for a throwaway testnet directory under `/tmp`; never do this with a key that matters.
:::

## 2. Get CMN from the faucet

The faucet is three endpoints, and it dispenses from a pre-funded account — it is **not** a
mint path. All minting on this chain goes through the emissions pallet, and a faucet that
could mint would be a hole in the supply cap.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/drip` | `{"address":"5..."}` → dispenses one drip |
| `GET` | `/balance/:address` | live free balance, in plancks |
| `GET` | `/health` | chain, spec version, drip size, funding balance |

```bash
A=5HittaW1bxyNsuCd6zxJd84D1Td4UDUMBgAY54fUEs4fmt8x
curl -s -X POST https://faucet.scalarnet.io/drip \
  -H 'content-type: application/json' \
  -d "{\"address\":\"$A\"}"
```

```json
{"ok":true,"address":"5HittaW1bxyNsuCd6zxJd84D1Td4UDUMBgAY54fUEs4fmt8x",
 "amountPlancks":"1100000000000000",
 "blockHash":"0xa04b8e48c021345c21c58e8cd0ed11d5307f99a1f22661192e9bf9e9792e424e",
 "txHash":"0x45c5f891971ffb9a93d84a59e559aef9137797c5a3a80278b71ad3daa846d1f2"}
```

**1 100 CMN**, and the response already carries the block it landed in. Watching it arrive
over the WebSocket instead of trusting the HTTP response:

```js
// 02-drip.mjs
import { ApiPromise, WsProvider } from '@polkadot/api';
import { readFileSync } from 'node:fs';

const { A } = JSON.parse(readFileSync('accounts.json', 'utf8'));
const api = await ApiPromise.create({ provider: new WsProvider('wss://rpc.scalarnet.io') });

const t0 = Date.now();
const res = await fetch('https://faucet.scalarnet.io/drip', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ address: A.address }),
});
console.log('POST /drip:', res.status, JSON.stringify(await res.json()));

let landed = null, landedBlock = null;
const unsub = await api.rpc.chain.subscribeNewHeads(async (head) => {
  const acct = await api.query.system.account(A.address);
  if (acct.data.free.toBigInt() > 0n && landed === null) {
    landed = Date.now();
    landedBlock = head.number.toNumber();
  }
});
while (landed === null && Date.now() - t0 < 180000) await new Promise(r => setTimeout(r, 500));
unsub();

const after = await api.query.system.account(A.address);
console.log('balance   :', after.data.free.toString(), 'plancks');
console.log('seen at   : block', landedBlock);
console.log('elapsed   :', landed - t0, 'ms');
await api.disconnect();
```

```text
POST /drip : 200 {"ok":true,...}
A after    : 1100000000000000 plancks = 1100 CMN
seen at blk: 534415
http rtt   : 1309 ms
total      : 1318 ms
```

**Landed at block 534 415, 1.3 seconds end to end** — inside a single 6-second block. The
faucet signs and submits synchronously, so the HTTP response is already the confirmation;
the balance poll is belt-and-braces.

### The rate limits are real

Ask twice for the same address:

```bash
curl -s -i -X POST https://faucet.scalarnet.io/drip \
  -H 'content-type: application/json' -d "{\"address\":\"$A\"}"
```

```text
HTTP/2 429
retry-after: 3588
{"ok":false,"code":"RATE_LIMITED","error":"rate limit reached for this address",
 "scope":"address","retryAfterMs":3587320}
```

| Limit | Value | How I know |
|---|---|---|
| per address | **1 drip / 60 min** | **Observed.** `429`, `scope: "address"`, `retryAfterMs: 3587320` |
| per IP | 5 drips / 60 min | Read from `faucet/src/config.ts` — *not* exercised here; a sixth request should return `429` with `scope: "ip"` |
| reserve floor | 1 000 CMN | Read from `/health` (`reservePlancks: "1000000000000000"`) — *not* exercised |

I deliberately did not hammer the per-IP budget to prove it. It is a drain protection on a
shared faucet, and exhausting it would have locked every other tester on this IP out for an
hour to confirm a number the source already states.

A malformed address is rejected before anything moves: `{"address":"not-an-address"}` → `400`.

::: danger Spend your first drip in the right order
One drip is **1 100 CMN**. Registering as an agent costs **1 050.01 CMN**
(`minStake` 1 000 + `baseRegistrationFee` 50 + existential deposit 0.01). That is a margin
of **49.99 CMN — about 4.5 %**.

Writing this page I did the friendly thing first — a 100 CMN demo transfer (§3) — and left
the sender at 999.9999 CMN, **0.0001 CMN short of `minStake`**. Registration failed, and the
per-address cooldown is 60 minutes.

If you intend to reach §4, **register first and experiment afterwards**, or use a second
address for the demo transfer. Tracked as
[issue #162](https://github.com/tejaspatil1936/scalar-commons-v4/issues/162).
:::

## 3. Send a transfer, and find it

`transferKeepAlive` rather than `transferAll`/`transfer`: it refuses to drop the sender
below the existential deposit, which on a chain where your stake is a *lock inside* your
free balance is the difference between a transfer and a reaped account.

```js
// 03-transfer.mjs
import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { readFileSync } from 'node:fs';

const { A, B } = JSON.parse(readFileSync('accounts.json', 'utf8'));
await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider('wss://rpc.scalarnet.io') });
const a = new Keyring({ type: 'sr25519', ss58Format: 42 }).addFromUri(A.mnemonic);

const AMOUNT = 100n * 10n ** 12n;                     // 100 CMN
const tx = api.tx.balances.transferKeepAlive(B.address, AMOUNT);
console.log('estimated fee:', (await tx.paymentInfo(a)).partialFee.toString());

const out = await new Promise((resolve, reject) => {
  tx.signAndSend(a, ({ status, dispatchError, events, txHash }) => {
    if (dispatchError) return reject(new Error(dispatchError.toString()));
    if (status.isInBlock) resolve({ blockHash: status.asInBlock.toHex(), txHash: txHash.toHex(), events });
  }).catch(reject);
});

const hdr = await api.rpc.chain.getHeader(out.blockHash);
console.log('block:', hdr.number.toNumber(), out.blockHash);
console.log('tx   :', out.txHash);
for (const { event } of out.events) {
  console.log(` ${event.section}.${event.method}`, JSON.stringify(event.data.toHuman()));
}
await api.disconnect();
```

```text
existentialDeposit: 10000000000
estimated fee: 108157147

included in block: 534421 0xad0d5cc2f30d6a7931928e7907131674701ec8441cca15b1fbfc8648bae1dafe
txHash           : 0x44d6f16de33e1d7565e218a0878426583e154c742723a1bbe5ca661a78f4f72d

--- events ---
  balances.Withdraw {"who":"5HittaW1…mt8x","amount":"108,157,147"}
  system.NewAccount {"account":"5GBZjWmR…vxT9"}
  balances.Endowed {"account":"5GBZjWmR…vxT9","freeBalance":"100,000,000,000,000"}
  balances.Transfer {"from":"5HittaW1…mt8x","to":"5GBZjWmR…vxT9","amount":"100,000,000,000,000"}
  transactionPayment.TransactionFeePaid {"who":"5HittaW1…mt8x","actualFee":"108,157,147","tip":"0"}
  system.ExtrinsicSuccess {"dispatchInfo":{"weight":{"refTime":"630,189,000","proofSize":"14,288"},"class":"Normal","paysFee":"Yes"}}
```

The books balance exactly:

| | plancks | CMN |
|---|---|---|
| A before | 1 100 000 000 000 000 | 1 100 |
| A after | 999 999 891 842 853 | 999.999891… |
| **A delta** | **−100 000 108 157 147** | −(100 + fee) |
| B after | 100 000 000 000 000 | 100 |
| fee paid | 108 157 147 | 0.000108 |

`A delta == −(amount + fee)` — no rounding, no dust. The fee is **~0.000108 CMN**, but note
the warning at the top of this page: **weights are hand-estimated, not benchmarked**, so
treat that number as indicative.

### Find it in the explorer

```text
https://explorer.scalarnet.io/extrinsic/534421/1
```

Returns `200`, titled `Extrinsic 534421-1`, showing `transferKeepAlive`, the signer, the
amount `100,000,000,000,000` and the fee `108,157,147`. The other two routes:

```text
https://explorer.scalarnet.io/block/534421
https://explorer.scalarnet.io/account/5HittaW1bxyNsuCd6zxJd84D1Td4UDUMBgAY54fUEs4fmt8x
```

### Find it in the indexer API

The indexer keys extrinsics as `<block>-<index>`:

```bash
curl -s https://api.scalarnet.io/v1/blocks/534421/extrinsics
curl -s https://api.scalarnet.io/v1/extrinsics/534421-1
curl -s https://api.scalarnet.io/v1/accounts/5HittaW1bxyNsuCd6zxJd84D1Td4UDUMBgAY54fUEs4fmt8x
```

```json
{"total":1,"limit":25,"offset":0,"items":[{"isSigned":true,"id":"534421-1",
 "blockNumber":534421,"index":1,
 "hash":"0x44d6f16de33e1d7565e218a0878426583e154c742723a1bbe5ca661a78f4f72d",
 "section":"balances","method":"transferKeepAlive",
 "signer":"5HittaW1bxyNsuCd6zxJd84D1Td4UDUMBgAY54fUEs4fmt8x","nonce":0,
 "tipPlancks":"0","success":true,
 "args":{"dest":{"type":"Id","value":"5GBZjWmRwC2K2D9u9X7wusNgwwxRtNoYcJWjPVVshF9ZvxT9"},
 "value":"100000000000000"}}]}
```

`GET https://api.scalarnet.io/` lists all 24 endpoints. The ones you will want:

| Endpoint | Gives you |
|---|---|
| `/v1/accounts/:address` | balance, nonce, `isAgent`, first/last seen |
| `/v1/accounts/:address/extrinsics` | everything that address signed |
| `/v1/agents/:address` | stake, completions, era volume, heartbeat block |
| `/v1/escrows/:buyer/:provider/:seq` | one agreement |
| `/v1/eras/current` | era number, blocks remaining, whether settlement is due |
| `/v1/emissions` and `/v1/emissions/supply` | emission parameters, cap, issuance |

## 4. Become an agent and run an escrow job

This is the part the chain exists for. The SDK in `sdk/` wraps it.

::: tip Running an agent for real
This section is the by-hand walk. For a daemon that registers, heartbeats, finds work
addressed to it, delivers and claims — run as a systemd service and proven end to end on
spec 306 — see **[Run an agent on the public testnet](./run-an-agent-public-testnet)**.
:::

### Getting the SDK

::: warning The SDK is not published to npm
`npm install @scalar-commons/sdk` returns **404**. So does `@scalar-commons/faucet`. You
must build it from the repository:

```bash
git clone https://github.com/tejaspatil1936/scalar-commons-v4
cd scalar-commons-v4/sdk
npm ci
npm run build          # tsc -> dist/
```

Then, from your tester workspace:

```bash
cd /tmp/scalar-tester
npm install /path/to/scalar-commons-v4/sdk
npm install @polkadot/api@16.5.6     # <- required, see below
```

The second line is **not optional**. `npm install <local-path>` creates a *symlink* and
installs nothing else ("added 1 package"), so your own code cannot import
`@polkadot/keyring` at all:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@polkadot/keyring'
  imported from /tmp/scalar-tester/05-agentflow.mjs
```

You will also see `@polkadot/util has multiple versions` warnings, because the SDK pins
`@polkadot/api ^15` (resolving to 15.10.2) while a current workspace resolves 16.5.6. Both
copies load and the flow below works end to end regardless — signing, submission and event
decoding were all verified against the live chain — but it is noise a published package
would not produce.
:::

### What registration actually costs

Read the numbers off the chain rather than trusting any document, including this one:

```js
const api = await ApiPromise.create({ provider: new WsProvider('wss://rpc.scalarnet.io') });
for (const k of Object.keys(api.consts.agents)) console.log(k, api.consts.agents[k].toString());
```

| Constant | plancks | CMN |
|---|---|---|
| `agents.minStake` | 1 000 000 000 000 000 | **1 000** |
| `agents.baseRegistrationFee` | 50 000 000 000 000 | **50** (burned) |
| `balances.existentialDeposit` | 10 000 000 000 | 0.01 |
| **total to register** | | **1 050.01** |
| `agents.maxStakePerAgent` | 1 000 000 000 000 000 000 | 1 000 000 |
| `agents.unstakeCooldown` | | 100 800 blocks ≈ 7 days |
| `escrow.minAgreementAmount` | 10 000 000 000 000 | 10 |
| `escrow.minDeliveryBlocks` | | 10 blocks ≈ 60 s |

The stake is a **lock**, not a transfer — it stays inside your `free` balance and shows up as
`frozen`. Do not add it to your balance when accounting; the SDK's `netPosition()` is careful
about this and reports `free`, `reserved`, `frozen` and `stake` separately.

::: danger You need TWO registered agents, not one
`escrow.create_agreement` requires **both** sides to be agents:

```rust
ensure!(agents_pallet::Pallet::<T>::is_agent(&buyer),    Error::<T>::BuyerNotAgent);
ensure!(agents_pallet::Pallet::<T>::is_agent(&provider), Error::<T>::ProviderNotAgent);
```

So the minimum escrow demo costs **2 × 1 050.01 = 2 100.02 CMN**, which is exactly two
faucet drips to two different addresses. There is no way to do it with one account, and no
way to do it with one drip.
:::

### Register, and heartbeat immediately

```js
// 05-agentflow.mjs  (excerpt)
import { ScalarCommonsClient, PLANCKS_PER_CMN } from '@scalar-commons/sdk';
const client = await ScalarCommonsClient.connect('wss://rpc.scalarnet.io');
const CMN = PLANCKS_PER_CMN;

await client.register(a, 1000n * CMN);   // agents.register(stake)
await client.register(b, 1000n * CMN);
await client.heartbeat(a);               // agents.heartbeat()   <- do not skip
await client.heartbeat(b);
```

```text
  [start]          A=999.999891842853 CMN  B=1200 CMN
  [after top-up]   A=1064.999891842853 CMN  B=1134.999891842853 CMN
== agents.register (A, stake 1000 CMN) == block=0xbffa13fd…b91a65
== agents.register (B, stake 1000 CMN) == block=0x4761a6a8…f11f7c
  [after register] A=1014.999783685738 CMN  B=1084.999783685738 CMN
A: lastHeartbeat 0 -> 534534
B: lastHeartbeat 0 -> 534535
```

::: danger Registering does not make you "active" — you must heartbeat
`agents::register` never writes `LastHeartbeat`; the only writer in the pallet is
`heartbeat()` itself. A newly registered agent therefore has `LastHeartbeat = 0`, and on a
chain at block ~534 500 the liveness multiplier is computed from a ~534 500-block gap:

```text
since = 534527, grace = 10800, decay = 1296000
pct   = 100 - 90 * 523727 / 1296000 = 63
```

The emissions weight function requires `hb >= 90`:

```rust
let has_heartbeat = hb >= 90;
let is_active = did_work_this_era && has_heartbeat;
let qualifies_for_floor = is_active && (min_qual == 0 || vol_u128 >= min_qual);
```

**63 < 90**, so a fresh agent is born already failing the activity gate and earns **zero**
floor emission for the era — no matter how much real escrow work it does. I confirmed this
live: after registering *and* completing two qualifying jobs, the indexer still reported
`"lastHeartbeatBlock": 0`. One `agents.heartbeat()` call fixed it.

Send a heartbeat immediately after registering. Tracked as
[issue #161](https://github.com/tejaspatil1936/scalar-commons-v4/issues/161).
:::

### The escrow lifecycle

Three calls, in this order, and the middle one has a timing guard:

| Step | SDK | Extrinsic | Who signs |
|---|---|---|---|
| 1 | `createEscrow(b, providerAddr, amount, hash, deliverBy, cap)` | `escrow.createAgreement` | buyer |
| 2 | `acceptEscrow(a, buyerAddr, seq, hash)` | `escrow.recordDelivery` | provider |
| 3 | `completeEscrow(b, providerAddr, seq)` | `escrow.confirmDelivery` | buyer |

::: warning Provider consent and expiry are NOT shipped
An earlier version of this page said spec 307 added `escrow.acceptAgreement`,
`rejectAgreement`, `cancelPending` and `expireAgreement`. **It does not.** Spec 307 is live on
the public testnet and none of those four calls exist in it — nor in spec 309, nor on `master`.
Neither does the `NotAccepted` error the old text referred to.

The complete escrow call list in live spec 307, read from the chain's own metadata:

```text
createAgreement  recordDelivery  confirmDelivery
disputeDelivery  claimRefund     extendDeadline
```

So the lifecycle is exactly the three steps in the table above — create → deliver → confirm.
There is no accept step to wait for, and a provider does not need to consent before you can
`recordDelivery`.

Provider consent and the expiry path are **designed but unmerged**: see
`pallets/escrow/DESIGN-E18-E2.md`, [issue #180](https://github.com/tejaspatil1936/scalar-commons-v4/issues/180)
and PRs [#204](https://github.com/tejaspatil1936/scalar-commons-v4/pull/204) /
[#233](https://github.com/tejaspatil1936/scalar-commons-v4/pull/233). When they ship, this page
gets the table back with a version number that has been checked against a running chain.

**Check for yourself rather than trusting this page** — it is the habit that would have caught
the error above:

```js
console.log(api.runtimeVersion.specVersion.toNumber());
console.log(Object.keys(api.tx.escrow).sort().join(' '));
```

:::

Want a worker that does this loop for you? See [Run an agent](https://scalarnet.io/docs/guide/run-an-agent).

```js
const head = (await api.rpc.chain.getHeader()).number.toNumber();
const deliverableHash = blake2AsHex('scalar-commons tester guide: deliverable v1', 256);
await client.createEscrow(b, A.address, 10n * CMN, deliverableHash, head + 200, null);
// ... wait MinDeliveryBlocks ...
await client.acceptEscrow(a, B.address, 0, deliverableHash);
await client.completeEscrow(b, A.address, 0);
```

```text
== escrow.createAgreement (B buys from A, 10 CMN) == block=0xb5f2f6cb…b79f4
  [after createEscrow] A=1014.999783685738 CMN  B=1074.999675528555 CMN   (10 CMN reserved)
== escrow.recordDelivery (A delivers, seq 0) == block=0xd93f44df…58b162
== escrow.confirmDelivery (B confirms, seq 0) == block=0x0f4e43a5…4ad912
  [after confirm] A free=1024.974242899863 | B free=1074.999567371412 reserved=0
```

::: warning `MinDeliveryBlocks` — you must wait ~60 s before recording delivery
Calling `recordDelivery` straight after `createAgreement` fails:

```text
escrow.MinDeliveryBlocksNotElapsed
```

The guard is `now >= created_at + MinDeliveryBlocks` with `MinDeliveryBlocks = 10` blocks
(~60 s). It exists so an agent cannot create and instantly settle fake jobs to farm escrow
volume — it is load-bearing, not a nuisance.

Worse, **the SDK retries this for you, and each retry costs a fee.** `withRetry` retries on
*any* error with no classification, so a deterministic runtime rejection is re-submitted
three more times:

```text
[scalar-sdk] submit(acceptEscrow) failed on attempt 1/4; retrying { error: 'escrow.MinDeliveryBlocksNotElapsed: ' }
... attempts 2, 3, 4 ...
```

Measured cost: balance fell 432 628 700 plancks over those four attempts, against a single
tx fee of 108 157 147 — **exactly 4.0 fee-paying submissions**. And they could never have
worked: the backoff is 1 s + 2 s + 3 s = 6 s, while the guard needs 60 s.

Wait for the block height yourself before calling `acceptEscrow`. Tracked as
[issue #160](https://github.com/tejaspatil1936/scalar-commons-v4/issues/160).
:::

### Where the money went

The provider received **9.975 CMN of a 10 CMN job**, not 10:

| | |
|---|---|
| agreement amount | 10 CMN |
| completion fee | 25 bps = **0.25 %** = 0.025 CMN → Treasury |
| **provider receives** | **9.975 CMN** |

The rate is not a constant — it is read live from `autoParams.completionFeeBps`, and
auto-params moves it at era settlement within `completionFeeBounds`:

```text
completionFeeBps    = 25       (when the job above settled)
completionFeeBounds = {"min":0,"max":2500,"maxStep":25}
```

**It moved while this page was being written.** At the era-2 settlement it went from 25 to
50 bps — exactly one `maxStep` — so the same 10 CMN job that returned 9.975 CMN above would
now return 9.95 CMN. Nothing was governed by hand; that is `run_era_rules` doing its job.

Read it before you reason about margins, and do not hard-code it:

```bash
# via the SDK's api, or any polkadot-js client:
#   await api.query.autoParams.completionFeeBps()
```

Two more things the flow revealed, both worth knowing:

- **Era escrow volume is credited to the provider only.** After the job, A's
  `eraEscrowVolume` was 10 CMN and B's was **0**. Buying does not earn you emission weight;
  delivering does. That is the thesis working as designed.
- **The gross amount counts toward volume, not the net.** `add_era_escrow_volume` is called
  with `amount`, before the fee is deducted.

### Reading your position

```js
console.log(await client.netPosition(A.address));
```

```json
{
  "free": "1024974242899863",
  "reserved": "0",
  "frozen": "1000000000000000",
  "stake": "1000000000000000",
  "eraEscrowVolume": "10000000000000",
  "pendingEmissions": "0",
  "total": "1024974242899863"
}
```

Note `total` = `free + pendingEmissions` and deliberately does **not** add `stake` — the
stake lives inside `free` as a lock, and adding it would report tokens that were never
issued. There is also no "transferable" figure, because what you can actually move depends
on the existential deposit too, and an advisory number that ignores it is worse than none.

Or over the indexer, with no SDK at all:

```bash
curl -s https://api.scalarnet.io/v1/agents/5HittaW1bxyNsuCd6zxJd84D1Td4UDUMBgAY54fUEs4fmt8x
```

```json
{"address":"5HittaW1…mt8x","stakePlancks":"1000000000000000",
 "registeredAtBlock":534455,"lastHeartbeatBlock":0,"unstakeAtBlock":null,
 "completedAgreements":2,"activeEscrowCount":0,
 "eraVolumePlancks":"60000000000000","eraUniqueBuyers":1,
 "eraGovParticipation":0,"capabilities":[],"metadata":null}
```

## 5. How CMN is actually earned

This is the part most testers get wrong, because two different things on this chain are
called an "era".

| | blocks | wall clock | what it drives |
|---|---|---|---|
| **emissions era** | `emissions.eraDuration` = **3 600** | **≈ 6 h** | CMN emission, agent weight, escrow volume accounting |
| **staking era** | `SessionsPerEra` 6 × `epochDuration` 1 800 = **10 800** | ≈ 18 h | validator set election, bonding |

Everything below is the **emissions** era. Check where you are:

```bash
curl -s https://api.scalarnet.io/v1/eras/current
```

```json
{"era":2,"startBlock":531510,"durationBlocks":3600,"currentBlock":534643,
 "blocksElapsed":3133,"blocksRemaining":467,"dueForSettlement":false,
 "lastSettledEra":1,"ringSnapshot":0,"activeSnapshot":4}
```

### `settle_era` is permissionless, and that is the point

Anyone can call `emissions.settle_era()` — there is no privileged origin, deliberately:

```rust
// Permissionless: any registered agent (or anyone) can trigger settlement.
ensure_signed(origin)?;
ensure!(now >= era_start + T::EraDuration::get(), Error::<T>::EraNotDue);
ensure!(LastSettledEra::<T>::get().is_none_or(|last| era > last), Error::<T>::EraAlreadySettled);
```

Two guards, both load-bearing: `EraNotDue` stops early settlement, and the double-settlement
guard stops the same era minting twice.

In practice you do not need to call it. A **keeper** — an ordinary signed account with no
privilege whatsoever — polls every 15 minutes and submits `settle_era` when it is due. It
re-reads the runtime's own guards each run and exits without submitting (and without paying
a fee) when settlement is not due. If the keeper stops, settlement is *not* blocked; anyone
can still call it. That property is the design, not a workaround.

The cost of permissionless settlement is that if nobody calls it, it never happens — and for
a long stretch nobody did, which is why the keeper exists at all
(`TESTNETAUDIT.md` §6 I-8).

### What `settle_era` pays, and to whom

The era's total emission is a clamp on the number of registered agents:

```text
emission = clamp(TargetEmissionPerAgent × agent_count, FloorEmissionPerEra, InitialEmissionsPerEra)
         = clamp(10 000 × 11, 100 000, 1 000 000)
         = 110 000 CMN
```

With 11 registered agents at the time of writing, `10 000 × 11 = 110 000` sits just above the
100 000 CMN floor. **Note what this does not depend on: how much work was done.** The size of
the pot tracks the agent count; only the *split* tracks work.

That split is weight-proportional, accumulated MasterChef-style:

```rust
delta = emission × 2^64 / total_weight;
AccRewardPerStake::mutate(|acc| *acc += delta);
```

so nothing is pushed to anyone — each agent's share accrues against the accumulator and is
pulled later with `emissions.claim()`.

Per-agent weight is where the thesis lives. It is **not** stake-proportional:

| Input | Effect |
|---|---|
| `sqrt(stake)` | square root, so capital has decreasing returns |
| rank | 1.0× / 1.2× / 1.5× by collective rank |
| era escrow volume × buyer diversity | the `work_score` — the dominant term |
| oracle accuracy | bonus, `OracleBonusBps` = 2 000 (+20 %) |
| governance participation | **multiplies** work; cannot substitute for it (zero work ⇒ zero gov reward) |
| velocity (`era_vol / stake`) | up to `VelocityBonusBps` = 3 000 (+30 %) at full capital deployment |
| onboarding boost | +10 000 bps on completion 1, decaying to +1 000 bps by completion 10 |
| floor share | `floorBps` = 1 000, **gated** — see below |

### The two gates that will silently zero you

```rust
let did_work_this_era = vol_u128 > 0;
let is_active = did_work_this_era && has_heartbeat;      // has_heartbeat = hb >= 90
let qualifies_for_floor = is_active && (min_qual == 0 || vol_u128 >= min_qual);
let effective_floor = if qualifies_for_floor { floor_bps } else { 0 };
```

1. **`MinQualifyingVol` = 50 CMN of escrow volume in the era.** Below it you forfeit the
   floor share. A single minimum-size 10 CMN job is *not* enough — you need 50 CMN. (You can
   still earn a small `work_score` reward below the threshold; it is the floor you lose.)
2. **A live heartbeat.** See the warning in §4 — a freshly registered agent fails this until
   it calls `agents.heartbeat()`.

Reading the live agent set while writing this page, of 11 registered agents only **two** had
any escrow volume in the era, and one of those two had `lastHeartbeat = 0` — so despite 171
lifetime completions and 10 000 CMN staked, it was on course to earn **no floor share at
all**. These gates are not theoretical.

### How you see what you earned

```js
const pos = await client.netPosition(A.address);
console.log('pendingEmissions:', pos.pendingEmissions.toString());
console.log('weight          :', (await client.weightOf(A.address)).toString());
await client.claim(a);        // emissions.claim() -> moves pending into free
```

Or without the SDK:

```bash
curl -s https://api.scalarnet.io/v1/emissions
curl -s https://api.scalarnet.io/v1/emissions/supply
```

```json
{"capPlancks":"100000000000000000000000",
 "totalIssuancePlancks":"6054761378188739061920",
 "remainingPlancks":"93945238621811260938080",
 "percentIssued":6.0547,"tokenSymbol":"CMN","tokenDecimals":12}
```

### What one settled era actually paid

Era 2 settled while this page was being written. The numbers below are the real ones.

```bash
curl -s https://api.scalarnet.io/v1/emissions
```

```json
{"lastSettledEra":2,"lastEraEmissionPlancks":"110000000000000000",
 "accRewardPerStake":"587270607288593617598683139816", ...}
```

**110 000 CMN** — exactly `clamp(10 000 × 11 agents, 100 000, 1 000 000)`, as predicted.
Then, as the agent from §4:

```text
weightOf(A)      : 6953468
pendingEmissions : 90068368362993380
== emissions.claim ==
free after claim : 91143217281421854   (delta +90 068.37 CMN)
```

You can check the split yourself, because the accumulator is public:

```text
accRewardPerStake  era 1 = 348329673019716992730215109268
                   era 2 = 587270607288593617598683139816
                   delta = 238940934268876624868468030548

total_weight = emission × 2^64 / delta = 8 492 232
my weight    =                           6 953 468   ->  81.88 %
payout       = weight × delta / 2^64   = 90 068 368 362 993 380   (matches to the planck)
```

::: danger Read this before you conclude the testnet is printing money for you
That is **81.88 % of an entire era's emission — 90 068 CMN — for 60 CMN of escrow volume
between two accounts I controlled**, on 2 200 CMN of faucet funding.

Nothing was exploited and nothing overflowed: it all flowed through `pallet-emissions`,
and predicted and actual payouts match exactly. It happened because of how the two parts
compose on a near-empty network:

- the **pot is sized by agent count, not by work** — 110 000 CMN was minted for ~120 CMN of
  total escrow volume chain-wide that era, about **917 CMN minted per CMN of real work**;
- the **qualification gates concentrate rather than dilute** — of 11 registered agents,
  most did no escrow at all that era, and the one other agent that did (171 lifetime
  completions, 10 000 CMN staked) was denied the **floor share** by the heartbeat gate, so
  it took 3.79 % of the weight against my 81.88 %.

This is expected to dilute as real agents arrive, and it is filed for a deliberate decision
rather than presented as a feature:
[issue #164](https://github.com/tejaspatil1936/scalar-commons-v4/issues/164) (`tier:T0`).
**Do not read your testnet balance as an indication of what mainnet economics will pay.**
:::

`pendingEmissions` only becomes non-zero **after** an era settles, so a tester who registers,
works, and checks immediately will see zero and think it is broken. It is not — wait for the
era boundary. `emissions.lastSettledEra` is an `Option<u32>`: `null` means nothing has ever
settled, which is *not* the same as era 0.

::: warning The supply cap, and what it is measured against
`SupplyCap` is 10²³ plancks = **100 000 000 000 CMN (100 B)**. Issuance today is ~6.05 B,
about **6.05 %**. Note this does not match the 18 B genesis figure quoted in the project's
own `CLAUDE.md` — this testnet's genesis was ~6.01 B CMN, and the difference between those
two numbers is a documentation discrepancy, not a mint.

The bulk of issuance growth to date was **not** emissions: spec 305 removed staking
inflation after `TotalIssuance` grew by 43.58 M CMN from `pallet-staking` while
`pallet-emissions` minted exactly zero (`TESTNETAUDIT.md` §6 I-2). Emissions are now the
only mint path.
:::

## 6. Run your own full node

You do not have to trust `rpc.scalarnet.io`. Sync your own copy and check the chain against
itself. Everything below was run as an outsider would run it — a throwaway base path, the
**public** IP in `--bootnodes`, and no access to the validators' machines.

### Get the chain spec

The raw spec is published as a static asset alongside these docs:

```bash
curl -sO https://scalarnet.io/docs/chainspec.json
```

It carries the five bootnodes, so `--bootnodes` on the command line is optional — it is
shown below only to make the dial explicit.

::: warning `https://scalarnet.io/docs/<anything>` returns 200
The docs site is a VitePress SPA with a catch-all fallback, so a request for a file that
does not exist still answers `200` with the site's HTML. Do not use a status code to test
whether an asset is published — check the `content-type`:

```bash
curl -s -o /dev/null -w 'ct=%{content_type}\n' https://scalarnet.io/docs/chainspec.json
```

`application/json` means you have the spec; `text/html` means you have the 404 page.
:::

### Bootnodes

| p2p port | multiaddr |
|---|---|
| 30333 | `/ip4/152.53.113.104/tcp/30333/p2p/12D3KooWEyoppNCUx8Yx66oV9fJnriXwCcXwDDUA2kj6vnc6iDEp` |
| 30334 | `/ip4/152.53.113.104/tcp/30334/p2p/12D3KooWHdiAxVd8uMQR1hGWXccidmfCwLqcMpGwR6QcTP6QRMuD` |
| 30335 | `/ip4/152.53.113.104/tcp/30335/p2p/12D3KooWSCufgHzV4fCwRijfH2k3abrpAJxTKxEvN1FDuRXA2U9x` |
| 30336 | `/ip4/152.53.113.104/tcp/30336/p2p/12D3KooWSsChzF81YDUKpe9Uk5AHV5oqAaXAcWNSPYgoLauUk4st` |
| 30337 | `/ip4/152.53.113.104/tcp/30337/p2p/12D3KooWSuTq6MG9gPt7qZqLFKkYrfxMewTZhj9nmRHJkPwzWDG2` |

### Build and run

Building `scalar-node` is covered in [Run a node](/guide/run-a-node) — the toolchain pin is
load-bearing, so read that first. Then:

```bash
mkdir -p /tmp/scalar-tester-node && cd /tmp/scalar-tester-node

./scalar-node \
  --chain ./chainspec.json \
  --base-path /tmp/scalar-tester-node/db \
  --name my-tester-node \
  --port 30340 \
  --rpc-port 9955 \
  --rpc-methods safe \
  --no-telemetry \
  --no-mdns \
  --bootnodes /ip4/152.53.113.104/tcp/30333/p2p/12D3KooWEyoppNCUx8Yx66oV9fJnriXwCcXwDDUA2kj6vnc6iDEp
```

`--rpc-methods safe` keeps the unsafe surface closed even on loopback; `--port 30340` avoids
colliding with a validator's 30333–30337 if you happen to run on the same host.

::: tip Add `--prometheus-port` if 9615 is taken
On a machine already running a node you will see
`Error binding to '127.0.0.1:9615': Address already in use`. It is non-fatal — the node syncs
fine — but pass `--prometheus-port 9616` (or `--no-prometheus`) to keep the log clean.
:::

### What it actually did

```text
📋 Chain specification: Scalar Commons Local Testnet
👤 Role: FULL
🔨 Initializing Genesis block/state (state: 0xe20e…abd1, header-hash: 0xff68…03d1)
🏷  Local node identity is: 12D3KooWCHpEUFrda1bfC1HXh43X7tcfo3xrSXmx4Quegcsg7ZJU
📦 Highest known block at #0
⚙️  Syncing, target=#534511 (5 peers), best: #5644, ⬇ 415.3kiB/s
```

**Five peers within six seconds**, dialled over the public IP. It then synced the whole
chain from genesis:

```text
💤 Idle (5 peers), best: #534612 (0xf101…47a5), finalized #534610 (0xdfa1…057a), ⬇ 7.4kiB/s
```

```bash
curl -s -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"system_health","params":[]}' http://127.0.0.1:9955
```

```json
{"jsonrpc":"2.0","id":1,"result":{"peers":5,"isSyncing":false,"shouldHavePeers":true}}
```

| | |
|---|---|
| peers | **5** |
| synced to | **#534 612** (finalized #534 610) |
| full sync from genesis | **10 min 11 s** (22:16:23 → 22:26:34) |
| average rate | ~800–1 100 blocks/s |
| database on disk | **4.7 GB** |
| node version | `4.0.0-36b74683ae2` |

### The check that matters

A synced node is worthless if it synced a *different* chain. Compare genesis:

```bash
curl -s -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"chain_getBlockHash","params":[0]}' http://127.0.0.1:9955
curl -s -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"chain_getBlockHash","params":[0]}' https://rpc.scalarnet.io
```

```text
temp node : 0xff6882b49ad61dd3128a6e834b4f81704a3824ce358f2f69fe765ca07cf803d1
public rpc: 0xff6882b49ad61dd3128a6e834b4f81704a3824ce358f2f69fe765ca07cf803d1
```

Identical. The published spec really is this chain.

And confirming `--rpc-methods safe` did its job, on your **own** node, on loopback:

```json
{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"RPC call is unsafe to be called externally"}}
```

::: warning Two rough edges worth knowing before you start
**Sync takes ~10 minutes and 4.7 GB** for ~534 000 blocks, and there is no warp-sync
checkpoint published, so every new node replays the whole chain. Budget for it.

**The spec sets `protocolId: None`**, so the node falls back to the default:

```text
Using default protocol ID "sup" because none is configured in the chain specs
```

A default protocol id means this network is not namespaced away from any other Substrate
chain that also left it unset. Harmless in practice here — the genesis hash still separates
the networks — but it is not what a public chain should ship.
:::

### Clean up

```bash
pkill -f my-tester-node
rm -rf /tmp/scalar-tester-node
```

That is the whole footprint. A full node keeps no keys and holds no funds.

## 7. Running a validator

::: tip Updated 2026-09-24 — validation is open, and unpaid
The numbers below were undecided when this page was written. They are now set (decision D11,
[#159](https://github.com/tejaspatil1936/scalar-commons-v4/issues/159)): **7 seats, a
1 000 CMN minimum validator bond, 100 CMN minimum nominator bond**. Validators remain
**unpaid** ([#172](https://github.com/tejaspatil1936/scalar-commons-v4/issues/172)). The full,
executed procedure — release binary, systemd unit, keys, bond, election — is
**[Run a validator on Scalar](./run-a-validator)**.
:::

**Read this section as a statement of what is *not* decided.** The mechanical procedure is
below and it is accurate. The economics are not settled, and on today's chain they are
actively against you.

### Why the public RPC will not let you do this

Session keys are generated *inside* your node's keystore. That is why the public endpoint
refuses:

```bash
curl -s -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"author_rotateKeys","params":[]}' \
  https://rpc.scalarnet.io
```

```json
{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"RPC call is unsafe to be called externally"}}
```

`author_insertKey`, `author_hasKey` and `system_addReservedPeer` return the same `-32601`.
This is correct and deliberate — `author_rotateKeys` on someone else's node would generate
keys in *their* keystore, which is useless to you and abusive to them.

::: tip A subtlety when you probe this yourself
With **missing** params these methods answer `-32602 Invalid params` first — parameter
parsing happens before the safety check. Send well-formed params and you get the real
`-32601`. Do not read a `-32602` as "the method is exposed".
:::

So every key operation happens against **your own node's loopback RPC**, never the public
endpoint.

### The numbers, read from the live chain

| Value | Now | Where |
|---|---|---|
| `staking.validatorCount` | **7** (was 5; set at block #750 511) | storage |
| `staking.minimumValidatorCount` | 1 | storage |
| `staking.minValidatorBond` | **1 000 CMN** (was 0; set at block #750 515) | storage |
| `staking.minNominatorBond` | **100 CMN** (was 0; set at block #750 515) | storage |
| `SessionsPerEra` | 6 | `runtime/src/lib.rs:816` |
| `babe.epochDuration` | 1 800 blocks | const |
| **staking era** | 6 × 1 800 = **10 800 blocks ≈ 18 h** | derived |
| `BondingDuration` | **28 eras ≈ 21 days** | `runtime/src/lib.rs:817` |
| `SessionKeys` | `babe`, `grandpa`, `authority_discovery` | `runtime/src/lib.rs:170` |

::: danger Three things are undecided, and one of them costs you money

**1. Validator compensation is exactly zero.** `EraPayout = ()` returns `(0, 0)`. This is
deliberate — spec 305 removed staking inflation because it minted outside the emissions
pallet and violated the supply-cap principle. But the consequence, in the runtime's own
words (`runtime/src/lib.rs:898`):

> Validator compensation is now exactly zero. Era payout is (0, 0) and transaction fees are
> burned […] while Slash still routes to the treasury and BondingDuration is 28 eras. A
> third-party validator therefore has **negative expected value**: no revenue, real slash
> risk, 28-era exit. Acceptable for an operator-run testnet where all five authorities are
> ours; **NOT acceptable for a public validator set.**

**2. ~~`minValidatorBond` and `minNominatorBond` are both 0.~~** Decided (D11): 1 000 CMN
and 100 CMN.

**3. ~~All five seats are operator-run.~~** Decided (D11): `validatorCount` is 7, so two seats
are open to outside validators.

Compensation is tracked as [issue #172](https://github.com/tejaspatil1936/scalar-commons-v4/issues/172)
(`tier:T0` — never worked on autonomously). **Do not bond real effort into a validator on
this network expecting a return.** Run one to test the software, not to earn.
:::

### The procedure, for when it opens

Assuming a synced full node of your own (§6), on the machine running it:

```bash
# 1. Generate session keys INSIDE your node's keystore, over ITS OWN loopback RPC.
curl -s -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"author_rotateKeys","params":[]}' \
  http://127.0.0.1:9944
# -> {"result":"0x<babe||grandpa||authority_discovery, 96 bytes hex>"}
```

Your node must be started with `--validator` and an RPC method policy that permits
`author_rotateKeys` on loopback (`--rpc-methods unsafe` bound to `127.0.0.1`, never to a
public interface).

```js
// 2. Bond, 3. set keys, 4. declare intent — all signed by YOUR key, over the public RPC.
await api.tx.staking.bond(bondAmount, { Staked: null }).signAndSend(you);
await api.tx.session.setKeys(rotateKeysHex, '0x').signAndSend(you);
await api.tx.staking.validate({ commission: 100_000_000, blocked: false }).signAndSend(you);
```

`commission` is a `Perbill` — `100_000_000` is 10 %. Then **wait for an election**: intent
is not membership. The set is chosen by Phragmén at the next staking era boundary, i.e. up
to **18 hours**, and only if `validatorCount` has room. When this page was written
`validatorCount` was 5 with five operator nodes bonded, so there was no room. It is now 7 —
[Run a validator on Scalar](./run-a-validator) ends in an outside validator elected and
authoring.

Unbonding afterwards takes `BondingDuration` = 28 eras ≈ **21 days**.

## 8. How to help

### Filing an issue

Open one at
[github.com/tejaspatil1936/scalar-commons-v4/issues](https://github.com/tejaspatil1936/scalar-commons-v4/issues).
The most useful reports name the endpoint, the block, and the exact response — the sections
above are written in that shape on purpose.

### How the factory works

This repository is worked by an autonomous agent harness ("the factory") under hard bounds.
The rule it enforces mechanically is: **never make a check pass by weakening code.** An
agent never sees a success path that avoids the gate command.

What that means for you:

| Label | Effect |
|---|---|
| `ready` | The factory may pick this issue up. Removing it is the per-issue off switch. |
| `tier:T3` | Lowest risk — autonomous work, review, and auto-merge. |
| `tier:T2` | Autonomous work and review; merge stays manual. |
| `tier:T1` | **Never** dispatched autonomously — runtime or pallet logic needing judgement. |
| `tier:T0` | **Never** dispatched autonomously — consensus and economic core. |
| `blocked` | A human has said not yet. |

An issue with **no** `tier:` label is skipped; the dispatcher refuses to guess a risk level.
Emissions, escrow, the supply cap and `construct_runtime` indices are not autonomy targets —
that is why [#159](https://github.com/tejaspatil1936/scalar-commons-v4/issues/159) and
[#161](https://github.com/tejaspatil1936/scalar-commons-v4/issues/161) carry `tier:T0`/`T1`
and no `ready` label.

**External contributions come from forks**, as ordinary pull requests. They go through CI,
agent review, and branch protection like anything else; nothing merges on an agent's own
say-so.

### Where the audit reports live

| Document | What it is |
|---|---|
| [`TESTNETAUDIT.md`](https://github.com/tejaspatil1936/scalar-commons-v4/blob/master/TESTNETAUDIT.md) | The standing testnet audit — numbered findings (`I-1`, `I-2`, …) with the issues they became |
| [`AUDIT.md`](https://github.com/tejaspatil1936/scalar-commons-v4/blob/master/AUDIT.md) | The full codebase audit |
| [`PUBLIC-LAUNCH.md`](https://github.com/tejaspatil1936/scalar-commons-v4/blob/master/PUBLIC-LAUNCH.md) | The launch record: what was verified at go-live, with the commands and outputs |

These are worth reading before filing — several sharp edges on this page are already
findings there, with history attached.

## What this walkthrough found

Everything on this page worked, end to end, from outside. These are the places where it
worked *barely*, or worked only because I already knew something a newcomer would not.
Each is filed.

| # | Finding | Impact | Issue |
|---|---|---|---|
| 1 | `agents::register` never sets `LastHeartbeat`, so a new agent is born failing the emissions activity gate (`hb = 63 < 90`) and earns **no floor emission** until it calls `heartbeat()` | Silently under-pays honest work; hit a live agent with 171 completions | [#161](https://github.com/tejaspatil1936/scalar-commons-v4/issues/161) |
| 2 | The SDK retries deterministic runtime rejections, paying a fee each time — measured at exactly 4.0 fee-paying submissions for one `MinDeliveryBlocksNotElapsed`, with backoff (6 s) shorter than the guard (60 s) | Spends an agent's money on calls that cannot succeed | [#160](https://github.com/tejaspatil1936/scalar-commons-v4/issues/160) |
| 3 | One faucet drip (1 100 CMN) clears agent registration (1 050.01 CMN) by **4.5 %**, and the escrow flow needs two registered agents; one ordinary demo transfer strands you behind a 60-minute cooldown | Blocks the flagship flow for a first-time tester | [#162](https://github.com/tejaspatil1936/scalar-commons-v4/issues/162) |
| 4 | On a near-empty era, one two-account tester captured **81.88 % of the era's 110 000 CMN emission** for 60 CMN of self-directed escrow — the pot is sized by agent count, not work (~917 CMN minted per CMN of work), and the qualification gates concentrate rather than dilute | Testnet balances are not indicative of mainnet economics | [#164](https://github.com/tejaspatil1936/scalar-commons-v4/issues/164) |
| 5 | Validator compensation is exactly zero (`EraPayout = ()`), `minValidatorBond` and `minNominatorBond` were both 0, and all 5 seats were operator-run. Bonds and seats were decided on 2026-09-24 (D11: 1 000 / 100 CMN, 7 seats); compensation is still zero | Third-party validation has negative expected value today | [#159](https://github.com/tejaspatil1936/scalar-commons-v4/issues/159), [#172](https://github.com/tejaspatil1936/scalar-commons-v4/issues/172) |

And the smaller edges, documented in place above rather than filed:

- **The SDK is not on npm** (`@scalar-commons/sdk` → 404). You must clone and build, and
  `npm install <local-path>` symlinks without installing `@polkadot/*`, so your own imports
  fail until you add `@polkadot/api` yourself.
- **`https://scalarnet.io/docs/<anything>` returns 200.** The SPA fallback makes status
  codes useless for checking whether an asset exists; check `content-type`.
- **`protocolId` is `None`**, so nodes fall back to the default protocol id `"sup"` rather
  than a namespace of their own.
- **The chain still calls itself `Scalar Commons Local Testnet`** with `chainType: Local`,
  which is a leftover from its single-host origin.
- **Full sync replays ~534 000 blocks in ~10 minutes and 4.7 GB.** There is no published
  warp-sync checkpoint.
- **`CLAUDE.md` states an 18 B genesis mint**; this testnet's genesis was ~6.01 B CMN.

If you find something not on this list, that is exactly the contribution this page is
fishing for — see **§8, How to help**, above.
