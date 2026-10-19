# ROUND 8 — The six failing tests, diagnosed before touched

Date: 2026-08-02
Branch: `rebuild/runtime` (PR #66). Predecessors: `BASELINE.md`, `ROUND2.md` …
`ROUND7.md`.

**5 of 6 fixed. 1 left standing as a maintainer decision**, because I could not
quote a spec source proving which side was wrong — which the round's rule says
is the moment to stop, not the moment to guess.

Three commits, one per diagnosis. **Exactly one of the six was a code bug**, and
it was the one that mattered economically.

---

## Diagnosis table

| # | Test | Verdict | Evidence (quoted) | Fix | Commit |
|---|---|---|---|---|---|
| 1 | `integer_sqrt_correct` | **CODE BUG** | Its own doc comment: *"Correct for all u128 values."* It was not. CLAUDE.md: *"Balance arithmetic uses `saturating_*` / `checked_*` only. **No bare `+ - *`**."* — the seed was `(x + 1) / 2`. | Delegate to `u128::isqrt`. Signature and floor-sqrt semantics identical. | `ff1fcf2` |
| 2 | `accumulator_increases_on_era_settlement` | **TEST BUG** | `docs/VERIFIED-CONSTANTS.md` §3.1: *"**Weight = 0 → zero emissions, regardless of stake size or heartbeat.**"* CLAUDE.md #2: *"Emissions reward verifiable work, not raw stake."* | Fixture records real era escrow work. Assertion untouched. | `a24794d` |
| 3 | `agent_can_claim_after_settlement` | **TEST BUG** | Same source; same root cause. `NothingToClaim` was the correct answer for an agent that did nothing. | Same. Assertion untouched. | `a24794d` |
| 4 | `higher_stake_earns_proportionally_more` | **TEST BUG** | Same source; same root cause. Both weights were 0, so it compared `0 > 0`. | Both agents get **identical** work, isolating stake as the variable it claims to measure. Assertion untouched. | `a24794d` |
| 5 | `expire_request_refunds_creator` | **TEST BUG** | The mock's own constant, `pallets/oracle/src/tests.rs:130`: `pub const MinChallengeWindow: u64 = 5;` — the test passed `3`. 8 of the 9 `create_oracle_request` call sites in the file pass `5`; this was the sole outlier. | `challenge_window: 3 → 5`. `expire_request()` never reads it. | `91da0ee` |
| 6 | `sub_agent_cannot_link_to_two_orchestrators` | **AMBIGUOUS — standing** | No source at any tier documents *which stage* enforces link exclusivity. See below. | **None. Left failing.** | — |

---

## Failure 1 — `integer_sqrt`, the anti-whale curve

### What was wrong

```rust
/// Integer square root (Newton's method). Correct for all u128 values.
pub fn integer_sqrt(n: u128) -> u128 {
    if n == 0 { return 0; }
    let mut x = n;
    let mut y = (x + 1) / 2;          // overflows iff n == u128::MAX
    while y < x { x = y; y = (x + n / x) / 2; }
    x
}
```

`n == u128::MAX` makes `x + 1` wrap. In debug that is the panic ROUND6 recorded.
**In the release WASM — the build that actually computes emission weight — it
wraps silently to 0** and the iteration returns a wrong root. A wrong answer in
the anti-whale curve is a worse failure mode than a loud one, which is why this
was the one to fix first.

### The choice: `u128::isqrt` over a patched Newton seed

Both were viable. I took `isqrt` for three reasons:

1. **It is available.** `u128::isqrt` stabilised in rustc **1.84**; we are pinned
   at 1.85.0 (`rust-toolchain.toml`), verified by running it on this toolchain.
   It is `core`, so it is `no_std`-clean and available in the WASM runtime.
2. **It contains no user-level arithmetic at all.** A patched Newton seed would
   still need `checked_add`/`saturating_add` in a loop I would have to argue was
   overflow-free. With `isqrt` the CLAUDE.md "no bare `+ - *`" rule cannot be
   violated here *by construction*, rather than by my analysis being right.
3. **Correctness is not mine to assert.** It is the standard library's, tested
   by the whole Rust ecosystem, and it is branch-free bit-shift math — no floats,
   so it is deterministic across native and WASM.

The signature is byte-identical: `pub fn integer_sqrt(n: u128) -> u128`.

### The curve is unchanged — measured, not assumed

Only `n == u128::MAX` overflowed the old seed. For every other input the two
implementations must agree, and I checked rather than argued it. A differential
harness ran the **old** Newton code against `isqrt` with `-C debug-assertions=on`:

* `0 .. 200_000` exhaustively
* every `2^k`, `2^k ± 1`, and every perfect square `(2^k)² ± 1`, for `k` in `0..128`
* a 2,000,000-value xorshift sweep across the full `u128` range
* the floor-sqrt defining property `s² ≤ n < (s+1)²` at every point

```
ALL DIFFERENTIAL CHECKS PASSED
```

### Boundary values, shown

| `n` | old Newton | `integer_sqrt(n)` now |
|---|---|---|
| `0` | 0 | **0** |
| `1` | 1 | **1** |
| `4` | 2 | **2** |
| `10^12` (= 1 CMN in plancks) | 1 000 000 | **1 000 000** |
| `(2^64−1)²` — largest exact square in u128 | 18 446 744 073 709 551 615 | **18 446 744 073 709 551 615** |
| `u128::MAX − 1` | *overflow* | **18 446 744 073 709 551 615** |
| `u128::MAX` | **panic (debug) / silently wrong (release)** | **18 446 744 073 709 551 615** |

The only row that changes is the last two — from broken to correct.

### Regression test added

`integer_sqrt_no_overflow_at_domain_boundary` pins the largest exact square and
its neighbours, `u128::MAX − 1`, `u128::MAX`, and asserts `s² ≤ n < (s+1)²`
across the domain using `checked_mul` so the *test* cannot overflow either.

---

## Failures 2–4 — emissions: one root cause, and it was the tests

The three emissions failures **did** share a single root cause, as the round
suspected. It was not in era settlement. It was in the fixtures.

Every one of them registered an agent with stake, settled an era, and expected
emissions — **without ever recording any escrow work**. The pallet gives such an
agent weight zero, so the accumulator never moves, `claim()` correctly returns
`NothingToClaim`, and both weight snapshots are `0` (hence `0 > 0` failing).

This is not a bug. It is the thesis:

> **CLAUDE.md, first principle #2:** "Emissions reward verifiable work, not raw stake."

> **`docs/VERIFIED-CONSTANTS.md` §3, on a pure passive staker (archetype A-2):**
> "`did_work_this_era = false` → `is_active = false` → `qualifies_for_floor = false`
> → `effective_floor = 0` … Therefore `activity = 0`, and
> `base_weight = sqrt_stake × … × 0 × … = 0`.
> **Weight = 0 → zero emissions, regardless of stake size or heartbeat.**"

> **`pallets/emissions/src/lib.rs`, above the gate itself:** "ERA-BASED activity
> gate (V4 fix: was lifetime completions >= 1) … This closes the dilution attack:
> minimal agents doing 1 lifetime completion to permanently farm the floor
> baseline weight while doing no ongoing work."

The corroborating detail: the sibling test that **already passed**,
`log2_scaled_baseline_at_unit_volume`, is the only one in the file that seeds
era volume. It shows the fixture shape the other three were missing.

**Fix:** a `do_era_work()` helper driving the *production* path
(`Agents::add_era_escrow_volume`) rather than poking storage — 5 distinct buyers
× 20,000, i.e. an ordinarily productive agent, not an edge case. **Every
assertion is unchanged, verbatim.** Only the missing premise was added.

`higher_stake_earns_proportionally_more` additionally gives ALICE and BOB
**identical** work, so stake is the only variable it varies. Previously it
compared `0 > 0`; it now actually measures the √stake curve.

---

## Failure 5 — oracle: not an off-by-one

`expire_request_refunds_creator` passed `challenge_window = 3` into a mock whose
own constant is `MinChallengeWindow = 5`, so the request was rejected at
*creation* and the expiry path under test never executed.

The round's brief guessed off-by-one/ordering. It is neither. The guard —

```rust
ensure!(challenge_window >= T::MinChallengeWindow::get(), Error::<T>::ChallengeTooShort);
```

— is the correct inclusive reading of a constant named `Min`, and the test was
low by **2**, not by 1. `expire_request()` reads only `req.response_deadline`
(left at 5, block still advances to 10) and never touches `challenge_window`, so
the value was incidental to what the test asserts.

Fixed by passing the minimum the mock declares. `MinChallengeWindow` was not
lowered, the guard was not relaxed to `>`, and the runtime's
`OracleMinChallengeWindow = HOURS` was not touched.

---

## Failure 6 — orchestrator: LEFT STANDING, and why

This is the one I am not fixing, and the reason is the round's own rule.

**The failure is not where it looks.** The panic reads `Expected Ok(_). Got
Err(AlreadyLinked)` — that is the `assert_ok!` on CAROL's *propose*, not the
`assert_noop!` at the end. The test's final assertion **already matches the
code**. What fails is a setup step.

```rust
// Propose from CAROL
assert_ok!(Orchestrator::propose_sub_agent_link(RuntimeOrigin::signed(CAROL), BOB));   // <- fails here
// BOB tries to accept CAROL — but already linked to ALICE
assert_noop!(Orchestrator::accept_orchestrator_link(..., CAROL), Error::<Test>::AlreadyLinked);
```

`AlreadyLinked` is enforced in **both** `propose_sub_agent_link` (lib.rs:267) and
`accept_orchestrator_link` (lib.rs:299). The test assumes only the second exists.
The *invariant* — one orchestrator per sub-agent — is not in dispute; both sides
agree on it. The open question is narrower: **at which stage should exclusivity
be enforced?**

**Nothing at any tier of the evidence hierarchy answers that.** I searched
CLAUDE.md, every doc comment in the pallet (`SubAgentToOrchestrator` has none),
`docs/`, and `knowledge/`. The linking rules are documented nowhere but the code.
Git history shows the guard landed in `d90ccbd` and the test in a *later*
commit, `fac820d` — so the test was written against the pallet and, per ROUND6,
never executed.

I could not weaken the code (the round forbids it, and dropping the propose-side
guard would let an orchestrator pre-position poaching proposals at already-
committed sub-agents). I could not quote a source proving the test wrong. **So I
left it failing.**

### The decision for the maintainer

Two coherent designs, and it is a product call, not a mechanical one:

* **Strict propose (what the code does today).** Rejects proposal spam aimed at
  committed sub-agents.
* **Permissive propose (what the test expects).** Lets an orchestrator queue an
  offer a sub-agent can accept once their current link ends — "pre-negotiated
  succession" — with exclusivity still enforced at accept.

**If strict is intended**, this two-line test change makes it green, and I have
verified it — all 10 orchestrator tests pass, and it *strengthens* coverage by
pinning both guards while preserving the original final assertion character for
character:

```rust
// Propose from CAROL
assert_noop!(
    Orchestrator::propose_sub_agent_link(RuntimeOrigin::signed(CAROL), BOB),
    Error::<Test>::AlreadyLinked
);
```

I ran exactly this, confirmed `10 passed; 0 failed`, then **reverted it** — the
working tree contains no trace of it. Applying it is the maintainer's call.

**Either way, the linking rules should be written down** — as a doc comment on
`SubAgentToOrchestrator` or in `docs/`. This failure exists because they never were.

---

## Gate evidence

All four run on the pinned toolchain, `rustc 1.85.0 (4d91de4e4 2025-02-17)`.

```
$ cargo test --workspace --no-fail-fast
                                          90 passed   1 failed   (was 84 / 6)

$ cargo fmt --all -- --check               FMT_EXIT=0
$ cargo clippy --workspace --all-targets -- -D warnings
                                           CLIPPY_EXIT=0
$ cargo build --release
    Finished `release` profile [optimized] target(s) in 4m 05s
                                           BUILD_EXIT=0
```

Per crate:

| Crate | Passed | Failed | Was (ROUND6) |
|---|--:|--:|---|
| `pallet-agents` | **27** | 0 | 25 / **1** |
| `pallet-emissions` | **10** | 0 | 7 / **3** |
| `pallet-escrow` | 13 | 0 | 13 / 0 |
| `pallet-oracle` | **10** | 0 | 9 / **1** |
| `pallet-orchestrator` | 9 | **1** | 9 / **1** |
| `scalar-commons-integration-tests` | 17 | 0 | 17 / 0 |
| `scalar-commons-runtime` | 4 | 0 | 4 / 0 |
| **Total** | **90** | **1** | 84 / **6** |

The suite is **91 tests, not 90** — `pallet-agents` gains the
`integer_sqrt` boundary regression test. Five of the six failures are fixed; the
single remaining failure is failure 6, standing by the round's rule and
documented above as a maintainer decision.

Three of the four gates are clean. `cargo test` is **not** green, and I am not
going to describe it as green: it is 90/91 with one deliberate, documented
standing failure.

---

## Economic-semantics implications — flagged

1. **`integer_sqrt` returned a wrong root in production at the top of the
   domain.** The release WASM wrapped instead of panicking, so the anti-whale
   weight curve gave a silently incorrect √stake for `u128::MAX`. Real stakes
   never approach that (`MaxStakePerAgent` bounds them far below), so **no
   on-chain emission is believed to have been miscomputed** — but the function is
   `pub` and also called by `pallet-orchestrator` on *volume*
   (`orchestrator/src/lib.rs:469`), which is not stake-bounded. The correctness
   guarantee is now unconditional. **The curve for every realistic input is
   bit-identical to before** (differentially verified above), so this is a
   correctness repair, not an economic change.

2. **No `spec_version` bump, and none is needed for the tests.** The only
   non-test change is `integer_sqrt`'s body. It changes no storage layout, no
   extrinsic signature, no pallet index, and no economic constant. It *does*
   change runtime behaviour at exactly one input (`u128::MAX`), from wrong to
   correct — worth the maintainer's attention when this branch is released, but
   not a storage migration.

3. **Three emissions tests were, until today, asserting the pre-V4 economics** —
   that stake alone earns. Had anyone "fixed" them by relaxing the activity gate,
   it would have reopened the dilution attack the V4 gate was written to close.
   That is the trap this round's diagnose-first rule was built to catch, and it
   is the reason all three assertions were left verbatim.

---

## What I did NOT do

**Held to scope:**

1. Did **not** touch `runtime/**` or `node/**`. No fix needed one.
2. Did **not** change any economic constant, extrinsic signature, storage layout,
   or pallet index. No fix came close to needing one, so there was nothing to
   STOP and report.
3. Did **not** bump `spec_version` (see implication 2).
4. Did **not** touch `tests/common.rs` or the integration tests — all 17 already
   passed and none of the six failures reached them.
5. Did **not** touch the 84 tests that were already passing.

**Never on the table:**

6. Did **not** weaken a single guard. Specifically left intact: the emissions
   era-activity gate, `MinQualifyingVol`, the heartbeat multiplier, oracle
   `MinChallengeWindow` and its `>=` comparison, and **both** orchestrator
   `AlreadyLinked` guards.
7. Did **not** delete or loosen any assertion. Every assertion in all six tests
   is unchanged; the only edits were to fixtures that were missing their premise,
   plus one added regression test.
8. No `#[allow]`, `todo!()`, `unimplemented!()`, `#[ignore]`, or commented-out
   code. Nothing `#[cfg]`-gated away.

**Deliberately not resolved:**

9. Did **not** guess on failure 6, and did **not** quietly apply the patch I had
   already verified green. The rule said report the ambiguity; the suite is
   therefore 89/90, not 90/90, by choice.
10. Did **not** write the missing orchestrator linking-rules documentation —
    that is a design decision to record, not a gap for me to invent.
11. Did **not** address any ROUND6/ROUND7 gap outside these six tests: the
    `frame_benchmarking::Benchmark` runtime API, the empty `benchmarks.rs` files,
    `GenesisBuilder::preset_names()`, or branch protection.
12. Did **not** open a PR, merge, force-push, or touch `master`.
