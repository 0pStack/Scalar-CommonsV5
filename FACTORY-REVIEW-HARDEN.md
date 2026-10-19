# FACTORY-REVIEW-HARDEN — durable prompt delivery, full coverage, a test that tests the real code

**Branch:** `factory/review-harden` · **Files changed:** `factory/review.sh`,
`factory/config.env`, `factory/tests/verdict-parse.sh` · **Nothing merged.**
**No `ENABLE_DISPATCH` change** — it stays exactly as committed on master (`false`).

Follow-up to #86. That PR stopped the reviewer from failing every lens; this one
removes the fragility that was left behind, restores full coverage on #85-class
PRs, and replaces a safety test that was green while asserting the wrong rules.

---

## 1. Durable prompt delivery — and a correction to the round's premise

**The round's framing was that #86 fixed E2BIG "by shrinking the prompt", leaving
the 1500-line cap as the only thing preventing its return. That is not what #86
did.** #86 changed the delivery mechanism at the same time as adding the caps, and
the mechanism is what made the bug impossible. `review.sh` on master already reads:

```bash
( cd "$WORK" && timeout "$REVIEW_LENS_TIMEOUT" claude -p --dangerously-skip-permissions ) \
  < "$pf" > "$out" 2> "$err"
```

A `< file` redirect hands the child a **file descriptor**. The prompt is never an
`argv` element, so `MAX_ARG_STRLEN` is not consulted and `execve()` cannot return
`E2BIG` — at any diff size. So there was no argv-string delivery left to remove.

That said, the round's underlying concern was legitimate and is now addressed:
**nothing was stopping a future edit from turning delivery back into an argument**,
and the caps were documented in a way that let them be mistaken for the E2BIG
defence. Three changes fix that:

1. **The header and the inline comment now state explicitly** that the redirect —
   not the caps — is what makes E2BIG impossible, and that the caps exist for
   reviewability only. `config.env` says the same thing where the caps are set.
2. **`factory/tests/verdict-parse.sh` now asserts the delivery mechanism** (§4). If
   anyone reintroduces `claude -p "$(cat "$pf")"`, the test goes red. This is the
   durable part: a comment asks nicely, a test enforces.
3. **The raised caps make stdin load-bearing in practice, not just in theory.** At
   `MAX_REVIEW_DIFF_BYTES=200000` plus lens/file-list/manifest overhead, a prompt
   can now reach ~206 KB — **above** the 131072-byte argv limit. Under the old
   1500-line cap the prompt happened to stay under it; it no longer does.

### Proof: the exact prompt that failed, through the new path

The same 317062-byte prompt from PR #85, run both ways:

```
### A) OLD path — prompt as argv
( cd work && timeout 900 claude -p "$(cat old85.prompt)" --dangerously-skip-permissions )
rc=126  stdout_bytes=0
/bin/bash: line 13: /usr/bin/timeout: Argument list too long

### B) NEW path — same 317062-byte prompt on stdin (review.sh's exact form)
( cd work && timeout 900 claude -p --dangerously-skip-permissions ) < old85.prompt
rc=0
prompt_bytes=317062  (single-argv limit = 131072, so 2.42x over)
stdout_bytes=7943
--- stderr --- (empty)
--- last lines of stdout ---
VERDICT: FAIL

### parsed by the REAL parser
$ ./factory/review.sh --classify 0 new.out
FAIL
```

**Exit 0 on a prompt 2.42× the argv limit.** Same input, same machine, same
`claude` binary: argv fails, stdin succeeds. E2BIG cannot recur regardless of diff
size, and the caps are free to be set for reviewability rather than for exec
safety.

---

## 2. Caps raised, and a byte ceiling added

| knob | before | after |
|---|---|---|
| `MAX_REVIEW_DIFF_LINES` | 1500 | **2500** |
| `MAX_REVIEW_DIFF_BYTES` | *(did not exist)* | **200000** |

**Why 2500.** #85's post-exclusion diff is 2256 lines. At 1500 it was truncated,
and the truncation did not merely lose findings — **it manufactured two false
ones**, both traced in the previous round:

- a `√stake` vs `stake` "discrepancy" that `token-model.md:148,162` explicitly
  resolves ("The base is `√stake`, not `stake`. This is the anti-whale term") — the
  page had been truncated out
- "exactly one `chain-check` directive appears" when there are **ten** — nine of
  them in the same truncated page

2500 gives that class of PR full coverage. This is the strongest argument for the
cap being generous: a reviewer reasoning from a gap does not stay silent, it
confabulates.

**Why a byte ceiling.** Lines are a bad proxy for size. A diff of
generated-but-not-globbed content — one-line JSON blobs, embedded base64, a
minified file that dodged `REVIEW_EXCLUDE_GLOBS` — can be a handful of lines and
megabytes of bytes. It would sail under a 2500-line cap and produce an
unreviewably huge prompt. Both ceilings now apply, whichever binds first, and the
truncation logic reports **which one** bound:

```
warn "REVIEW DIFF TRUNCATED by the ${TRUNC_REASON} — coverage is PARTIAL."
warn "shown: $REVIEW_LINES lines / $REVIEW_BYTES bytes of $FILTERED_LINES lines / $FILTERED_BYTES bytes"
```

Truncation still happens at **file boundaries** (never mid-hunk), still lists every
omitted file, and the prompt still carries the disclosure sentence verbatim — now
with the binding ceiling named:

```
diff truncated at N lines; omitted files: <list>
Ceiling that bound: byte cap (200000 bytes). Shown N lines / M bytes of P lines / Q bytes.
```

A single file larger than an entire ceiling still emits the prefix that fits and is
declared `(cut mid-file)` rather than vanishing.

---

## 3. #85 now gets full coverage

```
$ ./factory/review.sh --dry-run 85
```

**0 files omitted. `not truncated`. 3 of 3 parseable verdicts. Every lens
`claude exit 0`.**

| | at cap 1500 (#86) | at cap 2500 (now) |
|---|---|---|
| filtered diff | 2256 lines | 2256 lines |
| **reviewed** | **1335 lines** | **2256 lines / 98449 B** |
| files omitted by truncation | **3** | **0** |
| truncation warning | yes, PARTIAL coverage | `not truncated` |
| prompt per lens | 1489 lines / 65567 B | 2405 lines / 104509 B |
| lens exit codes | 0, 0, 0 | 0, 0, 0 |
| parseable verdicts | 3 of 3 | 3 of 3 |

`token-model.md`, `check-chain-values.mjs` and `snapshot-chain.mjs` — the three
files truncated away at 1500 — are now all in the review.

### The two false findings are gone

Grepping the new run for them:

```
=== 1. √stake / sqrt-vs-stake "discrepancy" claims ===
  NONE — no lens reports a √stake vs stake discrepancy
=== 3. truncation / "could not see" complaints ===
  line 19:  not truncated
  line 125: ### What I could not see   <- about the EXCLUDED generated files only
```

**The `√stake` false finding is not merely absent — it inverted.** With the page
visible, the conformance lens now writes:

> The formula documents `√stake` and heartbeat/onboarding terms beyond the issue's
> five — that is the runtime being reported accurately, which the issue requires,
> not embellishment.

**The `chain-check` false finding was replaced by a real one.** "Only one directive
exists" (wrong — there are ten) became a specific, cited defect that is only
findable *with* the file:

> **"Every raw value on this page is … mechanically re-checked" is false as
> written.** … `check-chain-values.mjs` only inspects tables armed with
> `<!-- chain-check:constants -->` (`:~185–200`). At least five raw values are
> quoted in prose and therefore escape the gate entirely:
> `maxEmissionOverrideEras` "raw `10`" (`:~115`), `maxBatchClaimSize` "raw `100`"
> (`:~137`), `orchestratorEmissionMultiplier` "raw `5000`" and
> `maxOrchestratorFeeBps` "raw `500`" (`:~300–305`), `slashAppealWindow` "raw `10`"
> (`:~350`). These will rot silently while the page promises they cannot.

That is direct evidence for issue #89's Task 1 — and the reviewer could not produce
it until the cap was raised. The remaining "what I could not see" is confined to the
two *deliberately excluded* generated files, and the standing lens frames it
correctly: "a limit of the material I was given, not a defect I found in the code."

### Verdicts

`1 PASS / 2 FAIL / 0 ERROR => FAIL`, script exit 1. The FAILs are again real cited
findings, now better ones — the genesis-stake/floor-emissions contradiction and the
overclaimed mechanical-verification coverage above. Script exit 1 reflects those
FAIL verdicts; the round's "exit 0 per lens" is satisfied — every `claude` call
exited 0, which is the thing that was broken.

Full verbatim output:

```
[2026-08-06T20:11:26Z] === fresh-context review of PR #85 ===
[2026-08-06T20:11:26Z] DRY RUN: lenses will run; nothing will be posted, labelled or merged.
[2026-08-06T20:11:27Z] diff: raw 8065 lines -> filtered 2256 (98449 B) -> review 2256 lines / 98449 B (mode: filtered)
[2026-08-06T20:11:27Z] caps: 2500 lines / 200000 bytes
[2026-08-06T20:11:27Z] 2 file(s) excluded as generated/vendored; names still shown to every lens
[2026-08-06T20:11:28Z] PR #85 closes issue #73
[2026-08-06T20:11:28Z] running lens: correctness (2405-line prompt, 104509 bytes)
[2026-08-06T20:15:07Z] lens correctness => FAIL (claude exit 0)
[2026-08-06T20:15:07Z] running lens: conformance (2403-line prompt, 104370 bytes)
[2026-08-06T20:20:39Z] lens conformance => FAIL (claude exit 0)
[2026-08-06T20:20:39Z] running lens: standing (2407-line prompt, 104632 bytes)
[2026-08-06T20:22:59Z] lens standing => PASS (claude exit 0)
[2026-08-06T20:22:59Z] review status: FAIL (1 PASS / 2 FAIL / 0 ERROR)

===== DRY RUN — PR #85 — nothing posted, labelled, or merged =====
diff:   raw 8065 lines -> filtered 2256 -> review 2256 lines / 98449 B  (mode: filtered)
caps:   2500 lines / 200000 bytes
excluded as generated/vendored: 2 file(s)
not truncated

--- lens correctness: exit=0 verdict=FAIL ---
reasons (last 40 lines of the model stdout):
  ## Findings
  
  **1. `docs/guide/run-a-node.md` (~line 112, § Genesis allocation) directly contradicts this PR's own economic invariant.**
  
  > "pre-register each genesis validator as an agent with `10,000 CMN` of agent stake — the minimum that qualifies for floor emissions from era 1."
  
  `docs/reference/token-model.md` § "What earns nothing" states the opposite, mechanically:
  
  ```
  era_volume == 0
    → is_active = false            → effective_floor = 0
    → activity = 0
    → weight = √stake × rank × 0 × heartbeat = 0
  ```
  
  and its threshold table requires `≥ 50 CMN` era escrow volume before any floor baseline applies. A genesis validator holding 10,000 CMN of stake and doing no escrow work earns **zero**, not floor emissions, in era 1 or any era. `agents.fullFloorStake` is the stake at which the floor baseline is *full*, not a qualification for receiving it. This is the single claim the whole PR exists to make ("emissions pay for verifiable work, not for holding tokens" — `docs/index.md`), and one of the two pages gets it backwards. A node operator reading only the run-a-node guide is told stake alone pays.
  
  **2. `docs/reference/token-model.md` § Supply asserts an unverified absolute about mint paths.**
  
  > "2. **All minting flows through pallet-emissions.** No other pallet has a mint path."
  
  This is a supply-cap invariant stated in prose, checked by nothing — `check-chain-values.mjs` verifies constant values, pallet indices and surface coverage, but has no notion of mint sites. Meanwhile the same PR's pallet index table (`docs/reference/rpc.md`) lists `Staking` at 34 and `NominationPools` at 32, and `run-a-node.md` § "Run as a validator" instructs operators to call `staking.validate` — so pallet-staking is live with a real validator set. Stock `pallet-staking` era payouts mint. Either the runtime configures a non-minting payout (in which case the docs should say so, since it is load-bearing for the cap) or the sentence is false. I cannot see `runtime/src/lib.rs`, so I am flagging the assertion, not confirming a breach — but an unqualified "no other pallet has a mint path" published next to a staking pallet is not something to ship on trust.
  
  **3. The gate cannot deliver the guarantee the PR claims for it.** `check-chain-values.mjs:34` reads `.chain/snapshot.json` and nothing else; the file is committed, excluded from this diff, carries no hash/signature, and is bound to a live node only by a `$comment` asking humans not to hand-edit it. So "verified against the live node" (issue requirement) degrades to "verified against a JSON blob someone committed." Nothing in the gate re-derives it or detects drift. **Concretely: I could not verify a single raw value in this PR** — every `100000000000000000000000`, every pallet index, `spec 304`, the 118-method count — because the only artifact that would prove them was excluded as generated. All I could check was internal consistency (unit conversions, 7B+5B+3B+3B = 18B, block→time arithmetic, the 64-byte `EraSnapshot` layout and its little-endian sample decode, the GRANDPA `n-(n-1)/3` table) — those are all self-consistent.
  
  **4. `check-chain-values.mjs:118-127` — prose facts are unanchored substring matches.** `text.includes('42')` for `ss58Format` and `text.includes('118')` for the RPC method count pass on any incidental occurrence of those digits anywhere on the page. `run-a-node.md` contains `42` in several unrelated contexts. These checks report as passing without testing anything.
  
  **5. Boundary error, `docs/reference/token-model.md` § What earns nothing.** The table says volume `10 – 50 CMN` yields a positive work score, but the row above states `log2_scaled` "adds 1,000 bps per doubling of volume **above** `unitVolume`" — at exactly `era_volume == unitVolume` (10 CMN) there are zero doublings, so the score is 0 and emissions are zero. The interval should be exclusive at 10. The same table also introduces a `heartbeat ≥ 90` condition on the floor baseline that appears in no formula elsewhere on the page.
  
  **6. `docs/reference/token-model.md` § Supply undercounts the cap copies.** Prose: "The two copies are listed in the table above and are checked against each other by the docs gate." `check-chain-values.mjs:96-102` checks **three** (`emissions.supplyCap`, `orchestrator.supplyCap`, `constitution.supplyCap`); `orchestrator.supplyCap` is never documented with its raw value anywhere. The invariant check is the stronger artifact here — the prose is what is wrong.
  
  **7. `docs/guide/run-a-node.md` (~line 167).** The full-node example starts the new node on `--rpc-port 9960`, then "Verify it joined" curls `http://127.0.0.1:9944` — alice's port, not the node you just started. The pasted response (`"peers":4`, `"shouldHavePeers":false`) is consistent with querying an existing devnet member, not a freshly joined sixth node.
  
  ## Not findings
  
  Dependency additions (`@polkadot/api ^15.9.2`, `markdownlint-cli2 ^0.18.1`, `vitepress ^1.6.3`) are all `devDependencies`, each justified by a script in `package.json`, and pinned at install time by the committed lockfile. `snapshot-chain.mjs` reads only runtime-defined facts and excludes volatile state — correct call. `check-chain-values.mjs:56-79`'s `REQUIRED_CONSTANTS` list is a good defence against the "delete rows to raise the pass rate" failure mode, and the cross-pallet `INVARIANTS` evaluate relationships rather than quoting them. Rounding direction in both documented accumulator formulas (`pool × ACC_SCALE / total_weight`, `(acc − debt) × snapshot / ACC_SCALE`) truncates against the claimant, which is the safe direction. No gate was weakened to make anything green.
  
  The FAIL is on finding 1 — a self-contradictory statement about who gets paid, in the PR whose entire purpose is to state that correctly — reinforced by 2, 3 and 5.
  
  VERDICT: FAIL

--- lens conformance: exit=0 verdict=FAIL ---
reasons (last 40 lines of the model stdout):
  ## Requirement-by-requirement
  
  **1. Run a node — build, chain spec, joining the devnet**
  Delivered. Build and toolchain (`docs/guide/run-a-node.md:9–52`), four `--chain` presets plus the non-selectable mainnet builder (`:54–85`), raw chainspec generation (`:120–136`), full-node join with bootnode multiaddr (`:138–157`), validator path with `author_rotateKeys` / `session.setKeys` (`:~180–215`). Satisfied in substance.
  
  **2. SDK usage — install, connect, extrinsics and reads**
  Delivered. Install (`docs/guide/sdk.md:~29–45`), `connect` / `ApiPromise` construction (`:~47–75`), write surface tabulated per pallet (agents `:~110–125`, escrow `:~180–195`, oracle `:~215–225`, emissions `:~245–255`, orchestrator `:~275–290`), reads (`:~320–345`). Satisfied.
  
  **3. RPC reference — custom runtime APIs and the standard surface**
  Delivered. `ScalarCommonsApi` with all four signatures plus the honest note that no JSON-RPC wrappers are registered (`docs/reference/rpc.md:~30–60`), `state_call` encoding with a byte-level `EraSnapshot` layout (`:~75–110`), standard surface enumerated with explicit absences (`:~170–260`), pallet indices (`:~300–345`). Satisfied. The hex sample at `:~85` decodes correctly against the offset table (88 zero nibbles, then `19000000`/`dc050000`/`88130000`/`e8030000`/`00000000` = 25/1500/5000/1000/0, 64 bytes) — this one was actually computed, not invented.
  
  **4. Token model**
  Delivered. 1 CMN = 10^12 plancks (`docs/reference/token-model.md:12–16`), 100B cap with three enforcement paths (`:27–46`), 18B genesis mint and its four-way split (`:29`, `:53–58`), weight formula with all five issue-named terms (`:~200–210`). Arithmetic self-checks: 3,600 blocks × 6s = 6h → 1,460 eras/yr; 82B ÷ 1.46B ≈ 56 yr; 10,800/1,296,000/432,000/100,800 blocks = 18h/90d/30d/7d; every planck raw value matches its decimal gloss. The formula documents `√stake` and heartbeat/onboarding terms beyond the issue's five — that is the runtime being reported accurately, which the issue requires, not embellishment.
  
  **5. Gate created, not weakened**
  `docs/package.json` provides `lint` and `build`; lockfile present for `npm ci`. `check-chain-values.mjs` is a real gate, not a rubber stamp: `REQUIRED_CONSTANTS` (22 entries, `:~55–80`) prevents deleting rows from raising the pass rate, `INVARIANTS` (`:~95–105`) evaluates cross-pallet relations rather than quoting them, and extrinsic/API coverage is enforced against the snapshot (`:~275–300`). Nothing stubbed, no assertion neutered.
  
  ## Changes no requirement asked for
  
  `docs/.gitignore`, the VitePress theme chrome (nav spec badge, footer, social link at `docs/.vitepress/config.mts:33–63`), and `docs/index.md` are all site scaffolding a "create the docs site" issue implies; `index.md` is additionally load-bearing (`check-chain-values.mjs:~155` reads it unconditionally). The three devDependencies each trace to a requirement — `vitepress`→build, `markdownlint-cli2`→lint, `@polkadot/api`→live-node snapshot. **No scope creep found.** Notably, `docs/VERIFIED-CONSTANTS.md` is *not* edited despite being known-stale; the discrepancy is reported instead (`token-model.md:~418–424`), which is the correct handling under the standing rule.
  
  ## Findings
  
  **A. The "Verify it joined" step verifies the wrong node.** `docs/guide/run-a-node.md:149–157` starts the new full node on `--rpc-port 9960`, then `:~172` curls `http://127.0.0.1:9944` — which the topology table at `:~230` identifies as alice, an existing validator. A reader following this gets a green result whether or not their node joined; the check cannot fail for the reason it claims to test. The pasted output at `:~176` compounds it: `"peers":4` is alice's pre-join count (a joined 6th node would see 5), and `shouldHavePeers:false` is what a `--dev` node reports, not a node started with `--chain <raw json>` and bootnodes. On a page whose selling point is that its output was captured from the live devnet, this sample was not.
  
  **B. "Every raw value on this page is … mechanically re-checked" is false as written.** The Provenance section (`token-model.md:~380`) and the intro (`:7`) assert blanket mechanical coverage, but `check-chain-values.mjs` only inspects tables armed with `<!-- chain-check:constants -->` (`:~185–200`). At least five raw values are quoted in prose and therefore escape the gate entirely: `maxEmissionOverrideEras` "raw `10`" (`:~115`), `maxBatchClaimSize` "raw `100`" (`:~137`), `orchestratorEmissionMultiplier` "raw `5000`" and `maxOrchestratorFeeBps` "raw `500`" (`:~300–305`), `slashAppealWindow` "raw `10`" (`:~350`). These will rot silently while the page promises they cannot. Either arm them or stop claiming universal coverage.
  
  ## What I could not check
  
  `docs/.chain/snapshot.json` and `docs/package-lock.json` were excluded, so I cannot confirm the snapshot was captured from the live spec-304 node rather than hand-authored, nor that the lockfile satisfies `npm ci`. Consequently `118` RPC methods, `v15` metadata, every raw constant value, and the completeness of the extrinsic-coverage check are unverified from my side — the design (loud failure if `runtimeApis` is empty, `check-chain-values.mjs:~305`) is sound, but the input is opaque to me. Neither finding above rests on this.
  
  Findings A and B are both localized and cheaply fixed (change one port and one sample payload; arm or soften five prose claims), but A ships a verification procedure that cannot detect the failure it exists to detect, on the exact requirement — "joining the devnet" — the issue named.
  
  VERDICT: FAIL

--- lens standing: exit=0 verdict=PASS ---
reasons (last 40 lines of the model stdout):
  ## Standing-rule review — PR #85 (docs site)
  
  **Structural observation first:** every file in this PR is `new file mode`. Nothing pre-existing is modified or deleted. There is no prior test, assertion, CI config, or build step in this diff that *could* have been weakened — the site, its lint script, and its checker are all created here.
  
  ### Checklist, item by item
  
  - **Tests deleted / renamed / commented out / skipped / `#[ignore]` / `it.skip` / `xit` / `describe.skip`** — none. No test file is touched. `docs/guide/sdk.md:36-41` *documents* `npm test` and `npm run test:integration` for the SDK workspace without altering them.
  - **Assertions weakened** — none. The only assertion machinery is new: `docs/scripts/check-chain-values.mjs` asserts exact raw-value equality (`!spans.includes(raw)` → error), exact pallet-index equality (`claimed !== String(idx)` → error), and `BigInt` comparison for cross-pallet invariants. Nothing is loosened to a range or truthiness check.
  - **`todo!()` / `unimplemented!()` / empty bodies / `fn main() {}`** — none; no Rust and no node/runtime paths are touched.
  - **`#[allow(...)]` / `eslint-disable`** — no `eslint-disable` anywhere. The nearest analogue is markdownlint rule config at `docs/.markdownlint-cli2.jsonc:9,12,15,17` (`MD013:false`, `MD033:false`, `MD024 siblings_only`, `MD034:false`). I examined each: MD013 (line length) cannot be "fixed" in a table-heavy reference — markdown tables are unwrappable; MD024 `siblings_only` is the standard setting; MD033 and MD034 disable rules that, scanning the four linted pages, nothing appears to violate (every URL is inside a markdown link or a code span, and I found no raw HTML elements — VitePress `::: warning` containers and `<!-- chain-check -->` comments are not what MD033 flags). This is authoring a new linter's ruleset with stated rationale, not silencing a firing lint. Rules that could catch real doc defects — MD040 (fenced-code language), MD041, MD047, MD001 — remain active.
  - **`SKIP_WASM_BUILD` / build steps disabled** — the opposite. `docs/guide/run-a-node.md:44-47` carries an explicit `::: warning Never set SKIP_WASM_BUILD` block. No build step is short-circuited.
  - **Gate or CI relaxed** — no CI config in the diff. The gate scripts are authored, not narrowed: `docs/package.json:12` runs `markdownlint-cli2` **and** `node scripts/check-chain-values.mjs` (the second is optional extra rigor, not required by the issue). No `|| true`, no `--no-run`, no inflated timeout. `docs/.vitepress/config.mts:19` sets `ignoreDeadLinks: false` — `true` was the cheap escape and was not taken.
  - **Silent error swallowing** — one empty handler, at `docs/scripts/snapshot-chain.mjs:37`. It is cleared on inspection: `ApiPromise.create` is called with `throwOnConnect: true` inside a `try/catch` that prints the endpoint and `process.exit(1)` on failure, so an unreachable node is a loud, blocking failure — matching the issue's "if the node is not reachable, that is a blocking finding." The handler suppresses duplicate reporting only. In `check-chain-values.mjs`, `if (raw === undefined) continue` in the constants loop is structurally required (the dotted-name regex also matches extrinsic names like `agents.completeUnstake`), and the gap it leaves is closed by the `REQUIRED_CONSTANTS` list, which hard-errors when a required constant vanishes from the snapshot.
  
  ### Evidence pointing the other way
  
  The checker is explicitly designed against the degenerate "delete rows to pass" strategy — `REQUIRED_CONSTANTS` exists so that "deleting rows would *raise* the pass rate — a check that rewards saying less is worse than no check." It also evaluates cross-pallet invariants rather than quoting them, and fails on any undocumented custom-pallet extrinsic or `ScalarCommonsApi` method. `docs/reference/token-model.md` reports two unflattering facts rather than hiding them: the oracle bonus term "contributes exactly zero on chain" because `OracleScoreProvider = ()`, and a documented discrepancy where `VERIFIED-CONSTANTS.md` says `InitialAlpha = 4,000` against the live 1,500.
  
  ### Dependencies
  
  Three devDependencies, all justified by the gate itself: `vitepress` (build), `markdownlint-cli2` (lint), `@polkadot/api` (reads live runtime metadata, which the issue requires). No runtime dependencies added.
  
  ### What I could not see
  
  `docs/.chain/snapshot.json` and `docs/package-lock.json` were excluded as generated/vendored. I therefore cannot confirm the snapshot was genuinely captured from the live node at spec 304 rather than hand-authored, nor that `npm run lint`/`npm run build` actually pass. That is a limit of the material I was given, not a defect I found in the code — and the architecture (offline lint against a committed, provenance-stamped snapshot regenerated by `npm run snapshot:chain`) is documented in both script headers as a deliberate determinism choice, not a chain mock.
  
  No instance of the standing-rule violation pattern is present in this diff.
  
  VERDICT: PASS

===== DRY RUN SUMMARY: 1 PASS / 2 FAIL / 0 ERROR => FAIL =====
WOULD: post a verdict comment on PR #85
WOULD: label needs-human
WOULD NOT: merge — review.sh has no merge path, under any flag
EXIT=1
```

---

## 4. The stale test, rewritten to exercise the real code

### What was wrong

`factory/tests/verdict-parse.sh` contained a **copy** of review.sh's grep/awk
pipeline and asserted against the copy:

```bash
# The verdict extraction exactly as review.sh performs it.   <- it no longer was
parse_verdict() {
  v="$(grep -oE '^VERDICT: (PASS|FAIL)' "$out" | tail -1 | awk '{print $2}')"
  ...
```

When #86 changed the real rules, the copy did not move. The file kept passing while
asserting behaviour review.sh no longer had — notably
`expect "lowercase verdict fails closed (strict)" FAIL 'verdict: pass'`, the exact
opposite of the current rule, and "no verdict → FAIL" where the current rule is
"no verdict → ERROR". **Green while wrong** is worse than red: it reports
confidence it has not earned.

### The fix: a testable entrypoint

The decision logic in `review.sh` is now four pure functions defined before the
script does any work — `parse_verdict`, `classify_lens_result`, `overall_status`,
`review_labels` — plus four self-test entrypoints that dispatch on `$1` and exit:

```
review.sh --parse-verdict <file>        PASS | FAIL | (empty)
review.sh --classify <rc> <file>        PASS | FAIL | ERROR
review.sh --status <pass> <fail> <err>  PASS | FAIL | INCONCLUSIVE
review.sh --labels <pass> <fail> <err>  "<agent-reviewed> <needs-human>"
```

`run_lens` calls the same functions, so there is exactly one implementation. The
dispatch sits before `stop_requested`, before `gh`, and before `spend_reserve`, so
a test run makes no API call, spends no budget, and touches no PR — asserted by the
test itself (§5 of the test).

This also removed duplicated logic from `run_lens`: the PASS/FAIL/ERROR decision
used to be two inline `if` blocks; it is now one `classify_lens_result` call.

### 51 assertions, all against the real script

```
=== verdict parsing (review.sh --parse-verdict) ===       20 assertions
=== lens classification (review.sh --classify) ===         9
=== status (review.sh --status) ===                        8
=== labels (review.sh --labels) ===                        6
=== prompt delivery (E2BIG regression guard) ===           4
=== self-test entrypoints are side-effect free ===         4

===== VERDICT-PARSE SUMMARY: 51 passed, 0 failed =====
```

The rules it now asserts are the current ones: last verdict line wins,
case-insensitive, markdown tolerated (`**VERDICT: PASS**`, `**VERDICT:** PASS`,
`_VERDICT: PASS_`, `## VERDICT: PASS`), the colon form required so prose is not a
verdict, and — the load-bearing one — **empty output or a non-zero exit is ERROR,
never FAIL and never PASS**, including `exit 1` overriding a `VERDICT: PASS` that
happens to be in stdout.

### It goes RED when the parser regresses

Three separate regressions introduced into `review.sh`, test run each time, then
restored:

**R1 — parser made case-sensitive** (`grep -oiE` → `grep -oE`): **16 failed**

```
FAIL  clean PASS on its own line (expected PASS, got -none-)
FAIL  lowercase is accepted (expected PASS, got -none-)
FAIL  bold around the whole line (expected PASS, got -none-)
FAIL  last verdict wins (PASS then FAIL) (expected FAIL, got -none-)
FAIL  exit 0 + PASS verdict (expected PASS, got ERROR)
… 11 more
```

**R2 — missing verdict scored FAIL instead of ERROR**: **2 failed**

```
FAIL  exit 0 + empty output => ERROR (expected ERROR, got FAIL)
FAIL  exit 0 + no verdict => ERROR (expected ERROR, got FAIL)
```

**R3 — argv prompt delivery reintroduced** (the #86 E2BIG bug): **2 failed**

```
FAIL  prompt is passed as an argv string (E2BIG regression: use a stdin redirect)
FAIL  no stdin redirect from $pf found — how is the prompt being delivered?
```

Restored: **51 passed, 0 failed**, and `diff` against the pre-regression copy
reports the file identical.

The delivery guard inspects **code only** — `grep -vE '^[[:space:]]*#'` first —
because review.sh's header quotes the bad invocation verbatim as a warning. The
first version of the guard did not, and went red against correct code; the test
caught my own bug before it was committed.

---

## 5. Verification performed

- `shellcheck -x factory/review.sh` → **clean, exit 0**
- `shellcheck -x factory/tests/verdict-parse.sh` → **clean, exit 0**
- `shellcheck -s bash factory/config.env` → **clean, exit 0**. This needed one
  targeted `# shellcheck disable=SC2034` on `FACTORY_REPO=""`, which is a **false
  positive**: the variable is read by `gh_repo_args()` in `lib/common.sh`, and
  shellcheck cannot see that use because `common.sh` sources `config.env` via a
  variable path. The finding pre-dates this round. Flagging it explicitly rather
  than burying it, since suppressing a linter is the shape of the thing the
  standing rule forbids — the distinction is that nothing here silences a real
  problem or makes a failing check pass.
- `bash -n` on all three → clean
- `./factory/tests/verdict-parse.sh` → 51/51, exit 0; goes red on three distinct
  regressions and recovers (§4)
- 317062-byte prompt through stdin delivery → exit 0 (§1)
- `./factory/review.sh --dry-run 85` → full coverage, 0 files omitted (§3)

## 6. What I did NOT change

- **Nothing outside the three permitted files.** No pallet, runtime, indexer, CI,
  `dispatch.sh`, `merge.sh`, or `lib/common.sh` change.
- **`ENABLE_DISPATCH` is untouched** — still `${ENABLE_DISPATCH:-false}` as
  committed on master. `git diff` on this branch contains no `ENABLE_DISPATCH`
  line.
- **No lens prompt text was changed at all this round.** The three lens texts are
  byte-identical to master.
- **Nothing was made lenient.** The taxonomy is unchanged: `ERROR` ⇒
  `INCONCLUSIVE`, no `agent-reviewed`, add `needs-human`, exit 2. `agent-reviewed`
  still requires ≥2 PASS **and** zero ERROR. Raising a coverage cap widens what the
  reviewer sees; it does not lower any bar.
- **`review.sh` still never merges.** The four new entrypoints are read-only and
  print one line each.
- **No test was deleted or weakened.** `verdict-parse.sh` gained assertions
  (12 parse cases → 20, plus 23 new ones in three new sections). Every rule the old
  file asserted that is still true is still asserted; the ones removed were
  asserting the *opposite* of the shipped behaviour.

### Known follow-up, out of scope

`factory/README.md:114` and `:461` describe this test as "16 assertions on
fail-closed verdicts". It is now 51 across six sections. `README.md` is outside the
three files this round permits, so the count is left stale and flagged here.
