# e2e  tests that need a live chain

Every test in this repository that talks to a Scalar Commons node lives here. Other
workspaces keep their default test commands offline. CI typechecks this package and
runs the archetype runner's offline unit tests; live suites are deliberate devnet runs.

| Folder | What it checks | Needs |
|---|---|---|
| `lifecycle/` | Pallet lifecycles, asserted through events and storage | A development chain with funded development accounts |
| `faucet/` | Real drips, limits and response metadata | A devnet with the configured faucet seed endowed |
| `indexer/` | The indexer API cross-checked against direct RPC reads | A devnet with development accounts |
| `explorer/` | Node-backed pages after a real transfer | A devnet with the configured test seed endowed |
| `sdk/` | SDK metadata, storage decoding and runtime call conformance | A devnet with registered development agents |
| `archetypes/` | Attacker-archetype accounting and reports | Offline for unit tests; a development chain for the runner |

All live test files use the `*.live.test.ts` suffix. Shared connection, account,
submission and deadline behavior lives in `support/chain.ts`.

## Run

Install and build the SDK once from the repository root:

```bash
npm ci
npm run build -w @scalar-commons/sdk
```

Then run all or one group:

```bash
npm run test:live -w @scalar-commons/e2e
npm run test:live:lifecycle -w @scalar-commons/e2e
npm run test:live:faucet -w @scalar-commons/e2e
npm run test:live:indexer -w @scalar-commons/e2e
npm run test:live:explorer -w @scalar-commons/e2e
npm run test:live:sdk -w @scalar-commons/e2e
npm run archetypes -w @scalar-commons/e2e -- --archetype wash --eras 1
npm run typecheck -w @scalar-commons/e2e
npm test -w @scalar-commons/e2e
```

Live files run one at a time because they sign with shared development accounts and
must not race their nonce streams.

## Endpoints and accounts

| Suite | Variable | Default |
|---|---|---|
| lifecycle | `SCALAR_WS` | `ws://127.0.0.1:9955` |
| faucet | `FAUCET_RPC_ENDPOINT`, `FAUCET_SEED` | `ws://127.0.0.1:9944`, `//Ferdie` |
| indexer | `INDEXER_RPC_URL` | `ws://127.0.0.1:9944` |
| explorer | `EXPLORER_RPC_ENDPOINT`, `EXPLORER_TEST_SEED`, `EXPLORER_INDEXER_URL` | `ws://127.0.0.1:9944`, `//Eve`, `http://127.0.0.1:8080` |
| SDK | `SCALAR_WS` (or `WS_ENDPOINT`) | `ws://127.0.0.1:9944` |
| archetypes | `--endpoint` | `ws://127.0.0.1:9944` |

Lifecycle tests use fresh throwaway accounts funded from `//Alice`. They are for a
development chain and must never target the public testnet.

## Failure and skip policy

A missing or stalled node fails quickly. Extrinsic submission has a deadline and always
unsubscribes after success, rejection or timeout. Each live test file must execute at
least one test.

Set `E2E_ALLOW_SKIP=1` only when intentionally running a command in an environment
without the required node or runtime capability. Without that explicit opt-in, a skipped
suite or capability is a test failure. This prevents a green result that asserted
nothing.

Time-gated behavior that cannot finish under the production runtime constants belongs
in pallet unit tests or a dedicated compressed-timing runtime. The former E7 live test
was removed because the repository has no compressed-timing node and the runtime's
challenge window made that test unreachable.
