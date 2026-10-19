# FACTORY-REVIEW-FIX — why `factory/review.sh` failed every lens on large PRs

**Branch:** `factory/review-fix` · **Files changed:** `factory/review.sh`, `factory/config.env` · **Nothing merged.**

---

## 1. Root cause

The reported symptom was right, the suspected mechanism was not. The diff never
reached a model at all — **`claude` was never executed.**

The old code passed the whole prompt as a single command-line argument:

```bash
( cd "$WORK" && timeout 900 claude -p "$(cat "$pf")" --dangerously-skip-permissions ) \
  > "$out" 2>"$WORK/$name.err" || warn "lens $name exited non-zero"
```

Linux caps a **single** `argv` element at `MAX_ARG_STRLEN` = 32 pages = **131072
bytes**. This is a separate limit from `ARG_MAX` (2 MiB here), and it is not
configurable. PR #85's prompt was **317062 bytes**, so `execve()` returned
`E2BIG` and the shell aborted the command with exit **126** before `claude`
started.

Reproduced on the exact failing PR, with the exact old invocation:

```
$ wc -lc old85.prompt
  8079 317062 old85.prompt
$ timeout 900 claude -p "$(cat old85.prompt)" --dangerously-skip-permissions > out 2> err
rc=126
--- stdout bytes: 0 ---
--- stderr ---
/bin/bash: line 28: /usr/bin/timeout: Argument list too long
```

And the threshold confirmed directly:

```
$ for n in 120000 131000 131072 131080 140000; do ... /bin/true "$s"; done
120000 bytes: OK
131000 bytes: OK
131072 bytes: E2BIG      <- exactly 32 * 4096
131080 bytes: E2BIG
140000 bytes: E2BIG
```

That explains the whole reported picture: *"every lens exited non-zero and
produced no parseable VERDICT."* Zero bytes of stdout, exit 126, three times.
Then `|| warn` discarded the exit code and the missing-verdict rule scored each
lens **FAIL** — inventing three objections that no model ever made.

The 8000-line diff was the trigger; it was **not** a case of overwhelming the
model's context. 317 KB is roughly 80k tokens, well inside the model's window.
The failure was in the shell, one layer below the API.

### Second, independent bug — the tally was structurally dead

`run_lens` returned its verdict on stdout, but it also called `log()`, which
writes to stdout:

```bash
v="$(run_lens "$l")"      # captures BOTH the log line and the verdict
case "$v" in PASS) ... FAIL) ... esac
```

Demonstrated:

```
captured v = $'[ts] running lens: correctness (10 line prompt)\nPASS'
PASSES=0 FAILS=0  <- tally after a genuine PASS
```

So even on a PR small enough to exec, `$v` was `"[ts] running lens: …\nPASS"`,
the `case` matched neither arm, and `PASSES`/`FAILS` stayed at 0/0 — no
`agent-reviewed` label could ever be applied, and the comment table printed a
log line where the verdict belonged. Both bugs are now fixed and both are
documented in the script header as do-not-regress notes.

---

## 2. What changed in `factory/review.sh`

### 2.1 Filtered diff (real pathspec, not a line grep)

The PR head is fetched into a private ref and diffed against the base branch
with git `:(exclude,glob)` pathspecs, so exclusion happens at the **file** level
inside git and can never mis-slice a hunk:

```bash
git fetch --quiet --no-tags origin "+refs/pull/$PR/head:$PRREF" \
                                   "+refs/heads/$BASE_REF:refs/remotes/origin/$BASE_REF"
git diff --no-color "refs/remotes/origin/$BASE_REF...$PRREF" -- "${EXCLUDE_SPECS[@]}" ...
```

The private ref is deleted on exit. If the fetch fails (no `origin`, restricted
network), the script falls back to the unfiltered `gh pr diff`, **says so in the
prompt**, and still applies the line cap — it does not pretend the diff was
filtered.

**Exclusion list** (`REVIEW_EXCLUDE_GLOBS` in `config.env`, overridable):

```
**/package-lock.json  **/pnpm-lock.yaml  **/yarn.lock
**/*.min.js  **/*.min.css  **/*.map
**/dist/**  **/build/**  **/node_modules/**
**/*snapshot.json
```

### 2.2 No silent coverage loss

Three guarantees, all visible in the prompt the lens receives:

1. **Every changed file name** is listed, including excluded ones, each tagged
   `[generated/vendored — diff body excluded]` or `[diff body omitted by
   truncation]`.
2. **Every `package.json` / `Cargo.toml` diff is reproduced in full** in its own
   section that is never excluded and never truncated (`REVIEW_MANIFEST_GLOBS`).
   Dropping a lockfile body must not hide a dependency change, and this is what
   keeps that true.
3. If the filtered diff still exceeds **`MAX_REVIEW_DIFF_LINES` (default 1500)**
   it is truncated **at file boundaries** (never mid-hunk) and the prompt states
   verbatim: `diff truncated at N lines; omitted files: <list>`, followed by an
   instruction that partial coverage is not itself grounds for FAIL but must be
   named in the reasons. The truncation is also logged as a `WARN`.

### 2.3 Exit code captured; ERROR is not FAIL

```bash
( cd "$WORK" && timeout "$REVIEW_LENS_TIMEOUT" claude -p --dangerously-skip-permissions ) \
  < "$pf" > "$out" 2> "$err"
rc=$?
```

The prompt now goes **on stdin**, so prompt size can never fail an exec again.
`rc` is recorded per lens and three outcomes are kept distinct:

| result | meaning | effect |
|---|---|---|
| `PASS` | model returned `VERDICT: PASS` | counts toward `agent-reviewed` |
| `FAIL` | model returned `VERDICT: FAIL` | `needs-human`, exit 1 |
| `ERROR` | call exited non-zero, **or** exited 0 with no parseable verdict, **or** was never run (spawn cap) | review status **INCONCLUSIVE**, no `agent-reviewed`, `needs-human`, exit 2 |

`agent-reviewed` now additionally requires `ERRORS == 0`: a review with a dead
lens is an incomplete review and must not be labelled as having cleared the bar.
Lens results travel in files (`$WORK/<lens>.result`), never on stdout, which
kills the log-contamination bug class permanently.

### 2.4 Robust verdict parse

```bash
grep -oiE 'verdict[[:space:]]*:[[:space:]]*[*_[:space:]]{0,6}(pass|fail)' "$out" | tail -1
```

Case-insensitive, tolerant of markdown emphasis and whitespace, last match wins,
and it requires the colon form so prose like *"the verdict was fail"* cannot be
mistaken for a verdict. It runs **only** against the model's captured stdout —
`review.sh`'s own progress output goes to the terminal and never into `$out`.
17/17 cases verified:

```
  ok    plain PASS                                     -> PASS
  ok    plain FAIL                                     -> FAIL
  ok    markdown bold both sides                       -> PASS      (**VERDICT: PASS**)
  ok    markdown bold on colon                         -> PASS      (**VERDICT:** PASS)
  ok    bold value only                                -> FAIL      (VERDICT: **FAIL**)
  ok    lowercase                                      -> PASS
  ok    mixed case + spaces                            -> FAIL
  ok    underscore emphasis                            -> PASS
  ok    last one wins                                  -> FAIL
  ok    last one wins (reverse)                        -> PASS
  ok    empty output -> none                           -> (none)
  ok    no verdict at all -> none                      -> (none)
  ok    prose 'the verdict was fail'                   -> (none)
  ok    malformed word -> none                         -> (none)
  ok    truncated mid-word -> none                     -> (none)
  ok    heading form                                   -> PASS
  ok    trailing period                                -> FAIL

  17 ok, 0 failed
```

`(none)` means no verdict was parsed, which is now recorded as **ERROR /
INCONCLUSIVE** rather than FAIL.

### 2.5 `--dry-run`

Accepted in any position (`review.sh --dry-run 85` or `review.sh 85 --dry-run`).
It runs all three lenses for real and prints each lens's **exit code, verdict,
note and reasons**, plus the diff-size accounting — but posts no comment, applies
no label, and merges nothing. Dry-run lenses are real spawns and are still
charged against `DAILY_SPAWN_CAP`.

`review.sh` still has **no merge code path at all**, under any flag:

```
$ grep -nE "gh pr merge|--merge|--squash|--rebase|pr merge" factory/review.sh
no merge path present
```

---

## 3. Before / after on PR #85

| measurement | before | after |
|---|---|---|
| raw `gh pr diff 85 \| wc -l` | **8065 lines** | 8065 (unchanged, it is the input) |
| generated/vendored excluded | 0 | 2 files, **5768 lines** (`docs/package-lock.json` 4662, `docs/.chain/snapshot.json` 1106) |
| filtered diff | — | **2256 lines** |
| review diff after the 1500-line cap | — | **1335 lines** (cut at a file boundary) |
| prompt handed to one lens | 8079 lines / **317062 bytes** | 1489 lines / **65567 bytes** |
| vs. the 131072-byte `execve` limit | **2.42× over → E2BIG** | **0.50× — and now on stdin, so the limit no longer applies** |
| lens exit codes | 126, 126, 126 (`execve` E2BIG) | **0, 0, 0** |
| parseable verdicts | **0 of 3** | **3 of 3** |

Diff-line reduction: **8065 → 1335, 83.4% smaller.** Prompt-byte reduction:
**79.3%.**

Coverage on #85 is honestly **partial**: the 1500-line cap omits
`docs/reference/token-model.md`, `docs/scripts/check-chain-values.mjs` and
`docs/scripts/snapshot-chain.mjs`. That is stated in the prompt, logged as a
`WARN`, and repeated in the PR comment. Raising `MAX_REVIEW_DIFF_LINES` to ~2400
would give this PR full post-exclusion coverage; 1500 is kept as the default per
the round spec.

---

## 4. Dry-run on PR #85 — the regression proof

Command run (note the flag is accepted before the PR number):

```
$ ./factory/review.sh --dry-run 85
```

**All three lenses returned a parseable verdict and every exit code was
captured: `0`, `0`, `0` — zero ERROR, versus `126`, `126`, `126` and zero
parseable verdicts before.**

| lens | claude exit | verdict | before this fix |
|---|---|---|---|
| correctness | 0 | FAIL | exit 126, no output, scored FAIL by default |
| conformance | 0 | FAIL | exit 126, no output, scored FAIL by default |
| standing | 0 | PASS | exit 126, no output, scored FAIL by default |

**Read the verdicts carefully.** Two lenses still say FAIL — but for the first
time these are *real, cited findings from a model that actually read the diff*,
not the artefact of a failed `execve`. `correctness` fails on a wrong,
security-relevant claim about the unsafe RPC surface that contradicts the
sibling page, and on a join-verification recipe that curls the wrong port;
`conformance` fails on the same wrong port plus a three-way contradiction about
whether stake alone earns emissions. `standing` passes and says so explicitly.
The round brief assumed #85 was fine; the working reviewer disagrees on two
concrete, checkable points. That is the reviewer doing its job, and it is a
finding, not something to tune away. #85 is already merged; these are follow-up
issues for a human to triage, not something this round changes.

Note also that all three lenses used the truncation disclosure exactly as
intended — each one names the files it could not see, and both FAILing lenses
state that partial coverage is *not* the reason for the verdict ("Partial
coverage is not why I'm failing"; "That is a coverage limitation, not evidence
of weakening, so per the lens it is not a FAIL reason"). Requirement 2 —
no silent coverage loss — is demonstrably working.

Full verbatim output:

```
[2026-08-05T11:39:29Z] === fresh-context review of PR #85 ===
[2026-08-05T11:39:29Z] DRY RUN: lenses will run; nothing will be posted, labelled or merged.
[2026-08-05T11:39:31Z] diff: raw 8065 lines -> filtered 2256 -> review 1335 (mode: filtered)
[2026-08-05T11:39:31Z] 2 file(s) excluded as generated/vendored; names still shown to every lens
[2026-08-05T11:39:31Z] WARN: REVIEW DIFF TRUNCATED at 1500 lines — coverage is PARTIAL.
[2026-08-05T11:39:31Z] WARN: omitted files: docs/reference/token-model.md docs/scripts/check-chain-values.mjs docs/scripts/snapshot-chain.mjs 
[2026-08-05T11:39:31Z] WARN: raise MAX_REVIEW_DIFF_LINES in factory/config.env to widen coverage
[2026-08-05T11:39:31Z] PR #85 closes issue #73
[2026-08-05T11:39:31Z] running lens: correctness (1489-line prompt, 65567 bytes)
[2026-08-05T11:42:33Z] lens correctness => FAIL (claude exit 0)
[2026-08-05T11:42:33Z] running lens: conformance (1487-line prompt, 65428 bytes)
[2026-08-05T11:44:51Z] lens conformance => FAIL (claude exit 0)
[2026-08-05T11:44:51Z] running lens: standing (1491-line prompt, 65690 bytes)
[2026-08-05T11:46:13Z] lens standing => PASS (claude exit 0)
[2026-08-05T11:46:13Z] review status: FAIL (1 PASS / 2 FAIL / 0 ERROR)

===== DRY RUN — PR #85 — nothing posted, labelled, or merged =====
diff:   raw 8065 lines -> filtered 2256 -> review 1335  (mode: filtered)
excluded as generated/vendored: 2 file(s)
TRUNCATED at 1500 lines; omitted: docs/reference/token-model.md, docs/scripts/check-chain-values.mjs, docs/scripts/snapshot-chain.mjs

--- lens correctness: exit=0 verdict=FAIL ---
reasons (last 40 lines of the model stdout):
  ## Review — PR #85 (docs site)
  
  **Scope reality check.** This diff contains no Rust, no runtime code, no balance arithmetic, no mint sites, and no storage definitions. Every visible file is markdown, VitePress config, a markdownlint config, a `.gitignore`, and a docs-only `package.json`. None of the economic-defect classes in the lens (overflow, cap bypass, guard-after-move, root in settlement, rounding direction) are reachable from anything in the visible diff. The `package.json` adds only devDependencies (`@polkadot/api`, `markdownlint-cli2`, `vitepress`), and `@polkadot/api` is justified by the `snapshot:chain` script it ships alongside — no unjustified dependency.
  
  **What I verified positively.**
  - `docs/reference/rpc.md` `EraSnapshot` decode: I decoded the sample hex. It is exactly 64 bytes and yields `25 / 1500 / 5000 / 1000` at offsets 44/48/52/56, matching the offset table line-for-line. Correct, including little-endian claim and the "no length prefix" reasoning.
  - `docs/guide/run-a-node.md` GRANDPA table: `n - (n-1)/3` integer division gives 3/3/4/5 for n=3/4/5/7 and tolerated-down 0/1/1/2 — all four rows correct, and the "five buys nothing over four" claim is right.
  - Genesis split 7B+5B+3B+3B = 18B, shares 38.9/27.8/16.7/16.7 ✓.
  - Devnet port derivation (`30333+i`, `9944+i`, `9615+i`) matches its own table; the example node uses 30400/9960/9630, clear of both ranges ✓.
  - `2^53` plancks ≈ 9,007 CMN ✓ at 12 decimals. The pending-emissions formula divides last (`* weight / ACC_SCALE`), so bigint truncation rounds **down**, against the claimant — the correct direction.
  - Every internal link target I can resolve resolves: with `ignoreDeadLinks: false` (`docs/.vitepress/config.mts:19`), `#connect`, `#agent-lifecycle`, `#escrow`, `#retries-and-failure`, `#beyond-the-wrappers`, `#chain-properties`, `#run-as-a-validator`, `#fault-tolerance`, `#scalarcommonsapi`, `#chain-and-system` all have matching headings.
  
  **Defects.**
  
  1. **`docs/reference/rpc.md:19` contradicts `docs/guide/run-a-node.md:236`, and the rpc.md statement is factually wrong.** rpc.md says the unsafe set (`author_insertKey`, `author_rotateKeys`, …) is "reachable only from a node started with `--rpc-methods unsafe`". Substrate's default is `--rpc-methods auto`, which serves the *full* method set whenever RPC is on localhost. So unsafe methods are exposed on a default-configured loopback node — the docs understate the exposure. Meanwhile run-a-node.md's validator start command (`docs/guide/run-a-node.md:214-222`) passes no `--rpc-methods`, and step 2 then instructs curling `author_rotateKeys` at `http://127.0.0.1:9960`. Both pages cannot be right: if the devnet really runs `--rpc-methods safe` as rpc.md:17 asserts, the rotateKeys recipe is broken; if it runs `auto`, rpc.md's exposure claim is wrong. This is a security-posture statement in operator-facing docs, so it matters more than a typo.
  
  2. **`docs/guide/run-a-node.md:180-190` — the "Verify it joined" check queries the wrong node.** The preceding command starts the new full node on `--rpc-port 9960`, but the verification curl targets `http://127.0.0.1:9944`, which is alice. The recipe as written tells you nothing about whether *your* node joined, and the pasted `"peers":4` is consistent with alice's pre-join view of the other four validators — i.e. the sample output is what you'd see before the new node connected. Should be `:9960`, with `peers: 5`.
  
  3. **`docs/guide/sdk.md:106` hardcodes `MIN_STAKE = 1_000n * PLANCKS_PER_CMN` as `agents.minStake`, while `docs/guide/run-a-node.md:127` calls `10,000 CMN` "the minimum that qualifies for floor emissions".** These may be two distinct parameters, but neither figure carries a chain-check marker, and a 10× discrepancy between two pages of the same "verified against the runtime" doc set is exactly the drift the issue's gate exists to prevent. The same page later does it correctly (`client.api.consts.agents.minStake.toBigInt()` at sdk.md:412) — the literal should follow suit or be chain-checked.
  
  4. **`docs/index.md:65-69` overclaims: "Every number on this site is checked against a node … `npm run lint` fails if the prose drifts from it."** Exactly one `<!-- chain-check:… -->` directive appears in the entire visible diff (`docs/reference/rpc.md:283`, the pallet-index table). The "118 JSON-RPC methods" count, `tokenDecimals`/`ss58Format`, the genesis allocation table, the decoded auto-param values and `minStake` carry no marker. Whether the claim holds depends entirely on `check-chain-values.mjs`, which was truncated out — see blind spots. As written the claim is unsupported by anything I can see.
  
  5. **Minor / non-blocking:** `docs/index.md:31` describes weight as combining **√stake** with the other factors, whereas the closing issue's scope line says `stake x rank x oracle accuracy x …`. One of the two is imprecise; `token-model.md` is the authority and I can't see it. Also, the MD033 justification at `docs/.markdownlint-cli2.jsonc:11-12` cites "the chain-check directives" as the reason — HTML *comments* are not flagged by MD033, so that half of the rationale doesn't hold. Disabling MD013/MD024/MD033/MD034 is ordinary docs-lint config with stated reasons and does not read as weakening the gate in the sense the issue forbids (nothing was deleted, skipped, or stubbed).
  
  **What I could not see, and therefore did not check:** `docs/reference/token-model.md` (the entire supply-cap, emissions and weight-formula prose — the page most likely to contain an economically wrong claim), `docs/scripts/check-chain-values.mjs` and `docs/scripts/snapshot-chain.mjs` (the *enforcement* half of the gate; a no-op or over-permissive matcher there would make the whole "verified against a live node" claim hollow, and this is the single highest-value thing left unreviewed), `docs/.chain/snapshot.json` (so I cannot confirm `snapshot.runtime.specVersion`/`snapshot.chain.name` exist with the shape `config.mts:32,36,63` reads, which would fail the `build` half of the gate), and `docs/package-lock.json`. Partial coverage is not why I'm failing.
  
  Failing on finding 1 (a wrong, security-relevant statement about the unsafe RPC surface that also contradicts the sibling page's own instructions) and finding 2 (a verification recipe that verifies the wrong node). Both are small, concrete edits.
  
  VERDICT: FAIL

--- lens conformance: exit=0 verdict=FAIL ---
reasons (last 40 lines of the model stdout):
  ## Requirement-by-requirement
  
  **1. Run a node — build, chain spec, joining the devnet** — Delivered in substance. `docs/guide/run-a-node.md:1-319` covers toolchain pin and rationale (:10-30), build (:34-52), the four `--chain` presets plus the non-selectable mainnet builder (:56-91), chain properties and SS58 blocker (:95-108), genesis allocation (:112-127), raw spec generation (:131-146), joining as a full node with the pinned bootnode multiaddr (:150-180), devnet topology (:196-212), and validator setup with `author_rotateKeys` / `session.setKeys` (:230-278).
  
  But the "Verify it joined" step is broken: the full-node command starts on `--rpc-port 9960` (`docs/guide/run-a-node.md:171`), then the verification curls `http://127.0.0.1:9944` (`:185`) — alice's port, not the node you just started. The check passes whether or not your node joined, so it verifies nothing. The pasted response `{"peers":4,...,"shouldHavePeers":false}` (`:189`) confirms it was copied from the pre-existing devnet rather than from a newly joined node: a 6th node joining would see 5 peers, and `shouldHavePeers` is false only for a dev/no-bootnode node, not one started with `--bootnodes`. The validator section gets this right (`:265`, `:275` both use 9960), which makes the full-node section an isolated error, not a convention.
  
  **2. SDK usage — install, connect, the extrinsics and reads** — Delivered. Install (`docs/guide/sdk.md:22-42`), connect incl. bring-your-own-`ApiPromise` (:44-72), signers (:74-90), plancks (:92-108), and extrinsic coverage across agents/escrow/oracle/emissions/orchestrator/auto-params (:110-268) plus reads (:270-320) and the escape hatch to `client.api` (:322-350).
  
  **3. RPC reference — custom runtime APIs and the standard surface** — Delivered, and the most convincingly verified page. `ScalarCommonsApi`'s four methods with signatures (`docs/reference/rpc.md:41-46`), the explicit caveat that they are *not* registered as named JSON-RPC methods (:48-54), `state_call` usage, and a byte-offset decode of `EraSnapshot` (:76-101) whose hex payload actually decodes to the tabulated values (`completion_fee_bps` 25 = `19000000` LE, `alpha` 1500 = `dc050000`, `beta` 5000 = `88130000`, `floor_bps` 1000 = `e8030000`; 128 hex chars = the stated 64 bytes). Standard surface (:143-213), 13 runtime APIs of which 12 standard — the table has exactly 13 rows (:217-232). Pallet indices with the 34–36/38–41 history (:236-283).
  
  **4. Token model** — `docs/reference/token-model.md` is in the changed-files list but its body was truncated out. I could not check the 10^12 plancks / 100B cap / 18B mint / weight-formula requirements against it. Supporting evidence in visible files is consistent (`run-a-node.md:98` 12 decimals; `:112-127` 18B split summing correctly; `index.md:60-62` 100B cap).
  
  **5. Gate + live-node verification** — `docs/package.json` supplies working `lint` and `build` scripts; `npm ci` is satisfiable (`package-lock.json` is in the changed-files list). Lint is markdownlint **plus** `node scripts/check-chain-values.mjs`, and `snapshot:chain` regenerates `.chain/snapshot.json` from a live node — the right shape for "documented values must match the runtime." I could not see `check-chain-values.mjs`, `snapshot-chain.mjs`, or `snapshot.json`, so I cannot confirm the check actually asserts anything rather than exiting 0; that is missing material, not a finding against the PR.
  
  ## Changes no requirement asked for
  
  Very little. `docs/.gitignore`, `.markdownlint-cli2.jsonc`, `.vitepress/config.mts` and `index.md` are all load-bearing for the `lint`/`build` gate the issue explicitly scopes in. `srcExclude` (`config.mts:15`) and the lint globs deliberately leave the pre-existing `VERIFIED-CONSTANTS.md` / `rfcs/` alone — no opportunistic edits to untouched files. All three devDependencies map to a stated need: `vitepress` = build, `markdownlint-cli2` = lint, `@polkadot/api` ^15.9.2 = reading live metadata as the issue demands. No unjustified dependency.
  
  Minor: `MD034` is disabled (`.markdownlint-cli2.jsonc:17`) on the rationale that "bare URLs are legitimate in an RPC endpoint reference," but the RPC reference has no bare URLs — every endpoint is in backticks. A rule switched off without a demonstrated need, in a config authored as part of the gate.
  
  ## Defects
  
  1. **Wrong port in the join-verification step** (`docs/guide/run-a-node.md:171` vs `:185`) — the check queries alice instead of the reader's node and therefore cannot fail; the sample output at `:189` is alice's, not the new node's.
  2. **Contradiction on whether stake alone earns.** `run-a-node.md:129-131` says genesis validators get 10,000 CMN agent stake, "the minimum that qualifies for floor emissions from era 1." `index.md:37` says "A pure staker who does no escrow work earns exactly zero," and `sdk.md:437` says "weight is zero without escrow volume." `rpc.md:118` describes `floor_bps` as a "Live activity floor for qualifying agents." Either stake alone qualifies for the floor or it earns exactly zero; the three pages state both. The unseen token-model page may resolve this, but as shipped the reader gets opposite answers on the PR's headline economic claim.
  3. Minor: `rpc.md:252` states Sudo was "Removed by referendum after launch" as accomplished fact for a chain that has not launched.
  
  Files I could not see and therefore did not check: `docs/reference/token-model.md`, `docs/scripts/check-chain-values.mjs`, `docs/scripts/snapshot-chain.mjs`, `docs/.chain/snapshot.json`, `docs/package-lock.json`. I also could not verify that the `deploy/*` scripts referenced throughout `run-a-node.md` exist, since they are outside this diff.
  
  Scope discipline is good and the RPC page shows real verification against a node. But requirement 1's verification procedure is wrong in a way a reader following the page would be misled by, and the emissions claim is self-contradictory across three delivered pages — partial delivery on the issue's core promise that documented values match the runtime.
  
  VERDICT: FAIL

--- lens standing: exit=0 verdict=PASS ---
reasons (last 40 lines of the model stdout):
  ## Standing-rule review — PR #85 (docs site)
  
  ### What I checked and found clean
  
  **No tests touched.** The diff adds no test files and deletes/renames/skips none. No `it.skip`/`xit`/`describe.skip`/`#[ignore]`, no commented-out cases, no assertions weakened — there are no assertions in the visible material to weaken.
  
  **No stubs.** No `todo!()`/`unimplemented!()`/`unreachable!()`, no empty function bodies, no `fn main() {}`. The only executable code in the visible diff is `docs/.vitepress/config.mts`, which is a real config, not a stub.
  
  **No build short-circuit.** `SKIP_WASM_BUILD` appears exactly once, in `docs/guide/run-a-node.md:40-43`, as a `::: warning Never set SKIP_WASM_BUILD` block — i.e. prose telling operators *not* to do it. That is the opposite of a violation.
  
  **The gate is chained strictly, not loosened.** `docs/package.json:12` is `markdownlint-cli2 "index.md" "guide/**/*.md" "reference/**/*.md" && node scripts/check-chain-values.mjs` — `&&`, no `|| true`, no `--no-run` equivalent, and the chain-value check is inside the gate rather than bolted on outside it. `build` (line 10) is a plain `vitepress build .`. No timeouts, no retries, no failure swallowing.
  
  **Link checking left strict.** `docs/.vitepress/config.mts:19` sets `ignoreDeadLinks: false` with a comment that a broken internal link should fail the build. The cheap escape here would have been `ignoreDeadLinks: true`; it wasn't taken.
  
  **No error swallowing.** No empty catch, `let _ =`, or `unwrap_or_default` in the visible code.
  
  **Dependencies justified.** All three devDeps map to a stated need: `vitepress` (build), `markdownlint-cli2` (lint), `@polkadot/api ^15.9.2` (reading live-node metadata for `snapshot:chain`, which the issue explicitly requires). No unexplained additions.
  
  ### Observations that are not violations, stated for the record
  
  - `docs/.markdownlint-cli2.jsonc:9,12,15,17` disables MD013/MD033/MD034 and relaxes MD024 to `siblings_only`. I considered this as the markdown analogue of `#[allow(...)]`. It is not a rule-weakening under this lens: there was no pre-existing docs lint to weaken — creating the lint script is part of the issue scope — and each disable carries a rationale. Two of the rationales don't match anything I can see, though: MD033 is justified by "raw HTML for containers", but VitePress `:::` containers are not HTML and the sole HTML in the visible pages is the `<!-- chain-check:pallet-index -->` comment (`docs/reference/rpc.md`), which MD033 does not flag; MD034 is justified by "bare URLs in an RPC reference", but every URL in the visible pages is inside a code span, fenced block, or link syntax. Over-broad config authored at creation time, not a check made to stop checking.
  - `docs/.vitepress/config.mts:16` excludes `VERIFIED-CONSTANTS.md`, `rfcs/**`, `README.md` from the site source. This does shrink what `ignoreDeadLinks: false` can fail on. I judged it legitimate: those are pre-existing engineering records that were never site pages, and publishing them as routes would be wrong independent of the gate.
  
  ### What I could not see
  
  Diff bodies were withheld for `docs/reference/token-model.md`, `docs/scripts/check-chain-values.mjs`, `docs/scripts/snapshot-chain.mjs` (truncation) and `docs/.chain/snapshot.json`, `docs/package-lock.json` (generated/vendored). The consequential gap is `check-chain-values.mjs`: it is half the `lint` gate, and `docs/index.md:66-70` claims "`npm run lint` fails if the prose drifts from it." I cannot verify that script actually asserts anything — a version that exits 0 unconditionally, or that only checks the single `chain-check:pallet-index` marker while the site quotes dozens of unmarked constants, would look identical from here. Only one chain-check directive exists across the four visible pages. That is a coverage limitation, not evidence of weakening, so per the lens it is not a FAIL reason — but it is the file to read first if this lens is re-run with full coverage.
  
  On the material I was actually given, none of the enumerated escapes appear.
  
  VERDICT: PASS

===== DRY RUN SUMMARY: 1 PASS / 2 FAIL / 0 ERROR => FAIL =====
WOULD: post a verdict comment on PR #85
WOULD: label needs-human
WOULD NOT: merge — review.sh has no merge path, under any flag
EXIT=1
```

Exit code 1 = at least one lens returned FAIL. Exit 2 would mean INCONCLUSIVE
(one or more ERROR); exit 0 means a clean review. Nothing was posted, no label
was applied, and nothing was merged.

---

## 5. What I did NOT change

- **Nothing outside `factory/review.sh` and `factory/config.env`.** No pallet,
  runtime, indexer, CI, `dispatch.sh`, `merge.sh`, or `lib/common.sh` change.
- **No lens prompt was weakened.** The three lens texts are byte-identical apart
  from two additions: the conformance lens is told to use the complete file list
  and manifest diff to judge scope creep, and the shared verdict instruction now
  says that uncertainty caused by *material the reviewer was not given* is not a
  reason to FAIL (uncertainty about the **code** still is). No lens was made
  lenient, no auto-pass exists, and no review is skipped.
- **Fail-closed behaviour is preserved and tightened.** An unreviewable PR still
  cannot be labelled `agent-reviewed`; it now gets `needs-human` and exit 2
  instead of three fabricated FAILs. `merge.sh` blocks on both, so the merge
  gate is no weaker than before — it is strictly stronger, because
  `agent-reviewed` now also requires that every lens actually ran.
- **`review.sh` still never merges.** No merge path was added; the `--dry-run`
  flag removes side effects, it does not add any.
- **The 3-lens / 2-of-3 structure, the fresh-context isolation, the out-of-repo
  working directory, and the spawn-budget reservation are unchanged.**
- **`ENABLE_DISPATCH=true`** is an uncommitted local edit in the working tree
  that predates this round. It is deliberately **not** included in this commit;
  `config.env` in this branch carries only the four new review knobs.

### Known follow-up, deliberately out of scope

`factory/tests/verdict-parse.sh` contains its **own copy** of the old parsing
pipeline and asserts the old rules (`lowercase verdict fails closed (strict)`,
and "no verdict → FAIL"). It still passes, because it tests its private copy and
never invokes `review.sh`. It now documents behaviour that `review.sh` no longer
has. Updating it means touching a third file, which this round's scope forbids,
so it is flagged rather than changed.

---

## 6. Verification performed

- `shellcheck -x factory/review.sh` → **clean, exit 0** (shellcheck 0.10.0). The
  only finding without `-x` is `SC1091` "not following lib/common.sh", which is
  informational and also present on the pre-change file.
- `bash -n factory/review.sh` → clean.
- Verdict parser: 17/17 cases (§2.4).
- Argument handling: no args, unknown flag, two PR numbers → usage + `FATAL`,
  exit 1; `--help` → exit 0.
- Spawn-cap path: `DAILY_SPAWN_CAP=0 ./factory/review.sh --dry-run 85` → three
  `ERROR` results, status `INCONCLUSIVE`, exit 2, no fabricated FAILs.
- Live dry-run on PR #85 (§4).
