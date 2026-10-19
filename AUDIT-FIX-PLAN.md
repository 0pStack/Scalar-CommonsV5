# AUDIT-FIX-PLAN.md

**Round:** factory readiness + file every audit issue
**Date:** 2026-09-08
**Base:** `master` @ `648322e`
**Repository:** `tejaspatil1936/scalar-commons-v4` (public since 2026-09-08T18:19:33Z)

Everything below is either a fix to the factory's ability to **run** its gates, or a filing of a defect
the audit proved. **No gate's meaning was weakened, anywhere.** `merge.sh` kept every refusal it had and
gained two.

---

## ⚠️ Read this before the 21:00 UTC+2 dispatch pass

`tier:T2` is now in `DISPATCH_TIERS`, and issue **#130 (I-13)** carries `tier:T2 ready`. Three of its
four causes are **already fixed in PR #118**, which is open and unmerged. A dispatched agent will see
that issue's gate — `grep -q 'load_billing_env' factory/review.sh` — red on `master` and is likely to
re-implement work that already exists, producing a PR that conflicts with #118.

Two clean ways out, both one command; the labels were left exactly as this round specified, so the call
is yours:

```sh
gh pr merge 118 --squash --delete-branch          # land the fix, then #130 is only about cause 2
gh issue edit 130 --remove-label ready            # park it until #118 lands
```

The issue body already carries a **Status at filing time** section naming PR #118 and narrowing #130 to
cause 2 (`review.sh` never removes a stale `needs-human`), which is the only cause still untouched.

---

## Part 1 — the three factory defects

**PR [#118](https://github.com/tejaspatil1936/scalar-commons-v4/pull/118)** — branch `factory/audit-fixes`,
**open, not merged**, as instructed.

| Defect | Audit id | Fix |
|---|---|---|
| `review.sh` never called `load_billing_env` | P6-03, I-13 cause 1 | Runs the same preflight `lib/loop.sh` runs — after the kill switch, before the diff is fetched, long before any lens spawns. Fails closed. |
| `BEHIND` PRs were a permanent dead end | I-13 cause 3 | `gh pr update-branch`, wait for the new head **and** its fresh checks, re-read mergeability, then merge. `CONFLICTING`/`DIRTY` stay hard refusals, checked first, so a conflicted branch is never handed to update-branch. |
| `agent-reviewed` was a naked label | P6-05, I-13 cause 4 | `review.sh` records the SHA it actually read in its verdict comment; `merge.sh` refuses a head that has moved. A PR reviewed before verdicts carried a SHA reads `UNBOUND` and must be reviewed again. |

**Why the third fix does not reintroduce the second.** An update-branch moves the head, which by the SHA
rule invalidates the binding — refusing there would put the factory straight back to "cannot merge
anything". The exception is narrow and **proved from the commit graph**, not asserted: the new head is
accepted only if it is a two-parent merge whose **first** parent is exactly the reviewed SHA and whose
**second** parent is already contained in the base branch. Rejected by test: a commit pushed on top, a
merge of an arbitrary branch, and — the interesting one — an unreviewed commit buried under a *later*
base merge, which is also a merge commit and would sail through a naive "is it a merge?" check.

### Tests

| Suite | Assertions |
|---|---|
| `factory/tests/review-billing.sh` (new) | 8 |
| `factory/tests/merge-binding.sh` (new) | 37 |
| `gate-detect` + `gate-parse` + `selftest` + `verdict-parse` (existing) | 114 |
| **total** | **159 passed, 0 failed** |

`merge-binding.sh` drives the real decision functions through self-test entrypoints, a real throwaway
git repo for the lineage cases, and **`merge.sh`'s real loop against a stub `gh`** — a pure-unit suite
would stay green if someone wired the functions up and never called them.

Writing that loop test caught a fail-open in this change's own first draft: an empty `gh pr view`
response after update-branch resolved to a **merge**. Both post-update reads now demand a well-formed
answer or refuse. `shellcheck -S warning` is clean across `factory/`.

### Not fixed here

I-13 **cause 2** — `review.sh` never removes a stale `needs-human` — was outside this round's brief and
is what issue #130 is now about. It is why a dry run still merges nothing today:

```
REFUSE #113  has needs-human (unresolved review objection)
REFUSE #112  has needs-human (unresolved review objection)
```

Any fix must not simply drop the label: a clean re-review superseding an earlier ERROR is not the same
thing as an unresolved FAIL being cleared, and only the first may lift it.

---

## Part 2 — the 24 issues

**23 filed verbatim from `TESTNETAUDIT.md` §6, plus 1 derived; 1 flagged as a filing error.**

Every body is the section text verbatim — evidence, tables and provenance included — followed by a
`## Gate` section (one line, no backslashes), the audit's own RED/GREEN prose, and a
`## Closes audit findings` list of the phase finding ids it closes. Every gate was executed on `master`
@ `648322e` and the RED/GREEN result posted as a comment on its issue.

| I-N | Issue | Tier | Labels | Gate on `master` |
|---|---|---|---|---|
| I-1 | [#119](https://github.com/tejaspatil1936/scalar-commons-v4/issues/119) | T0 | `tier:T0` `security` | **RED** |
| I-2 | [#120](https://github.com/tejaspatil1936/scalar-commons-v4/issues/120) | T0 | `tier:T0` `security` | **RED** |
| I-3 | [#121](https://github.com/tejaspatil1936/scalar-commons-v4/issues/121) | T3 | `tier:T3` `documentation` `ready` | **RED** |
| **I-4** | *not filed* | tier:T3 | — | **GREEN — filing error, flagged** |
| I-4 (residual) | [#142](https://github.com/tejaspatil1936/scalar-commons-v4/issues/142) | T3 | `tier:T3` `documentation` `ready` | **RED** |
| I-5 | [#122](https://github.com/tejaspatil1936/scalar-commons-v4/issues/122) | T3 | `tier:T3` `documentation` `ready` | **RED** |
| I-6 | [#123](https://github.com/tejaspatil1936/scalar-commons-v4/issues/123) | T1 | `tier:T1` `security` `ready` | **RED** |
| I-7 | [#124](https://github.com/tejaspatil1936/scalar-commons-v4/issues/124) | T1 | `tier:T1` `blocked` `ready` | **RED** |
| I-8 | [#125](https://github.com/tejaspatil1936/scalar-commons-v4/issues/125) | T1 | `tier:T1` `ready` | **RED** |
| I-9 | [#126](https://github.com/tejaspatil1936/scalar-commons-v4/issues/126) | T2 | `tier:T2` `ci` `ready` | **RED** |
| I-10 | [#127](https://github.com/tejaspatil1936/scalar-commons-v4/issues/127) | T3 | `tier:T3` `ready` | **RED** |
| I-11 | [#128](https://github.com/tejaspatil1936/scalar-commons-v4/issues/128) | T3 | `tier:T3` `documentation` `ready` | **RED** |
| I-12 | [#129](https://github.com/tejaspatil1936/scalar-commons-v4/issues/129) | T3 | `tier:T3` `documentation` `ready` | **RED** |
| I-13 | [#130](https://github.com/tejaspatil1936/scalar-commons-v4/issues/130) | T2 | `tier:T2` `ready` | **RED** |
| I-14 | [#131](https://github.com/tejaspatil1936/scalar-commons-v4/issues/131) | T3 | `tier:T3` `ready` | **RED** |
| I-15 | [#132](https://github.com/tejaspatil1936/scalar-commons-v4/issues/132) | T2 | `tier:T2` `ready` | **RED** |
| I-16 | [#133](https://github.com/tejaspatil1936/scalar-commons-v4/issues/133) | T3 | `tier:T3` `ready` | **RED** |
| I-17 | [#134](https://github.com/tejaspatil1936/scalar-commons-v4/issues/134) | T0 | `tier:T0` | **RED** |
| I-18 | [#135](https://github.com/tejaspatil1936/scalar-commons-v4/issues/135) | T3 | `tier:T3` `ready` | **RED** |
| I-19 | [#141](https://github.com/tejaspatil1936/scalar-commons-v4/issues/141) | T3 | `tier:T3` `ready` | **RED** |
| I-20 | [#136](https://github.com/tejaspatil1936/scalar-commons-v4/issues/136) | T1 | `tier:T1` `ready` | **RED** |
| I-21 | [#137](https://github.com/tejaspatil1936/scalar-commons-v4/issues/137) | T3 | `tier:T3` `ready` | **RED** |
| I-22 | [#140](https://github.com/tejaspatil1936/scalar-commons-v4/issues/140) | T2 | `tier:T2` `ready` | **RED** |
| I-23 | [#139](https://github.com/tejaspatil1936/scalar-commons-v4/issues/139) | T1 | `tier:T1` `ready` | **RED** |
| I-24 | [#138](https://github.com/tejaspatil1936/scalar-commons-v4/issues/138) | T1 | `tier:T1` `security` `ready` | **RED** |

### The one GREEN gate — I-4, flagged not filed

I-4's gate is `gh api repos/tejaspatil1936/scalar-commons-v4 --jq '.private' | grep -qx false`. It is
**GREEN**: the repository went public at **2026-09-08T18:19:33Z**, after the audit was written, and an
anonymous `curl` of the repo URL returns `200`. The audit's headline claim — "Every GitHub link on the
public landing page 404s" — is no longer true, so filing it verbatim would have filed a false statement
and handed an agent a task that is already done.

The half that is still RED was filed as **#142**: `docs/.vitepress/config.mts:69` points at
`github.com/tejaspatil1936/scalar-commons` — **missing `-v4`** — a repository that does not exist. That
link is rendered into the nav of every published docs page. Making the repo public did not fix it and
could not have: the URL names the wrong repository, not a private one.

### Gate rewrites at filing time

**I-1 (decision D1: rotate, not remove).** The audit's gate asserted `Sudo::Key` is `None`. As
instructed, it now asserts the root key is **not** Alice's
`0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d`. RED today; GREEN the moment the
key is rotated, with or without removal. The issue records that **removal is scheduled for mainnet**,
and that `docs/reference/rpc.md:296` ("Removed by referendum after launch") must be corrected until it
is true.

**Backslash removal (four gates).** The audit's I-3, I-20, I-21 and I-24 gates contained backslashes —
regex escapes and, in I-20, nested shell quote-escaping. The factory's gate runner mangles those, so
they were rewritten backslash-free and each was re-executed to confirm it still returns RED for the
same reason:

- **I-3** — `grep -qE '^\| … \|'` → `grep -qF -e … -e … -e …`. Three fixed strings instead of one
  anchored alternation; catches strictly more, never less.
- **I-20** — the nested `curl`-inside-`curl` with escaped JSON → one `python3 -c` that makes both
  JSON-RPC calls. Identical comparison: head `:code` hash vs genesis `:code` hash.
- **I-21** — `\d` → `[0-9]`, and the literal `'` supplied via `chr(39)`. Same arithmetic:
  drip × per-address allowance ≥ 1051 CMN.
- **I-24** — `\s` → `[[:space:]]`. Same two sshd assertions.

**I-23** additionally dropped a `tr '\0'` in favour of `grep -qa` on `/proc/<pid>/cmdline`, which reads
the NUL-separated argv directly.

### Label notes

- `ci` did not exist and was created (`#1d76db`).
- `tier:T0` issues (#119, #120, #134) carry **no** `ready` — they are never dispatched, and the label
  would misrepresent them as queued.
- `tier:T1` issues carry `ready` as specified. `dispatch.sh` skips T1 unconditionally in code, so the
  label marks them queued for human rounds and cannot cause a dispatch.
- **#124 (I-7) carries both `blocked` and `ready`**, per this round's rule that the tier label plus any
  topic label named in the heading both apply. They pull in opposite directions —
  `blocked` means "the factory skips this" and `ready` means "the factory may pick this up". `blocked`
  wins in `dispatch.sh` (it is the first skip rule), and I-7 is T1 besides, so nothing will dispatch it.
  Worth resolving deliberately rather than leaving as an accident.

---

## Part 3 — the batch-day configuration

### `factory-dispatch.service` drop-in

`~/.config/systemd/user/factory-dispatch.service.d/override.conf`:

```ini
[Service]
Environment=ENABLE_DISPATCH=true
Environment=ENABLE_MERGE=true
Environment="DISPATCH_TIERS=tier:T3 tier:T2"
Environment=MAX_PARALLEL=4
Environment=DAY_MAX_PARALLEL=4
Environment=DAILY_SPAWN_CAP=300
```

`config.env` documents `DISPATCH_TIERS` as a **space-separated** list, so the whole assignment is quoted
— unquoted, systemd would read ` tier:T2` as a second variable and the T2 issues would be silently
skipped with `not in DISPATCH_TIERS`. `dispatch.sh` can still **never** dispatch `tier:T0` or `tier:T1`:
the allowlist only narrows the code's ceiling and cannot widen it.

### `factory-merge.service` drop-in

`~/.config/systemd/user/factory-merge.service.d/override.conf`:

```ini
[Service]
Environment=MERGE_T2=true
```

### Effective environment after `systemctl --user daemon-reload`

```
$ systemctl --user show factory-dispatch.service -p Environment
Environment=ENABLE_DISPATCH=true ENABLE_MERGE=true "DISPATCH_TIERS=tier:T3 tier:T2" MAX_PARALLEL=4 DAY_MAX_PARALLEL=4 DAILY_SPAWN_CAP=300 PATH=/home/dev/.npm-global/bin:/home/dev/.local/bin:/home/dev/.cargo/bin:/usr/local/bin:/usr/bin:/bin
```

```
$ systemctl --user show factory-merge.service -p Environment
Environment=ENABLE_MERGE=true MERGE_T2=true PATH=/home/dev/.npm-global/bin:/home/dev/.local/bin:/home/dev/.cargo/bin:/usr/local/bin:/usr/bin:/bin
```

### Branch protection

`required_status_checks.strict` → **false**, all six contexts kept:

```
contexts: gate, full, landing, faucet, docs, sdk
strict:   false   (was true)
```

Changed via the sub-resource endpoint rather than a full `PUT` of the protection object, so nothing else
could be dropped by omission. Verified by diffing the whole protection object before and after:

```
CHANGED .required_status_checks.strict: True -> False
(nothing else changed)
```

`enforce_admins: true`, `allow_force_pushes: false`, `allow_deletions: false` and the required-review
settings are all untouched.

### Restore `strict=true` — the exact command

```sh
gh api -X PATCH repos/:owner/:repo/branches/master/protection/required_status_checks -F strict=true
```

Run it from a checkout of this repository, or substitute
`repos/tejaspatil1936/scalar-commons-v4/branches/master/protection/required_status_checks`.

**Restore it once PR #118 is merged.** `strict=false` is what lets today's `merge.sh` — the one on
`master`, which has no update-branch step — merge an out-of-date branch at all. Once #118 lands,
`merge.sh` brings branches up to date itself and re-runs their checks, so `strict=true` becomes the
better setting again: it is the thing that guarantees no PR merges on results from a stale base.

### Timers

Left running on their own schedule. **No dispatch pass was started by hand.**

| Timer | Next |
|---|---|
| `factory-dispatch.timer` | hourly, on the hour |
| `factory-merge.timer` | every 30 min |
| `factory-watchdog.timer` | every 30 min |
| `factory-digest.timer` | daily 07:30 |

### What the dispatcher will see on its next pass

15 issues carry `ready` at a dispatchable tier: **4 × `tier:T2`** (#126, #130, #132, #140) and
**11 × `tier:T3`** (#121, #122, #127, #128, #129, #131, #133, #135, #137, #141, #142), against
`MAX_PARALLEL=4` and a `DAILY_SPAWN_CAP` of 300. The nine `tier:T0`/`tier:T1` issues are skipped in
code regardless of their labels.

---

## Verification trail

| Claim | Evidence |
|---|---|
| 159 factory assertions pass | `for t in factory/tests/*.sh; do bash "$t"; done` — all exit 0 |
| shellcheck clean | `shellcheck -S warning factory/*.sh factory/lib/*.sh factory/tests/*.sh` — no output |
| 23 gates RED on `master` | executed at `648322e`, results posted as a comment on each issue |
| I-4 gate GREEN | `gh api … --jq '.private'` → `false`; anonymous `curl` of the repo URL → `200` |
| only `strict` changed | before/after diff of the full protection object |
| no manual dispatch | `factory/logs/` shows no new dispatch run; the 21:00 timer is untouched |
