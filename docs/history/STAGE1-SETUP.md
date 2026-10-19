# STAGE 1 SETUP — backlog hygiene + safety audit

**Date:** 2026-08-03 · **Branch:** master · **Devnet:** 5 validators, spec 304, `ws://127.0.0.1:9944`

**Dispatcher was NOT enabled. No timer was started. No chain/runtime code was touched.**

> **DO NOT ENABLE STAGE 1 YET.** The audit found a blocking defect (F-1 below) that would
> cause all six T3 issues to report PASS with zero work done. Details and fix in
> "Anything that looks unsafe".

---

## 1. Issues closed

**33 closed**, 0 failures, 0 open remaining before the re-file.

Every one received the comment verbatim:

> Superseded by the master rebuild (rounds 2-15); remaining launch work re-filed as fresh tier-labeled issues.

Closed set: #26–#59 (the stale matty-era SC-*/AD-*/H-*/PQ-*/VL-*/ID-* backlog, plus the
`TEST: add AGENTS.md` smoke-test issue).

## 2. Issues created (12)

| # | Tier | Labels | Title |
|---|---|---|---|
| [70](https://github.com/tejaspatil1936/scalar-commons-v4/issues/70) | T3 | `tier:T3`, `ready` | Indexer: implement the REST API (24 endpoints) |
| [71](https://github.com/tejaspatil1936/scalar-commons-v4/issues/71) | T3 | `tier:T3`, `ready` | Explorer: block / extrinsic / account UI |
| [72](https://github.com/tejaspatil1936/scalar-commons-v4/issues/72) | T3 | `tier:T3`, `ready` | SDK: add recordGovVote(pollIndex, signer) + fix read methods on spec 304 |
| [73](https://github.com/tejaspatil1936/scalar-commons-v4/issues/73) | T3 | `tier:T3`, `ready` | Docs: developer + user documentation |
| [74](https://github.com/tejaspatil1936/scalar-commons-v4/issues/74) | T3 | `tier:T3`, `ready` | Landing page: public site |
| [75](https://github.com/tejaspatil1936/scalar-commons-v4/issues/75) | T3 | `tier:T3`, `ready` | Faucet: testnet token faucet |
| [76](https://github.com/tejaspatil1936/scalar-commons-v4/issues/76) | T1 | `tier:T1` | Public RPC exposure (firewall + wss reverse proxy) |
| [77](https://github.com/tejaspatil1936/scalar-commons-v4/issues/77) | T1 | `tier:T1` | Chaos test: kill validators / partition / spam |
| [78](https://github.com/tejaspatil1936/scalar-commons-v4/issues/78) | T1 | `tier:T1` | Live validation of the ROUND14 gov-farming fix against a real referendum |
| [79](https://github.com/tejaspatil1936/scalar-commons-v4/issues/79) | T0 | `tier:T0` | Real weight benchmarks for all extrinsics |
| [80](https://github.com/tejaspatil1936/scalar-commons-v4/issues/80) | T0 | `tier:T0` | B1 / Sybil-resistant diversity (economic distinctness) — post-testnet |
| [81](https://github.com/tejaspatil1936/scalar-commons-v4/issues/81) | T0 | `tier:T0` | ≥7 validators across separate hosts/operators — mainnet |

T1 and T0 carry **no `ready` label**, so the dispatcher skips them on two independent
grounds: the missing `ready` label (they never enter the candidate list) and the hard
tier refusal in `dispatch.sh` (`tier:T0|tier:T1` → "TIER TOO RISKY for autonomy").

Every body contains all four required elements: scope, the exact GATE command, the
standing rule ("never make a check pass by weakening code; a failure is a finding"), and
the note that work builds against the live devnet RPC at `ws://127.0.0.1:9944` (spec 304).

### Superseded Stage-0 loops

The existing factory Stage-0 loops — `trackB-indexer`, `trackB-sdk`, `trackB-explorer`,
`trackC-od4` (in `factory/tasks/*.prompt`) — are **superseded** by the dispatched issues
above (#70, #72, #71 respectively). They have **not** been deleted; they remain on disk
for reference. `factory/blocked/BLOCKED-trackB-sdk.md` (attempt cap, 10/10) is likewise
superseded by #72, which scopes the same work properly against real runtime metadata.
Do not run `factory/run-stage0.sh` alongside Stage 1 — it would duplicate #70/#71/#72.

## 3. Labels created

`factory/bootstrap-labels.sh` created **all 9** (none pre-existed; no `gh label create` by hand):

`ready` · `tier:T0` · `tier:T1` · `tier:T2` · `tier:T3` · `blocked` · `in-progress` ·
`agent-reviewed` · `needs-human`

The last two were not in the request but are created by the same script and are load-bearing:
`merge.sh` requires `agent-reviewed` and refuses on `needs-human`.

## 4. config.env — exact values before / after

| Key | Before | After |
|---|---|---|
| `MAX_PARALLEL` | `3` | `3` (unchanged) |
| `NIGHT_START` / `NIGHT_END` | `22` / `7` | unchanged |
| `DAY_MAX_PARALLEL` | `1` | `1` (unchanged) |
| `DEFAULT_MAX_ATTEMPTS` | `10` | `10` (unchanged) |
| `DEFAULT_MAX_MINUTES` | `240` | `240` (unchanged) |
| `SAME_ERROR_LIMIT` | `3` | `3` (unchanged) |
| **`DISPATCH_TIERS`** | **did not exist** (dispatcher accepted `tier:T3` **and** `tier:T2`) | **`tier:T3`** ← new |
| `MERGE_T2` | `false` | `false` (unchanged) |
| `MERGE_T3` | `true-only-after-protection` | **`true`** ← protection verified |
| `ENABLE_DISPATCH` | `false` | `false` (**untouched**) |
| `ENABLE_MERGE` | `false` | `false` (**untouched**) |
| `MIN_FREE_DISK_GB` | `30` | `30` (unchanged) |
| `BACKOFF_MINUTES` | `60` | `60` (unchanged) |
| `BASE_BRANCH` | `master` | `master` (unchanged) |
| **API daily spend cap** | **does not exist** | **still does not exist** — see F-2 |

### Two small script edits were required to make the config honest

The request was for a config-only round. Two edits were unavoidable because the stated
policy was otherwise unenforceable — a config value that no code reads is a comment, not a control.

1. **`factory/dispatch.sh`** — the dispatchable set was hardcoded `tier:T3|tier:T2`, with no
   knob. Added a `DISPATCH_TIERS` allowlist check *inside* the existing T3/T2 branch, so it
   can only ever **narrow**: `tier:T0`/`tier:T1` still fall through to the hard refusal
   regardless of what `DISPATCH_TIERS` contains. Verified by dry run: all six T3 issues are
   candidates, and a `tier:T2` issue would now log
   `SKIP … not in DISPATCH_TIERS="tier:T3" — out of scope for this stage`.
2. **`.claude/settings.json`** — see F-3; the standing-rule hook was not wired at all.

Both are strict tightenings. Neither touches runtime, pallets, or the node.

## 5. Safety confirmations

| Control | Status | Evidence |
|---|---|---|
| Branch protection on `master` | **PRESENT** | required checks `gate`,`full`; `strict:true`; `enforce_admins:true`; `allow_force_pushes:false` |
| Required checks map to real jobs | **YES** | job id `gate` in `ci-fast.yml`, `full` in `ci-full.yml`, both on `pull_request` |
| `merge.sh` refuses without protection | **YES** | condition 1, checked before all others; exits 1 and prints why regardless of `MERGE_*` flags |
| T3 auto-merge | **ON** (`MERGE_T3=true`) | still additionally gated on `ENABLE_MERGE=true` + `agent-reviewed` + no `needs-human` + green CI + no conflicts + not draft |
| T2 merge | **OFF** | `MERGE_T2=false` → `REFUSE … T2 auto-merge stays off by policy` |
| T0/T1 never dispatched | **YES** | hard `case` refusal in `dispatch.sh`, independent of labels/config |
| T0/T1 never auto-merged | **YES** | `merge.sh`: `tier:T0\|tier:T1) refuse "$tier is never auto-merged"` |
| 3 fresh-context reviewers on every PR | **YES** | `review.sh` runs 3 separate `claude -p` calls — lenses `correctness`, `conformance`, `standing`; each a new context; ≥2 PASS → `agent-reviewed`; **any** FAIL → `needs-human`; an unparseable verdict counts as FAIL |
| Review precedes merge | **YES** | `merge.sh` condition 2 refuses any PR lacking `agent-reviewed` |
| `MAX_PARALLEL` in force | **YES** | dry run: `window: day … MAX_PARALLEL=1`; 5 of 6 issues logged `DEFER … MAX_PARALLEL=1 reached` |
| Attempt cap in force | **YES** | `10 attempts` per loop; `SAME_ERROR_LIMIT=3` stops byte-identical failures early |
| Wall-clock cap in force | **YES** | `240 min` per loop; `watchdog.sh` kills at cap + 2 min grace |
| Disk guard | **YES** | 1873 GB free vs 30 GB floor |
| Rate-limit back-off | **YES** | `watchdog.sh` rate guard → 60 min global back-off |
| Kill switch | **YES** | `touch /home/dev/STOP_FACTORY` — every component exits before doing work |
| **API daily spend cap** | **ABSENT** | **F-2 — no such control exists anywhere in the factory** |
| **reject-stubs PostToolUse hook** | **WAS NOT WIRED** | **F-3 — now wired** |

---

## Anything that looks unsafe

### F-1 — BLOCKING. All six T3 issues would PASS their gate with zero work done.

`dispatch.sh` calls `detect_gate` **at dispatch time**, before the worker has written
anything. `detect_gate` derives the gate from the files changed in the worktree — which is
empty at that moment — so `sub` is empty and it falls through to the workspace gate:

```
flock ~/.factory/cargo.lock bash -c 'cargo check --workspace && cargo test --workspace --no-run'
```

`loop.sh` then runs that gate once up front and short-circuits:

```
gate already passes before any attempt — nothing to do. PASS
```

That gate is **already green on master**. So every T3 issue exits PASS at attempt 0 having
done nothing. This is precisely the `trackC-od4 | 0 attempts | already green | 0m1s` row in
`factory/STATE.md`.

Two aggravating factors:
- The gate the worker is held to has **no relationship to the gate written in the issue body**
  (`cd indexer && npm ci && npm test`, etc.).
- `explorer/`, `faucet/`, and the landing-page directory **do not exist yet**, so `detect_gate`
  has nothing to match on for #71, #74, #75 even after files change.

Not a merge risk (an empty branch produces no PR), but it would burn all six issues and
report success. **Fix before enabling:** parse the fenced GATE command out of the issue body
and use it as the gate, falling back to `detect_gate` only when absent. Every issue created
this round already carries its gate in a fenced block for exactly this purpose.

### F-2 — There is no API daily spend cap. There never was one.

A full sweep of `factory/` for `spend|budget|daily.?(cap|limit)|max_cost|usd|dollar` returns
only prose in comments. The bounds that do exist are per-loop (10 attempts, 240 min) and
per-pass (`MAX_PARALLEL`), which bound *concurrency and duration*, not *cost*: 6 issues ×
10 attempts × 240 min, plus 3 review lenses per PR, has no dollar ceiling and no daily
reset. I did **not** add a config key for this — an unenforced `DAILY_SPEND_CAP_USD` would
read as a control while doing nothing, which is worse than its visible absence. This needs a
real implementation (a spend ledger the dispatcher and `review.sh` both check before
spawning) before unattended 24/7 operation.

### F-3 — The standing-rule hook was not wired. Now wired.

`.claude/settings.json` had exactly one `PostToolUse` hook: `.claude/hooks/post-edit.sh`,
which only runs `rustfmt`. `.claude/hooks-factory/reject-stubs.sh` existed and worked but
**was never referenced** — despite `dispatch.sh:352` telling every worker "Standing rule
enforced at write time by `.claude/hooks-factory/reject-stubs.sh`". Workers would have been
told a mechanical guard was watching them when none was. Added it as a second hook on the
same `Write|Edit|MultiEdit` matcher. Verified live:

```
$ printf '{"tool_input":{"file_path":".../t.rs"}}' | bash .claude/hooks-factory/reject-stubs.sh
BLOCKED by factory standing rule: never make a check pass by weakening code.
  - todo!( — placeholder body. 1 occurrence(s) on line(s): 1
RC=2
```

### F-4 — A second, unreviewed auto-merge path to master exists.

`.github/workflows/auto-merge-claude.yml` enables GitHub auto-merge (`--auto --squash`) on
any PR whose head branch starts with `claude/`. It does **not** consult `review.sh`,
`agent-reviewed`, or `needs-human`. With `required_approving_review_count: 0` in branch
protection, such a PR merges to master as soon as `gate` and `full` go green — no human and
no agent review.

Factory PRs are unaffected: `dispatch.sh` pushes `task/<num>`, which does not match
`claude/`. So this is not a Stage 1 regression — but it is a live unreviewed write path to
the trunk, left over from the matty-era swarm. Recommend deleting it or narrowing it to
require `agent-reviewed`.

### F-5 — Creating issues fires the claude-swarm workflows.

`claude.yml` and `claude-opus.yml` trigger on `issues`. Creating the 12 issues produced 12+
workflow runs; all were **`skipped`** (their `if` conditions require an `@claude` mention),
so nothing ran and nothing was spent. Noted only so the skipped runs in `gh run list` are
not mistaken for factory activity.

### F-6 — `required_approving_review_count: 0`.

Branch protection requires status checks but zero human approvals. That is coherent with the
factory design (the 3 review lenses are the review, and `merge.sh` enforces them), but it
means anything that bypasses `merge.sh` — see F-4 — reaches master unreviewed.

---

## The exact command to enable Stage 1 dispatch

**Do not run this until F-1 is fixed.** With F-1 outstanding it will mark all six T3 issues
PASS without doing any work.

```
sed -i 's/^ENABLE_DISPATCH=.*/ENABLE_DISPATCH="${ENABLE_DISPATCH:-true}"/' factory/config.env
```

Then dispatch runs on its next invocation (or `./factory/dispatch.sh` to run one pass now).

To preview without enabling anything — safe to run right now, performs zero mutations:

```
./factory/dispatch.sh --dry-run
```

Auto-merge is a **separate second switch** and is deliberately still off. `MERGE_T3=true`
sets the tier policy; `ENABLE_MERGE` is what actually lets `merge.sh` act. Enable it only
after T3 PRs have been reviewed by hand at least once:

```
sed -i 's/^ENABLE_MERGE=.*/ENABLE_MERGE="${ENABLE_MERGE:-true}"/' factory/config.env
```

Stop everything at any time:

```
touch /home/dev/STOP_FACTORY
```
