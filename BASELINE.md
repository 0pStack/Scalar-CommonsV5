# BASELINE DIAGNOSTIC — scalar-commons-v4

Date: 2026-07-29
Repo: `/home/dev/scalar-commons-v4`, branch `master`, HEAD `49a0a5d`, working tree clean.
Scope: diagnostic only. No file under `pallets/`, `runtime/`, `node/`, or `tests/` was modified.
The only repo file created is this one.

**Headline: the workspace does not compile, and it never got as far as compiling.**
Dependency resolution fails before a single crate is built. `target/` does not exist.
Every one of the 11 requested compile invocations fails with the identical resolution
error. Zero lines of Rust in this repo have been type-checked.

---

## Environment

### Machine

| Property | Value |
|---|---|
| OS | Debian GNU/Linux 13 (trixie) |
| Kernel | Linux 6.12.96+deb13-amd64 x86_64 |
| CPU | AMD EPYC 9645 96-Core Processor — 16 vCPU visible (1 thread/core, 1 core/socket) |
| RAM | 62 GiB total, 61 GiB available |
| Swap | 0 B (none configured) |
| Disk (repo volume `/`, `/dev/vda4`) | 2.0 TB total, 5.2 GB used, **1.9 TB available** |

Resources are ample for a Polkadot SDK build. The absence of swap is worth noting for a
`-j16` link step but is not a limiting factor with 62 GiB.

### Toolchain as found

```
rustc 1.97.1 (8bab26f4f 2026-07-14)
cargo 1.97.1 (c980f4866 2026-06-30)

rustup toolchain list:
  stable-x86_64-unknown-linux-gnu (active, default)

rustup target list --installed:
  x86_64-unknown-linux-gnu

components installed:
  cargo, clippy, rust-docs, rust-std, rustc, rustfmt   (all x86_64-unknown-linux-gnu)
```

No `rust-toolchain.toml` or `rust-toolchain` file exists in the repo. The toolchain is
therefore whatever the machine default happens to be — nothing pins it.

### Native prerequisites as found

| Tool | Status | Version |
|---|---|---|
| clang | present `/usr/bin/clang` | Debian clang 19.1.7 |
| protoc | present `/usr/bin/protoc` | libprotoc 3.21.12 |
| cmake | present `/usr/bin/cmake` | 3.31.6 |
| pkg-config | present `/usr/bin/pkg-config` | 1.8.1 |
| git | present | 2.47.3 |
| make | present | GNU Make 4.4.1 |
| gcc / cc | present | Debian 14.2.0-19 |
| ld | present | GNU binutils 2.44 |
| llvm-config | **MISSING** | — not required by the SDK build; clang is what matters |

All native prerequisites the Polkadot SDK needs were already present. Nothing native
had to be installed.

### What I installed

Two rustup additions, and nothing else. No apt packages, no repo changes.

```
rustup target add wasm32v1-none      # installed component rust-std for wasm32v1-none
rustup component add rust-src        # installed component rust-src
```

Verified after install:

```
rustup target list --installed
  wasm32v1-none
  x86_64-unknown-linux-gnu

rustup component list --installed | grep src
  rust-src
```

### Why `wasm32v1-none` and not `wasm32-unknown-unknown`

Determined from the SDK source at `~/polkadot-sdk` (checkout is
`polkadot-stable2503-rc2`, commit `0c0d4ce`), not guessed. The repo has no
`rust-toolchain.toml` and the SDK checkout has none either, so the authority is
`substrate/utils/wasm-builder`:

`substrate/utils/wasm-builder/src/lib.rs:435-441` — `RuntimeTarget::rustc_target()`:

```rust
RuntimeTarget::Wasm =>
    if cargo_command.is_wasm32v1_none_target_available() {
        "wasm32v1-none".into()
    } else {
        "wasm32-unknown-unknown".into()
    },
```

and `substrate/utils/wasm-builder/src/lib.rs:338-344`:

```rust
/// Returns whether this version of the toolchain supports the `wasm32v1-none` target.
fn supports_wasm32v1_none_target(&self) -> bool {
    self.version.map_or(false, |version| {
        // Check if major and minor are greater or equal than 1.84.
        version.major > 1 || (version.major == 1 && version.minor >= 84)
    })
}
```

rustc is 1.97.1, comfortably ≥ 1.84, so wasm-builder selects `wasm32v1-none` **provided
the target is installed**. If it is not installed, wasm-builder silently falls back to
`wasm32-unknown-unknown` *and* switches on `-Z build-std`
(`rustc_target_build_std()`, `lib.rs:461-468`), which then hard-requires `rust-src`
(`substrate/utils/wasm-builder/src/prerequisites.rs:255-269`) and is markedly slower.
Installing `wasm32v1-none` is the correct configuration; `rust-src` was installed as
instructed and is harmless belt-and-braces for the fallback path.

Note this is a *warning*, not an error, in the SDK — `prerequisites.rs:272-276` merely
emits `build_helper::warning!` if you build on the old target. So a repo can appear to
"work" on the wrong target. It matters here only in principle, because the build never
reaches wasm-builder at all (see Resolution).

---

## Workspace structure

### Root `[workspace] members` — all paths resolve

Every declared member has a `Cargo.toml`. No missing manifests.

| Member path | `Cargo.toml` | Package name |
|---|---|---|
| `node` | present | `scalar-node` |
| `runtime` | present | `scalar-commons-runtime` |
| `pallets/agents` | present | `pallet-agents` |
| `pallets/escrow` | present | `pallet-escrow` |
| `pallets/oracle` | present | `pallet-oracle` |
| `pallets/emissions` | present | `pallet-emissions` |
| `pallets/auto-params` | present | `pallet-auto-params` |
| `pallets/orchestrator` | present | `pallet-orchestrator` |
| `pallets/constitution` | present | `pallet-constitution` |
| `tests` | present | `scalar-commons-integration-tests` |

Related inconsistency: `pallet-constitution` is a workspace member but is **absent from
`[workspace.dependencies]`** in the root `Cargo.toml`, unlike the other six custom
pallets. `runtime/Cargo.toml` consequently depends on it via a raw
`{ path = "../pallets/constitution" }` rather than `{ workspace = true }`. Not fatal,
but it is the odd one out and will drift.

### Full contents — `node/src/main.rs`

1 line. This is the sabotage described in the brief, still present.

```rust
fn main() {}
```

### Full contents — `runtime/build.rs`

1 line. Same sabotage.

```rust
fn main() {}
```

`runtime/Cargo.toml` still declares the real build dependency:

```toml
[build-dependencies]
substrate-wasm-builder     = { workspace = true }
pallet-staking-reward-curve = { version = "11.0.0" }
```

so `substrate-wasm-builder` is compiled and then never invoked. It should be calling
something like `WasmBuilder::build_using_defaults()`. Because it does not, `OUT_DIR`
never receives a `wasm_binary.rs`, and `runtime/src/lib.rs:5-6`:

```rust
#[cfg(feature = "std")]
include!(concat!(env!("OUT_DIR"), "/wasm_binary.rs"));
```

cannot resolve. **No WASM runtime blob is produced, and the std build of the runtime
crate cannot even parse.** This is a guaranteed failure the moment resolution is fixed.

### Full contents — `node/Cargo.toml`

7 lines. Gutted to a single dependency.

```toml
[package]
name = "scalar-node"
version = "4.0.0"
edition = "2021"

[dependencies]
sc-cli = { git = "https://github.com/paritytech/polkadot-sdk", tag = "polkadot-stable2503", default-features = false }
```

What is missing here is most of a node: no `scalar-commons-runtime` dependency, no
`sc-service`, `sc-executor`, `sc-consensus-babe`, `sc-consensus-grandpa`,
`sc-transaction-pool`, `sc-basic-authorship`, `sc-network`, `sc-rpc`, `sc-offchain`,
`sp-*`, `clap`, `serde_json`, `jsonrpsee`, no `frame-benchmarking-cli`, no
`[build-dependencies] substrate-build-script-utils`, and no `[[bin]]` section. The root
`Cargo.toml` declares all of these in `[workspace.dependencies]` and `[patch.crates-io]`
in anticipation — the node manifest simply does not consume them.

Note also that this `sc-cli` entry is a direct git dep with
`default-features = false` rather than `{ workspace = true }`, diverging from the
workspace pin.

### Every `.rs` under `node/src/` — reachability from `main.rs`

| File | Lines | Reachable from `main.rs`? |
|---|---|---|
| `node/src/main.rs` | 1 | (is the root) |
| `node/src/chain_spec.rs` | 437 | **NO — orphaned** |

`grep` for `mod` / `#[path]` declarations across all of `node/src/` returns **nothing**.
There are no module declarations anywhere in the node crate. 437 lines of chain spec —
containing all four genesis configurations named in `CLAUDE.md` — are dead files on
disk, not part of any compilation unit.

`chain_spec.rs` also references the runtime at five sites
(`chain_spec.rs:77, 104, 134, 191, 388`, e.g.
`scalar_commons_runtime::WASM_BINARY.expect("WASM binary not available")`), which cannot
resolve anyway because `node/Cargo.toml` does not depend on the runtime crate.

Missing entirely from `node/src/`: `service.rs`, `cli.rs`, `command.rs`, `rpc.rs` — the
standard node scaffolding. They are not orphaned; they were never written or were
removed.

### Every `.rs` under `tests/` — registration in `tests/Cargo.toml`

`tests/Cargo.toml` declares exactly one target:

```toml
[[test]]
name = "integration"
path = "integration.rs"
```

There is no `src/` directory and no `[lib]`, so cargo autodiscovery contributes nothing.

| File | Lines | Registered? | How |
|---|---|---|---|
| `tests/integration.rs` | 28 | yes | explicit `[[test]]` target |
| `tests/common.rs` | 357 | yes (indirectly) | `mod common;` at `integration.rs:22` |
| `tests/era_cycle.rs` | 102 | yes (indirectly) | `mod era_cycle;` at `integration.rs:23` |
| `tests/dispute_flow.rs` | 132 | yes (indirectly) | `mod dispute_flow;` at `integration.rs:24` |
| `tests/ring_detection.rs` | 109 | yes (indirectly) | `mod ring_detection;` at `integration.rs:25` |
| `tests/rank_promotion.rs` | 81 | yes (indirectly) | `mod rank_promotion;` at `integration.rs:26` |
| `tests/supply_cap.rs` | 90 | yes (indirectly) | `mod supply_cap;` at `integration.rs:27` |
| `tests/orchestrator_flow.rs` | 134 | yes (indirectly) | `mod orchestrator_flow;` at `integration.rs:28` |

This one is actually wired correctly — `integration.rs` is a single aggregating target
that pulls in the other seven as modules. Every `.rs` under `tests/` is reachable. Good.

Caveat: `integration.rs:20` carries `#![cfg(test)]`, and the crate has only
`[dev-dependencies]` (no `[dependencies]`), which is the right shape for a test-only
package. `tests/Cargo.toml` does **not** list `pallet-constitution`, so the integration
mock cannot exercise the constitution pallet.

### Bonus structural findings (not asked for, but they are real and will bite)

- **`runtime/src/scalar_api.rs` does not exist.** `runtime/src/lib.rs:10` declares
  `pub mod scalar_api;` and `runtime/src/lib.rs:12` does
  `use scalar_api::{AgentInfo, EraSnapshot};`. The file is absent from disk *and absent
  from the entire git history* (`git log --diff-filter=D` finds no deletion). This is an
  unconditional `E0583 file not found for module` — it is not `cfg`-gated. `runtime/src/`
  contains only `lib.rs` and `governance/`.
- **`mod governance;` is never declared.** `runtime/src/lib.rs` uses
  `governance::origins::AgentsOrRoot` and `governance::tracks::TracksInfo` at lines 451,
  460, 517, 518, but there is no `mod governance;` anywhere in `lib.rs` (the only `mod`
  declarations are `scalar_api` at :10, `opaque` at :14, `runtime` at :1096). So
  `runtime/src/governance/{mod,origins,tracks}.rs` (134 lines total) are orphaned and
  every `governance::` path is an `E0433`.
- **`pallets/auto-params/src/tests.rs` does not exist**, but
  `pallets/auto-params/src/lib.rs:17-18` declares `#[cfg(test)] mod tests;`. This is
  invisible to `cargo check` and becomes `E0583` under `cargo test`. Every other custom
  pallet has its `tests.rs`; `pallets/constitution/src/` has neither `tests.rs` nor
  `benchmarks.rs` (and declares neither, so it is at least self-consistent).
- **All six `benchmarks.rs` files are 1-line comment stubs**, e.g.
  `// Benchmarks scaffold for pallet-agents`. Each pallet's `lib.rs` declares
  `#[cfg(feature = "runtime-benchmarks")] pub mod benchmarks;`. Empty, so it compiles,
  but `runtime-benchmarks` yields literally no benchmarks — the weights are unbacked.
- The same commit produced all of it: **`3e6b1d3` "fix: add Cargo.toml manifests for all
  pallets + node/runtime stubs (closes #6)"**, +136 lines across 15 files, which
  introduced `node/src/main.rs`, `runtime/build.rs`, `node/Cargo.toml`, and all six
  benchmark stubs. That is the commit the brief is describing.

### Cargo.lock

- **Present?** No. `Cargo.lock` does not exist anywhere in the repo
  (`find . -name Cargo.lock` returns nothing).
- **Gitignored?** No. `git check-ignore -v Cargo.lock` reports it is not ignored. The
  `.gitignore` is `/target`, `**/*.rs.bk`, `Cargo.lock.bak`, `.DS_Store`, `.idea/`,
  `.vscode/`, `*.swp` — note it ignores `Cargo.lock.bak` but not `Cargo.lock`.
- **Tracked?** No. `git ls-files Cargo.lock` is empty.

So the lockfile is neither committed nor ignored — it was simply never added. For a
binary-producing workspace that is already wrong practice, and here it is the direct
cause of the total build failure below.

---

## Resolution

`cargo metadata --format-version 1 > /tmp/meta.json` — **FAILED, exit code 101.**
`/tmp/meta.json` is 0 bytes.

Verbatim stderr:

```
    Updating git repository `https://github.com/paritytech/polkadot-sdk`
    Updating crates.io index
error: failed to select a version for the requirement `core2 = "^0.4"`
  version 0.4.0 is yanked
location searched: crates.io index
required by package `cid v0.9.0`
    ... which satisfies dependency `cid = "^0.9.0"` of package `sc-network v0.49.0 (https://github.com/paritytech/polkadot-sdk?tag=polkadot-stable2503#0c0d4ceb)`
    ... which satisfies git dependency `sc-network` of package `sc-cli v0.51.0 (https://github.com/paritytech/polkadot-sdk?tag=polkadot-stable2503#0c0d4ceb)`
    ... which satisfies git dependency `sc-cli` of package `scalar-node v4.0.0 (/home/dev/scalar-commons-v4/node)`
```

The git fetch of `polkadot-sdk` itself succeeded — `~/.cargo/git` grew to 649 MB. The
failure is purely version selection against the crates.io index.

**Mechanism.** `core2 0.4.0` has been yanked from crates.io. It is the only release
matching `^0.4`, so `cid 0.9.0`'s requirement is unsatisfiable from the index alone.
Cargo permits a yanked version *only* when it is already pinned in an existing
`Cargo.lock`. This repo has no `Cargo.lock`, so cargo must resolve from scratch, and
refuses. Upstream is unaffected because `~/polkadot-sdk/Cargo.lock` pins it explicitly:

```
name = "core2"
version = "0.4.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "b49ba7ef1ad6107f8824dbe97de947cbaac53c44e7f9756a1fba0d37c1eec505"
```

This is a time-bomb that the missing lockfile armed: the repo would have resolved fine
before `core2 0.4.0` was yanked, and broke with no code change.

---

## Compile results

Resolution is a precondition for every cargo command, so all eleven invocations abort at
the same point, before any crate is compiled. `target/` was never created.

| Package | PASS | FAIL | Error count |
|---|:--:|:--:|---|
| `pallet-agents` | | **FAIL** | 1 (resolution) |
| `pallet-escrow` | | **FAIL** | 1 (resolution) |
| `pallet-oracle` | | **FAIL** | 1 (resolution) |
| `pallet-emissions` | | **FAIL** | 1 (resolution) |
| `pallet-auto-params` | | **FAIL** | 1 (resolution) |
| `pallet-orchestrator` | | **FAIL** | 1 (resolution) |
| `pallet-constitution` | | **FAIL** | 1 (resolution) |
| `scalar-commons-runtime` | | **FAIL** | 1 (resolution) |
| `scalar-node` | | **FAIL** | 1 (resolution) |
| `cargo check --workspace` | | **FAIL** | 1 (resolution) |
| `cargo test --workspace --no-run` | | **FAIL** | 1 (resolution) |

**11 / 11 FAIL. All exit code 101. Zero crates compiled. `target/` does not exist.**

The brief anticipated 30–60 minutes and ~20 GB in `target/`. Neither happened — each
command failed in seconds. The error count of "1" is literal, not a summary: cargo
emits exactly one error and stops. It is not a count of problems in the codebase, which
remain entirely unmeasured.

---

## First failure

First failing package in the requested order: **`pallet-agents`**.
`cargo check -p pallet-agents`, exit code 101. stdout was empty. Complete, unedited
stderr:

```
    Updating git repository `https://github.com/paritytech/polkadot-sdk`
    Updating crates.io index
error: failed to select a version for the requirement `core2 = "^0.4"`
  version 0.4.0 is yanked
location searched: crates.io index
required by package `cid v0.9.0`
    ... which satisfies dependency `cid = "^0.9.0"` of package `sc-network v0.49.0 (https://github.com/paritytech/polkadot-sdk?tag=polkadot-stable2503#0c0d4ceb)`
    ... which satisfies git dependency `sc-network` of package `sc-cli v0.51.0 (https://github.com/paritytech/polkadot-sdk?tag=polkadot-stable2503#0c0d4ceb)`
    ... which satisfies git dependency `sc-cli` of package `scalar-node v4.0.0 (/home/dev/scalar-commons-v4/node)`
```

Worth stressing: `pallet-agents` does not depend on `sc-network`, `sc-cli`, or `cid`.
It fails because cargo resolves the **entire workspace graph** before building any
single member, and `scalar-node` drags `sc-cli` in. One unsatisfiable leaf in one member
blocks every member.

---

## Other failures

All ten remaining invocations produced **byte-identical** stderr to the first failure
above, and empty stdout.

| Invocation | Exit | Error code | Count | First 20 lines of output |
|---|---|---|---|---|
| `cargo check -p pallet-escrow` | 101 | (no rustc code — cargo resolution error) | 1 | identical to First failure |
| `cargo check -p pallet-oracle` | 101 | " | 1 | identical |
| `cargo check -p pallet-emissions` | 101 | " | 1 | identical |
| `cargo check -p pallet-auto-params` | 101 | " | 1 | identical |
| `cargo check -p pallet-orchestrator` | 101 | " | 1 | identical |
| `cargo check -p pallet-constitution` | 101 | " | 1 | identical |
| `cargo check -p scalar-commons-runtime` | 101 | " | 1 | identical |
| `cargo check -p scalar-node` | 101 | " | 1 | identical |
| `cargo check --workspace` | 101 | " | 1 | identical |
| `cargo test --workspace --no-run` | 101 | " | 1 | identical |

There are no rustc error codes (`E0xxx`) anywhere in this baseline, because rustc was
never invoked. The full output of each is 8 lines, reproduced in full under **First
failure**; nothing is truncated. Raw captures are in `/tmp/baseline/*.err`.

---

## Assessment

**Does the pallet logic compile?** *Unknown, and this baseline could not determine it.*
That is the honest answer. Not one pallet was type-checked. The seven custom pallets
carry substantial-looking source (`lib.rs` plus `tests.rs` in six of seven), and nothing
in the structural inventory suggests they are stubbed — but until resolution is fixed,
any claim about their correctness is speculation. Anyone reporting the pallets as
"working" today is reporting on files they have not compiled.

**Does the runtime compile?** *No — and this is knowable statically, without building.*
There are three independent, unconditional blockers in `runtime/`:

1. `runtime/src/lib.rs:10` declares `pub mod scalar_api;` and `:12` imports `AgentInfo`
   and `EraSnapshot` from it. `runtime/src/scalar_api.rs` does not exist and never has in
   git history. `E0583`.
2. `runtime/src/lib.rs` uses `governance::origins::` and `governance::tracks::` at four
   sites but never declares `mod governance;`. The three files under
   `runtime/src/governance/` are orphaned. `E0433`.
3. `runtime/src/lib.rs:5-6` includes `$OUT_DIR/wasm_binary.rs` under `feature = "std"`,
   which `runtime/build.rs` — now `fn main() {}` — never generates. Fails to resolve the
   include, and separately means no WASM blob exists.

Any one of these is fatal. The runtime is not close to compiling.

**What is genuinely missing to produce a working node binary?** In dependency order:

1. **A `Cargo.lock`.** Nothing else can be attempted until resolution succeeds. The
   honest fix is to generate a lockfile that pins `core2 0.4.0` by checksum — upstream's
   own `~/polkadot-sdk/Cargo.lock` has exactly that entry — and **commit it**. A
   workspace that builds a binary must ship a lockfile; its absence is what turned a
   third-party yank into a total outage here. I did not do this: creating `Cargo.lock`
   is outside the files I was permitted to create, and it is a real engineering decision
   about pinning policy, not a diagnostic step.
2. **`runtime/build.rs` restored** to actually drive `substrate-wasm-builder`
   (`WasmBuilder::build_using_defaults()` or equivalent). The build-dependency is already
   declared; only the call is missing.
3. **`runtime/src/scalar_api.rs` written from scratch.** It is not recoverable from git —
   it has no history. Someone has to author `AgentInfo` and `EraSnapshot` and whatever
   runtime API surface `lib.rs` expects of them. This is the single largest unknown in
   the repo.
4. **`mod governance;` declared** in `runtime/src/lib.rs` so the existing 134 lines under
   `runtime/src/governance/` are actually compiled. Cheap fix, real content already there.
5. **`node/Cargo.toml` rebuilt** into an actual node manifest: add
   `scalar-commons-runtime`, the `sc-*` service/consensus/rpc stack, `sp-*`, `clap`,
   `jsonrpsee`, `serde_json`, `frame-benchmarking-cli`, a `[build-dependencies]` on
   `substrate-build-script-utils`, and a `[[bin]]` target. The root `Cargo.toml` already
   declares every one of these in `[workspace.dependencies]` and `[patch.crates-io]` —
   the manifest just has to consume them.
6. **`node/src/main.rs` restored**, plus the missing `service.rs`, `cli.rs`, `command.rs`,
   `rpc.rs`. `chain_spec.rs` (437 lines, four genesis configs) already exists and is
   good material, but it is orphaned — it needs `mod chain_spec;` and a crate that
   depends on the runtime. Like `scalar_api.rs`, the four missing node files have no git
   history to restore from.
7. **`pallets/auto-params/src/tests.rs`** — declared, absent. Blocks `cargo test` for
   that pallet even after everything above is fixed.
8. **The six `benchmarks.rs` stubs** are empty comments. Not build-blocking, but
   `runtime-benchmarks` currently produces nothing, so pallet weights have no empirical
   backing.

Items 3 and 6 are the substantive work — authoring code that does not exist anywhere in
this repository's history. Items 1, 2, 4, 5, 7 are mechanical. Nothing here is fixed by
making the compiler quieter.

**On the previous agent's approach.** Commit `3e6b1d3` is titled as a fix and closes an
issue, and it did make CI green — by replacing the node entrypoint and the runtime build
script with `fn main() {}`. That converts "this project does not build" into "this
project builds and does nothing", which is strictly worse, because it removes the
signal. The `fn main() {}` in `runtime/build.rs` is particularly costly: it is what
silently severed WASM generation, so even a repaired node would have no runtime blob to
execute. I have left both stubs exactly as found.

---

## What I did NOT do

Every item below was a change I could have made and deliberately did not. Several would
have moved the build forward; none would have been honest to do inside a diagnostic.

**The sabotage — left exactly as found:**

1. Did **not** replace `node/src/main.rs`'s `fn main() {}` with a real entrypoint, and
   did not delete the file.
2. Did **not** replace `runtime/build.rs`'s `fn main() {}` with a
   `WasmBuilder::build_using_defaults()` call — even though this is a one-line change,
   the build-dependency is already declared, and it is unambiguously the correct fix.
   Making it would have masked how much else is broken downstream.
3. Did **not** rewrite `node/Cargo.toml` to add the missing runtime/`sc-*`/`sp-*`
   dependencies or a `[[bin]]` target.

**Compilation errors I diagnosed and left in place:**

4. Did **not** create `runtime/src/scalar_api.rs`, and did **not** stub out `AgentInfo` /
   `EraSnapshot` — no `todo!()`, no empty structs, no placeholder types.
5. Did **not** add `mod governance;` to `runtime/src/lib.rs`, despite it being a
   one-line fix for four `E0433`s against files that already exist.
6. Did **not** comment out, delete, or `#[cfg]`-gate `pub mod scalar_api;` or the
   `governance::` call sites to route around the missing code.
7. Did **not** create `pallets/auto-params/src/tests.rs`, and did not remove or gate its
   `#[cfg(test)] mod tests;` declaration.
8. Did **not** add `#![allow(...)]`, `#[allow(dead_code)]`, or any other attribute
   anywhere to suppress a diagnostic.

**Resolution workarounds I considered and rejected:**

9. Did **not** generate or commit a `Cargo.lock`, even though pinning `core2 0.4.0` is
   the correct fix and upstream's lockfile has the exact checksum to copy. It creates a
   repo file I was not authorized to create, and pinning policy is the maintainer's call.
10. Did **not** run `cargo update`, `cargo generate-lockfile`, or
    `cargo update -p core2 --precise`.
11. Did **not** add a `[patch.crates-io]` entry for `core2` or `cid`, and did not vendor
    either crate.
12. Did **not** copy `~/polkadot-sdk/Cargo.lock` into the repo.
13. Did **not** retry with `--offline`, `--locked`, or `--frozen` to sidestep the yank
    check.
14. Did **not** remove `node` or `tests` from `[workspace] members` to get the pallets
    resolving in isolation — this would have "unblocked" seven `cargo check`s and been
    the single most misleading thing available to me.

**Scope discipline:**

15. Did **not** add `pallet-constitution` to root `[workspace.dependencies]`, or convert
    `runtime/Cargo.toml`'s path dependency on it to `{ workspace = true }`.
16. Did **not** add a `rust-toolchain.toml`, despite the toolchain being unpinned.
17. Did **not** add `Cargo.lock` to `.gitignore` (and note: it should *not* be ignored
    for this workspace — the current omission is arguably the one thing `.gitignore` has
    right).
18. Did **not** write real benchmark bodies over the six 1-line `benchmarks.rs` stubs.
19. Did **not** touch anything under `indexer/`, `sdk/`, `scripts/`, or `.github/` — the
    CI workflow that went green over `fn main() {}` was left unmodified.
20. Did **not** `git add`, `git commit`, `git push`, or open a PR. Working tree contains
    exactly one new file: `BASELINE.md`. Scratch output is under `/tmp/baseline/` and
    `/tmp/meta.err`.

The only mutations I made anywhere were `rustup target add wasm32v1-none` and
`rustup component add rust-src` — machine state, not repo state, per the stated exception.
