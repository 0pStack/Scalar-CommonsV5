# The Factory — 24/7 bounded-autonomy harness

Runs agent loops on this server around the clock, inside hard bounds, with
mechanical enforcement of one rule:

> **Never make a check pass by weakening code.**

The factory's whole design follows from taking that rule seriously. An agent
cannot be trusted to grade its own work, so it doesn't: **a gate command decides
success, and the agent never sees a success path that avoids it.** A loop whose
gate is red has failed no matter how confident its transcript sounds.

---

## Table of contents

- [Stop everything NOW](#stop-everything-now)
- [Setup (one time)](#setup-one-time)
- [The three stages](#the-three-stages)
- [How to add a task](#how-to-add-a-task)
- [Reading the morning digest](#reading-the-morning-digest)
- [Components](#components)
- [Enforcement: the hook](#enforcement-the-hook)
- [Labels](#labels)
- [Bounds and guards](#bounds-and-guards)
- [Billing](#billing)
- [Testing the factory itself](#testing-the-factory-itself)
- [Troubleshooting](#troubleshooting)

---

## Stop everything NOW

```bash
touch ~/STOP_FACTORY
```

That is the whole kill switch. Every component checks for that file before doing
any work, and loops re-check it between attempts. Within 30 minutes the watchdog
also SIGTERMs (then SIGKILLs) every running loop and orphaned agent process.

To kill running loops immediately rather than waiting for the timer:

```bash
touch ~/STOP_FACTORY && ./factory/watchdog.sh
```

To resume: `rm ~/STOP_FACTORY`.

---

## Setup (one time)

### 1. Put the API key in place

Loops **must** bill the API key, never your interactive Max subscription.

```bash
mkdir -p ~/.factory
printf 'export ANTHROPIC_API_KEY=sk-ant-api03-YOUR-KEY-HERE\n' > ~/.factory/env
chmod 600 ~/.factory/env
```

This file is outside the repo and is never committed. `loop.sh` fails closed: no
key means the loop refuses to start, so a misconfiguration can't silently drain
the subscription. See [Billing](#billing).

### 2. Enable lingering — **requires root, and is not optional for 24/7**

```bash
sudo loginctl enable-linger dev
```

Without lingering, systemd tears down your user manager when you log out and
**every factory timer dies with it**. Verify:

```bash
loginctl show-user dev | grep Linger    # want: Linger=yes
```

> This command was attempted during the build and returned `Access denied`
> (unprivileged) — `sudo` on this host requires a password, so **you must run it
> yourself**. Until then the timers only survive while a session is open.

### 3. Install the systemd user timers

```bash
./factory/install-systemd.sh              # watchdog + nightly digest
./factory/install-systemd.sh --dry-run    # preview
```

Installs **user** units (no root) into `~/.config/systemd/user/`:

| Unit | Schedule | Purpose |
|---|---|---|
| `factory-watchdog.timer` | every 30 min, +5 min after boot | caps, kill switch, disk + rate guards |
| `factory-digest.timer` | 05:30 UTC daily | gist `STATE.md` + new BLOCKED reports |

The Stage-2 dispatcher timer is **not** installed by default; add it with
`--with-dispatch` (it still needs `ENABLE_DISPATCH=true` to act).

Check them:

```bash
systemctl --user list-timers "factory-*"
journalctl --user -u factory-watchdog.service -n 50
```

### 4. Verify the harness works

```bash
./factory/tests/selftest.sh        # bounds: caps, stuck-stop, kill switch, billing
./factory/tests/gate-detect.sh     # per-tier gate selection
./factory/tests/verdict-parse.sh   # reviewer fails closed
```

---

## The three stages

Autonomy is turned up one notch at a time, and each notch has a precondition
that has to be *true*, not merely hoped for.

### Stage 0 — named loops only (start here)

Four defined tasks, no dispatcher, no auto-merge, no autonomous triage. Work
lands as commits in isolated worktrees for you to inspect.

```bash
./factory/run-stage0.sh --dry-run   # see exactly what would start
./factory/run-stage0.sh             # start the 4 loops in tmux session "loops"
tmux attach -t loops                # watch (ctrl-b n / ctrl-b w to navigate)
```

| Loop | Gate |
|---|---|
| `trackB-indexer` | `cd indexer && npm ci && npm test` |
| `trackB-sdk` | `cd sdk && npm ci && npm run typecheck && npm test` |
| `trackB-explorer` | `cd explorer && npm ci && npm run build && npm test` |
| `trackC-od4` | `python3 -m pytest experiments/sc-e1/tests -q` |

Each prompt requires the agent to **write its test suite first, from the spec**,
then implement. Three of these components largely don't exist yet, so the tests
are a deliverable, not an afterthought.

### Stage 1 — dispatcher on for `tier:T3`

**Preconditions:** the chain builds, CI is armed on PRs, and Stage 0 has produced
at least one clean gate pass you have reviewed by hand.

```bash
./factory/bootstrap-labels.sh                     # create the label vocabulary
# set ENABLE_DISPATCH=true in factory/config.env
./factory/install-systemd.sh --with-dispatch
```

Now labelling an issue `ready` + `tier:T3` causes work to happen. PRs are opened
and adversarially reviewed, and **a human still clicks merge**. This is a good
place to live for a long time.

### Stage 2 — merge flags on

**Precondition:** branch protection with at least one *required* status check
exists on `master`.

```bash
gh api -X PUT repos/:owner/:repo/branches/master/protection \
  --input factory/branch-protection.json     # edit the check contexts first
# then set ENABLE_MERGE=true in factory/config.env
```

`merge.sh` verifies protection itself and **refuses to merge anything at all
while it is absent**, regardless of the `MERGE_*` flags. As of this build,
`master` has no protection (the API returns 404), so merging is off.

`MERGE_T2` stays `false` even then: T2 touches broader surface than a reviewed
T3 diff, and one gate plus three reviewers is not enough for it.

---

## How to add a task

```bash
gh issue create --title "indexer: add pagination to /v1/events" \
  --body "Add limit/offset to GET /v1/events, hard cap 200/page. Tests required."
gh issue edit <n> --add-label ready --add-label tier:T3
```

That's it. At the next dispatcher pass the issue is picked up, worked in its own
worktree, gated, PR'd, and reviewed.

Write the issue body like a spec, because it becomes the prompt *and* the thing
the spec-conformance reviewer judges the diff against. State what "done" means.
A vague issue produces a vague diff and a `needs-human` label.

Group issues that touch the same code with `cluster:<name>` — cluster members
never run in parallel.

**Preview without executing anything:**

```bash
./factory/dispatch.sh --dry-run
```

---

## Reading the morning digest

At 05:30 UTC the digest timer gists `STATE.md` plus every new `BLOCKED-*.md` as a
**secret** gist and appends the URL to `factory/digests.log`.

```bash
tail -3 factory/digests.log      # last few digest URLs
./factory/tracker.sh             # regenerate + print STATE.md right now
```

`STATE.md` opens with **Health** (kill switch, back-off, disk, window, stage
flags, yesterday's merge count), then tasks touched in 24h, open factory PRs,
per-loop stats (attempts used, outcome, wall time), and the open BLOCKED reports
with the head of each authoritative gate output.

**Read order when something looks wrong:** Health → BLOCKED reports → loop stats.
Every number comes from logs, BLOCKED files, or the GitHub API. Nothing in it
comes from an agent's self-assessment.

A `BLOCKED-<name>.md` leads with the **last gate output**, labelled
authoritative, and puts the agent's summary below it marked advisory. That
ordering is deliberate: the gate says what happened, the agent says what it
believes happened, and only the first one is evidence.

---

## Components

| Path | What it does |
|---|---|
| `lib/loop.sh` | The bounded worker. Agent → gate → repeat until green or bounded out. |
| `lib/worktree.sh` | Worktree isolation + the shared cargo cache and its lock. |
| `lib/common.sh` | Config, kill switch, back-off, billing preflight, guards. |
| `dispatch.sh` | Issue-driven dispatcher (Stage 2 component; off by default). |
| `review.sh` | Three fresh-context adversarial reviewers. Never merges. |
| `merge.sh` | The only component allowed to merge. Off by default. |
| `tracker.sh` | Regenerates `STATE.md`; `--digest` gists it. |
| `watchdog.sh` | External enforcement of caps + the four guards. |
| `run-stage0.sh` | Starts the four named loops in tmux. |
| `bootstrap-labels.sh` | Creates the label vocabulary (idempotent). |
| `install-systemd.sh` | Installs the user units; handles linger. |
| `tasks/*.prompt` | The Stage-0 task definitions. |
| `tests/*.sh` | Tests for the harness itself. |

### The loop, precisely

```
loop.sh <name> <workdir> <promptfile> <gatecmd> [max_attempts] [max_minutes]
```

1. Kill switch checked **before** anything, then billing loaded (fails closed).
2. Gate run **once up front** — if the tree is already green, exit 0 having spent
   nothing. Paying an agent to discover there's no work is pure waste.
3. Per attempt: check kill switch, wall clock, attempt cap, and back-off; run the
   agent bounded by `timeout` to the *remaining* wall budget; run the gate.
4. Gate exit 0 → **exit 0 immediately**.
5. Gate red → hash the output. Byte-identical `SAME_ERROR_LIMIT` times in a row →
   BLOCKED early, because an agent that isn't responding to the feedback will
   keep not responding to it.
6. Any cap hit → write `BLOCKED-<name>.md`, exit 1.

Everything is tee'd to `factory/logs/<name>-<date>.log`.

### Review, precisely

Three separate `claude -p` processes, each with a fresh context, each given
**only** the PR diff, the linked issue body, and one lens:

1. **correctness / security** — arithmetic, supply cap, guard ordering, panics,
   permissionless paths, migrations.
2. **spec conformance** — does the diff do what the issue asked, *and nothing
   more*? Scope creep is a defect here, not a bonus.
3. **standing rules** — every deleted test, weakened assertion, stub, `#[allow]`,
   or relaxed gate, enumerated.

Reviewers run from a temp dir **outside the repo** so `CLAUDE.md` isn't
auto-discovered and no reviewer can wander the tree hunting for justifications;
the rules each one needs are in its lens prompt.

Each must end with exactly `VERDICT: PASS` or `VERDICT: FAIL`. **A missing or
unparseable verdict counts as FAIL** — fail closed. ≥2 PASS → `agent-reviewed`.
Any FAIL → `needs-human` plus a comment with the objections. Both labels can be
set at once (2 PASS + 1 FAIL); since merging requires `agent-reviewed` *and* no
`needs-human`, any FAIL blocks the merge while the audit trail survives.

`review.sh` also runs the same `load_billing_env` preflight `lib/loop.sh` runs:
every lens is a `claude -p` process, so each one goes through the same billing
guarantee the loops do — post-cutover that means no stray API key reaches the
child and the Max login is what gets billed (see **Billing** below). Before this
preflight was wired into `review.sh` at all, all six systemd-launched reviews —
18 of 18 lenses — exited 127.

**The verdict is bound to a head SHA.** `review.sh` records the exact commit it
read in its verdict comment, and `merge.sh` refuses a PR whose head has moved
since. `agent-reviewed` on its own only ever meant "a review passed"; the binding
is what makes it mean "*this diff* passed", which matters because `dispatch.sh`
re-pushes from a reused worktree every hour.

Why fresh context: the author agent has spent hours convincing itself the work is
good. Review inside that context inherits the rationalisation.

---

## Enforcement: the hook

`.claude/hooks-factory/reject-stubs.sh` is a `PostToolUse` hook on
`Edit|Write|MultiEdit`. It scans what was just written and **exits 2 to block the
write**, feeding the reason back to the agent, when it finds:

| Pattern | Why it's blocked |
|---|---|
| `todo!(` / `unimplemented!(` | compiles fine, so a build-only gate goes green over a hollow implementation |
| `#[allow(` | silences a lint instead of satisfying it |
| `SKIP_WASM_BUILD` | "builds" the runtime without producing a runtime |
| `fn main() {}` (in `node/`, `runtime/`) | the classic make-it-compile gut |

It skips `node_modules/`, `target/`, `dist/`, `build/`, `.git/`, markdown, and the
factory's own files (which necessarily *name* these patterns in order to ban
them). It fails **open** on a malformed payload, so it can never spuriously block
honest work.

It parses the hook payload with **python3, not jq** — `jq` is not installed on
this host, which is why the pre-existing `.claude/hooks/post-edit.sh` silently
no-ops.

### Wiring it in

This project's `.claude/settings.json` already has a `PostToolUse` hook. Merge,
don't replace — add a second entry to the existing array:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [
          { "type": "command", "command": "bash .claude/hooks/post-edit.sh" },
          { "type": "command", "command": "bash .claude/hooks-factory/reject-stubs.sh" }
        ]
      }
    ]
  }
}
```

The factory did **not** edit `settings.json` — only this snippet is provided, so
turning the hook on is your explicit, reversible decision. Dispatcher workers get
the same rules in their prompt preamble regardless, so the hook is defence in
depth rather than the only line.

Verify it:

```bash
printf 'fn f(){ todo!() }\n' > /tmp/t.rs
printf '{"tool_input":{"file_path":"/tmp/t.rs"}}' | bash .claude/hooks-factory/reject-stubs.sh
echo "exit=$?"   # want: 2, with an explanation
```

---

## Labels

| Label | Meaning |
|---|---|
| `ready` | Factory may pick this up. Removing it is the per-issue off switch. |
| `tier:T3` | Lowest risk. Auto-dispatch, auto-review, auto-merge eligible. |
| `tier:T2` | Auto-dispatch + review; merge stays manual (`MERGE_T2=false`). |
| `tier:T1` | **Never** dispatched autonomously. |
| `tier:T0` | **Never** dispatched autonomously. Consensus/economic core. |
| `cluster:<name>` | Cluster members run serialized, never in parallel. |
| `blocked` | Skip. Human says not yet. |
| `in-progress` | A worker owns it. Set at dispatch, cleared on finish. |
| `agent-reviewed` | Cleared ≥2/3 review lenses, at the SHA named in the verdict comment. |
| `needs-human` | A lens objected, or a loop blocked. |

An issue with **no** `tier:` label is skipped — the dispatcher refuses to guess a
risk level. Every skip prints a reason on every pass, so the queue is never
silently empty.

`tier:T0`/`tier:T1` exist so the *dangerous* work is nameable and visibly
excluded. Emissions, escrow, the supply cap, and `construct_runtime` indices are
not autonomy targets.

---

## Bounds and guards

All in `factory/config.env`; each also accepts an environment override
(`MAX_PARALLEL=1 ./factory/dispatch.sh`).

| Setting | Default | Meaning |
|---|---|---|
| `DEFAULT_MAX_ATTEMPTS` | 10 | Hard attempt ceiling per loop. |
| `DEFAULT_MAX_MINUTES` | 240 | Hard wall-clock ceiling per loop. |
| `SAME_ERROR_LIMIT` | 3 | Identical gate failures before stopping early. |
| `MAX_PARALLEL` | 3 | Concurrent workers in the night window. |
| `DAY_MAX_PARALLEL` | 1 | Concurrent workers outside it. |
| `NIGHT_START` / `NIGHT_END` | 22 / 7 UTC | Heavy-parallelism window. |
| `MIN_FREE_DISK_GB` | 30 | Below this, stop dispatching new work. |
| `BACKOFF_MINUTES` | 60 | Global pause after a rate-limit/overload. |
| `ENABLE_DISPATCH` | false | Stage 1 switch. |
| `ENABLE_MERGE` | false | Stage 2 switch. |

Loops are allowed 24/7; only *heavy parallelism* is confined to the night window,
so the box stays usable during the day.

The watchdog enforces the same caps **from outside** every 30 minutes, using the
pidfiles loops publish in `factory/run/`. A supervisor that trusts the supervised
process isn't a supervisor: if a loop wedges in a syscall or gets SIGSTOPped, its
own deadline never fires. The watchdog kills it and writes the BLOCKED report
itself.

Rate detection scans **only `*.agent.log`** transcripts. Scanning every log
caused a real false positive during the build — a log captured under `bash -x`
contains the detection regex in its own trace output, which would have tripped a
60-minute global back-off and silently halted the factory.

### The shared cargo cache tradeoff

`CARGO_TARGET_DIR=~/shared-target` is shared by every worktree. A cold Substrate
build is very expensive; N private target dirs would mean N cold builds and tens
of GB of duplication.

The cost: **cargo does not support concurrent invocations against one target
dir.** Two parallel builds race and produce corrupt or spuriously-failing
results — which a factory reads as a flaky gate, burning attempts on a phantom
failure. So every cargo invocation serializes behind one `flock`
(`cargo_locked` / `gate_locked`). Builds are serial; agent thinking, editing, and
non-cargo gates stay parallel — and thinking dominates, so throughput holds.

If you ever need genuinely parallel builds, give each worktree its own target dir
and accept the disk and cold-build cost. **Do not remove the lock.**

---

## Billing

**Updated 27 Sep 2026 (LAB decision 002 amendment, Max-subscription cutover).**
The inference proxy this host used is retired; `~/.factory/env` no longer sets
`ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`. Loops now bill the **Claude Max
subscription** — the same login an interactive session on this box would use.
Verified on this host with `claude` 2.1.220:

- Interactive sessions have no `ANTHROPIC_API_KEY` and authenticate via
  `oauthAccount` (`billingType: stripe_subscription`).
- With `ANTHROPIC_API_KEY` (or `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`) set,
  the CLI states the key *"takes precedence over your claude.ai login"* — so
  Max billing requires the *absence* of these, not their presence.

`load_billing_env` therefore **clears** `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`/
`ANTHROPIC_AUTH_TOKEN` (logging a warning if any were set — a stray key would
otherwise silently redirect billing at the retired, dead proxy; this is exactly
how the 217/219/223/225 tasks died mid-GATING on 2026-09-27), and it still
strips the `CLAUDECODE*` interactive-session markers, same as the old policy —
that guard against a nested, non-clean session was never about which billing
source was in use, so the Max-auth flip gives no reason to drop it.

---

## Testing the factory itself

```bash
./factory/tests/selftest.sh        # 32 assertions on the loop's bounds
./factory/tests/gate-detect.sh     # 18 assertions on gate selection
./factory/tests/verdict-parse.sh   # 16 assertions on fail-closed verdicts
```

Everything is shellcheck-clean (`shellcheck -x factory/**/*.sh`).

`selftest.sh` uses a **stub `claude`** that edits nothing and claims total
success — precisely the adversarial case the bounds exist to survive. Tests are
free, fast, and deterministic.

Dry-run the pipeline without touching GitHub:

```bash
FACTORY_ISSUE_FIXTURE=factory/tests/fixture-issues.json ./factory/dispatch.sh --dry-run
NIGHT_START=0 NIGHT_END=24 FACTORY_ISSUE_FIXTURE=factory/tests/fixture-issues.json \
  ./factory/dispatch.sh --dry-run        # force the night window
./factory/merge.sh --dry-run
./factory/watchdog.sh --dry-run
./factory/run-stage0.sh --dry-run
```

---

## Troubleshooting

**A loop blocked.** Read `factory/blocked/BLOCKED-<name>.md`. The gate output at
the top is what actually happened. Do not resolve it by weakening the gate.

**Everything stopped.** Check `~/STOP_FACTORY`, then `~/.factory/backoff`
(rate-limit pause), then free disk.

**Timers not firing after logout.** Lingering isn't enabled — see
[Setup step 2](#2-enable-lingering--requires-root-and-is-not-optional-for-247).

**`gh` label errors.** Run `./factory/bootstrap-labels.sh`; the labels don't
exist until you create them.

**`merge.sh` refuses everything.** Expected until branch protection with a
required check exists on `master`. It prints exactly what's missing.

**`merge.sh` refuses on the reviewed SHA.** The PR head has moved since the
review, so the review no longer speaks for it. Re-run `./factory/review.sh <N>`.
A PR reviewed before verdicts carried a SHA reads as *not bound to a head SHA*
and needs the same re-run.

**A PR is `BEHIND` master.** `merge.sh` fixes this itself now: it runs
`gh pr update-branch`, waits up to `MERGE_UPDATE_WAIT_SECS` (default 1800) for
the new checks to settle, re-reads mergeability, and only then merges. If the
checks do not settle in that window it leaves the PR for the next hourly pass
rather than merging on stale results.

**A worktree is in the way.**

```bash
./factory/lib/worktree.sh list
./factory/lib/worktree.sh cleanup <task-id>          # refuses if work is uncommitted
FORCE=1 ./factory/lib/worktree.sh cleanup <task-id>  # discard it anyway
```
