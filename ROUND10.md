# ROUND 10 — Persistent 3-validator devnet on the VPS

**Date:** 2026-08-02 · **Host:** `v2202607384283486718` (152.53.113.104) ·
**Binary:** `scalar-node 4.0.0-bed14893c1f` (HEAD `bed1489`)
**Commit:** `96ef3e6 deploy: persistent 3-validator devnet under user systemd`
(on `master` — see "Branch decision")

**Gate: MET.** Three validators finalizing under user systemd, one node
restarted and recovered, all units enabled and reboot-durable via linger.

**ABSOLUTE RULE honored:** no pallet, runtime, or `node/src/` file was touched.
The chain needed no code change to run persistently. `git show --stat 96ef3e6`
is entirely `deploy/`.

---

## 1. What was created

Everything lives in a new top-level `deploy/` plus four user systemd units.

```
deploy/
├── README.md                   ops runbook + your firewall commands + mainnet gaps
├── scalar-local-raw.json       raw chainspec (2.3 MB, 176 genesis storage entries)
├── build-spec.sh               regenerate that chainspec
├── install.sh                  idempotent: base paths, node keys, unit install + enable
├── snapshot.sh                 consistent state snapshot of one node
├── reset-chain.sh              DESTRUCTIVE wipe back to genesis
└── systemd/
    ├── scalar-alice.service
    ├── scalar-bob.service
    ├── scalar-charlie.service
    └── scalar-devnet.target
```

Units are installed to `~/.config/systemd/user/`. **No sudo was used anywhere**,
and no system-level unit was created.

### Topology

| node    | p2p   | RPC              | prometheus       | base path                  | pruning |
|---------|-------|------------------|------------------|----------------------------|---------|
| alice   | 30333 | 9944 (127.0.0.1) | 9615 (127.0.0.1) | `~/scalar-testnet/alice`   | archive |
| bob     | 30334 | 9945 (127.0.0.1) | 9616 (127.0.0.1) | `~/scalar-testnet/bob`     | default |
| charlie | 30335 | 9946 (127.0.0.1) | 9617 (127.0.0.1) | `~/scalar-testnet/charlie` | default |

- **Chain spec:** the existing `local` preset (Alice/Bob/Charlie authorities),
  built to raw and committed so all three nodes — and any node that joins later
  — boot byte-identical genesis regardless of which binary is on disk.
  `id: scalar-local`, `chainType: Local`, `CMN`/12 decimals, ss58 42.
- **Fixed node keys** (`0x00…01/02/03`, mode 0600) pin each peer id, so alice's
  bootnode multiaddr stays valid across restarts and reboots:
  `/ip4/127.0.0.1/tcp/30333/p2p/12D3KooWEyoppNCUx8Yx66oV9fJnriXwCcXwDDUA2kj6vnc6iDEp`
  Verified deterministic — it reproduces the peer id recorded in ROUND4.
- **bob and charlie are given only alice as a bootnode.** They are never told
  about each other; authority discovery (ROUND5) resolves the rest.
- alice runs `archive` pruning because she is the RPC/indexer endpoint and needs
  full history; bob and charlie use defaults to save disk.

### Why a `.target`

`scalar-devnet.target` is `WantedBy=default.target`, and each service is
`WantedBy=scalar-devnet.target` + `PartOf=scalar-devnet.target`. That gives one
handle for all three (`systemctl --user restart scalar-devnet.target`) while
keeping each node independently startable. The enable chain that makes reboot
survival work:

```
/home/dev/.config/systemd/user/default.target.wants/scalar-devnet.target
/home/dev/.config/systemd/user/scalar-devnet.target.wants/scalar-alice.service
/home/dev/.config/systemd/user/scalar-devnet.target.wants/scalar-bob.service
/home/dev/.config/systemd/user/scalar-devnet.target.wants/scalar-charlie.service
```

---

## 2. Persistence and health evidence

### 2.1 Units enabled, linger on

```
$ systemctl --user is-enabled scalar-devnet.target scalar-alice.service scalar-bob.service scalar-charlie.service
enabled
enabled
enabled
enabled

$ loginctl show-user dev | grep -i linger
Linger=yes
```

`Linger=yes` + `WantedBy=default.target` is the mechanism by which the user
manager starts at boot with nobody logged in. **Caveat stated honestly: I did
not reboot this box to prove it.** A reboot is a disruptive, outward-facing act
on a machine I do not own, so I verified the mechanism (enable symlinks + linger)
rather than the event. If you want the real proof, `sudo reboot` and then
`systemctl --user status scalar-alice`.

### 2.2 Bind surface — RPC is on loopback, as intended

```
$ ss -ltnp | grep -E "9944|9945|9946|9615|3033"
LISTEN 0 1024   0.0.0.0:30333  0.0.0.0:*  users:(("scalar-node",pid=528233,fd=32))
LISTEN 0 1024   0.0.0.0:30334  0.0.0.0:*  users:(("scalar-node",pid=528234,fd=32))
LISTEN 0 1024   0.0.0.0:30335  0.0.0.0:*  users:(("scalar-node",pid=528235,fd=32))
LISTEN 0 1024 127.0.0.1:9615   0.0.0.0:*  users:(("scalar-node",pid=528233,fd=36))
LISTEN 0 1024 127.0.0.1:9944   0.0.0.0:*  users:(("scalar-node",pid=528233,fd=34))
LISTEN 0 1024 127.0.0.1:9945   0.0.0.0:*  users:(("scalar-node",pid=528234,fd=39))
LISTEN 0 1024 127.0.0.1:9946   0.0.0.0:*  users:(("scalar-node",pid=528235,fd=38))
```

RPC and Prometheus: loopback only. p2p: all interfaces (see §3 — that port *is*
currently reachable from the internet).

### 2.3 All three finalizing — 2m21s sampled via RPC

Sampled `system_syncState` and `chain_getFinalizedHead` on all three nodes
(ports 9944/9945/9946) every 10s. Columns are `best/finalized`:

```
utc time              | alice (best/final)     | bob (best/final)       | charlie (best/final)
------------------------------------------------------------------------------------------------
2026-08-02T21:15:41Z  | 7/5                    | 7/5                    | 7/5
2026-08-02T21:15:51Z  | 9/7                    | 9/7                    | 9/7
2026-08-02T21:16:01Z  | 11/9                   | 11/9                   | 11/9
2026-08-02T21:16:11Z  | 12/10                  | 12/10                  | 12/10
2026-08-02T21:16:21Z  | 14/12                  | 14/12                  | 14/12
2026-08-02T21:16:32Z  | 16/14                  | 16/14                  | 16/14
2026-08-02T21:16:42Z  | 18/15                  | 18/15                  | 18/15
2026-08-02T21:16:52Z  | 19/17                  | 19/17                  | 19/17
2026-08-02T21:17:02Z  | 21/19                  | 21/19                  | 21/19
2026-08-02T21:17:12Z  | 23/20                  | 23/20                  | 23/20
2026-08-02T21:17:22Z  | 24/22                  | 24/22                  | 24/22
2026-08-02T21:17:32Z  | 26/24                  | 26/24                  | 26/24
2026-08-02T21:17:42Z  | 28/25                  | 28/25                  | 28/25
2026-08-02T21:17:52Z  | 29/27                  | 29/27                  | 29/27
2026-08-02T21:18:02Z  | 31/29                  | 31/29                  | 31/29
```

Finalized **5 → 29** in 141s across all three nodes, in exact agreement at every
sample. ~6s block time, finality tracking ~2 blocks behind head.

Verbatim journald from alice over the same period:

```
Aug 02 23:15:00 scalar-alice[528233]: 👶 New epoch 0 launching at block 0x7a3e…d8f7 (block slot 297617550 >= start slot 297617550).
Aug 02 23:15:00 scalar-alice[528233]: 🏆 Imported #1 (0x7019…356f → 0x7a3e…d8f7)
Aug 02 23:15:04 scalar-alice[528233]: 💤 Idle (2 peers), best: #1 (0x7a3e…d8f7), finalized #0 (0x7019…356f), ⬇ 3.5kiB/s ⬆ 3.4kiB/s
Aug 02 23:15:09 scalar-alice[528233]: 💤 Idle (2 peers), best: #2 (0x84c1…4472), finalized #0 (0x7019…356f), ⬇ 4.1kiB/s ⬆ 3.9kiB/s
Aug 02 23:15:14 scalar-alice[528233]: 💤 Idle (2 peers), best: #3 (0x5ded…4bdb), finalized #1 (0x7a3e…d8f7), ⬇ 1.8kiB/s ⬆ 1.7kiB/s
```

and from bob and charlie, showing they are authoring (not just following):

```
Aug 02 23:15:18 scalar-bob[528234]: 🙌 Starting consensus session on top of parent 0x5ded…4bdb (#3)
Aug 02 23:15:18 scalar-bob[528234]: 🎁 Prepared block for proposing at 4 (1 ms) hash: 0x14c3…d2aa; parent_hash: 0x5ded…4bdb
Aug 02 23:15:18 scalar-bob[528234]: 🔖 Pre-sealed block for proposal at 4.

Aug 02 23:15:12 scalar-charlie[528235]: 🙌 Starting consensus session on top of parent 0x84c1…4472 (#2)
Aug 02 23:15:12 scalar-charlie[528235]: 🎁 Prepared block for proposing at 3 (1 ms) hash: 0xcc29…5fe9
Aug 02 23:15:12 scalar-charlie[528235]: 🏆 Imported #3 (0x84c1…4472 → 0x5ded…4bdb)
```

Discovery working — alice learned both peers' addresses although only *they*
were given *her* multiaddr, never the reverse:

```
Aug 02 23:14:54 scalar-alice[528233]: discovered peer on address peer=12D3KooWSCufgHzV4fCwRijfH2k3abrpAJxTKxEvN1FDuRXA2U9x address=/ip4/152.53.113.104/tcp/30335/…
Aug 02 23:14:54 scalar-alice[528233]: discovered peer on address peer=12D3KooWHdiAxVd8uMQR1hGWXccidmfCwLqcMpGwR6QcTP6QRMuD address=/ip4/152.53.113.104/tcp/30334/…
```

### 2.4 Restart one node → rejoins and catches up

`systemctl --user restart scalar-bob.service` at 21:18:23Z:

```
=========== BEFORE RESTART ===========
time      label            | alice best/fin | bob best/fin   | charlie best/fin
21:18:23Z steady-state     | 34/32          | 34/32          | 34/32
=========== RESTARTING BOB ===========
restart issued at 21:18:23Z
21:18:23Z t+5s             | 34/32          | DOWN/DOWN      | 34/32
21:18:28Z t+10s            | 35/33          | 35/33          | 35/33
21:18:33Z t+15s            | 36/34          | 36/34          | 36/34
21:18:38Z t+20s            | 37/35          | 37/35          | 37/35
21:18:49Z t+30s            | 39/36          | 39/36          | 39/36
21:19:19Z t+60s            | 44/41          | 44/41          | 44/41
=========== FINAL STATE ===========
active
active
active
```

The systemd + node lifecycle, verbatim:

```
Aug 02 23:18:23 systemd[114489]: Stopping scalar-bob.service - Scalar Commons devnet validator — bob...
Aug 02 23:18:23 systemd[114489]: Stopped scalar-bob.service - Scalar Commons devnet validator — bob.
Aug 02 23:18:23 systemd[114489]: Started scalar-bob.service - Scalar Commons devnet validator — bob.
Aug 02 23:18:23 scalar-bob[529972]: 👤 Role: AUTHORITY
Aug 02 23:18:23 scalar-bob[529972]: 💾 Database: RocksDb at /home/dev/scalar-testnet/bob/chains/scalar-local/db/full
Aug 02 23:18:23 scalar-bob[529972]: 🏷  Local node identity is: 12D3KooWHdiAxVd8uMQR1hGWXccidmfCwLqcMpGwR6QcTP6QRMuD
Aug 02 23:18:23 scalar-bob[529972]: 📦 Highest known block at #34
```

Three things this proves at once: **new PID** (528234 → 529972, a real process
replacement), **same peer identity** (the `--node-key-file` survived, so the
network identity is stable across restarts), and **`Highest known block at #34`
— resumed from the persisted database, not from genesis.**

### 2.5 Bonus: what an actual outage looks like (35s, charlie)

The restart above was so fast (<5s) that no finality stall was observable at 5s
sampling. Because I had asserted a fault-tolerance property in the README, I
tested it properly rather than leave it as an unbacked claim — charlie stopped
for 35s, alice and bob sampled:

```
21:19:44Z steady     | alice 48/46 | bob 48/46
--- STOPPING CHARLIE (2 of 3 authorities remain) ---
21:19:50Z down+10s   | alice 49/46 | bob 49/46
21:19:55Z down+15s   | alice 50/46 | bob 50/46
21:20:05Z down+25s   | alice 50/46 | bob 50/46
21:20:15Z down+35s   | alice 52/46 | bob 52/46      <- best +4, finalized frozen
--- STARTING CHARLIE ---
21:20:20Z up+5s      | alice 53/46 | bob 53/46
21:20:25Z up+10s     | alice 54/52 | bob 54/52      <- finality catches up in one step
21:20:40Z up+25s     | alice 56/54 | bob 56/54
```

```
Aug 02 23:20:20 systemd[114489]: Started scalar-charlie.service …
Aug 02 23:20:20 scalar-charlie[531700]: 🏷  Local node identity is: 12D3KooWSCufgHzV4fCwRijfH2k3abrpAJxTKxEvN1FDuRXA2U9x
Aug 02 23:20:20 scalar-charlie[531700]: 📦 Highest known block at #48
Aug 02 23:20:25 scalar-charlie[531700]: 💤 Idle (2 peers), best: #54 (0x9174…33f7), finalized #52 (0x9813…3d05), ⬇ 5.7kiB/s ⬆ 4.1kiB/s
```

**Finding worth carrying forward: this 3-validator set tolerates zero failures
for finality.** GRANDPA's threshold is `n - (n-1)/3`, which for `n = 3` is `3` —
every authority must vote. Block production continued (BABE only needs a slot
leader) while finality sat still for the whole outage, then jumped 46 → 52 within
~10s of charlie returning, unattended. This is inherent to a 3-authority set,
not a defect, and it matches ROUND4's own note that one node cannot form a quorum
for a three-authority set. **A network that must survive one validator being down
needs at least 4 authorities.** Treat snapshots and restarts as maintenance
windows until then.

### 2.6 Recovery summary in one output

```
$ for p in 9944 9945 9946; do curl -s … system_syncState; done
port 9944: {"startingBlock":0, "currentBlock":64,"highestBlock":64}   # alice, never restarted
port 9945: {"startingBlock":34,"currentBlock":64,"highestBlock":64}   # bob,     restarted at #34
port 9946: {"startingBlock":48,"currentBlock":64,"highestBlock":64}   # charlie, stopped at #48
```

Each node resumed from exactly where it left off, and all three converged to the
same height. No crash-restarts occurred (`NRestarts=0` on all three; the manual
restart does not increment that counter, which tracks `Restart=` policy firings).

### 2.7 Unattended steady state after all tests

Left alone for ~3 minutes following both disruption tests, no intervention:

```
=== 21:23:30Z ===
port 9944: {"startingBlock":0, "currentBlock":85,"highestBlock":85}
port 9945: {"startingBlock":34,"currentBlock":85,"highestBlock":85}
port 9946: {"startingBlock":48,"currentBlock":85,"highestBlock":85}

Aug 02 23:23:29 scalar-alice[528233]:   💤 Idle (2 peers), best: #84 (0xbd99…0468), finalized #82 (0xdaed…1b8f)
Aug 02 23:23:28 scalar-bob[529972]:     💤 Idle (2 peers), best: #84 (0xbd99…0468), finalized #82 (0xdaed…1b8f)
Aug 02 23:23:25 scalar-charlie[531700]: 💤 Idle (2 peers), best: #84 (0xbd99…0468), finalized #82 (0xdaed…1b8f)
```

Identical best and finalized hashes on all three, 2 peers each, still climbing.

### 2.8 Footprint

~450 MB RSS per node (1.35 GB total on a 62 GB box); chain DBs 2.2–3.5 MB after
the first ~10 minutes. Alice is `archive` and will grow without bound over
months — worth a disk check eventually, but 1.9 TB is free.

---

## 3. What YOU need to run — firewall and public RPC

These need root; I have no sudo. Full text in `deploy/README.md`.

**Current state: `ufw` is installed and its unit is enabled, but the service is
inactive — nothing is filtering packets on this host right now.**

> ⚠️ `ufw enable` applies default-deny-incoming. **Allow SSH first or you will
> lock yourself out.** SSH is on port 22.

Open p2p so external nodes can join (not required for the devnet to work — all
three talk over loopback and finalize with every port closed):

```bash
sudo ufw allow 22/tcp                comment 'ssh — MUST be first'
sudo ufw allow 30333:30335/tcp       comment 'scalar commons devnet p2p'
sudo ufw enable
sudo ufw status verbose
```

Optional public RPC — prefer scoping it to your own address:

```bash
sudo ufw allow from <YOUR.IP.ADDR> to any port 9944 proto tcp comment 'scalar RPC'
```

### The one deviation from the brief, and why

Task 3 asked for `--rpc-external --rpc-cors all --rpc-methods safe` **on
`127.0.0.1:9944`**, with public exposure left to the firewall "not by binding to
0.0.0.0 yet". Those two halves are mutually exclusive: `--rpc-external`'s own
help text is *"Listen to all RPC interfaces (default: local)"* — it is precisely
the flag that binds `0.0.0.0`.

I resolved it toward the **stated intent** (localhost) and **did not** pass
`--rpc-external`, because ufw is inactive: binding `0.0.0.0` today would put
JSON-RPC on a public IP with no packet filter in front of it. `--rpc-cors all`
and `--rpc-methods safe` are both set as asked.

**You lose nothing operationally** — an SSH tunnel reaches it with no firewall
change and no unit edit:

```bash
ssh -L 9944:127.0.0.1:9944 dev@152.53.113.104
# then ws://127.0.0.1:9944 — e.g. polkadot.js.org/apps/?rpc=ws%3A%2F%2F127.0.0.1%3A9944
```

To genuinely bind it publicly: put the firewall up first, add `--rpc-external \`
to `ExecStart` in `deploy/systemd/scalar-alice.service`, then `./deploy/install.sh
&& systemctl --user restart scalar-alice`, and confirm with `ss -ltnp | grep 9944`.
Say the word and I'll make that edit — I did not want to open a public RPC port
on your box on my own initiative.

**Note the p2p ports are already reachable from the internet** (`0.0.0.0:30333-5`,
no filter). That is normal for a blockchain node and is how outside peers would
connect, but you should know it is the current state rather than assume the box
is closed.

---

## 4. What mainnet needs that this testnet skips

This devnet is **not a mainnet template**. It is deliberately insecure in ways
that are fine locally and disqualifying for anything holding value:

- **Session keys are the well-known `//Alice`, `//Bob`, `//Charlie` seeds.**
  Those private keys are public knowledge, in every Substrate test fixture on
  earth. Anyone can sign as these validators. Mainnet needs per-validator
  generated keys (`key generate-session-keys`) held in each validator's own
  keystore and registered via `session.setKeys`.
- **Node keys are `0x00…01/02/03`.** Real ones come from `key generate-node-key`,
  0600, and backed up — losing one changes a bootnode's peer id.
- **`sudo` is a single Alice key.** `chain_spec.rs` already says "replaced by
  multisig in staging/mainnet"; mainnet needs the multisig plus the documented
  day-14 referendum handoff that removes sudo entirely.
- **One host = one fault domain.** Three validators sharing a box, kernel, disk
  and PSU is not three validators in any meaningful sense.
- **Three authorities = zero finality fault tolerance** (measured, §2.5). Needs
  ≥4, realistically many more.
- **SS58 prefix 42**, the generic default — `chain_spec.rs` flags this as a
  `MAINNET BLOCKER`.
- **`ChainType::Local`**, no telemetry endpoints, no public bootnodes in spec.
- **No TLS/reverse proxy/rate limiting, no monitoring or alerting.** Prometheus
  is exported on loopback but nothing scrapes it and nothing pages anyone when
  finality stalls — which, per §2.5, is exactly the failure mode to alert on.
- **No key backup or DR** beyond `snapshot.sh`.

---

## 5. What I did NOT do

- **Did not touch pallets, runtime, or `node/src/`.** No code change was needed;
  the chain ran persistently as-is. The ABSOLUTE RULE was never in tension.
- **Did not reboot the box** to prove reboot survival. Verified the mechanism
  (enable symlinks into `default.target.wants` + `Linger=yes`), not the event —
  a reboot is disruptive and yours to schedule.
- **Did not pass `--rpc-external` / bind RPC to `0.0.0.0`.** Reasoned above;
  reversible in one line whenever you want it.
- **Did not run any `sudo`/firewall command.** No sudo available and not mine to
  run; the exact commands are in §3 and `deploy/README.md`.
- **Did not install ufw rules, TLS, a reverse proxy, or monitoring/alerting.**
  Out of scope for this round; flagged as mainnet gaps.
- **Did not wire the indexer** (`indexer/`) to this devnet. Alice is `archive`
  specifically so that is easy later, but it was not asked for and I did not
  start it.
- **Did not run the Rust test suite or lint gates.** Nothing compiled-in changed
  — the only build was a rebuild of the existing HEAD (the on-disk binary was
  stale relative to sources; the rebuild was clean, 4m21s).
- **Did not touch the pre-existing uncommitted work** in `factory/` or
  `CIFIX.md`, which was dirty when I started and is untouched.
- **Did not create a PR.** Committed `deploy/` straight to `master` as the brief
  permitted for non-gated files. See below.

### Branch decision

**master, directly** — commit `96ef3e6`. The brief allowed either; `deploy/` is
new, additive, ungated ops config that no CI job builds and no other work
depends on, so a review branch would have been ceremony without a reviewer. The
commit is scoped to exactly `deploy/` and reverts cleanly with
`git revert 96ef3e6` (that would delete the files; the running units in
`~/.config/systemd/user/` would need `systemctl --user disable --now
scalar-devnet.target scalar-alice scalar-bob scalar-charlie` separately).

---

## 6. Operating it

```bash
systemctl --user status scalar-alice scalar-bob scalar-charlie --no-pager
journalctl --user -u scalar-alice -f
journalctl --user -u scalar-alice -u scalar-bob -u scalar-charlie -f
systemctl --user restart scalar-devnet.target      # all three
systemctl --user restart scalar-bob                # just one
./deploy/snapshot.sh alice                         # consistent state snapshot
```

The devnet is running right now and will keep running. Full runbook:
`deploy/README.md`.
