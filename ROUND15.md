# ROUND15 — Devnet hardened to 5 validators; finality survives one down

**Branch:** `feat/devnet-4validators` · **Gate:** N≥4 validators, finalized
height advances with one validator stopped, stopped node rejoins and catches up.

**Result: met.** The devnet now runs 5 validators on spec_version 304. With one
validator stopped for 93 seconds, **finalized height advanced 11 → 24** — the
property ROUND10 explicitly could not demonstrate. The stopped node rejoined and
was authoring blocks 2 seconds later.

A negative control was also run, because "finality survived" is only meaningful
if the test could have failed: stopping **two** validators does stall finality,
exactly as the threshold arithmetic predicts.

---

## 1. What changed, and what deliberately did not

The absolute rule for this round was config + ops only — no pallet or runtime
logic. That held. The only source file touched is `node/src/chain_spec.rs`, and
only its `local` preset's authority *list*:

```
 deploy/README.md                    | 241 +++++++++++++++++++++++++++---------
 deploy/install.sh                   |  34 +++--
 deploy/reset-chain.sh               |  21 +++-
 deploy/scalar-local-raw.json        |  72 +++++++----   (regenerated artifact)
 deploy/snapshot.sh                  |  29 +++--
 deploy/systemd/scalar-devnet.target |  14 ++-
 node/src/chain_spec.rs              |  33 ++++-
 + deploy/nodes.env                  (new)  topology single source of truth
 + deploy/finality-check.sh          (new)  best/finalized sampler
 + deploy/systemd/scalar-dave.service (new)
 + deploy/systemd/scalar-eve.service  (new)
```

`runtime/**`, `pallets/**`, and every `node/src/` file other than `chain_spec.rs`
are untouched. **No code change was needed for persistence**, so the STOP-and-
report condition never triggered.

### chain_spec diff summary

The functional change is two lines. `dev_genesis()` already derived *everything*
downstream from the `initial_authorities` vector — session keys, stakers,
`validatorCount`, `invulnerables`, and validator balances — so extending the
vector was sufficient and no genesis field needed editing by hand:

```rust
 vec![
     authority_keys_from_seed("Alice"),
     authority_keys_from_seed("Bob"),
     authority_keys_from_seed("Charlie"),
+    authority_keys_from_seed("Dave"),
+    authority_keys_from_seed("Eve"),
 ],
```

The remaining 31 lines of that diff are the doc comment explaining the threshold
arithmetic and why five was chosen.

Verified against the regenerated spec — the derived fields all moved together,
and the economic ones did not move at all:

| genesis field        | before | after | note                                        |
|----------------------|--------|-------|---------------------------------------------|
| `session.keys`       | 3      | **5** | derived                                     |
| `staking.validatorCount` | 3  | **5** | derived                                     |
| `staking.stakers`    | 3      | **5** | derived                                     |
| `staking.invulnerables` | 3   | **5** | derived                                     |
| `balances.balances`  | 9      | **11**| +2 stashes, controllers dedup with endowed  |
| `agents.agents`      | 3      | **3** | **unchanged** — keyed off endowed accounts  |
| `GENESIS_AGENT_STAKE`, `VALIDATOR_STASH_BOND`, emissions/BPS constants | — | — | **untouched** |

`agents.agents` staying at 3 is the point worth checking: genesis agents are
taken from the first three *endowed* accounts, not from the authority set, so
promoting Dave and Eve to validators pre-registers no additional staked agent
and shifts no emissions weight. No economic constant changed, so no
gaming-vector analysis was triggered.

Other presets (`dev`, `staging`, `sc-e1`, mainnet) are untouched.

### Why 5, stated honestly

GRANDPA's threshold for `n` authorities is `n - (n-1)/3` voters:

| `n` | threshold | tolerated down |                                          |
|-----|-----------|----------------|------------------------------------------|
| 3   | 3         | **0**          | ROUND10's set — any stop froze finality  |
| 4   | 3         | 1              |                                          |
| 5   | 4         | 1              | **chosen**                               |
| 7   | 5         | 2              | next real step up                        |

The brief asked for Dave "and Eve for margin". Delivered — but the margin claim
needs correcting, and the docs now say so: **the fifth authority buys nothing
for fault tolerance.** Four and five both survive exactly one failure, because
the threshold rises in step with the set size. Seven is the next size that
survives two. Five is justified by slot spread and an odd set size, not by extra
resilience, and both `chain_spec.rs` and `deploy/README.md` state this plainly
rather than implying five is safer than four.

---

## 2. Topology

Rebuilt from master HEAD (`297bd66`) and confirmed:

```
$ ./target/release/scalar-node --version
scalar-node 4.0.0-297bd66155d

$ curl -s ... state_getRuntimeVersion http://127.0.0.1:9944
specName scalar-commons specVersion 304
```

The chain was previously serving spec **303**; it now serves **304**.

| node    | p2p   | RPC   | prometheus | pruning | role                 |
|---------|-------|-------|------------|---------|----------------------|
| alice   | 30333 | 9944  | 9615       | archive | bootnode + query RPC |
| bob     | 30334 | 9945  | 9616       | default | validator            |
| charlie | 30335 | 9946  | 9617       | default | validator            |
| dave    | 30336 | 9947  | 9618       | default | **new**              |
| eve     | 30337 | 9948  | 9619       | default | **new**              |

All five run under user systemd (`scalar-devnet.target`), enabled, with linger
set so they return after a reboot. Alice's node key is unchanged, so her peer id
— and the bootnode multiaddr baked into every other unit — survived the change:

```
==> alice: peer id 12D3KooWEyoppNCUx8Yx66oV9fJnriXwCcXwDDUA2kj6vnc6iDEp
```

Dave and Eve are given **only alice** as a bootnode, exactly like bob and
charlie. Authority discovery over the DHT (ROUND5) did the rest — full mesh, no
config edits to the pre-existing three units:

```
alice (9944): {"peers":4,"isSyncing":false,"shouldHavePeers":false}
bob   (9945): {"peers":4,"isSyncing":false,"shouldHavePeers":true}
charlie(9946):{"peers":4,"isSyncing":false,"shouldHavePeers":true}
dave  (9947): {"peers":4,"isSyncing":false,"shouldHavePeers":true}
eve   (9948): {"peers":4,"isSyncing":false,"shouldHavePeers":true}
```

### Genesis was reset

Going from 3 to 5 authorities is a different genesis and therefore a different
chain. The raw spec was regenerated and all five databases wiped:

```
old deploy/scalar-local-raw.json sha256: f7ec0fb9a6d3273561d7606d1a97f879c3b09b2157541808766c808174066e2a
new deploy/scalar-local-raw.json sha256: 216f763c711f6cfa7b72dd534aae600baab201556d49dbb54c84a5f9b26cf849

==> building raw spec from --chain local
2026-08-03 19:18:57 [0] 💸 generated 5 npos voters, 5 from validators and 0 nominators
2026-08-03 19:18:57 [0] 💸 generated 5 npos targets
```

~2.2 GB of pre-ROUND15 chain data was deleted across the three old nodes. This
was authorised by the brief (testnet, no value). All five nodes then booted from
block 0 on the new spec.

---

## 3. The gate: finality survives one validator down

Charlie was chosen as the victim because ROUND10 §2.5 stopped charlie, making
the comparison direct.

### 3.1 RPC sampling — all five nodes, verbatim

`./deploy/finality-check.sh`. The column that matters is `final`:

```
=== ROUND15 finality fault-tolerance test ===
=== authority set: 5 (alice bob charlie dave eve) — GRANDPA threshold 4 ===
=== victim: charlie ===

--- BASELINE: all 5 up ---
[17:20:25Z]  alice best=   11 final=    8  bob best=   11 final=    8  charlie best=   11 final=    8  dave best=   11 final=    8  eve best=   11 final=    8
[17:20:31Z]  alice best=   12 final=   10  bob best=   12 final=   10  charlie best=   12 final=   10  dave best=   12 final=   10  eve best=   12 final=   10
[17:20:37Z]  alice best=   13 final=   11  bob best=   13 final=   11  charlie best=   13 final=   11  dave best=   13 final=   11  eve best=   13 final=   11

--- STOPPING charlie at 17:20:37Z (4 of 5 authorities remain) ---
--- charlie is-active: inactive ---

[17:20:37Z]  alice best=   13 final=   11  bob best=   13 final=   11  charlie DOWN  dave best=   13 final=   11  eve best=   13 final=   11
[17:20:44Z]  alice best=   14 final=   12  bob best=   14 final=   12  charlie DOWN  dave best=   14 final=   12  eve best=   14 final=   12
[17:20:50Z]  alice best=   15 final=   13  bob best=   15 final=   13  charlie DOWN  dave best=   15 final=   13  eve best=   15 final=   13
[17:20:56Z]  alice best=   16 final=   14  bob best=   16 final=   14  charlie DOWN  dave best=   16 final=   14  eve best=   16 final=   14
[17:21:02Z]  alice best=   17 final=   15  bob best=   17 final=   15  charlie DOWN  dave best=   17 final=   15  eve best=   17 final=   15
[17:21:08Z]  alice best=   18 final=   16  bob best=   18 final=   16  charlie DOWN  dave best=   18 final=   16  eve best=   18 final=   16
[17:21:14Z]  alice best=   19 final=   17  bob best=   19 final=   17  charlie DOWN  dave best=   19 final=   17  eve best=   19 final=   17
[17:21:20Z]  alice best=   20 final=   18  bob best=   20 final=   18  charlie DOWN  dave best=   20 final=   18  eve best=   20 final=   18
[17:21:27Z]  alice best=   20 final=   18  bob best=   20 final=   18  charlie DOWN  dave best=   20 final=   18  eve best=   20 final=   18
[17:21:33Z]  alice best=   21 final=   19  bob best=   21 final=   19  charlie DOWN  dave best=   21 final=   19  eve best=   21 final=   19
[17:21:39Z]  alice best=   22 final=   20  bob best=   22 final=   20  charlie DOWN  dave best=   22 final=   20  eve best=   22 final=   20
[17:21:45Z]  alice best=   23 final=   21  bob best=   23 final=   21  charlie DOWN  dave best=   23 final=   21  eve best=   23 final=   21
[17:21:51Z]  alice best=   24 final=   22  bob best=   24 final=   22  charlie DOWN  dave best=   24 final=   22  eve best=   24 final=   22
[17:21:57Z]  alice best=   24 final=   22  bob best=   24 final=   22  charlie DOWN  dave best=   24 final=   22  eve best=   24 final=   22
[17:22:04Z]  alice best=   25 final=   23  bob best=   25 final=   23  charlie DOWN  dave best=   25 final=   23  eve best=   25 final=   23
[17:22:10Z]  alice best=   26 final=   24  bob best=   26 final=   24  charlie DOWN  dave best=   26 final=   24  eve best=   26 final=   24

--- charlie still down. is-active: inactive ---
--- RESTARTING charlie at 17:22:10Z ---

[17:22:10Z]  alice best=   26 final=   24  bob best=   26 final=   24  charlie DOWN  dave best=   26 final=   24  eve best=   26 final=   24
[17:22:16Z]  alice best=   27 final=   25  bob best=   27 final=   25  charlie best=   27 final=   25  dave best=   27 final=   25  eve best=   27 final=   25
[17:22:22Z]  alice best=   28 final=   26  bob best=   28 final=   26  charlie best=   28 final=   26  dave best=   28 final=   26  eve best=   28 final=   26
```

**Outage: 17:20:37Z → 17:22:10Z = 93 seconds** (gate asks ≥60s).
**Finalized height over the outage: 11 → 24 = 13 blocks finalized with a
validator down.** `final` tracked `best` two blocks behind for the entire
window, on all four surviving nodes, which is the same lag as when all five were
up. Finality was not merely alive — it was unaffected.

### 3.2 The same window from alice's own log

`journalctl --user -u scalar-alice`. Note the peer count dropping 4 → 3 as
charlie leaves, while `finalized` keeps climbing:

```
19:20:23 💤 Idle (4 peers), best: #10 (0xace6…e7f6), finalized #8 (0xe564…9110)
19:20:28 💤 Idle (4 peers), best: #11 (0xd123…b272), finalized #9 (0x5a75…0c87)
19:20:33 💤 Idle (4 peers), best: #12 (0xece5…381e), finalized #10 (0xace6…e7f6)
19:20:38 💤 Idle (3 peers), best: #13 (0x5b03…5fff), finalized #11 (0xd123…b272)
19:20:43 💤 Idle (3 peers), best: #14 (0xdeab…d7f8), finalized #12 (0xece5…381e)
19:20:48 💤 Idle (3 peers), best: #15 (0x4891…846a), finalized #12 (0xece5…381e)
19:20:53 💤 Idle (3 peers), best: #15 (0x4891…846a), finalized #13 (0x5b03…5fff)
19:20:58 💤 Idle (3 peers), best: #16 (0xc7ff…fb4a), finalized #14 (0xdeab…d7f8)
19:21:03 💤 Idle (3 peers), best: #17 (0x2756…4455), finalized #15 (0x4891…846a)
19:21:08 💤 Idle (3 peers), best: #18 (0x3ac2…6eaf), finalized #16 (0xc7ff…fb4a)
19:21:13 💤 Idle (3 peers), best: #19 (0xbd2d…d8c6), finalized #17 (0x2756…4455)
19:21:18 💤 Idle (3 peers), best: #20 (0x5b09…acf1), finalized #17 (0x2756…4455)
19:21:23 💤 Idle (3 peers), best: #20 (0x5b09…acf1), finalized #18 (0x3ac2…6eaf)
19:21:33 💤 Idle (3 peers), best: #21 (0x4b04…d6aa), finalized #19 (0xbd2d…d8c6)
19:21:38 💤 Idle (3 peers), best: #22 (0xaf09…569e), finalized #20 (0x5b09…acf1)
19:21:43 💤 Idle (3 peers), best: #23 (0x35e3…36ef), finalized #21 (0x4b04…d6aa)
19:21:48 💤 Idle (3 peers), best: #24 (0xbc0e…62c2), finalized #21 (0x4b04…d6aa)
19:21:53 💤 Idle (3 peers), best: #24 (0xbc0e…62c2), finalized #22 (0xaf09…569e)
19:22:03 💤 Idle (3 peers), best: #25 (0xc30c…defe), finalized #23 (0x35e3…36ef)
19:22:08 💤 Idle (3 peers), best: #26 (0xb82f…65cc), finalized #24 (0xbc0e…62c2)
```

(Local time is UTC+2; 19:20:38 local = 17:20:38Z.)

### 3.3 Rejoin and catch-up

From charlie's log — stopped, restarted 93s later, in consensus and authoring
within 2 seconds, no manual intervention:

```
19:20:33 💤 Idle (4 peers), best: #12 (0xece5…381e), finalized #10 (0xace6…e7f6)
19:20:37 systemd[114489]: Stopping scalar-charlie.service - Scalar Commons devnet validator — charlie...
19:20:37 systemd[114489]: Stopped scalar-charlie.service - Scalar Commons devnet validator — charlie.
19:22:10 systemd[114489]: Starting scalar-charlie.service - Scalar Commons devnet validator — charlie...
19:22:10 systemd[114489]: Started scalar-charlie.service - Scalar Commons devnet validator — charlie.
19:22:11 〽️ Prometheus exporter started at 127.0.0.1:9617
19:22:11 👶 Starting BABE Authorship worker
19:22:12 🙌 Starting consensus session on top of parent 0xb82f…65cc (#26)
19:22:12 🏆 Imported #27 (0xb82f…65cc → 0xd943…efca)
19:22:16 💤 Idle (4 peers), best: #27 (0xd943…efca), finalized #25 (0xc30c…defe)
19:22:21 💤 Idle (4 peers), best: #28 (0x34c7…7d69), finalized #26 (0xb82f…65cc)
19:22:26 💤 Idle (4 peers), best: #29 (0xcc45…a12f), finalized #27 (0xd943…efca)
```

Charlie went down at #12, came back to a chain at #26, and was at the head with
the other four by #27 — one block. Peer count back to 4.

### 3.4 Contrast with ROUND10

| | ROUND10 (n=3) | ROUND15 (n=5) |
|---|---|---|
| authorities | 3 | 5 |
| GRANDPA threshold | 3 (all) | 4 |
| one node stopped | **finality frozen** | **finality advances** |
| measured | best 48→52, finalized stuck at 46 | best 13→26, finalized 11→24 |
| outage length | 35s | 93s |
| recovery | jumped 46→52 on rejoin | never fell behind; rejoin in 1 block |

---

## 5. Negative control — two down does stall, as predicted

A "finality survived" result means nothing unless the test could have failed.
Three of five is below the threshold of 4, so stopping a second validator must
stall finality. Charlie **and** dave stopped together:

```
=== ROUND15 NEGATIVE CONTROL: two of five down should STALL finality ===

--- BASELINE: all 5 up ---
[17:23:06Z]  alice best=   36 final=   33  bob best=   36 final=   33  charlie best=   36 final=   33  dave best=   36 final=   33  eve best=   36 final=   33
[17:23:12Z]  alice best=   37 final=   34  bob best=   37 final=   34  charlie best=   37 final=   34  dave best=   37 final=   34  eve best=   37 final=   34
[17:23:19Z]  alice best=   38 final=   36  bob best=   38 final=   36  charlie best=   38 final=   36  dave best=   38 final=   36  eve best=   38 final=   36

--- STOPPING charlie AND dave at 17:23:19Z (3 of 5 remain, threshold is 4) ---

[17:23:25Z]  alice best=   39 final=   36  bob best=   39 final=   36  charlie DOWN  dave DOWN  eve best=   39 final=   36
[17:23:31Z]  alice best=   40 final=   36  bob best=   40 final=   36  charlie DOWN  dave DOWN  eve best=   40 final=   36
[17:23:37Z]  alice best=   41 final=   36  bob best=   41 final=   36  charlie DOWN  dave DOWN  eve best=   41 final=   36
[17:23:43Z]  alice best=   42 final=   36  bob best=   42 final=   36  charlie DOWN  dave DOWN  eve best=   42 final=   36
[17:23:50Z]  alice best=   43 final=   36  bob best=   43 final=   36  charlie DOWN  dave DOWN  eve best=   43 final=   36
[17:23:56Z]  alice best=   43 final=   36  bob best=   43 final=   36  charlie DOWN  dave DOWN  eve best=   43 final=   36
[17:24:02Z]  alice best=   43 final=   36  bob best=   43 final=   36  charlie DOWN  dave DOWN  eve best=   43 final=   36
[17:24:08Z]  alice best=   43 final=   36  bob best=   43 final=   36  charlie DOWN  dave DOWN  eve best=   43 final=   36
[17:24:14Z]  alice best=   43 final=   36  bob best=   43 final=   36  charlie DOWN  dave DOWN  eve best=   43 final=   36
[17:24:20Z]  alice best=   44 final=   36  bob best=   44 final=   36  charlie DOWN  dave DOWN  eve best=   44 final=   36
[17:24:26Z]  alice best=   45 final=   36  bob best=   45 final=   36  charlie DOWN  dave DOWN  eve best=   45 final=   36

--- RESTARTING charlie and dave at 17:24:26Z ---

[17:24:27Z]  alice best=   45 final=   36  bob best=   45 final=   36  charlie DOWN  dave DOWN  eve best=   45 final=   36
[17:24:33Z]  alice best=   46 final=   44  bob best=   46 final=   44  charlie best=   46 final=   44  dave best=   46 final=   44  eve best=   46 final=   44
[17:24:39Z]  alice best=   47 final=   45  bob best=   47 final=   45  charlie best=   47 final=   45  dave best=   47 final=   45  eve best=   47 final=   45
[17:24:45Z]  alice best=   48 final=   46  bob best=   48 final=   46  charlie best=   48 final=   46  dave best=   48 final=   46  eve best=   48 final=   46
```

**Finality froze at #36 for the entire 67-second two-node outage** while `best`
climbed 38 → 45 — the exact ROUND10 failure signature, reproduced deliberately.
On restart, finality jumped **36 → 44 in a single step within ~7 seconds** and
resumed normal two-behind tracking.

This is the control that gives §3 its meaning: the same rig, the same script,
the same chain, one more node stopped, and the result inverts. The 5-validator
set tolerates one failure and not two, precisely as `n - (n-1)/3` predicts.

One honest observation from this run: with two of five BABE authorities absent,
**block production also degraded** — `best` sat at #43 from 17:23:50 to
17:24:20, roughly 30 seconds of empty slots, before resuming. Under a single
failure (§3) production never stuttered. So the second failure costs both
liveness properties, not just finality.

---

## 6. Firewall and ops updates

`deploy/README.md` was updated for the new topology. Ops-relevant deltas:

**Firewall — the p2p range widened.** ROUND10 documented
`sudo ufw allow 30333:30335/tcp`; that range does not cover dave (30336) or eve
(30337). The README now specifies:

```bash
sudo ufw allow 22/tcp                comment 'ssh — MUST be first'
sudo ufw allow 30333:30337/tcp       comment 'scalar commons devnet p2p (5 nodes)'
sudo ufw enable
```

with explicit instructions to *replace* the old rule rather than stack an
overlapping one. **Nothing is currently blocked by this** — ufw is still
inactive on this host, and all five nodes peer over loopback regardless. The
range only matters for external peers. Prometheus ports (9615–9619) are
deliberately left closed; nothing scrapes them and they are unauthenticated.
Alice's RPC remains bound to `127.0.0.1` — the ROUND10 reasoning for preferring
an SSH tunnel over `--rpc-external` is unchanged.

**Topology is now a single source of truth.** ROUND10 hardcoded
`for node in alice bob charlie` in three separate scripts. Going to five would
have meant three edits with three chances to miss one — and a node missing from
`reset-chain.sh`'s loop would silently keep a database from the *old* genesis
and then fail to sync, which is an unpleasant way to discover a typo. The list
now lives in `deploy/nodes.env`, which `install.sh`, `reset-chain.sh` and
`snapshot.sh` all source.

**New `deploy/finality-check.sh`.** ROUND10's difficulty was partly a tooling
gap: watching `journalctl` scroll makes block production and finality easy to
conflate. This prints both, per node, per sample, so a stall is unmistakable —
it is what produced the evidence above.

**`snapshot.sh` guidance reversed.** It used to warn that stopping a node for a
snapshot pauses finality, and that snapshots were therefore maintenance windows.
That is no longer true and the script says so — with the standing caveat that
snapshotting **two** nodes at once still stalls finality.

---

## 7. What still needs real multi-host validators for mainnet

The result above is a *consensus* result, and it should not be read as more than
that. **Five validators on one host is one fault domain, not five.** They share
a kernel, a disk, a NIC, a power supply, and a single `systemd --user` manager.
What was proven is that the chain survives one validator *process* stopping.
Nothing here says anything about surviving the loss of this machine — if it dies,
the surviving voter count is zero, not four.

What mainnet needs that this does not have:

- **Separate hosts, providers, and regions.** Five (ideally seven) validators
  each on its own machine, so a host, rack, provider or region failure costs at
  most one authority. Right now a single `kill -9` sweep, a full disk, or an OOM
  event takes all five.
- **Separate operators with separate credentials.** Five nodes one person can
  `systemctl --user stop` are not five independent failure probabilities,
  whatever the authority count says. The same applies to deploys: one operator
  rolling one broken binary to all five is a correlated failure the threshold
  arithmetic does not model.
- **Seven authorities, if two simultaneous failures must be survivable.** Five
  tolerates exactly one. This is worth restating because "we went from 3 to 5"
  sounds like more headroom than it is.
- **Real p2p addressing.** Every unit bootstraps from
  `/ip4/127.0.0.1/tcp/30333/…`. Mainnet needs public multiaddrs and *several*
  bootnodes — alice is currently a single bootnode whose loss would partition a
  cold-starting network.
- **Real keys.** Session keys are still the public `//Alice … //Eve` dev seeds,
  and node keys are still `0x00…01` through `0x00…05`. Anyone can author and
  sign as these validators. Mainnet needs per-validator generated session keys
  in each operator's own keystore, registered via `session.setKeys`, plus
  generated node keys with backups.
- **Monitoring that pages a human.** Prometheus is exported on loopback and
  nothing scrapes it. The finality stall in §5 was detected because a script was
  deliberately watching; in production nothing would have noticed. A stalled-
  finality alert is the single highest-value thing missing from this deployment.
- Unchanged mainnet blockers carried over from ROUND10: sudo is a single Alice
  key, SS58 prefix is still the generic 42, `ChainType::Local`, no TLS/reverse
  proxy/rate limiting, no key backup or DR runbook.

---

## 8. Gate checklist

| gate | status | evidence |
|---|---|---|
| N ≥ 4 validators | ✅ 5 | §2 topology; `session.keys` = 5, `validatorCount` = 5 |
| rebuilt from master, spec 304 | ✅ | `scalar-node 4.0.0-297bd66155d`; RPC reports specVersion 304 |
| authority set extended following existing pattern | ✅ | §1 diff — `authority_keys_from_seed`, all genesis fields derived |
| no runtime/pallet changes | ✅ | diff touches only `node/src/chain_spec.rs` + `deploy/**` |
| chain reset to genesis on new spec | ✅ | §2, new spec sha256, all nodes from block 0 |
| finalized height advances with one down | ✅ | §3.1 — 11 → 24 over 93s |
| ≥60s with N-1 nodes | ✅ 93s | §3.1 |
| stopped node rejoins and catches up | ✅ | §3.3 — authoring within 2s, head in 1 block |
| negative control (two down stalls) | ✅ | §5 — finality frozen at #36 for 67s |
| lint gate clean | ✅ | `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings` |
| CI green on PR | ✅ | PR #69 — both checks pass |

```
$ gh pr checks 69
full    pass    34m6s   .../runs/30836862042/job/91764040053
gate    pass    38m12s  .../runs/30836862011/job/91764040095
```

`gate` is ci-fast (fmt, clippy `-D warnings`, `cargo check`); `full` is ci-full,
which builds the release binary and runs the workspace test suite.

## 9. Current devnet state

Left running, all five active, finalizing normally on spec 304. `install.sh` has
enabled every unit, so the set returns as five after a reboot.
