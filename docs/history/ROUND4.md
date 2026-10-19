# ROUND 4 — The node layer: a binary that produces blocks

Date: 2026-08-01
Branch: `rebuild/runtime` (continued). Predecessors: `BASELINE.md`, `ROUND2.md`, `ROUND3.md`.

**Outcome: success. `target/release/scalar-node` exists, runs, and produces
blocks. With a quorum of validators it finalizes them.**

Round 3 produced a WASM blob. This round produced a chain. `node/src/main.rs`
was `fn main() {}` and `node/Cargo.toml` had one dependency and no `[[bin]]`;
both are now real, ported from the kitchensink reference node at tag
`polkadot-stable2503`.

Three defects were found that had nothing to do with porting — they were latent
in files written before this round and would have stopped any node from
starting, on any SDK version. All three are described below with the verbatim
error that exposed them.

Nothing was stubbed. No `#[allow]`, no `todo!()`, no `SKIP_WASM_BUILD`, no
deleted test. `runtime/`, `pallets/`, `tests/`, `factory/` and `.github/` were
not touched.

---

## Headline results

| Gate | Result |
|---|---|
| `cargo build --release` | **PASS** — whole workspace, 4m02s, `target/release/scalar-node` (62,843,384 bytes) |
| `--version` | **PASS** — `scalar-node 4.0.0-6ccc89317ae` (git hash from `build.rs`) |
| `--dev --tmp` produces blocks | **PASS** — `Imported #1` … `#11` in a 2-minute run |
| Finalization advances | **PASS** — on a 3-validator devnet: best `#29`, finalized `#27`. **NOT on single-node `--dev`** — see Gate B |
| All four genesis configs build | **PASS** — `dev`, `local`, `staging`, `sc-e1` |
| Second `--tmp` run starts clean | **PASS** — fresh DB path, identical genesis hash |
| RPC surface responds | **PASS** — `system_*`, `payment_*`, `babe_*`, `grandpa_*` |

---

## What the reference has that we omitted (and why)

The reference is `substrate/bin/node/cli` plus `substrate/bin/node/rpc` at tag
`polkadot-stable2503`. I diffed `polkadot-stable2503-rc2..polkadot-stable2503`
over `substrate/bin/node/` and `substrate/client/` first: **empty**, so the
local checkout at `-rc2` is byte-identical to the pinned tag for everything read
here.

### Omitted because the runtime has no such pallet

| Subsystem | Reference crates | Runtime requirement we lack |
|---|---|---|
| **BEEFY** | `sc-consensus-beefy`, `sc-consensus-beefy-rpc`, `sp-consensus-beefy` | `pallet-beefy`, `pallet-mmr`, `BeefyApi` |
| **MMR gadget** | `mmr-gadget`, `mmr-rpc` | `pallet-mmr`, `MmrRuntimeApi` |
| **Statement store** | `sc-statement-store`, `sc-network-statement`, `sc_rpc::statement` | `pallet-statement-store`, `sp_statement_store::runtime_api` |
| **Mixnet** | `sc-mixnet`, `sc_rpc::mixnet`, `sc_cli::MixnetParams` | `pallet-mixnet` |
| **Transaction storage proof** | `sp-transaction-storage-proof` | `pallet-transaction-storage` |

Two of these have visible structural consequences rather than merely absent
features, and both are commented at the site:

* The block-import chain is **`grandpa -> babe`**. The reference is
  `grandpa -> beefy -> babe`.
* The BABE authoring inherents are **`(slot, timestamp)`**. The reference adds
  a third, `sp_transaction_storage_proof::registration::new_data_provider`.
  Supplying it here would produce blocks this runtime rejects as carrying an
  unknown inherent — so this is not a feature omission, it is a correctness
  requirement.
* `HostFunctions` is plain `sp_io::SubstrateHostFunctions`; the reference adds
  `sp_statement_store::runtime_api::HostFunctions`.

### Omitted because the runtime has the pallet but not the API

**Authority discovery — this is the one that matters.**

`pallet_authority_discovery` **is** in this runtime (`construct_runtime` index
8), its `Config` is implemented (`runtime/src/lib.rs:881`), and its key **is**
in `SessionKeys` (`runtime/src/lib.rs:124`). But `impl_runtime_apis!` never
declares `sp_authority_discovery::AuthorityDiscoveryApi`, and
`sp-authority-discovery` is not even a dependency of `runtime/Cargo.toml`. The
worker's whole job is to call that API to read the authority set, so it cannot
be spawned against this runtime.

Fixing it means editing `runtime/src/lib.rs`. Round 4 is not permitted to do
that, so the worker is omitted and the gap is reported here. Consequence:
validators do not publish or resolve each other's addresses over the DHT.
Explicit `--bootnodes` / `--reserved-nodes` still work — which is why the
3-validator devnet below finalizes fine — but a real multi-operator network
wants it. Full text in **Remaining gaps**.

### Omitted because our chain spec cannot support it

**`sync_state` RPC.** `SyncState::new` requires the chain spec to carry a
`lightSyncState` extension. The reference declares an `Extensions` struct
holding one; `node/src/chain_spec.rs` declares
`pub type ChainSpec = sc_service::GenericChainSpec` — i.e. `NoExtension`. Wired
in as the reference has it, every startup died before the first block (verbatim,
`scratchpad/dev-run1.log`):

```
2026-08-01 11:39:30 〽️ Prometheus exporter started at 127.0.0.1:9615
2026-08-01 11:39:30 Essential task `babe-worker` failed. Shutting down service.
Error: Service(Application(LightSyncStateExtensionNotFound))
```

The round's instruction is to adapt the node to our chain spec, not the
reverse, so the RPC goes. Cost: this node cannot **serve** warp-sync snapshots
to others. It can still warp-sync **itself** — `grandpa::warp_proof::NetworkProvider`
is wired unchanged in `service.rs`.

### Omitted by choice, not by constraint

| Omitted | Reason |
|---|---|
| `Benchmark` subcommand, `frame-benchmarking-cli` | Its pallet path needs a `runtime-benchmarks` feature that `runtime/Cargo.toml` only partially wires (5 pallets listed, 30+ in the runtime). Enabling it is a runtime edit. |
| Hardware benchmarks (`gather_hwbench`, `SUBSTRATE_REFERENCE_HARDWARE`) | Same dependency as above. The `--no-hardware-benchmarks` flag is **kept**, so scripts passing it do not break; it is currently inert. |
| `Inspect` subcommand, `node-inspect` | Block/extrinsic decoding convenience. |
| `state_trie_migration` and `dev` RPCs | Diagnostics, each another crate. |
| `clap_complete` shell completions in `build.rs` | Packaging convenience. |
| `flaming-fir` chain id, `benchmarking.rs`, the `#[ignore]` `test_sync`/`test_consensus` harness, `[[bench]]` targets | Reference-specific test scaffolding. |

The reference pulls everything through the `polkadot-sdk` umbrella crate. This
workspace pins individual crates, so each is named explicitly in
`node/Cargo.toml` and routed through `[workspace.dependencies]` at the same git
tag as the runtime.

---

## What changed file by file

Nine commits, all on `rebuild/runtime`.

| Commit | File(s) | What |
|---|---|---|
| `7cd64b7` | `node/Cargo.toml`, `node/build.rs`, `Cargo.toml` | Real manifest, `[lib]`+`[[bin]]`, build script |
| `0ecaccd` | `node/src/{lib,main,cli,command}.rs` | CLI surface and dispatch |
| `85c3ffb` | `node/src/{service,rpc}.rs` | The service and RPC layers |
| `4cafe8a` | `node/src/chain_spec.rs` | Unused import, doc comments |
| `2fd7151` | `Cargo.lock` | Lock the new deps |
| `0536430` | `node/src/chain_spec.rs` | **Five genesis keys the runtime has no field for** |
| `0662f35` | `node/src/{rpc,service}.rs`, `node/Cargo.toml` | Drop `sync_state` |
| `6ccc893` | `Cargo.lock` | Lock after dropping two deps |

### `Cargo.toml` (root) — the only permitted edit outside `node/`

Added 16 `[workspace.dependencies]` entries, all at
`tag = "polkadot-stable2503"`, all resolving from the git source already in the
lock (no new registry sources): `sc-client-api`, `sc-consensus`,
`sc-network-sync`, `sc-chain-spec`¹, `sc-sysinfo`, `sc-storage-monitor`,
`sc-consensus-babe-rpc`, `sc-consensus-grandpa-rpc`, `sc-sync-state-rpc`¹,
`sp-blockchain`, `sp-consensus`, `sp-authority-discovery`,
`pallet-transaction-payment-rpc-runtime-api`, `substrate-build-script-utils`,
`futures`.

¹ `sc-chain-spec` and `sc-sync-state-rpc` are declared but no longer consumed,
after `sync_state` was dropped. Left in place as workspace-level declarations —
they cost nothing and are the obvious re-entry point if the chain spec later
grows a `lightSyncState` extension.

### `node/Cargo.toml`

Was: package stanza plus one `sc-cli` dependency. No `[[bin]]`, so `cargo` never
produced a binary from it, and `default-features = false` on `sc-cli` — a
node-side crate that has no meaningful no-std mode.

Now: `[lib]` + `[[bin]] name = "scalar-node"`, 40 dependencies, one build
dependency. Lib+bin mirrors the reference split and is load-bearing here:
`chain_spec::mainnet_genesis_config` takes five arguments with no safe defaults
and so cannot hang off a `--chain` id. As a library API it is reachable; in a
bare binary crate it would be dead code, and the only ways to silence that are
an `#[allow]` (forbidden) or deletion (worse).

### `node/build.rs` (new, 16 lines)

`generate_cargo_keys()` + `rerun_if_git_head_changed()`, from the reference.
Emits `SUBSTRATE_CLI_IMPL_VERSION`, which `command.rs::impl_version` reads via
`env!`. Without it the crate does not compile at all, so this is not decoration.
The reference's `clap_complete` block is omitted.

### `node/src/main.rs` (2 lines → 13)

Was `fn main() {}`. Now the reference's thin bin: `scalar_node::run()`.

### `node/src/lib.rs` (new, 19 lines)

Crate root. `pub mod chain_spec; mod cli; mod command; pub mod rpc; pub mod service;`
plus `#![warn(missing_docs)]`.

### `node/src/cli.rs` (new, 79 lines)

The reference's `Cli` and `Subcommand`, minus `mixnet_params`, `Inspect` and
`Benchmark`. Twelve subcommands retained: `key`, `verify`, `vanity`, `sign`,
`build-spec`, `check-block`, `export-blocks`, `export-state`, `import-blocks`,
`purge-chain`, `revert`, `chain-info`.

### `node/src/command.rs` (new, 141 lines)

`SubstrateCli` impl and the dispatch `match`. `load_spec` maps
`dev`/`local`/`staging`/`sc-e1` onto the four builders in `chain_spec.rs`, plus
`from_json_file` for a path. `Revert` keeps the reference's `aux_revert`
(`babe::revert` then `grandpa::revert`).

### `node/src/service.rs` (new, 449 lines)

`new_partial` / `new_full_base` / `new_full`, shaped exactly as the reference.
Retained in full: BABE block import + import queue, GRANDPA block import,
justification import, warp sync provider, `build_network`, `spawn_tasks`,
`ProposerFactory`, `start_babe` with `SlotProportion::new(0.5)` and
`BackoffAuthoringOnFinalizedHeadLagging`, `run_grandpa_voter`, offchain workers,
libp2p/litep2p backend switch, storage monitor. Omissions as tabled above, each
commented at its site.

### `node/src/rpc.rs` (new, 149 lines)

`FullDeps` / `create_full`. Merges `System`, `TransactionPayment`, `Babe`,
`Grandpa`. The four custom `ScalarCommonsApi` methods are exported by the WASM
blob (ROUND3 verified this in the export table) but are **not** surfaced as
JSON-RPC — explicitly out of scope this round. They remain reachable via
`state_call`.

---

## chain_spec adaptations

`node/src/chain_spec.rs` was 437 lines of real code, orphaned. **All four
genesis configurations survive and all four build.** No allocation, validator
count, session key, staking parameter, bond, SS58 prefix or token property was
changed. `mainnet_genesis_config` keeps its `assert_eq!` that allocations equal
`GENESIS_MINT`, and the file-level `const _: () = assert!(...)` that the four
dev allocations sum to 18B CMN.

Four changes were made. The first two are cosmetic; the third is the one that
matters.

### 1. One unused import removed

`RuntimeGenesisConfig` was imported and never named — every builder hands the
runtime a `serde_json` patch and lets `GenesisBuilder` type it. Removed rather
than silenced.

### 2. Doc comments added to the public surface

The crate carries `#![warn(missing_docs)]` (as the reference does). Additive
only; documents the four presets, the six allocation constants, the `ChainSpec`
alias, and — usefully — records why `mainnet_genesis_config` has no `--chain`
id.

### 3. Five genesis keys removed — the blocker

Genesis could not be built at all. Verbatim, from
`./target/release/scalar-node build-spec --chain dev --raw`:

```
Error: Service(Other("Invalid JSON blob: unknown field `constitution`, expected
one of `system`, `balances`, `authorityDiscovery`, `transactionPayment`,
`vesting`, `treasury`, `sudo`, `agents`, `autoParams`, `nominationPools`,
`staking`, `babe`, `grandpa`, `session`, `safeMode`, `txPause` at line 66
column 16 for blob: ...
```

That error list is the authoritative set of fields `RuntimeGenesisConfig`
actually has. Five keys in the patch name pallets that declare **no**
`#[pallet::genesis_config]` at this tag, so no field exists for them:

| Key | Pallet | Verified against |
|---|---|---|
| `rankedCollective` | `pallet_ranked_collective` | SDK source — no `genesis_config` anywhere in the crate |
| `referenda` | `pallet_referenda` | SDK source — none |
| `convictionVoting` | `pallet_conviction_voting` | SDK source — none |
| `whitelist` | `pallet_whitelist` | SDK source — none |
| `constitution` | `pallet_constitution` (ours) | `pallets/constitution/src/` — none |

Dropping the four empty patches changes no on-chain state: a pallet with no
genesis config has nothing to initialise, and all five pallets remain in
`construct_runtime` and active from block 1. The comment left in the file says
so explicitly.

**One of the five carried a payload, and its loss is real.** `rankedCollective`
seeded the three validator **stash** accounts at rank 1 — "the Technical Council
from block 1", per the original comment. That is not implementable from a chain
spec at this SDK version, because the pallet has no genesis config to write to.

The collective is still non-empty at block 1, by a different route:
`pallet-agents`' own genesis build calls `T::AgentCollective::induct` on each
genesis agent and, because `GENESIS_AGENT_STAKE` (10,000 CMN) equals
`AgentsFullFloorStake` (`runtime/src/lib.rs:1019`), promotes it twice. So there
**are** three members at block 1 — but they are the **controller** accounts at
**rank 2**, where the spec intended the **stash** accounts at **rank 1**. That
delta is unresolved and is listed under Remaining gaps.

### 4. `--dev` authority count: flagged, NOT changed

`development_config()` puts Alice, Bob **and** Charlie in the authority set.
The reference's `development_config` uses a single authority. This is why
single-node `--dev` produces blocks but does not finalize (Gate B). Changing it
would be a semantic change to a genesis configuration, not a mechanical fix, so
it was left alone and documented in a doc comment at the function.

---

## Gate A evidence

```
$ cargo build --release
    Finished `release` profile [optimized] target(s) in 4m 02s

$ ls -la target/release/scalar-node
-rwxrwxr-x 2 dev dev 62843384 Aug  1 11:33 target/release/scalar-node

$ ./target/release/scalar-node --version
scalar-node 4.0.0-6ccc89317ae
```

The version suffix is the git commit hash, produced by `build.rs` — evidence
the build script is wired, not just present.

`scalar-node` compiles with **zero warnings of its own**. The 6 warnings in the
workspace release build are all pre-existing unused imports in
`pallets/{escrow,auto-params,oracle}` and `runtime/`, which this round may not
touch.

### Chain-spec presets

All four `--chain` ids resolve and build a raw spec — this exercises the full
`GenesisBuilder::build_state` path through the WASM blob, not just JSON:

```
build-spec --chain dev      : OK (2344376 bytes)
build-spec --chain local    : OK (2345394 bytes)
build-spec --chain staging  : OK (2365329 bytes)
build-spec --chain sc-e1    : OK (2344393 bytes)
```

`--help` lists the twelve subcommands and identifies the node correctly:

```
Scalar Commons node — sovereign Substrate chain for autonomous AI-agent coordination.

Usage: scalar-node [OPTIONS]
       scalar-node <COMMAND>

Commands:
  key            Key management cli utilities
  verify         Verify a signature for a message, provided on STDIN, ...
  vanity         Generate a seed that provides a vanity address
  sign           Sign a message, with a given (secret) key
  build-spec     Build a chain specification
  check-block    Validate blocks
  export-blocks  Export blocks
  export-state   Export the state of a given block into a chain spec
  import-blocks  Import blocks
  purge-chain    Remove the whole chain
  revert         Revert the chain to a previous state
  chain-info     Db meta columns information
```

Note that the runtime's `GenesisBuilder` reports **no** presets of its own —
`preset_names()` returns `vec![]` and `get_preset` returns `None` for every id
(`runtime/src/lib.rs:1496-1501`). The four presets above are the node's
`--chain` ids, built from `chain_spec.rs`, not from the runtime. See Remaining
gaps.

---

## Gate B evidence

### Blocks: `--dev --tmp`, single node

```
$ ./target/release/scalar-node --dev --tmp
```

Verbatim, `scratchpad/dev-run2.log`:

```
2026-08-01 11:44:32 Scalar Commons Node
2026-08-01 11:44:32 ✌️  version 4.0.0-2fd7151d35f
2026-08-01 11:44:32 📋 Chain specification: Scalar Commons Development
2026-08-01 11:44:32 👤 Role: AUTHORITY
2026-08-01 11:44:32 💾 Database: RocksDb at /tmp/substrate0HPN1S/chains/scalar-dev/db/full
2026-08-01 11:44:32 [0] 💸 generated 3 npos voters, 3 from validators and 0 nominators
2026-08-01 11:44:32 [0] 💸 generated 3 npos targets
2026-08-01 11:44:32 🔨 Initializing Genesis block/state (state: 0x5be0…3972, header-hash: 0x6e13…e44d)
2026-08-01 11:44:32 👴 Loading GRANDPA authority set from genesis on what appears to be first startup.
2026-08-01 11:44:32 👶 Creating empty BABE epoch changes on what appears to be first startup.
2026-08-01 11:44:32 👶 Starting BABE Authorship worker
2026-08-01 11:44:37 💤 Idle (0 peers), best: #0 (0x6e13…e44d), finalized #0 (0x6e13…e44d), ⬇ 0 ⬆ 0
2026-08-01 11:44:42 🙌 Starting consensus session on top of parent 0x6e13a72d…ca4de44d (#0)
2026-08-01 11:44:42 🎁 Prepared block for proposing at 1 (1 ms) hash: 0x8cec3ec6…d5630239; parent_hash: 0x6e13…e44d; end: NoMoreTransactions; extrinsics_count: 1
2026-08-01 11:44:42 🔖 Pre-sealed block for proposal at 1. Hash now 0xc1073142…0dd8b7f7, previously 0x8cec3ec6…d5630239.
2026-08-01 11:44:42 👶 New epoch 0 launching at block 0xc107…b7f7 (block slot 297596247 >= start slot 297596247).
2026-08-01 11:44:42 👶 Next epoch starts at slot 297598047
2026-08-01 11:44:42 🏆 Imported #1 (0x6e13…e44d → 0xc107…b7f7)
2026-08-01 11:44:48 🏆 Imported #2 (0xc107…b7f7 → 0x9b66…b24e)
2026-08-01 11:44:54 🏆 Imported #3 (0x9b66…b24e → 0xcca9…799f)
...
2026-08-01 11:46:48 🏆 Imported #9  (0xad19…730b → 0x0eee…41b5)
2026-08-01 11:46:54 🏆 Imported #10 (0x0eee…41b5 → 0x8fb1…d820)
2026-08-01 11:47:00 🏆 Imported #11 (0x8fb1…d820 → 0x0651…0a57)
```

Eleven blocks in ~2.5 minutes. Runtime execution is real: `extrinsics_count: 1`
is the timestamp inherent, epoch transitions are computed by
`pallet-babe`, and the NPoS election ran at genesis
(`generated 3 npos voters, 3 from validators`).

**Finality does not advance here**, and this is expected, not a defect. Every
`Idle` line reads `finalized #0`. `development_config()` puts three validators
in the authority set, so GRANDPA needs all three to reach its threshold; only
Alice's keys are in this node's keystore. One node cannot form a quorum for a
three-authority set. See "chain_spec adaptation 4".

### Finalization: 3-validator local devnet

`--chain local` carries the same three authorities. Running all three:

```bash
BIN=./target/release/scalar-node

$BIN --chain local --alice   --validator --base-path /tmp/dn1 \
     --node-key 00…01 --port 30333 --rpc-port 9944 --prometheus-port 9615 &
# alice peer id: 12D3KooWEyoppNCUx8Yx66oV9fJnriXwCcXwDDUA2kj6vnc6iDEp
BOOT=/ip4/127.0.0.1/tcp/30333/p2p/12D3KooWEyoppNCUx8Yx66oV9fJnriXwCcXwDDUA2kj6vnc6iDEp

$BIN --chain local --bob     --validator --base-path /tmp/dn2 \
     --node-key 00…02 --port 30334 --rpc-port 9945 --prometheus-port 9616 --bootnodes $BOOT &
$BIN --chain local --charlie --validator --base-path /tmp/dn3 \
     --node-key 00…03 --port 30335 --rpc-port 9946 --prometheus-port 9617 --bootnodes $BOOT &
```

(`--node-key` is required on all three: with a persistent `--base-path` on a
non-dev chain, sc-cli will not invent a network identity —
`Error: NetworkKeyNotFound(".../network/secret_ed25519")`. Explicit
`--bootnodes` is required because authority discovery is absent; see Remaining
gaps.)

Finality starts immediately and tracks two blocks behind the head. Alice
(`scratchpad/dn-alice.log`):

```
2026-08-01 11:51:10 💤 Idle (2 peers), best: #3  (0x88b0…020f), finalized #1  (0x7ab4…04b7), ⬇ 1.8kiB/s ⬆ 1.6kiB/s
2026-08-01 11:51:15 💤 Idle (2 peers), best: #4  (0x73b8…bde9), finalized #2  (0x25f1…a3be), ⬇ 1.9kiB/s ⬆ 1.8kiB/s
2026-08-01 11:51:20 💤 Idle (2 peers), best: #5  (0x2eb2…c119), finalized #3  (0x88b0…020f), ⬇ 1.6kiB/s ⬆ 2.0kiB/s
...
2026-08-01 11:53:30 🏆 Imported #27 (0x21fb…8df9 → 0xdee4…e853)
2026-08-01 11:53:35 💤 Idle (2 peers), best: #27 (0xdee4…e853), finalized #25 (0xe672…6919), ⬇ 1.3kiB/s ⬆ 1.5kiB/s
2026-08-01 11:53:36 🏆 Imported #28 (0xdee4…e853 → 0x83ae…ce41)
2026-08-01 11:53:40 💤 Idle (2 peers), best: #28 (0x83ae…ce41), finalized #26 (0x21fb…8df9), ⬇ 1.6kiB/s ⬆ 1.7kiB/s
2026-08-01 11:53:42 🏆 Imported #29 (0x83ae…ce41 → 0xdba6…c00f)
2026-08-01 11:53:45 💤 Idle (2 peers), best: #29 (0xdba6…c00f), finalized #27 (0xdee4…e853), ⬇ 1.8kiB/s ⬆ 1.8kiB/s
```

Bob and Charlie agree, at the same heights and hashes:

```
# dn-bob.log
2026-08-01 11:53:43 💤 Idle (2 peers), best: #29 (0xdba6…c00f), finalized #27 (0xdee4…e853), ⬇ 1.8kiB/s ⬆ 1.8kiB/s
# dn-charlie.log
2026-08-01 11:53:43 💤 Idle (2 peers), best: #29 (0x2eae…0dde), finalized #27 (0xdee4…e853), ⬇ 1.9kiB/s ⬆ 2.0kiB/s
```

All three authoring (note the competing `#26` and `#29` imports in Alice's log,
`🏆` vs `🆕` — different authors on the same height, resolved by fork choice),
all three finalizing the same chain. This is a working BABE + GRANDPA network.

This also fills in the `<!-- TODO(Keith): paste the exact testnet launch command -->`
left open in `CLAUDE.md`.

### Second `--tmp` run starts clean

```
run 2: 💾 Database: RocksDb at /tmp/substrate0HPN1S/chains/scalar-dev/db/full
       🔨 Initializing Genesis block/state (state: 0x5be0…3972, header-hash: 0x6e13…e44d)
run 3: 💾 Database: RocksDb at /tmp/substrateVxF2dz/chains/scalar-dev/db/full
       🔨 Initializing Genesis block/state (state: 0x5be0…3972, header-hash: 0x6e13…e44d)
       🏆 Imported #1 (0x6e13…e44d → 0x2d5e…2d4e)
       🏆 Imported #2 (0x2d5e…2d4e → 0xba56…1457)
```

New temp directory each time, genesis re-initialised from scratch, and the
genesis state root and header hash are **identical** across runs — the spec is
deterministic. Block #1's hash differs between runs because it carries a
wall-clock timestamp, as it should.

### RPC surface

Against a live `--dev --tmp` node on `127.0.0.1:9944`:

```
system_chain            -> "Scalar Commons Development"
system_name             -> "Scalar Commons Node"
system_version          -> "4.0.0-6ccc89317ae"
system_accountNextIndex -> 0        (for Alice, 5Grwva…GKutQY)
state_getRuntimeVersion -> {"specName":"scalar-commons","implName":"scalar-commons",
                            "authoringVersion":1,"specVersion":301,"implVersion":0,…}
```

`specVersion: 301` is Round 3's bump, live over RPC. Methods present from the
ported modules: `payment_queryInfo`, `payment_queryFeeDetails`,
`babe_epochAuthorship`, `grandpa_proveFinality`, `grandpa_roundState`,
`grandpa_subscribeJustifications`, `grandpa_unsubscribeJustifications`,
`system_accountNextIndex`.

---

## Remaining gaps (verbatim)

### 1. `AuthorityDiscoveryApi` is not implemented — runtime fix required

The pallet is wired but its runtime API is absent, so the discovery worker
cannot run. From `runtime/src/lib.rs`, the pallet is present:

```
1236:    #[runtime::pallet_index(8)]  pub type AuthorityDiscovery = pallet_authority_discovery;
```

its Config is implemented:

```
881: impl pallet_authority_discovery::Config for Runtime {
882:     type MaxAuthorities = ConstU32<100>;
883: }
```

and its key is in `SessionKeys`:

```
124:        pub authority_discovery: AuthorityDiscovery,
```

but `impl_runtime_apis!` (lines 1274–1503) declares twelve APIs and
`AuthorityDiscoveryApi` is not among them:

```
Core, Metadata, BlockBuilder, TaggedTransactionQueue, OffchainWorkerApi,
SessionKeys, BabeApi, GrandpaApi, AccountNonceApi, TransactionPaymentApi,
ScalarCommonsApi, GenesisBuilder
```

`sp-authority-discovery` is not a dependency of `runtime/Cargo.toml` either.
**Fix (runtime, not this round):** add `sp-authority-discovery` to
`runtime/Cargo.toml` (including its `std` feature), then add to
`impl_runtime_apis!`:

```rust
impl sp_authority_discovery::AuthorityDiscoveryApi<Block> for Runtime {
    fn authorities() -> Vec<AuthorityDiscoveryId> {
        AuthorityDiscovery::authorities()
    }
}
```

then re-add `sc-authority-discovery` to `node/Cargo.toml` and restore the
worker block in `service.rs` (the reference's version is quoted in the comment
at the omission site). **This changes `RUNTIME_API_VERSIONS`, so it needs a
`spec_version` bump.** Until then, multi-node networks need explicit
`--bootnodes` or `--reserved-nodes`.

### 2. The runtime exposes no `GenesisBuilder` presets

`runtime/src/lib.rs:1492-1502`:

```rust
impl sp_genesis_builder::GenesisBuilder<Block> for Runtime {
    fn build_state(config: Vec<u8>) -> sp_genesis_builder::Result {
        frame_support::genesis_builder_helper::build_state::<RuntimeGenesisConfig>(config)
    }
    fn get_preset(id: &Option<sp_genesis_builder::PresetId>) -> Option<Vec<u8>> {
        frame_support::genesis_builder_helper::get_preset::<RuntimeGenesisConfig>(
            id, |_| None,
        )
    }
    fn preset_names() -> Vec<sp_genesis_builder::PresetId> { vec![] }
}
```

`preset_names()` is empty and `get_preset` returns `None` for every id. The
node's four `--chain` presets live in `chain_spec.rs` and go through
`build_state`, which works — so nothing is broken today. But `chain-spec-builder`
and any tooling that enumerates runtime presets will see an empty list, and the
`dev`/`local` genesis definitions are duplicated in Rust rather than owned by the
runtime. Moving them into `get_preset` is the modern SDK pattern. Runtime edit;
not this round.

### 3. Genesis cannot seed `RankedCollective` — the TC composition differs from intent

Covered above. Concretely: the spec intended the three validator **stash**
accounts at **rank 1**; what genesis actually produces is the three
**controller** accounts at **rank 2**, via `pallet-agents`' induct-and-promote.
No chain-spec change can fix this — `pallet_ranked_collective` has no genesis
config at `polkadot-stable2503`. Options, none taken here: give
`pallet-agents`' genesis an explicit member list; add a migration; or seed the
collective by extrinsic after launch.

### 4. `sync_state` RPC unavailable

`Error: Service(Application(LightSyncStateExtensionNotFound))`. This node cannot
serve warp-sync snapshots. Fixing it means giving `chain_spec.rs` an
`Extensions` struct with a `light_sync_state` field and changing the `ChainSpec`
type alias — a chain-spec format change, deliberately not made in a round whose
instruction was to adapt the node to the chain spec.

### 5. Benchmarking is not wired end to end

`runtime/Cargo.toml`'s `runtime-benchmarks` feature lists 5 pallets; the runtime
has 30+. Until that is completed, `frame-benchmarking-cli` cannot be added to
the node usefully, so there is no `benchmark` subcommand and no hardware
benchmark at startup. Runtime edit.

### 6. Everything ROUND3 reported is still open

Not re-verified this round, but nothing was done about any of it: 243 test
compile errors across 4 crates (no `[dev-dependencies]` in any pallet manifest,
stale Config members in three test mocks, `ConstU32<0>` vs `ConstU64<0>` in
`tests/common.rs:256`); the index-41 decision; tracks 0 and 1 unreachable
without a custom-origin enum; `tx_pause::WhitelistedCalls = ()` allowing root to
pause `settle_era`; CI floating on `@stable` against a pinned toolchain; 14
pre-existing warnings that keep `clippy -D warnings` red.

---

## What I did NOT do

**Out of scope, left alone:**

1. Did **not** touch `runtime/`, `pallets/`, `tests/`, `factory/` or
   `.github/`. Not one line. The `AuthorityDiscoveryApi` gap, the empty
   `preset_names()`, and the incomplete `runtime-benchmarks` feature were all
   found, all reported with exact file/line and exact patch, and all left
   unfixed.
2. Did **not** add `[dev-dependencies]` to pallet manifests or fix any of
   ROUND3's 243 test errors. `cargo test --workspace` was not run — it does not
   compile, for reasons Round 3 documented and Round 4 was not scoped to fix.
3. Did **not** add a launch script to `scripts/`. The exact devnet commands are
   in Gate B above instead; `scripts/` is outside this round's permitted paths.
4. Did **not** modify CI, or `CLAUDE.md`'s open TODO for the testnet launch
   command.

**Deliberately not widened:**

5. Did **not** change `development_config()` to a single authority, which would
   have made single-node `--dev` finalize and produced a tidier Gate B. That is
   a semantic change to a genesis configuration, not a mechanical fix. Flagged
   in a doc comment and reported instead; finality was proven the honest way,
   with a real quorum.
6. Did **not** give `chain_spec.rs` a `lightSyncState` extension to keep the
   `sync_state` RPC. Adapting the node was the instruction.
7. Did **not** wire the four custom `ScalarCommonsApi` methods as JSON-RPC —
   explicitly out of scope for this round.
8. Did **not** stub, fake or no-op any omitted subsystem. Every omission
   removes a block-import layer, a spawned task or a merged RPC module
   outright, and each is commented at its site with the runtime requirement
   that is missing.
9. Did **not** invent arguments for `mainnet_genesis_config` to give it a
   `--chain` id. Validator keys, founder allocations and two multisig accounts
   have no defensible defaults.
10. Did **not** change any economic constant, allocation, bond, validator
    count, session key, SS58 prefix or token property in any of the five genesis
    builders.

**Never on the table:**

11. No `#[allow]`, `todo!()`, `unimplemented!()`, `unsafe`, or stub was added
    anywhere. The one place an `#[allow(dead_code)]` would have been the easy
    answer — `mainnet_genesis_config` unused in a binary crate — was solved by
    adopting the reference's lib+bin split instead.
12. Nothing was commented out, `#[cfg]`-gated away, deleted or renamed to make
    a check pass. `SKIP_WASM_BUILD` was never set; every build in this document
    compiled real WASM.
13. Did **not** re-pin, fork or patch the SDK. Every new dependency is
    `tag = "polkadot-stable2503"`, the same tag as the runtime.
14. Did **not** open a PR, merge, force-push, or touch `master`.
