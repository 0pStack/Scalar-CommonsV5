# FACTORY-REPORT — 24/7 bounded-autonomy harness

Built on branch `factory/harness`, 2026-07-30. Everything lives under `factory/`
plus `.claude/hooks-factory/`. No existing repo file was modified — the hook is
wired via a documented `settings.json` snippet you apply yourself, not by editing
your settings.

**Status: built, verified, and OFF.** Nothing autonomous is running. Two systemd
user timers are installed and live (watchdog + nightly digest); the dispatcher
and merger both ship disabled behind explicit flags.

---

## 1. The enforcement thesis

The one rule — *never make a check pass by weakening code* — is enforced
mechanically at four independent layers, because an unsupervised agent under gate
pressure will otherwise take the cheap escape.

| Layer | Mechanism | When it acts |
|---|---|---|
| 1. Prompt | Every prompt states the rule and names its gate | before work |
| 2. Hook | `reject-stubs.sh` exits 2 on stub patterns | at write time |
| 3. Gate | Exit code is the entire verdict; agent summary is never consulted | after each attempt |
| 4. Review | 3 fresh-context adversarial lenses, fail-closed | before merge eligibility |

The structural decision: `loop.sh` gives the agent **no success path that avoids
the gate**. It runs the gate itself, reads the exit code, and blocks or continues.
A transcript claiming success while the gate is red is a failed loop.

---

## 2. Components built

| Path | Purpose |
|---|---|
| `factory/lib/loop.sh` | Bounded worker (Ralph loop): agent → gate → repeat |
| `factory/lib/worktree.sh` | Worktree isolation, shared cargo cache + flock |
| `factory/lib/common.sh` | Config, kill switch, back-off, billing preflight, guards |
| `factory/dispatch.sh` | Issue-driven dispatcher (**off**: needs `ENABLE_DISPATCH=true`) |
| `factory/review.sh` | 3 fresh-context adversarial reviewers; **no merge path** |
| `factory/merge.sh` | Only merger (**off**: needs protection + `ENABLE_MERGE=true`) |
| `factory/tracker.sh` | `STATE.md` + `--digest` secret gist |
| `factory/watchdog.sh` | External cap enforcement + 4 guards (30 min timer) |
| `factory/run-stage0.sh` | Starts the 4 named loops in tmux session `loops` |
| `factory/bootstrap-labels.sh` | Creates the label vocabulary (idempotent, **not run**) |
| `factory/install-systemd.sh` | Installs user units, handles linger |
| `factory/branch-protection.json` | Protection template for Stage 2 |
| `factory/config.env` | All bounds; every value env-overridable |
| `factory/README.md` | Setup, stages, labels, troubleshooting |
| `factory/tasks/*.prompt` | 4 Stage-0 task definitions + shared preamble |
| `factory/systemd/*` | 6 unit files (watchdog, digest, dispatch) |
| `factory/tests/*` | 3 test suites + issue fixture |
| `.claude/hooks-factory/reject-stubs.sh` | PostToolUse stub blocker |

### Choices made where the spec was silent

- **`ENABLE_DISPATCH` / `ENABLE_MERGE` flags.** "Off by default" is implemented as
  a refusal with an explanatory message, not just an uninstalled timer — so
  enabling a timer alone cannot start autonomous work. Two independent switches.
- **BLOCKED reports live in `factory/blocked/`**, pidfiles in `factory/run/`, logs
  in `factory/logs/`; all three gitignored via `factory/.gitignore`.
- **A pre-gate run before attempt 1.** If the tree is already green the loop exits
  0 having spent nothing. Paying an agent to discover there is no work is waste.
- **`\x1f` (Unit Separator) as the record delimiter**, not tab — see bug #1 below.
- **Reviewers run from a temp dir outside the repo** so `CLAUDE.md` isn't
  auto-discovered, honoring "given ONLY the diff + issue body + lens".
- **Three test suites for the harness itself** (66 assertions). A safety bound
  that has never been demonstrated is a claim, not a bound.
- **`python3` instead of `jq`** everywhere — `jq` is not installed on this host.
- **Labels are not created.** `bootstrap-labels.sh` is provided but unrun:
  creating labels mutates shared repo state and isn't needed until Stage 1.

---

## 3. Verification evidence

### 3.1 Shellcheck — clean

```
$ shellcheck -x $(find factory .claude/hooks-factory -name '*.sh' | sort)
EXIT 0 — ZERO FINDINGS across 15 scripts
```

Every finding raised during the build was fixed at the source, not suppressed;
the four remaining `disable=` directives each carry a written justification
(intentional Markdown backticks, trap-invoked function, sourced-file false
positive).

### 3.2 Loop bounds — 32/32

`factory/tests/selftest.sh` runs `loop.sh` against a **stub `claude`** that edits
nothing and claims total success — exactly the adversarial case the bounds exist
for. Free, fast, deterministic.

```
=== CASE 1: attempt cap — gate output VARIES so same-error stop cannot mask it ===
  PASS  exits 1 when attempt cap hit (got 1)
  PASS  ran exactly max_attempts=3 attempts, never more (got 3)
  PASS  logs the attempt-cap reason
  PASS  BLOCKED-capcheck.md written with the reason
  PASS  BLOCKED report leads with the authoritative gate output
  PASS  BLOCKED report contains the LAST gate output (pre-gate + 3 attempts)
  PASS  BLOCKED report contains the last agent summary
  PASS  BLOCKED report restates the ABSOLUTE RULE

=== CASE 2: same-error stop — identical gate output 3x halts early (burn control) ===
  PASS  exits 1 when stuck (got 1)
  PASS  stopped after 3 attempts despite max_attempts=10 (saved 7) (got 3)
  PASS  logs the stuck reason
  PASS  tracks the identical-output streak

=== CASE 3: kill switch — ~/STOP_FACTORY blocks before ANY attempt ===
  PASS  exits 1 immediately (got 1)
  PASS  made ZERO attempts — no spend after kill switch (got 0)
  PASS  logs the kill switch

=== CASE 4: gate passes => exit 0 the moment it goes green ===
  PASS  exits 0 on gate pass (got 0)
  PASS  stopped immediately at 1 attempt (did not use all 10) (got 1)
  PASS  logs the pass
  PASS  no BLOCKED file left behind after a pass

=== CASE 5: already-green gate => zero agent spend ===
  PASS  exits 0 (got 0)
  PASS  spent NOTHING when the tree was already green (got 0)
  PASS  logs the short-circuit

=== CASE 6: logging — output tee'd to factory/logs/<name>-<date>.log ===
  PASS  log file created: logs/logcheck-20260730.log
  PASS  log contains the run header
  PASS  log records the gate command

=== CASE 7: billing fail-closed — no API key means the loop REFUSES to run ===
  PASS  exits non-zero without an API key (got 1)
  PASS  made zero attempts (never silently fell back to the Max login) (got 0)
  PASS  explains the refusal

=== CASE 8: bad input rejected ===
  PASS  rejects a missing workdir (got 1)
  PASS  rejects a missing promptfile (got 1)
  PASS  rejects a non-numeric max_attempts (got 1)
  PASS  exits 2 on missing arguments (usage) (got 2)

===== SELFTEST SUMMARY: 32 passed, 0 failed =====
```

### 3.3 Gate detection — 18/18

Wrong-gate selection is the most dangerous failure mode available, because it
looks like the factory is working. `factory/tests/gate-detect.sh` builds throwaway
git repos with real manifests:

```
=== gate detection ===
  PASS  sdk diff -> npm ci
  PASS  sdk diff -> npm run build
  PASS  sdk diff -> npm run typecheck (read from package.json)
  PASS  sdk diff -> npm test
  PASS  sdk diff -> scoped to sdk
  PASS  sdk gate is not the workspace fallback
  PASS  indexer test-only -> npm test
  PASS  does not invent a missing build script
  PASS  no test script -> falls back to the workspace gate
  PASS  a subproject with no test script cannot form an honest gate, so it escalates
  PASS  python subproject -> pytest
  PASS  rust diff -> workspace gate
  PASS  rust gate is flock-serialized
  PASS  mixed diff -> workspace gate (conservative)

=== tier -> gate routing ===
  PASS  tier:T2 always uses the workspace gate
  PASS  tier:T2 gate builds tests too
  PASS  tier:T3 uses the detected subproject gate
  PASS  unknown tier falls back to workspace gate

===== GATE-DETECT SUMMARY: 18 passed, 0 failed =====
```

The emitted gate string was also proven to survive shell round-tripping:

```
$ G="$(t2_gate)"; echo "$G"
flock /home/dev/.factory/cargo.lock bash -c 'cargo check --workspace && cargo test --workspace --no-run'
$ bash -c "${G/.../echo BOTH-PARTS-RAN-AS-ONE-ARG && true}"
BOTH-PARTS-RAN-AS-ONE-ARG
EXEC EXIT=0
```

### 3.4 Reviewer fails closed — 16/16

```
=== verdict parsing ===
  PASS  clean PASS on its own line -> PASS
  PASS  clean FAIL on its own line -> FAIL
  PASS  empty output fails closed -> FAIL
  PASS  no verdict line at all fails closed -> FAIL
  PASS  prose mentioning pass but no verdict -> FAIL
  PASS  last verdict wins when the model restates -> FAIL
  PASS  indented verdict still detected (fallback) -> PASS
  PASS  verdict inside a sentence (fallback) -> FAIL
  PASS  malformed verdict word fails closed -> FAIL
  PASS  lowercase verdict fails closed (strict) -> FAIL
  PASS  PASS preceded by a FAIL discussion -> PASS
  PASS  truncated output mid-verdict fails closed -> FAIL

=== tally rules ===
  PASS  3 PASS: reviewed, no escalation -> reviewed/human = yes no
  PASS  2 PASS 1 FAIL: reviewed AND escalated -> reviewed/human = yes yes
  PASS  1 PASS 2 FAIL: not reviewed, escalated -> reviewed/human = no yes
  PASS  3 FAIL: not reviewed, escalated -> reviewed/human = no yes

===== VERDICT-PARSE SUMMARY: 16 passed, 0 failed =====
```

Note the 2-PASS-1-FAIL row: the spec's two rules (">=2 PASS → agent-reviewed" and
"any FAIL → needs-human") can both apply. Both labels get set; since `merge.sh`
requires `agent-reviewed` **and** no `needs-human`, any FAIL blocks the merge
while preserving the audit trail.

### 3.5 Dispatcher dry-run — every label rule fires

`--dry-run` performs zero mutations. Run against `factory/tests/fixture-issues.json`
(11 crafted issues), with the night window forced:

```
mode:        DRY RUN (no mutations)
window:      night (heavy parallelism), MAX_PARALLEL=3

DISPATCH #901 tier:T3  cluster=none       indexer: add pagination to /v1/events
        WOULD: create worktree ../wt-901 from origin/rebuild/runtime
        WOULD: add label in-progress to #901
        WOULD: gate = flock /home/dev/.factory/cargo.lock bash -c 'cargo check --workspace && cargo test --workspace --no-run'
        WOULD: run loop.sh issue-901 (caps: 10 attempts / 240 min)
        WOULD: on gate PASS -> push task/901, gh pr create (Closes #901), then review.sh
        WOULD: on gate FAIL -> write BLOCKED-issue-901.md, clear in-progress, comment on the issue
        WOULD: NOT merge (merge.sh is the only merger, and it is off)
DISPATCH #902 tier:T3  cluster=sdk-oracle sdk: implement oracle submit_response
DEFER #903  tier:T3  cluster:sdk-oracle already has #902 running — serialized, not parallel
SKIP  #904  tier:T0  TIER TOO RISKY for autonomy — never dispatched (consensus/economic code)
SKIP  #905  tier:T1  TIER TOO RISKY for autonomy — never dispatched (consensus/economic code)
SKIP  #906  tier:T2  blocked label present — human says not yet
SKIP  #907  tier:T3  in-progress — a worker already owns it
SKIP  #908  (none)   no tier: label — refusing to guess the risk level
DISPATCH #909 tier:T2  cluster=none       sc-e1: add Mechanism A sweep
DEFER #910  tier:T3  MAX_PARALLEL=3 reached this pass
SKIP  #911  tier:T3  needs-human — review escalated it

Dry run complete: 3 issue(s) would be dispatched, 0 mutations performed.
```

T0/T1 refusal, `blocked`, `in-progress`, `needs-human`, missing-tier refusal,
cluster serialization, and the parallelism cap are each demonstrated. In the real
daytime window `MAX_PARALLEL` clamps to 1.

### 3.6 Merge refuses — branch protection absent

```
$ ./factory/merge.sh --dry-run
REFUSING TO MERGE ANYTHING — branch protection precondition not met.

  branch:            master
  protection API:    not configured ({"message":"Not Found",...,"status":"404"})
  required checks:   <none>

Auto-merge is only safe when the trunk itself enforces the rules. Without
protection and at least one REQUIRED status check, a squash-merge from this
script would be an unguarded write to master: nothing would compel CI
to be green, and nothing would stop the next bad merge either.
...
exit=1
```

This is the correct terminal state today, and it is checked **before** the
`MERGE_*` flags are even consulted — no flag combination can bypass it.

### 3.7 Watchdog — independent cap enforcement, proven

A fake loop pidfile (2h old, 1-minute cap) against a live process:

```
--- dry run first (should say WOULD kill, and NOT kill) ---
WOULD: loop 'overcap-test' (pid 226988) is 7200s old, past its 1m cap +grace — killing
still alive after dry-run: correct
--- real run (should actually kill) ---
[..] loop 'overcap-test' (pid 226988) is 7200s old, past its 1m cap +grace — killing
[..] watchdog pass complete (killed 1 loop(s))
KILLED: correct
--- watchdog wrote a BLOCKED report? ---
# BLOCKED: overcap-test
- **reason**: killed by watchdog — exceeded 1m wall cap (age 7200s)
The loop's internal deadline did not fire (wedged or stopped process).
This report was written by the watchdog, not the loop.
--- pidfile reaped? ---
pidfile reaped: yes
```

Kill switch honored by every component:

```
$ touch ~/STOP_FACTORY
watchdog:    STOP_FACTORY present — terminating all factory processes.
dispatch:    STOP_FACTORY present — dispatcher exiting without dispatching.
merge:       STOP_FACTORY present — merging nothing.
run-stage0:  FATAL: STOP_FACTORY exists (/home/dev/STOP_FACTORY). Remove it before starting Stage 0.
```

Disk guard (threshold forced high to trip it):

```
$ MIN_FREE_DISK_GB=999999 ./factory/watchdog.sh --dry-run
WARN: DISK GUARD: 1913GB free < 999999GB — new dispatch suspended
$ MIN_FREE_DISK_GB=999999 ./factory/dispatch.sh --dry-run
WARN: free disk 1913GB < 999999GB — refusing to dispatch new work.
```

Rate guard — discriminates real signals from log noise:

```
$ ./factory/watchdog.sh --dry-run              # clean state
no rate-limit signatures in the last 35 min
$ printf 'API error: 429 rate_limit_error, please retry\n' > factory/logs/x-attempt1.agent.log
$ ./factory/watchdog.sh --dry-run
WARN: rate-limit/overload signature in x-attempt1.agent.log
WOULD: engage 60m back-off for all loops
```

### 3.8 Hook — blocks and allows correctly

```
$ printf '{"tool_input":{"file_path":".../runtime/src/lib.rs"}}' | .claude/hooks-factory/reject-stubs.sh
BLOCKED by factory standing rule: never make a check pass by weakening code.
Violations found in what you just wrote:
  - todo!( — placeholder body. 1 occurrence(s) on line(s): 2
  - #[allow( — suppresses a lint rather than fixing it. line(s): 1
  - fn main() {} — empty entrypoint in a node/runtime path. line(s): 3
EXIT=2
```

| Case | Expected | Got |
|---|---|---|
| clean source file | allow | 0 |
| `fn main(){}` outside node/runtime | allow (path-scoped) | 0 |
| `SKIP_WASM_BUILD` anywhere | block | 2 |
| `unimplemented!()` via MultiEdit shape | block | 2 |
| vendored `node_modules/` | allow | 0 |
| malformed JSON payload | allow (fail open) | 0 |
| `{"tool_input":{}}` | allow (fail open) | 0 |

### 3.9 Worktree isolation

```
$ ./factory/lib/worktree.sh new selftest-wt      -> /home/dev/wt-selftest-wt (65912a6, detached)
$ ./factory/lib/worktree.sh cleanup selftest-wt  -> removed
# dirty-tree guard:
WARN: worktree /home/dev/wt-guard-test has uncommitted changes — refusing to remove (FORCE=1 to override)
PRESERVED (correct — refused to discard work)
$ FORCE=1 ./factory/lib/worktree.sh cleanup guard-test  -> removed with FORCE
```

### 3.10 systemd user units — loaded, timers listing

```
$ systemctl --user list-timers --all 'factory-*'
NEXT                          LEFT  LAST                          PASSED   UNIT                   ACTIVATES
Thu 2026-07-30 15:29:49 CEST  29min Thu 2026-07-30 14:59:49 CEST  20s ago  factory-watchdog.timer factory-watchdog.service
Fri 2026-07-31 07:30:00 CEST  16h   -                             -        factory-digest.timer   factory-digest.service

2 timers listed.

$ systemctl --user status factory-watchdog.service
   Active: inactive (dead)  ... Process: 228245 ExecStart=.../watchdog.sh (code=exited, status=0/SUCCESS)
```

(07:30 CEST = 05:30 UTC, as specified.) The service ran successfully and its
output landed in `factory/logs/watchdog.systemd.log`.

### 3.11 Billing split — loops on API, interactive on Max

Verified three independent ways with `claude` 2.1.220.

**(a) Interactive context has no API key and is OAuth/subscription-backed:**

```
$ env | grep ANTHROPIC          # -> nothing
$ python3 -c "...json.load(open('~/.claude.json'))['oauthAccount']"
{"emailAddress": "harden.construction@gmail.com", "billingType": "stripe_subscription", ...}
```

**(b) An API key in the environment TAKES PRECEDENCE and does not fall back.**
With a deliberately invalid key:

```
$ ANTHROPIC_API_KEY="sk-ant-api03-INVALID-KEY-FOR-BILLING-PROOF-000000" \
    claude -p "Reply with the single word: pong" --dangerously-skip-permissions
stdout: Execution error
stderr: ⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another
        auth source is set and takes precedence over your claude.ai login
        · Unset it to load your organization's connectors
```

The CLI states the precedence explicitly, and the invalid key **fails** rather
than silently reverting to the Max login. That is the load-bearing proof: the key
path is live, not decorative.

**(c) The real key from `~/.factory/env` produces a metered API charge:**

```
$ ( . ~/.factory/env; claude -p "Reply with exactly: pong" \
      --dangerously-skip-permissions --output-format json )
  result = "pong"
  total_cost_usd = 0.040901
  is_error = false
  usage = {"service_tier": "standard", "input_tokens": 2, "output_tokens": 4, ...}
EXIT=0
```

`load_billing_env` therefore requires a non-empty key, **fails closed without
one** (selftest case 7: zero attempts, explicit refusal), and unsets inherited
`CLAUDECODE*` markers so each loop is a clean, non-nested, API-billed session.

> **Note on `--bare`:** the CLI has a flag that hard-guarantees API-only auth
> ("OAuth and keychain are never read"). The factory deliberately does **not** use
> it, because `--bare` also *skips hooks* — which would disable the anti-stub
> enforcement. Fail-closed preflight plus a working hook beats a stronger auth
> guarantee with the safety net off.

---

## 4. Bugs found and fixed during verification

The dry-runs earned their keep. Five real defects, all found by testing rather
than by reading:

1. **Empty fields silently shifted every column left.** Records were tab-separated
   and read with `IFS=$'\t' read`. Tab is IFS *whitespace*, so bash collapses runs
   of tabs and drops empty fields — an issue with no `cluster:` label had its
   `flags` value land in `cluster`. Effect: **the `blocked`, `in-progress`, and
   `needs-human` skip rules never fired** (fixture issues #906/#907/#911 fell
   through to DEFER). Fixed by switching to `\x1f` (Unit Separator) in both
   `dispatch.sh` and `merge.sh`. This is the bug that most justified building the
   fixture.
2. **`printf` ate the BLOCKED report.** `printf '- **reason**: %s\n'` — a format
   string starting with `-` is parsed as an *option* (`printf: - : invalid
   option`), aborting the report block, so **no BLOCKED file was written at all**
   and the exit code became 2 instead of 1. Fixed by passing all content as
   printf *arguments* (`printf '%s\n' "$line"`), which also immunizes against
   backtick-as-command-substitution.
3. **The rate guard fired on its own log noise.** It scanned every file in
   `factory/logs/`; a log captured under `bash -x` contains the detection regex in
   its trace output. That would have engaged a 60-minute global back-off and
   silently halted the whole factory. Narrowed to `*.agent.log` — rate-limit
   errors only ever come from the API, so only API transcripts are evidence.
4. **Broken paths in `review.sh` (found by shellcheck SC2318).**
   `local name="$1" out="$WORK/$name.out"` — within a single `local`, later
   initialisers don't see earlier ones, so all three lenses would have written to
   the same wrongly-named file. Split into separate `local` statements.

5. **The nightly digest would have silently produced nothing.** `tracker.sh`
   called `gh gist create --secret`, but gh 2.96 has no such flag — gists are
   secret *by default* and `--public` is the opt-out. Passing it makes gh print
   its usage text and create nothing, so every 05:30 digest would have "run"
   successfully while gisting nothing. Caught by running the digest for real
   rather than trusting the timer; fixed and verified end-to-end:

   ```
   $ ./factory/tracker.sh --digest
   [..] gisting 1 file(s) as a secret gist
   [..] digest: https://gist.github.com/tejaspatil1936/91b7590f9df8749218ede999bf2395b6
   $ cat factory/digests.log
   2026-07-30T13:29:21Z  https://gist.github.com/...  1 files
   ```

Two smaller fixes: `grep -c` prints `0` *and* exits 1, so `|| echo 0` produced
`"0\n0"` in the tracker's attempt column; and non-loop logs (`watchdog`,
`dispatch-notes`) were being reported as loops — now filtered by requiring the
loop header, and stats scoped to each log's **last** run so appended daily logs
don't overstate attempt counts.

---

## 5. Your commands

### (1) Put the API key in place

```bash
mkdir -p ~/.factory
printf 'export ANTHROPIC_API_KEY=sk-ant-api03-YOUR-KEY-HERE\n' > ~/.factory/env
chmod 600 ~/.factory/env
```

`~/.factory/env` already exists on this host with a working key (proof 3.11c ran
against it). Re-run only if you want to rotate it.

**Also run this — it needs your password and I could not:**

```bash
sudo loginctl enable-linger dev
loginctl show-user dev | grep Linger     # want: Linger=yes
```

Without lingering the timers die when you log out. See §6.

### (2) Start Stage 0 tonight

```bash
cd ~/scalar-commons-v4
./factory/run-stage0.sh --dry-run     # confirm the 4 loops, gates, worktrees
./factory/run-stage0.sh               # start them in tmux session "loops"

tmux attach -t loops                  # watch; ctrl-b n / ctrl-b w to navigate
tail -f factory/logs/*-$(date -u +%Y%m%d).log
./factory/tracker.sh                  # regenerate + print STATE.md
```

Each loop is capped at 10 attempts / 240 minutes, works in its own worktree
(`../wt-trackB-*`), and is graded only by its gate. Worst case per loop is a
`BLOCKED-*.md` you read in the morning.

Optional — turn the hook on first (recommended; merge, don't replace, the
existing `PostToolUse` entry):

```json
{ "type": "command", "command": "bash .claude/hooks-factory/reject-stubs.sh" }
```

### (3) Stop everything

```bash
touch ~/STOP_FACTORY            # every component refuses before doing work
./factory/watchdog.sh           # optional: kill running loops now, don't wait 30m
```

Resume with `rm ~/STOP_FACTORY`. To also stop the timers:

```bash
systemctl --user disable --now factory-watchdog.timer factory-digest.timer
```

### Reading the morning digest

```bash
tail -3 factory/digests.log     # secret gist URLs, newest last
```

At 05:30 UTC the digest gists `STATE.md` + new BLOCKED reports. Read order:
Health → BLOCKED reports → loop stats.

---

## 6. What I did NOT build, and why

1. **Lingering is not enabled.** `loginctl enable-linger dev` returned
   `Access denied`, and `sudo` on this host requires a password I don't have. This
   is the one gap that affects the "24/7" claim: **until you run it, the timers
   only survive while a login session is open.** Command in §5(1).

2. **The label vocabulary is not created.** `ready`, `tier:T0..T3`,
   `agent-reviewed`, `needs-human`, `blocked`, `in-progress` do not exist in the
   repo. Creating labels mutates shared repo state and isn't needed until Stage 1,
   so it's a one-line explicit step: `./factory/bootstrap-labels.sh`. The
   dispatcher is off, so nothing needs them yet.

3. **Branch protection is not configured, and I did not configure it.**
   `master` has none (API 404). Setting it changes the rules for every human
   contributor, which is your call, not an automation's. Template provided at
   `factory/branch-protection.json`; `merge.sh` refuses everything until it
   exists. **Merging is therefore fully inert today** — this is the intended
   Stage-0/1 state.

4. **The dispatcher timer is not installed and dispatch is off.** Stage 2
   machinery, built and dry-run-verified, gated behind `ENABLE_DISPATCH=true`
   *and* `--with-dispatch`. Turning it on before Stage 0 has produced a reviewed
   clean pass would be autonomy without evidence it works here.

5. **`review.sh` has not been run against a real PR.** The repo has zero open PRs,
   so there was nothing to review, and I would not open a throwaway PR on a shared
   repo just to exercise it. Its decision logic — verdict extraction, fail-closed
   behaviour, the 2/3 tally — is covered by 16 fixture assertions (§3.4); what
   remains unexercised is the `gh pr diff` / `gh pr comment` plumbing. It will run
   for real on the first Stage-1 PR. `review.sh <pr> --dry-run` exists for a
   no-cost check when you have one.

6. **No loop has been run against a real `claude` agent.** All 32 bound tests use
   a stub agent, deliberately: they must be free, fast, and deterministic, and the
   stub's "I claim everything is fixed and perfect!" is a *harder* case than a real
   agent. Real API billing was proven separately (§3.11). The first genuine
   agent-in-the-loop run is Stage 0, which you start.

7. **No `spec_version` bump, migration, or chain code.** Nothing in this branch
   touches `pallets/`, `runtime/`, `node/`, or `tests/` — verified below.

8. **The 24-endpoint indexer spec does not exist anywhere**, so I did not invent
   it. `CLAUDE.md` asserts a "24-endpoint REST API" and an `npm test` command, but
   `indexer/` contains exactly one file: `reconcile.py`. No package.json, no
   server, no JS suite. The Track B prompt therefore states this plainly, tells
   the agent not to trust the claim, and makes `indexer/API.md` — 24 endpoints
   enumerated from the pallets' actual events — the first deliverable, before any
   implementation. Same situation for the explorer: no `explorer/` or `frontend/`
   directory exists; that prompt creates the component from nothing.

### Scope confirmation

```
$ git diff --stat master...factory/harness -- pallets runtime node tests
(empty — no changes)
```

Files added: `factory/**`, `.claude/hooks-factory/reject-stubs.sh`,
`FACTORY-REPORT.md`. `.claude/settings.json` was **not** modified.

---

## 7. Honest assessment of residual risk

- **The gates are only as good as the tests the agents write.** Three of the four
  Stage-0 gates run test suites that *do not exist yet* — the agent authors them.
  A suite that asserts nothing passes just as green as a real one. Mitigations:
  prompts demand tests-first-from-spec and forbid empty assertions; the standing
  rules reviewer hunts for exactly this; `node_gate` refuses to build a gate for a
  subproject with no test script rather than inventing one. **But the first
  Stage-0 output deserves a real human read of the tests, not just the gate
  result.** That is the single highest-value thing you can do tomorrow.
- **`--dangerously-skip-permissions` is exactly what it says.** Loops run agents
  with full tool access in a worktree. Isolation is per-worktree, not a sandbox: a
  determined agent could reach outside it. The kill switch, caps, and the fact
  that nothing merges are the real containment.
- **Cluster serialization is per-pass.** `flock` guarantees mutual exclusion
  between live workers; two *sequential* dispatcher passes can still hand the same
  cluster to a new worker while a stale one is finishing. The `in-progress` label
  plus the watchdog's stale-label cleanup cover the common case.
- **The reviewers are the same model family as the author.** Fresh context and
  distinct lenses reduce correlated blind spots; they do not eliminate them. `2/3
  PASS` is a filter, not a proof, which is why merging additionally requires green
  CI and branch protection.
