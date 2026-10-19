# ROUND 6 — Benchmarks unblocked, CI armed

Date: 2026-08-01
Branch: `rebuild/runtime`. Predecessors: `BASELINE.md`, `ROUND2.md`,
`ROUND3.md`, `ROUND4.md`, `ROUND5.md`.

| Task | Result |
|---|---|
| **1 — one-token fix** | **DONE.** `runtime-benchmarks` build is green. No `spec_version` bump, and the WASM blob is proven byte-identical. |
| **2 — benchmark subcommand** | **WIRED, gate BLOCKED.** The subcommand works (`benchmark machine` runs end to end). `benchmark pallet --list` cannot run: the runtime does not declare the `frame_benchmarking::Benchmark` API. Out of scope. Reported verbatim. |
| **3 — arm CI** | **DONE**, plus three environment bugs found that would each have made every run red on their own. |
| **3c amendment — run the tests** | **6 of 90 tests FAIL.** CI gets `--no-run` only, per instruction. Every failure verbatim below. |

Four commits. Nothing stubbed, no `#[allow]`, no test touched, nothing
commented out.

---

## Task 1 — the one-token fix

`runtime/src/lib.rs`: `fn ensure_successful(_: &())` → `fn ensure_successful(_: ())`.

The trait takes the asset id **by value** —
`fn ensure_successful(asset_id: AssetId);`
(`substrate/frame/support/src/traits/tokens/misc.rs:312`), and the SDK's own
blanket impl at line 328 reads `fn ensure_successful(_: AssetId) {}`.

### Gate evidence

```
$ cargo check -p scalar-commons-runtime --features runtime-benchmarks
BENCH_EXIT=0        errors: 0

$ cargo build --release          # default features
    Finished `release` profile [optimized] target(s) in 4m 24s
EXIT=0
```

### The `spec_version` check, stated explicitly

The claim is that the changed code is cfg-gated out of production builds, so
no bump is needed. I did not assert this — I measured it, and the first
measurement was misleading, which is worth recording.

Naively hashing the runtime blob before and after the change showed a
**difference**. That is not evidence of a semantic change: my edit added an
8-line explanatory comment above the function, and Substrate bakes
`file!`/`line!` panic locations into the WASM, so every subsequent line number
in `lib.rs` shifted.

The controlled experiment holds the comment fixed and toggles **only** the
token:

| Build | `compact.compressed.wasm` sha256 |
|---|---|
| comment present, `_: &()` | `f09ab8d75dbfc95d3af9b042aaf003a0e8e3333b7d64fcfd0d440eda73bbe7b6` |
| comment present, `_: ()` | `f09ab8d75dbfc95d3af9b042aaf003a0e8e3333b7d64fcfd0d440eda73bbe7b6` |

**Byte-identical.** The item does not exist in a default build, the production
runtime is unchanged, and there is nothing for a version bump to signal.
`spec_version` stays at 302.

---

## Task 2 — benchmark subcommand

### What changed

* `node/Cargo.toml` — `frame-benchmarking-cli`, plus a `runtime-benchmarks`
  feature forwarding to the runtime and the four SDK crates that expose one
  (`frame-benchmarking-cli`, `pallet-staking`, `sc-service`, `sp-runtime` —
  determined by reading each dependency's manifest).
* `node/src/cli.rs` — the `Benchmark(frame_benchmarking_cli::BenchmarkCmd)`
  subcommand.
* `node/src/command.rs` — the dispatch arm, ported from the reference.

Two deviations, both deliberate:

**`frame-benchmarking-cli` is declared inline** with the same git tag rather
than through `[workspace.dependencies]`, because the root manifest carries it
only in `[patch.crates-io]` and root `Cargo.toml` is outside this round's
scope. `runtime/Cargo.toml` already declares three dependencies this way, so
the pattern is not new. Promoting it is cosmetic follow-up.

**`Overhead` and `Extrinsic` return an explicit error.** In the reference both
are driven by a `benchmarking.rs` module of extrinsic builders (`RemarkBuilder`,
`TransferKeepAliveBuilder`) that construct and sign real calls. Writing those
is authoring benchmark support code, which this round explicitly does not do,
and `benchmarking.rs` is not in scope. They report exactly what they need
rather than pretending to measure:

```
Overhead benchmarking is not wired for this node: it needs an extrinsic
builder (the reference's `RemarkBuilder`) and inherent benchmark data.
```

This is the SDK's own idiom for an unavailable variant — the reference does the
same for `Storage` when the feature is off.

### An unrelated blocker found on the way: `comfy-table`

```
error[E0658]: `let` expressions in this position are unstable
  --> comfy-table-7.2.2/src/utils/arrangement/disabled.rs:21:12
  --> comfy-table-7.2.2/src/utils/formatting/content_format.rs:101:12
```

`comfy-table` is a transitive dependency of `frame-benchmarking-cli`. 7.2.2
uses let-chains, which need rustc ≥ 1.88; we are pinned to 1.85.0 and cannot
move (ROUND3: this SDK tag does not build on newer rustc). Resolved by pinning
`Cargo.lock` to **7.1.4**, the version the SDK itself locks at this tag — not a
number I chose, a number I looked up in `~/polkadot-sdk/Cargo.lock`.

### Gate evidence — the wiring works

```
$ cargo check -p scalar-node                                EXIT=0
$ cargo check -p scalar-node --features runtime-benchmarks  EXIT=0

$ ./target/release/scalar-node benchmark --help
Commands:
  pallet     Benchmark the extrinsic weight of FRAME Pallets
  storage    Benchmark the storage speed of a chain snapshot
  overhead   Benchmark the execution overhead per-block and per-extrinsic
  block      Benchmark the execution time of historic blocks
  machine    Command to benchmark the hardware
  extrinsic  Benchmark the execution time of different extrinsics

$ ./target/release/scalar-node benchmark machine --dev --allow-fail
| CPU      | BLAKE2-256            | 661.84 MiBs | 1000.00 MiBs | ❌ Fail ( 66.2 %) |
| CPU      | SR25519-Verify        | 814.67 KiBs | 637.62 KiBs  | ✅ Pass (127.8 %) |
| Memory   | Copy                  | 18.27 GiBs  | 11.49 GiBs   | ✅ Pass (158.9 %) |
| Disk     | Seq Write             | 3.04 GiBs   | 950.00 MiBs  | ✅ Pass (328.0 %) |
| Disk     | Rnd Write             | 1.66 GiBs   | 420.00 MiBs  | ✅ Pass (405.7 %) |
From 6 benchmarks in total, 4 passed and 2 failed (10% fault tolerance).
EXIT=0
```

`benchmark machine` runs the full hardware suite end to end. (The two CPU
"Fail" rows are this VM being slower than the SDK's reference hardware — a
finding about the machine, not the wiring.)

### Gate BLOCKED — `benchmark pallet --list`

The requested gate does **not** pass. Verbatim, on a node built with
`--features runtime-benchmarks`:

```
$ ./target/release/scalar-node benchmark pallet --list
2026-08-01 13:56:45 [0] 💸 generated 3 npos voters, 3 from validators and 0 nominators
2026-08-01 13:56:45 [0] 💸 generated 3 npos targets
2026-08-01 13:56:45 Loading WASM from state
Error: Input("Did not find the benchmarking runtime api. This could mean that
you either did not build the node correctly with the `--features
runtime-benchmarks` flag, or the chain spec that you are using was not created
by a node that was compiled with the flag")
EXIT=1
```

The message's two suggested causes are both wrong here; the real cause is a
third. **The runtime never declares the `frame_benchmarking::Benchmark` runtime
API.** `impl_runtime_apis!` contains thirteen APIs and that is not one of them:

```
sp_api::Core                       sp_consensus_grandpa::GrandpaApi
sp_api::Metadata                   sp_authority_discovery::AuthorityDiscoveryApi
sp_block_builder::BlockBuilder     frame_system_rpc_runtime_api::AccountNonceApi
sp_transaction_pool::…::TaggedTransactionQueue
sp_offchain::OffchainWorkerApi     pallet_transaction_payment_rpc_runtime_api::TransactionPaymentApi
sp_session::SessionKeys            crate::scalar_api::ScalarCommonsApi
sp_consensus_babe::BabeApi         sp_genesis_builder::GenesisBuilder
```

Confirmed against the compiled blob's export table, not just the source. In the
benchmarks-enabled `scalar_commons_runtime.wasm`:

```
$ strings …/scalar_commons_runtime.wasm | grep -E "^Benchmark_"
(nothing)

$ strings …/scalar_commons_runtime.wasm | grep -c AuthorityDiscoveryApi_authorities
2
```

The second line validates the detection method — Round 5's API *is* found by
the same command, so the absence of `Benchmark_*` is real.

**The alternative route is blocked too, by a different, already-known gap.**
The deprecation notice suggests `--runtime <blob> --genesis-builder=runtime`:

```
$ ./target/release/scalar-node benchmark pallet \
    --runtime …/scalar_commons_runtime.compact.compressed.wasm \
    --genesis-builder=runtime --list
Error: Input("The preset with name Some(\"development\") is not available.")
EXIT=1
```

That is ROUND4 gap 2 — `GenesisBuilder::preset_names()` returns `vec![]`, so
the runtime advertises no presets for the CLI to build genesis from.

**What Round 7 needs** (a `runtime/src/lib.rs` change, out of scope here): add
to `impl_runtime_apis!`, gated on `#[cfg(feature = "runtime-benchmarks")]`, a
`frame_benchmarking::Benchmark<Block>` impl with its `benchmark_metadata` and
`dispatch_benchmark` methods plus the `define_benchmarks!` list — the
kitchensink runtime's version is the model. That changes
`RUNTIME_API_VERSIONS`, so it needs a `spec_version` bump.

**Our 7 pallets would be absent from the list regardless**, exactly as the task
anticipated: all six `benchmarks.rs` files are single comment lines (41–47
bytes), `pallet-constitution` has none at all, and no `#[benchmarks]` block
exists anywhere. Recorded as expected; none were written.

---

## Task 3 — CI

### Before (quoted verbatim)

`ci-full.yml`:

```yaml
# Full gate: workspace tests on merge to main (and on demand via label `full-ci`).
name: ci-full
on:
  push:
    branches: [main]
  pull_request:
    types: [labeled]
  workflow_dispatch:
jobs:
  test:
    if: github.event_name != 'pull_request' || github.event.label.name == 'full-ci'
    runs-on: ubuntu-latest
    timeout-minutes: 120
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
      - run: cargo test --workspace --release
      - name: indexer tests
        run: |
          if [ -f indexer/package.json ]; then
            cd indexer && npm ci && npm test
          fi
```

`ci-fast.yml`:

```yaml
# Fast PR gate: every agent PR must pass this before human review.
name: ci-fast
on:
  pull_request:
  workflow_dispatch:
jobs:
  gate:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: rustfmt, clippy
      - uses: Swatinem/rust-cache@v2
      - run: cargo fmt --all -- --check
      - run: cargo clippy --workspace --all-targets -- -D warnings
      - run: cargo check --workspace
      - name: indexer tests (if present)
        run: |
          if [ -f indexer/package.json ]; then
            cd indexer && npm ci && npm test
          fi
```

**ci-full has never executed, once.** Confirmed:

```
$ git symbolic-ref refs/remotes/origin/HEAD
refs/remotes/origin/master

$ git branch -a | grep -w main
(no branch 'main' exists)
```

It triggers on `push: branches: [main]`. There is no `main`. Its only other
path required a `full-ci` label on a PR. Every green merge in this repository's
history was green because nothing ran.

### After — trigger blocks

`ci-full.yml`:

```yaml
on:
  push:
    branches: [master]
  pull_request:
    branches: [master]
  workflow_dispatch:
```

`ci-fast.yml` (unchanged — it was already correct):

```yaml
on:
  pull_request:
  workflow_dispatch:
```

### Three environment bugs, each fatal on its own

Fixed in both files. Any one of these would have made every run red for
reasons unrelated to the code under test.

**1. The toolchain was overridden.** `dtolnay/rust-toolchain@stable` *sets* the
toolchain, defeating `rust-toolchain.toml`'s 1.85.0 pin — and per ROUND3 this
SDK tag cannot be compiled by a newer rustc at all (`sp-io`'s `#[no_mangle]`
panic handler is rejected outright). ROUND3 flagged this and it was still
live. Now the channel is read out of the file, so there is one source of truth
and drift is impossible, and a step asserts we got what we asked for:

```yaml
- name: Resolve pinned toolchain
  id: toolchain
  run: echo "channel=$(grep -oP 'channel\s*=\s*"\K[^"]+' rust-toolchain.toml)" >> "$GITHUB_OUTPUT"
- uses: dtolnay/rust-toolchain@master
  with:
    toolchain: ${{ steps.toolchain.outputs.channel }}
    targets: wasm32v1-none
    components: rust-src
- name: Assert the pinned toolchain is what we got
  run: |
    rustc --version
    rustc --version | grep -q '${{ steps.toolchain.outputs.channel }}'
```

The grep was verified locally: it yields `1.85.0`.

**2. protoc was missing.** `sc-network` depends on `litep2p`, whose
build-dependency `prost-build` shells out to `protoc`:

```
$ cargo tree -p scalar-node -i prost-build
prost-build v0.13.2
[build-dependencies]
└── litep2p v0.9.3
    └── sc-network v0.49.0
```

GitHub's ubuntu images do not ship it. Both workflows now install
`protobuf-compiler`.

**3. The indexer guard could never fire** (item e). It tested for
`indexer/package.json`:

```
$ ls indexer/
reconcile.py
```

One Python file, no `package.json`, no JS test suite. The step was a silent
no-op dressed as a check. Removed from both files rather than left in place.
When the Node indexer lands it gets a real step, in its own job.

### ci-full jobs (all blocking)

| Step | Purpose | Verified locally |
|---|---|---|
| `cargo build --release` | **anti-stub gate** | EXIT=0 |
| `test -x target/release/scalar-node` | binary exists | EXIT=0 |
| `./scalar-node --version` | it runs | `scalar-node 4.0.0-f53fafbc7e4` |
| `./scalar-node build-spec --chain dev --raw` | WASM executes: `GenesisBuilder::build_state` runs *inside the runtime* to produce this | EXIT=0 |
| `cargo check --workspace --features runtime-benchmarks` | the feature graph Round 5 found half-wired | EXIT=0 |
| `cargo test --workspace --no-run` | tests compile | EXIT=0 |

The build step is the anti-stub gate the round asked for: `node/src/main.rs`
was `fn main() {}` for this project's entire life and no check noticed. A stub
cannot compile the workspace, produce a binary, answer `--version`, and execute
a runtime to build genesis.

I ran the exact step sequence locally on a default (non-benchmarks) build:

```
step 'cargo build --release'          EXIT=0
step 'test -x scalar-node'            EXIT=0
scalar-node 4.0.0-f53fafbc7e4
step '--version'                      EXIT=0
step 'build-spec --chain dev --raw'   EXIT=0
```

### Task 3c — the tests

`cargo test --workspace --no-run` exits 0, as the amendment said. So I executed
the suite. **It is not green.**

```
$ cargo test --workspace --no-run
EXIT=0        real 2m44s

$ cargo test --workspace
EXIT=101      (aborted at the first failing crate)

$ cargo test --workspace --no-fail-fast
EXIT=101
```

| Crate | Passed | Failed |
|---|--:|--:|
| `pallet-agents` | 25 | **1** |
| `pallet-emissions` | 7 | **3** |
| `pallet-oracle` | 9 | **1** |
| `pallet-orchestrator` | 9 | **1** |
| `pallet-escrow` | 13 | 0 |
| `scalar-commons-integration-tests` | 17 | 0 |
| `scalar-commons-runtime` | 4 | 0 |
| **Total** | **84** | **6** |

Note the first run stopped after `pallet-agents`; the table needed
`--no-fail-fast` to be complete. All six failures, verbatim:

```
---- tests::integer_sqrt_correct stdout ----
thread 'tests::integer_sqrt_correct' panicked at pallets/agents/src/lib.rs:190:21:
attempt to add with overflow

---- tests::accumulator_increases_on_era_settlement stdout ----
thread 'tests::accumulator_increases_on_era_settlement' panicked at pallets/emissions/src/tests.rs:199:9:
accumulator should have increased

---- tests::agent_can_claim_after_settlement stdout ----
thread 'tests::agent_can_claim_after_settlement' panicked at pallets/emissions/src/tests.rs:211:9:
Expected Ok(_). Got Err(
    Module(
        ModuleError {
            index: 3,
            error: [1, 0, 0, 0],
            message: Some("NothingToClaim"),
        },
    ),
)

---- tests::higher_stake_earns_proportionally_more stdout ----
thread 'tests::higher_stake_earns_proportionally_more' panicked at pallets/emissions/src/tests.rs:242:9:
alice with 10K stake should outweigh bob with 1K

---- tests::expire_request_refunds_creator stdout ----
thread 'tests::expire_request_refunds_creator' panicked at pallets/oracle/src/tests.rs:244:9:
Expected Ok(_). Got Err(
    Module(
        ModuleError {
            index: 3,
            error: [4, 0, 0, 0],
            message: Some("ChallengeTooShort"),
        },
    ),
)

---- tests::sub_agent_cannot_link_to_two_orchestrators stdout ----
thread 'tests::sub_agent_cannot_link_to_two_orchestrators' panicked at pallets/orchestrator/src/tests.rs:228:9:
Expected Ok(_). Got Err(
    Module(
        ModuleError {
            index: 3,
            error: [5, 0, 0, 0],
            message: Some("AlreadyLinked"),
        },
    ),
)
```

Per the amendment: CI gets **only** `cargo test --workspace --no-run`, and
none of the failing tests were touched.

**One of these deserves escalation beyond "a test fails."**
`pallets/agents/src/lib.rs:190`:

```rust
/// Integer square root (Newton's method). Correct for all u128 values.
/// weight ∝ √stake so 100× stake → 10× weight (not 100×) — anti-whale.
pub fn integer_sqrt(n: u128) -> u128 {
    if n == 0 { return 0; }
    let mut x = n;
    let mut y = (x + 1) / 2;      // <- line 190: overflows when n == u128::MAX
    while y < x { x = y; y = (x + n / x) / 2; }
    x
}
```

Three reasons this is more than a red test:

1. The doc comment says *"Correct for all u128 values"*. It is not.
2. It uses bare `+`, which CLAUDE.md prohibits outright: *"Balance arithmetic
   uses `saturating_*` / `checked_*` only. No bare `+ - *`."*
3. **The panic only happens in debug.** Release builds wrap silently, so in the
   production WASM this returns a *wrong square root* rather than failing —
   and `integer_sqrt` is the anti-whale curve feeding emission weight. A silent
   wrong answer in the weighting function is a worse failure mode than a panic.

`pallets/**` is outside this round's scope, so it is reported, not fixed.

### ci-fast — the minimum change, and an honest status

Steps are unchanged: `fmt`, `clippy -D warnings`, `cargo check --workspace`.
Only the toolchain, protoc and dead-indexer-guard fixes were applied.

**Measured on this branch, two of the three steps currently FAIL:**

```
$ cargo fmt --all -- --check
FMT_EXIT=1        551 diff hunks across ~30 files
                  (node/, pallets/, runtime/, tests/ — essentially the whole tree)

$ cargo clippy --workspace --all-targets -- -D warnings
CLIPPY_EXIT=101
pallets/auto-params/src/lib.rs:38:9:   error: unused import: `sp_std::vec::Vec`
pallets/auto-params/src/tests.rs:14:8: error: duplicated attribute
error: could not compile `pallet-auto-params` (lib) due to 1 previous error

$ cargo check --workspace
EXIT=0            PASSES
```

Both failures are in files outside this round's scope (`pallets/auto-params`,
and formatting spans the entire tree). **I left them as blocking steps.** The
alternatives were `continue-on-error` or deletion, and both amount to hiding
the debt — which is precisely how this repository ended up with a node that was
`fn main() {}` and a CI file pointing at a branch that does not exist. Clearing
them is a small, mechanical, self-contained commit: two one-line clippy fixes,
then `cargo fmt --all`.

**Consequence, stated plainly: until that commit lands, ci-fast will be red on
every PR, and a branch protection rule requiring it would block merges.** That
is the correct state for a repository whose lint gate has never been run.

### CODEOWNERS

New `.github/CODEOWNERS`, requiring review from `@tejaspatil1936` on `*` plus
the four T0/T1 paths explicitly: `/runtime/**`, `/pallets/**`, `/node/**`,
`/.github/**` (CI guards itself).

### Workflows deliberately untouched

`claude.yml`, `claude-opus.yml`, `file-issues.yml`, `auto-merge-claude.yml`,
`continuous-watch.yml`, `pr-ci-feedback.yml` — confirmed unmodified:

```
$ git status --short .github/
 M .github/workflows/ci-fast.yml
 M .github/workflows/ci-full.yml
?? .github/CODEOWNERS
```

---

## Remaining gaps

1. **`frame_benchmarking::Benchmark` runtime API not declared** — blocks
   `benchmark pallet`. New this round. Runtime change + `spec_version` bump.
2. **No benchmarks exist** — six comment-only `benchmarks.rs` files, zero
   `#[benchmarks]` blocks. Even with gap 1 fixed, our 7 pallets list nothing.
3. **6 of 90 tests fail**, itemised above. The `integer_sqrt` overflow is the
   one to fix first, on economic-correctness grounds, not test-hygiene grounds.
4. **ci-fast is red**: 551 fmt hunks, 2 clippy issues in `pallets/auto-params`.
5. **Branch protection is not a file.** CODEOWNERS only *requests* review.
   Making it blocking, and making ci-full/ci-fast required, are settings on
   `master` in the GitHub UI or via `gh api`. Nothing committed to this
   repository can do it, so the gate is not actually enforced until someone
   sets it.
6. **CI has never been observed to run.** Everything above was verified by
   executing the equivalent commands locally on the same pinned toolchain; the
   YAML is parse-checked, but no GitHub Actions run exists to point at. The
   first push to a PR against `master` is the real test.
7. **ROUND4 gap 2 — `GenesisBuilder::preset_names()` empty** — still open, and
   now has a second consequence: it blocks the `--runtime` route for
   benchmarking.
8. ROUND4 gaps 3 (genesis cannot seed `RankedCollective`) and 4 (`sync_state`
   RPC) — untouched. ROUND3's open items — index-41 decision, tracks 0/1
   unreachable, `tx_pause::WhitelistedCalls = ()` allowing root to pause
   `settle_era` — untouched.

---

## What I did NOT do

**Held to scope:**

1. Did **not** touch `runtime/src/lib.rs` beyond the single authorized token
   (plus an explanatory comment above it). Specifically did **not** add the
   `frame_benchmarking::Benchmark` API, though I know exactly what it needs and
   it is the only thing standing between here and a working `benchmark pallet`.
2. Did **not** write a benchmark, or a `benchmarking.rs` extrinsic-builder
   module. The six comment-only `benchmarks.rs` files are as I found them.
3. Did **not** touch any failing test, or the code under it — including
   `integer_sqrt`, despite it violating a CLAUDE.md hard rule and silently
   returning wrong values in release builds.
4. Did **not** touch `pallets/auto-params`, where the two clippy errors live,
   even though fixing them is two lines and would move ci-fast closer to green.
5. Did **not** run `cargo fmt --all`. It would rewrite ~30 files across every
   directory in the repository.
6. Did **not** touch root `Cargo.toml` — hence `frame-benchmarking-cli` is
   declared inline in `node/Cargo.toml` rather than as a workspace dependency.
7. Did **not** touch the six disabled workflows, `tests/`, `indexer/`,
   `scripts/`, `factory/`, or any node source beyond `cli.rs`/`command.rs`.

**Deliberately not widened:**

8. Did **not** make any CI step non-blocking, and did **not** delete the
   failing fmt/clippy steps. A check that cannot fail is not a check — the same
   defect as the indexer guard I was asked to remove.
9. Did **not** add a full `cargo test --workspace` step to CI, per the
   amendment, because six tests fail.
10. Did **not** bump `spec_version`. Verified by byte-comparison rather than
    assumed.
11. Did **not** change any economic constant, weight, curve, genesis
    allocation, pallet index, or storage layout. The production WASM blob this
    round produces is byte-identical to Round 5's for the same source lines.

**Never on the table:**

12. No `#[allow]`, `todo!()`, `unimplemented!()`, or stub anywhere. Nothing
    commented out, `#[cfg]`-gated away, or deleted to make a check pass.
    `SKIP_WASM_BUILD` never set.
13. Did **not** open a PR, merge, force-push, or touch `master`.
