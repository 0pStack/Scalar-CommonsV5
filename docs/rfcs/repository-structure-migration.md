# Repository structure migration plan

| Field | Value |
|---|---|
| Status | Proposed; accepted when the review PR for issue #95 is merged |
| Scope | Repository layout and migration order only |
| Tracking issue | [#95](https://github.com/0pStack/Scalar-CommonsV5/issues/95) |
| Delivery rule | One migration step per pull request |

## Decision

Keep the Rust workspace at the repository root. Moving `node/`, `runtime/`, or `pallets/`
would invalidate filed `file:line` references, add review noise, and force an avoidable cold Rust
CI run without changing a crate boundary.

Move the JavaScript applications, shared TypeScript library, operations scripts, deployment files,
and documentation into directories that state their ownership and deployment boundary. Perform the
migration incrementally so every pull request can be reviewed, tested, and reverted independently.

## Target tree

```text
node/ runtime/ pallets/                 Rust crates stay in place
integration-tests/                      current tests/
packages/sdk/                           shared TypeScript library
apps/
  agent/
  faucet/
  indexer/
  explorer/
  landing/
e2e/                                    all live-chain suites, including SDK and economics
scripts/
  ops/
  ci/                                   one workspace package; root-key tools stay out of CI helpers
deploy/
  devnet/
  services/
  web/
  chain-specs/
  validator/
  hardening/
docs/
  site/                                 the only published documentation subtree
  design/
  adr/
  history/
  data/
  scripts/
examples/matty-agent/
.github/
  workflows/
  actions/
  workflow-drafts/
```

`factory/` leaves this repository under #89. The stale files listed by #103 are archived rather
than carried into the target tree. The published chain specification becomes generated output: its
only intended difference from `deploy/scalar-local-raw.json` is `bootNodes`.

## Migration sequence

The rows below are pull-request boundaries. A row may reference several issues, but its code and
path changes must land in one dedicated PR and must not be mixed with the next row.

| Step | Change | Tracking | Required result before the next step |
|---:|---|---|---|
| 1 | Add standard root files and CODEOWNERS | #93 | Ownership and root conventions are reviewable before paths move |
| 2 | Correct CI path selection and run the offline e2e suite | #91, #56 | Every later rename is observed by CI; action pinning remains the separate #90 PR |
| 3 | Establish the published-docs boundary with VitePress `srcDir` | #62 | Only `docs/site/` can be published |
| 4 | Archive stale documents and scripts | #103 | Dead files do not create false move work |
| 5 | Address workspaces by package name and adopt naming rules | #52 | CI and local commands use `-w @scalar-commons/<name>` before directories move |
| 6 | Unify Vitest and add formatting, linting, coverage, ShellCheck, and actionlint | #94, PR #134 | The formatting-only commit is ignored by blame and all quality gates exist |
| 7 | Complete offline test renames and move remaining SDK live tests to `e2e/` | #52, #54 | Offline and live-suite ownership is explicit |
| 8 | Move `sdk/` to `packages/sdk/` and `agent/` to `apps/agent/` | #53 | Root scripts no longer resolve `@polkadot` through `../sdk/package.json`; systemd names are unchanged |
| 9 | Extract `factory/` into its own repository | #89 | No factory runtime or permissions remain in this repository |
| 10 | Template and harden systemd units | #42, #84 | Units contain no machine-specific home path and preserve service names |
| 11 | Move remaining apps and deployment paths during an operator host day | #41, #42, #53 | Live services, web deployment, and rollback are verified on the host |
| 12 | Remove Rust workspace and test-helper duplication | #46 | Rust cleanup is isolated from module splitting |
| 13 | Split `runtime/src/lib.rs` into configs, bridges, APIs, version, and genesis presets | #86, #30, #38 | Metadata paths, runtime behavior, and release fingerprints remain stable |
| 14 | Split oversized pallet modules, starting with agents and escrow | #46, #38 | Metadata type paths remain stable and benchmarks/weights stay paired with code |

PR numbers are added to the tracking issue as each step starts. A later step does not begin until
its predecessor is merged or the plan is explicitly amended in a reviewable documentation PR.

## Migration constraints

- Do not combine a path move with behavior changes. First make imports and builds work at the new
  path; change behavior in a later PR.
- Preserve package names while directories move. Consumers use workspace names, never relative
  filesystem traversal into another package.
- Preserve systemd unit names through the directory migration. Template contents before changing
  host paths.
- Keep `node/`, `runtime/`, and `pallets/` at the root throughout this plan.
- Keep FRAME metadata type paths stable when splitting pallets. Types that contribute to metadata
  stay inside `mod pallet` unless a reviewed migration proves the encoded metadata is unchanged.
- Generate the published chain spec from its source plus the deployment-specific `bootNodes`
  overlay. Do not maintain a second hand-edited copy.
- Keep root-key operational tools separate from ordinary CI helpers and require an explicit live
  execution mode.
- Update path filters, CODEOWNERS, documentation links, package exports, and deployment references
  in the same PR as each move.

## Verification for every migration PR

1. Search for the old path in workflows, scripts, systemd units, documentation, package manifests,
   and source imports. Any remaining reference must be deliberate and documented.
2. Run the smallest relevant tests while editing, then the complete affected gate before push.
3. For TypeScript moves, run clean install, build, typecheck, offline tests, formatting, linting, and
   coverage from the workspace root.
4. For Rust moves, run `cargo fmt --all -- --check`, Clippy with warnings denied, and the affected
   Rust tests. Steps 12–14 require the complete Rust CI gate.
5. Run ShellCheck and actionlint whenever shell paths or workflows change.
6. For host-facing steps, record the deployed unit, health check, and rollback result in the PR.
7. Revert only the current migration PR if a path change fails. Do not repair it by pulling a later
   step forward.

## Explicitly deferred splits

The following files are large, but splitting them before their migration step would mix cleanup
with path changes and make review harder:

- `runtime/src/lib.rs`: configs, bridges, runtime APIs, version, and genesis presets in step 13.
- `pallets/agents/src/lib.rs`: weights, traits, and implementation modules in step 14; metadata
  types remain inside `mod pallet`.
- `pallets/escrow/src/lib.rs`: the same pallet split discipline in step 14.
- Landing instruments and `landing/src/observatory.css`: split after the application reaches
  `apps/landing/`.
- Indexer API, store, and chain-state modules: split after `apps/indexer/` exists.
- `e2e/indexer/live.test.ts`: split after all live suites use the final `e2e/` layout.
- `factory/review.sh`: belongs to the extracted repository and is not refactored here.

## Consequences

The migration takes more PRs, but each PR has one ownership boundary, a smaller rollback surface,
and a meaningful CI result. Rust history and filed findings keep their paths. Package consumers stop
depending on incidental directory layout before paths move. Host changes occur only after offline
renames and templates have already been reviewed.
