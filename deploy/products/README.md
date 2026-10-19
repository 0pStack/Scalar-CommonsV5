# Scalar Commons — products under user systemd

The three things that read *from* the devnet: the indexer, the explorer and the
faucet. `deploy/README.md` covers the five validators they read from; this file
covers only the products.

Same operating model as the validators — **user** systemd, no root, no system
units, `loginctl enable-linger dev` is what makes them come back after a reboot.

| product  | bind               | unit                     | env file                              |
|----------|--------------------|--------------------------|---------------------------------------|
| indexer  | `127.0.0.1:8080`   | `scalar-indexer.service` | `~/.config/scalar-commons/indexer.env`  |
| explorer | `127.0.0.1:8081`   | `scalar-explorer.service`| `~/.config/scalar-commons/explorer.env` |
| faucet   | `127.0.0.1:8082`   | `scalar-faucet.service`  | `~/.config/scalar-commons/faucet.env`   |

All three talk to `ws://127.0.0.1:9944` — alice, who runs `archive` pruning and
so is the only node with the full history.

**Loopback only, on purpose.** None of the three authenticates a caller. The
ports are the entire access-control story, exactly as with the node's RPC (see
`deploy/README.md`, "Public RPC — deliberately not enabled yet"). Exposing any
of them means putting a reverse proxy in front of it first, not flipping the
`*_HOST` variable.

---

## Install

```bash
# the products are Node services; install their deps first
(cd indexer  && npm ci)
(cd faucet   && npm ci)
(cd explorer && npm ci && npm run build)   # explorer's unit runs compiled output

./deploy/products/install.sh
systemctl --user start scalar-indexer.service scalar-explorer.service scalar-faucet.service
```

`install.sh` is idempotent. It creates `~/scalar-products/indexer/` for the
index, seeds each env file from the matching `*.env.example` at mode 0600, and
enables the units. **It never overwrites an env file that already exists** —
`faucet.env` is where a signing key lives.

It does not start anything, and it does not build anything: a missing
`explorer/dist/index.js` is a hard error at install time rather than a restart
loop in the journal later.

## Configuration

Each unit bakes its defaults as `Environment=` lines and then reads
`EnvironmentFile=-%h/.config/scalar-commons/<product>.env`. systemd applies
those in file order, so **the env file always wins**; the baked values exist so
the ports are still right on a machine where the env file was never created.
That matters because all three products default to port 8080 in code.

The `-` prefix means a missing env file is not a startup failure.

Changing a value:

```bash
$EDITOR ~/.config/scalar-commons/faucet.env
systemctl --user restart scalar-faucet.service
```

No `daemon-reload` needed for an env-file edit — only for a unit-file edit.

---

## indexer — `127.0.0.1:8080`

Subscribes to finalized blocks on alice and serves the versioned 25-endpoint
`/v1` REST surface over what it has stored.

- Runs `indexer/src/index.ts` directly under `--experimental-strip-types`; there
  is no build step, so there is no `dist/` to drift out of date with `src/`.
- State lives in `~/scalar-products/indexer/indexer.sqlite`, deliberately outside
  the checkout so rebuilding the repo does not cost the index.
- It is a follower, not an archive: `INDEXER_BACKFILL_DEPTH` (default 256) bounds
  how far back a restart catches up.
- `After=scalar-alice.service` but only `Wants=network-online.target` — alice
  going down must not take the API down. Already-indexed history stays queryable
  and the indexer reconnects.

```bash
curl -s http://127.0.0.1:8080/v1/status
journalctl --user -u scalar-indexer -f
```

Tunables: `INDEXER_HOST`, `INDEXER_PORT`, `INDEXER_RPC_URL`, `INDEXER_DB`,
`INDEXER_BACKFILL_DEPTH`. See `indexer.env.example`.

## explorer — `127.0.0.1:8081`

Server-rendered block, extrinsic and account views read straight off the node.

- The only product whose unit runs compiled output: the entrypoint is
  `explorer/dist/index.js`, so `npm run build` must have run first.
  `install.sh` refuses to install otherwise.
- Holds no state, so it is safe to restart at any time.
- It connects to the node *before* it listens. A node that is down is therefore a
  failed start that systemd retries, not a socket serving errors.
- Every type shape comes from the node's runtime metadata. Pointing
  `EXPLORER_RPC_ENDPOINT` at a node on a different `spec_version` changes what
  renders — it is not just a transport setting.

```bash
curl -sI http://127.0.0.1:8081/
journalctl --user -u scalar-explorer -f
```

Tunables: `EXPLORER_HOST`, `EXPLORER_PORT`, `EXPLORER_RPC_ENDPOINT`. See
`explorer.env.example`.

## faucet — `127.0.0.1:8082`

Dispenses devnet CMN from a pre-funded account.

- **Never a mint path.** It signs ordinary transfers from an account that already
  holds the funds; nothing here touches the emissions pallet or the supply cap.
- Default signer is `//Ferdie` — endowed at genesis, not a validator, so draining
  it moves no staked funds. It is a well-known dev seed: anything beyond a devnet
  sets `FAUCET_SEED` in the 0600 env file, never in the unit, which is
  world-readable in `~/.config/systemd/user`.
- `FAUCET_RESERVE_CMN` (default 1000) is a floor, not a warning: a drip that
  would leave the funding account below reserve + existential deposit is refused
  with `503 INSUFFICIENT_FAUCET_FUNDS`, re-checked against the node's live
  balance on every request. That is what stops the faucet draining its own
  account and dying mid-drip.
- Rate limits are in-memory counters, per address and per IP, and reset on
  restart. Devnet-grade, not public-internet-grade.
- `FAUCET_TRUST_PROXY` stays `false`. On a loopback bind every request already
  appears to come from `127.0.0.1`, so honouring `X-Forwarded-For` would let one
  caller forge unlimited distinct IPs and walk straight through the per-IP limit.
  Turn it on only behind a proxy that *overwrites* the header.

```bash
curl -s http://127.0.0.1:8082/health
journalctl --user -u scalar-faucet -f
```

Tunables: `FAUCET_HOST`, `FAUCET_PORT`, `FAUCET_RPC_ENDPOINT`, `FAUCET_SEED`,
`FAUCET_SS58_FORMAT`, `FAUCET_DRIP_CMN`, `FAUCET_RESERVE_CMN`,
`FAUCET_ADDRESS_MAX_REQUESTS`, `FAUCET_ADDRESS_WINDOW_MINUTES`,
`FAUCET_IP_MAX_REQUESTS`, `FAUCET_IP_WINDOW_MINUTES`, `FAUCET_TRUST_PROXY`.
See `faucet.env.example`.

---

## Status, logs, stop

```bash
systemctl --user status scalar-indexer scalar-explorer scalar-faucet
systemctl --user is-enabled scalar-indexer scalar-explorer scalar-faucet   # survives reboot?
journalctl --user -u scalar-indexer -u scalar-explorer -u scalar-faucet -f
systemctl --user restart scalar-indexer.service
systemctl --user stop scalar-indexer scalar-explorer scalar-faucet
```

## Checking the units before installing

```bash
shellcheck deploy/products/*.sh && systemd-analyze verify deploy/products/*.service
```

## A note on paths

Like `deploy/systemd/*.service`, these units hardcode the deployment checkout in
`WorkingDirectory=`. `install.sh` warns if you run it from a different checkout
(a git worktree, say), because the installed units would run the other tree's
code, not the one you installed from.

## The emissions keeper

`settle_era` is **permissionless by design** — CLAUDE.md first principle #3 says no economically
essential function may depend on a privileged caller. The cost of that design is that if nobody calls
it, it never happens, and nobody did: for ~512 000 blocks (about 142 elapsed six-hour eras)
`LastSettledEra` was null, `agents::EraNumber` was 0, and **no CMN had ever been emitted by the
mechanism this project is about**. TESTNETAUDIT.md §6 I-8, issue #125.

```bash
systemctl --user enable --now scalar-keeper.timer
journalctl --user -u scalar-keeper.service -f
```

| | |
|---|---|
| unit | `scalar-keeper.service` (Type=oneshot) + `scalar-keeper.timer` |
| cadence | every 15 min, `Persistent=true` |
| key | `~/.config/scalar-commons/keeper.key`, mode 0600, **not** in the repository |
| script | `scripts/keeper-settle-era.mjs` |

**The keeper holds no privilege.** It is an ordinary signed account calling an extrinsic any agent
could call. If it stops, settlement is not blocked — anyone can still call `settle_era`. That
property is the point of the design; do not "fix" a keeper outage by giving it a privileged origin.

**Why it polls 24x per era.** The script re-reads the runtime's own guards (`EraNotDue`,
`EraAlreadySettled`) every run and exits 0 without submitting when settlement is not due, so an extra
tick costs one RPC round trip and no fee, while a missed tick self-corrects within 15 minutes instead
of delaying settlement by a whole era. The runtime's F-04 double-settlement guard remains the real
backstop.

There is no in-code default seed and the script refuses to start without a key file — a keeper that
silently fell back to a published dev seed would be the `//Ferdie` faucet defect over again.

## The site redeploy timer

`deploy/public/redeploy-site.sh` is the reproducible path from a repository state to the live
scalarnet.io, and until #158 nothing ran it: a merged docs change sat on `origin/master` while the
public site served the previous build. `scalar-redeploy.timer` runs it for you.

```bash
install -m 644 deploy/products/scalar-redeploy.service ~/.config/systemd/user/
install -m 644 deploy/products/scalar-redeploy.timer   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now scalar-redeploy.timer
journalctl --user -u scalar-redeploy.service -f
```

| | |
|---|---|
| unit | `scalar-redeploy.service` (Type=oneshot) + `scalar-redeploy.timer` |
| cadence | every 10 min (`OnUnitActiveSec=10min`, `Persistent=true`) |
| script | `deploy/products/redeploy-on-merge.sh` → `deploy/public/redeploy-site.sh` |
| source | a dedicated clone at `~/scalar-products/site-src`, never the working checkout |
| state | `~/scalar-products/redeploy/last-deployed-sha` |
| test | `deploy/products/test-redeploy-on-merge.sh` (offline, no npm, no network) |

Each tick fetches `origin/master`. If it has not moved since the last deploy, that is the whole
tick. If it moved but none of the new commits touch `landing/` or `docs/`, the SHA is recorded and
nothing is built. Otherwise both sites are built into `/var/www/scalarnet/.staging.*` and, **only if
the build exits 0**, swapped into place with `mv --exchange` (an atomic `renameat2` exchange). A
failed build deletes staging, leaves the live site exactly as it was, and does not advance the SHA,
so the next tick retries. Every deploy logs `redeploy: deployed <sha>`.

It holds no privilege and no credential: it reads a public repository and writes two directories
the `dev` user already owns.
