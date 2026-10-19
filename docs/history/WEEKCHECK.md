# WEEKCHECK — Week-Gap Checklist Audit

**Audit run:** 2026-08-29 ~02:10–02:15 UTC · read-only
**Gap audited:** 2026-08-19 (plan set) → 2026-08-29 (now), ~9 nights unattended
**Repo:** `tejaspatil1936/scalar-commons-v4` · master tip `79aac43` (2026-08-07)

**Headline:** the feared failure mode (duplicate PRs) **did not happen**. A different one did:
the dispatcher ran **86 times** over 9 nights and produced **zero** new PRs, zero commits, zero
merges. It re-dispatched the same three already-finished issues every hour, every night, and
`gh pr create` refused every time because the PR already existed. Net new output for the week: **nothing**.

---

## A. Checklist verification

| # | Item | Status |
|---|------|--------|
| A1 | `ready` removed from #70, #71, #72 | ✅ **DONE** |
| A2 | `ready` removed from #94, #95, #96 | ❌ **NOT DONE** |
| A3 | tier:T3 + ready queue | ⚠️ 5 issues live (#94,#95,#96,#87,#88) |
| A4 | Correction comment on #94 | ✅ **DONE** |
| A5 | PR #97 merged | ❌ **NOT DONE** — still OPEN |
| A6 | `ci-node.yml` on master | ❌ **NOT DONE** |
| A7 | landing/faucet/docs/sdk in branch protection | ❌ **NOT DONE** — none added |
| A8 | factory-merge.service / .timer | ❌ **NOT DONE** — units do not exist |
| A9 | factory-digest.service.d drop-in | ❌ **NOT DONE** |
| A10 | bob/charlie/dave/eve `--rpc-methods safe` | ❌ **NOT DONE** — alice only |

### A1 — `ready` removed from #70/#71/#72 — ✅ DONE

```
#70 [OPEN] Indexer: implement the REST API (24 endpoints)      labels: tier:T3
#71 [OPEN] Explorer: block / extrinsic / account UI            labels: tier:T3
#72 [OPEN] SDK: add recordGovVote(pollIndex, signer) ...        labels: tier:T3
```
No `ready` on any of the three. These are correctly out of the dispatch queue.

### A2 — `ready` removed from #94/#95/#96 — ❌ NOT DONE

```
#94 [OPEN] SDK: fix review findings on PR #91 ...       labels: ready, tier:T3
#95 [OPEN] Explorer: fix review findings on PR #92 ...  labels: ready, tier:T3
#96 [OPEN] Indexer: fix review findings on PR #93 ...   labels: ready, tier:T3
```

**This single omission is the root cause of the entire wasted week.** These three labels kept the
dispatcher spinning on finished work for 9 nights.

### A3 — Live dispatch queue (tier:T3 + ready)

```
#96 Indexer: fix review findings on PR #93 (REST API, 24 endpoints)  [ready,tier:T3]
#95 Explorer: fix review findings on PR #92 (block/extrinsic/account UI) [ready,tier:T3]
#94 SDK: fix review findings on PR #91 (recordGovVote + spec-304)    [ready,tier:T3]
#88 [docs][security] rpc.md and run-a-node.md contradict each other  [documentation,ready,tier:T3,security]
#87 [docs] run-a-node.md: 'Verify it joined' checks the wrong node   [documentation,ready,tier:T3]
```

Five issues. #94/#95/#96 are **already delivered** (PRs #98/#99/#100 open and green) — they should
not be in the queue. #87 and #88 are genuinely undone but were **never picked up**: the dispatcher
fills its 3 parallel worker slots (`MAX_PARALLEL=3`) with #94/#95/#96 on every single pass and
never reaches them.

### A4 — Correction comment on #94 — ✅ DONE

```
--- 2026-08-19T19:35:45Z by tejaspatil1936 ---
CORRECTION: finding #2 (undeclared @polkadot/keyring and @polkadot/util-crypto) is WRONG and
must be ignored. Verified: sdk/package.json on branch task/72 declares both at ^13.0.0. The
reviewer inferred 'not declared' from 'no package.json change in this diff' — a non-sequitur.
Additionally: master has NO sdk/package-lock.json, so this PR ADDS one; npm ci could not have
run on master before it. Do not 'fix' this finding.
```

The correction landed **and was honoured** — the worker's delta commit does not touch
`package-lock.json` (verified in section C).

### A5 — PR #97 — ❌ OPEN, not merged

```
#97 ci: add ci-node.yml — real gates for landing, faucet, docs, sdk
state=OPEN head=ci/node-coverage base=master
created=2026-08-19T19:53:25Z merged=null closed=null   mergeCommit=none
```

### A6 — `ci-node.yml` on master — ❌ ABSENT

```
$ git ls-tree origin/master .github/workflows/
  ci-fast.yml   ci-full.yml   claude.yml   file-issues.yml
$ git show origin/master:.github/workflows/ci-node.yml
fatal: path '.github/workflows/ci-node.yml' exists on disk, but not in 'origin/master'
```

Jobs it *would* define (from `origin/ci/node-coverage`): `changes` (path filter) → `landing`,
`faucet`, `docs`, `sdk`. It only exists on the unmerged branch.

### A7 — Branch protection — ❌ none of the four added

```
$ gh api repos/:owner/:repo/branches/master/protection/required_status_checks -q '.contexts'
["gate","full"]
```

Still just `gate` and `full`. Adding the four is blocked behind #97 anyway — a required context
that no workflow on master produces would wedge every PR.

### A8 — factory-merge units — ❌ DO NOT EXIST

```
$ systemctl --user status factory-merge.service
Unit factory-merge.service could not be found.
$ systemctl --user status factory-merge.timer
Unit factory-merge.timer could not be found.
$ systemctl --user show factory-merge.service -p Environment
Environment=
```

Timers actually installed — merge is absent:

```
NEXT                          LEFT      LAST                          UNIT
Sat 2026-08-29 04:41:14 CEST  29min     Sat 2026-08-29 04:11:14 CEST  factory-watchdog.timer
Sat 2026-08-29 05:00:00 CEST  48min     Sat 2026-08-29 04:04:46 CEST  factory-dispatch.timer
Sat 2026-08-29 07:30:00 CEST  3h 18min  Fri 2026-08-28 07:30:46 CEST  factory-digest.timer
```

Note a misleading detail: `factory-dispatch.service.d` sets `Environment=ENABLE_MERGE=true`. That
flag is **inert** — `dispatch.sh` never invokes `merge.sh`:

```
$ grep -nE "merge\.sh|ENABLE_MERGE" factory/dispatch.sh factory/lib/*.sh factory/config.env
factory/config.env:67:ENABLE_MERGE="${ENABLE_MERGE:-false}"
factory/dispatch.sh:454:  ... `factory/merge.sh` is the only component permitted to merge, and
factory/dispatch.sh:572:  printf '  WOULD: NOT merge (merge.sh is the only merger, and it is off)\n'
```

`factory/merge.sh` exists (9176 bytes, Aug 2) but nothing calls it and no `merge.systemd.log` was
ever created. Autonomous merge is structurally impossible as currently wired.

### A9 — factory-digest drop-in — ❌ ABSENT

```
$ ls -la ~/.config/systemd/user/factory-digest.service.d/
ls: cannot access '...': No such file or directory
```

`systemctl --user cat factory-digest.service` shows the bare unit with no drop-in. The STATE.md
honesty fix was never applied.

### A10 — Validator RPC hardening — ❌ NOT DONE (alice only)

Unit files — `--rpc-methods` appears **only** in alice:

```
deploy/systemd/scalar-alice.service:32:    --rpc-methods safe
deploy/systemd/scalar-bob.service      — no --rpc-methods line
deploy/systemd/scalar-charlie.service  — no --rpc-methods line
deploy/systemd/scalar-dave.service     — no --rpc-methods line
deploy/systemd/scalar-eve.service      — no --rpc-methods line
```

Live `/proc/<pid>/cmdline` (flags read only; no RPC method was invoked to test):

```
701914 alice   ... --rpc-port 9944 --rpc-cors all --rpc-methods safe --state-pruning archive ...
701915 bob     ... --rpc-port 9945 --prometheus-port 9616 --bootnodes ...   [no --rpc-methods]
706903 charlie ... --rpc-port 9946 --prometheus-port 9617 --bootnodes ...   [no --rpc-methods]
706904 dave    ... --rpc-port 9947 --prometheus-port 9618 --bootnodes ...   [no --rpc-methods]
701918 eve     ... --rpc-port 9948 --prometheus-port 9619 --bootnodes ...   [no --rpc-methods]
```

All five have been up **25 days** (started Aug 3) and were never restarted, so even a unit-file
edit would not have taken effect:

```
    PID     ELAPSED                  STARTED
 701914 25-08:54:54 Mon Aug  3 19:19:16 2026
 701915 25-08:54:54 Mon Aug  3 19:19:16 2026
 701918 25-08:54:54 Mon Aug  3 19:19:16 2026
 706903 25-08:49:44 Mon Aug  3 19:24:26 2026
 706904 25-08:49:44 Mon Aug  3 19:24:26 2026
```

With no `--rpc-methods` flag, substrate defaults to `auto`, which serves the **unsafe** method set
on a loopback-bound RPC. Ports 9945–9948 are localhost-only, so this is a local-privilege /
defence-in-depth gap rather than remote exposure — but it is exactly the gap issue #88 describes,
and it is still open.

---

## B. What the factory actually did unattended

### B1 — Every PR created since 2026-08-19

Exactly **three**, all on the first night, none since:

| PR | State | Created | Merged | Branch | Closes |
|----|-------|---------|--------|--------|--------|
| #98 | OPEN | 2026-08-19T22:15:05Z | — | `task/94` | #94 |
| #99 | OPEN | 2026-08-19T22:21:40Z | — | `task/95` | #95 |
| #100 | OPEN | 2026-08-19T22:30:54Z | — | `task/96` | #96 |

Also open from before the gap: #91 (`task/72`→#72), #92 (`task/71`→#71), #93 (`task/70`→#70),
#97 (`ci/node-coverage`, closes nothing).

**Nothing was created after 2026-08-19T22:30:54Z** — a 9-day, 8-hour silence across 86 dispatch runs.

### B2 — DUPLICATES: **ZERO**

Grouping all open PRs by the issue they close:

```
#72 → #91          (1 PR)
#71 → #92          (1 PR)
#70 → #93          (1 PR)
#94 → #98          (1 PR)
#95 → #99          (1 PR)
#96 → #100         (1 PR)
#97 → closes nothing
```

**No issue has more than one PR. The duplicate-dispatch event we feared did not occur.**

It was prevented by accident, not by design. `dispatch.sh` genuinely has no "an open PR already
closes this issue" check — it tried to create a duplicate **255 times**, and GitHub refused every
one:

```
[2026-08-29T02:04:56Z] WARN: #94 gh pr create failed: a pull request for branch "task/94" into
                             branch "master" already exists:
                             https://github.com/tejaspatil1936/scalar-commons-v4/pull/98
[2026-08-29T02:05:02Z] WARN: #95 gh pr create failed: ... pull/99
[2026-08-29T02:05:29Z] WARN: #96 gh pr create failed: ... pull/100
$ awk '/^\[2026-08-(19|2[0-9])/ && /gh pr create failed/' factory/logs/dispatch.systemd.log | wc -l
255
```

`gh`'s branch+base uniqueness constraint is the only thing standing between this dispatcher and a
hundred duplicate PRs. **The moment a worker produces a new branch name for an already-covered
issue, that protection evaporates.** The missing guard is still worth adding.

### B3 — What merged to master: **NOTHING**

```
$ git log --oneline --since=2026-08-19 origin/master
(no output)

$ git log -5 --format="%h %ad %s" --date=iso origin/master
79aac43 2026-08-07 07:20:08 +0530 factory: harden review.sh — enforce stdin delivery ... (#90)
d3aebf1 2026-08-05 23:40:07 +0530 factory: fix review.sh failing every lens on large diffs (#86)
660c840 2026-08-05 08:29:44 +0530 [factory] Docs: developer + user documentation (#73) (#85)

$ gh pr list --state merged --json number,mergedAt -q '.[] | select(.mergedAt > "2026-08-19")'
(no output)
```

Master's tip is **22 days old**. Zero merges in the gap — autonomous or manual. `merge.sh` never
ran (no `factory/logs/merge.systemd.log` exists, no "merge" string anywhere in the dispatch log).

### B4 — Spend: 275 ledger lines, but only **17 real model spawns**

`DAILY_SPAWN_CAP = 40` (`factory/config.env:94`). The cap was **never hit** and never blocked anything.

| File | Total | `dispatch:` (no-op) | `loop:` | `review:` |
|------|-------|--------------------|---------|-----------|
| spend-20260819 | 18 | 6 | 3 | 9 |
| spend-20260820 | 28 | 27 | 1 | 0 |
| spend-20260821 | 27 | 27 | 0 | 0 |
| spend-20260822 | 28 | 27 | 1 | 0 |
| spend-20260823 | 27 | 27 | 0 | 0 |
| spend-20260824 | 28 | 27 | 1 | 0 |
| spend-20260825 | 27 | 27 | 0 | 0 |
| spend-20260826 | 28 | 27 | 1 | 0 |
| spend-20260827 | 27 | 27 | 0 | 0 |
| spend-20260828 | 28 | 27 | 1 | 0 |
| spend-20260829 (partial) | 9 | 9 | 0 | 0 |
| **TOTAL** | **275** | **258** | **8** | **9** |

**258 of 275 ledger entries (94%) are accounting fiction** — `dispatch:issue-N` is written when a
worker slot is *claimed*, before the loop discovers there is nothing to do. Actual model
invocations across the whole week:

```
2026-08-19T22:04:50Z  loop:issue-95:attempt1     ← the only real work: the 3 PRs
2026-08-19T22:04:50Z  loop:issue-94:attempt1
2026-08-19T22:04:50Z  loop:issue-96:attempt1
2026-08-19T22:15:07Z  review:pr-98:lens-correctness / lens-conformance / lens-standing
2026-08-19T22:21:43Z  review:pr-99:lens-correctness / lens-conformance / lens-standing
2026-08-19T22:30:56Z  review:pr-100:lens-correctness / lens-conformance / lens-standing
2026-08-20T03:05:07Z  loop:issue-96:attempt1     ← every ~48h thereafter: the escrow-slot drain
2026-08-22T03:05:07Z  loop:issue-96:attempt1
2026-08-24T04:05:01Z  loop:issue-96:attempt1
2026-08-26T04:05:01Z  loop:issue-96:attempt1
2026-08-28T04:05:07Z  loop:issue-96:attempt1
```

So the real spend was **12 spawns on night one** (which produced everything) plus **5 spawns**
across the rest of the week, all on issue-96, all doing the same thing: draining leaked devnet
escrow slots so the indexer gate could pass. Model spend was **not** the waste — the waste was
**86 × ~40s of CPU and ~1.7 GB peak RSS per run**, and the *budget headroom* consumed by 258
phantom ledger lines (27/40 of the daily cap each day was pure bookkeeping).

### B5 — Dispatch history: 86 fires, 258 worker slots, 250 immediate no-ops

```
$ journalctl --user -u factory-dispatch.service --since "2026-08-19" | grep -c "Starting factory-dispatch"
86
$ awk '/^\[2026-08-(19|2[0-9])/ && /dispatch pass complete/' factory/logs/dispatch.systemd.log | wc -l
86
$ awk '/^\[2026-08-(19|2[0-9])/ && /gate already passes/'    factory/logs/dispatch.systemd.log | wc -l
250
```

The arithmetic closes exactly: 86 passes × 3 workers = 258 slots; 250 exited instantly on
"gate already passes"; 8 spawned an agent (= the 8 `loop:` ledger lines). Every pass ended
identically:

```
[2026-08-29T02:05:30Z] dispatch pass complete: 3 worker(s), 0 did not pass their gate
```

The per-worker loop, repeated ~250 times:

```
[2026-08-29T02:04:49Z] === loop "issue-94" starting ===
[2026-08-29T02:04:49Z] workdir=/home/dev/wt-94 promptfile=/home/dev/wt-94/.factory-prompt.md
[2026-08-29T02:04:49Z] gate=cd sdk && npm ci && npm run typecheck && npm test
[2026-08-29T02:04:49Z] billing: ANTHROPIC_API_KEY loaded (…PbewAA); API billing enforced.
[2026-08-29T02:04:54Z] gate already passes before any attempt — nothing to do. PASS
[2026-08-29T02:04:54Z] #94 gate PASSED — pushing task/94
Everything up-to-date
[2026-08-29T02:04:56Z] WARN: #94 gh pr create failed: ... already exists: .../pull/98
```

**Failures / rate limits / API-credit errors: NONE.** Scanning for
`rate.?limit|429|credit|quota|insufficient|403|401|500` returns only the benign
`billing: ANTHROPIC_API_KEY loaded` lines and the 255 `gh pr create failed` warnings. No spawn-cap
stop, no `BLOCK_REASON`, no throttling. The system was healthy — it just had nothing to do and no
way to notice.

One genuine recurring finding, from `issue-96-attempt1.agent.log` (2026-08-28 04:08), matching the
known devnet slot leak:

> The gate was failing, but not on code. It was the devnet slot leak: `live.test.ts` seeds an
> escrow agreement in `beforeAll` and never releases it, so both of `//Alice`'s provider pairs had
> refilled to 10/10 `MaxAgreementsPerPair`. ... I drained 18 leaked agreements ... **The leak is
> unfixed and will recur in roughly 20 gate runs.** ... It deserves its own issue.

That prediction is confirmed by the data: issue-96 needed a drain on 08-20, 08-22, 08-24, 08-26,
08-28 — a clean 48-hour cycle. **This leak has no issue filed against it.**

### B6 — New BLOCKED reports: **NONE**

```
$ find factory/blocked -name "BLOCKED-*.md" -newermt "2026-08-19"
(no output)
$ ls factory/blocked/
BLOCKED-trackB-sdk.md   (3962 bytes, Aug 2 23:37 — pre-dates the gap)
```

Pre-existing file's reason line, for completeness: `- **reason**: attempt cap reached (10 attempts)`.
Nothing new was blocked, because nothing new was attempted.

### B7 — CI: one failure, and it is the expected one

```
skipped  claude-swarm  master            issue_comment  2026-08-19T22:31:02Z
skipped  claude-swarm  master            issue_comment  2026-08-19T22:31:00Z
success  ci-fast       task/96           pull_request   2026-08-19T22:30:56Z
success  ci-full       task/96           pull_request   2026-08-19T22:30:56Z
success  ci-fast       task/95           pull_request   2026-08-19T22:21:42Z
success  ci-full       task/95           pull_request   2026-08-19T22:21:42Z
success  ci-fast       task/94           pull_request   2026-08-19T22:15:08Z
success  ci-full       task/94           pull_request   2026-08-19T22:15:08Z
success  ci-fast       ci/node-coverage  pull_request   2026-08-19T19:53:28Z
failure  ci-node       ci/node-coverage  pull_request   2026-08-19T19:53:28Z   ← only failure
success  ci-full       ci/node-coverage  pull_request   2026-08-19T19:53:28Z
```

The `skipped` runs are `claude-swarm` on `issue_comment` — normal gating, not failures. **No CI
run has been triggered since 2026-08-19T22:31** because no branch received a new commit
("Everything up-to-date" on all 255 pushes).

The single `ci-node` failure is the `sdk` job, and it fails for precisely the reason CI-NODE.md
documented:

```
sdk  npm ci  npm error code EUSAGE
sdk  npm ci  npm error The `npm ci` command can only install with an existing package-lock.json or
sdk  npm ci  npm error npm-shrinkwrap.json with lockfileVersion >= 1.
sdk  npm ci  ##[error]Process completed with exit code 1.
```

Confirmed by inspection:

```
origin/master   sdk/package-lock.json  ABSENT
origin/task/72  sdk/package-lock.json  PRESENT (94067 bytes)
origin/task/94  sdk/package-lock.json  PRESENT (94067 bytes)
```

**The `sdk` gate cannot go green until an SDK PR merges.** #97 and #91/#98 are mutually blocking in
ordering terms: #97's sdk job stays red until the lockfile lands on master.

---

## C. Open PR set (7 PRs)

| PR | Branch → base | Δ | Mergeable | CI | Labels |
|----|---------------|-----|-----------|-----|--------|
| #91 | `task/72` → master | +3148 / −41 (5 files) | MERGEABLE / CLEAN | gate ✅ full ✅ | `agent-reviewed`, `needs-human` |
| #92 | `task/71` → master | +5077 / −0 (18 files) | MERGEABLE / CLEAN | gate ✅ full ✅ | `needs-human` |
| #93 | `task/70` → master | +5626 / −0 (21 files) | MERGEABLE / CLEAN | gate ✅ full ✅ | `agent-reviewed`, `needs-human` |
| #97 | `ci/node-coverage` → master | +772 / −0 (2 files) | MERGEABLE / **UNSTABLE** | gate ✅ full ✅ landing ✅ faucet ✅ docs ✅ changes ✅ **sdk ❌** | none |
| #98 | `task/94` → master | +3171 / −42 (6 files) | MERGEABLE / CLEAN | gate ✅ full ✅ | `needs-human` |
| #99 | `task/95` → master | +5164 / −0 (22 files) | MERGEABLE / CLEAN | gate ✅ full ✅ | `needs-human` |
| #100 | `task/96` → master | +6501 / −0 (23 files) | MERGEABLE / CLEAN | gate ✅ full ✅ | `needs-human` |

One line each:

- **#91** — SDK `recordGovVote` + spec-304 read-method fixes; **superseded by #98**, which is #91 plus the review fixes.
- **#92** — Explorer block/extrinsic/account UI; **superseded by #99**.
- **#93** — Indexer 24-endpoint REST API; **superseded by #100**.
- **#97** — adds `ci-node.yml` (landing/faucet/docs/sdk gates); blocked only by its own `sdk` job, which cannot pass until a `sdk/package-lock.json` reaches master.
- **#98** — #91 + one commit addressing the adversarial review; blocked on human review only (`needs-human`, all checks green).
- **#99** — #92 + explorer review fixes; blocked on human review only.
- **#100** — #93 + indexer review fixes; blocked on human review only.

**No PR carries `agent-reviewed` among the new set** — #98/#99/#100 have `needs-human` only, even
though the three-lens review ran on all of them on 08-19 (9 `review:` spend entries). Every open PR
is waiting on exactly one thing: **a human deciding to merge.**

### Special check — PR #98 (task/94)

**Base branch: `master`.** (Not `task/72` — it is a standalone PR against master.)

Ancestry — #98 is a strict superset of #91:

```
$ git merge-base --is-ancestor origin/task/72 origin/task/94
YES: task/94 contains all of task/72

$ git log --oneline origin/task/72..origin/task/94
14501e3 sdk: address adversarial review of #91 — scope revert + verified claims

$ git log --oneline origin/task/94..origin/task/72
(empty — task/72 has nothing task/94 lacks)
```

**Does it remove or alter `txEntry`/`queryEntry`/`constEntry`? NO.** All three helpers are intact,
and are used *more* on `task/94` than on `task/72`:

```
$ git show 14501e3 | grep -E "^[+-].*(txEntry|queryEntry|constEntry)"
+ * {@link queryEntry}/{@link constEntry}) because polkadot-js types `api.tx`,
```
That is the only line — an added doc-comment reference. No helper line is removed or modified.

```
origin/task/72:sdk/src/index.ts:140: function txEntry(...)     usage: txEntry=12 queryEntry=14 constEntry=2
origin/task/94:sdk/src/index.ts:139: function txEntry(...)     usage: txEntry=12 queryEntry=15 constEntry=3
```

**Does it touch `sdk/package-lock.json`? NO.**

```
$ git show --name-only 14501e3 | grep -i package-lock
NO — package-lock.json NOT touched by the delta commit
```

The lockfile is present in #98's file list only because it is inherited unchanged from `task/72`
— identical bytes (94067) on both branches. The 08-19 correction comment was respected exactly.

What the delta commit *does* change (from its own message): reverts `live.test.ts` behind the
pre-existing `RUN_INTEGRATION=1` opt-in (finding 3.4); removes the unrequested and
incorrectly-documented `NetPosition.spendable` field (findings 3.6 & 4); and converts the
self-only-vote rule from asserted to verified via an `agents.Unauthorized` test (finding 5).

> ### Verdict: **#98 HELPS #91 — it does not conflict with it.**
>
> #98 = #91 + one review-fix commit. It preserves the load-bearing `txEntry`/`queryEntry`/`constEntry`
> refactor (all 47 typecheck errors stay cleared) and carries the same `sdk/package-lock.json` that
> master lacks, so merging #98 **unblocks the `sdk` gate in #97** exactly as merging #91 would.
> #98 strictly dominates #91. Merge #98; close #91 as superseded. Merging both is redundant and
> merging #91 *after* #98 would be a regression.

The same relationship should be assumed but is **not yet verified** for #99 vs #92 and #100 vs #93
— confirm ancestry before closing those.

---

## D. Chain and devnet health — ✅ ALIVE, producing and finalizing

All 5 validators running, 25 days uptime, 4 peers each:

```
    PID     ELAPSED    NODE
 701914 25-08:54:54    scalar-alice   :9944
 701915 25-08:54:54    scalar-bob     :9945
 706903 25-08:49:44    scalar-charlie :9946
 706904 25-08:49:44    scalar-dave    :9947
 701918 25-08:54:54    scalar-eve     :9948

:9944 {"peers":4,"isSyncing":false,"shouldHavePeers":false}
:9945 {"peers":4,"isSyncing":false,"shouldHavePeers":true}
:9946 {"peers":4,"isSyncing":false,"shouldHavePeers":true}
:9947 {"peers":4,"isSyncing":false,"shouldHavePeers":true}
:9948 {"peers":4,"isSyncing":false,"shouldHavePeers":true}
```

Two samples ~16s apart prove motion in **both** best and finalized:

```
=== SAMPLE 1  2026-08-29T02:13:45Z ===
system_health: {"peers":4,"isSyncing":false,"shouldHavePeers":false}
best  hex=0x592f6 dec=365302
final hex=0x592f4 dec=365300
lag = 2

=== SAMPLE 2  2026-08-29T02:14:01Z ===
system_health: {"peers":4,"isSyncing":false,"shouldHavePeers":false}
best  hex=0x592f9 dec=365305
final hex=0x592f7 dec=365303
lag = 2

=== MOTION ===
best:  365302 -> 365305  (+3 blocks)
final: 365300 -> 365303  (+3 blocks)
```

Chain identity: `Scalar Commons Node` / `Scalar Commons Local Testnet`. **Finality is tracking
production at a constant 2-block lag — not stalled.**

Disk:

```
/dev/vda4  2.0T  109G  1.8T  6%  /
```

1.8 TB free. No pressure.

---

## E. Straight answer

### (a) Planned steps: done vs not done

| # | Planned step | Status |
|---|--------------|--------|
| A1 | Remove `ready` from #70/#71/#72 | ✅ DONE |
| A4 | Post correction comment on #94 | ✅ DONE |
| A2 | Remove `ready` from #94/#95/#96 | ❌ NOT DONE |
| A5 | Merge PR #97 | ❌ NOT DONE |
| A6 | `ci-node.yml` on master | ❌ NOT DONE |
| A7 | Add landing/faucet/docs/sdk to branch protection | ❌ NOT DONE |
| A8 | Create factory-merge.service + .timer | ❌ NOT DONE |
| A9 | Create factory-digest.service.d drop-in | ❌ NOT DONE |
| A10 | `--rpc-methods safe` on bob/charlie/dave/eve | ❌ NOT DONE |

**Two of nine done.** Both completed items were GitHub-side actions taken on 2026-08-19 itself,
before the gap began. Every item requiring a local change — systemd units, validator flags, a merge
— is untouched. The 08-19 session ended after the label cleanup and the correction comment, and
nothing resumed it.

### (b) What the unattended week produced

**Net progress: zero. Net waste: modest in dollars, total in opportunity.** The three PRs that
matter (#98/#99/#100) were all created on the first night, 2026-08-19, within 26 minutes — before
the gap really started. Across the following nine nights the dispatcher fired 86 times, claimed 258
worker slots, and produced no commit, no PR, and no merge. 250 of those slots exited within five
seconds on "gate already passes before any attempt — nothing to do," then pushed an unchanged
branch and were refused by `gh pr create` 255 times. Real model spend was only 17 spawns for the
whole week — 12 on night one doing the actual work, and 5 more that were all the same recurring
chore: draining leaked devnet escrow slots on a 48-hour cycle so the indexer gate would pass. The
`DAILY_SPAWN_CAP` of 40 was never approached, though 258 of 275 ledger entries were phantom
`dispatch:` lines, so ~27 of each day's 40-spawn budget was consumed by bookkeeping for work that
never happened. The feared duplicate-PR storm **did not occur** — but only because GitHub rejects a
second PR for the same branch+base pair; `dispatch.sh` still has no such guard of its own and tried
255 times. Meanwhile #87 and #88 — real, undone work — were never once picked up, because
`MAX_PARALLEL=3` was permanently saturated by three finished issues. Cost of the week: roughly
57 CPU-minutes, ~1.7 GB peak RSS per run, five spawns of escrow-draining, and nine days of
zero throughput on a queue that had work in it. The chain, at least, ran flawlessly throughout.

### (c) The correct next 3 actions, in order

**1 — Stop the treadmill, then merge the SDK PR that unblocks CI.** Remove `ready` from **#94, #95,
#96** (this single action ends the 86-runs-per-week no-op loop and frees all three worker slots for
#87 and #88 tonight). Then merge **#98** and close **#91** as superseded — #98 is #91 plus the
review fixes, keeps the `txEntry`/`queryEntry`/`constEntry` refactor intact, and carries the
`sdk/package-lock.json` that master lacks.

**2 — Land CI, then wire the gates.** With the lockfile on master from step 1, re-run **#97**'s
`ci-node` workflow: the `sdk` job's `npm ci` EUSAGE failure disappears and all five jobs go green.
Merge **#97**, then — and only then — add `landing`, `faucet`, `docs`, `sdk` to
`branches/master/protection/required_status_checks` (currently `["gate","full"]`). Adding them
before #97 is on master would wedge every PR behind contexts no workflow produces.

**3 — Clear the remaining PR backlog and file the leak.** Verify that **#99** supersedes **#92** and
**#100** supersedes **#93** by the same ancestry check that proved it for #98/#91
(`git merge-base --is-ancestor`), then merge #99 and #100 and close #92/#93. Separately, **file the
issue nobody filed**: `live.test.ts` seeds an escrow agreement in `beforeAll` and never releases it,
exhausting `MaxAgreementsPerPair` every ~20 gate runs — the fix is an `afterAll` release, and until
it lands the indexer gate keeps burning a spawn every 48 hours. Issues **#87** and **#88** (the
latter being the documented form of the A10 RPC gap) then finally reach the dispatcher.

---

*Read-only audit. No file other than this one was created; nothing was modified, committed, pushed,
merged, dispatched, labelled, or fixed.*
