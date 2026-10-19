# CONTEXT.md — current state of the public testnet, for the next session

Short, dated facts that are not obvious from the code. Newest first. Each entry says where the
evidence lives.

## 2026-09-24/25 — validator onboarding opened, agent and validator guides published

### Chain parameters (D11, issue #159)

| | Value | Block | Extrinsic |
|---|---|---|---|
| `staking.validatorCount` | 5 → **7** | #750 511 | `0x21b0f253d7f6bde2307b344efa164d0b9d5adfa272eb8798ebff9dced8644cc1` |
| `staking.minValidatorBond` | 0 → **1 000 CMN** | #750 515 | `0x5dcec038dc0840cff2b4b5add0a8ba87065e8e8fc74a2e966b3f53e070918f1f` |
| `staking.minNominatorBond` | 0 → **100 CMN** | #750 515 | same |

Both are `sudo.sudo(...)` via `scripts/apply-upgrade.mjs --call` (added in #171), which reuses
the upgrade script's key handling and fee preflight. All five operator validators kept authoring;
the era-70 election returned exactly the same five.

**Validators are unpaid** (D2): `EraPayout = ()`. The decision on paying outsiders is #172
(`tier:T0`).

### Releases

`.github/workflows/release.yml` builds `scalar-node` for Linux x86_64 on every `v*` tag and
publishes it with a `.sha256`. First release: **v0.306.0** (commit `206936f`, runtime spec 306),
sha256 `7f6efa029e3f94f8f100f2d9f9797d865789e532dc753bf853f317877bfa455d`.

### Site auto-redeploy (#158)

`scalar-redeploy.timer` (systemd user unit, installed from `deploy/products/`) runs every
10 minutes. It fetches `origin/master` into `~/scalar-products/site-src`, and only when new
commits touch `landing/` or `docs/` builds both sites into `/var/www/scalarnet/.staging.*` and
swaps them in with `mv --exchange`. The last deployed SHA is in
`~/scalar-products/redeploy/last-deployed-sha`. `journalctl --user -u scalar-redeploy`.
**Do not hand-run `redeploy-site.sh` into the live webroots any more** — the timer owns them.

### New public docs

- `/docs/guide/run-an-agent-public-testnet` — reference agent daemon (`examples/reference-agent`),
  SDK install from a packed tarball (not on npm), live costs, A/B escrow proof, era-61 claim.
  **`/docs/guide/run-an-agent` is a different page** — the `agent/` worker from #189, merged by
  the owner while this run waited on the validator's exit. Two reference agents now exist;
  which is canonical is #214 (`tier:T0`).
- `/docs/guide/run-a-validator` — release binary or source build, systemd user unit
  (`deploy/validator/`), keys, bond, election proof.

### Economic observation worth keeping

Emissions era 61 (settled #754 158) is the first observed era where one clean, single-buyer
10 CMN job was the only qualifying volume: `EmissionCappedByVolume` cut the 270 000 CMN
agent-count ceiling to **10 CMN**, and the provider claimed all of it (#754 159). The α-bound
works as designed; #167 (flow can be recycled) is still open.

### Findings filed

#172 (T0 validator rewards), #214 (T0 two reference agents), #173 (faucet `/health` stale specVersion), #174 (SDK capability and
install gaps), #175 (indexer loses completed escrows).

### Throwaway state on the devnet host

Outsider test artifacts live in `~/outsider-validator.*`, `~/outsider-srcbuild.*`,
`~/ref-agent-proof.*` and `~/sdk-install-check.*`. None hold operator keys. The test agent
accounts A `5CFbRsiZ…hBxy` and B `5F9YYu5R…wjYv` remain registered with 1 000 CMN stake each.
