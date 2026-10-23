# CLAUDE.md - Scalar Commons

## What this is

Scalar Commons is a sovereign Polkadot SDK chain for autonomous AI-agent coordination.
The native token is CMN, and emissions reward verifiable work.

Do not copy version numbers, economic values, formulas, pallet counts, or API counts into this
file. Use the repository sources that are checked with the code:

- [`Cargo.toml`](Cargo.toml), [`Cargo.lock`](Cargo.lock), and
  [`rust-toolchain.toml`](rust-toolchain.toml) define the SDK and Rust toolchain.
- [`docs/reference/token-model.md`](docs/reference/token-model.md) contains the reward formula and
  token constants checked against [`docs/.chain/snapshot.json`](docs/.chain/snapshot.json).
- [`docs/reference/rpc.md`](docs/reference/rpc.md) documents the runtime and RPC surface.
- [`package.json`](package.json) defines the npm workspaces and root scripts.
- [`deploy/nodes.env`](deploy/nodes.env) defines the persistent devnet topology.

## First principles - never violate

1. **The supply cap is absolute.** No code path may mint beyond the runtime-defined cap. Trace the
   runtime constant and every issuance path before changing minting.
2. **Emissions reward verifiable work, not raw stake.** Treat the formula in the generated token
   model as canonical. Any weighting change requires tests and a gaming-vector analysis.
3. **No root-gated liveness.** Economically essential functions such as era settlement and reward
   claims must not depend on a privileged caller.
4. **Every economic parameter is a gaming surface.** Any extrinsic or parameter change requires a
   written gaming-vector analysis before merge using the tokenomics security reviewer.
5. **The chain is coordination infrastructure.** Prefer agent coordination guarantees over
   speculative token mechanics.

## Repository map

- `node/` - service, CLI, and chain presets
- `runtime/` - runtime assembly, APIs, governance configuration, and version
- `pallets/<name>/` - custom pallet logic, mocks, and unit tests
- `tests/` - Rust integration tests and shared mock runtime
- `sdk/`, `agent/`, `faucet/`, `indexer/`, `explorer/`, `landing/`, `docs/`, `e2e/` - npm
  workspaces listed in the root `package.json`
- `e2e/` - live-chain suites plus offline archetype-runner unit tests
- `deploy/` - chain spec, persistent devnet, service units, and operator scripts

## Development environment

Local work is supported in WSL2 using the team setup guide. Use package-scoped commands while
iterating, then run the complete affected gate. GitHub Actions is the merge gate. Release runtimes
and release node binaries come from CI.

Run Rust and npm commands from the repository root.

### Rust

```sh
cargo build --release
cargo test -p pallet-<name>             # while changing one pallet
cargo test -p scalar-commons-runtime    # while changing runtime-only behavior
cargo test --workspace                  # complete Rust test gate
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
```

### JavaScript and TypeScript

```sh
npm ci
npm run build
npm run typecheck
npm test                                # offline; no running chain
npm run test:tooling
npm run format:check
npm run lint
npm run coverage
```

Address a workspace by its package name. For example:

```sh
npm run typecheck -w @scalar-commons/indexer
npm test -w @scalar-commons/indexer
npm run lint -w @scalar-commons/docs
npm run build -w @scalar-commons/docs
npm run build -w @scalar-commons/sdk
npm run typecheck -w @scalar-commons/e2e
npm test -w @scalar-commons/e2e         # offline archetype-runner unit tests
```

Live-chain suites are deliberate devnet runs, not part of the root offline test command:

```sh
npm run test:live -w @scalar-commons/e2e
```

See [`e2e/README.md`](e2e/README.md) for individual live suites and required services.

### Persistent local devnet

The persistent systemd devnet uses the `local` chain preset. Its topology comes from
`deploy/nodes.env`; do not duplicate the validator count here.

```sh
cargo build --release -p scalar-node
./deploy/build-spec.sh
./deploy/install.sh
systemctl --user start scalar-devnet.target
./deploy/finality-check.sh
```

Use `systemctl --user stop scalar-devnet.target` when the network is not needed. The `dev` and
`local` presets have different authority sets; do not substitute one for the other. Follow
[`deploy/README.md`](deploy/README.md) for installation, reset, status, and recovery procedures.

## Hard rules - encoded from past bugs

- **Pallet indices in `construct_runtime` are append-only and unique.** Never renumber or reuse an
  index.
- **Every new `Config` type must be added to every affected test mock**, including the shared
  integration-test mock. Match the runtime's block-number type.
- **Balance arithmetic uses `saturating_*` or `checked_*`.** Do not use bare arithmetic on balance
  values. Cite the runtime constant used as the denominator in basis-point calculations.
- **Guards fire before funds move.** All fallible validation precedes reserve, transfer, mint, and
  storage mutation.
- **Era-settlement protections stay intact:** permissionless signed origin, due-era validation,
  start-block tracking, and double-settlement prevention.
- **Gaming-vector guards are load-bearing.** Preserve the orchestrator self-link guard, the real
  governance vote verifier, the qualifying-volume floor, and the velocity-bonus cap. Read their
  current values from runtime configuration and the generated token model.
- **Storage layout changes require a migration and a `spec_version` bump.**
- **Chain event changes require consumer checks.** Run the affected indexer, explorer, SDK, agent,
  landing, and e2e gates; use the generated RPC reference instead of a copied endpoint count.

## Workflow

1. Changes to emissions, escrow, oracle, orchestrator, agents, or runtime economics begin with a
   written plan and failing tests.
2. Use test-driven development for behavior changes: reproduce the failure, implement the fix, and
   preserve the regression test.
3. Run the smallest relevant checks while editing, then the complete affected gate before push.
   Report actual command output.
4. Run the tokenomics security reviewer after economic changes and the test runner after code
   changes.
5. Keep commits small and scoped to one concern. Use Conventional Commits, for example
   `fix(emissions): reject settlement before the era is due` or
   `docs: correct the local devnet instructions`.
6. Never force-push `main`, and never commit unresolved lockfile conflicts.

## Releases and changelog

`.github/workflows/changelog-release.yml` owns release notes and tags. Do not edit `CHANGELOG.md`
or push release tags by hand.

- Every merged PR becomes a changelog entry unless it carries `skip-changelog`.
- Label PRs and issues accurately and use `Closes #N`.
- Runtime and node release rules live in the workflow and release documentation.
- A release publishes artifacts; enactment still requires an explicit runtime upgrade.
- Use the workflow's manual dispatch when an authorized release must be forced.

## Style

- Document the economic reason for pallet, extrinsic, and storage behavior.
- Prefer extending an existing pallet over adding a new one. New pallets need a written
  justification.
