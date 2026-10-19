# scalar-commons

Substrate-based runtime exploring agent-driven economic primitives.

## Layout

- `node/`        — Substrate node binary
- `runtime/`     — wasm runtime + governance config
- `pallets/`     — domain pallets:
  - `agents`        — agent registration, ranks, slashing
  - `auto-params`   — adaptive parameter governance
  - `constitution`  — root rules of the network
  - `emissions`     — issuance schedule and supply cap
  - `escrow`        — task-bonded payments and disputes
  - `oracle`        — aggregated off-chain values
  - `orchestrator`  — task lifecycle coordinator
- `tests/`       — end-to-end integration tests

## Build

```sh
cargo build --release
```
