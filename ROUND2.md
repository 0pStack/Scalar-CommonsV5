# ROUND 2 — Unblock resolution, make the runtime compile, emit real WASM

Date: 2026-07-29
Branch: `rebuild/runtime`, forked from `master` @ `49a0a5d`.
Predecessor: `BASELINE.md` (Round 1 diagnostic).

**Outcome: partial. Resolution is fixed and four of seven pallets now compile
from a workspace that previously compiled nothing at all. WASM was NOT emitted.**

The build script is wired correctly and demonstrably runs `substrate-wasm-builder`
— but three separate blockers stand between here and a runtime blob, and all
three are outside the file scope I was given. They are documented precisely
below rather than worked around.

Headline numbers: **0 → 4 of 7 pallets green**, and the count of crates that
reach the compiler at all went from **0 to every crate in the workspace**.

---

## What changed

Seven commits, smallest-first. No file outside the permitted scope was touched.

| # | Commit | File(s) | What |
|---|---|---|---|
| 1 | `f4e53a8` | `Cargo.lock` (new) | Seeded from upstream SDK, reconciled |
| 2 | `96ad7ed` | `runtime/build.rs` | Stub → real `WasmBuilder` script |
| 3 | `c14b703` | `runtime/src/lib.rs` | Added missing `mod governance;` |
| 4 | `d50d8b1` | `runtime/src/scalar_api.rs` (new) | Authored the missing module |
| 5 | `b4f28b1` | `pallets/{agents,oracle,emissions}/Cargo.toml` | Declared 4 used-but-undeclared deps |
| 6 | `cf4be69` | `runtime/Cargo.toml` | `default-features = false` on `pallet-constitution` |
| 7 | `cf0f733` | `Cargo.lock` | Recorded the new dependency edges |

### 1. `Cargo.lock` — `f4e53a8`

Copied `~/polkadot-sdk/Cargo.lock` to the repo root, then ran
`cargo metadata --format-version 1 >/dev/null` to reconcile. It succeeded on the
first attempt, exit 0. Reconciliation added our ten workspace members and pruned
unused entries: **28,184 → 11,071 lines**.

`core2` is pinned exactly as upstream has it, which is the whole point of the
exercise:

```
name = "core2"
version = "0.4.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "b49ba7ef1ad6107f8824dbe97de947cbaac53c44e7f9756a1fba0d37c1eec505"
```

Byte-identical to the upstream checksum. `git check-ignore -v Cargo.lock` reports
not-ignored; `.gitignore` was not modified; the file is tracked.

The reconcile emits ten `warning: patch ... was not used in the crate graph`
lines (`sc-basic-authorship`, `sc-consensus-babe`, `frame-benchmarking-cli`, …).
These are expected and not a defect: `node/Cargo.toml` is still gutted to a
single `sc-cli` dependency, so nothing in the graph consumes those patches. They
should disappear when the node layer is restored in Round 3.

### 2. `runtime/build.rs` — `96ad7ed`

Replaced `fn main() {}` with a real build script calling
`substrate_wasm_builder::WasmBuilder::build_using_defaults()`, gated on `std`
with a no-op `#[cfg(not(feature = "std"))]` arm.

Pattern taken from `~/polkadot-sdk/templates/solochain/runtime/build.rs` at tag
`polkadot-stable2503`, checked against the pinned `substrate-wasm-builder`
**26.0.0** (`pub fn build_using_defaults()` at `src/builder.rs:144`). The
`metadata-hash` variant used by `substrate/bin/node/runtime/build.rs` was
deliberately not copied — this runtime declares no `metadata-hash` feature, and
adding one would be inventing scope.

Verified to actually run: the inner wasm build now creates
`target/*/wbuild/scalar-commons-runtime/` and compiles several hundred SDK
crates for `wasm32v1-none`. It gets as far as the runtime itself before failing
(see **Remaining failures**).

### 3. `runtime/src/lib.rs` — `c14b703`

Added `pub mod governance;` with a one-line comment. That is the entire diff —
five lines including whitespace and comment. No logic touched.

This makes the previously orphaned `runtime/src/governance/{mod,origins,tracks}.rs`
reachable, resolving the `governance::origins::AgentsOrRoot` /
`governance::tracks::TracksInfo` references at lines 451, 460, 517, 518.

### 4. `runtime/src/scalar_api.rs` — `d50d8b1`

Authored from scratch. See **scalar_api.rs design decisions** below.

### 5. Pallet manifests — `b4f28b1`

The manifests created in `3e6b1d3` were written without consulting what the
pallet sources import, so four crates that the code had always used were never
declared. All four are `use`d in sources I was forbidden to touch, so declaring
them is the only legal fix — and the correct one:

| Pallet | Added | Used at |
|---|---|---|
| `agents` | `sp-io` | `lib.rs:714,738` (`offchain_index`), `lib.rs:1066` (`hashing::blake2_256`) |
| `oracle` | `sp-io` | `lib.rs:278,378,428` (`hashing::blake2_256`) |
| `oracle` | `pallet-escrow` | `lib.rs:466-468` (`DisputeOracle`, `DisputeCallback`, `PROVIDER_WINS_PREIMAGE`) |
| `emissions` | `pallet-auto-params` | `lib.rs:20` (`AutoParamsProvider`), `lib.rs:301` (`EraMetrics`) |

Each is propagated through that crate's `std` feature list. Both new inter-pallet
edges are acyclic — `escrow` does not depend on `oracle`, and `auto-params`
depends on no sibling pallet — so no dependency cycle is introduced.

This single commit took `pallet-agents`, `pallet-escrow`, and `pallet-oracle`
from failing to green.

### 6. `runtime/Cargo.toml` — `cf4be69`

`pallet-constitution` was the **only** runtime dependency declared without
`default-features = false`:

```toml
pallet-constitution     = { path = "../pallets/constitution" }
```

Its `default = ["std"]` therefore stayed enabled during the wasm-builder inner
build, dragging `std` into `wasm32v1-none`. `getrandom` and `subtle` then failed
with `can't find crate for 'std'` / `target is not supported`. Adding
`default-features = false` fixed it, and the inner wasm build advanced past
those crates to the runtime itself.

This is squarely the "feature/std propagation fix" the scope permits. It was
found via the scratch probe described under **Remaining failures** — the repo as
committed cannot reach this stage on its own, but the defect is real, and
leaving it unfixed would have cost Round 3 a full debug cycle.

---

## Compile results

Real repository on branch `rebuild/runtime`, stock `stable` toolchain
(rustc 1.97.1). "Before" is Round 1's baseline, where every invocation died at
dependency resolution before any crate compiled.

| Package | Before | After | Errors after | Codes |
|---|:--:|:--:|:--:|---|
| `pallet-agents` | FAIL *(resolution)* | **PASS** | 0 | — |
| `pallet-escrow` | FAIL *(resolution)* | **PASS** | 0 | — |
| `pallet-oracle` | FAIL *(resolution)* | **PASS** | 0 | — |
| `pallet-emissions` | FAIL *(resolution)* | FAIL | 1 | `E0221` |
| `pallet-auto-params` | FAIL *(resolution)* | **PASS** | 0 | — |
| `pallet-orchestrator` | FAIL *(resolution)* | FAIL | 1 | `E0221` *(inherited from emissions)* |
| `pallet-constitution` | FAIL *(resolution)* | FAIL | 2 | `E0599`, `E0308` |
| `scalar-commons-runtime` | FAIL *(resolution)* | FAIL | 1 | `E0221` *(inherited; runtime crate not reached)* |
| `scalar-node` | FAIL *(resolution)* | *not attempted* | — | node layer out of scope this round |

**4 of 7 pallets green, from 0.** Two of the three remaining failures
(`orchestrator`, `runtime`) contain no errors of their own — they are blocked
solely by `pallet-emissions`. The genuine remaining defects are **3 errors
across 2 files**.

`cargo build --release -p scalar-commons-runtime` (step 6) fails at the same
`pallet-emissions` error and therefore never reaches the build script. **No
`.wasm` artifact exists anywhere in any target directory.**

---

## scalar_api.rs design decisions

The module had to satisfy exactly one consumer — `runtime/src/lib.rs` — and I
inventoried every constraint before writing a line. Repo-wide grep for
`scalar_api` / `ScalarApi` / `AgentInfo` / `EraSnapshot` across `.rs`, `.ts`,
`.js`, `.md`, `.json` found **zero** references outside `lib.rs`: nothing in
`indexer/`, `sdk/`, `docs/`, `node/`, or `tests/`. So the observable contract is
precisely four things:

- `lib.rs:12` — `use scalar_api::{AgentInfo, EraSnapshot};`
- `lib.rs:1297` — `impl crate::scalar_api::ScalarCommonsApi<Block, AccountId, Balance, BlockNumber> for Runtime`
- the four method bodies at `lib.rs:1298-1364`
- the two struct literals at `lib.rs:1323` and `lib.rs:1334`

Everything below follows from those. Decisions I was forced to make:

**1. It is a `decl_runtime_apis!` trait, not a plain trait.** The impl sits
inside `impl_runtime_apis!` and passes four generic arguments to a trait the
call site names with three (`Block` first). That signature shape is only
produced by `decl_runtime_apis!`, which injects `Block` itself. This also
explains the `scalar_api` naming — `impl_runtime_apis!` generates its own `api`
module, hence the rename noted at `lib.rs:8`.

**2. Field types were read off the storage items, not guessed.** Every field
was traced to the storage declaration it is populated from:

| Field | Type | Source |
|---|---|---|
| `stake` | `Balance` | `agents::AgentStake` → `BalanceOf<T>` |
| `completions` | `u32` | `agents::CompletedAgreements` |
| `era_volume` | `Balance` | `agents::EraEscrowVolume` |
| `unique_buyers` | `u32` | `agents::EraUniqueBuyers` |
| `last_heartbeat` | `BlockNumber` | `agents::LastHeartbeat` → `BlockNumberFor<T>` |
| `capabilities` | `Vec<u32>` | `agents::AgentCapabilities` → `BoundedVec<u32,_>.to_vec()` |
| `uri` / `name` | `Vec<u8>` | `AgentMeta.uri` / `.name` → `BoundedVec<u8,_>.to_vec()` |
| `orchestrator` | `Option<AccountId>` | `orchestrator::SubAgentToOrchestrator` (`OptionQuery`) |
| `completion_fee_bps`, `alpha`, `beta`, `floor_bps` | `u32` | `auto_params::*` |
| `last_era_emission` | `Balance` | `emissions::LastEraEmission` |

**3. `total_weight` is `u128`, deliberately not `Balance`.** It is a sum over
`emissions::AgentWeightSnapshot`, which stores `u128` *scores*, not token
amounts. `EraSnapshot` is generic only over `Balance`, and typing this field as
`Balance` would both break inference on `.sum()` and falsely imply the value is
denominated in CMN. It is a weight, so it is `u128` with a comment saying why.

**4. `heartbeat_multiplier` is `u32`, narrowing the pallet's `u128`.** Not my
choice — `lib.rs:1326` already writes `heartbeat_mult as u32`. I matched the
existing cast rather than widen the struct and silently change the call site's
meaning. Documented on the field.

**5. serde derives are `std`-gated.** Not speculative: `runtime/Cargo.toml`
states the intent explicitly at the `serde` dependency —
*"serde needed for AgentInfo/EraSnapshot `#[cfg_attr(feature="std", derive(Serialize,Deserialize))]` … required by jsonrpsee `#[rpc]` macro"*. That comment describes a
design that had been decided; I implemented it as described. `serde` is already
optional and already in the `std` feature list, so no manifest change was needed.

**6. `get_oracle_score` and `get_pending_emissions` stay separate methods.**
They are separate in the impl. `get_oracle_score` takes a `capability`
parameter, so it cannot fold into `AgentInfo` (an agent has one score per
capability); `get_pending_emissions` duplicates a field on `AgentInfo` so a
caller polling one number needn't assemble the whole struct. Both documented.

**7. `None` from `get_agent_info` means "no stake", not "no metadata".** The
impl's `?` operator is on `AgentStake`; missing metadata yields `Some` with
empty `uri`/`name` via `unwrap_or_default()`. Two genuinely different states,
documented so callers don't conflate them.

**Nothing speculative was added.** No helper methods, no extra fields, no
convenience constructors, no RPC layer, no `#[api_version]`. Four methods and
two structs, because that is what exists to be satisfied.

**Verification status.** Zero of the runtime's compile errors are attributable
to this module. Type-checking the runtime with `SKIP_WASM_BUILD=1` in the probe
produced 108 errors; exactly one falls inside the `ScalarCommonsApi` impl body
(`lib.rs:1301`), and it is `field 'rank' of struct 'MemberRecord' is private` —
pre-existing SDK drift in code I did not write. The only other mention of
`scalar_api` in the whole error stream is at the `impl` line, where an unrelated
`Tally` mismatch from `lib.rs:459` surfaces its obligation. That is meaningful
evidence but **not** proof: the runtime never compiled cleanly, so the module's
correctness is established negatively, not positively.

---

## Remaining failures

Three independent blockers. All three lie outside the permitted file scope, so
all three are reported rather than fixed.

### Blocker A — `pallet-emissions`, 1 error (verbatim)

```
error[E0221]: ambiguous associated type `MaxProposalsPerEra` in bounds of `T`
   --> pallets/emissions/src/lib.rs:232:44
    |
 92 |         #[pallet::constant] type MaxProposalsPerEra:           Get<u32>;
    |                             ------------------------------------------- ambiguous `MaxProposalsPerEra` from `pallet::Config`
...
232 |             let cached_max_props        = (T::MaxProposalsPerEra::get() as u128).max(1);
    |                                            ^^^^^^^^^^^^^^^^^^^^^ ambiguous associated type `MaxProposalsPerEra`
    |
    = note: associated type `MaxProposalsPerEra` could derive from `pallet_agents::Config`
help: use fully-qualified syntax to disambiguate
    |
232 -             let cached_max_props        = (T::MaxProposalsPerEra::get() as u128).max(1);
232 +             let cached_max_props        = (<T as pallet::Config>::MaxProposalsPerEra::get() as u128).max(1);
    |

For more information about this error, try `rustc --explain E0221`.
error: could not compile `pallet-emissions` (lib) due to 1 previous error
```

Both `pallet_emissions::Config` and its `pallet_agents::Config` supertrait
declare `MaxProposalsPerEra`. Pre-existing and unrelated to anything in this
round — it was simply masked in Round 1, because name-resolution errors (`E0433`)
abort compilation before type-checking runs.

**Note for whoever fixes this: rustc's suggested patch does not compile.** Line
232 sits in a scope where `pallet` is not in scope, so the suggestion yields
`error[E0433]: cannot find module or crate 'pallet'`. The form that works is
`<T as crate::pallet::Config>::MaxProposalsPerEra::get()`. Verified in the probe.

This one error is the sole cause of the `pallet-orchestrator` and
`scalar-commons-runtime` failures too — neither has any error of its own.

### Blocker B — `pallet-constitution`, 2 errors (verbatim)

```
error[E0599]: no method named `saturating_sub` found for associated type `<<T as Config>::Currency as Currency<...>>::Balance` in the current scope
   --> pallets/constitution/src/lib.rs:141:37
    |
141 |                 let remaining = cap.saturating_sub(current);
    |                                     ^^^^^^^^^^^^^^
    |
   ::: /home/dev/.cargo/git/checkouts/polkadot-sdk-dee0edd6eefa0594/0c0d4ce/substrate/primitives/arithmetic/src/traits.rs:231:5
    |
231 |     fn saturating_sub(self, rhs: Self) -> Self;
    |        -------------- the method is available for `<<T as pallet::Config>::Currency as Currency<<T as frame_system::Config>::AccountId>>::Balance` here
    |
    = help: items from traits can only be used if the trait is in scope
    = note: the full name for the type has been written to '/home/dev/scalar-commons-v4/target/debug/deps/pallet_constitution-7ce581ec39689f71.long-type-7358719826730610086.txt'
    = note: consider using `--verbose` to print the full type name to the console
help: trait `Saturating` which provides `saturating_sub` is implemented but not in scope; perhaps you want to import it
    |
 36 +     use frame_support::sp_runtime::traits::Saturating;
    |
help: there is a method `defensive_saturating_sub` with a similar name
    |
141 |                 let remaining = cap.defensive_saturating_sub(current);
    |                                     ++++++++++

error[E0308]: mismatched types
   --> pallets/constitution/src/lib.rs:142:33
    |
125 |     impl<T: Config> Hooks<BlockNumberFor<T>> for Pallet<T> {
    |          - expected this type parameter
...
142 |                 if remaining <= buffer {
    |                                 ^^^^^^ expected type parameter `T`, found associated type
    |
    = note: expected type parameter `T`
              found associated type `<<T as pallet::Config>::Currency as Currency<<T as frame_system::Config>::AccountId>>::Balance`
    = note: you might be missing a type parameter or trait bound

Some errors have detailed explanations: E0308, E0599.
For more information about an error, try `rustc --explain E0308`.
error: could not compile `pallet-constitution` (lib) due to 2 previous errors
```

**These are one bug, not two.** The `E0308` is a cascade: with `saturating_sub`
unresolved, `remaining` gets a bogus type and the comparison on the next line
fails. Adding the single import rustc names —
`use frame_support::sp_runtime::traits::Saturating;` — clears **both**. Verified
in the probe: `pallet-constitution` went to `EXIT=0, 0 errors` on that one line.

Worth flagging for review: rustc's alternative suggestion of
`defensive_saturating_sub` is *not* equivalent here. This code is the supply-cap
canary hook; `defensive_*` variants panic in debug. Plain `Saturating` is the
correct import.

### Blocker C — toolchain: rustc 1.97.1 cannot build `polkadot-stable2503`

Once Blockers A and B are patched, the wasm inner build reaches `sp-io` and dies:

```
error: `#[no_mangle]` cannot be used on internal language items
1774 | #[no_mangle]
1775 | pub fn panic(info: &core::panic::PanicInfo) -> ! {

error: could not compile `sp-io` (lib) due to 1 previous error
```

`sp-io` declares `#[panic_handler] #[no_mangle] pub fn panic(...)`
(`substrate/primitives/io/src/lib.rs:1772-1775`). Modern rustc rejects
`#[no_mangle]` on internal lang items outright. `polkadot-stable2503` predates
that change; **rustc 1.97.1 is simply too new for this SDK tag.**

I confirmed the fix rather than guessing: installed rustc **1.85.0** and rebuilt.
The `sp-io` error disappears completely and the inner wasm build proceeds
through several hundred SDK crates to the runtime itself.

The root cause is systemic and should be fixed properly:
`.github/workflows/ci-full.yml:16` and `ci-fast.yml:12` both use
`dtolnay/rust-toolchain@stable` — a **floating** toolchain against an SDK pinned
to a fixed March-2025 tag. The repo has no `rust-toolchain.toml` (noted in
BASELINE.md). This build was always going to break on its own as stable moved
forward, with no commit to blame. Round 3 should add a pinned
`rust-toolchain.toml` and change CI to honour it. That file is outside this
round's permitted scope, so I did not create it.

### Blocker D — the runtime itself: ~139 API-drift errors

This is the largest finding of the round and was not visible before now.

With Blockers A–C all cleared in the probe, `scalar-commons-runtime` compiles for
`wasm32v1-none` and fails with **139 errors** (`cargo` reports 142 including
non-coded ones):

| Code | Count | Nature |
|---|--:|---|
| `E0271` | 89 | type mismatch — dominated by `Tally` (see below) |
| `E0308` | 18 | mismatched types |
| `E0599` | 9 | missing methods |
| `E0046` | 7 | unimplemented trait items (e.g. `BlockNumberProvider`) |
| `E0437` | 6 | `type X is not a member of trait` — `pallet_safe_mode`, `pallet_tx_pause` |
| `E0412` | 3 | missing types |
| `E0616` | 2 | private field access |
| `E0061` | 2 | wrong argument count |
| `E0277`, `E0117`, `E0053` | 1 each | trait bound / coherence / signature |

Native type-check (`SKIP_WASM_BUILD=1`, rustc 1.97.1) shows the same class of
failure with 108 errors, located as: **180 hits in `runtime/src/lib.rs`, 26 in
`runtime/src/governance/tracks.rs`**, 1 in `governance/origins.rs`.

Representative examples:

- **`Tally` mismatch (49 hits from `lib.rs:459` alone).**
  `type Tally = pallet_conviction_voting::TallyOf<Runtime>` is supplied where
  `pallet_referenda::Config` expects
  `pallet_ranked_collective::Tally<Runtime, (), Pallet<Runtime>>`. This single
  wrong associated type is the largest error source in the runtime.
- **`pallet_safe_mode::Config` / `pallet_tx_pause::Config`** — `EnterOrigin`,
  `ExitOrigin`, `EnteredDeposit`, `ExtendDeposit`, `MaxDuration`, `FullNameOf`
  are configured but no longer exist on those traits at this tag.
- **`MemberRecord.rank` is private** (`lib.rs:1301`).
- **`ConstU128` not in scope**; **`IdentityLookup` is not in `frame_support::traits`**.
- **`TracksInfo`** — `track_for` has an incompatible signature and the tracks
  constant is no longer accepted as an iterator (`governance/tracks.rs`).

A couple of these are genuinely import-level and would be inside my scope
(`ConstU128`, the `IdentityLookup` path). I deliberately did not cherry-pick
them: they are a rounding error against 139, fixing them would not move any
package from FAIL to PASS, and touching them would blur the line between
"restore what was missing" and "port the runtime to stable2503" — which is the
actual remaining work and is squarely a logic change.

**Assessment: `runtime/src/lib.rs` was written against a different, older
Polkadot SDK than the tag the workspace pins.** That is a porting job, not a
wiring job, and it is materially larger than everything in Round 2 combined.

### Step 6 — WASM proof: NOT ACHIEVED

Reported honestly:

- **Build script runs?** Yes. `target/*/wbuild/scalar-commons-runtime/` is
  created and the inner `wasm32v1-none` build executes.
- **`$OUT_DIR/wasm_binary.rs` generated?** Only the `SKIP_WASM_BUILD=1` stub, in
  which `WASM_BINARY` is `None`:
  ```
  pub const WASM_BINARY_PATH: Option<&str> = None;pub const WASM_BINARY: Option<&[u8]> = None;pub const WASM_BINARY_BLOATY: Option<&[u8]> = None;
  ```
  That artifact proves the script is wired, and nothing more. It is not a WASM proof.
- **`WASM_BINARY` is `Some(...)`?** No.
- **`.wasm` artifact path + size?** **None exists.** `find` across every target
  directory returns nothing.

---

## Verification method note

Blockers C and D could not be discovered from the repository as committed —
Blocker A stops compilation first. To see past it I copied the workspace into
the session scratchpad, applied the three minimal fixes rustc itself suggested
(one disambiguation, one import, plus the `default-features` fix I then landed
properly), and built there.

**The probe was diagnostic only.** It lives in the scratchpad, is not part of the
branch, and none of its pallet-source edits were copied back. Every "before/
after" number in the **Compile results** table above is measured on the real
repository with only the seven committed changes applied. Probe-derived findings
are labelled as such throughout.

The one thing the probe changed in the real repo is commit `cf4be69` — and that
is a manifest fix inside my permitted scope, landed on its own merits.

---

## What I did NOT do

Fixes I could have made, was in some cases one line away from, and deliberately
did not:

**Pallet source — forbidden, and the instruction was explicit:**

1. Did **not** apply the `E0221` disambiguation at `pallets/emissions/src/lib.rs:232`,
   despite having verified in the probe that
   `<T as crate::pallet::Config>::MaxProposalsPerEra::get()` fixes it and takes
   `pallet-emissions`, `pallet-orchestrator`, **and** unblocks the runtime.
   This is the single highest-leverage line in the repo and I left it alone.
2. Did **not** add `use frame_support::sp_runtime::traits::Saturating;` to
   `pallets/constitution/src/lib.rs`, despite having verified that this one
   import clears both of its errors.
3. Did **not** switch `saturating_sub` to `defensive_saturating_sub` as rustc's
   second suggestion offers — wrong semantics for a supply-cap canary, and a
   source edit regardless.
4. Did **not** create the missing `pallets/auto-params/src/tests.rs`, nor remove
   its `#[cfg(test)] mod tests;` declaration (BASELINE.md finding, still open).
5. Did **not** fill in the six 1-line `benchmarks.rs` stubs.

**Runtime logic — outside "missing mod declarations / imports":**

6. Did **not** change `type Tally` at `runtime/src/lib.rs:459`, the single
   largest error source (49 of 108 native errors).
7. Did **not** touch the `pallet_safe_mode` / `pallet_tx_pause` Config blocks
   whose members no longer exist at this tag.
8. Did **not** add the missing `ConstU128` import or correct the
   `frame_support::traits::IdentityLookup` path — genuinely import-level and
   arguably in scope, but cosmetic against 139 errors and a slippery slope into
   porting the runtime.
9. Did **not** rewrite `runtime/src/governance/tracks.rs` for the changed
   `TracksInfo` API.
10. Did **not** work around `MemberRecord.rank` being private.

**Weakening — never on the table:**

11. Did **not** add `#[allow(...)]`, `todo!()`, `unimplemented!()`, or any stub.
12. Did **not** comment out, `#[cfg]`-gate, delete, or rename any failing module,
    test, item, or workspace member.
13. Did **not** drop `node` or `tests` from `[workspace] members` to make the
    other checks look clean.
14. Did **not** leave `SKIP_WASM_BUILD=1` set anywhere in the repo, or commit a
    build script that skips wasm — that would have produced a green
    `cargo build` with `WASM_BINARY = None`, which is precisely the Round 1
    failure mode in a new costume.
15. Did **not** report the probe's results as the repository's state.

**Scope:**

16. Did **not** touch `node/**` at all — `node/src/main.rs` is still
    `fn main() {}` and `node/Cargo.toml` is still a single dependency, per
    "the node/ layer stays untouched this round".
17. Did **not** touch `tests/**`, `indexer/`, `sdk/`, or `scripts/`.
18. Did **not** create `rust-toolchain.toml`, despite Blocker C proving the repo
    needs one and having identified rustc 1.85.0 as a working version. Not in
    the permitted file list.
19. Did **not** change `.github/workflows/*` to pin the toolchain, though
    `dtolnay/rust-toolchain@stable` is the root cause of Blocker C.
20. Did **not** add `pallet-constitution` to the root `[workspace.dependencies]`
    to match its six siblings — root `Cargo.toml` is not in scope. Used a
    `default-features = false` path dependency instead.
21. Did **not** modify `.gitignore`; `Cargo.lock` is tracked.
22. Did **not** open a PR, merge, force-push, or touch `master`.

Machine-level changes (not repo state): installed the `1.85.0` rustup toolchain
with `rust-src` and the `wasm32v1-none` target, to test Blocker C. Round 1's
`wasm32v1-none` + `rust-src` on `stable` remain.

---

## Recommended order for Round 3

1. `pallets/emissions/src/lib.rs:232` — one-line disambiguation *(unblocks 3 packages)*.
2. `pallets/constitution/src/lib.rs` — one `Saturating` import *(clears 2 errors)*.
3. Add `rust-toolchain.toml` pinning ~1.85.0; change CI off `@stable`.
4. Port `runtime/src/lib.rs` + `governance/tracks.rs` to `polkadot-stable2503`
   — start with `type Tally` at `lib.rs:459`, which alone accounts for roughly
   half the errors.
5. Only then restore the `node/` layer (`main.rs`, `service.rs`, `cli.rs`,
   `command.rs`, `rpc.rs`, and a real `node/Cargo.toml`).

Steps 1–3 are roughly ten minutes of work. Step 4 is the real project.
