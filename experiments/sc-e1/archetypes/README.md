# SC-E1 Archetype Runners (A-1 … A-5)

Deterministic, seeded synthetic-agent runners for **SC-E1 — Scalar Commons
Emissions-Economy Validation** (protocol §5 + workbook tab 02). Each archetype
is a scripted loop over the agent SDK; every loop calls `settle_era`-with-backoff
so era settlement emerges from participant incentive alone; **no archetype ever
holds a privileged key**. Replaying a manifest reproduces byte-identical
extrinsic sequences per seed.

> **Scope.** Everything here lives under `experiments/sc-e1/archetypes/`. No
> pallet, runtime, or economic-parameter changes. The economics run on-chain via
> the SDK — the runners only *drive* them.

## The five archetypes (protocol §5)

| ID | File | Behaviour (per era) | Tests |
|----|------|---------------------|-------|
| **A-1** | [`a1_honest_worker.ts`](a1_honest_worker.ts) | register → stake → heartbeat → **n real escrows with genuine counterparties** → honest oracle answer → governance vote → claim | C-1a upside (P1, P2) |
| **A-2** | [`a2_passive_staker.ts`](a2_passive_staker.ts) | register → stake (≤ MaxStake) → heartbeat → claim. **No work.** | C-1a baseline (P1) |
| **A-3** | [`a3_sybil_farm.ts`](a3_sybil_farm.ts) | N accounts from one controller, min stake, heartbeat-only, no volume | C-1b vs burned BASE_TX_FEE (P4) |
| **A-4** | [`a4_wash_trader.ts`](a4_wash_trader.ts) | two colluding accounts self-escrow ≥ MinQualifyingVol both directions | C-1b vs completion+tx fees (P5) |
| **A-5** | [`a5_oracle_colluder.ts`](a5_oracle_colluder.ts) | k accounts submit **identical coordinated** oracle answers | C-1b oracle surface (P6) |

Every loop ends with `settlement.attempt(account, era)` — the permissionless
`settle_era`-with-backoff mechanism (protocol §5 settlement rule; §3 P0 gate "no
root-gated liveness").

## Running

Requires **Node ≥ 22.6** (uses built-in TypeScript type-stripping and the
built-in test runner — zero dependencies to install).

```bash
cd experiments/sc-e1/archetypes

# Print the digest of every (run, seed) in manifest.json
npm run run:manifest

# Full test suite: determinism, manifest replay identity,
# no-privileged-keys, settlement emergence, per-archetype behaviour
npm test
```

## Reproducibility model

Reproducibility is a protocol requirement (§10). The design:

- **One seed per run**, in `manifest.json`. Per-cohort and per-member seeds are
  *derived* from it (`deriveSeed(runSeed, archetypeId, cohortIndex, …)`), so the
  whole population is a pure function of the manifest.
- **`prng.ts`** is a SplitMix64 generator over 64-bit BigInt lanes. Every
  stochastic choice — backoff length, escrow jitter, deliverable hashes — draws
  from it. No `Math.random`, no wall-clock, no ambient entropy.
- **`recording-sdk.ts`** implements the SDK interface but *records* each
  extrinsic to an ordered ledger instead of broadcasting it. That ledger **is**
  the reproducible extrinsic sequence; `digestSequence` folds it to a 64-bit
  digest for compact comparison.

Same manifest + same seed ⇒ identical ledger ⇒ identical digest. This is the
acceptance criterion, and [`tests/replay.test.ts`](tests/replay.test.ts) asserts
it for every `(run, seed)` in the matrix.

## Relationship to the P0-3 SDK

The runners depend on [`types.ts`](types.ts) `AgentSdk` — the minimal §8.3 write
/read surface — **not** on any transport. Two things implement it:

1. **`RecordingSdk`** (here): deterministic, in-memory, dependency-free. Makes
   the acceptance criterion checkable *now*, before a dev node exists.
2. **The real polkadot-js SDK** from **P0-3** (`sdk/`, `ScalarCommonsClient`,
   branch `claude/issue-5-*`). Its method surface — `register`, `stake`,
   `heartbeat`, `createEscrow`, `acceptEscrow`, `completeEscrow`, `submitOracle`,
   `vote`, `settleEra`, `claim` — maps 1:1 onto `AgentSdk`. A thin adapter that
   turns an `account` id into a keyring pair is all that's needed to point the
   same archetypes at a live chain. The recorded `pallet.method` names already
   match the chain (per the SDK README mapping), so the recorded stream is a
   faithful preview of live traffic.

`sdk/` was not merged to `master` when this landed, so the runners ship against
the interface plus the recording implementation. Nothing in the archetypes
changes when the real hands are plugged in.

## Manifest format (`manifest.json`)

```jsonc
{
  "version": 1,
  "runs": [
    {
      "id": "RUN-A",
      "seeds": [1, 2, 3],          // ≥ 3 seeds per run (§6)
      "eras": 20,
      "settlement": { "maxBackoff": 8 },
      "cohorts": [
        { "archetype": "A-1", "count": 2, "params": { "stakeCmn": 5000, "escrowsPerEra": 3 } },
        { "archetype": "A-2", "count": 2, "params": { "stakeCmn": 10000 } }
      ]
    }
  ]
}
```

The bundled manifest encodes the §6 run matrix RUN-A … RUN-F. Counts are scaled
down from the protocol defaults (e.g. sybil N = 1,000) so the recorded stream
stays reviewable; raise `cohort.count` for a full run. RUN-B (work-weighting
disabled) and RUN-F (zero privileged calls) are **chain-spec** deltas — the
archetype population is identical to RUN-A by design, which is why their cohorts
match.

## File map

| File | Role |
|------|------|
| `types.ts` | `AgentSdk` interface, `ExtrinsicRecord`, `Archetype`, contexts |
| `constants.ts` | economic constants from protocol §4 (inputs to P0-1, not authority) |
| `prng.ts` | SplitMix64 PRNG + `deriveSeed` seed derivation |
| `identity.ts` | deterministic account ids + hashes |
| `privileged.ts` | privileged-signer / privileged-call guard (§5) |
| `recording-sdk.ts` | in-memory recording `AgentSdk` |
| `settlement.ts` | permissionless `settle_era`-with-backoff coordinator |
| `a1..a5_*.ts` | the five archetypes |
| `registry.ts` | archetype id → implementation |
| `runner.ts` | manifest execution + replay digest + CLI |
| `manifest.json` | the §6 run matrix |
| `tests/` | determinism, replay, no-privileged-keys, settlement, behaviour |

## Notes / limitations

- Per protocol **HL-1**, these are scripted, non-adaptive archetypes — a pass on
  P4–P6 is a *lower bound* on attack resistance; a fail is a real fail.
- The recording SDK re-implements **no** economics. It only mirrors the minimal
  bookkeeping the runners need to be well-formed (the per-buyer agreement `seq`).
  Emissions, fees, weights, and the supply cap all live in the pallets.
