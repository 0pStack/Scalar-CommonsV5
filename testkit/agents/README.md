# testkit

Re-runnable lifecycle tests, run against any node.

```bash
cd testkit && npm install
SCALAR_WS=ws://127.0.0.1:9955 npm test     # default is ws://127.0.0.1:9955
```

- The suite skips (with a console warning) if no node answers at `SCALAR_WS`.
- Tests use throwaway accounts funded from `//Alice`, so they need a dev chain, never a public one.
- Assertions read events and storage back, not just the submission result.
- Time-gated paths (unstake completion after `UnstakeCooldown`) are covered by the pallet unit tests, not here.
- The E22 test skips itself on runtimes without `agents.NoSuchSlash` (pre-307).
