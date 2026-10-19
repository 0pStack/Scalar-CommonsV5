# STAGE 1 HARDENING — F-1, F-2, F-4

**Date:** 2026-08-03 · **Branch:** `fix/stage1-hardening` · **PR:** [#82](https://github.com/tejaspatil1936/scalar-commons-v4/pull/82)

Factory + `.github` only. **No chain, runtime, or pallet code was touched.**
`ENABLE_DISPATCH=false` and `ENABLE_MERGE=false` — both left exactly as they were.

---

## F-1 (blocking) — gate derived from the issue body

### The defect

`gate_for_tier()` called `detect_gate "$wt"`, which infers a gate from the files a diff
touches. At dispatch time the worktree is a pristine copy of `master`, so the diff is
**empty**, so `sub` is empty and every issue fell through to `t2_gate`:

```
flock ~/.factory/cargo.lock bash -c 'cargo check --workspace && cargo test --workspace --no-run'
```

That gate is already green on master. `loop.sh` runs the gate once before the first
attempt and exits on success — `gate already passes before any attempt — nothing to do.
PASS`. Every T3 issue would have been closed as done with zero work performed.

### The fix

`dispatch.sh` gained `gate_from_issue()`: it finds a `## Gate` heading, takes the first
fenced code block under it, joins multi-line blocks with ` && `, and **rejects prose** —
the first token must be a real command (`cd`, `npm`, `cargo`, `python3`, `./…`, …).

`gate_for_tier()` now takes the issue number and prefers the issue's gate. `detect_gate`
remains the fallback for issues predating the convention, with one hard guard: if a
`tier:T3` issue has no GATE block **and** `detect_gate` falls through to the workspace
cargo gate, dispatch **refuses** rather than running an already-green gate.

### Evidence — `./factory/dispatch.sh --dry-run`

```
DISPATCH #75  tier:T3   Faucet: testnet token faucet
        WOULD: gate = cd faucet && npm ci --no-audit --no-fund && npm test
        WOULD: gate source = issue body (## Gate block)
DISPATCH #74  tier:T3   Landing page: public site
        WOULD: gate = cd landing && npm ci --no-audit --no-fund && npm run build
        WOULD: gate source = issue body (## Gate block)
DISPATCH #73  tier:T3   Docs: developer + user documentation
        WOULD: gate = cd docs && npm ci --no-audit --no-fund && npm run lint && npm run build
        WOULD: gate source = issue body (## Gate block)
DISPATCH #72  tier:T3   SDK: add recordGovVote(pollIndex, signer) + fix read methods on spec 304
        WOULD: gate = cd sdk && npm ci && npm run typecheck && npm test
        WOULD: gate source = issue body (## Gate block)
DISPATCH #71  tier:T3   Explorer: block / extrinsic / account UI
        WOULD: gate = cd explorer && npm ci && npm run build && npm test
        WOULD: gate source = issue body (## Gate block)
DISPATCH #70  tier:T3   Indexer: implement the REST API (24 endpoints)
        WOULD: gate = cd indexer && npm ci && npm test
        WOULD: gate source = issue body (## Gate block)
```

All six now carry their own subproject command. **Zero** resolve to the cargo workspace gate.

### Three issue bodies had to be corrected

The parser rejected #73, #74 and #75 (exit 2 — prose, not a command):

```
#70 rc=0 gate=cd indexer && npm ci && npm test
#71 rc=0 gate=cd explorer && npm ci && npm run build && npm test
#72 rc=0 gate=cd sdk && npm ci && npm run typecheck && npm test
#73 rc=2 gate=<NONE>          <- "docs build / lint passes"
#74 rc=2 gate=<NONE>          <- "the site builds (npm ci && npm run build in ...)"
#75 rc=2 gate=<NONE>          <- "the faucet test suite passes (...)"
```

Those were my own prose gates from the Stage-1 setup round. Their bodies were rewritten
with runnable commands (and a note that creating the missing `package.json` is part of the
work, so a red gate is the correct starting state). The parser catching them is the
mechanism working: an unrunnable gate would fail bash for the wrong reason and burn every
attempt on a sentence.

### Evidence — refusal path (fixture T3 issue with no `## Gate` block)

```
DISPATCH #999 tier:T3   T3 task with no GATE block
        WOULD: create worktree ../wt-999 from origin/master
        WOULD: add label in-progress to #999
        WOULD: REFUSE — no usable gate in the issue body, and the
               detect_gate fallback is the already-green workspace gate
```

In the non-dry path this also comments on the issue explaining what is missing.

---

## F-2 — daily spawn budget

Per-token cost is not observable from a headless `claude -p` call, so the factory bounds
what it *can* count: agent spawns per UTC day.

- Ledger: `~/.factory/spend-YYYYMMDD`, one line per spawn (`timestamp<TAB>label`).
  The ledger **is** the counter, so it doubles as an audit trail of what started and when.
- The date is in the **filename**, so the budget resets at 00:00 UTC with no cron, no
  cleanup job, and no clock arithmetic that could go wrong.
- Check-and-append happen together under one `flock`, so two workers racing at the cap
  boundary cannot both be told yes. Reservation happens **before** the spawn — a crash
  between spawn and record would under-count, and an under-counting budget is not a budget.
- New keys in `config.env`: `DAILY_SPAWN_CAP` (default **40**) and `SPEND_DIR`.

### Three reservation points

| Component | Charges | Why |
|---|---|---|
| `dispatch.sh` | 1 per dispatched worker | the loop itself |
| `lib/loop.sh` | 1 per attempt | **each attempt is its own `claude -p`** |
| `review.sh` | 1 per lens | a review is 3 spawns, not 1 |

Charging per *attempt* is what makes the cap real. Counting only dispatches would let 40
workers × 10 attempts = 400 agent calls through a cap of "40".

`review.sh` treats a capped-out lens as **FAIL**, so a PR can never be labelled
`agent-reviewed` on an incomplete review.

### Rough dollar mapping (estimate, not a measurement)

| Spawn kind | Rough cost |
|---|---|
| worker attempt (long context, many tool calls, up to 240 min) | ~$0.50 – $2.00 |
| review lens (one diff + one issue body, no tools) | ~$0.10 – $0.40 |

At a blended **~$0.75/spawn, a cap of 40 ≈ $30/day**, ~$900 if a runaway ran unnoticed for
a month. These are order-of-magnitude figures and should be re-derived from the Console
once real runs exist. **This is not a billing control** — the Console monthly cap remains
the hard backstop. This exists so a runaway is stopped in minutes by the machine that
started it, rather than in days by a billing alert.

Note the cap is deliberately tight relative to the work queued: 6 dispatches + up to 10
attempts each = 60 potential spawns, so 40 bites partway through the first full pass. For a
first stage the thing you want to learn is whether the loops work at all, not how much they
can spend unattended.

### Evidence — cap enforced at the boundary

```
cap=3 ledger=.../spend-20260803
spawn 1: RESERVED  (count=1 remaining=2)
spawn 2: RESERVED  (count=2 remaining=1)
spawn 3: RESERVED  (count=3 remaining=0)
spawn 4: REFUSED   (rc=3)
    DAILY SPAWN CAP REACHED: 3 of 3 spawns used today (.../spend-20260803).
    Refusing to start "test spawn 4". The budget resets at 00:00 UTC.
    To raise it deliberately: edit DAILY_SPAWN_CAP in factory/config.env.
spawn 5: REFUSED   (rc=3)
--- ledger contents ---
2026-08-03T19:45:44Z	test:spawn1
2026-08-03T19:45:44Z	test:spawn2
2026-08-03T19:45:44Z	test:spawn3
```

### Evidence — date rollover resets

```
yesterday lines: 50          # spend-20260802 well past the cap
today count:     0  remaining: 40
reserve after rollover: OK
```

### Evidence — concurrency safe (20 racing reservations, cap 5)

```
granted: 5  ledger lines: 5  cap: 5
```

### Evidence — visible in the dispatcher header

```
free disk:   1873GB (min 30GB)
spawn budget: 0/40 used today (40 remaining) — /home/dev/.factory/spend-20260803
```

---

## F-4 — unreviewed write paths removed

### Deleted

| Workflow | What it did |
|---|---|
| `auto-merge-claude.yml` | `gh pr merge --auto --squash` on any `claude/*` PR — **no review of any kind** |
| `continuous-watch.yml` | daily cron; commented `@claude Please implement this issue…` on every open `agent-task` issue without a branch |
| `pr-ci-feedback.yml` | on every red `ci-fast` run, commented `@claude ci-fast failed… please fix` |

Those three formed a **self-sustaining spawn loop**: watch re-triggers the agent → agent
opens a PR → CI fails → feedback re-triggers the agent → auto-merge merges whatever goes
green. That is the Phase-0 burn.

### Also removed — same defect class

Deleting only the three above would have left me unable to truthfully confirm the second
half of the requirement ("no remaining workflow re-triggers agents on issues/PRs without an
`@claude` mention"), because two workflows still spawned agents off a **label**:

- **`claude-opus.yml` — deleted.** Its only trigger was `issues: [labeled]` +
  `agent-task` + `complex-task`. It had no `@claude` path at all, so there was nothing to
  preserve.
- **`claude.yml` — `issues: [opened, labeled]` trigger and its `if` clause removed.** It
  started an agent with `contents: write` the moment an issue carried `agent-task`, with no
  human in the loop and no accounting. The workflow is now **mention-only**.

Flagging this as a scope expansion beyond the three files named in the request. It is a
strict removal of capability, and the confirmation clause could not be satisfied without it.

### Evidence — nothing merges

```
$ grep -rn "pr merge|merge --auto|--auto|automerge|enablePullRequestAutoMerge" .github/workflows/
NONE — no workflow merges anything
```

### Evidence — the one agent-spawning workflow is mention-only

```
--- .github/workflows/ci-fast.yml   (no agent): triggers = pull_request workflow_dispatch
--- .github/workflows/ci-full.yml   (no agent): triggers = push pull_request workflow_dispatch
--- .github/workflows/claude.yml    (SPAWNS AGENT)
    on:
      issue_comment:              types: [created]
      pull_request_review_comment: types: [created]
      pull_request_review:        types: [submitted]
    if-condition:
      (github.event_name == 'issue_comment' && contains(github.event.comment.body, '@claude')) ||
      (github.event_name == 'pull_request_review_comment' && contains(github.event.comment.body, '@claude')) ||
      (github.event_name == 'pull_request_review' && contains(github.event.review.body, '@claude'))
--- .github/workflows/file-issues.yml (no agent): triggers = workflow_dispatch
```

Every surviving trigger requires a literal `@claude` written by a human. No `issues`
trigger spawns anything. No `schedule` trigger remains.

---

## Verification summary

| Check | Result |
|---|---|
| `factory/tests/selftest.sh` | **32 passed, 0 failed** |
| `bash -n` on dispatch.sh, common.sh, loop.sh, review.sh | clean |
| All 6 T3 gates resolve from issue body | confirmed by `--dry-run` |
| T3 with no GATE block | refuses instead of using the green gate |
| Spawn cap at boundary / rollover / 20-way race | enforced, resets, 5-of-20 granted |
| Workflows that merge to master | none |
| Workflows that spawn agents without `@claude` | none |
| `ENABLE_DISPATCH` / `ENABLE_MERGE` | still `false` / `false` — untouched |

The selftest harness is hermetic (its own `HOME`/`SPEND_DIR`), so running it did not
consume any real budget — the live ledger was never created.

---

## Still open — not fixed this round

**F-3 was already fixed** in the Stage-1 setup round (the `reject-stubs` PostToolUse hook
is wired and verified blocking).

**`file-issues.yml` is dead and hazardous.** It is `workflow_dispatch`-only, so it cannot
fire on its own and does **not** violate the F-4 confirmation. But it hardcodes
`R="matty33/scalar-commons-v4"` — a different repo — and re-files the entire stale backlog
that was just closed. One accidental click re-creates 33 issues in someone else's project.
Left in place because it needs a deliberate human action; recommend:

```
git rm .github/workflows/file-issues.yml
```

**The `agent-task` / `complex-task` labels are now inert.** Nothing reads them since
`claude-opus.yml` is gone and `claude.yml` no longer triggers on `issues`. Harmless, but
they are a trap for anyone who assumes labelling still does something. Consider deleting.

**`required_approving_review_count: 0`** on master (F-6 from the setup round) stands. It is
coherent with the design — `merge.sh` enforces the 3-lens review — but anything bypassing
`merge.sh` reaches master unreviewed. With F-4 done, no such bypass currently exists.

---

## Enabling Stage 1 (unchanged, still not run)

F-1 was the blocker on this command; it is now fixed. Merge PR #82 first, then:

```
sed -i 's/^ENABLE_DISPATCH=.*/ENABLE_DISPATCH="${ENABLE_DISPATCH:-true}"/' factory/config.env
```

Auto-merge remains a separate second switch and is still off:

```
sed -i 's/^ENABLE_MERGE=.*/ENABLE_MERGE="${ENABLE_MERGE:-true}"/' factory/config.env
```

Stop everything: `touch /home/dev/STOP_FACTORY`
