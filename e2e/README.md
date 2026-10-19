# e2e — tests that need a live chain

Every test in this repository that talks to a real Scalar Commons node lives here, so
that every other package's `npm test` is offline. CI (`.github/workflows/ci-node.yml`)
**typechecks** this package and never runs its live suites: a hosted runner has no chain.

| Folder | What it checks | Needs |
|---|---|---|
| `lifecycle/` | pallet lifecycles (agents, auto-params, emissions, escrow, oracle, orchestrator), asserted on events and read-back storage | a **dev** chain: throwaway accounts are funded from `//Alice` |
| `faucet/` | the faucet's real drips, rate limits and metadata shapes | a devnet with `//Ferdie` endowed |
| `indexer/` | the indexer against finalized blocks, cross-checked against RPC on all 25 v1 endpoints | a devnet with dev accounts |
| `explorer/` | explorer pages rendered from a node, after one real transfer | a devnet with `//Eve` endowed (the suite does not exercise `/activity`, the one page that reads the indexer) |
| `archetypes/` | the ENDGOAL §3.4 attacker archetypes, with net CMN per archetype ([README](./archetypes/README.md)) | a dev chain, funded from `//Alice` |

## Run

Install once at the repository root (`npm ci`) and build the SDK the suites import
(`npm run build -w sdk`), then, from the root:

```bash
npm run test:live -w e2e              # lifecycle + faucet + indexer + explorer
npm run test:live:lifecycle -w e2e
npm run test:live:faucet -w e2e
npm run test:live:indexer -w e2e
npm run test:live:explorer -w e2e
npm run archetypes -w e2e -- --archetype wash --eras 1
npm run typecheck -w e2e              # offline; what CI runs
npm test -w e2e                       # offline: the archetype runner's own unit tests
```

`npm test` here runs only the offline unit tests of the archetype runner (its money
maths, ledger and report table), so the root `npm test` stays offline. The live suites
are the `test:live*` scripts.

Files run one at a time (`fileParallelism: false` in `vitest.config.ts`): every suite
signs with genesis dev accounts, and parallel files would race their nonces.

## Endpoints

Each suite keeps the variable it always had:

| Suite | Variable | Default |
|---|---|---|
| lifecycle | `SCALAR_WS` | `ws://127.0.0.1:9955` |
| faucet | `FAUCET_RPC_ENDPOINT`, `FAUCET_SEED` | `ws://127.0.0.1:9944`, `//Ferdie` |
| indexer | `INDEXER_RPC_URL` | `ws://127.0.0.1:9944` |
| explorer | `EXPLORER_RPC_ENDPOINT`, `EXPLORER_TEST_SEED`, `EXPLORER_INDEXER_URL` | `ws://127.0.0.1:9944`, `//Eve`, `http://127.0.0.1:8080` |
| archetypes | `--endpoint` | `ws://127.0.0.1:9944` (`node archetypes/run.mjs --help`) |

## When no node answers

- `lifecycle/` **skips**, with a console warning naming the endpoint.
- `faucet/`, `indexer/` and `explorer/` **fail**. An unreachable node is a finding for
  them, not a reason to assert nothing.

## Why one package

The suites share their dependencies (`@polkadot/*`, the workspace SDK for the chain
constants, and vitest) and one vitest config, so they are one workspace package. The faucet, indexer and explorer suites
import their app's `src/` by relative path. The apps export no library entry point,
and `tsconfig.json` here typechecks those sources together with the tests. The
lifecycles have their own `lifecycle/tsconfig.json` only to relax
`noUncheckedIndexedAccess`, which they predate. The package is on vitest 3: the
lifecycles call `ctx.skip(reason)`, which takes a reason only from vitest 3.
