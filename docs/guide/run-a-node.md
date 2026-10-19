# Run a node

This page covers building `scalar-node` from source, choosing a chain spec, and joining the
5-validator devnet — as a full node first, then as a validator.

The reference network these instructions were verified against is **Scalar Commons Local
Testnet**, five validators on one host, RPC on `ws://127.0.0.1:9944`.

## Prerequisites

The toolchain pin is load-bearing, not hygiene. `rust-toolchain.toml` pins **Rust 1.85.0**
because the workspace targets Polkadot SDK tag `polkadot-stable2503`, whose `sp-io` uses
`#[no_mangle]` on a `#[panic_handler]`. Any rustc new enough to reject that cannot build
this SDK tag at all. Do not bump the pin without also moving the SDK tag.

`rustup` reads the pin automatically, including the WASM target:

```toml
[toolchain]
channel = "1.85.0"
components = ["rust-src", "rustfmt", "clippy"]
targets = ["wasm32v1-none"]
profile = "minimal"
```

`wasm32v1-none` is the correct target here, not `wasm32-unknown-unknown`:
`substrate-wasm-builder` selects it whenever rustc is ≥ 1.84 and the target is installed.
Without it the builder silently falls back and needs `-Z build-std`.

You also need a C toolchain, `clang`, `protobuf-compiler`, `pkg-config` and `libssl-dev` —
the standard Substrate build set.

## Build

```bash
rustup show                      # confirm 1.85.0 and wasm32v1-none are active
cargo build --release -p scalar-node
```

The WASM runtime is built as part of the workspace, so there is no separate runtime build
step. The binary lands at `target/release/scalar-node`.

::: warning Never set `SKIP_WASM_BUILD`
The runtime blob is what the node executes and what `Metadata` serves. A node built with
the WASM build skipped will not match the chain it is trying to join.
:::

Confirm the binary and its version:

```bash
./target/release/scalar-node --version
```

## Chain specs

`node/src/chain_spec.rs` defines four presets selectable with `--chain`, plus a mainnet
genesis builder that is deliberately *not* selectable.

| `--chain` | Spec id | Name | Chain type | Authorities |
|---|---|---|---|---|
| `dev` | `scalar-dev` | Scalar Commons Development | Development | Alice, Bob, Charlie |
| `local` | `scalar-local` | Scalar Commons Local Testnet | Local | Alice, Bob, Charlie, Dave, Eve |
| `staging` | `scalar-staging` | Scalar Commons Staging | Live | Validator1 … Validator7 |
| `sc-e1` | `scalar-sc-e1` | Scalar Commons sc-e1 Fast-Era | Development | Alice, Bob, Charlie |
| *(none)* | `scalar-commons` | Scalar Commons | Live | supplied by the caller |

Anything that is not one of those four ids is treated as a path to a raw chainspec JSON
file, which is how the devnet is actually run.

A few consequences worth knowing before you pick one:

- **`dev` cannot finalize on its own.** All three of Alice, Bob and Charlie are in the
  authority set, so a single `--dev` process authors roughly a third of slots and never
  reaches GRANDPA's 2/3 quorum. Blocks are produced; nothing is finalized. Use it for
  extrinsic-level work, not for anything that reads finalized state.
- **`local` is the devnet preset**, and the one the reference network runs. Five
  authorities means the GRANDPA threshold is 4, so finality survives one validator being
  down. It does not survive two — see [fault tolerance](#fault-tolerance).
- **`sc-e1`** is genesis-identical to `dev` but tagged as a distinct chain so fast-era
  integration harnesses do not collide with dev chain state on disk. It pairs with a
  λ-scaled runtime build; era length and the other block-denominated constants are
  compile-time runtime constants and *cannot* be overridden from a chainspec.
- **`mainnet_genesis_config`** takes real authorities, founder allocations, two multisigs
  and a root key as arguments. None of those has a defensible default, so it has no
  `--chain` id: call it from a spec-building tool and ship the resulting JSON.

### Chain properties

All presets share the same token properties, which is what any wallet or client will read
from `system_properties`:

| Property | Value | Note |
|---|---|---|
| `tokenSymbol` | `CMN` | |
| `tokenDecimals` | `12` | 1 CMN = 10^12 plancks |
| `ss58Format` | `42` | the generic Substrate default — **mainnet blocker** |

`ss58Format` 42 is not a registered prefix. `chain_spec.rs` flags it as a launch blocker:
a unique prefix must be registered with the
[ss58-registry](https://github.com/paritytech/ss58-registry) before mainnet, at which
point address encodings change.

### Genesis allocation

The 18B CMN genesis mint is split four ways, and a compile-time assertion in
`chain_spec.rs` fails the build if the parts stop summing to the whole:

| Recipient | Allocation | Share of mint |
|---|---|---|
| Founders | 7,000,000,000 CMN | 38.9% |
| Treasury | 5,000,000,000 CMN | 27.8% |
| Researcher multisig | 3,000,000,000 CMN | 16.7% |
| Bootstrap multisig | 3,000,000,000 CMN | 16.7% |

Dev and testnet presets additionally bond `1,000,000 CMN` per validator stash, give each
controller `50,000 CMN` for fees, and pre-register each genesis validator as an agent with
`10,000 CMN` of agent stake — the minimum that qualifies for floor emissions from era 1.
See [the token model](/reference/token-model) for what that stake does and does not earn.

## Generate the raw chainspec

A preset is a Rust function; a network's *identity* is the raw JSON that function produces.
Nodes must all load byte-identical genesis, so the devnet commits its spec rather than
regenerating it per host:

```bash
./deploy/build-spec.sh          # writes deploy/scalar-local-raw.json
```

Under the hood that is `scalar-node build-spec --chain local --raw --disable-default-bootnode`.

::: danger A new genesis is a new chain
Regenerating the spec changes the genesis hash. Every existing database becomes
incompatible and must be wiped (`./deploy/reset-chain.sh`). This is not a soft migration —
a node holding data from the previous genesis cannot sync against the new one.
:::

## Join the devnet as a full node

The devnet's bootnode is alice, whose peer id is pinned by a fixed node key so the
multiaddr stays valid across restarts:

```text
/ip4/127.0.0.1/tcp/30333/p2p/12D3KooWEyoppNCUx8Yx66oV9fJnriXwCcXwDDUA2kj6vnc6iDEp
```

Sync a non-authoring full node against it:

```bash
./target/release/scalar-node \
  --chain deploy/scalar-local-raw.json \
  --base-path ~/scalar-data/fullnode \
  --name my-fullnode \
  --port 30400 \
  --rpc-port 9960 \
  --bootnodes /ip4/127.0.0.1/tcp/30333/p2p/12D3KooWEyoppNCUx8Yx66oV9fJnriXwCcXwDDUA2kj6vnc6iDEp
```

Only alice is given as a bootnode. The other validators find each other through authority
discovery over the DHT rather than through configuration — which is why the network can
grow without editing existing nodes. Note the consequence: **alice is a single point of
partition** for peer discovery on this devnet. A real network needs several bootnodes.

For a remote host, replace `/ip4/127.0.0.1` with its public address. The devnet's p2p
range is 30333–30337.

### Verify it joined

```bash
curl -sH 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"system_health","params":[]}' \
     http://127.0.0.1:9944
```

```json
{"jsonrpc":"2.0","id":1,"result":{"peers":4,"isSyncing":false,"shouldHavePeers":false}}
```

`isSyncing: false` with a non-zero peer count is the signal you are in. Then check that
*finalized* height is advancing, not just best height — a chain that produces blocks
without finalizing them looks healthy to a naive check:

```bash
./deploy/finality-check.sh 12 5     # 12 samples, 5s apart, all five nodes
```

See [the RPC reference](/reference/rpc#chain-and-system) for the individual
`chain_getFinalizedHead` and `system_syncState` calls behind that script.

### Devnet topology

The reference devnet allocates ports in parallel runs, so the *N*th node is derivable:
p2p `30333+i`, RPC `9944+i`, Prometheus `9615+i`.

| Node | p2p | RPC | Prometheus | Pruning |
|---|---|---|---|---|
| alice | 30333 | 9944 | 9615 | archive |
| bob | 30334 | 9945 | 9616 | default |
| charlie | 30335 | 9946 | 9617 | default |
| dave | 30336 | 9947 | 9618 | default |
| eve | 30337 | 9948 | 9619 | default |

alice runs `--state-pruning archive --blocks-pruning archive` because she is the indexer's
query endpoint and needs full history. Every node's RPC is bound to loopback; alice's is
the one treated as public-facing. `deploy/nodes.env` is the machine-readable copy of this
table, and `deploy/README.md` carries the full systemd operations runbook — service units,
snapshots, log recipes and the firewall commands that need root.

### Reaching a remote RPC

The devnet does not pass `--rpc-external`, so nothing is bound to `0.0.0.0`. An SSH tunnel
gets you a remote endpoint without a firewall change or a unit edit:

```bash
ssh -L 9944:127.0.0.1:9944 user@your-host
# then point any client at ws://127.0.0.1:9944
```

That URL works directly in
[Polkadot-JS Apps](https://polkadot.js.org/apps/?rpc=ws%3A%2F%2F127.0.0.1%3A9944) and in
[the SDK](/guide/sdk#connect). If you do bind publicly, put a packet filter up *first*,
keep `--rpc-methods safe`, and terminate TLS at a reverse proxy — a node's own port is not
a public API surface.

A tunnel is not a substitute for that flag: it arrives at the node as a loopback
connection, and `--rpc-methods auto` — the default — serves the unsafe set to anything on
loopback. Alice's unit sets `safe` explicitly, so the tunnel above is safe against port
9944. Tunnelling into a node that left the flag at its default hands the far end
`author_insertKey`.

## Run as a validator

Two steps: author blocks, then register the keys you author with.

### 1. Start with `--validator`

```bash
./target/release/scalar-node \
  --chain deploy/scalar-local-raw.json \
  --base-path ~/scalar-data/validator \
  --name my-validator \
  --validator \
  --node-key-file ~/scalar-data/validator/node-key \
  --port 30400 --rpc-port 9960 --prometheus-port 9630 \
  --rpc-methods safe \
  --bootnodes /ip4/127.0.0.1/tcp/30333/p2p/12D3KooWEyoppNCUx8Yx66oV9fJnriXwCcXwDDUA2kj6vnc6iDEp
```

`--rpc-methods safe` is not redundant. The flag's default is `auto`, and `auto` serves
*every* method — including the keystore-mutating ones, `author_insertKey` and
`author_rotateKeys` — whenever RPC is listening on loopback. Omit the flag and a validator
that looks locked down because it never passed `--rpc-external` is still one reachable
loopback connection away from having its keystore written to. Setting `safe` explicitly is
what alice's unit does (`deploy/systemd/scalar-alice.service`), and it costs a validator
nothing: block authoring does not go through RPC. Step 2 below is the one moment you need
the unsafe set, and it says how to take it back off.

Generate the node key once and keep it — losing it changes your peer id, which breaks any
multiaddr others have pinned:

```bash
./target/release/scalar-node key generate-node-key --file ~/scalar-data/validator/node-key
chmod 600 ~/scalar-data/validator/node-key
```

### 2. Generate and register session keys

Session keys are a 3-tuple on this runtime: GRANDPA, BABE and authority-discovery.
(`ImOnline` was removed, so any 4-key example from upstream Substrate docs does not apply
here.)

Generate them *inside the validator's own keystore* — that is what `author_rotateKeys`
does, and it is why the private halves never leave the machine.

`author_rotateKeys` is in the unsafe set, so the node you started in step 1 will refuse it:

```json
{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"RPC call is unsafe to be called externally"}}
```

That refusal is the flag working, not a fault. Restart the node with `--rpc-methods unsafe`
in place of `--rpc-methods safe`, leaving every other argument from step 1 untouched, run
the two calls below, then restart it back onto `safe`. Keep the window short and keep RPC
on loopback for its duration — `unsafe` exposes `author_insertKey` and
`system_addReservedPeer` alongside the two methods you actually want.

```bash
curl -sH 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"author_rotateKeys","params":[]}' \
     http://127.0.0.1:9960
```

The returned hex blob is the concatenated *public* keys. Register it on chain from your
stash account with `session.setKeys(keys, proof)`, then declare your intent to validate
through `staking.validate`. Confirm the node holds what you registered — this one is
unsafe too, so do it before you restart onto `safe`:

```bash
curl -sH 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"author_hasSessionKeys","params":["0x<blob>"]}' \
     http://127.0.0.1:9960
```

Your keys take effect at the start of a session — not immediately. Session keys survive the
restart back onto `safe`: they live in the keystore under `--base-path`, not in the RPC
configuration, so you only ever need the unsafe window again when you rotate.

::: danger The devnet's validator keys are public
The five devnet validators author with the well-known `//Alice` … `//Eve` seeds, which
appear in every Substrate test fixture in existence. Anyone can sign as them. Never reuse
that pattern for a network holding value: generate per-validator session keys, hold them
in each validator's own keystore, and register them via `session.setKeys`.
:::

## Fault tolerance

GRANDPA finalizes on a supermajority. For `n` authorities the threshold is
`n - (n-1)/3` voters, using integer division:

| `n` | Threshold | Tolerated down |
|---|---|---|
| 3 | 3 | **0** |
| 4 | 3 | 1 |
| 5 | 4 | 1 |
| 7 | 5 | 2 |

At `n = 3` the threshold is *every* authority, so stopping one freezes finality outright
while block production carries on — the failure mode that motivated moving the devnet to
five.

Be precise about what the fifth authority buys: **nothing for fault tolerance.** Four and
five both tolerate exactly one failure, because the threshold rises in step with set size.
Seven is the next size that survives two. Five was chosen for slot spread and an odd set
size. So: restart or snapshot one node freely, never two at once.

And note what a validator count cannot tell you. Five validators on one host share a
kernel, a disk, a NIC and one `systemd --user` manager — that is **one fault domain, not
five**. Surviving one validator *process* stopping says nothing about surviving the loss
of the machine, at which point the live voter count is zero. `deploy/README.md` enumerates
what a production set needs: separate hosts, separate operators, separate key custody, and
real p2p addressing with more than one bootnode.

## What this devnet is not

The devnet is deliberately insecure in ways that are fine locally and disqualifying for
anything holding value: well-known session and node keys, `sudo` held by a single Alice key,
the unregistered SS58 prefix 42, `ChainType::Local`, no TLS or rate limiting, and
Prometheus exported but unscraped and unalerted. `deploy/README.md` keeps the full list
under "What mainnet needs that this testnet skips". Read it before treating any of this as
a mainnet template.
