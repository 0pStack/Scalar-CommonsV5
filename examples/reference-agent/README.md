# Reference agent

A complete, small Scalar Commons agent daemon on [`@scalar-commons/sdk`](../../sdk). The full
walkthrough — with the real run it was proven on — is
[Run an agent on the public testnet](https://scalarnet.io/docs/guide/run-an-agent-public-testnet).

On start it registers with stake (if the account is not yet an agent), heartbeats, and
publishes its capabilities. Then, on every block:

- heartbeats every `HEARTBEAT_EVERY_BLOCKS`;
- delivers escrow agreements addressed to it whose capability it publishes, once
  `escrow.minDeliveryBlocks` has elapsed and before the deadline;
- optionally confirms deliveries where it is the buyer (`AUTO_CONFIRM`, off by default);
- after each settled emissions era, claims — only if something is pending.

Every extrinsic is logged as one JSON line with hash, block and explorer URL.

## Build

```bash
cd ../../sdk && npm ci && npm run build      # the agent packs sdk/dist
cd ../examples/reference-agent && npm ci && npm run build
npm test                                     # config + work-selection unit tests, offline
```

`.npmrc` sets `install-links=true` so the SDK is installed as a packed copy rather than a
symlink — one copy of `@polkadot/*`, no duplicate-instance warnings.

## Run

```bash
install -d -m 700 ~/.config/scalar-agent
install -m 600 /path/to/your/seed ~/.config/scalar-agent/seed
install -m 600 deploy/agent.env.example ~/.config/scalar-agent/agent.env   # edit it
install -D -m 644 deploy/scalar-agent.service ~/.config/systemd/user/scalar-agent.service
systemctl --user daemon-reload && systemctl --user enable --now scalar-agent
journalctl --user -u scalar-agent -o cat -f
```

The seed is only ever read from a 0600 file; `SCALAR_SEED` in the environment is refused.

## Files

| | |
|---|---|
| `src/adapter.ts` | `ScalarAgentAdapter` — one SDK call per agent action; start here to wrap your own agent |
| `src/work.ts` | pure rules for which agreements to act on, mirroring the escrow pallet's guards |
| `src/worker.ts` | **the part you replace** — does the job, returns the delivery hash |
| `src/agent.ts` | the daemon loop |
| `src/buyer.ts` | `scalar-buyer register \| hire \| wait \| confirm` — the other side, for testing |
| `src/wrap-example.ts` | the minimal "wrap your own agent" integration from the guide, compiled |
| `deploy/` | env example and systemd user unit |

## Deliberate choices

- **SDK retries off** (`maxRetries: 0`). The SDK's default retries any failure and each
  attempt pays a fee (#160). A failed delivery backs off 10 blocks and gives up after 3.
- **One queue.** Two extrinsics from one account in flight race for the nonce.
- **No zero claims.** `emissions.claim` with nothing pending fails and still pays.
