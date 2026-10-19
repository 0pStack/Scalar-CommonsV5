# STATUS — Scalar Commons v4

_Read-only status report. Generated 2026-08-18. Nothing was built, run, started, stopped, or committed to produce it._

---

## 1. Repo snapshot

**Branch:** `master`
**Working tree:** not clean — one untracked file, `STAGE1-HARDENING.md` (the PR #82 write-up; the PR itself is merged, the report file was never committed). No modified or staged files.

### `git log --oneline -20`

| commit | date | subject |
|---|---|---|
| 79aac43 | 2026-08-07 | factory: harden review.sh — enforce stdin delivery, full coverage, real test (#90) |
| d3aebf1 | 2026-08-05 | factory: fix review.sh failing every lens on large diffs (#86) |
| 660c840 | 2026-08-05 | [factory] Docs: developer + user documentation (#73) (#85) |
| bc21b03 | 2026-08-05 | faucet: devnet CMN faucet with per-address and per-IP rate limiting (#84) |
| 0fce317 | 2026-08-05 | [factory] Landing page: public site (#74) (#83) |
| e2138c1 | 2026-08-04 | Merge pull request #82 from tejaspatil1936/fix/stage1-hardening |
| 0f7313e | 2026-08-04 | Merge branch 'master' into fix/stage1-hardening |
| aabcc6d | 2026-08-03 | factory: harden Stage 1 — real gates, spawn budget, remove burn loops |
| badc47b | 2026-08-04 | Merge pull request #69 from tejaspatil1936/feat/devnet-4validators |
| 507c2b5 | 2026-08-03 | docs: record ROUND15 CI result (both checks green on PR #69) |
| 3f94aa6 | 2026-08-03 | docs: ROUND15 — finality survives one validator down |
| 0c0da7b | 2026-08-03 | deploy: extend devnet to 5 validators, topology in one place |
| 0edee76 | 2026-08-03 | chain_spec: extend local preset authority set from 3 to 5 |
| 297bd66 | 2026-08-03 | Merge pull request #68 from tejaspatil1936/chore/housekeeping |
| 1310969 | 2026-08-03 | docs: add CIFIX and ROUND11 reports |
| 0b87944 | 2026-08-03 | factory: point base branch at master; widen tests-fix prompt |
| 7b2e23b | 2026-08-03 | Merge pull request #67 from tejaspatil1936/fix/gov-and-diversity |
| 5141b4b | 2026-08-03 | ci: run the test suite in ci-full instead of only compiling it |
| 920b1ed | 2026-08-03 | docs: ROUND14 — gov-credit and diversity-ordering fixes, with the numbers |
| 8975559 | 2026-08-03 | runtime: right-size governance alpha 4,000 -> 1,500 bps |

**Last commit was 2026-08-07 — 11 days ago. No commits since.**

### Last 15 merged PRs

| # | merged (UTC) | title |
|---|---|---|
| 90 | 2026-08-07 | factory: harden review.sh — enforce stdin delivery, full coverage on #85, test the real parser |
| 86 | 2026-08-05 | factory: fix review.sh failing every lens on large diffs (E2BIG, not model overload) |
| 85 | 2026-08-05 | [factory] Docs: developer + user documentation (#73) |
| 84 | 2026-08-05 | [factory] Faucet: testnet token faucet (#75) |
| 83 | 2026-08-05 | [factory] Landing page: public site (#74) |
| 82 | 2026-08-04 | factory: harden Stage 1 — real gates, spawn budget, remove burn loops |
| 69 | 2026-08-03 | ROUND15: harden devnet to 5 validators — finality survives one down |
| 68 | 2026-08-03 | chore: factory base→master, widen tests-fix prompt, add reports |
| 67 | 2026-08-03 | agents/runtime: close governance-farming vector, fix diversity ordering, right-size gov weight (ROUND14) |
| 66 | 2026-08-02 | Rebuild: working chain (rounds 2-7) |
| 26 | 2026-07-07 | fix: add Cargo.toml manifests for all pallets + node/runtime stubs (closes #6) |
| 25 | 2026-07-06 | feat: SC-E1 analysis + verdict pipeline |
| 24 | 2026-07-06 | docs: knowledge-graph write-back bootstrap |
| 23 | 2026-07-06 | test: indexer measurement-plane reconciliation fixture (P0-5) |
| 22 | 2026-07-06 | sim: Phase-0 v2 re-run against verified formula |

### Open PRs

**None.** `gh pr list --state open` returns an empty list — nothing in flight, no CI status to report.

---

## 2. CI / Actions health

### Last 15 workflow runs

| conclusion | workflow | branch | event | finished (UTC) | duration |
|---|---|---|---|---|---|
| success | ci-full | master | push | 2026-08-07 01:50 | 1h11m |
| success | ci-fast | factory/review-harden | pull_request | 2026-08-06 20:54 | 37m |
| success | ci-full | factory/review-harden | pull_request | 2026-08-07 00:14 | 1h34m |
| success | ci-full | master | push | 2026-08-05 18:10 | 36m |
| success | ci-fast | factory/review-fix | pull_request | 2026-08-05 17:35 | 11m |
| success | ci-full | factory/review-fix | pull_request | 2026-08-05 17:35 | 34m |
| success | ci-full | factory/review-fix | pull_request | 2026-08-05 11:48 | 35m |
| success | ci-fast | factory/review-fix | pull_request | 2026-08-05 11:48 | 26m |
| success | ci-full | master | push | 2026-08-05 02:59 | 34m |
| success | ci-full | task/73 | pull_request | 2026-08-05 02:24 | 34m |
| success | ci-fast | task/73 | pull_request | 2026-08-05 02:24 | 12m |
| success | ci-full | master | push | 2026-08-05 01:44 | 35m |
| success | ci-fast | task/73 | pull_request | 2026-08-05 01:08 | 13m |
| success | ci-full | task/73 | pull_request | 2026-08-05 01:08 | 38m |
| success | ci-fast | task/75 | pull_request | 2026-08-05 01:08 | 11m |

**No failed or cancelled runs in the last 15.** All green. The most recent run of any kind is the `ci-full` push build on master for #90 (2026-08-07) — **CI has not run in 11 days**, simply because nothing has been pushed. Build status on master is therefore "green as of 79aac43", asserted from CI history, not from a local compile.

### Branch protection on `master`

- Required status checks: **`gate`** and **`full`**, `strict: true` (branch must be up to date before merge)
- `enforce_admins`: **enabled**
- Required approving reviews: **0** (`dismiss_stale_reviews` false, code-owner review not required, last-push approval not required)
- Force pushes: **disabled**. Branch deletion: **disabled**. Required signatures: off. Linear history: not required. Conversation resolution: not required.

This is the configuration the factory's `MERGE_T3=true` was predicated on, and it is still in place.

---

## 3. Issues / backlog — 12 open

### tier:T3 + `ready` — dispatchable now (2)

| # | title | labels |
|---|---|---|
| 88 | [docs][security] rpc.md and run-a-node.md contradict each other on unsafe RPC method exposure | tier:T3, ready, documentation, security |
| 87 | [docs] run-a-node.md: 'Verify it joined' checks the wrong node | tier:T3, ready, documentation |

Both are documentation fixes against the docs shipped in #85, both self-contained under `docs/`.

### tier:T3, not `ready` — larger builds, deliberately not dispatchable (3)

| # | title |
|---|---|
| 72 | SDK: add recordGovVote(pollIndex, signer) + fix read methods on spec 304 |
| 71 | Explorer: block / extrinsic / account UI |
| 70 | Indexer: implement the REST API (24 endpoints) |

Note: `indexer/` currently contains only `reconcile.py` — the 24-endpoint REST API described in CLAUDE.md does not exist yet; #70 is that work.

### tier:T1 — never autonomous (4)

| # | title |
|---|---|
| 89 | [verification] Confirm check-chain-values.mjs actually asserts; resolve √stake vs stake — also labelled **needs-human** |
| 78 | Live validation of the ROUND14 gov-farming fix against a real referendum |
| 77 | Chaos test: kill validators / partition / spam |
| 76 | Public RPC exposure (firewall + wss reverse proxy) |

### tier:T0 — never autonomous, consensus/economic core (3)

| # | title |
|---|---|
| 81 | ≥7 validators across separate hosts/operators — mainnet |
| 80 | B1 / Sybil-resistant diversity (economic distinctness) — post-testnet |
| 79 | Real weight benchmarks for all extrinsics |

### Unlabeled

None — every open issue carries a tier label.

**Immediate backlog vs later:** the immediate, machine-actionable backlog is exactly two docs issues (#87, #88). Everything else is either a human-judgement item (T1/T0: chaos testing, RPC exposure, benchmarks, mainnet validator set) or a T3 build that has had its `ready` label deliberately withheld (#70, #71, #72).

---

## 4. Factory state

### `factory/config.env` — current values

| setting | value |
|---|---|
| `ENABLE_DISPATCH` | **false** |
| `ENABLE_MERGE` | **false** |
| `DISPATCH_TIERS` | `tier:T3` (Stage-1 policy; T2 parked) |
| `MAX_PARALLEL` | 3 (clamped to `DAY_MAX_PARALLEL=1` outside the 22:00–07:00 UTC window) |
| `MAX_REVIEW_DIFF_LINES` | 2500 (raised from 1500 on 2026-08-05 after #85 truncation produced false findings) |
| `DAILY_SPAWN_CAP` | 40 |
| `MERGE_T2` | false |
| `MERGE_T3` | **true** (unblocked once branch protection was verified on 2026-08-03) |

Both stage switches are OFF, so the factory is fully idle by configuration: even with `MERGE_T3=true`, merging additionally requires `ENABLE_MERGE=true`, an `agent-reviewed` label, no `needs-human` label, and green CI.

### Is anything running?

- `pgrep -af 'dispatch.sh|loop.sh|review.sh'` → **nothing** (only the pgrep's own shell matched).
- `tmux ls` → 4 sessions alive but idle: `chain` (created Jul 29), `dispatch` (Aug 4), `factory` (Jul 30), `loops` (Aug 2, 4 windows: trackB-indexer, trackB-sdk, trackB-explorer, trackC-od4). These are leftover shells from earlier rounds; no factory process is executing in them.
- systemd user timers **are** live: `factory-watchdog.timer` (every ~31 min, last pass 2026-08-18 20:18 CEST) and `factory-digest.timer` (daily 07:30 CEST, last 2026-08-18). These only observe and report — they do not dispatch.

### `factory/STATE.md` (generated by `tracker.sh`, stamped 2026-08-18T18:18:14Z)

- kill switch: clear · rate-limit back-off: clear
- disk: 1831 GB free (min 30 GB) — OK
- window: day (throttled to 1)
- dispatcher: false | merge: false
- merges yesterday: **0**
- Tasks touched in last 24h: **none**
- Open factory PRs: **none**
- Loop stats last 24h: **empty**
- Open BLOCKED reports: **1 — `BLOCKED-trackB-sdk.md`**

### Newest factory logs

`factory/logs/watchdog.systemd.log` (last written 2026-08-18 20:18) — last 10 lines:

```
[2026-08-18T17:16:14Z] no rate-limit signatures in the last 35 min
[2026-08-18T17:16:14Z] watchdog pass complete (killed 0 loop(s))
[2026-08-18T17:47:14Z] === watchdog pass ===
[2026-08-18T17:47:14Z] disk OK: 1831GB free (min 30GB)
[2026-08-18T17:47:14Z] no rate-limit signatures in the last 35 min
[2026-08-18T17:47:14Z] watchdog pass complete (killed 0 loop(s))
[2026-08-18T18:18:14Z] === watchdog pass ===
[2026-08-18T18:18:14Z] disk OK: 1831GB free (min 30GB)
[2026-08-18T18:18:14Z] no rate-limit signatures in the last 35 min
[2026-08-18T18:18:14Z] watchdog pass complete (killed 0 loop(s))
```

There are **no `dispatch*.log` or `review*.log` files at all**. The newest dispatch-loop log is `issue-73-20260804.log` (2026-08-04), which ended successfully:

```
[2026-08-04T06:38:30Z] === loop "issue-73" starting ===
[2026-08-04T06:38:30Z] gate=cd docs && npm ci --no-audit --no-fund && npm run lint && npm run build
[2026-08-04T06:38:30Z] caps: attempts=10 minutes=240 (deadline 10:38:30Z)
[2026-08-04T06:38:30Z] gate is red at start (expected) — beginning attempts
[2026-08-04T06:38:31Z] --- attempt 1/10 (14399s of wall budget left) ---
[2026-08-04T07:00:19Z] agent exited rc=0
[2026-08-04T07:00:25Z] gate exited rc=0
[2026-08-04T07:00:25Z] GATE PASSED on attempt 1 after 1315s. PASS
```

`factory/logs/watchdog.log` holds a single line from 2026-08-04: `STOP_FACTORY honoured; 0 process(es) terminated`.

The daily digest log confirms the digest timer has been gisting STATE.md every morning through 2026-08-18 (latest: `gist.github.com/tejaspatil1936/a475d711356a40de2e1b888c147d2817`).

### BLOCKED reports

One, at `factory/blocked/BLOCKED-trackB-sdk.md`, from **2026-08-02**:

- reason: attempt cap reached (10/10), 30m2s wall of a 240m budget
- gate: `cd sdk && npm ci --no-audit --no-fund && npm run typecheck && npm test`
- last gate output: `tsc` clean, `vitest` red — `tests/retry.test.ts` passes (4 tests), `tests/integration.test.ts` has 2 failed / 1 skipped, starting with `ScalarCommonsClient — read methods > eraInfo decodes timing and settlement`

This is the same failure that open issue **#72** ("SDK: add recordGovVote + fix read methods on spec 304") describes — the block is tracked, not lost.

### Spawn ledger (`~/.factory/`)

| ledger | spawns recorded |
|---|---|
| `spend-20260804` | 15 |
| `spend-20260805` | 6 |
| `spend-20260806` | 3 |

**No `spend-20260818` file exists — 0 of 40 spawns used today.** The last agent spawn of any kind was 2026-08-06.

### Kill switch

`~/STOP_FACTORY` is **not present**. The factory is stopped by its config flags (`ENABLE_DISPATCH=false`), not by the kill switch.

---

## 5. Chain / runtime

_No build was run. All of the below is read off the tree and the process table._

- **spec_version: 304** (`runtime/src/lib.rs:150`), `impl_version: 0`, `transaction_version: 1`.
- **Pallets present** under `pallets/` (7, matching CLAUDE.md): `agents`, `auto-params`, `constitution`, `emissions`, `escrow`, `oracle`, `orchestrator`.
- **`deploy/` does define a devnet**: `nodes.env` is the single source of truth for a **5-node topology** (`alice bob charlie dave eve`, alice as bootnode, ports derived as p2p 30333+i / rpc 9944+i / prometheus 9615+i), with `scalar-local-raw.json` as the raw chain spec, `install.sh` / `reset-chain.sh` / `snapshot.sh` / `build-spec.sh` / `finality-check.sh` as the operator scripts, and systemd units for all five nodes plus a `scalar-devnet.target`.
- **A devnet is currently running.** Five `scalar-node --release` validators are live against `deploy/scalar-local-raw.json`:

| node | base-path | rpc | p2p | notes |
|---|---|---|---|---|
| alice | `~/scalar-testnet/alice` | 9944 | 30333 | bootnode, `--rpc-methods safe`, `--rpc-cors all`, archive pruning, prometheus 9615 |
| bob | `~/scalar-testnet/bob` | 9945 | 30334 | |
| charlie | `~/scalar-testnet/charlie` | 9946 | 30335 | |
| dave | `~/scalar-testnet/dave` | 9947 | 30336 | |
| eve | `~/scalar-testnet/eve` | 9948 | 30337 | |

Alice/bob/eve have been up since one start (pids 701914/701915/701918); charlie/dave were started later (pids 706903/706904) — consistent with the ROUND15 one-validator-down finality exercise. **Nothing was started or stopped by this report.**

---

## 6. What shipped recently

Reading the merged PRs together with `FACTORY-*.md`, `ROUND*.md`, `STAGE1-*.md` and `CIFIX.md` in the repo root (there is no `reports/` directory — the write-ups live at top level):

- **The chain itself was rebuilt and re-validated** (#66, ROUND2–ROUND13). A working Substrate chain on spec 304 with all seven pallets, plus `CIFIX.md` recording the CI repair and `BASELINE.md` the measured baseline.
- **Economic hardening (ROUND14, #67).** Closed a governance-farming vector by wiring `GovVoteVerifier` to real `pallet_conviction_voting` state, fixed diversity ordering, and right-sized the governance alpha from 4,000 to 1,500 bps — with the numbers written up in `ROUND14.md`.
- **Devnet hardened to 5 validators (ROUND15, #69).** Chain-spec authority set 3→5, topology consolidated into `deploy/nodes.env` so adding a node no longer means editing three scripts, and a demonstrated result: **finality survives one validator going down**.
- **Landing page (#83, issue #74).** A public site under `landing/` with its own test suite and a `chain-facts.json` fed from verified chain constants.
- **Faucet (#84, issue #75).** A devnet CMN faucet under `faucet/` with per-address *and* per-IP rate limiting, tests included.
- **Documentation (#85, issue #73).** Developer + user docs under `docs/` (guide, reference, RFCs, `VERIFIED-CONSTANTS.md`) with a lint+build gate. The two open docs issues (#87, #88) are follow-up defects found in exactly this material.
- **Factory Stage-1 hardening (#82).** Real gates derived from the issue body, a daily spawn budget with dated ledgers, and removal of the burn loops — `ENABLE_DISPATCH`/`ENABLE_MERGE` deliberately left `false`.
- **Reviewer fixed, then hardened (#86 then #90).** #86 diagnosed that every review lens was failing on large diffs because of `E2BIG` at `execve` — not model overload — and switched prompt delivery to a stdin file redirect while adding size caps. #90 then made stdin delivery mandatory rather than incidental, raised `MAX_REVIEW_DIFF_LINES` 1500→2500 after proving that truncating #85 made the reviewer *manufacture* two false findings, and replaced a safety test that was green while asserting the wrong rules with one that tests the real verdict parser.

The through-line of the last three weeks: three real user-facing subprojects shipped autonomously (landing, faucet, docs), and then the autonomy machinery that produced them was audited and repaired twice.

---

## 7. Where things stand / next step

The chain is green and idle: master's last commit (79aac43, 2026-08-07) passed `ci-full`, branch protection on master is intact with `gate` + `full` required and `enforce_admins` on, and a 5-validator devnet on spec 304 has been running locally the whole time. The factory is fully stopped by configuration — `ENABLE_DISPATCH=false` and `ENABLE_MERGE=false`, zero spawns today against a cap of 40, no dispatch/loop/review process alive, only the watchdog and digest timers ticking — so nothing has moved in 11 days and no work is in flight (zero open PRs). The backlog is thin at the dispatchable end: exactly two `tier:T3 + ready` issues (#87, #88), both docs defects in the material #85 shipped; the three larger T3 builds (#70 indexer REST API, #71 explorer, #72 SDK) have had `ready` withheld, and #72 is the same failure captured in the one open BLOCKED report (`BLOCKED-trackB-sdk.md`, SDK integration tests red against spec 304 since 2026-08-02). Everything else open is T1/T0 and requires a human by policy.

**Single next action:** decide whether to re-enable the factory for one bounded pass. Concretely, that means setting `ENABLE_DISPATCH=true` in `factory/config.env` and letting the dispatcher take #87 and #88 — the two ready T3 docs issues — under the existing caps, which is the smallest run that exercises the hardened `review.sh` from #90 end-to-end on real work. (If the preference is to stay stopped, the equivalent no-autonomy action is to fix #87/#88 by hand and commit the untracked `STAGE1-HARDENING.md`.)
