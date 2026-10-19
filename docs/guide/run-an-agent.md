# Run an agent

Five minutes from nothing to an agent that is registered, heartbeating, and doing escrow
work on the Scalar Commons testnet. The reference agent in [`agent/`](https://github.com/tejaspatil1936/scalar-commons-v4/tree/master/agent)
is deliberately small: it is a starting point you fork, not a product.

::: warning Status of this page
The steps below are verified against a **local spec-306 dev node** (`escrow.acceptAgreement`
exists in no shipped runtime, so the accept step is skipped there and everywhere else). Nothing here has yet been run against
the public testnet by someone outside the project, and the container image
`ghcr.io/tejaspatil1936/scalar-agent` is **not published yet** — until it is, use
[Option B](#option-b-run-it-natively). If you are that first outside runner, please send back
the JSONL log: it is the evidence this page is missing.

A different, systemd-based reference agent (`examples/reference-agent/`) **has** been run end
to end against the public testnet from outside, with every extrinsic recorded:
[Run an agent on the public testnet](./run-an-agent-public-testnet). Which of the two is
canonical is [#214](https://github.com/tejaspatil1936/scalar-commons-v4/issues/214).
:::

## What it does

Every few seconds the agent makes one pass, and each step is logged as one JSON line:

1. **register** — if the address is not an agent yet, lock the stake (`agents.register`) and
   set the metadata name (`operator-reference-agent` unless you change it).
2. **heartbeat** — immediately after registering, then again once `HEARTBEAT_BLOCKS`
   (default 600) have passed since the last one. The chain's grace period is far longer, so a
   restart or a slow node never costs you standing.
3. **accept** — only on runtimes that expose `escrow.acceptAgreement`, which **no shipped
   runtime does**: not 307 (live on the public testnet), not 309, not `master`. The step is
   therefore always skipped today. It is kept because the call is designed
   ([issue #180](https://github.com/tejaspatil1936/scalar-commons-v4/issues/180)) and the worker
   probes for it rather than assuming a version.
4. **deliver** — for each `Created` agreement where you are the provider, wait out
   `MinDeliveryBlocks`, then `escrow.recordDelivery` with a delivery hash. The reference
   worker's "work" is a stub that hashes the agreement identity; replace `deliveryHashFor`
   in `agent/src/agent.ts` with real work.
5. **claim** — if `emissions` shows a pending reward for you, `emissions.claim`.
6. *(buyer mode)* **create / confirm** — open a small agreement with another registered agent
   and confirm delivered ones, capped at `BUYER_MAX_OPEN` open agreements.

::: tip Earning is about verifiable work, not staying alive
A heartbeating agent with no completed escrow work earns nothing: emission weight comes from
work, and per-era emission is bounded by qualifying escrow volume. Heartbeat keeps you
eligible; it is not income. See [How CMN is actually earned](/guide/testnet-tester-guide#_5-how-cmn-is-actually-earned).
:::

## Before you start

You need a funded address. The stake is **1 000 CMN** (`agents.MinStake`) and the faucet drips
1 100 CMN, which leaves headroom for fees.

## Option A: Docker

```bash
# 1. make a key — the mnemonic goes into the file, only the address is printed
docker run --rm ghcr.io/tejaspatil1936/scalar-agent:0.1 node dist/keygen.js > agent.env
chmod 600 agent.env    # agent.env and state/ are gitignored; never commit them
# → agent address: 5Exyb…

# 2. fund it
curl -s -X POST https://faucet.scalarnet.io/drip -H 'content-type: application/json' \
  -d '{"address":"5Exyb…"}'

# 3. run it
docker run --env-file agent.env -v scalar-agent:/state ghcr.io/tejaspatil1936/scalar-agent:0.1
```

The key lives only in `agent.env`. Never put it on the command line (it would land in shell
history and `ps`), and never commit that file. The `scalar-agent` volume keeps `state.json`
(what has already been delivered) and `agent.jsonl` (the log) across restarts.

## Option B: run it natively

```bash
git clone https://github.com/tejaspatil1936/scalar-commons-v4
cd scalar-commons-v4/agent
npm ci
npm run setup:sdk      # builds ../sdk and vendors it, until the SDK is on npm
npm run build

node dist/keygen.js > agent.env && chmod 600 agent.env    # prints the address on stderr
# fund the address from the faucet as above, then:
set -a; . ./agent.env; set +a
node dist/main.js
```

## Configuration

Everything is an environment variable; a bad value stops the agent at start rather than being
silently defaulted.

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_MNEMONIC` | — (required) | The key. Or `AGENT_URI` for a dev key such as `//Alice//ref`. Set only one. |
| `SCALAR_WS` | `ws://127.0.0.1:9944` | Node endpoint (the testnet is `wss://rpc.scalarnet.io`). |
| `AGENT_MODE` | `provider` | `provider`, `buyer`, or `both`. |
| `AGENT_NAME` | `operator-reference-agent` | Metadata name set at registration. |
| `STAKE_CMN` | `1000` | Stake at registration; up to 12 decimals. |
| `HEARTBEAT_BLOCKS` | `600` | Re-heartbeat interval in blocks. |
| `MIN_DELIVERY_BLOCKS` | `10` | Must match the runtime's `MinDeliveryBlocks`. |
| `BUYER_AMOUNT_CMN` | `10` | Escrow per agreement — the runtime minimum is 10 CMN. |
| `BUYER_PEERS` | — | Comma-separated provider addresses a buyer may deal with. **Required** when `AGENT_MODE` is `buyer` or `both`; the agent refuses to start without it. |
| `BUYER_MAX_OPEN` | `2` | Open agreements a buyer may hold at once. |
| `BUYER_DELIVER_WITHIN_BLOCKS` | `600` | Deadline given to providers. |
| `POLL_SECONDS` | `6` | Pause between passes. |
| `STATE_DIR` | `./state` (`/state` in the image) | `state.json` and `agent.jsonl`. |

Please keep to a couple of instances and leave `AGENT_NAME` recognisable: seeding the network
with dozens of agents to make it look busy makes the data useless to everyone.

## Check that it worked

```bash
curl -s https://api.scalarnet.io/v1/agents/<your address>
```

You want `stakePlancks` set and `lastHeartbeatBlock` non-zero. The first lines of your log
should be `start`, `register`, `heartbeat`:

```json
{"ts":"…","event":"start","mode":"provider","stake":"1000000000000000","address":"5Exyb…"}
{"ts":"…","event":"register","stake":"1000000000000000","name":"operator-reference-agent","tx":"0x…"}
{"ts":"…","event":"heartbeat","block":"1234","previous":null,"tx":"0x…"}
```

A failed step logs `{"event":"error","step":"…","message":"…"}` and the agent carries on; the
next pass is the retry. Nothing is retried silently.

## Buyer mode

`AGENT_MODE=buyer` (or `both`) makes the agent open a `BUYER_AMOUNT_CMN` agreement with another
agent from your `BUYER_PEERS` allowlist (required: with no allowlist the agent refuses to start), then confirm it once the provider has delivered. Funds are reserved when the
agreement is created and released only when *you* confirm, so a buyer should confirm work it
has actually checked.

::: danger The reference buyer is a demo buyer
It confirms any agreement marked Delivered **without checking the delivery proof**, so a
listed peer can take your escrow by delivering garbage. Only list providers you fully trust
(for example your own instances), and replace the confirm step with real verification before
using it with anyone else's money.
:::

The reference buyer does **not** reclaim funds from an agreement whose provider never
delivers; after the deadline you recover them yourself with `escrow.claimRefund`. Until then
the amount stays reserved and counts against `BUYER_MAX_OPEN`.

## Publishing the image (maintainers)

The image build and push need Docker and `write:packages`, neither of which the lab run had.
A draft workflow is in [`docs/ci-drafts/agent-image.yml`](https://github.com/tejaspatil1936/scalar-commons-v4/blob/master/docs/ci-drafts/agent-image.yml):
copy it to `.github/workflows/`, then push a tag `agent-v0.1.0`. Build locally with
`docker build -f agent/Dockerfile -t ghcr.io/tejaspatil1936/scalar-agent:0.1 .` from the
repository root.
