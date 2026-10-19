# ROUND 5 — Closing the two runtime gaps Round 4 exposed

Date: 2026-08-01
Branch: `rebuild/runtime` (continued). Predecessors: `BASELINE.md`, `ROUND2.md`,
`ROUND3.md`, `ROUND4.md`.

**Task 1 (AuthorityDiscoveryApi): complete and verified live on a network.**
**Task 2 (runtime-benchmarks graph): wired in full, 10 of 11 errors cleared.
The last one is in a file this round may not modify. Reported verbatim, not
worked around.**

Six commits. Nothing was stubbed, no `#[allow]` was added, no test was deleted,
no code was commented out.

---

## Headline results

| Gate | Result |
|---|---|
| `cargo build --release` (whole workspace) | **PASS** — 4m26s, `scalar-node 4.0.0-196c4d716d8` |
| 3-validator devnet, blocks | **PASS** — best `#28`, no regression |
| 3-validator devnet, finality | **PASS** — finalized `#26`, tracking ~2 behind |
| Authority-discovery worker spawns clean | **PASS** — zero errors/warnings across all three nodes |
| Worker is *live*, not merely spawned | **PASS** — `known_authorities_count = 2` on each node, `handle_value_found_event_failure = 0` |
| `cargo check -p scalar-commons-runtime` (default) | **PASS** — no regression |
| `cargo check -p scalar-commons-runtime --features runtime-benchmarks` | **FAIL — 1 error**, in `runtime/src/lib.rs:350`, out of scope. Was 10 errors across 3 SDK crates before this round. |

---

## Task 1 — AuthorityDiscoveryApi

### What changed

**`runtime/Cargo.toml`** — added `sp-authority-discovery` (`workspace = true`,
so `default-features = false` per the workspace entry) and forwarded
`sp-authority-discovery/std`.

**`runtime/src/lib.rs`** — one API added to `impl_runtime_apis!`:

```rust
impl sp_authority_discovery::AuthorityDiscoveryApi<Block> for Runtime {
    fn authorities() -> Vec<sp_authority_discovery::AuthorityId> {
        AuthorityDiscovery::authorities()
    }
}
```

Identical in substance to the kitchensink runtime's
(`substrate/bin/node/runtime/src/lib.rs:3259`); the only difference is that
this runtime has no `AuthorityDiscoveryId` alias in scope, so the type is
spelled out.

No adaptation was needed, and I checked rather than assumed:
`pallet_authority_discovery::Pallet::authorities()`
(`substrate/frame/authority-discovery/src/lib.rs:81`) returns the current
session's keys concatenated with the next session's, sorted and deduplicated —
which is exactly the contract `AuthorityDiscoveryApi` documents, *"identifiers
of the current and next authority set"*.

**`spec_version` 301 → 302.** This adds an entry to `RUNTIME_API_VERSIONS`,
which is part of the `RuntimeVersion` a node checks before it will execute a
block, so the bump is required even though no storage layout changed. No
migration: the API only *reads* `pallet_authority_discovery`'s existing
`Keys`/`NextKeys`, which `pallet-session` already populates on every rotation.

**`node/Cargo.toml`** — re-added `sc-authority-discovery`.

**`node/src/service.rs`** — the reference's worker block restored intact
(`PublishAndDiscover` role, DHT event stream filtered off the network service,
`WorkerConfig` carrying `publish_non_global_ips` and `public_addresses`), plus
`use sc_network::{event::Event, NetworkBackend, NetworkEventStream}`. The two
config reads are hoisted above `spawn_tasks`, which consumes `config`; the
worker is spawned after it. Same ordering as the reference. The module doc
comment was rewritten to record why the omission existed rather than deleting
the history.

### Gate evidence

Release build, then the ROUND4 Gate B devnet procedure unchanged — `--chain
local`, Alice/Bob/Charlie, Bob and Charlie given **only Alice** as a bootnode
and never told about each other, **no `--reserved-nodes`**:

```
2026-08-01 12:36:46 💤 Idle (2 peers), best: #24 (0xdcdd…93a1), finalized #22 (0xce3c…7726), ⬇ 1.5kiB/s ⬆ 1.6kiB/s
2026-08-01 12:36:48 🏆 Imported #25 (0xdcdd…93a1 → 0x9c8b…dc52)
2026-08-01 12:36:48 🆕 Imported #25 (0xdcdd…93a1 → 0x4a38…0c5c)
2026-08-01 12:36:51 💤 Idle (2 peers), best: #25 (0x9c8b…dc52), finalized #23 (0x00f6…f8d3), ⬇ 1.8kiB/s ⬆ 1.9kiB/s
2026-08-01 12:36:54 🏆 Imported #26 (0x9c8b…dc52 → 0x83d3…c190)
2026-08-01 12:36:56 💤 Idle (2 peers), best: #26 (0x83d3…c190), finalized #24 (0xdcdd…93a1), ⬇ 1.5kiB/s ⬆ 1.9kiB/s
2026-08-01 12:37:00 🏆 Imported #27 (0x83d3…c190 → 0xc70c…a520)
```

Bob and Charlie agree at the same heights and hashes. **A scan for
`error|panic|failed|warn` across all three logs returns nothing.** No
regression against Round 4.

#### Proof the worker is live, not merely spawned

A spawned-but-broken worker looks identical at default log level, so this was
checked two ways.

**Prometheus**, scraped from each node before shutdown (`substrate_authority_discovery_*`):

| Metric | Alice | Bob | Charlie |
|---|--:|--:|--:|
| `known_authorities_count` | **2** | **2** | **2** |
| `times_published_total` | 6 | 6 | 6 |
| `amount_external_addresses_last_published` | 3 | 2 | 2 |
| `authority_addresses_requested_total` | 12 | 12 | 12 |
| `dht_event_received{value_found}` | 24 | 31 | 35 |
| `handle_value_found_event_failure` | **0** | **0** | **0** |

`known_authorities_count = 2` is each node knowing the *other* two authorities
(self excluded) — i.e. the runtime API returned a three-element authority set
and it was consumed. `handle_value_found_event_failure = 0` is the strong one:
every DHT record found was decoded and its signature verified against that set.
Before this round none of these metrics existed at all, because the worker
could not be constructed.

**Debug log** (`-l sub-authority-discovery=debug` — note the log target is
`sub-authority-discovery`, not the crate name). Alice publishing, then
resolving Bob and Charlie purely from the DHT:

```
2026-08-01 12:41:44.739 DEBUG tokio-runtime-worker sub-authority-discovery: Publishing authority DHT record peer_id='12D3KooWEyoppNCUx8Yx66oV9fJnriXwCcXwDDUA2kj6vnc6iDEp' with addresses='["/ip4/152.53.113.104/tcp/30343", "/ip6/2a0a:4cc0:80:4be2:84ed:47ff:fe39:edee/tcp/30343"]'
...
Found addresses for authority Public(… (5FHneW46...)): {"/ip4/152.53.113.104/tcp/30344/p2p/<peer>", "/ip6/…/tcp/30344/p2p/<peer>"}
Found addresses for authority Public(… (5FLSigC9...)): {"/ip4/152.53.113.104/tcp/30345/p2p/<peer>", "/ip6/…/tcp/30345/p2p/<peer>"}
Found a newer record for Public(… (5FHneW46...)) new record creation time 1785580925266460316 old record creation time 1785580913266181167
```

`5FHneW46…` and `5FLSigC9…` are Bob's and Charlie's `authority_discovery`
session keys from our own chain spec, and the ports (30344, 30345) are theirs.
Alice learned those addresses over the DHT, not from configuration — she was
never given them.

**Answering the question as asked:** Bob and Charlie ran with `--bootnodes`
pointing at Alice only, no `--reserved-nodes`, and were never given each
other's addresses. Both reached 2 peers and both resolved the full authority
set. Note honestly that peer *count* alone does not prove discovery — libp2p
would gossip peers regardless — which is why the metrics above are the actual
evidence.

#### One honest blemish

The debug log also carries, and the metrics count, 6 × `value_put_failed`:

```
DEBUG tokio-runtime-worker sub-authority-discovery: Failed to put hash 'Key(b"F \x87\x98…")' on Dht.
```

This is a Kademlia PUT failing to reach its replication quorum, which is
expected on a 3-node loopback network where the routing table is smaller than
the target replication factor. It is not caused by anything in this change: the
records demonstrably propagate anyway (`value_found` 24–35 per node,
`known_authorities_count = 2` everywhere, zero handling failures). Recorded
because it appears in the logs and should not surprise the next reader.

---

## Task 2 — runtime-benchmarks feature graph

### What changed

`runtime/Cargo.toml`'s `runtime-benchmarks` feature went from **5 entries to
40**. Membership was decided by reading each dependency's own `Cargo.toml` to
see whether it declares a `runtime-benchmarks` feature — not from memory. The
rule is the kitchensink runtime's, applied mechanically: everything that
exposes the feature gets it forwarded. (The kitchensink writes this as the
single line `polkadot-sdk/runtime-benchmarks` because it consumes the SDK
umbrella crate; this workspace pins individual crates, so the same graph is
spelled out.)

### Why the old state was worse than "incomplete"

The previous 5 entries included `frame-support/runtime-benchmarks`. That switch
turns **on** extra required methods across FRAME's traits, while the pallets
that implement those methods behind their own `runtime-benchmarks` cfg were
left **off**. The result was a feature graph that disagreed with itself.
Verbatim, from `cargo check -p scalar-commons-runtime --features
runtime-benchmarks` on the pre-Round-5 manifest — **10 errors, all inside SDK
crates**:

```
substrate/frame/ranked-collective/src/lib.rs:122:1: error[E0046]: not all trait items implemented, missing: `unanimity`, `rejection`, `from_requirements`, `setup`
substrate/frame/ranked-collective/src/lib.rs:276:1: error[E0046]: not all trait items implemented, missing: `try_successful_origin`
substrate/frame/ranked-collective/src/lib.rs:294:1: error[E0046]: not all trait items implemented, missing: `try_successful_origin`
substrate/frame/ranked-collective/src/lib.rs:303:1: error[E0046]: not all trait items implemented, missing: `try_successful_origin`
substrate/frame/ranked-collective/src/lib.rs:328:1: error[E0046]: not all trait items implemented, missing: `try_successful_origin`
substrate/frame/ranked-collective/src/lib.rs:349:1: error[E0046]: not all trait items implemented, missing: `try_successful_origin`
substrate/frame/ranked-collective/src/lib.rs:358:1: error[E0046]: not all trait items implemented, missing: `try_successful_origin`
substrate/frame/ranked-collective/src/lib.rs:382:1: error[E0046]: not all trait items implemented, missing: `try_successful_origin`
substrate/frame/conviction-voting/src/types.rs:59:1: error[E0046]: not all trait items implemented, missing: `unanimity`, `rejection`, `from_requirements`, `setup`
substrate/frame/referenda/src/lib.rs:756:1: error[E0046]: not all trait items implemented, missing: `create_ongoing`, `end_ongoing`

error: could not compile `pallet-ranked-collective` (lib) due to 8 previous errors
error: could not compile `pallet-conviction-voting` (lib) due to 1 previous error
error: could not compile `pallet-referenda` (lib) due to 1 previous error
```

Completing the graph **removes all ten**.

### The one remaining error — reported, not worked around

With the graph complete, exactly one error remains, and it is in our own
`runtime/src/lib.rs`, which this round's scope permits modifying **only** for
the two Task 1 changes. Verbatim:

```
error[E0053]: method `ensure_successful` has an incompatible type for trait
   --> /home/dev/scalar-commons-v4/runtime/src/lib.rs:350:29
    |
350 |     fn ensure_successful(_: &()) {}
    |                             ^^^ expected `()`, found `&()`
    |
    = note: expected signature `fn(())`
               found signature `fn(&())`
help: change the parameter type to match the trait
    |
350 |     fn ensure_successful(_: ()) {}
    |                             ~~

error: could not compile `scalar-commons-runtime` (lib) due to 1 previous error
```

The site is `NativeBalanceConverter`, the treasury's identity balance converter:

```rust
pub struct NativeBalanceConverter;
impl frame_support::traits::tokens::ConversionFromAssetBalance<Balance, (), Balance>
    for NativeBalanceConverter
{
    type Error = sp_runtime::DispatchError;
    fn from_asset_balance(balance: Balance, _: ()) -> Result<Balance, Self::Error> { Ok(balance) }
    #[cfg(feature = "runtime-benchmarks")]
    fn ensure_successful(_: &()) {}          // <- takes &(), trait takes ()
}
```

The trait takes the asset id **by value**
(`substrate/frame/support/src/traits/tokens/misc.rs:312`:
`fn ensure_successful(asset_id: AssetId);`), and the SDK's own blanket impl at
line 328 is `fn ensure_successful(_: AssetId) {}`. This is pre-existing dead
code that has never been compiled by anything, because it sits behind a
`runtime-benchmarks` cfg that had never successfully been enabled.

**This cannot be dodged by partial wiring.** Every pallet's own
`runtime-benchmarks` feature itself forwards `frame-support/runtime-benchmarks`,
so any non-empty subset of the graph turns the trait method on. There is no
"partial wiring that honestly compiles" available here — the choice is the
complete graph plus this one-token fix, or nothing.

**I verified the fix is sufficient without committing it.** I applied
`&()` → `()` in the working tree, ran
`cargo check -p scalar-commons-runtime --features runtime-benchmarks`, got
`EXIT=0` with zero errors (including the WASM inner build), then reverted
`runtime/src/lib.rs` to its committed state. `git diff` confirms the file is
untouched in what shipped. So: **the completed graph plus that single token is
a green `runtime-benchmarks` build.** Authorizing that one-token change is all
Round 6 needs for this gap.

### Feature state table

Every dependency that exposes `runtime-benchmarks` is wired. All compile.

**Scalar Commons pallets** — each verified individually with
`cargo check -p <pallet> --features runtime-benchmarks`:

| Pallet | Wired | Compiles | Note |
|---|:--:|:--:|---|
| `pallet-agents` | yes | **OK** | `benchmarks.rs` is a 41-byte comment-only file |
| `pallet-escrow` | yes | **OK** | 41-byte comment-only |
| `pallet-oracle` | yes | **OK** | 41-byte comment-only |
| `pallet-emissions` | yes | **OK** | 44-byte comment-only |
| `pallet-auto-params` | yes | **OK** | 46-byte comment-only |
| `pallet-orchestrator` | yes | **OK** | 47-byte comment-only |
| `pallet-constitution` | yes | **OK** | no `benchmarks.rs`, no `mod` decl |

The six `benchmarks.rs` files contain a single comment line each (e.g.
`// Benchmarks scaffold for pallet-agents`) and are declared as
`#[cfg(feature = "runtime-benchmarks")] pub mod benchmarks;`. They compile
because an empty module is valid — but they define **no benchmarks**, so no
weights can be generated for any Scalar Commons extrinsic. Writing them was
explicitly out of scope this round and none were written.

**SDK dependencies** — all wired, all compile under the completed graph:

| Group | Crates |
|---|---|
| FRAME core (6) | `frame-support`, `frame-system`, `frame-benchmarking`, `frame-election-provider-support`, `sp-runtime`, `sp-staking` |
| Consensus / staking (7) | `pallet-babe`, `pallet-grandpa`, `pallet-staking`, `pallet-offences`, `pallet-bags-list`, `pallet-im-online`†, `pallet-election-provider-multi-phase`† |
| Tokens (6) | `pallet-balances`, `pallet-transaction-payment`, `pallet-timestamp`, `pallet-vesting`, `pallet-assets`†, `pallet-nomination-pools` |
| Governance / admin (14) | `pallet-sudo`, `pallet-scheduler`, `pallet-utility`, `pallet-multisig`, `pallet-preimage`, `pallet-referenda`, `pallet-conviction-voting`, `pallet-ranked-collective`, `pallet-salary`†, `pallet-identity`, `pallet-treasury`, `pallet-whitelist`, `pallet-safe-mode`, `pallet-tx-pause` |

† Declared in `[dependencies]` but **not** present in `construct_runtime`.
Forwarded anyway so the graph stays uniform and cannot silently skew if one is
later wired in. Called out in a comment in the manifest.

Dependencies that expose **no** `runtime-benchmarks` feature, correctly absent:
`pallet-session`, `pallet-authority-discovery`, `pallet-authorship`,
`frame-executive`, `pallet-staking-reward-curve`, and all `sp-*` crates other
than `sp-runtime` and `sp-staking`.

---

## Remaining gaps

1. **`runtime/src/lib.rs:350` — `ensure_successful(_: &())` should be
   `(_: ())`.** One token. Blocks the entire `runtime-benchmarks` build.
   Verified sufficient (above). Out of scope this round.
2. **No benchmarks exist.** Six comment-only `benchmarks.rs` files, zero
   `#[benchmarks]` blocks, so no Scalar Commons extrinsic has a measured
   weight. The runtime currently uses `SubstrateWeight` and hand-set values.
   With gap 1 fixed, the node could then add `frame-benchmarking-cli` and the
   `benchmark` subcommand (ROUND4 gap 5's other half) — but there would still
   be nothing to run until benchmarks are written.
3. **Runtime `GenesisBuilder` presets still empty** (ROUND4 gap 2) — untouched.
4. **Genesis still cannot seed `RankedCollective`** (ROUND4 gap 3) — untouched.
   The TC is three controller accounts at rank 2 where the spec intended three
   stash accounts at rank 1.
5. **`sync_state` RPC still unavailable** (ROUND4 gap 4) — untouched.
6. **Everything ROUND3 reported is still open** — 243 test compile errors
   across 4 crates, the index-41 decision, tracks 0 and 1 unreachable,
   `tx_pause::WhitelistedCalls = ()` letting root pause `settle_era`, CI
   floating on `@stable`, and the pre-existing warnings that keep
   `clippy -D warnings` red. `cargo test --workspace` was not run this round;
   it still does not compile.
7. **`--dev` single-node still does not finalize** — `development_config()` has
   three authorities by design. Not a defect; documented in Round 4.

---

## What I did NOT do

**Held to scope:**

1. Did **not** fix `runtime/src/lib.rs:350`, despite proving it is the single
   remaining blocker and knowing the exact one-token fix. Scope permits
   `runtime/src/lib.rs` only for the two Task 1 changes. I applied it in the
   working tree solely to verify sufficiency, then reverted; it is not in any
   commit and `git diff` on that file is empty apart from Task 1.
2. Did **not** write a single benchmark. The six comment-only `benchmarks.rs`
   files are exactly as I found them.
3. Did **not** touch `pallets/*/Cargo.toml`. Scope allowed `[features]` wiring
   there, but no change was needed: all seven already forward
   `frame-support`, `frame-system` and `frame-benchmarking` correctly, and all
   seven compile under the feature. Permission unused is not permission owed.
4. Did **not** touch `node/src/{cli,command,rpc,chain_spec,lib,main}.rs`,
   `runtime/src/governance/`, `runtime/src/scalar_api.rs`, `tests/`,
   `indexer/`, `.github/`, `scripts/` or `factory/`.
5. Did **not** add `frame-benchmarking-cli` or a `benchmark` subcommand to the
   node. That is ROUND4 gap 5's other half and depends on gap 1 above.

**Deliberately not widened:**

6. Did **not** drop entries from the benchmarks graph to manufacture a green
   build. That would have been the "partial wiring" escape hatch, and it does
   not exist here — every pallet's feature pulls in
   `frame-support/runtime-benchmarks`, which is what triggers the error. A
   graph trimmed until it compiled would have been the half-enabled state that
   caused the original 10 errors.
7. Did **not** change any economic constant, weight, curve, genesis allocation,
   pallet index, or storage layout. The only runtime behaviour added is one
   read-only runtime API.
8. Did **not** re-pin, fork or patch the SDK.

**Never on the table:**

9. No `#[allow]`, `todo!()`, `unimplemented!()`, stub or `#[cfg]`-gating-away
   was added anywhere. Nothing was commented out or deleted to make a check
   pass. `SKIP_WASM_BUILD` was never set — every build in this document
   compiled real WASM.
10. Did **not** open a PR, merge, force-push, or touch `master`.
