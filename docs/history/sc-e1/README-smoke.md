# SC-E1 Zombienet smoke test

Proves the ephemeral-network path of protocol §8.1 end-to-end **before** any
pre-registration-locked counted run. It is a harness sanity check, not a SEEV run.

## What it does

1. Builds the node and installs a pinned `zombienet` binary.
2. Spawns a **3-validator** ephemeral network from [`zombienet.toml`](./zombienet.toml)
   on the `sc-e1` fast-era chain-spec preset.
3. Runs **5 fast eras** with a tiny synthetic population via the agent SDK
   (settlement stays permissionless — no privileged keys).
4. Extracts the indexer measurement export (§8.4).
5. Uploads the export as a workflow artifact and **fails if it is empty or missing**.

## Files

| File | Role |
|---|---|
| `zombienet.toml` | 3-validator native-provider network topology |
| `scripts/run-eras.sh` | Drive N eras via the SDK (§8.3) |
| `scripts/extract-export.sh` | Pull the indexer export (§8.4) |
| `scripts/check-export.sh` | Artifact guard — non-empty export or fail |
| `ci/sc-e1.yml` | The CI job (`workflow_dispatch`); install into `.github/workflows/` (see below) |

## Dependency gates (not yet merged)

This is **scaffolding**. The integration points fail loudly until their PRs land —
each is marked `# TODO: unblock after PR #N merges` in the relevant file:

| Gate | PR | Blocks |
|---|---|---|
| P0-2 fast-era `sc-e1` chain-spec preset + buildable node binary | #4 | node build, `chain = "sc-e1"` |
| P0-3 TypeScript agent SDK (`sdk/`) | #5 | `run-eras.sh` |
| P0-5 indexer measurement export (`indexer/`) | #7 | `extract-export.sh` |

When all three merge: remove the TODO stubs, wire the real SDK/indexer commands,
and switch the workflow trigger from manual-only to `pull_request:` / `schedule:`.

## Installing the workflow

The GitHub App that authored this branch lacks the `workflows` permission, so it
**cannot** commit files under `.github/workflows/`. The workflow therefore lives
at `ci/sc-e1.yml` in this directory. A human with push rights must copy it into
place (one command, one commit):

```sh
cp experiments/sc-e1/ci/sc-e1.yml .github/workflows/sc-e1.yml
git add .github/workflows/sc-e1.yml && git commit -m "ci: install sc-e1 smoke workflow"
```

## Running locally / manually

Once dependencies are merged, trigger via the Actions tab (**sc-e1-smoke** →
Run workflow), or run the pieces by hand against a live devnet:

```sh
zombienet spawn experiments/sc-e1/zombienet.toml --provider native
bash experiments/sc-e1/scripts/run-eras.sh 5 8 ws://127.0.0.1:9944
bash experiments/sc-e1/scripts/extract-export.sh ws://127.0.0.1:9944 experiments/sc-e1/export
bash experiments/sc-e1/scripts/check-export.sh experiments/sc-e1/export
```
