# CI-FIX — ci-full exhausted runner disk (run 30742971934)

Date: 2026-08-02
Branch: `rebuild/runtime` (PR #66)
Commit: `0db1e00` — *ci: free runner disk and drop dev debuginfo in ci-full*
**New run: https://github.com/matty33/scalar-commons-v4/actions/runs/30757994902**

One file changed: `.github/workflows/ci-full.yml`, **58 insertions, 0 deletions.**

---

## 1. Diagnosis — this was never a code failure

The step timings from the failed run say so on their own:

| # | Step | Result | Duration |
|---|---|---|---|
| 8 | Build release (runtime WASM + node binary) | **success** | 44m 56s |
| 9 | The binary must actually be a node | **success** | 3s |
| 10 | Check runtime-benchmarks feature graph | **success** | 32m 59s |
| 11 | **Tests compile** (`cargo test --workspace --no-run`) | **failure** | 2m 20s |

The release build — the expensive one, the anti-stub gate — passed. So did the
benchmarks feature graph. The job then fell over in the *debug* profile with:

```
##[warning]You are running out of disk space... Free space left: 52 MB
/usr/bin/ld: final link failed: No space left on device
```

`ld` ran out of room mid-link. Nothing about the workspace's correctness
changed between step 10 and step 11; only the free-space figure did.

### Why the debug profile is the expensive one

Measured on this workspace's local `target/`:

| | Size |
|---|--:|
| `target/release` | 8.6 GB |
| **`target/debug`** | **30 GB** |

A standard GitHub runner has roughly 14 GB free. `target/debug` alone is over
twice that. Broken down:

| `target/debug/…` | Size |
|---|--:|
| `deps` | 15 GB |
| `build` | 7.1 GB |
| `incremental` | 4.8 GB |
| `wbuild` | 3.1 GB |

And within `deps`, the 26 linked test executables total 2.9 GB — of which
almost everything is debuginfo:

| Binary | File | `.debug_*` sections |
|---|--:|--:|
| `pallet_oracle-c20a238e4bf18cd8` | 0.16 GB | 0.14 GB (**91%**) |
| `scalar_commons_runtime-a5c50c548acee992` | 0.17 GB | 0.15 GB (**90%**) |

`cargo test --no-run` is the only step in the job that *links* debug binaries.
That is exactly the step that died.

---

## 2. What changed

### (1) Reclaim step, first, before checkout

Ordering is load-bearing: the reclaim is worthless once the build has already
filled the disk. It deletes preinstalled toolchains that nothing in this
workspace can reach — this is a Rust + protoc build with no .NET, Android, GHC
or CodeQL anywhere in its dependency graph — and prunes the docker image cache.
`df -h /` prints either side, so every future log shows whether the reclaim
actually worked instead of leaving it to be assumed.

Two deliberate details:

* **Only `/opt/hostedtoolcache/CodeQL` is removed, not the tree.** The runner
  resolves the node used by JavaScript actions (`actions/checkout`,
  `Swatinem/rust-cache`) out of `/opt/hostedtoolcache`. Deleting all of it is a
  commonly-copied "free disk space" recipe and it would break every step below.
* **`docker image prune -af || true`.** A disk-reclaim step must never become a
  new way for the job to go red. Missing `rm -rf` paths already exit 0; the
  docker daemon is the one thing here that can legitimately be absent.

### (2) `CARGO_PROFILE_DEV_DEBUG: "0"` job-wide

Given debuginfo is ~90% of the bytes, this is the single largest lever.

The justification is that **no step in this job consumes debuginfo**. The job
compiles, links, runs `--version`, and builds a raw chain spec. It never reads
a backtrace, attaches a debugger, or symbolises a core dump. The debuginfo was
bought and never used, so dropping it costs no diagnostic power.

**Verified rather than assumed**, on the pinned toolchain CI actually uses —
same trivial crate, built both ways with `cargo 1.85.0 (d73d2caf9 2024-12-31)`:

```
default (repo's [profile.dev] sets only opt-level, so debug defaults on)
                                   3,997,592 bytes
CARGO_PROFILE_DEV_DEBUG=0            438,616 bytes     -89%
```

That −89% matches the 90–91% debuginfo share measured in the real test binaries
above, which is the cross-check I wanted before trusting it.

Worth stating explicitly: the repo's `[profile.test]` sets **only** `opt-level`,
so it inherits `debug` from `[profile.dev]` and the override reaches the test
binaries too. Had `[profile.test]` set `debug` itself, this env var would have
been a no-op on precisely the step that was failing.

### (3) Closing `df -h /`, with `if: always()`

The task asked for a final `df -h /` so every run records its headroom. I added
`if: always()`, because without it the step is skipped on failure — and a disk
figure is *only* diagnostic when a gate has just failed. Without `always()`,
this step would have told us nothing about run 30742971934, the very run that
made it necessary.

This is a reporting step: it never votes on the job's conclusion, so it does not
soften anything.

---

## 3. No gate was weakened — verified mechanically, not by eyeball

I parsed both versions of the YAML and compared the original ten steps by name,
`run` body and `if` condition:

```
OK   actions/checkout@v4
OK   Install protoc
OK   Resolve pinned toolchain
OK   dtolnay/rust-toolchain@master
OK   Assert the pinned toolchain is what we got
OK   Swatinem/rust-cache@v2
OK   Build release (runtime WASM + node binary)
OK   The binary must actually be a node
OK   Check runtime-benchmarks feature graph
OK   Tests compile

every original step present with identical `run` and identical `if`: True
original order preserved:                                            True
added steps: ['Free runner disk', 'Disk headroom after the build']
```

The diff is `58 insertions, 0 deletions` — no line of the existing job was
edited. The two new steps bracket the originals. Nothing gained
`continue-on-error`, nothing gained `|| true`, and in particular **`Tests
compile` is still `--no-run` and still blocking** — that step's `--no-run`
status is a ROUND6 decision documented in the file's own comments, and swapping
it for a full `cargo test --workspace` is a different change than this one. It
is now worth doing: the six failures it was waiting on are fixed, and the suite
is 97/0.

---

## 4. ci-fast: deliberately NOT changed, and why

The scope note asked me to apply the same step to `ci-fast.yml` only if its
artifacts plausibly exceed disk, and to state the reasoning either way. **They
do not.** Two independent lines of evidence:

**Structural.** ci-fast runs `cargo fmt`, `cargo clippy --workspace
--all-targets`, and `cargo check --workspace`. All three are metadata-emitting:
they produce `.rmeta`, and they **never invoke the linker on a test binary**.
The failure mode here was `ld` running out of room during a final link, and
ci-fast contains no final link to run out of room during. The 2.9 GB of test
executables and the debuginfo that dominates them are not in its footprint at
all. `--all-targets` makes clippy *lint* the test targets; it does not link them.

**Empirical.** The last four ci-fast runs on `rebuild/runtime` are all green,
and I grepped each one's full log for `running out of disk space` and `No space
left on device`:

| Run | Conclusion | Disk-warning lines |
|---|---|--:|
| 30751279163 | success | 0 |
| 30742971955 | success | 0 |
| 30742279005 | success | 0 |
| 30740912937 | success | 0 |

Note that 30742971955 is ci-fast from the *same push* as the ci-full run that
died. Same commit, same runner image: one job exhausted the disk and the other
did not notice it existed. That is the cleanest possible control for this
question.

**One caveat I want on the record.** ci-fast is not comfortable, just adequate.
Its footprint still includes `target/debug/build` (7.1 GB locally) and
`target/debug/wbuild` (3.1 GB) — the runtime's `build.rs` runs
`substrate-wasm-builder` even under `cargo check`. If ci-fast ever gains a step
that links binaries, or the dependency graph grows materially, it will land in
the same place. The reclaim step is a copy-paste away when that happens; I did
not pre-emptively add it because the scope was explicit and a change with no
demonstrated need is a change whose effect nobody can measure.

---

## 5. Verification performed

* **YAML parses** — `actionlint` is not installed in this container; validated
  with PyYAML 6.0.2 plus the structural comparison in §3. Job keys, triggers
  (`push`/`pull_request`/`workflow_dispatch`), `runs-on`, `timeout-minutes: 120`
  and the twelve-step list all resolve as intended.
* **`CARGO_PROFILE_DEV_DEBUG` parses as the string `'0'`**, not the integer `0`.
  I quoted it deliberately — GitHub coerces env values to strings, but the
  quoted form removes any question about what cargo receives.
* **The env var works on the pinned toolchain**, measured (§2), not assumed.
* **Pushed** `17313e7..0db1e00`, which re-triggered ci-full on PR #66.
* **The reclaim step has already passed on the new run** — step conclusion
  `success`. Its `df -h /` before/after figures land in the run log; live-run
  logs are not retrievable through the API until the run completes.

Per instructions I did **not** wait for the run to finish, so this report makes
no claim about whether ci-full is now green — only that the change addresses the
mechanism that broke it.

---

## 6. What I did NOT do

1. Did **not** touch `ci-fast.yml`. Reasoning and evidence in §4.
2. Did **not** modify, reorder, or remove any gate step; did **not** add
   `continue-on-error` or `|| true` to anything that decides the job's verdict.
3. Did **not** change `Tests compile` from `--no-run` to a full run. It is now
   justified (97/0) but it is a scope-separate change, and bundling it would
   have made a failure ambiguous between "the disk fix didn't work" and "a test
   regressed". Flagged in §3 as the obvious next commit.
4. Did **not** add `SKIP_WASM_BUILD`, tune `CARGO_INCREMENTAL`, split the job,
   change `timeout-minutes`, or touch the cache action. Each would further cut
   disk or time, but none was asked for and each changes what the job proves.
5. Did **not** delete `/opt/hostedtoolcache` wholesale, the usual form of this
   recipe — it would break the JavaScript actions in this job.
6. Did **not** touch any Rust source, `Cargo.toml`, or `runtime/`. The commit is
   one file.
7. Did **not** commit this report. A second push to `rebuild/runtime` would,
   under the workflow's `cancel-in-progress: true` concurrency policy, cancel
   the very run this document links to.
