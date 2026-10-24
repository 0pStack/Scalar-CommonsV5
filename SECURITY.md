# Security policy

Scalar Commons is pre-mainnet. The live network is a public testnet, and its tokens carry no value.
Bugs that let someone mint beyond the supply cap, move or lock funds they do not own, take a
privileged origin, or stop era settlement are still treated as security issues.

## Supported versions

Only the runtime currently enacted on the live testnet and the latest
[release](https://github.com/0pStack/Scalar-CommonsV5/releases/latest) of `scalar-node` get
fixes. Older releases are not patched.

## Reporting a vulnerability

Do not open a public issue or pull request for a vulnerability.

- While this repository is private, report to the repository owner,
  [@0pStack](https://github.com/0pStack), through a private channel you already share with the
  team.
- Once the repository is public, use **Report a vulnerability** on the repository's
  **Security** tab (GitHub private vulnerability reporting).

Include the affected pallet, extrinsic or package, the commit or release, and steps to reproduce.
For economic issues, describe the gaming vector: who gains, by how much, and at whose cost.

## What happens next

We confirm the report, reproduce it, and agree on a disclosure date with you. Fixes land through
a runtime upgrade or a node release; see [`CHANGELOG.md`](CHANGELOG.md). Advisories in
third-party dependencies are tracked by the `deps` job in `ci-fast` (`deny.toml`,
`.cargo/audit.toml`).
