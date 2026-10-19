# ROUND 3 — Toolchain pin + runtime API port to stable2503 + WASM emission

Date: 2026-07-30
Branch: `rebuild/runtime` (continued). Predecessors: `BASELINE.md`, `ROUND2.md`.

**Outcome: success. All 7 pallets green, the runtime compiles clean, and a real
WASM blob is emitted — 1,153,255 bytes, `WASM_BINARY = Some(...)`.**

The runtime went from 114 compile errors to 0. Every one of the four drift
classes identified in ROUND2 Blocker D is resolved against the SDK source at
`polkadot-stable2503`, not from memory.

One decision needs your review before this is considered settled: **a new pallet
index (41) was added** to resolve the referenda Tally conflict. It is the section
immediately below, and it is the only irreversible thing in this round.

Test compilation still fails in three pallet test-mocks and the integration test
crate. All of those files are outside this round's permitted scope; they are
reported verbatim, unfixed.

---

## Governance decisions made in 3a

### The problem was not drift — the config could never have compiled

`runtime/src/lib.rs` wired **both** `RankedCollective::Polls` and
`ConvictionVoting::Polls` to the single `Referenda` instance. A referenda
instance carries exactly **one** `Tally` type across all of its tracks, and the
two consumers demand different ones:

| Consumer | Required tally |
|---|---|
| `pallet_conviction_voting` | `pallet_conviction_voting::TallyOf<Runtime>` |
| `pallet_ranked_collective` | `pallet_ranked_collective::TallyOf<Runtime>` |

This is type-impossible on **any** SDK version. It is not an API change that
overtook the code — it never compiled, which is consistent with BASELINE.md's
finding that this runtime has never built. It accounted for **61 of the 114**
runtime errors.

`runtime/src/governance/tracks.rs` documents the intent that makes the conflict
concrete: *"Track 0: Agents (fast) — 24h decision, **ranked-collective
electorate**"* alongside *"Track 1: Network — majority stake"*. One instance,
two electorates, three tracks. FRAME cannot express that.

### What I chose

**A second referenda instance: `RankedPolls` = `pallet_referenda::Pallet<Runtime, Instance2>`, pallet index 41.**

```
Referenda   (default instance)   Tally = conviction_voting::TallyOf   stake-weighted OpenGov
RankedPolls (Instance2)          Tally = ranked_collective::TallyOf   TC electorate
```

`RankedCollective::Polls = RankedPolls`. Both instances share the same
`TracksInfo`, submission deposit, queue depth and undeciding timeout — this is
the same governance tracks under a different electorate, not a second economic
regime. **No new economic constants were introduced.**

This is exactly the SDK's own pattern: `substrate/bin/node/runtime/src/lib.rs`
declares `Referenda = pallet_referenda::Pallet<Runtime>` and
`RankedPolls = pallet_referenda::Pallet<Runtime, Instance2>`, with the ranked
collective pointed at the latter.

### Alternatives considered

**Alternative 1 — `RankedCollective::Polls = NoOpPoll`.** I actually committed
this first (`387b3de`) and then reversed it (`604dfd2`). The reasoning is worth
recording because the reversal was forced by a fact, not a preference.

`NoOpPoll` is the SDK's sanctioned "this collective runs no polls" value, used
that way in the SDK's own salary and core-fellowship integration tests. It was
attractive because it is one line, adds no storage, and — decisively — is
*reversible*, whereas a pallet index is a permanent commitment and CLAUDE.md
forbids renumbering or reusing indices.

It does not work here. `pallet_ranked_collective` bounds:

```rust
type Polls: Polling<TallyOf<Self, I>, Votes = Votes, Moment = BlockNumberFor<Self>>;
```

and `NoOpPoll` hardcodes `type Moment = u64`, while this runtime's `BlockNumber`
is `u32`. The SDK tests that use it have `u64` block numbers. So the only
remaining no-op route was hand-writing a bespoke `Polling` impl parameterised on
our `BlockNumber` — strictly more new code than the SDK pattern, to deliver
strictly less function. At that point the argument for it collapsed.

**Alternative 2 — leave `Polls = Referenda` and change ConvictionVoting.**
Rejected: `GovVoteVerifier` is wired to `pallet_conviction_voting::VotingFor`,
which CLAUDE.md lists as a load-bearing gaming-vector guard. Conviction voting
must stay functional on the stake-weighted instance.

### What you are actually being asked to approve

1. **Pallet index 41 is now used.** Appended, never previously occupied — which
   CLAUDE.md permits (it forbids renumbering and reuse, not appending). But once
   this ships it cannot be reclaimed. If you would rather the TC not have its own
   poll set, revert `604dfd2` *now*, while nothing has launched.
2. **`spec_version` 300 → 301.** Adding a pallet is a storage-layout change,
   which CLAUDE.md requires be accompanied by a bump. No migration is written
   because there is no live chain — this runtime has never produced a blob until
   today.
3. **The TC votes on a separate poll set, not on the same referenda as stake
   holders.** This is the substantive semantic consequence. The original comment
   — *"Polls wired to pallet_referenda so TC votes accelerate governance
   tracks"* — is only partially honoured: the TC gets a vote, but on its own
   instance. The "accelerate" half is already delivered by `pallet-whitelist`
   (*"TC fast-track — enables 6h governance path"*), which is wired and
   untouched.

### A second governance gap, found and NOT closed

`TracksInfo::track_for` changed meaning at this tag — it was an
`Id -> TrackInfo` lookup, it is now an **origin → track id router**. There was
therefore no prior origin mapping in this runtime to preserve; I had to write the
first one.

Only `Root` is routable, and it routes to track 2 (`"root"`), the track
documented for runtime upgrades and sudo removal. **Tracks 0 (`"agents"`) and 1
(`"network"`) are configured but currently unreachable**, because this runtime
has no custom-origin enum. `governance/origins.rs` defines only `EnsureOrigin`
type aliases (`AgentsCollectiveOrigin`, `GeneralAdminOrigin`) — those gate *who
may call*, they are not `RuntimeOrigin` variants and cannot be matched in
`track_for`.

Reaching tracks 0 and 1 needs a `pallet_custom_origins`-style origin enum, as
Polkadot's own runtimes use. That is a new governance surface, not a port, so I
reported it instead of inventing it. **This is the most important follow-up in
this document after the index decision.**

---

## What changed

Eight commits this round, on top of Round 2's eight.

| Commit | Scope | What |
|---|---|---|
| `0ac3f73` | `rust-toolchain.toml` | Pin 1.85.0 + `rust-src` + `wasm32v1-none` |
| `1f62091` | `pallets/emissions/src/lib.rs` | Authorized one-liner: E0221 disambiguation |
| `a66b3c6` | `pallets/constitution/src/lib.rs` | Authorized one-liner: `Saturating` import |
| `387b3de` | `runtime/src/lib.rs` | Tally via `NoOpPoll` — **superseded by `604dfd2`** |
| `f65024b` | `runtime/src/lib.rs` | safe-mode + tx-pause Config port |
| `604dfd2` | `runtime/src/lib.rs` | `RankedPolls` Instance2 + index 41 + spec_version |
| `b1580d8` | `runtime/src/governance/` | `TracksInfo` + `AgentsOrRoot` port |
| `32c336a` | `runtime/src/lib.rs` | Remaining mechanical drift |

### 1. Toolchain — `0ac3f73`

`rust-toolchain.toml` pinning `channel = "1.85.0"`, `components = ["rust-src",
"rustfmt", "clippy"]`, `targets = ["wasm32v1-none"]`, `profile = "minimal"`.

Verified: `rustup show` reports *"active because: overridden by
'/home/dev/scalar-commons-v4/rust-toolchain.toml'"*, with `wasm32v1-none`
installed **for that toolchain**. `pallet-agents` re-checked clean under it
(`EXIT=0`) before committing.

The file carries the full rationale inline, including why CI's
`dtolnay/rust-toolchain@stable` was the root cause: a floating toolchain against
a fixed March-2025 SDK tag will break unattended, with no commit to blame.
**CI still uses `@stable` — `.github/workflows/*` is outside scope, so changing
it is a follow-up.** Note that a pinned `rust-toolchain.toml` is honoured by
`dtolnay/rust-toolchain@stable` only if the workflow does not override it, so
please check that when you touch CI.

### 2. The two authorized one-liners — `1f62091`, `a66b3c6`

**emissions.** `<T as crate::pallet::Config>::MaxProposalsPerEra::get()`. Note
rustc's own suggestion (`<T as pallet::Config>`) does not compile — `pallet` is
not in scope at that point. I verified the intended trait rather than assuming:
`pallets/agents/src/lib.rs:305` documents its own copy as *"Matches the emissions
pallet's MaxProposalsPerEra so gov_score cap is enforced at call time"*, so the
two are meant to hold the same value and the emissions constant is the correct
denominator. Unblocked `pallet-emissions` **and** `pallet-orchestrator`.

**constitution.** `use frame_support::sp_runtime::traits::Saturating;`. Cleared
both errors, confirming ROUND2's read that the E0308 was a cascade. Used plain
`Saturating`, **not** rustc's `defensive_saturating_sub` suggestion: this is the
supply-cap canary whose stated contract is to *"emit alert events but never
halt"*, and `defensive_*` panics in debug — that would invert the contract.

### 3. safe-mode / tx-pause — `f65024b`

`pallet_safe_mode` replaced origin-gated entry with a deposit-funded
permissionless path plus `Force*Origin`s that carry the pause duration as their
`Success` type.

| Old | New | Note |
|---|---|---|
| `EnterOrigin = EnsureRoot` | `ForceEnterOrigin = EnsureRootWithSuccess<_, 4h>` | duration now rides on the origin |
| `ExitOrigin = EnsureRoot` | `ForceExitOrigin = EnsureRoot` | |
| `MaxDuration = 4h` | the `Success` value above | |
| `EnteredDeposit = ConstU128<0>` | `EnterDepositAmount = None` | |
| `ExtendDeposit = ConstU128<0>` | `ExtendDepositAmount = None` | |
| — | `EnterDuration`, `ExtendDuration` | set to 4h; govern only the (disabled) deposit path |
| — | `Notify = ()` | no equivalent existed |
| — | `ForceDepositOrigin = EnsureRoot` | no equivalent; inert while deposits are off |
| — | `ReleaseDelay = None` | no equivalent; nothing to release |

The `None`-vs-`Some(0)` choice matters: the original was root-only entry. Under
the new API a **zero deposit would open safe-mode entry to any signed account for
free**. `None` disables the path, which is the faithful reading.

`pallet_tx_pause` dropped `FullNameOf` and added
`WhitelistedCalls: Contains<RuntimeCallNameOf<Self>>` — the set of calls that may
never be paused. Set to `()`, because the previous config protected nothing and
`()` preserves exactly that. **See the flag below.**

### 4. TracksInfo + origins — `b1580d8`

Three unrelated drifts in one trait, ported against
`polkadot/runtime/rococo/src/governance/tracks.rs`:

- `tracks()` returned `&'static [(Id, TrackInfo)]`; now returns
  `impl Iterator<Item = Cow<'static, Track<Id, Balance, Moment>>>`, with
  `Track { id, info }` replacing the tuple.
- The trait's first generic is `Balance`, not `RuntimeCall`. The previous
  `TracksInfo<crate::RuntimeCall, _>` could never have satisfied
  `pallet_referenda::Config`, which bounds `Tracks: TracksInfo<BalanceOf, _>`.
- `str_array` is a `const fn`, so `s!("agents")` → `s("agents")`.

**`Curve` moved from `Permill` to `Perbill`.** All nine thresholds carried over at
identical value: `from_percent` is unchanged, and the three absolute support
floors are rescaled ppm → ppb (×1000):

| Track | Before | After | Value |
|---|---|---|---|
| 0 agents | `from_parts(2)` ppm | `from_parts(2_000)` ppb | 2 ppm — ~36K CMN |
| 1 network | `from_parts(100)` ppm | `from_parts(100_000)` ppb | 100 ppm — ~1.8M CMN |
| 2 root | `from_parts(1_000)` ppm | `from_parts(1_000_000)` ppb | 1000 ppm — ~18M CMN |

The documented ~36K / ~1.8M / ~18M CMN floors are unchanged.

`origins.rs`: `EitherOf` requires both arms to share a `Success` type.
`EnsureRanked<_, _, 2>` succeeds with the caller's rank (`u16`), so plain
`EnsureRoot` (`Success = ()`) could not pair with it. Root now uses
`EnsureRootWithSuccess<_, MaxRank = u16::MAX>` — root outranks every agent, which
matches how the SDK composes root with ranked origins.

### 5. Mechanical drift — `32c336a`

| Item | Fix |
|---|---|
| `IdentityLookup` | lives in `sp_runtime::traits`, not `frame_support::traits` |
| `into_account_truncating` | needs `AccountIdConversion` in scope |
| `MemberRecord.rank` private | `RankedMembers::rank_of` — 2 call sites, "not a member = rank 0" preserved |
| `do_add_member` / `do_promote_member` | gained `emit_event: bool`; passing `true`, matching the SDK's own `RankedMembers::induct`, so inductions stay observable to indexers |
| `BlockNumberProvider` | `= System` on treasury, referenda ×2, conviction-voting, nomination-pools |
| `VotingHooks` | `= ()` (conviction-voting) |
| `Filter` | `= Nothing` (nomination-pools) |
| `RuntimeCall` | added to whitelist Config |
| staking `RewardRemainder` / `Slash` | now take a fungible `OnUnbalanced`; `Treasury` no longer satisfies it. Replaced with `ResolveTo<TreasuryAccount, Balances>`, which resolves to the identical account `TreasuryPalletId` derives — **the destination of slashed and leftover funds is unchanged** |
| `GovVoteVerifier` orphan rule (E0117) | was implemented directly on `ConvictionVoting`; both the type parameter and implementing type are foreign. Moved to a local `ConvictionVotingBridge`, matching the existing `*Bridge` structs. Still reads `pallet_conviction_voting::VotingFor` — the load-bearing part per CLAUDE.md |

---

## Compile results

Under the pinned 1.85.0 toolchain.

| Package | ROUND2 end | ROUND3 end | Errors |
|---|:--:|:--:|:--:|
| `pallet-agents` | PASS | **PASS** | 0 |
| `pallet-escrow` | PASS | **PASS** | 0 |
| `pallet-oracle` | PASS | **PASS** | 0 |
| `pallet-emissions` | FAIL (1) | **PASS** | 0 |
| `pallet-auto-params` | PASS | **PASS** | 0 |
| `pallet-orchestrator` | FAIL (1, inherited) | **PASS** | 0 |
| `pallet-constitution` | FAIL (2) | **PASS** | 0 |
| `scalar-commons-runtime` | FAIL (blocked, never reached) | **PASS** | 0 |
| `cargo build --release -p scalar-commons-runtime` | FAIL | **PASS** | 0 |
| `cargo test --workspace --no-run` | FAIL (resolution) | FAIL | 243 |

**8 of 8 packages green, from 4 of 8.**

Runtime error burn-down, measured after each class:

| Stage | Errors |
|---|--:|
| Start (pallets fixed, 1.85.0) | 114 |
| after Tally resolution | 53 |
| after safe-mode / tx-pause | 42 |
| after `RankedPolls` Instance2 | 42 |
| after TracksInfo + origins | 34 |
| after Permill → Perbill | 16 |
| after mechanical drift | 2 |
| after last `MemberRecord.rank` | **0** |

14 warnings remain (unused imports in pallet sources I may not touch, two
`create_runtime_str` deprecations, one `TransferStake` deprecation, one unused
patch). None are errors; none were introduced by this round except nothing —
`EnsureOrigin` in `origins.rs` was already unused before it. The CLAUDE.md lint
gate (`clippy -D warnings`) would still fail on these; see **What I did NOT do**.

---

## WASM proof

`cargo build --release -p scalar-commons-runtime` → **EXIT=0**, finished in 3m29s.

Generated `$OUT_DIR/wasm_binary.rs`
(`target/release/build/scalar-commons-runtime-3c9549cfbfa803a2/out/wasm_binary.rs`):

```rust
pub const WASM_BINARY_PATH: Option<&str> = Some("/home/dev/scalar-commons-v4/target/release/wbuild/scalar-commons-runtime/scalar_commons_runtime.compact.compressed.wasm");
pub const WASM_BINARY: Option<&[u8]> = Some(include_bytes!("/home/dev/scalar-commons-v4/target/release/wbuild/scalar-commons-runtime/scalar_commons_runtime.compact.compressed.wasm"));
pub const WASM_BINARY_BLOATY: Option<&[u8]> = Some(include_bytes!("/home/dev/scalar-commons-v4/target/release/wbuild/scalar-commons-runtime/scalar_commons_runtime.wasm"));
```

`WASM_BINARY` is `Some(...)`. Compare Round 2, where the only `wasm_binary.rs`
was the `SKIP_WASM_BUILD=1` stub with all three constants `None`.

Artifacts, all under `target/release/wbuild/scalar-commons-runtime/`:

| Bytes | Artifact |
|--:|---|
| **1,153,255** | `scalar_commons_runtime.compact.compressed.wasm` ← the genesis blob |
| 4,706,887 | `scalar_commons_runtime.compact.wasm` |
| 4,986,065 | `scalar_commons_runtime.wasm` (bloaty) |
| 4,986,065 | `target/wasm32v1-none/release/scalar_commons_runtime.wasm` |

Authenticity checks, not just existence:

- **Magic bytes**: `00 61 73 6d 01 00 00 00` — `\0asm`, WASM version 1.
- **Built for `wasm32v1-none`**, confirming the target selection reasoned out in
  BASELINE.md is what wasm-builder actually used.
- **Runtime API entrypoints exported**: `Core_version`, `Core_execute_block`,
  `Core_initialize_block`, `Metadata_metadata`, `Metadata_metadata_at_version`,
  `Metadata_metadata_versions`, `GenesisBuilder_build_state`,
  `GenesisBuilder_get_preset`, `GenesisBuilder_preset_names`.
- **All four custom API methods exported**: `ScalarCommonsApi_get_agent_info`,
  `ScalarCommonsApi_get_era_metrics`, `ScalarCommonsApi_get_oracle_score`,
  `ScalarCommonsApi_get_pending_emissions`.

That last line also closes an open item from ROUND2: the `scalar_api.rs` authored
there was only verified *negatively* (no error named it). It is now verified
positively — all four methods are present in the compiled blob's export table.

---

## Remaining failures

`cargo test --workspace --no-run` fails: **243 errors across 4 crates**. Every
failing file is outside this round's permitted scope. Nothing below was fixed.

| Crate | Errors | File |
|---|--:|---|
| `pallet-oracle` (lib test) | 91 | `pallets/oracle/src/tests.rs` |
| `pallet-orchestrator` (lib test) | 84 | `pallets/orchestrator/src/tests.rs` |
| `pallet-emissions` (lib test) | 63 | `pallets/emissions/src/tests.rs` |
| `scalar-commons-integration-tests` | 1 | `tests/common.rs` |

### Cause 1 — no pallet manifest declares `[dev-dependencies]`

Verified across all seven: **none** has a `[dev-dependencies]` section. The test
mocks therefore reference crates that were never declared. This is the same class
of defect as ROUND2's missing runtime dependencies, from the same commit
(`3e6b1d3`). Undeclared crates: `sp_core`, `sp_io`, `pallet_balances`,
`pallet_oracle`.

```
error[E0432]: unresolved import `sp_core`
 --> pallets/orchestrator/src/tests.rs:7:5
  |
7 | use sp_core::H256;
  |     ^^^^^^^ use of undeclared crate or module `sp_core`

error[E0433]: failed to resolve: use of undeclared crate or module `pallet_balances`
  --> pallets/orchestrator/src/tests.rs:31:27
   |
31 |     type AccountData    = pallet_balances::AccountData<u64>;
   |                           ^^^^^^^^^^^^^^^ use of undeclared crate or module `pallet_balances`
```

That accounts for the bulk (125 × E0412, 107 × E0433, 3 × E0432).

### Cause 2 — stale Config members in the mocks

```
error[E0437]: type `OrchestratorEmissionMultiplier` is not a member of trait `super::Config`
error[E0437]: type `Currency` is not a member of trait `super::Config`
error[E0201]: duplicate definitions with name `MaxResponsesPerRequest`
```

The mock runtimes have drifted from the pallet `Config` traits they implement —
independent of the SDK.

### Cause 3 — `tests/common.rs`, the one integration-test error (verbatim)

```
error[E0277]: the trait bound `ConstU32<0>: sp_core::Get<u64>` is not satisfied
   --> tests/common.rs:256:44
    |
256 |     type MinQualifyingVol                = ConstU32<0>; // disabled in integration tests
    |                                            ^^^^^^^^^^^ the trait `sp_core::Get<u64>` is not implemented for `ConstU32<0>`
    |
    = help: the following other types implement trait `sp_core::Get<T>`:
              `ConstU32<T>` implements `sp_core::Get<std::option::Option<u32>>`
              `ConstU32<T>` implements `sp_core::Get<u32>`
note: required by a bound in `pallet_emissions::Config::MinQualifyingVol`
   --> /home/dev/scalar-commons-v4/pallets/emissions/src/lib.rs:99:64
    |
99  |         #[pallet::constant] type MinQualifyingVol:             Get<BalanceOf<Self>>;
    |                                                                ^^^^^^^^^^^^^^^^^^^^ required by this bound in `Config::MinQualifyingVol`
```

This is precisely the hazard CLAUDE.md already records — *"`BlockNumber`-typed
constants use `ConstU64`, not `ConstU32`"* — here in its `Balance` form. The mock
`Balance` is `u64`, so this wants `ConstU64<0>`. One character class of fix, in a
forbidden file.

Encouragingly, this is the **only** error in the integration crate: `common.rs`
and all seven test modules otherwise compile against the ported runtime.

---

## Flags for review (beyond the index decision)

1. **`tx_pause::WhitelistedCalls = ()` vs first principle #3.** With `()`, no call
   is protected from pausing, and `PauseOrigin = EnsureRoot`. That means root can
   pause `Emissions::settle_era` — which sits badly against *"No root-gated
   liveness… `settle_era` is permissionless by design."* This is **pre-existing**,
   not introduced here: the old `FullNameOf` protected nothing either, so `()` is
   the faithful port. I did not widen it, because adding a protective whitelist is
   a design change, not a port. Recommend a follow-up adding at least
   `settle_era` and reward claims to the whitelist.
2. **Tracks 0 and 1 are unreachable** until a custom-origin enum exists (see 3a).
3. **CI still floats on `@stable`** and will not honour the new pin if the
   workflow overrides it.

---

## What I did NOT do

**Out of scope, left broken and reported:**

1. Did **not** add `[dev-dependencies]` to any pallet manifest, though that is
   plainly the fix for ~240 of the 243 test errors and is the same defect class I
   was authorized to fix in the *runtime* manifests last round. Scope this round
   was "pallets/* beyond the two named one-liners: forbidden."
2. Did **not** touch `pallets/{oracle,orchestrator,emissions}/src/tests.rs` to
   repair the stale Config members or the duplicate `MaxResponsesPerRequest`.
3. Did **not** change `tests/common.rs:256` `ConstU32<0>` → `ConstU64<0>`, a
   one-token fix that would take the integration crate to green.
4. Did **not** touch `node/**` at all. `node/src/main.rs` is still `fn main() {}`
   and `node/Cargo.toml` is still a single dependency. There is still **no node
   binary** — this round produced a runtime blob, not a running chain.

**Deliberately not widened:**

5. Did **not** add a `pallet_custom_origins` enum to make tracks 0 and 1
   reachable. New governance surface, not a port.
6. Did **not** add `settle_era` or reward claims to `tx_pause::WhitelistedCalls`,
   despite the first-principles concern — flagged instead.
7. Did **not** change any economic constant, weight, curve value, or emission
   formula. The Permill→Perbill conversion is arithmetically exact and documented
   line by line; the staking `ResolveTo` change routes to the identical treasury
   account.
8. Did **not** modify `.github/workflows/*` to honour the toolchain pin.
9. Did **not** clean up the 14 remaining warnings (unused imports, deprecated
   `create_runtime_str`, deprecated `TransferStake`). Most are in pallet sources I
   may not touch; the rest are not drift. The CLAUDE.md lint gate will still fail
   until someone does. I also did not run `cargo fmt --all`, which would have
   reformatted files far outside this round's scope.
10. Did **not** write a storage migration for the added pallet — there is no live
    chain state, and inventing one would be worse than noting its absence.

**Never on the table:**

11. No `#[allow]`, `todo!()`, `unimplemented!()`, or stub was added anywhere.
12. Nothing was commented out, `#[cfg]`-gated away, deleted, or renamed to make a
    check pass. No workspace member was dropped.
13. Did **not** leave `SKIP_WASM_BUILD` set anywhere in the repo. It was used only
    as an iteration aid while burning down the 114 errors; the final gate is a
    plain `cargo build --release`, and the committed build script always builds
    wasm.
14. Did **not** re-pin or fork the SDK. Everything was ported forward to
    `polkadot-stable2503` as instructed.
15. Did **not** renumber or reuse any existing pallet index.
16. Did **not** open a PR, merge, force-push, or touch `master`.

---

## Suggested Round 4

1. Add `[dev-dependencies]` to the seven pallet manifests; fix the three stale
   test mocks and `tests/common.rs:256`. Gets `cargo test --workspace` compiling,
   then **run** the tests — nothing in this repo has ever executed.
2. Decide the index-41 question above, while it is still cheap.
3. Restore the `node/` layer (`main.rs`, `service.rs`, `cli.rs`, `command.rs`,
   `rpc.rs`, real `node/Cargo.toml`) to get an actual binary. `chain_spec.rs`
   already exists and its `WASM_BINARY` references now resolve.
4. Point CI at the pinned toolchain; add the tx-pause whitelist.
