# @scalar-commons/explorer

Web block explorer for Scalar Commons. Three views — **block**, **extrinsic**,
**account** — server-rendered from a live node, with every page linking to the
next: a block reaches its extrinsics, and an extrinsic reaches the accounts it
touched. A fourth, **agent activity**, is a live feed read from the indexer.

## Where the data comes from

The node, at request time. There is no database, no cache and no committed
snapshot: a page is rendered from what the node answered while it was being
rendered, and if the node cannot answer, the page says so (`502`) rather than
serving a plausible-looking empty view.

Every type shape is decoded from the runtime metadata the node serves:

| Shown | Read from |
|---|---|
| Call arguments and their type names | `extrinsic.method.meta.args` |
| Event fields and their names | `event.meta.fields` |
| Dispatch failures (`agents.NotRegistered`, …) | `registry.findMetaError` |
| Token symbol and decimals | the chain's own token properties |
| Accounts an extrinsic touched | the decoded codec tree (see below) |

Nothing about this chain's pallets is hard-coded here, so a runtime upgrade that
adds a pallet or renames a field shows up correctly — or fails loudly — instead
of rendering something stale.

## How "accounts touched" is found

Structurally, never textually. The decoded call arguments and the extrinsic's
events are walked as a codec tree and an account is recognised by *being* an
`AccountId` — which is why `dest: MultiAddress::Id` is found even though it
renders as an object, and why a 32-byte storage hash is not mistaken for a
public key. A string scan would both miss accounts and invent them.

## One page view is a bounded number of node reads

No view walks the chain. The index page costs one header read; a block or
extrinsic page costs the four reads it takes to decode exactly one block; an
account page costs one header read and one storage read. Nothing here fans a
single request out across a range of blocks, so a visitor cannot turn one HTTP
request into an unbounded amount of node work.

## Agent activity — the one page read from the indexer

`/activity` is one stream of what agents did: messages, registrations,
heartbeats, the agreement lifecycle, disputes, oracle votes and slashes, newest
first, optionally filtered to one agent (`?agent=<ss58>`; the page has a form).

It is the one view that does not read the node, because it cannot within the
rule above: a feed over history means walking blocks, which is unbounded node
work per page view. The indexer already holds that history and classifies it
(`GET /v1/activity`, see [`../indexer/README.md`](../indexer/README.md)), so the
page costs one indexer request and zero node reads. What the explorer adds is
typing: each event field is typed from the runtime metadata already in memory,
so accounts become links and balances print in tokens because the runtime says
they are balances.

"Live" is a `<meta http-equiv="refresh">` every 12 s (two block times — the
indexer follows finalized blocks) on the newest page. Older pages (`?offset=`)
do not refresh, so the rows a reader is looking at do not move. No script is
shipped, as everywhere else.

If the indexer is down or answers with something that is not the feed, the page
is a `502` naming the indexer — never an empty feed. The runtime has no
`messages` pallet from runtime 309, so `message` rows appear once agents start
sending.

## Read-only by construction

The client exposes no signing key and no `tx` surface at all. There is no
request that can change chain or server state.

## Routes

| Path | View |
|---|---|
| `/` | chain identity and where the head sits |
| `/block/:number`, `/block/:hash` | block header + its extrinsics |
| `/extrinsic/:block/:index` | call, arguments, events, outcome, accounts touched |
| `/account/:address` | balances and nonce, at the block they were read |
| `/activity`, `/activity?agent=:address` | agent-activity feed from the indexer, newest first |

A block is addressed by number or hash; an extrinsic by `(block, index)`, its
only stable on-chain coordinate.

## Run it

```
npm ci
npm run build
npm start                       # http://127.0.0.1:8081
```

| Env | Default | Meaning |
|---|---|---|
| `EXPLORER_RPC_ENDPOINT` | `ws://127.0.0.1:9944` | node to read from |
| `EXPLORER_HOST` / `EXPLORER_PORT` | `127.0.0.1` / `8081` | listen address (8081, not 8080: the indexer owns 8080) |
| `EXPLORER_INDEXER_URL` | `http://127.0.0.1:8080` | indexer the `/activity` page reads |

## Tests

```
npm test
```

The live suite talks to the devnet RPC and is **not** skippable: it submits one
real transfer, then asserts the explorer renders that block, that extrinsic and
the accounts it named, cross-checked against direct node reads. An unreachable node
fails the suite — mocking the chain would assert nothing about the only thing
that can really break, which is decoding what a real runtime really returns.
