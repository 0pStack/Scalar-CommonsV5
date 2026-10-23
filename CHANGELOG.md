# Changelog

Every PR merged to `main` gets an entry under **Unreleased**, written by
`.github/workflows/changelog-release.yml`. The section comes from the labels on
the PR and on the issues it closes: `security` → Security, `bug` → Fixed,
`documentation` → Documentation, `tidy`/`qa` → Maintenance, anything else →
Changed. Label a PR `skip-changelog` to leave it out.

A release (a `vX.Y.Z` tag plus a prebuilt `scalar-node`) is cut automatically
when the merge leaves the shipped node different from the last tag:

- **minor**: the runtime `spec_version` differs from the last tag's
- **patch**: `node/` changed since the last tag
- otherwise no release; entries wait under Unreleased for the next one

`spec_version` is the on-chain version; a release does not enact it on any
chain. That still takes `system.setCode` from root.

## Unreleased

### Fixed

- SDK: add escrow consent calls; acceptEscrow becomes recordDelivery ([#164](https://github.com/0pStack/Scalar-CommonsV5/pull/164), closes [#64](https://github.com/0pStack/Scalar-CommonsV5/issues/64))

### Documentation

- fix(docs): verify runtime snapshot and docs base ([#163](https://github.com/0pStack/Scalar-CommonsV5/pull/163), closes [#100](https://github.com/0pStack/Scalar-CommonsV5/issues/100))

### Maintenance

- fix(ts): validate tests and workspace SDK setup ([#162](https://github.com/0pStack/Scalar-CommonsV5/pull/162), closes [#102](https://github.com/0pStack/Scalar-CommonsV5/issues/102))

## [v0.7.3] - 2026-10-22

### Security

- fix(node): refuse the libp2p network backend ([#161](https://github.com/0pStack/Scalar-CommonsV5/pull/161), closes [#160](https://github.com/0pStack/Scalar-CommonsV5/issues/160))

### Maintenance

- chore: run every Claude agent and workflow on Claude Opus 5.5 ([#149](https://github.com/0pStack/Scalar-CommonsV5/pull/149), closes [#148](https://github.com/0pStack/Scalar-CommonsV5/issues/148))
- chore(deps-dev): bump typescript from 5.9.3 to 7.0.2 ([#153](https://github.com/0pStack/Scalar-CommonsV5/pull/153))
- ci(deps): stop Dependabot proposing npm majors ([#159](https://github.com/0pStack/Scalar-CommonsV5/pull/159))
- ci(deps): bump the actions group across 1 directory with 5 updates ([#151](https://github.com/0pStack/Scalar-CommonsV5/pull/151))

## [v0.7.2] - 2026-10-22

### Security

- ci: Dependabot, cargo-deny and cargo-audit for every dependency ([#150](https://github.com/0pStack/Scalar-CommonsV5/pull/150), closes [#37](https://github.com/0pStack/Scalar-CommonsV5/issues/37))

### Fixed

- fix(release): survive a failing commit-to-PR lookup ([#141](https://github.com/0pStack/Scalar-CommonsV5/pull/141), closes [#140](https://github.com/0pStack/Scalar-CommonsV5/issues/140))

### Documentation

- docs: guides describe provider consent as required since spec 309 ([#138](https://github.com/0pStack/Scalar-CommonsV5/pull/138), closes [#44](https://github.com/0pStack/Scalar-CommonsV5/issues/44))
- docs: align contributor and agent instructions ([#139](https://github.com/0pStack/Scalar-CommonsV5/pull/139), closes [#99](https://github.com/0pStack/Scalar-CommonsV5/issues/99))
- docs: refresh README and keep its release badge current ([#147](https://github.com/0pStack/Scalar-CommonsV5/pull/147), closes [#146](https://github.com/0pStack/Scalar-CommonsV5/issues/146))

## [v0.7.1] - 2026-10-22

### Fixed

- emissions + orchestrator: don't pay skipped eras at the current weight ([#132](https://github.com/0pStack/Scalar-CommonsV5/pull/132), closes [#23](https://github.com/0pStack/Scalar-CommonsV5/issues/23))
- fix: compile the runtime-benchmarks feature on stable2606 ([#137](https://github.com/0pStack/Scalar-CommonsV5/pull/137), closes [#136](https://github.com/0pStack/Scalar-CommonsV5/issues/136))

### Maintenance

- ci: run e2e's offline archetype tests in the e2e job ([#133](https://github.com/0pStack/Scalar-CommonsV5/pull/133), closes [#56](https://github.com/0pStack/Scalar-CommonsV5/issues/56))
- Tooling: unify JS quality, coverage, and CI gates ([#134](https://github.com/0pStack/Scalar-CommonsV5/pull/134), closes [#94](https://github.com/0pStack/Scalar-CommonsV5/issues/94))
- docs: agree repository structure migration plan ([#135](https://github.com/0pStack/Scalar-CommonsV5/pull/135), closes [#95](https://github.com/0pStack/Scalar-CommonsV5/issues/95))

## [v0.7.0] - 2026-10-22

### Security

- runtime: ship quick-fix security bundle ([#121](https://github.com/0pStack/Scalar-CommonsV5/pull/121), closes [#19](https://github.com/0pStack/Scalar-CommonsV5/issues/19))

## [v0.6.0] - 2026-10-22

### Security

- rank-2 agents can no longer act as Root; agents who leave lose their rank ([#109](https://github.com/0pStack/Scalar-CommonsV5/pull/109), closes [#18](https://github.com/0pStack/Scalar-CommonsV5/issues/18))
- fix: cap the faucet's total losses and keep its limits across restarts ([#110](https://github.com/0pStack/Scalar-CommonsV5/pull/110), closes [#20](https://github.com/0pStack/Scalar-CommonsV5/issues/20))
- fix: stop add_stake re-locking stake the account already has locked ([#113](https://github.com/0pStack/Scalar-CommonsV5/pull/113), closes [#58](https://github.com/0pStack/Scalar-CommonsV5/issues/58))
- runtime: shut down unsafe ranked referendum route ([#111](https://github.com/0pStack/Scalar-CommonsV5/pull/111), closes [#59](https://github.com/0pStack/Scalar-CommonsV5/issues/59))
- runtime: enforce emergency filters without halting recovery ([#115](https://github.com/0pStack/Scalar-CommonsV5/pull/115), closes [#60](https://github.com/0pStack/Scalar-CommonsV5/issues/60))
- escrow: make oracle dispute settlement atomic ([#116](https://github.com/0pStack/Scalar-CommonsV5/pull/116), closes [#61](https://github.com/0pStack/Scalar-CommonsV5/issues/61))
- Upgrade Polkadot SDK to stable2606-3, spec_version 313 ([#124](https://github.com/0pStack/Scalar-CommonsV5/pull/124), closes [#30](https://github.com/0pStack/Scalar-CommonsV5/issues/30))

### Fixed

- release the dispute bounty in escrow so it is reserved only once ([#119](https://github.com/0pStack/Scalar-CommonsV5/pull/119), closes [#16](https://github.com/0pStack/Scalar-CommonsV5/issues/16))
- reject unsafe-integer offset and filters with 400 ([#120](https://github.com/0pStack/Scalar-CommonsV5/pull/120), closes [#28](https://github.com/0pStack/Scalar-CommonsV5/issues/28))
- agent rejects dropped, invalid and silent submits instead of hanging ([#122](https://github.com/0pStack/Scalar-CommonsV5/pull/122), closes [#57](https://github.com/0pStack/Scalar-CommonsV5/issues/57))
- oracle: consume live auto-param quorum ([#130](https://github.com/0pStack/Scalar-CommonsV5/pull/130), closes [#21](https://github.com/0pStack/Scalar-CommonsV5/issues/21))

### Changed

- chore: store and check out every text file with LF ([#112](https://github.com/0pStack/Scalar-CommonsV5/pull/112))

### Maintenance

- ci: automate CHANGELOG.md and node releases from merged PRs ([#129](https://github.com/0pStack/Scalar-CommonsV5/pull/129), closes [#128](https://github.com/0pStack/Scalar-CommonsV5/issues/128))

## [v0.5.0] - 2026-10-20

First tagged release: a prebuilt `scalar-node` for outside validators, runtime
spec 309 on `polkadot-stable2503`, matching the live testnet. Changes before
this tag are not itemised here; see `git log v0.5.0`.
