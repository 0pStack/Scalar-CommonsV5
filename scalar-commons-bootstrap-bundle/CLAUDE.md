# CLAUDE.md — Scalar Commons

## What this is

Sovereign Substrate / Polkadot SDK chain for autonomous AI-agent coordination.
Native token: **CMN** (1 CMN = 10^12 plancks). **100B hard supply cap, 18B genesis mint.**
Custom pallets: `agents`, `escrow`, `oracle`, `emissions`, `auto-params`, `orchestrator`, `constitution`.
Node.js event indexer (`indexer/`) exposes a 24-endpoint REST API over chain events.
Toolchain: Polkadot SDK 2025.12 line (sp-core 39.x, frame-system 45.x, sp-runtime 45.x).

## First principles — never violate

1. **The supply cap is absolute.** No code path may mint beyond the cap. All minting flows through the emissions pallet only.
2. **Emissions reward verifiable work, not raw stake.** Weight = stake × rank × oracle accuracy × governance participation × velocity bonus. Any change to weighting must preserve this thesis.
3. **No root-gated liveness.** No economically essential function (era settlement, reward claims) may depend on a privileged caller. `settle_era` is permissionless by design — keep it that way.
4. **Every economic parameter is a gaming surface.** Any new extrinsic or parameter change requires a written gaming-vector analysis before merge (use the tokenomics-security-reviewer subagent).
5. **The chain is coordination infrastructure.** Design decisions favor agent coordination guarantees over speculative token mechanics.

## Repo map

- `runtime/src/lib.rs` — runtime + `construct_runtime`; `runtime/src/governance/` — OpenGov config
- `pallets/<name>/src/lib.rs` — pallet logic; `pallets/<name>/src/tests.rs` — unit tests + mock runtime
- `tests/common.rs` — shared integration-test mock runtime
- `node/src/chain_spec.rs` — genesis configs (4 configurations)
- `indexer/` — Node.js event indexer + REST API (JS test suite lives here)

## Commands

All builds/tests run in **GitHub Codespaces or GitHub Actions — never assume a local machine.**

- Build: `cargo build --release` (WASM runtime builds as part of workspace)
- Rust tests: `cargo test --workspace`
- Lint gate: `cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings`
- Indexer tests: `cd indexer && npm test`
- Local 3-validator devnet: see `node/src/chain_spec.rs` configs
  <!-- TODO(Keith): paste the exact testnet launch command you use -->

## Hard rules (encode past bugs — do not regress)

- **Pallet indices in `construct_runtime` are append-only and unique.** Never renumber or reuse an index. (Past bug: SafeMode/TxPause/Constitution duplicated indices 34–36 with Staking/Babe/Grandpa and broke the runtime build.)
- **Every new `Config` type must be added to every test mock** — all `pallets/*/src/tests.rs` AND `tests/common.rs`. Missing mock fields are a hard compile error found late. `BlockNumber`-typed constants use `ConstU64`, not `ConstU32`.
- **Balance arithmetic uses `saturating_*` / `checked_*` only.** No bare `+ - *` on Balance. Basis-point math (`BPS = 10_000`) must be commented with the intended percentage.
- **Guards fire before funds move.** All `ensure!` checks precede any `reserve()`, `transfer`, or `mint` (pattern: oracle `DuplicateRequest` guard sits before `reserve()`).
- **`settle_era` protections stay:** `ensure_signed` (permissionless), `EraNotDue` guard, `EraStartBlock` tracking, and the double-settlement guard (F-04).
- **Gaming-vector guards are load-bearing — never remove:** orchestrator self-link guard (`orchestrator != sub_agent`), `GovVoteVerifier` wired to `pallet_conviction_voting::VotingFor`, `MinQualifyingVol` floor gate (≥50 CMN era volume), `VelocityBonusBps` cap (+30% max).
- **Storage layout changes require a migration and a `spec_version` bump.** Never mutate storage layout silently.
- **Indexer API is versioned.** Changing chain events means checking all 24 indexer endpoints for breakage; update the JS tests in the same PR.

## Workflow

1. Anything touching `emissions`, `escrow`, or `runtime/` starts in **plan mode**. Present the plan before editing.
2. **TDD:** write the failing test first, show it fail, then implement.
3. After every change: run fmt, clippy, and the relevant test suite. **Show the actual output** — never assert success without evidence.
4. Before committing economic changes: invoke the `tokenomics-security-reviewer` subagent. After any code change: invoke `test-runner`.
5. Commits are small and scoped to one pallet or one concern. Reference the pallet in the message (e.g. `emissions: add EraNotDue guard`).
6. Never `git push --force` on main. Never commit `Cargo.lock` conflicts unresolved.

## Style

- Rust doc comments (`//!`, `///`) on every pallet, extrinsic, and storage item, in the existing voice: explain the economic *why*, not just the mechanical *what*.
- Prefer extending an existing pallet over adding a new one; new pallets require a written justification.
