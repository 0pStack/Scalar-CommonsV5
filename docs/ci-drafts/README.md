# CI drafts

Two workflow drafts. They are **not active**: GitHub only runs files in
`.github/workflows/`, and these live here so they can be reviewed without
changing CI. Nothing in this directory is required by branch protection.

| Draft | What it does |
|---|---|
| `ci-devnode.yml` | Builds `scalar-node` (pinned toolchain, rust-cache), starts `--dev --tmp`, waits for RPC, runs `npm test --prefix testkit` with `SCALAR_WS=ws://127.0.0.1:9944`. Uploads the node log. |
| `test-guard.yml` | Fails a PR if the `#[test]` count falls or the `#[ignore]` count rises in `pallets/**` or `testkit/**` (TS `it(`/`test(` and `.skip(`/`.todo(` are counted in `testkit/**/*.ts`), unless the PR carries the label `tests-intentionally-changed`. |

## Enabling

1. A human copies the file(s): `cp docs/ci-drafts/<name>.yml .github/workflows/`
   (agents are not permitted to edit `.github/`).
2. `test-guard` only: create the label once,
   `gh label create tests-intentionally-changed --description "Test count drop / new #[ignore] is deliberate"`.
3. Merge. Run `ci-devnode` a few times via `workflow_dispatch` before trusting it.
4. Only after it has been stable, consider adding either job as a required
   check. Do not make `ci-devnode` required while it is a cold ~30-60 min build.

## Known caveats

- **`testkit/` is not on master yet.** `ci-devnode` fails at `npm ci` until the
  testkit is merged (its `package.json`, `package-lock.json` and an `npm test`
  script). `test-guard` works now, counting only `pallets/**` until then.
- Counting is textual: a `#[test]` inside a comment or a renamed/moved test is
  miscounted. Moving tests between files under the covered paths is neutral;
  moving them out is a drop and needs the label.
- Adding a test and removing another in the same PR nets zero and passes. The
  guard is a tripwire, not a proof.
- The dev node's timing constants (e.g. era duration) come from the `--dev`
  chain spec; testkit lifecycles that assume other values need `dev-fast` or
  a different `--chain`.
- The `ci-devnode` job uses the default `--rpc-port 9944`; adjust `SCALAR_WS`
  together with it.
- Both drafts were only YAML-parsed here, never executed on GitHub Actions.
