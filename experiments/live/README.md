# experiments/live — attacker archetypes against a live chain

ENDGOAL §3.4 requires each attacker archetype to be executed against a live
network, and states the consequence plainly:

> If wash trading still pays, the project does not launch.

**That gate had never been run, and the tooling could not run it.** The previous
archetype runners imported no transport at all — `recording-sdk.ts` appended to
an in-memory array — `scripts/run-eras.sh` and `extract-export.sh` were `exit 1`
stubs, `zombienet.toml` named a binary that does not exist, and `ci/sc-e1.yml`
was never in `.github/workflows/`. TESTNETAUDIT.md §6 I-7, issue #124.

This directory replaces that with something that actually touches the chain.

## What it does

```bash
npm ci
npm test                                   # offline: money maths, accounting, report
node run.mjs --archetype wash --eras 1     # live: real extrinsics, real fees
node run.mjs --archetype all --eras 2 --json out.json
```

Every archetype derives **fresh accounts** from a run-scoped mnemonic, funds
them from `//Alice`, and submits **real extrinsics**. There are no fixtures, no
recorded ledgers and no synthetic numbers anywhere in the output.

## The archetypes

| key | strategy | what it is testing |
|---|---|---|
| `honest` | one provider, three **distinct** buyers | the baseline every other row is compared against |
| `wash` | two accounts trading with each other | ENDGOAL §3.4's named blocker |
| `sybil` | a five-account ring, each buying from the next | `MinQualifyingVol` and the stake-weighted diversity cap |
| `oracle` | a bloc answering its own question identically | expected **inert**: `OracleScoreProvider = ()` |
| `governance` | votes without working | the V4 gate that makes the gov term require `work_score > 0` |
| `passive` | stakes and does nothing | the claim that stake alone earns nothing |

## How net CMN is computed

```
net = (free_after + claimable_after) - funded
```

summed over every account the archetype controls. Deliberately blunt: it charges
the strategy for every transaction fee, every escrow completion fee, and every
planck still locked in stake, and credits it with every reward actually
reachable. There is no model of what the strategy *should* have paid — if the
chain took it, the archetype paid it.

**Bonded stake counts as a cost.** An archetype ending an era with 1 000 CMN
still locked has not earned it back, and a ledger that credited it would report
ring farming as roughly free.

## Costs are always real; rewards need a settled era

Registration fees, completion fees and transaction fees are paid the moment the
strategy runs. Emissions are not reachable until `settle_era` runs — which is
what the keeper from #125 does, once per 3 600-block era.

So a run that does not wait for a settlement measures **only the cost side**,
and it says so:

```
!! INCOMPLETE — no era settled during this run.
   ... Do NOT read a negative number here as "the attack is unprofitable".
```

Use `--eras 0` to deliberately measure costs only, `--eras N` to wait for N
settlements, and `--wait-minutes` to bound the wait. A run that gives up waiting
reports `PARTIAL` rather than pretending.

## Timing

An escrow cannot be delivered faster than `MinDeliveryBlocks` (10 blocks, ~60 s)
after creation — `record_delivery` enforces `now >= created_at +
MinDeliveryBlocks`. That is the chain's own floor on how fast a ring can cycle,
and every wash-style strategy pays it in wall-clock time. One `--rounds 1` wash
run is therefore ~3–4 minutes before any waiting for settlement.

A full six-hour era means a full-fidelity `--archetype all --eras 1` run takes
about that long. That is the honest cost of measuring this against a real chain
instead of a fixture.

## Reading the output

- `net CMN` is **signed**, always. `+0.0000` means break-even, which is not a loss.
- `vs honest` is the difference against the baseline row.
- **`PROFITABLE AND BEATS HONEST WORK`** is the ENDGOAL §3.4 launch blocker.
- **Refused extrinsics are printed.** A strategy the chain *blocks* is a
  completely different finding from one it merely makes unprofitable, and the
  report keeps them apart.

## What this does not do yet

- It does not run the full five-archetype gate on a schedule; that is a separate
  step and a separate decision, because it costs real eras of wall-clock time.
- `claimable()` returns 0 unless the runtime exposes a pending-rewards API, so
  between settlement and `claim()` an archetype's rewards are counted only after
  they are claimed. The runner claims for every account when a settlement
  happened, so the measured net is complete for `SETTLED` runs.
