# Contributing

Read [`CLAUDE.md`](CLAUDE.md) first. It holds the first principles and the hard rules that come
from past bugs, and it applies to people as much as to agents.

## Workflow

1. Pick an issue, or open one. Every PR closes an issue (`Closes #N`).
2. Branch from `main`. Never commit to `main` directly.
3. Keep a PR to one concern, with [Conventional Commits](https://www.conventionalcommits.org/)
   messages such as `fix(escrow): …` or `docs: …`.
4. Label the PR and its issue accurately: the labels choose the changelog section. Do not edit
   `CHANGELOG.md` by hand.
5. GitHub Actions is the merge gate. Report the checks you ran locally in the PR.

## Setup

Run every command from the repository root.

- **TypeScript:** `npm ci` once, then address a package by name, for example
  `npm test -w @scalar-commons/indexer`. One lockfile serves every package; never run `npm ci`
  inside a package. `npm test` is offline; live-chain suites live in `e2e/`.
- **Rust:** the toolchain is pinned in [`rust-toolchain.toml`](rust-toolchain.toml). Local builds
  are supported in WSL2. CI runs the full Rust gate, so a TypeScript-only contributor can rely on
  it.

The command lists are in [`README.md`](README.md#getting-started) and [`CLAUDE.md`](CLAUDE.md).

## Changes that need more

- Emissions, escrow, oracle, orchestrator, agents or runtime economics: a written plan, failing
  tests first, and a gaming-vector analysis in the PR.
- Storage layout: a migration and a `spec_version` bump.
- Chain events: run the affected indexer, explorer, SDK, agent, landing and e2e gates.
- Security issues: follow [`SECURITY.md`](SECURITY.md) instead of opening a PR.
