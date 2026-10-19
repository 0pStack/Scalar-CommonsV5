# @scalar-commons/faucet

Devnet CMN faucet. Dispenses a fixed drip to a requested address, rate limited
per address **and** per IP so it cannot be drained.

## Where the funds come from

From a **pre-funded devnet account** — by default `//Ferdie`, which is endowed at
genesis in the local testnet chain spec and is *not* a validator, so spending
from it touches no staked balance.

There is **no mint path in this component, and there must never be one.** All
minting on this chain flows through the emissions pallet; a faucet that could
mint would be a hole in the 100B supply cap. The faucet only ever calls
`balances.transferKeepAlive` — `transferKeepAlive` specifically, so a drip can
never reap the funding account itself.

## Drain protection

Three independent limits, all applied **before** any funds move:

| Limit | Default | Stops |
|---|---|---|
| Per address | 1 drip / 60 min | one account being topped up in a loop |
| Per IP | 5 drips / 60 min | one requester farming unlimited *fresh* addresses |
| Reserve floor | 1000 CMN | the account being emptied if the above are misconfigured |

Rate limiting is a **sliding window**, not fixed buckets: fixed buckets let a
requester spend two full budgets back-to-back across a bucket boundary. Both
budgets are checked before either is recorded, so a request refused by the IP
budget does not silently burn the address budget (otherwise an attacker could
lock a victim's address out by spending only their own IP quota). A reserved slot
is refunded if the drip does not actually land.

## Endpoints

| Method | Path | Result |
|---|---|---|
| `GET` | `/` | index: one line of JSON naming `/health` and the two working routes |
| `POST` | `/drip` | `{"address":"5..."}` → `200` with `blockHash`/`txHash`, or `400` / `429` / `503` / `502` |
| `GET` | `/balance/:address` | live free balance in plancks |
| `GET` | `/health` | chain name, spec version, funding-account balance |

Planck amounts cross the wire as **strings**: JSON numbers are doubles and would
round a real balance. `429` responses carry both `retryAfterMs` and a standard
`Retry-After` header, plus the `scope` (`address` or `ip`) that refused.

## Running

```bash
npm ci --no-audit --no-fund
npm start
```

Configuration (all optional, all validated at startup — the process refuses to
boot on a bad value rather than falling back to a default drip amount):

| Variable | Default |
|---|---|
| `FAUCET_RPC_ENDPOINT` | `ws://127.0.0.1:9944` |
| `FAUCET_SEED` | `//Ferdie` |
| `FAUCET_SS58_FORMAT` | `42` |
| `FAUCET_DRIP_CMN` | `1500` |
| `FAUCET_RESERVE_CMN` | `1000` |
| `FAUCET_ADDRESS_MAX_REQUESTS` / `FAUCET_ADDRESS_WINDOW_MINUTES` | `1` / `60` |
| `FAUCET_IP_MAX_REQUESTS` / `FAUCET_IP_WINDOW_MINUTES` | `5` / `60` |
| `FAUCET_HOST` / `FAUCET_PORT` | `127.0.0.1` / `8080` |
| `FAUCET_TRUST_PROXY` | `false` |

`FAUCET_TRUST_PROXY` defaults to off deliberately: if the faucet is exposed
directly, anyone who can set `X-Forwarded-For` can forge a fresh IP per request
and erase the per-IP budget. Enable it **only** behind a reverse proxy that
overwrites that header.

## Tests

```bash
npm test
```

`tests/rateLimiter.test.ts` and `tests/amount.test.ts` are pure unit tests with
an injected clock. `tests/faucet.live.test.ts` runs against the **live devnet RPC**
and is intentionally not mocked and not skippable — it asserts real balance
changes, real rate-limit rejections that move no funds, and type shapes read from
real runtime metadata. **If the node is not reachable the suite fails rather than
skipping**, because an unreachable node is a finding, not a reason to assert
nothing. Start the devnet first (5-validator local testnet, RPC on `:9944`).
