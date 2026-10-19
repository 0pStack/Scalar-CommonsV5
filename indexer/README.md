# @scalar-commons/indexer

Event indexer and versioned REST API for Scalar Commons. It follows finalized
blocks on a live node, persists blocks / extrinsics / events, and serves them —
together with live pallet state — over **25 endpoints under `/v1`**.

Every response is real chain data. History comes from blocks the indexer has
ingested; current state (stakes, agreements, issuance, era timing) is read from
the node on each request. There are no fixtures anywhere in this package, and
no code path that answers from anything but the chain.

## Why it is split that way

The chain answers "what is true now" cheaply and "what happened in block N"
expensively. So:

- **Live reads** — agents, escrows, eras, emissions, account balances. These are
  what agents act on, and a cached copy would answer "what is true now" with
  "what was true at some point".
- **Indexed history** — blocks, extrinsics, events, per-account activity.
  Replaying these from the chain on every request would put the API's read load
  onto the validators.

Only **finalized** blocks are indexed. Indexing best blocks would let the API
report an agreement or a settlement that a re-org later erased.

## Running it

Needs a reachable node. For the local devnet see [`../deploy/README.md`](../deploy/README.md).

```bash
npm ci
INDEXER_RPC_URL=ws://127.0.0.1:9944 INDEXER_PORT=8080 npm start
```

| Variable | Default | Meaning |
|---|---|---|
| `INDEXER_RPC_URL` | `ws://127.0.0.1:9944` | Node to follow. Must be `ws://` or `wss://`. |
| `INDEXER_HOST` | `127.0.0.1` | Interface the API binds to. |
| `INDEXER_PORT` | `8080` | Port the API binds to. |
| `INDEXER_DB` | `indexer.sqlite` | SQLite file, or `:memory:`. |
| `INDEXER_BACKFILL_DEPTH` | `256` | Finalized blocks to catch up on at startup. |

If the node is unreachable the process exits rather than serving an API that
answers from an empty index.

Storage is SQLite via Node's built-in `node:sqlite`, so there is no native build
step. Balance-shaped values are stored and served as **decimal strings**: a
single agent stake (10^16 plancks) already exceeds `Number.MAX_SAFE_INTEGER`,
and SQLite's `INTEGER` is 64-bit, so neither can hold a `u128` planck amount.

## The 25 endpoints

All are `GET`, all under `/v1`. List endpoints take `?limit=` (default 25, max
200) and `?offset=`, and answer `{ total, limit, offset, items }`.

`/` is not one of the 25 and is not versioned: it answers `200` with a one-line
index naming `/v1/status` and listing these paths, reading nothing off the chain.
It exists so the bare host greets a browser with an entry point instead of the
`404` error object it used to return (issue #156).

Lists that come from live chain state — `/v1/agents`, `/v1/agents/:address/escrows`
and `/v1/escrows` — add `truncated` and `scanLimit`. Enumerating a storage map is
work done by the *node*, so it is bounded (512 entries) rather than trimmed after
the fact: `?limit=1` must not cost a sweep of every agent on chain. When the
ceiling stops a scan the list says so instead of passing off a floor as a total.
`/v1/escrows/stats` reports the same thing as `scanTruncated`, beside the
pallet's own `activeAgreementCount`.

| # | Endpoint | Returns |
|---|---|---|
| 1 | `/v1/status` | Chain identity, head position, indexer sync height |
| 2 | `/v1/blocks` | Indexed finalized blocks, newest first |
| 3 | `/v1/blocks/:id` | One block by height or hash |
| 4 | `/v1/blocks/:id/extrinsics` | Extrinsics in a block, in execution order |
| 5 | `/v1/blocks/:id/events` | Events in a block, in emission order |
| 6 | `/v1/extrinsics` | Extrinsics; `?signer=`, `?section=`, `?method=`, `?blockNumber=` |
| 7 | `/v1/extrinsics/:id` | One extrinsic (`<block>-<index>`) with call args and outcome |
| 8 | `/v1/extrinsics/:id/events` | Events emitted by one extrinsic |
| 9 | `/v1/events` | Events; `?section=`, `?method=`, `?blockNumber=`, `?account=` |
| 10 | `/v1/events/:id` | One event (`<block>-<index>`) |
| 11 | `/v1/accounts` | Accounts observed on chain, most recently active first |
| 12 | `/v1/accounts/:address` | Live balance and nonce, plus indexed activity |
| 13 | `/v1/accounts/:address/extrinsics` | Extrinsics an account signed |
| 14 | `/v1/agents` | Registered agents with live stake and era counters |
| 15 | `/v1/agents/:address` | One agent: stake, liveness, era volume, gov participation |
| 16 | `/v1/agents/:address/events` | Indexed events naming this agent |
| 17 | `/v1/agents/:address/escrows` | Open agreements the agent is party to, with `role` |
| 18 | `/v1/escrows` | Open agreements from live storage; `?buyer=`, `?provider=` |
| 19 | `/v1/escrows/stats` | Open count, funds reserved, status split, pallet limits |
| 20 | `/v1/escrows/:buyer/:provider/:seq` | One agreement by its storage key |
| 21 | `/v1/eras` | Eras settled within the indexed window, plus the era in progress |
| 22 | `/v1/eras/current` | Current era, and whether its settlement window has opened |
| 23 | `/v1/emissions` | Emission parameters and the last settlement recorded |
| 24 | `/v1/emissions/supply` | Total issuance against the hard supply cap |
| 25 | `/v1/activity` | Agent activity feed, newest first; `?agent=`, `?kind=` |

Two shapes are worth calling out:

- **`/v1/emissions/supply`** computes headroom as `cap - issuance` in `bigint`,
  from the runtime's own `SupplyCap` constant and live total issuance. The cap is
  the chain's one inviolable bound; it is never reported from a derived figure.
- **`/v1/eras/current`** exposes `dueForSettlement`, which is `settle_era`'s
  era-duration guard and nothing else. Settlement is permissionless by design;
  this flag says the window is open, not that any particular caller may act.
- **`/v1/eras`** gives every entry the same keys, so nothing has to branch on
  `settled` to know what it can read; the fields that do not apply are null. The
  emission and weight totals are the ones the pallet reported at settlement, read
  strictly — an era whose totals cannot be found is an error, never a zero.
  `settledHistoryFrom` is the oldest block the index holds, which grows past the
  startup backfill window for as long as the follower runs.

- **`/v1/activity`** is one stream of what agents did, projected from the event
  index (every row is an indexed event; its `id` resolves on `/v1/events/:id`).
  Each row carries a `kind`:

  | `kind` | Events |
  |---|---|
  | `message` | every event of the `messages` pallet (also `messaging` / `agentMessaging`, kept as aliases) |
  | `registration` | `agents.AgentRegistered` |
  | `heartbeat` | `agents.HeartbeatSent` |
  | `agreement` | `escrow.AgreementCreated`, `DeliveryRecorded`, `DeliveryConfirmed`, `RefundClaimed`, `DeadlineExtended` |
  | `dispute` | `escrow.DisputeOpened`, `DisputeResolved` |
  | `oracle_vote` | `oracle.OracleResponseSubmitted`, `BatchResponseSubmitted` |
  | `slash` | `agents.SlashExecuted`, `SlashAppealed`, `SlashAppealWithdrawn` |

  Messaging is matched by pallet rather than by event, so every event a
  messaging pallet emits joins the feed with no indexer change. The pallet is
  `messages`, added in runtime 309. The two aliases are the names this list
  guessed at before it existed; they cost one entry each and they are what would
  catch a rename on the runtime side. `?agent=`
  matches any account the event names, on either side, and does not require a
  live registration — a slashed-out agent still has a history. An unknown
  `?kind=` is a 400, not an empty feed. `historyFrom` is the oldest indexed block,
  as on `/v1/eras`.

`/v1` is a promise about response shape. Chain events change with the runtime —
a shape change here means a new prefix, not a quiet edit.

## Tests

```bash
npm ci && npm test
```

Seven suites are chain-free (the agent-activity classifier and feed query, paging rules, identifier and account extraction,
value translation, the SQLite store, path routing and era-event shaping, and the
one decode guard no live chain can trigger — an `AgreementStatus` variant this
build does not know). One — `tests/live.test.ts` — is end-to-end against the node
at `INDEXER_RPC_URL`:

1. submits real extrinsics (`agents.heartbeat`, `balances.transferKeepAlive`,
   `escrow.createAgreement`) from devnet dev accounts;
2. waits for the indexer to actually reach the finalized blocks they landed in;
3. queries **all 25 endpoints** and cross-checks each response against a direct
   RPC read of the same state;
4. asserts that every declared route was exercised, so no endpoint can be added
   without being tested.

**It needs a running node and fails loudly without one** — an indexer that
cannot reach a chain has nothing truthful to serve, so an unreachable node is a
finding, not a case to mock away.

One operational note: each run of the live suite creates one escrow agreement
and leaves it open, because the pallet only clears an agreement on delivery,
refund or dispute resolution. `MaxAgreementsPerPair` is 10, so a long-lived
devnet accumulates them; when every pair for the buyer is full the suite fails
with an explicit message rather than skipping the escrow assertions. Resetting
the devnet (`../deploy/reset-chain.sh`) clears them.
