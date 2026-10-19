# Run a validator on Scalar

This page takes you from an empty Linux machine to a validator in the Scalar Commons testnet's
active set, authoring blocks. Every step was performed from outside — a fresh base path, the
public chain spec, the public RPC for every signed transaction, a stash funded by the public
faucet — and every output block is real, captured on **spec 306** from block **#750 660**
onwards.

::: tip Proven, not promised
The outside validator built for this page was **elected in staking era 71** and authored
finalized blocks **#766 726, #766 737, #766 742 and #766 743** — see [§7](./run-a-validator#_7-wait-for-the-election-and-prove-it).
:::

::: danger Read this first — validators on this network are unpaid

- **Validation pays nothing.** Era payout is disabled (`EraPayout = ()` → `(0, 0)`) and
  transaction fees are burned. There is no validator reward, no commission income and no
  nominator reward, by design: spec 305 removed staking inflation because it minted outside
  the emissions pallet and past the supply-cap principle. Whether and how external validators
  are ever paid is an open decision:
  [#172](https://github.com/tejaspatil1936/scalar-commons-v4/issues/172) (`tier:T0`).
- **There is still slashing risk.** Equivocation (double-signing) is slashed to Treasury. There
  is no offline slashing on this chain — no `im-online` pallet — but run one node per set of
  session keys, always.
- **Leaving takes about 21 days.** `BondingDuration` is 28 staking eras of ~18 hours.
- **This is a testnet, and it may be reset without notice.** Your bond, your keys' registration
  and your node's database go with it. [What to do on a reset](#if-the-testnet-is-reset).
- **CMN on this network has no value.** Run a validator to test the software and the network,
  not to earn.
:::

## The numbers, read from the live chain

Set on **2026-09-24** by root (decision D11, issue [#159](https://github.com/tejaspatil1936/scalar-commons-v4/issues/159)),
read back over `wss://rpc.scalarnet.io`:

| | Value | Where |
|---|---|---|
| `staking.validatorCount` | **7** — five operator validators, two open seats | storage, set at block #750 511 |
| `staking.minValidatorBond` | **1 000 CMN** | storage, set at block #750 515 |
| `staking.minNominatorBond` | **100 CMN** | storage, set at block #750 515 |
| `staking.minimumValidatorCount` | 1 | storage |
| `staking.minCommission` | 0 % | storage |
| staking era | 6 sessions × 1 800 blocks = **10 800 blocks ≈ 18 h** | `SessionsPerEra`, `babe.epochDuration` |
| block time | 6 s | `babe.expectedBlockTime` |
| `BondingDuration` | **28 eras ≈ 21 days** | const |
| session keys | `babe`, `grandpa`, `authority_discovery` | `SessionKeys` |
| election | on-chain sequential Phragmén, once per staking era | `ElectionProvider` |
| each operator validator's bond | 1 000 000 CMN | `staking.ledger` |

The election fills up to `validatorCount` seats from everyone who has declared intent. With
seven seats and five operator validators, **the first two outside validators with at least
1 000 CMN bonded are elected** — bond size only matters once there are more candidates than
seats, and then the operators' 1 000 000 CMN bonds win.

**What you need in CMN:** the 1 000 CMN bond, plus the existential deposit (0.01 CMN), plus
about 0.000108 CMN per transaction for `bond`, `setKeys`, `validate` and later `chill`,
`unbond` and `withdrawUnbonded` — **1 000.011 CMN in all**. The bond is a staking *hold*: it
moves out of `free` into `reserved` (after bonding, the stash read `free 99.999676`,
`reserved 1 000`, `frozen 0`), and fees can only come from `free`, so do not bond everything
you have. **One faucet drip (1 100 CMN) covers it**
with about 100 CMN to spare.

## 1. The machine

Measured on the operator's own validator `alice` (which is also the archive node behind the
public RPC, so it is the heavy case), and on the outside validator built for this page:

| | Measured | Recommendation |
|---|---|---|
| CPU | alice: **1.7 %** of one core averaged over 15 days (AMD EPYC 9645, 16 cores); outside node sync peaked at ~1 000 blocks/s | 2 cores |
| RAM | alice: **3.2 GiB** resident (peak RSS 3.2 GiB; 7.1 GiB cgroup peak including page cache) | 4 GiB minimum, 8 GiB comfortable |
| Disk | alice, archive: **7.8 GB** at #750 000 (`du -sh` of its base path). Outside validator, default pruning: **2.6 GB** after full sync | 50 GB SSD, grows with the chain |
| Sync | **19 min** from genesis to #750 909 over the public bootnodes | — |
| OS | Linux x86_64, glibc ≥ 2.35 for the release binary (Ubuntu 22.04+, Debian 12+) | — |

### Ports

| Port | Bind | Reachable from | Why |
|---|---|---|---|
| p2p (30333 by default; **30338** on this page) | `0.0.0.0` | **the internet, TCP inbound** | peers and the other validators dial you here |
| RPC (9944 by default; **9949** on this page) | **127.0.0.1 only** | this machine only | session-key rotation and your own monitoring |
| Prometheus (9615 by default; **9620** on this page) | 127.0.0.1 | this machine only | metrics |

The node binds RPC and Prometheus to loopback unless you pass `--rpc-external` or
`--prometheus-external`. **Do not.** Open only the p2p port in your firewall.

## 2. Get the node

### Primary: the release binary

Every `v*` tag builds `scalar-node` on the pinned toolchain in CI and publishes it with a
checksum ([`.github/workflows/release.yml`](https://github.com/tejaspatil1936/scalar-commons-v4/blob/master/.github/workflows/release.yml)).
The current release is
**[v0.306.0](https://github.com/tejaspatil1936/scalar-commons-v4/releases/tag/v0.306.0)**,
for runtime spec 306.

```bash
mkdir -p ~/scalar && cd ~/scalar
curl -sSLO https://github.com/tejaspatil1936/scalar-commons-v4/releases/download/v0.306.0/scalar-node-linux-x86_64
curl -sSLO https://github.com/tejaspatil1936/scalar-commons-v4/releases/download/v0.306.0/scalar-node-linux-x86_64.sha256
sha256sum -c scalar-node-linux-x86_64.sha256
chmod +x scalar-node-linux-x86_64 && mv scalar-node-linux-x86_64 scalar-node
./scalar-node --version
```

```text
7f6efa029e3f94f8f100f2d9f9797d865789e532dc753bf853f317877bfa455d  scalar-node-linux-x86_64
scalar-node-linux-x86_64: OK
scalar-node-linux-x86_64 4.0.0-206936fdd49
```

**Do not run it if `sha256sum -c` does not print `OK`.** The binary is 53.7 MB, built on
Ubuntu 22.04; the newest glibc symbol it needs is `GLIBC_2.34`. The validator on this page
synced from genesis on a source build (next section), then was switched to this exact binary
with a restart — same base path, same keys — and carried on from #751 343.

### Fallback: build from source

The toolchain pin is load-bearing: the workspace is on Polkadot SDK tag
**`polkadot-stable2503`**, whose `sp-io` cannot be compiled by a current rustc, so the repository
pins **rust 1.85.0** with the **`wasm32v1-none`** target in `rust-toolchain.toml`. `rustup` picks
the pin up automatically inside the checkout.

```bash
sudo apt-get install -y build-essential clang protobuf-compiler git curl   # Debian/Ubuntu
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none
. "$HOME/.cargo/env"

git clone https://github.com/tejaspatil1936/scalar-commons-v4
cd scalar-commons-v4
rustc --version          # rustup installs 1.85.0 + wasm32v1-none from rust-toolchain.toml
cargo build --release    # builds the WASM runtime and target/release/scalar-node
./target/release/scalar-node --version
```

Verified in a clean directory with a fresh `CARGO_HOME` (so every crate, including the whole
Polkadot SDK, was fetched and compiled from scratch):

```text
real    16m33.213s      (-j 8 on an AMD EPYC 9645)
EXIT 0
scalar-node 4.0.0-37d0e4d2da7
target/ 5.0G   cargo-home/ 2.1G
```

Budget **~8 GB of disk and 15–60 minutes** depending on cores.

## 3. Chain spec and node key

```bash
mkdir -p ~/scalar && cd ~/scalar
curl -s -o chainspec.json -w 'http=%{http_code} ct=%{content_type} bytes=%{size_download}\n' \
  https://scalarnet.io/docs/chainspec.json
```

```text
http=200 ct=application/json bytes=2356581
```

Check the content type, not the status: the docs site answers 200 with an HTML page for any
path, so `text/html` means you did not get the spec. The spec carries the five public
bootnodes, so no `--bootnodes` flag is needed:

```text
/ip4/152.53.113.104/tcp/30333/p2p/12D3KooWEyoppNCUx8Yx66oV9fJnriXwCcXwDDUA2kj6vnc6iDEp
/ip4/152.53.113.104/tcp/30334/p2p/12D3KooWHdiAxVd8uMQR1hGWXccidmfCwLqcMpGwR6QcTP6QRMuD
/ip4/152.53.113.104/tcp/30335/p2p/12D3KooWSCufgHzV4fCwRijfH2k3abrpAJxTKxEvN1FDuRXA2U9x
/ip4/152.53.113.104/tcp/30336/p2p/12D3KooWSsChzF81YDUKpe9Uk5AHV5oqAaXAcWNSPYgoLauUk4st
/ip4/152.53.113.104/tcp/30337/p2p/12D3KooWSuTq6MG9gPt7qZqLFKkYrfxMewTZhj9nmRHJkPwzWDG2
```

**Generate the node's network key before the first start.** A node started with `--validator`
refuses to create one itself — this is what the first start printed here, in a loop:

```text
Error: NetworkKeyNotFound("/home/dev/outsider-validator.SQkD/base/chains/scalar-local/network/secret_ed25519")
```

```bash
./scalar-node key generate-node-key --chain ./chainspec.json --base-path ~/scalar/base
chmod 700 ~/scalar/base
chmod 600 ~/scalar/base/chains/scalar-local/network/secret_ed25519
```

```text
Generating key in "/home/dev/outsider-validator.SQkD/base/chains/scalar-local/network/secret_ed25519"
12D3KooWRq7TcUUgp9ZzgpLxYNks1o5KA4k3sg6z9t9Y2Y97nJE6
```

The key is created **mode 664** — readable by every user on the machine — hence the `chmod`.
The last line is your node's peer id.

## 4. Run it under systemd

`deploy/validator/` in the repository holds a systemd **user** unit and an env file. No root is
needed; `loginctl enable-linger` keeps it running after you log out.

```bash
install -D -m 644 deploy/validator/scalar-validator.service ~/.config/systemd/user/scalar-validator.service
install -D -m 600 deploy/validator/validator.env.example    ~/.config/scalar-validator/validator.env
$EDITOR ~/.config/scalar-validator/validator.env
systemctl --user daemon-reload
systemctl --user enable --now scalar-validator
loginctl enable-linger "$USER"
journalctl --user -u scalar-validator -f
```

The env file used for this page (paths are this run's temp directory; `NODE_NAME` is the
operator's choice):

```ini
NODE_BIN=/home/dev/outsider-validator.SQkD/scalar-node
CHAIN_SPEC=/home/dev/outsider-validator.SQkD/chainspec.json
BASE_PATH=/home/dev/outsider-validator.SQkD/base
NODE_NAME=outsider-guide-test
P2P_PORT=30338
RPC_PORT=9949
RPC_METHODS=safe
PROMETHEUS_PORT=9620
EXTRA_ARGS=--no-telemetry
```

which the unit turns into:

```text
scalar-node --chain chainspec.json --base-path base --name outsider-guide-test --validator \
  --port 30338 --rpc-port 9949 --rpc-methods safe --prometheus-port 9620 --no-mdns --no-telemetry
```

```text
🏷  Node name: outsider-guide-test
👤 Role: AUTHORITY
🔨 Initializing Genesis block/state (state: 0xe20e…abd1, header-hash: 0xff68…03d1)
Using default protocol ID "sup" because none is configured in the chain specs
🏷  Local node identity is: 12D3KooWRq7TcUUgp9ZzgpLxYNks1o5KA4k3sg6z9t9Y2Y97nJE6
Running JSON-RPC server: addr=127.0.0.1:9949,[::1]:9949
〽️ Prometheus exporter started at 127.0.0.1:9620
👶 Starting BABE Authorship worker
⚙️  Syncing, target=#750722 (5 peers), best: #5120 (0x3e52…6333), finalized #4608 (0xd372…74c6)
…
💤 Idle (5 peers), best: #750909 (0x785f…c21b), finalized #750907 (0xe9ae…7577)
```

Five peers within five seconds, and fully synced **19 minutes** later. What is listening:

```text
0.0.0.0:30338   [::]:30338     scalar-node     <- p2p, the only public port
127.0.0.1:9949  [::1]:9949     scalar-node     <- RPC, loopback only
127.0.0.1:9620                 scalar-node     <- Prometheus, loopback only
```

`genesis` must match the public chain — `0xff6882b4…f803d1` above is the same hash
`chain_getBlockHash(0)` returns on `wss://rpc.scalarnet.io`.

## 5. Session keys — on your own node, never the public RPC

Session keys are generated *inside a node's keystore*. The public endpoint refuses, by design —
`author_rotateKeys` there would put keys in the operator's keystore, useless to you:

```bash
curl -s -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"author_rotateKeys","params":[]}' https://rpc.scalarnet.io
```

```json
{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"RPC call is unsafe to be called externally"}}
```

**Your own node refuses too, while `RPC_METHODS=safe`** — `safe` withholds unsafe methods even on
loopback. So flip it for the one call, then flip it back:

```bash
sed -i 's/^RPC_METHODS=safe$/RPC_METHODS=unsafe/' ~/.config/scalar-validator/validator.env
systemctl --user restart scalar-validator
curl -s -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"author_rotateKeys","params":[]}' http://127.0.0.1:9949
sed -i 's/^RPC_METHODS=unsafe$/RPC_METHODS=safe/' ~/.config/scalar-validator/validator.env
systemctl --user restart scalar-validator
```

```json
{"jsonrpc":"2.0","id":1,"result":"0x6a4fcc900adfe988b6ec188fdd9c31dd75c93fa011a7f918c5cb791395212a52645ae4c5545609f461c0b5b0e7f2e159e9237d4df6543f987c940be275b9fdbe9482e4cc5da3e3730fdc5d32edab932207205014da1106c3f2c3b73e5a54c82e"}
```

96 bytes: the `babe`, `grandpa` and `authority_discovery` public keys, in that order. The
private halves are now three `0600` files in `base/chains/scalar-local/keystore/`. After the
flip back, the same call on loopback returns `-32601` again — confirm it does.

## 6. Stash, bond, keys, intent

The **stash** is the account that bonds CMN and owns the validator on chain. Generate it
somewhere other than the validator machine if you can — the node only ever needs the session
keys — and fund it from the faucet:

```js
// stash.mjs  (npm install @polkadot/api@15.10.2)
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady, mnemonicGenerate } from '@polkadot/util-crypto';
import { writeFileSync } from 'node:fs';
await cryptoWaitReady();
const mnemonic = mnemonicGenerate(24);
writeFileSync('stash.seed', mnemonic + '\n', { mode: 0o600 });
console.log(new Keyring({ type: 'sr25519', ss58Format: 42 }).addFromUri(mnemonic).address);
```

```bash
curl -s -X POST https://faucet.scalarnet.io/drip -H 'content-type: application/json' \
  -d '{"address":"5FADXQgabx5SaZg43YwZs3Q3XMfMUENvW49gW1Vjx1xZjmpe"}'
```

```json
{"ok":true,"address":"5FADXQgabx5SaZg43YwZs3Q3XMfMUENvW49gW1Vjx1xZjmpe","amountPlancks":"1100000000000000",
 "blockHash":"0x852cfde6efa4988715a1ff719faab93f225c2a5df725c97b8d9b19cc03f184a8",
 "txHash":"0x0d52c9015c212544ed9a6b5045deefde0f17da373ee44ed4e4666c7b9c8ea19e"}
```

Then three transactions, all signed by the stash and sent over the **public** RPC — nothing
here touches your node:

```js
// stake.mjs (excerpt) — the full script is in the repository's run record
const api = await ApiPromise.create({ provider: new WsProvider('wss://rpc.scalarnet.io') });
await api.tx.staking.bond(1000n * 10n ** 12n, { Stash: null }).signAndSend(stash);   // 1 000 CMN
await api.tx.session.setKeys(ROTATE_KEYS_RESULT, '0x').signAndSend(stash);         // from step 5
await api.tx.staking.validate({ commission: 50_000_000, blocked: false }).signAndSend(stash); // 5 %
```

`commission` is a `Perbill`: `10_000_000` = 1 %. On this network it is a statement of intent
only — there is nothing to take a commission from. Payee `Stash` is the honest choice for the
same reason.

```json
{"label":"staking.bond","txHash":"0x33cc0ad0446698689ad8f572d47c56c816809555027e33a99a967d934c5d05a3","block":750780,
 "explorer":"https://explorer.scalarnet.io/extrinsic/750780/1","events":["balances.Withdraw","staking.Bonded","transactionPayment.TransactionFeePaid","system.ExtrinsicSuccess"]}
{"label":"session.setKeys","txHash":"0xb0b7dd60002c73178e1861bb761875e7dec8c8043ec51f4a5adf9a129e5dbc3e","block":750917,
 "explorer":"https://explorer.scalarnet.io/extrinsic/750917/1","events":["balances.Withdraw","transactionPayment.TransactionFeePaid","system.ExtrinsicSuccess"]}
```

```json
{"label":"staking.validate","txHash":"0xc17829ec95b664342839e359ea9d6974428cc98f1423c3051ef17b0a9afd1988","block":754123,
 "explorer":"https://explorer.scalarnet.io/extrinsic/754123/1","events":["balances.Withdraw","staking.ValidatorPrefsSet","transactionPayment.TransactionFeePaid","system.ExtrinsicSuccess"]}
```

Read back over the public RPC straight after:

```json
{"stash":"5FADXQgabx5SaZg43YwZs3Q3XMfMUENvW49gW1Vjx1xZjmpe","block":754123,
 "ledger":{"total":1000000000000000,"active":1000000000000000,"unlocking":[]},
 "validatorPrefs":{"commission":"5.00%","blocked":false},
 "nextKeys":{"babe":"0x6a4fcc90…212a52","grandpa":"0x645ae4c5…75b9fdbe","authorityDiscovery":"0x9482e4cc…5a54c82e"},
 "inActiveSet":false,"currentEra":70,"activeEra":69}
```

`nextKeys` is exactly the 96 bytes `author_rotateKeys` returned, split three ways. `inActiveSet`
is `false`, as it should be: declaring intent does not put you in the set; an election does.

::: tip Why `validate` waited ~3 hours after `setKeys` here
`validatorCount` was raised at block #750 511. To prove that change did not disturb the
existing set, this run waited for the next election (era 70, at block #754 120) to return
exactly the five operator validators, and only then declared intent. An outside operator has
no reason to wait: bond, set keys and validate back to back.
:::

## 7. Wait for the election, and prove it

Intent is not membership. The set is chosen by an on-chain Phragmén election **at the start
of the last session of each staking era**, and the winners take their seats **one session
later**, when the next era begins. So after `validate` you wait for one election and one
session: between ~3 and ~21 hours, depending on where in the ~18-hour era you declare.

Watched over the public RPC, from `validate` at #754 123:

```json
{"at":"2026-09-25T20:20:23Z","result":"ELECTED","era":71,"block":764926,"electedCount":6,
 "overview":{"total":999999999999712,"own":999999999999712,"nominatorCount":0,"pageCount":0}}
{"at":"2026-09-25T23:19:29Z","result":"ACTIVE","block":766717,"activeEra":71,"session":426,"setSize":6,
 "set":["5Ck5SLSH…zEAPT","5FADXQga…xZjmpe","5FCfAonR…LFE7n","5GNJqTPy…xiZY","5HKPmK9G…u4ns8","5HpG9w8E…qUsSWFc"]}
{"at":"2026-09-25T23:20:18Z","result":"AUTHORED","block":766726,"hash":"0xcfee085a52a6e54218d407508ebd2bda2b2c764b3d7d9082975fd4a101b8a6da"}
{"at":"2026-09-25T23:21:24Z","result":"AUTHORED","block":766737}
{"at":"2026-09-25T23:21:54Z","result":"AUTHORED","block":766742,"hash":"0xad4ff36c347de6e169572645db8b20b49737b368818b83117f9458e5d57e86cd"}
{"at":"2026-09-25T23:22:00Z","result":"AUTHORED","block":766743,"hash":"0x46b58d4e9f33779a1a6e0c94171ab2d8755a00692f790e037fe0e51092e623ef"}
```

- **Elected** for era 71 in the election at block #764 926 — six winners for seven seats: the
  five operator validators and this one. (The exposure reads 999.999999999712 CMN, not 1 000:
  stake is converted to a `u64` vote weight for the election, and the conversion rounds.)
- **Active** from #766 717, the first block of session 426, era 71.
- **First authored block #766 726**, nine blocks in. Authorship read independently from each
  block's BABE pre-digest at the finalized hash — `authorityIndex 1` in the session's validator
  list is `5FADXQga…xZjmpe`:

```text
766726 0xcfee085a…a6da author 5FADXQgabx5SaZg43YwZs3Q3XMfMUENvW49gW1Vjx1xZjmpe babe SecondaryPlain finalized
766737 0x4beac836…cecc4 author 5FADXQgabx5SaZg43YwZs3Q3XMfMUENvW49gW1Vjx1xZjmpe babe Primary        finalized
766742 0xad4ff36c…86cd author 5FADXQgabx5SaZg43YwZs3Q3XMfMUENvW49gW1Vjx1xZjmpe babe SecondaryPlain finalized
766743 0x46b58d4e…23ef author 5FADXQgabx5SaZg43YwZs3Q3XMfMUENvW49gW1Vjx1xZjmpe babe SecondaryPlain finalized
```

The node's own log shows the other side of it:

```text
🎁 Prepared block for proposing at 766726 (1 ms) hash: 0x4030c5c5…022a; extrinsics_count: 1
🔖 Pre-sealed block for proposal at 766726. Hash now 0xcfee085a52a6e54218d407508ebd2bda2b2c764b3d7d9082975fd4a101b8a6da
```

It also proposed a block at #766 724 that lost the fork race — the canonical #766 724 is
`0x50fd02f6…8112`, not its `0x76081a9c…9a6e`. That is ordinary BABE behaviour when a secondary
slot and a primary slot collide, not a fault.

The explorer serves each of these blocks, e.g. <https://explorer.scalarnet.io/block/766726>,
but its block page does not show the author; use the pre-digest check above, or
`api.derive.chain.getHeader(hash).author`.

## Operating it

### Monitoring

```bash
journalctl --user -u scalar-validator -f                       # 💤 Idle (N peers), best/finalized
curl -s -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"system_health","params":[]}' http://127.0.0.1:9949
curl -s http://127.0.0.1:9620/metrics | grep -E '^substrate_block_height|^substrate_sub_libp2p_peers_count'
```

and from anywhere, over the public RPC: is your stash in `session.validators`? Is
`best` − `finalized` staying within a few blocks? In the explorer, blocks you author show your
stash as the author. A validator that is elected but not authoring is either not synced, has
lost its keystore, or has keys that do not match `session.nextKeys(stash)`.

### Upgrades

**Runtime upgrades are forkless and need nothing from you.** The runtime is WASM stored on
chain; a `set_code` upgrade switches every node at the same block, without a restart. Spec 306
was applied that way at block #543 472 with all five validators running and none restarted
(`UPGRADE-306.md`). **Node (client) upgrades** — a new `scalar-node` binary — are only needed
when a release says so; they are published as GitHub Releases with a checksum. Swap the binary,
`sha256sum -c`, restart.

### Leaving

```js
await api.tx.staking.chill().signAndSend(stash);            // stop validating; out of the set at the next era
await api.tx.staking.unbond(1000n * 10n ** 12n).signAndSend(stash);
// … BondingDuration = 28 eras ≈ 21 days …
await api.tx.staking.withdrawUnbonded(0).signAndSend(stash);
```

Keep the node running until `chill` has taken effect — `session.validators` no longer lists
your stash — or you are an elected validator that is not producing blocks. Then stop the service
and delete the base path.

<!-- chill-section -->

### If the testnet is reset

A reset is a new genesis. Your stash's balance, bond and session-key registration are gone with
the old chain; your node's database belongs to a chain that no longer exists.

1. `systemctl --user stop scalar-validator`
2. Download the new `chainspec.json` and check its genesis against
   `chain_getBlockHash(0)` on `wss://rpc.scalarnet.io`.
3. Delete `base/chains/scalar-local/db` **and** `keystore` (new chain, new keys — do not carry
   session keys across), keep or regenerate the network key.
4. Start, sync, and redo steps 5–7: rotate keys, drip, bond, set keys, validate.

## Security

- **Never expose RPC.** Not your own port, and never 9944–9948 on a host that also runs the
  operator's nodes. Unsafe methods (`author_rotateKeys`, `author_insertKey`) on a reachable
  RPC hand your keystore to anyone who can connect. Keep `RPC_METHODS=safe` except for the
  one-off rotation, and never pass `--rpc-external` or `--unsafe-rpc-external`.
- **File permissions.** `chmod 700` the base path; the network key is created 664 — make it
  600; the keystore files are created 600; the env file 600.
- **One node per session key set.** Two nodes with the same keys double-sign, and equivocation
  is the one thing this chain slashes.
- **The stash seed never lives on the validator** if you can avoid it, and is **never reused** —
  not as an agent key, not for another validator, not on another network. The node needs only
  the session keys; the stash signs four transactions in the validator's lifetime.
- **p2p is the only public port.** Everything else stays on loopback.

## What this walkthrough found

Everything above worked end to end from outside: release download and checksum, sync over the
public bootnodes, keys, bond, intent, election, authoring, finality, chill. These are the places
where it worked only because the walkthrough already knew something, or where it could not be
fully verified.

| # | Finding | Where |
|---|---|---|
| 1 | **Validators are unpaid.** `EraPayout = ()`, fees burned, slashing to Treasury, 28-era exit. Negative expected value for an outside operator. | [#172](https://github.com/tejaspatil1936/scalar-commons-v4/issues/172) (`tier:T0`) |
| 2 | A first start with `--validator` crash-loops on `NetworkKeyNotFound` until `key generate-node-key` is run, and that command writes the key **mode 664**. | §3 |
| 3 | `--rpc-methods safe` refuses `author_rotateKeys` **on loopback too**, so key rotation needs a temporary switch to `unsafe` and two restarts. | §5 |
| 4 | The bond is a staking *hold* (`reserved`), not a lock (`frozen`); tools and docs that look for a lock will report the stake as missing. | §6 |
| 5 | The explorer's block page does not show the block author, so "did my validator author this?" needs the RPC. | §7 |
| 6 | **Inbound p2p reachability of the test validator was not verified.** It ran on the operator's host, whose firewall rules are root-only, so whether TCP 30338 was reachable from outside is unknown. It dialled out to all five bootnodes, was elected, authored and finalized regardless. Open your p2p port anyway: with only outbound connections you depend on peers you dial. | §1 |
| 7 | The chain spec sets no `protocolId` (the node falls back to `"sup"`) and still names the chain `Scalar Commons Local Testnet`, `chainType: Local`. | §4 |
| 8 | Blocks run slightly slower than the nominal 6 s, so era boundaries arrive a few minutes to an hour later than `blocks × 6 s` predicts. Watch `session.currentIndex`, not the clock. | §7 |
