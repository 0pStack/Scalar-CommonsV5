# Scalar Commons v4 — The End Goal, Restated

*A definitive statement of what "done" means for this project, derived from the original
project description, Matty's requirements as carried in `CLAUDE.md` and the repo's public
claims, and everything learned building it.*

*Version 2 · supersedes the day-30 definition in `ROADMAP-30DAY.md` · 2026-08*

---

## 0. The goal in one sentence

**Every claim the project makes about itself must be true, and a stranger with nothing but a
browser and an internet connection must be able to verify it.**

Everything below is an expansion of that sentence.

---

## 1. Why the goal needs restating

The original goal was written as a feature list: build a chain, build an indexer, build an
explorer, build an SDK, ship a testnet. That framing is what produced the project's founding
failure, and it is worth naming precisely because the whole operating model exists to prevent
its recurrence.

**The founding failure.** A previous contributor made CI green by writing `fn main() {}` into
`node/src/main.rs` and `runtime/build.rs`. The badge said green. The chain did not compile.
Simultaneously, `CLAUDE.md` and the public description asserted a running network with a
24-endpoint REST indexer, a working SDK, and a block explorer — while `indexer/` contained one
59-line Python reconciliation script with zero endpoints, `explorer/` did not exist at all, and
the node had never built. **The claims were not lies; they were a feature list mistaken for a
status report.** The gap between description and reality was the actual project risk, larger
than any individual missing component.

So the end goal is not "build the list." The end goal is: **close the gap between what the
project says and what the project is, permanently, and make that closure mechanically
verifiable rather than asserted.**

This reframing has a practical consequence that shapes every decision below: *a component is
not done when it exists. It is done when an outsider can exercise it and see it work.*

---

## 2. What the project is (the claim that must become true)

Scalar Commons is a **Layer-1 blockchain — a standalone Substrate / Polkadot-SDK chain —
serving as the coordination and settlement layer for autonomous AI agents.**

The users are not humans transacting. They are software agents that:

1. **Register an on-chain identity** and stake the native token (CMN) as a bond.
2. **Enter into work agreements with each other**, with funds held in escrow.
3. **Have their work measured** by independent oracles rather than self-reported.
4. **Get paid in newly emitted CMN**, in proportion to how much verifiable, diverse, useful
   work they actually performed — not in proportion to how much capital they hold.
5. **Govern the network's parameters** through on-chain voting, with participation itself
   forming part of the reward weight.

The token is **CMN**: 100 billion hard cap, 18 billion minted at genesis (split 7B / 5B / 3B /
3B), 1 CMN = 10¹² plancks, 12 decimals, SS58 format 42.

**The economic thesis — and the thing that must be proven, not assumed:** the emission formula
is designed so that *faking the work does not pay*. That is the entire product. A chain that
pays agents for provable work is only interesting if the "provable" part holds under adversarial
pressure. Therefore economic security is not a feature of this project; it is the project.

The emission weight per agent per era:

```
weight = √stake × activity/volume × diversity × rank × heartbeat × onboarding_boost
```

with governance participation contributing at a right-sized 1,500 basis points.

Each term is load-bearing and each was chosen against a specific attack:

| Term | Attack it defends against |
|---|---|
| **√stake** (square root, not linear) | Whale dominance — doubling capital does not double reward |
| **activity / volume** | Passive rent extraction — a pure staker earns exactly zero |
| **diversity** | Wash trading — farming one fake counterparty repeatedly is unprofitable |
| **rank / oracle-measured reputation** | Self-reported work — measurement is independent, with an aggregation floor so no single reporter dominates |
| **heartbeat** | Abandoned or zombie agents drawing rewards |
| **governance participation (1,500 bps)** | Was itself a farm vector until fixed — see §5 |

---

## 3. The end goal, in full

Done means **all seven** of the following hold simultaneously and are independently checkable.

### 3.1 The chain layer — a real network, not a demo

- All **seven custom pallets** integrated in the runtime and passing tests: `agents` (identity,
  stake, heartbeat, rank), `escrow` (work agreements, permissionless settlement, no
  self-dealing), `oracle` (independent measurement with an aggregation floor), `emissions`
  (era reward minting under the supply cap), `auto-params` (bounded self-tuning), `orchestrator`
  (the agent link graph, self-link refused), `constitution` (invariant enforcement).
- **BABE + GRANDPA + Staking** consensus, with **OpenGov** (Referenda, Conviction Voting,
  Ranked Collective) so the chain is upgradeable and parameterizable on-chain rather than by fiat.
- **Multiple validators producing and finalizing blocks continuously and unattended.** Five is
  the current devnet; finality must survive a validator going down (proven), and the network
  must run for extended periods without human intervention.
- **A forkless runtime upgrade rehearsed** — `spec_version` bumped and applied on a live
  network without restarting nodes. A chain that cannot upgrade itself is not an L1.
- **Real weight benchmarks for every extrinsic across all seven pallets.** Today every
  extrinsic is priced by hand-estimated literal. That is a fee-fairness failure and a free DoS
  surface. Requires `define_benchmarks!` registration, generated `weights.rs`, and a
  `WeightInfo` associated type wired into each pallet's `Config`. **Human-reviewed — weights
  are never set autonomously.**

### 3.2 The product layer — the description made true, component by component

Each of these was asserted in the project description before it existed. Each must now exist,
be tested, and be reachable.

- **Indexer** — a REST API over chain events, **24 endpoints**, covering blocks, extrinsics,
  events, accounts, agents, escrows, eras, and emissions. Every response derived from real
  finalized chain data read via runtime metadata — no fixtures, no hand-written type shapes, no
  fallback data. Must survive hostile input (no unhandled input can kill the process) and must
  not amplify one HTTP request into unbounded RPC load against a validator.
- **Explorer** — a web UI with **block, extrinsic, and account views**, with navigation
  block→extrinsic and extrinsic→account, reading a live node. Output must be XSS-safe and must
  never render a plausible-looking empty page where an error occurred.
- **SDK** — a real, tested TypeScript client, not a skeleton: agent lifecycle
  (register/stake/heartbeat), escrow (create/accept/complete), oracle submission, governance
  (`vote`, `recordGovVote`), era settlement and claims, and correct reads on the current
  runtime (`eraInfo`, `netPosition`, `weightOf`, `totalIssuance`). Balances handled as `bigint`
  end to end — never routed through JavaScript `Number`, which loses precision above 2⁵³
  plancks (≈ 9,007 CMN).
- **Documentation** — developer and user docs: run a node, use the SDK, RPC reference, token
  model. Documented constants must be **mechanically cross-checked against the live runtime**,
  not transcribed by hand, and the pages must not contradict each other.
- **Faucet** — dispenses test CMN with per-address and per-IP rate limiting, drawing from a
  pre-funded account. **Never a mint path.**
- **Landing page** — a public front door whose claims are generated from verified chain facts,
  and which does not describe unshipped components as shipped or shipped components as planned.

### 3.3 The public access layer — what makes "testnet" mean testnet

This is the layer that converts a private devnet into a public network, and **none of it can be
done by an agent.**

- **A public RPC endpoint over wss with TLS**, terminated at a reverse proxy — never the node's
  own port exposed directly.
- **A restricted RPC method allowlist.** The unsafe method set (`author_insertKey`,
  `author_rotateKeys`, and peers) must be confirmed blocked on every exposed node. *Current
  status: not asserted here. `rpc_methods` lists every registered method even when unsafe calls
  are denied, so it is not evidence; confirm by calling an unsafe method on each exposed node and
  recording the refusal.*
- **Firewall rules, human-reviewed before they go live**, and rate limiting at the proxy.
- **The faucet, docs, landing page, and explorer all deployed and publicly reachable** — not
  merely built and sitting in the repo.

### 3.4 The economic security gate — the launch blocker that outranks everything

**All five attacker archetypes** (sybil farm, wash trader, oracle colluder, governance farmer,
passive staker) must be run **against the live network, not only against the Python
simulation**, and **none may be profitable.**

This gate outranks every other consideration except the chain building at all. If wash trading
still pays, the project does not launch — schedule slips, scope bends, the gate does not move.

Related and already closed: the **governance-farming vector**, where agents earned
governance-participation credit without casting real votes. `record_gov_vote` is now wired to
actual `pallet_conviction_voting` state with per-era deduplication, and the weight was
right-sized from 4,000 to 1,500 bps. This was found by adversarial analysis, not by tests
passing — which is the model for everything in this section.

Open economic research, documented rather than hidden: **B1 / Sybil-resistant diversity** (making
"distinct counterparty" economically meaningful rather than merely address-distinct) remains
unsolved and is explicitly a post-testnet item.

### 3.5 Verification integrity — the meta-goal

This is the requirement that did not exist in the original list and matters more than most of it.

- **Every subproject's tests must run in CI.** A test suite that no automated gate executes is
  decoration. *(Known gap: landing, faucet, docs and sdk now have CI jobs; the indexer and explorer
  suites are what remain unrun by any workflow.)*
- **A green check must mean the code is correct**, never that a check was weakened to pass.
- **Branch protection enforced, admins included**, with required status checks and no force-push.
- **The standing rule, mechanically enforced by hooks, not by trust:** never make a check pass by
  weakening code. No stubs, no commented-out modules or tests, no `todo!()`/`unimplemented!()`,
  no `#[allow]` to silence errors, no deleted tests. **A failure is a finding — report it
  verbatim.**
- **Reports must describe reality.** Status files, digests, and dashboards that misreport the
  system's actual state are themselves defects, and are treated as such.

### 3.6 The autonomy layer — the second product

The factory was built as a means, but it has become a deliverable in its own right: **a
bounded-autonomy harness that turns labelled issues into reviewed, CI-gated, merged pull
requests around the clock without a human in each loop.**

Done means:

- **Issue-driven dispatch** — `tier:T3` + `ready` issues are picked up automatically, each in an
  isolated git worktree, with the gate command taken from the issue body itself (never inferred).
- **Bounded loops** — attempt caps, wall-clock caps, same-error early stop, per-day spawn budget,
  a `~/STOP_FACTORY` kill switch, and a watchdog enforcing all of it.
- **Fresh-context adversarial review** — three independent lenses (correctness/security,
  spec-conformance, standing-rule violations) each reviewing with no memory of the implementation,
  each emitting an explicit verdict.
- **Merge gated on review, not on the agent's own claim.** Any FAIL from any lens blocks the
  merge, regardless of the tally.
- **Tiered autonomy that cannot be overridden by configuration:**

| Tier | Scope | Who merges |
|---|---|---|
| **T0** | emissions math, escrow settlement, slashing, oracle aggregation, migrations, weight values, genesis | Human + external audit. Never dispatched. |
| **T1** | pallet logic, runtime wiring, node service code, network exposure | Agent may PR; human merges on green CI. Never dispatched. |
| **T2** | tests, benchmark harnesses, CI config, tooling | Autonomous with gates |
| **T3** | frontend, explorer, docs, indexer, SDK, dependency bumps | Fully autonomous, CI-gated |

The proof that this works is not that it ships code. **The proof is that it correctly refuses to
ship bad code** — which it has now demonstrated: three agent-built subsystems were produced,
adversarially reviewed, and all three were blocked on real defects including a reachable remote
crash. Zero merges was the correct outcome.

### 3.7 Reproducibility

A clean-machine rebuild from the README must produce a working node, and the release must be
tagged. If it only builds on one server, it is not software — it is a pet.

---

## 4. The acceptance test

The end goal is met when an outsider — with no access to the server, no help, and no prior
knowledge — can do all of this:

1. Open the landing page and read what the network is.
2. Read the docs and follow them without hitting a contradiction or a broken instruction.
3. Connect to the public wss RPC endpoint from their own machine.
4. Request test CMN from the faucet and receive it.
5. Register an agent, stake, and enter an escrow agreement using the SDK.
6. Watch their own extrinsic appear in the explorer, and navigate block → extrinsic → account.
7. Query the indexer's REST API and get real data about their own activity.
8. Read the token model and see that the documented constants match what the live chain reports.
9. Attempt to game the emission formula — and find it unprofitable.

**When all nine hold, the project description is true, and "testnet" means testnet.**

---

## 5. What is explicitly NOT in this goal

These are real requirements for **mainnet**, deliberately excluded from the testnet definition
so that nothing is silently dropped and nothing wrongly blocks launch. They are bought with
money and calendar time, not with agents.

- **External security audit** of the Substrate code — $50k–150k, 4–8 week lead time. Book early.
- **Separate economic audit** of the emission and escrow mechanisms.
- **Securities counsel** before any token distribution of any kind.
- **Key ceremony**, sudo multisig, and a documented sudo-removal plan.
- **≥7 independent validators** across separate hosts and separate operators. Five validators on
  one machine is a database with extra steps, not a decentralized network.
- **Bug bounty** and a written incident-response runbook.
- **Chaos testing** — validators killed mid-block, network partitions, extrinsic spam, restart
  from snapshot.
- **2–3 months of public adversarial testnet** before mainnet is even considered.

---

## 6. Coordination and ownership items

Non-technical, but real, and easy to forget until they block something:

- **The server (netcup RS 8000) is in Matty's name.** Panel access must be transferred or
  formally shared before the network is publicly announced — otherwise the infrastructure has a
  single point of administrative failure outside the operator's control.
- **The repository now lives at `tejaspatil1936/scalar-commons-v4`**; the GitHub repository is not a fork (`isFork: false`). Which
  repo is canonical at launch needs an explicit decision.
- **`CLAUDE.md` and the public description must be corrected** wherever they currently describe
  unbuilt components as existing. Until each component actually lands, the honest form is
  "planned," not present tense. Fixing the docs is part of the goal, not separate from it.

---

## 7. The single sentence to hold onto

> **Build a chain where AI agents earn a token for provable work, prove that faking the work
> doesn't pay, and let a stranger check every word of that for themselves.**

Everything else — every pallet, endpoint, gate, reviewer, and timer — exists to make that
sentence literally true.
