# Instructions for Tejas — Messaging layer (F), spec 309

Goal: put agent-to-agent coordination messages on chain (typed, bounded, fee-priced, event-only), give every agent a messaging key, publish the envelope spec, and update SDK / reference agent / indexer — all live, no downtime, no reset. Two autonomous Claude Code rounds plus one spike. Same pattern as 305/306: no checkpoints, mechanical abort conditions.

Estimated wall-clock: Round A ≈ 1 day (CI + upgrade + live check), Round B ≈ 1–2 days, Spike ≈ half a day. They can overlap as noted.

---

## Step 0 — before starting (5 minutes)

```bash
cd ~/scalar-commons-v4 && git checkout master && git pull --ff-only
gh pr list; gh issue list --milestone "v0.307 — validated economics + on-chain coordination" --limit 50 | head -40
curl -s https://api.scalarnet.io/v1/status | head -c 200; echo
tmux ls
```

Paste me: the PR list (PR #176 must be merged), whether the milestone exists (if not, run the reconcile prompt from earlier first), and the `specVersion` from the status line (expect 306).

---

## Round A — runtime: messaging key + messages pallet → spec 309 (T0, autonomous)

```bash
cd ~/scalar-commons-v4 && tmux new -s spec309
claude --dangerously-skip-permissions
```

Paste:

```
T0 round, human-authorised in advance under the same terms as the 305/306 upgrades: fully autonomous, never ask a question, mechanical abort conditions only. If a decision is not covered, take the more conservative option and record it. On an abort, file an issue with the full report (tier:T0), skip only dependent work, finish the rest. Repo ~/scalar-commons-v4, master. Never print the contents of ~/.factory/env or ~/.config/scalar-commons/*; scripts/apply-upgrade.mjs may read the sudo key file the way it already does. Never weaken a check to pass.

Goal: spec 309 = on-chain coordination messages + per-agent messaging key. Read CONTEXT.md, UPGRADE-306.md, deploy/upgrade.md, pallets/agents, pallets/escrow, runtime/src/lib.rs first.

Decisions already made (do not revisit):
D14 Messaging key: pallets/agents gets an optional 32-byte X25519 public key per agent (`MessagingKey<T>: StorageMap<AccountId, [u8;32]>`), set by a new extrinsic `set_messaging_key(key: [u8;32])` callable only by a registered agent, replaceable at any time (rotation), removable with `clear_messaging_key()`. Event `MessagingKeySet { who, key }`. No deposit. Existing registrations are untouched; no storage migration is needed for them.
D15 Messages pallet: new pallet `pallet-messages`. One extrinsic `send(to: AccountId, kind: MessageKind, agreement: Option<(AccountId, u32)>, payload_hash: Option<[u8;32]>, payload: BoundedVec<u8, ConstU32<2048>>)`. `MessageKind` = { Offer, Bid, Accept, Reject, DeliveryNotice, DisputeNote, Announce, Ping }. Sender must be a registered agent (error NotRegistered). Recipient must be a registered agent for every kind except Announce (error RecipientNotRegistered). Payload is NOT stored in state: it is carried in the block body and emitted in the event `MessageSent { from, to, kind, agreement, payload_hash, payload_len, nonce }` where nonce is a per-sender counter kept in state (`NextNonce<T>: StorageMap<AccountId, u64>`) — that counter is the only state the pallet writes. Fee: in addition to the normal weight fee, charge `BaseFee + PerByteFee * payload_len` from the sender's free balance and burn it (Currency::withdraw + burn), with BaseFee = 0.02 CMN and PerByteFee = 0.0001 CMN as pallet constants (2 KiB ≈ 0.22 CMN). If auto-params can host them cleanly as adjustable values within governance bounds, do that instead of constants; if not, constants now and file a T2 issue for the auto-params hook. Per-sender rate limit: at most MaxPerBlock = 4 messages per account per block (error RateLimited).
D16 Runtime wiring: add the pallet to runtime/src/lib.rs, spec_version 309, transaction_version unchanged unless a call index changed. Weights: hand-estimated like the rest (note it in docs), with the payload length as a weight input.
D17 Tests (RED before / GREEN after, all in-tree): send by unregistered sender fails; send to unregistered recipient fails except Announce; payload above 2048 fails at the type level; fee arithmetic exact (assert balance delta = base + per_byte*len + weight fee); nonce increments per sender; rate limit trips on the 5th message in a block; event fields; set/clear messaging key by registered agent, rejected for unregistered; runtime integration test that the pallet is wired and its call encodes.

Phase A — implement on branch runtime/spec-309. cargo test --workspace, clippy clean, fmt. If storage changes to existing pallets are needed (they should not be beyond one new map), add a migration and run try-runtime on a live-state snapshot; otherwise state explicitly that no migration is required and prove it with try-runtime's pre/post checks anyway. Update docs/reference/token-model.md (message fees, burn), docs/reference/rpc.md if new RPC surface, and add docs/reference/messages.md (call, kinds, fee formula, event shape, what is and is not on chain). Open the PR, wait for CI green, squash-merge (pre-authorised for this PR).

Phase B — apply: build the wasm from merged master, backup exactly as for 306 into ~/upgrade-backup/<timestamp>/, run scripts/apply-upgrade.mjs with the fee preflight, confirm state_getRuntimeVersion → 309 over the PUBLIC wss, all five validators still authoring within 10 minutes, keeper healthy, indexer/explorer/faucet still 200 (restart them if they dropped their ws — that is #155, note it). Then prove it live: from two fresh faucet-funded accounts registered as agents, set a messaging key on each, send one message of each kind between them, and read the events back over the public wss; record every extrinsic hash and the exact fee charged versus the formula. Send one message with a 2048-byte payload and one with 2049 (must be rejected at construction). Write UPGRADE-309.md with §1 design, §2 apply log, §3 live proof, §4 fee table.

Abort conditions (stop, file issue, skip dependents): a previously green test goes red; CI not green after two fix attempts; try-runtime reports any storage error; apply preflight fails; fewer than five validators authoring 10 minutes after the upgrade; live fee charged differs from the formula; any message stored in state other than the nonce map (grep the storage in the metadata). Never tune bounds or fees to pass.

Finish with: PR number and merge SHA, block number of the upgrade, runtime version on public wss, the live-proof extrinsic hashes and fee table, any issues filed, and every conservative choice you made. Update CONTEXT.md.
```

Detach with `Ctrl-b d`. Rust CI is ~20 min per run; the upgrade itself is minutes; the live proof is minutes. Expect the report within a few hours.

Paste me: the final report (or `tail -60` of the tmux pane).

---

## Spike — statement store (T1, can run in parallel with Round A, separate tmux)

```bash
cd ~/scalar-commons-v4 && tmux new -s stmt
claude --dangerously-skip-permissions
```

Paste:

```
Research spike, fully autonomous, read-only against the public chain, no changes to running services, no PR to master (work on branch spike/statement-store and push it; do not merge). Repo ~/scalar-commons-v4. Never read ~/.factory/env or ~/.config/scalar-commons/*.

Question: can the Substrate statement store (sc-statement-store / sp-statement-store / pallet-statement in polkadot-stable2503) serve as Scalar's off-chain data plane for agent messaging, with per-account allowance derived from agent stake instead of balance?

Do: (1) confirm the crates exist at our SDK version and what the node needs to enable the store (CLI flag / service wiring); (2) on a throwaway dev chain in /tmp (not the testnet), wire pallet-statement so the ValidateStatement runtime API grants allowance proportional to pallets/agents stake (0 for unregistered accounts); (3) run two nodes locally; from two agent accounts with no inbound connectivity assumption (clients only connect outward), submit a signed statement encrypted to the recipient's key with a topic = recipient address, and have the recipient retrieve it via the statement RPC on its own node; (4) measure: submit latency, propagation between the two nodes, store size, and what happens when an unregistered account submits (must be rejected); (5) list the RPC methods the store exposes and classify each safe/unsafe for public exposure behind nginx; (6) record every rough edge (experimental warnings, missing docs, API instability).

Deliver docs/spikes/statement-store.md with verdict VIABLE / VIABLE-WITH-CHANGES / NOT-VIABLE, the exact node flags and runtime wiring, the measurements, and the security classification; push the branch; open a draft PR titled "spike: statement store" that is NOT merged. Finish with the verdict and a 10-line summary. Abort only if the crates cannot compile at our SDK version — then report that as the verdict.
```

Paste me: the verdict line and the 10-line summary.

---

## Round B — off-chain: envelope spec, SDK, reference agent, indexer (T2, autonomous) — start after Round A's spec 309 is live

```bash
cd ~/scalar-commons-v4 && tmux new -s msgclient
claude --dangerously-skip-permissions
```

Paste:

```
Fully autonomous, never ask a question, conservative choice on anything not covered, file an issue on abort and continue with independent work. Repo ~/scalar-commons-v4, master (spec 309 must be live on the public chain — verify state_getRuntimeVersion first; if it is not 309, stop and report). Never read ~/.factory/env or ~/.config/scalar-commons/*. Outsider steps use only public endpoints and fresh faucet-funded keys. Never weaken a check to pass.

Read docs/reference/messages.md, UPGRADE-309.md, docs/spikes/statement-store.md if present, sdk/, examples/reference-agent/, indexer/, and the withdrawn pilot intent at docs/oracle/pilot-001-withdrawn-intent.json if present (a real example of an outsider message that a strict validator rejected — the spec must make such mismatches impossible by construction).

Deliver, each with RED-before/GREEN-after tests and each as its own PR merged in order:
1. docs/reference/messaging.md — the signed envelope spec. Canonical encoding is SCALE of a fixed struct { version: u8, from: AccountId, to: AccountId, kind: u8, agreement: Option<(AccountId,u32)>, nonce: u64, expires_at_block: u32, payload_hash: [u8;32] }; signature = sr25519 over blake2_256(SCALE bytes) with the domain prefix b"ScalarMsg/v1|" ++ genesis_hash; verification rules (signer must equal from, nonce strictly increasing per (from,to) pair as seen by the verifier, reject if expires_at_block < current best block, payload_hash must equal blake2_256 of the delivered payload); transport bindings: (a) on-chain via pallet-messages (payload ≤ 2 KiB inline, or hash-only with payload off-chain), (b) HTTPS POST to the recipient's registered service URI, (c) statement store if the spike is VIABLE. Include test vectors in sdk/test/vectors/envelope.json generated from real keys and re-verified in CI.
2. SDK: messages.send / messages.subscribe (on-chain), envelope.sign / envelope.verify, encrypt/decrypt to the registered X25519 messaging key (use @polkadot/util-crypto naclSeal or equivalent; document the primitive), and a Transport interface with the on-chain and HTTPS implementations (statement-store stub if not viable). Offline tests: vectors, replay rejection, expiry, wrong signer, payload-hash mismatch, encryption round trip. Live test against the public chain with two fresh agents: send Offer, receive via subscribe, reply Accept.
3. Reference agent: replace storage polling with subscribing to MessageSent events addressed to it; negotiate Offer → Accept → escrow.createAgreement(deliverableHash = envelope payload_hash of the accepted terms) → DeliveryNotice with the report hash → buyer confirms after recheck. Prove it live end to end with two fresh agents and cite every extrinsic hash and the explorer URLs.
4. Indexer: GET /v1/messages?address=&agreement=&kind=&since=; GET /v1/agents/<addr>/timeline (registrations, messages, agreements, payouts in block order); GET /v1/metrics/fanout (messages per sender per era, distinct recipients per sender per era). Explorer: per-agent timeline page. Tests offline + live smoke.
5. Docs: update run-an-agent and tester guides with the messaging flow; landing "Testnet status" gains one line: on-chain coordination messages live since spec 309. Redeploy timer publishes.

Abort conditions: spec not 309; a green test goes red; CI not green after two attempts; live negotiation cannot complete; any secret in a vector file (run gitleaks before every push). Finish with PR numbers, the live extrinsic hashes for the negotiated agreement, the three endpoint URLs returning data, and issues filed.
```

Paste me: the final report.

---


---

# Additional critical changes uncovered (add to the same programme)

Everything below came out of the launch audit, the tester-guide run, the oracle exercise, and the Replit pilot. Ordered by how much it blocks. Rounds 0, C and D are autonomous; Round E is decisions only.

## Round 0 — economic gate on spec 306 (T2, start FIRST, runs in parallel with everything; ~6–12 h of waiting)

The single biggest unproven claim. Until this passes, the landing must keep saying "economics under repair" and nobody should pitch emissions.

```bash
cd ~/scalar-commons-v4 && tmux new -s econgate
claude --dangerously-skip-permissions
```

```
Fully autonomous, no questions. Repo ~/scalar-commons-v4, master. Never read ~/.factory/env or ~/.config/scalar-commons/*. Use experiments/live with fresh faucet-funded accounts only.
Run the full economic gate on the live chain at its current spec: `node run.mjs --archetype all --eras 1` (all six archetypes in the same era so they compete for the same pot). Before running, read UPGRADE-306.md and #164 and write down the pass criteria from them (honest archetype nets positive; wash-trader, sybil and ring nets ≤ 0 after fees and lineage exclusion; no single faucet-funded lineage captures more than 20% of the era pot). After the era settles and rewards are claimed, write experiments/live/reports/spec-306.md with the per-archetype ledger evidence (extrinsic hashes, payouts), the pass/fail per criterion, and an overall PASS or FAIL. Open a PR with the report and, if PASS, the landing/docs status text changed to "economic gate PASSED on spec 306 (date)"; if FAIL, leave the text as FAILED and file a tier:T0 issue with the exact capture path. Merge the PR when CI is green (pre-authorised). Comment on #164 with the result; close it only on PASS. Finish with the per-archetype table and the verdict.
```

Paste me: the verdict and the table.

## Round C — oracle lifecycle, question publication, keeper duties (T2, after spec 309 is live)

Findings behind it: 26 oracle requests sit past their deadline still marked "Collecting" because nobody calls `expireRequest`/`finaliseRequest`; creating a request requires a registered agent and answering requires an identity record + capability, none of which the guides say; question plaintext has no home, so responders cannot find what a hash means (the Replit runner rejected my question format for exactly this reason); my own tool's "one decimal, e.g. 16.1" rule was ambiguous; oracle accuracy is still not wired into rewards.

```bash
cd ~/scalar-commons-v4 && tmux new -s oracle
claude --dangerously-skip-permissions
```

```
Fully autonomous, no questions, conservative choices recorded, abort → issue + continue. Repo ~/scalar-commons-v4, master (spec ≥ 309 required — verify). Never read ~/.factory/env or ~/.config/scalar-commons/*. Outsider steps with fresh faucet keys only. Never weaken a check to pass.
1. Keeper: extend scalar-keeper to call oracle.expireRequest on requests past responseDeadline with responseCount < minResponses and oracle.finaliseRequest on requests past deadline + challengeWindow with enough responses; idempotent, fee-preflighted, one extrinsic per request per run, logged. Run it once live and clear the 25+ stale requests; record hashes. Tests offline. Update deploy/products keeper unit/docs.
2. Question registry: docs/oracle/SCHEMA.md defining canonical question objects (kind, source, extract, answerRule as a machine rule not an example, verify, date, version) with sorted-key JSON canonicalisation and blake2_256 questionHash; answer canonicalisation rules per kind (fx_ecb, btc_block_hash, nws_temp, coingecko_daily, nfl_final) written so two independent responders must produce identical strings; reconcile with the Replit runner's canonical FX form (`{"kind":"fx_ecb","title":...,"source":"https://api.frankfurter.app/<date>?from=EUR&to=USD"}`) by making the registry accept both `api.frankfurter.app` and `api.frankfurter.dev` as declared sources of the same ECB series and by publishing the exact key-order rule.
3. Publication on chain: the creator publishes each question's canonical JSON as a pallet-messages Announce (payload ≤ 2 KiB, payload_hash = questionHash) in the same script that creates the request; the indexer indexes Announce payloads by payload_hash so GET /v1/oracle/requests/<id> returns the plaintext question alongside chain state; GET /v1/oracle/requests?status=open lists answerable requests. Explorer: oracle request page with question, responses, result, accuracy.
4. Tooling: adopt examples/oracle/oracle-questions.mjs (from the pilot; generate/create/answer/status), fix its inclusion check (poll storage, never treat an empty Option as success), make `create` also send the Announce, add `daily` mode for a cron-style run, document it in the agent guide.
5. Docs: state that creating requests requires a registered agent, answering requires identity.setIdentity (≈11.6 CMN refundable deposit) + agents.setCapability, and list the fees; update tester and agent guides.
6. Oracle accuracy in rewards: read pallets/emissions and pallets/oracle; write docs/design/oracle-weight.md proposing how oracleScore enters the payout (bounded ≤ 20% as the landing already promises) with sybil analysis; file it as a tier:T0 issue for the next runtime round; do not implement in this round.
Prove live: a fresh outsider creates a question via the tool (request + Announce), a second fresh outsider finds it via /v1/oracle/requests?status=open, answers correctly, the keeper finalises it, oracleScore updates; cite every hash. PRs merged in order when CI is green (pre-authorised). Finish with hashes, endpoint URLs, and issues filed.
```

Paste me: the final report.

## Round D — operations, resilience, public commitments (T2/T3, any time; parallel-safe)

Findings behind it: products stayed up but broken after a node restart (#155) and the faucet still reports spec 305; nobody is alerted when anything stops; factory configuration exists only in local systemd drop-ins; no dependency audit or signed release; the NSA memo promises a private-instance guide, a termination drill, quarterly findings and misuse notification with no channel; the constitution text is unpublished; contributors have no policy.

```bash
cd ~/scalar-commons-v4 && tmux new -s ops
claude --dangerously-skip-permissions
```

```
Fully autonomous, no questions, conservative choices recorded, abort → issue + continue. Repo ~/scalar-commons-v4, master. Never read ~/.factory/env or ~/.config/scalar-commons/*. No sudo: anything needing root goes into deploy/ with exact commands and a note in the report. Never weaken a check to pass. One PR per item, merged in order when CI is green (pre-authorised).
1. #155 + faucet: shared chain client with reconnect/backoff for indexer, faucet, explorer; /health and /v1/status return 503 (not 500) while disconnected and re-read runtime version on reconnect (the faucet's stale "305" is the symptom); unit test simulating a ws close.
2. Monitoring: deploy/monitoring/ with a user-level timer that every 2 minutes checks the five public URLs, block-height progress (alert if no new block for 60 s), keeper timer health, product /health; alerts via a webhook URL read from an env file (Discord/Slack/email — whatever URL is configured; document how). Prove it by stopping the explorer for 3 minutes in a test and showing the alert and recovery message. Add a public status page at https://scalarnet.io/status generated from the same checks.
3. Factory config in git: factory/systemd/ with the drop-in templates (override.conf, path.conf) and an install script that renders and enables them; document in factory/README; prove by diffing rendered output against the live ~/.config/systemd/user/factory-*.service.d/ files.
4. Supply chain: cargo audit and npm audit jobs in ci-fast (fail on high/critical, allowlist file for accepted advisories with expiry dates); sign release binaries (cosign or minisign, public key in docs) in release.yml; document verification in the validator guide.
5. Public commitments: docs/guide/private-instance.md (permissioned chain spec generation, air-gapped run, verified end to end on a throwaway dev chain); docs/reference/termination-drill.md (record a real orchestrator→sub-agent termination on the testnet with explorer trace); docs/reference/constitution.md (current constitution text + change history from chain); docs/reference/guidance-mapping.md (ASD/CISA/NSA agentic risk classes → Scalar controls, one table); docs/reports/TEMPLATE.md + docs/reports/2026-Q3.md (first quarterly findings report, drawn from PUBLIC-LAUNCH, TESTNETAUDIT, UPGRADE-30x, the tester-guide findings); a public abuse page at https://scalarnet.io/abuse stating the contact and response SLA (contact address to be a placeholder the human fills — put it in domain.env style config, not hard-coded); CONTRIBUTING.md (forks, CI, agent review, no direct write access, tiers).
6. Reset runbook: docs/ops/reset-runbook.md (what a reset means for balances/agents/validators, announcement lead time, how the chain name is changed at the next coordinated restart, how backups are taken) — document only, do not execute.
7. Dataset export: a nightly job writing counterparty-graph and era-payout snapshots to /var/www/scalarnet/data/<date>/ and a docs page describing the files; prove one export exists.
Finish with PR numbers, the alert test evidence, and the list of items that need root (with exact commands).
```

Paste me: the final report. The root-needing commands I'll turn into a 5-minute block for you.

## Round E — decisions only (T0; Tejas + Matty, not agents)

These cannot be automated; each needs a one-line answer written into the issue. I have a recommendation for each.

| # | Decision | Recommendation |
|---|---|---|
| E1 | Validator rewards (EraPayout disabled) | Stay unpaid through v0.307; decide a small fixed per-era validator payment in v0.308 only after the econ gate passes twice. |
| E2 | Sudo exit path | Keep sudo through v0.307; v0.308 adds OpenGov tracks for runtime upgrade and staking config and moves sudo to a 2-of-3 multisig (Tejas, Matty, a third key in cold storage) as the intermediate step; removal at mainnet. |
| E3 | Second host / validator decentralisation | Rent a second VPS in a different provider/region; move two of the five validators there; document key backup/DR first. Do it before any external validator is invited to stay. |
| E4 | Benchmarks (#134) | Run the benchmark harness in v0.308; keep the landing caveat until then. |
| E5 | Know-Your-Agent / operator attestation | Design in v0.308: optional signed operator attestation in registration; required only for agents above a stake threshold. |
| E6 | Reputation surfaced | Design in v0.308 as multidimensional (completions, disputes lost, oracle accuracy, liveness), never a single score; read-only endpoint first. |
| E7 | Chain name "Local Testnet" | Rename at the next coordinated restart (E3's move is the natural moment). |
| E8 | Regulatory review | Counsel memo before any token has value; nothing to do in code. |

Write the answers as comments on the corresponding T0 issues; the factory does the rest.

## Order that makes sense

Round 0 now (it only waits) → Round A → Spike alongside → Round B → Round C → Round D anytime → Round E whenever you and Matty have twenty minutes.

## What I will do with the reports

- Round A: check the fee table and the live proof, then update CONTEXT.md and the v0.307 workbook.
- Spike: decide whether transport (c) is in or out — I'll tell you in one line.
- Round B: run the external-buyer pilot again from here, this time as on-chain messages instead of JSON pasted between chats, against the Replit provider once its runner speaks the same envelope.

## If something aborts

Do nothing except paste me the issue it filed. Every abort condition is designed to be safe to leave alone: the chain keeps running on the previous spec, and the backed-up WASM in ~/upgrade-backup/ is the rollback.
