# CI-NODE.md — real CI coverage for the JS/TS subprojects

**Round:** add `.github/workflows/ci-node.yml`.
**Branch:** `ci/node-coverage`. **Base:** `master` @ `79aac43`.
**Local runs performed:** 2026-08-19, ~21:45–21:50 CEST, Node **v22.23.1**, npm **10.9.8**.
**Nothing was fixed, skipped, excluded-to-pass, or weakened.** Two failures were found and are
reported verbatim below rather than routed around.

---

## 0. Why this round exists

`ci-fast.yml` and `ci-full.yml` contain **zero** `npm`/`node` steps. `landing/`, `faucet/`,
`docs/` and `sdk/` all ship real suites that no automated gate has ever executed. The visible
consequence is on the three open PRs: #91, #92 and #93 are entirely TypeScript and each reports
"2 checks passed" — those two checks are `gate` and `full`, the Rust workspace gates, which did
not compile or run a single line of the code those PRs add.

`indexer/` gets **no job** in this round. On master it holds one Python file (`reconcile.py`) and
no `package.json`, so an indexer job could only be a no-op that reads as coverage. It gets one
when PR #93 lands a manifest.

---

## 1. Per-project local run results

Every command below was run in the real repository checkout (not a copy), except where noted.

### Summary

| Project | `npm ci` | Check step | Test step | **Verdict** |
|---|---|---|---|---|
| **landing** | exit 0 | `npm run build` exit 0 | `npm test` **10/10 pass**, exit 0 | ✅ **PASS** |
| **faucet** | exit 0 | `npm run typecheck` exit 0 | offline 30/30 pass, exit 0 (full 55/55 with devnet) | ✅ **PASS** |
| **docs** | exit 0 | `npm run lint` exit 0 | `npm run build` exit 0 (no test script) | ✅ **PASS** |
| **sdk** | **exit 1** | `npm run typecheck` **exit 2, 47 errors** | `npm test` 9 pass / 1 skip, exit 0 | ❌ **FAIL ×2** |

---

### 1.1 landing — PASS

Scripts as defined in `landing/package.json`: `"build": "node scripts/build.mjs"`,
`"test": "node --test"`.

```
######## LANDING: npm ci ########
added 68 packages, and audited 69 packages in 2s
found 0 vulnerabilities
CI EXIT: 0

######## LANDING: npm run build ########
> @scalar-commons/landing@0.1.0 build
> node scripts/build.mjs
built /home/dev/scalar-commons-v4/landing/dist/index.html (14.8 kB) from scalar-commons spec 304, metadata v15, block #8063
BUILD EXIT: 0

######## LANDING: npm test ########
1..10
# tests 10
# suites 0
# pass 10
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 110.825222
TEST EXIT: 0
```

**Finding worth recording (not a failure):** landing's suite is **not self-contained**. It reads
files from outside `landing/`:

- `landing/test/claims.test.mjs:112` reads `runtime/src/lib.rs` and asserts
  `type OracleScoreProvider = ();` is still there — i.e. the oracle caveat must stay on the page
  for as long as the term is unwired.
- `landing/src/source-claims.mjs` cites `pallets/emissions/src/lib.rs`,
  `pallets/orchestrator/src/lib.rs` and `runtime/src/lib.rs`, and
  `claims.test.mjs:103` asserts each cited snippet is still literally present in that source.

So **a Rust change can turn the landing gate red.** The path filter includes those three files for
exactly this reason; without it a runtime edit would break landing on master with no PR having
run the check. I found this the hard way — my first run was in a scratchpad copy and 2 of 10
tests failed with `ENOENT: ... /gates/runtime/src/lib.rs`, which was an artifact of the copy, not
a real failure. Re-run in place: 10/10.

---

### 1.2 faucet — PASS

Scripts as defined in `faucet/package.json`: `"typecheck": "tsc -p tsconfig.json --noEmit"`,
`"test": "vitest run"`.

```
######## FAUCET: npm ci ########
CI EXIT: 0

######## FAUCET: npm run typecheck ########
> @scalar-commons/faucet@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit
TYPECHECK EXIT: 0

######## FAUCET: OFFLINE SUBSET (what CI will run) ########
> @scalar-commons/faucet@0.1.0 test
> vitest run tests/amount.test.ts tests/rateLimiter.test.ts

 RUN  v1.6.1 /home/dev/scalar-commons-v4/faucet

 ✓ tests/rateLimiter.test.ts  (19 tests) 8ms
 ✓ tests/amount.test.ts  (11 tests) 5ms

 Test Files  2 passed (2)
      Tests  30 passed (30)
OFFLINE TEST EXIT: 0
```

I also ran the **full** suite against the running 5-validator devnet, so the report can say
whether the excluded tests are healthy rather than merely absent:

```
######## FAUCET: FULL npm test (live devnet present) ########
> @scalar-commons/faucet@0.1.0 test
> vitest run

 RUN  v1.6.1 /home/dev/scalar-commons-v4/faucet

 ✓ tests/faucet.live.test.ts  (25 tests) 96691ms
 ✓ tests/rateLimiter.test.ts  (19 tests) 5ms
 ✓ tests/amount.test.ts  (11 tests) 5ms

 Test Files  3 passed (3)
      Tests  55 passed (55)
   Duration  98.18s
FULL TEST EXIT: 0
```

**55/55 pass.** The live tests are excluded from CI for **environment, not health**. Note this run
moved real devnet CMN: `faucet.live.test.ts` drips from the genesis-endowed, non-validator
`//Ferdie` account by design, which is what the suite exists to verify.

---

### 1.3 docs — PASS

`docs/package.json` defines **no `test` script**. Its real check is `lint`
(`markdownlint-cli2 "index.md" "guide/**/*.md" "reference/**/*.md" && node scripts/check-chain-values.mjs`)
plus `build` (`vitepress build .`).

```
######## DOCS: npm ci ########
CI EXIT: 0

######## DOCS: npm run lint ########
> @scalar-commons/docs@0.1.0 lint
> markdownlint-cli2 "index.md" "guide/**/*.md" "reference/**/*.md" && node scripts/check-chain-values.mjs

markdownlint-cli2 v0.18.1 (markdownlint v0.38.0)
Finding: index.md guide/**/*.md reference/**/*.md !node_modules/** !.vitepress/**
Linting: 5 file(s)
Summary: 0 error(s)
✓ docs match the runtime snapshot (Scalar Commons Local Testnet — scalar-commons spec 304 @ #8042)
  31 constant reference(s) covering 30/141 chain constants (all 22 required ones present),
  36 pallet indices, 5 cross-pallet invariants, 8 prose facts, 36 extrinsics, 4 runtime API methods checked across 5 pages
LINT EXIT: 0

######## DOCS: npm run build (vitepress) ########
> @scalar-commons/docs@0.1.0 build
> vitepress build .

  vitepress v1.6.4

- building client + server bundles...
✓ building client + server bundles...
- rendering pages...
✓ rendering pages...
build complete in 2.55s.
BUILD EXIT: 0
```

---

### 1.4 sdk — **FAIL (two independent defects)**

#### Defect 1 — `npm ci` cannot run: there is no lockfile on master

```
######## SDK: ls lockfile ########
ls: cannot access 'package-lock.json': No such file or directory

######## SDK: npm ci (VERBATIM) ########
npm error code EUSAGE
npm error
npm error The `npm ci` command can only install with an existing package-lock.json or
npm error npm-shrinkwrap.json with lockfileVersion >= 1. Run an install with npm@5 or
npm error later to generate a package-lock.json file, then try again.
npm error
npm error Clean install a project
npm error
npm error Usage:
npm error npm ci
[…usage text…]
npm error A complete log of this run can be found in: /home/dev/.npm/_logs/2026-08-19T19_48_01_153Z-debug-0.log
CI EXIT: 1
```

`git ls-files sdk/` confirms no `sdk/package-lock.json` is tracked. landing, faucet and docs all
have one (lockfileVersion 3). **The gate the factory has been running for sdk —
`cd sdk && npm ci && npm run typecheck && npm test` — could never have installed on master.**

#### Defect 2 — `npm run typecheck` fails with 47 errors

To find out whether anything downstream of the install also breaks, I installed with `npm install`
**in a scratchpad copy only** — deliberately not in the repo, because generating a lockfile is the
fix and this round does not fix. Result:

```
> @scalar-commons/sdk@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit

src/index.ts(122,24): error TS2532: Object is possibly 'undefined'.
src/index.ts(122,24): error TS2722: Cannot invoke an object which is possibly 'undefined'.
src/index.ts(127,24): error TS2532: Object is possibly 'undefined'.
src/index.ts(127,24): error TS2722: Cannot invoke an object which is possibly 'undefined'.
src/index.ts(132,24): error TS2532: Object is possibly 'undefined'.
src/index.ts(132,24): error TS2722: Cannot invoke an object which is possibly 'undefined'.
src/index.ts(148,7): error TS2532: Object is possibly 'undefined'.
src/index.ts(148,7): error TS2722: Cannot invoke an object which is possibly 'undefined'.
src/index.ts(162,7): error TS2532: Object is possibly 'undefined'.
src/index.ts(162,7): error TS2722: Cannot invoke an object which is possibly 'undefined'.
src/index.ts(171,7): error TS2532: Object is possibly 'undefined'.
src/index.ts(171,7): error TS2722: Cannot invoke an object which is possibly 'undefined'.
src/index.ts(185,7): error TS2532: Object is possibly 'undefined'.
src/index.ts(185,7): error TS2722: Cannot invoke an object which is possibly 'undefined'.
src/index.ts(198,7): error TS2532: Object is possibly 'undefined'.
src/index.ts(198,7): error TS2722: Cannot invoke an object which is possibly 'undefined'.
src/index.ts(206,24): error TS2532: Object is possibly 'undefined'.
src/index.ts(206,24): error TS2722: Cannot invoke an object which is possibly 'undefined'.
src/index.ts(211,24): error TS2532: Object is possibly 'undefined'.
src/index.ts(211,24): error TS2722: Cannot invoke an object which is possibly 'undefined'.
src/index.ts(219,7): error TS2532: Object is possibly 'undefined'.
src/index.ts(219,7): error TS2722: Cannot invoke an object which is possibly 'undefined'.
src/index.ts(220,7): error TS2532: Object is possibly 'undefined'.
src/index.ts(220,7): error TS2722: Cannot invoke an object which is possibly 'undefined'.
src/index.ts(221,7): error TS2532: Object is possibly 'undefined'.
src/index.ts(221,7): error TS2722: Cannot invoke an object which is possibly 'undefined'.
src/index.ts(222,7): error TS2532: Object is possibly 'undefined'.
src/index.ts(222,7): error TS2722: Cannot invoke an object which is possibly 'undefined'.
src/index.ts(223,7): error TS2532: Object is possibly 'undefined'.
src/index.ts(223,7): error TS2722: Cannot invoke an object which is possibly 'undefined'.
src/index.ts(226,32): error TS2532: Object is possibly 'undefined'.
src/index.ts(226,32): error TS2532: Object is possibly 'undefined'.
src/index.ts(248,26): error TS2532: Object is possibly 'undefined'.
src/index.ts(248,26): error TS2532: Object is possibly 'undefined'.
src/index.ts(248,26): error TS2722: Cannot invoke an object which is possibly 'undefined'.
src/index.ts(256,9): error TS2532: Object is possibly 'undefined'.
src/index.ts(256,9): error TS2722: Cannot invoke an object which is possibly 'undefined'.
src/index.ts(257,9): error TS2532: Object is possibly 'undefined'.
src/index.ts(257,9): error TS2722: Cannot invoke an object which is possibly 'undefined'.
src/index.ts(258,9): error TS2532: Object is possibly 'undefined'.
src/index.ts(258,9): error TS2722: Cannot invoke an object which is possibly 'undefined'.
src/index.ts(259,9): error TS2532: Object is possibly 'undefined'.
src/index.ts(259,9): error TS2722: Cannot invoke an object which is possibly 'undefined'.
src/index.ts(260,9): error TS2532: Object is possibly 'undefined'.
src/index.ts(260,9): error TS2722: Cannot invoke an object which is possibly 'undefined'.
src/index.ts(261,9): error TS2532: Object is possibly 'undefined'.
src/index.ts(261,9): error TS2722: Cannot invoke an object which is possibly 'undefined'.
TYPECHECK EXIT: 2
```

**47 errors — 25× TS2532, 22× TS2722, all in `src/index.ts`.** Cause: `sdk/tsconfig.json` sets
`"strict": true` and `"noUncheckedIndexedAccess": true`, while the client reaches into
polkadot-js index signatures unguarded (`api.tx.agents.register(...)`, `api.query.emissions...`).

#### sdk tests themselves pass

```
> @scalar-commons/sdk@0.1.0 test
> vitest run

 ✓ tests/retry.test.ts  (4 tests) 10ms
 ✓ tests/integration.test.ts  (6 tests | 1 skipped) 6ms

 Test Files  2 passed (2)
      Tests  9 passed | 1 skipped (10)
TEST EXIT: 0
```

The 1 skipped is `describe.skipIf(!runReal)` at `tests/integration.test.ts:237` — the SDK's own
live block, already gated on `RUN_INTEGRATION=1`.

#### Both sdk defects are already fixed by PR #91 — verified

I checked out `origin/task/72`'s `sdk/` into a scratchpad and ran its gate:

```
=== PR91 sdk has lockfile? ===
-rw-rw-r-- 1 dev dev 94067 Aug 18 23:08 package-lock.json

=== PR91: npm ci ===
CI EXIT: 0

=== PR91: npm run typecheck ===
> @scalar-commons/sdk@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit
TYPECHECK EXIT: 0
```

**This materially changes the advice on issue #94.** PR #91's `txEntry`/`queryEntry`/`constEntry`
refactor — the change its conformance reviewer flagged as unrequested scope creep across twelve
methods — is **load-bearing**: it is what clears all 47 typecheck errors. Reverting it to narrow
the PR's scope would leave `npm run typecheck` red. The scope-creep finding in #94 should be
resolved by *keeping* the refactor, not by undoing it.

That same PR adding `sdk/package-lock.json` is also the answer to #94's finding #2, which claimed
`@polkadot/keyring` and `@polkadot/util-crypto` were undeclared dependencies. They are declared
(verified in AUDIT.md §7); the real fact is that master has no lockfile at all, which this round
independently confirms by running the command.

---

## 2. What each CI job runs

Node **22** on `ubuntu-latest` for all four (satisfies every `engines` field: landing `>=20`,
faucet `>=18`, docs `>=20.19`, sdk `>=18`), matching the local Node v22.23.1 used above.

| Job | Working dir | Commands, in order |
|---|---|---|
| `landing` | `landing/` | `npm ci` → `npm run build` → `npm test` |
| `faucet` | `faucet/` | `npm ci` → `npm run typecheck` → `npm test -- tests/amount.test.ts tests/rateLimiter.test.ts` |
| `docs` | `docs/` | `npm ci` → `npm run lint` → `npm run build` |
| `sdk` | `sdk/` | `npm ci` → `npm run typecheck` → `npm test` |

Every command is a script the project's own `package.json` defines. No command was invented; the
only argument added anywhere is the faucet file list, explained in §3.

npm caching (`actions/setup-node` `cache: npm`) is enabled for landing, faucet and docs.
**It is deliberately omitted for sdk**: setup-node's npm cache requires a lockfile and would fail
during *setup*, burying the actual `EUSAGE` error from `npm ci` behind a less informative one. The
cache line goes back once the lockfile lands.

### Path filtering, and why it is not `on.paths`

The obvious implementation — a workflow-level `paths:` filter — is a trap once these checks are
**required** by branch protection: if `paths:` excludes a PR the workflow never runs, the required
context never reports, and the PR sits on *"Expected — waiting for status"* with no way to clear
it. So the four jobs **always run and always report**; a `changes` job computes what was touched
and each job's real work is gated on that. A PR touching only Rust gets four green checks in a few
seconds each, having correctly done nothing.

`changes` uses plain `git diff` rather than a third-party paths-filter action — auditable in place,
and no new supply-chain surface on a workflow that gates the trunk. Filters:

| Job | Selected when these change |
|---|---|
| `landing` | `landing/**`, **plus** `runtime/src/lib.rs`, `pallets/emissions/src/lib.rs`, `pallets/orchestrator/src/lib.rs` (see §1.1 — landing's tests assert against those files) |
| `faucet` | `faucet/**` |
| `docs` | `docs/**` |
| `sdk` | `sdk/**` |
| *all four* | `.github/workflows/ci-node.yml` (the gate is the thing under test), or any `push`/`workflow_dispatch` |

Verified locally against seven simulated change sets, including: sdk-only → `sdk=true` alone;
`runtime/src/lib.rs` → `landing=true`; `pallets/agents/src/lib.rs` → nothing selected;
PR #92's explorer files → nothing selected; workflow edit → all four.

---

## 3. Excluded tests — what, and exactly why

**No test was deleted, skipped, commented out, or modified.** One suite is not *selected* by the
CI invocation, and two non-test scripts are not run.

### 3.1 `faucet/tests/faucet.live.test.ts` — 25 tests, EXCLUDED from CI

- **Why:** it dispenses real CMN from a genesis-endowed account and asserts the on-chain balance
  moved. It needs a live devnet at `ws://127.0.0.1:9944`. Its own header (lines 15–21) states it
  is deliberately **not** skippable — *"If the node is unreachable the suite FAILS rather than
  skipping — an unreachable node is a blocking finding, per issue #75."* That is the right
  behaviour for a devnet gate and the wrong one for a hosted runner with no chain.
- **How excluded:** by *path selection at the call site* —
  `npm test -- tests/amount.test.ts tests/rateLimiter.test.ts`. The file is untouched; `npm test`
  with no arguments still runs all 55 tests and remains the gate a human or the factory runs
  against the devnet.
- **Health:** measured today against the live devnet — **55/55 pass**. Excluded for environment,
  not because it is broken.
- **What CI therefore does not cover for faucet:** real drip → balance change, nonce handling,
  dispatch-error decoding, the reserve floor against a real balance, and `GET /balance/:address`
  and `/health` against a real node. The offline 30 cover amount parsing/formatting and the
  sliding-window rate limiter — the drain-protection logic, but not the money movement.

### 3.2 `sdk` — nothing excluded

No exclusion was needed and none is applied. The SDK's chain-dependent block already gates itself
(`describe.skipIf(!runReal)`, `RUN_INTEGRATION=1`), so a plain `npm test` is offline by
construction: 9 passed, 1 skipped.

### 3.3 Non-test scripts not run

| Script | Project | Why not in CI |
|---|---|---|
| `verify:chain` | landing | Opens a WS connection to a live node. Not a test/lint/build script. |
| `fetch:chain-facts` | landing | **Regenerates** `chain-facts.json` from a live node. Running it in CI would overwrite the committed fixture the build and tests assert against. |
| `snapshot:chain` | docs | **Regenerates** `.chain/snapshot.json` from a live node — the exact fixture `check-chain-values.mjs` lints against. A gate that rewrites its own expected values checks nothing. Refreshing the snapshot stays a deliberate, reviewable commit. |
| `dev`, `preview` | docs | Long-running servers. |
| `start` | faucet | Long-running server. |
| `build` | sdk, faucet | `typecheck` (`tsc --noEmit`) covers the same compilation without emitting; faucet runs typecheck, sdk runs typecheck. |

---

## 4. Job names for branch protection

Add these as required status checks on `master`, alongside the existing `gate` and `full`:

```
landing
faucet
docs
sdk
```

Job `name:` is set explicitly and equals the job id in every case, so the check context string is
stable and will not drift if a job is renamed internally.

**`changes` is not in that list.** It is a dependency of the other four; requiring it adds nothing
(if it fails, all four fail). Requiring it is harmless if preferred.

**Do not add `sdk` as required until PR #91 merges.** It is red on master today for the two
defects in §1.4. Adding it as a required check now would block every PR — including #91 itself,
which is the thing that fixes it. Suggested order:

1. Merge this PR. Add `landing`, `faucet`, `docs` as required immediately — all three are green.
2. Merge PR #91 (lockfile + typecheck fix), then add `sdk` as required.

Command for the first three, once this is merged:

```bash
gh api -X PATCH repos/:owner/:repo/branches/master/protection/required_status_checks \
  -f 'checks[][context]=gate' \
  -f 'checks[][context]=full' \
  -f 'checks[][context]=landing' \
  -f 'checks[][context]=faucet' \
  -f 'checks[][context]=docs'
```

---

## 5. Expected result of this PR's own CI run

This PR changes `.github/workflows/ci-node.yml`, which selects **all four** jobs. Predicted:

| Check | Predicted | Why |
|---|---|---|
| `landing` | ✅ green | 10/10 locally |
| `faucet` | ✅ green | typecheck clean, 30/30 offline locally |
| `docs` | ✅ green | lint + build clean locally |
| **`sdk`** | ❌ **RED at `npm ci`** | no lockfile on master — §1.4 defect 1 |
| `gate` / `full` | ✅ green | no Rust touched |

**The red `sdk` check is the intended outcome of this round, not a regression.** It is a
pre-existing defect that no gate was previously able to see. Per the standing rule it is reported,
not routed around: there is no `continue-on-error`, no `|| true`, no narrowed command, and no
lockfile committed here to paper over it.

---

## 6. Files changed

- `.github/workflows/ci-node.yml` — new, 5 jobs.
- `CI-NODE.md` — this report.

No subproject source, test, config or manifest was modified. No lockfile was generated in the
repository (the sdk diagnostic install in §1.4 ran in a scratchpad copy outside the working tree).
`node_modules/` and `dist/` from the local runs are covered by each project's existing
`.gitignore` and are not staged.
