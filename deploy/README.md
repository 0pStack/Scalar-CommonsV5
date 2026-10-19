# Scalar Commons — persistent 5-validator devnet

A 5-validator Scalar Commons network that runs 24/7 on this VPS under **user**
systemd (no root, no system units). `loginctl enable-linger dev` is already set,
which is what lets the user manager start at boot with nobody logged in — that
is the mechanism by which this survives a reboot.

Everything here is ops and configuration. The only source change ROUND15 made
was the `local` preset's authority list in `node/src/chain_spec.rs` — no pallet
or runtime logic is involved.

This file covers the five validators. The indexer, explorer and faucet that read
from them are in [`products/README.md`](products/README.md).

> **ROUND15 changed the network's identity.** Going from 3 to 5 authorities is a
> different genesis, therefore a different chain. The chainspec was regenerated
> and the databases wiped; any node still holding pre-ROUND15 data cannot sync
> against this chain. See "Resetting the chain".

---

## Layout

| node    | p2p   | RPC                 | prometheus       | base path                 | pruning |
|---------|-------|---------------------|------------------|---------------------------|---------|
| alice   | 30333 | 9944 (127.0.0.1)    | 9615 (127.0.0.1) | `~/scalar-testnet/alice`  | archive |
| bob     | 30334 | 9945 (127.0.0.1)    | 9616 (127.0.0.1) | `~/scalar-testnet/bob`    | default |
| charlie | 30335 | 9946 (127.0.0.1)    | 9617 (127.0.0.1) | `~/scalar-testnet/charlie`| default |
| dave    | 30336 | 9947 (127.0.0.1)    | 9618 (127.0.0.1) | `~/scalar-testnet/dave`   | default |
| eve     | 30337 | 9948 (127.0.0.1)    | 9619 (127.0.0.1) | `~/scalar-testnet/eve`    | default |

Ports run in parallel blocks, so the Nth node is `30333+i` / `9944+i` / `9615+i`.
`deploy/nodes.env` is the machine-readable copy of this table.

- **alice is the bootnode and the query endpoint.** Her peer id is pinned by a
  fixed node key, so the multiaddr baked into the other four units stays valid
  forever:
  `/ip4/127.0.0.1/tcp/30333/p2p/12D3KooWEyoppNCUx8Yx66oV9fJnriXwCcXwDDUA2kj6vnc6iDEp`
- **bob, charlie, dave and eve are given only alice as a bootnode.** They find
  each other through authority discovery over the DHT (ROUND5), never through
  config — which is why adding dave and eve required no edit to the existing
  three units.
- alice runs `archive` pruning because she is the endpoint the indexer would
  query and needs full history. The rest use default pruning to save disk.
- Every node's RPC is bound to loopback and is reachable locally; only alice's
  is treated as the public-facing one. `finality-check.sh` polls all five.

Files:

```
deploy/
├── README.md                   this file
├── nodes.env                   topology: node list, node keys, RPC ports
├── scalar-local-raw.json       committed raw chainspec (the network's identity)
├── build-spec.sh               regenerate that chainspec
├── install.sh                  create base paths + node keys, install & enable units
├── finality-check.sh           sample best + FINALIZED height on every node
├── snapshot.sh                 consistent state snapshot of one node
├── reset-chain.sh              DESTRUCTIVE wipe back to genesis
├── hardening/
│   ├── sshd.conf               no passwords, no keyboard-interactive, no root login
│   ├── apply.sh                install it to /etc/ssh/sshd_config.d/, validate, reload
│   ├── sshd.gate               issue #138's gate: is sshd EFFECTIVELY hardened?
│   ├── test-apply.sh           proves apply.sh refuses to lock you out
│   └── test-gate.sh            proves the gate reads the effective config, not one file
└── systemd/
    ├── scalar-alice.service
    ├── scalar-bob.service
    ├── scalar-charlie.service
    ├── scalar-dave.service
    ├── scalar-eve.service
    └── scalar-devnet.target    starts/stops all five together
```

`install.sh`, `reset-chain.sh` and `snapshot.sh` all read the node list from
`nodes.env` rather than hardcoding it. ROUND10 had `alice bob charlie` written
out in three separate loops; adding two nodes meant three chances to miss one,
and a node missing from `reset-chain.sh`'s loop would silently keep a database
belonging to the old genesis.

---

## Install and start

```bash
cargo build --release -p scalar-node     # if the binary is not current
./deploy/build-spec.sh                   # only needed if the spec is missing
./deploy/install.sh                      # base paths, node keys, units, enable
systemctl --user start scalar-devnet.target
```

`install.sh` is idempotent and never deletes chain data.

---

## Status

```bash
# best + FINALIZED height on every node, one line per sample — start here
./deploy/finality-check.sh          # single sample
./deploy/finality-check.sh 12 5     # 12 samples, 5s apart

# all five at a glance
systemctl --user status scalar-alice scalar-bob scalar-charlie scalar-dave scalar-eve --no-pager

# just the up/down state
systemctl --user is-active scalar-alice scalar-bob scalar-charlie scalar-dave scalar-eve

# confirm they are enabled — i.e. they come back after a reboot
systemctl --user is-enabled scalar-devnet.target scalar-alice scalar-bob scalar-charlie scalar-dave scalar-eve

# current height and finality, straight from alice's RPC
curl -sH 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"system_syncState","params":[]}' \
     http://127.0.0.1:9944

curl -sH 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"chain_getFinalizedHead","params":[]}' \
     http://127.0.0.1:9944

# peer count
curl -sH 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"system_health","params":[]}' \
     http://127.0.0.1:9944
```

## Logs

All five log to journald.

```bash
journalctl --user -u scalar-alice -f                 # follow one node
journalctl --user -u scalar-alice -n 100 --no-pager  # last 100 lines
journalctl --user -u scalar-alice --since '10 min ago' --no-pager

# all five interleaved
journalctl --user -u scalar-alice -u scalar-bob -u scalar-charlie \
                  -u scalar-dave -u scalar-eve -f

# just the heartbeat lines (best / finalized height)
journalctl --user -u scalar-alice --since '5 min ago' --no-pager | grep Idle
```

## Stop / start / restart

```bash
systemctl --user restart scalar-bob            # one node — finality survives this
systemctl --user stop    scalar-devnet.target  # all five
systemctl --user start   scalar-devnet.target
systemctl --user restart scalar-devnet.target
```

The services declare `PartOf=scalar-devnet.target`, so target-level stop and
restart move all five together.

To stop the devnet coming back after a reboot:

```bash
systemctl --user disable scalar-devnet.target scalar-alice scalar-bob \
                         scalar-charlie scalar-dave scalar-eve
```

---

## Node RPC limits

Every `deploy/systemd/scalar-*.service` carries per-connection RPC bounds. They
are **not applied to the running nodes** until each is restarted — see the
rolling-restart recipe below.

| flag | value | why |
|---|---|---|
| `--rpc-rate-limit` | 300 | calls per **minute** per connection (the flag's unit; not per second). No default at all — unset means unlimited. |
| `--rpc-max-connections` | 100 | the upstream default, stated explicitly so a future default change cannot silently widen it. |
| `--rpc-max-subscriptions-per-connection` | 64 | down from 1024. A subscription is server-side work a client never has to ask for twice. |
| `--rpc-max-batch-request-len` | 16 | caps how much one message can amplify into. Without it a rate limit is nominal. |
| `--rpc-max-request-size` | 10 MB | down from 15. |
| `--rpc-message-buffer-capacity-per-connection` | 32 | bounds queued outbound messages per socket. |

Response size is deliberately **left at its 15 MB default** — lowering it would
truncate legitimate archive queries against alice.

`--rpc-rate-limit-trust-proxy-headers` is deliberately **not** set. Its help text
is *"Trust proxy headers for disable rate limiting"* — a bypass switch, not a
hardening one. The rate limit is per **connection**, so proxying does not
collapse it the way it collapsed the faucet's per-IP limit; there is nothing to
gain and a bypass to lose.

The same limits are on all five nodes, not just alice. A limit only the
public-facing node carries is a limit that disappears the moment someone fronts
a different one.

**Why the node and not nginx:** on websockets `limit_req` bounds *connection
establishment* only, never the JSON-RPC messages inside an already-open socket.
Before this, one client past nginx's 10 r/s handshake budget could call at an
unbounded rate in unbounded batches. TESTNETAUDIT.md §6 I-23, issue #139.

### Rolling restart — one node at a time

A restart is not free. Roll them one at a time, waiting for finality between
each, and do **alice last** (bootnode and query endpoint):

```bash
for n in eve dave charlie bob alice; do
    systemctl --user restart "scalar-$n"
    sleep 30
    ./deploy/finality-check.sh
done
```

Never restart two at once: two down of five leaves three, below GRANDPA's
threshold of four, and finality stalls until one returns.

Confirm afterwards that the flags actually took:

```bash
tr '\0' ' ' < /proc/$(systemctl --user show -p MainPID --value scalar-alice)/cmdline | tr ' ' '\n' | grep rpc
```

---

## Host hardening — sshd and fail2ban

Neither of the two controls below was recorded anywhere in this repository until
now: `git grep -il 'fail2ban|PermitRootLogin|PasswordAuthentication'` over the
whole tracked tree returned nothing. A clean-machine rebuild following this
directory therefore reproduced neither of them, and an operator had no way to
know either existed. That is issue #138 (TESTNETAUDIT.md §6 I-24).

### sshd — currently accepts password AND root login from the internet

`/etc/ssh/sshd_config` ends with two appended lines:

```
124:PasswordAuthentication yes
125:PermitRootLogin yes
```

sshd listens on `0.0.0.0:22` and `[::]:22`, so the box accepts **password-based
root login from the internet**, with `fail2ban` as the only brute-force control
in front of it. This sits directly beneath the chain's root key: anyone who gets
a shell here gets the operator's sudo key (#119), the faucet's signing key, and
every validator's session keys, without touching the chain at all.

The fix ships in this directory:

```bash
./deploy/hardening/apply.sh --dry-run     # no sudo needed; changes nothing
sudo ./deploy/hardening/apply.sh          # install, validate, reload
```

It installs `deploy/hardening/sshd.conf` to
`/etc/ssh/sshd_config.d/10-scalar-hardening.conf` — `PasswordAuthentication no`,
`KbdInteractiveAuthentication no`, `PermitRootLogin no`.

A drop-in rather than an edit, because the two bad lines are at the **end** of
`sshd_config` and sshd takes the **first** value it obtains for a keyword, not
the last. `Include /etc/ssh/sshd_config.d/*.conf` is at line 12, before them, so
the drop-in wins. The script verifies that Include is present rather than
assuming it, and re-reads the effective config with `sshd -G` afterwards, because
installing a file is not the same as changing a setting.

> [!WARNING]
> This removes every password-based way into this host. The script refuses to
> run unless `~/.ssh/authorized_keys` exists and holds at least one usable key
> line, and refuses if `PubkeyAuthentication` is not enabled — but the check is
> only as good as the key being *yours and working*. **Keep your current session
> open and confirm a second one succeeds before closing it.** To undo:
> `sudo rm /etc/ssh/sshd_config.d/10-scalar-hardening.conf && sudo systemctl reload ssh`

`deploy/hardening/test-apply.sh` covers the refusal paths (missing, empty,
whitespace-only and comments-only `authorized_keys`) by running the real script
with `--dry-run`. It writes nothing.

### Checking whether sshd is actually hardened

```bash
bash deploy/hardening/sshd.gate && echo hardened || echo NOT hardened
```

That is issue #138's gate, and it asks **sshd** what it will do rather than
reading a file:

```sh
test "$(/usr/sbin/sshd -G 2>/dev/null | grep -cE '^(passwordauthentication|permitrootlogin|kbdinteractiveauthentication) no$')" = 3
```

`sshd -G` prints the merged configuration — main file plus every drop-in, in
precedence order — and needs no root, so this is safe to run unprivileged.

**Do not replace this with a grep of `/etc/ssh/sshd_config`.** That is what the
gate originally did, and it is wrong in both directions. The hardening is a
drop-in, and the correct fix deliberately leaves `PasswordAuthentication yes`
and `PermitRootLogin yes` in place at the end of `sshd_config` — so a file grep
reports a hardened host as unhardened. Worse, a host whose `sshd_config` says
`no` while a drop-in included above it says `yes` is **wide open**, and a file
grep reports it as hardened. `deploy/hardening/test-gate.sh` holds both cases,
along with `prohibit-password` (which is still root login), an unparseable
config and a missing `sshd` binary — the last two must fail closed, because
"could not tell" is not "secure".

### fail2ban — active, and the only thing in front of sshd today

Undocumented here until now, and load-bearing:

| | |
|---|---|
| unit | `fail2ban.service`, **active since 2026-07-28 11:04:12 CEST** |
| ban action | `nftables` — `/etc/fail2ban/jail.d/defaults-debian.conf:2` |
| sshd jail | `enabled = true`, `backend = systemd`, same file |

The `banaction = nftables` line in `jail.d/` **overrides** `jail.conf:208`'s
stock `iptables-multiport`, because `jail.d/` is read after `jail.conf`. Quoting
the stock value is a mistake worth avoiding — check `jail.d/` first.

```bash
sudo fail2ban-client status          # jails
sudo fail2ban-client status sshd     # bans on the ssh jail
```

Reading jail state needs root: the client talks to
`/var/run/fail2ban/fail2ban.sock`, which is root-only.

**fail2ban is not a substitute for key-only authentication.** It rate-limits
guessing; it does not stop a correct guess, a leaked password, or a credential
reused from elsewhere. Once `apply.sh` has run it becomes defence in depth
rather than the only defence.

## Firewall — the commands **you** need to run as root

I cannot run these; they need sudo. Nothing below is required for the devnet to
*work* — all five nodes talk to each other over loopback, so the network
finalizes with every port closed. These only matter if you want peers or clients
from outside this box.

**ROUND15 widened the p2p range from `30333:30335` to `30333:30337`** (dave on
30336, eve on 30337). If you had already applied the ROUND10 rule, it does not
cover the two new nodes — replace it rather than adding a second overlapping
rule. Nothing breaks in the meantime: the new nodes peer over loopback either
way, and the range only matters for external peers.

**Current state: there IS host packet filtering running. The previous sentence
here said the opposite, and it was wrong.**

`ufw.service` reads `inactive` and has never gone active this boot
(`ActiveEnterTimestamp` is empty), which is what the old sentence was inferred
from. That inference does not hold: `ufw enable` installs its rules through
`ufw-init` without the unit ever entering the active state, so an inactive unit
says nothing about whether rules are loaded. What settles it is
`/proc/modules`, which is world-readable:

```bash
grep -cE '^(nf_|nft_|xt_|x_tables|ip6?table)' /proc/modules      # 20
grep -oE '^(nf_tables|nft_compat|xt_addrtype|xt_conntrack|xt_limit|xt_LOG|xt_recent)' /proc/modules
```

Twenty netfilter modules are loaded, including `xt_addrtype`, `xt_recent`,
`xt_LOG`, `xt_limit` and `xt_conntrack` — the set `ufw`'s own `before.rules`
pulls in, and not ones `fail2ban`'s nftables action would explain by itself.
Rules are in the kernel.

Their *contents* cannot be read without root, so this is where the evidence
stops:

```
$ /usr/sbin/nft list ruleset
Operation not permitted (you must be root)
$ /usr/sbin/iptables -L -n
Permission denied (you must be root)
$ /usr/sbin/ufw status
ERROR: You need to be root to run this script
```

Run those three as root to find out what the policy actually is before changing
it. **Do not assume the box is unfiltered and start from `ufw enable`** — that
was the mistake this paragraph used to invite, and a default-deny applied on
top of an unknown existing policy is how a remote host stops answering.

> [!WARNING]
> `ufw enable` applies a **default-deny on incoming** policy. If you enable it
> without allowing SSH first, you will lock yourself out of this VPS. SSH is on
> port 22. Run the SSH rule first, in the order below.

### Open p2p so external validators / full nodes can join

```bash
sudo ufw allow 22/tcp                comment 'ssh — MUST be first'
sudo ufw allow 30333:30337/tcp       comment 'scalar commons devnet p2p (5 nodes)'
sudo ufw enable
sudo ufw status verbose
```

Replacing the old 3-node rule, if it is already in place:

```bash
sudo ufw status numbered                          # find the 30333:30335 rule
sudo ufw delete <number>
sudo ufw allow 30333:30337/tcp       comment 'scalar commons devnet p2p (5 nodes)'
```

The prometheus ports (9615–9619) are deliberately **not** opened. Nothing
scrapes them yet, and an unauthenticated metrics endpoint is not something to
put on a public IP by default.

### Public RPC (optional — read the next section first)

```bash
sudo ufw allow 9944/tcp              comment 'scalar commons RPC (public)'
```

Prefer restricting it to your own address rather than the whole internet:

```bash
sudo ufw allow from <YOUR.IP.ADDR> to any port 9944 proto tcp comment 'scalar RPC'
```

To undo any of these:

```bash
sudo ufw status numbered
sudo ufw delete <number>
```

---

## Public RPC — deliberately not enabled yet

**alice's RPC binds to `127.0.0.1:9944`, not `0.0.0.0`.** The unit does *not*
pass `--rpc-external`. This is intentional and is a deviation from the literal
flag list in the ROUND10 brief, which asked for `--rpc-external` *and* for the
endpoint to be on `127.0.0.1` "not by binding to 0.0.0.0 yet" — those two are
mutually exclusive. `--rpc-external`'s own help text reads "Listen to all RPC
interfaces (default: local)".

I resolved it toward the stated intent (localhost) because ufw is currently
inactive: binding `0.0.0.0` right now would put a JSON-RPC endpoint on a public
IP with **no packet filter in front of it at all**. `--rpc-methods safe` is set
either way, but "safe" still exposes chain state, tx submission, and enough
surface that it should not go up unfiltered by accident.

**You do not need to open the port to use the RPC remotely.** An SSH tunnel is
the better answer and needs no firewall change and no unit edit:

```bash
# from your laptop
ssh -L 9944:127.0.0.1:9944 dev@152.53.113.104
# then point any client at ws://127.0.0.1:9944 or http://127.0.0.1:9944
# e.g. https://polkadot.js.org/apps/?rpc=ws%3A%2F%2F127.0.0.1%3A9944
```

If you genuinely want it bound publicly, do it in this order:

1. Put the firewall up first (`sudo ufw allow 22/tcp && sudo ufw enable`), and
   ideally restrict 9944 to your own IP as shown above.
2. Add `--rpc-external \` to `ExecStart` in
   `deploy/systemd/scalar-alice.service` (keep `--rpc-methods safe`).
3. Reinstall and restart:
   ```bash
   ./deploy/install.sh
   systemctl --user restart scalar-alice
   ```
4. Verify what it is actually bound to:
   ```bash
   ss -ltnp | grep 9944
   ```

For anything beyond a testnet, terminate TLS and rate-limit at a reverse proxy
rather than exposing the node's own port.

---

## Snapshots

```bash
./deploy/snapshot.sh            # alice (default)
./deploy/snapshot.sh charlie
```

Writes `~/scalar-snapshots/<node>-<UTC timestamp>.tar.zst`.

The script **stops the node, copies, and starts it again**. A tar of a running
node's database can be torn — the DB holds an exclusive lock and buffers writes
in memory — so a hot copy is not a supportable backup.

Since ROUND15 this is no longer a maintenance window: with five authorities the
remaining four keep finalizing while one node is stopped for the copy. **Do not
snapshot two nodes at once** — three of five is below the threshold of 4 and
finality stalls until one comes back.

Restore:

```bash
systemctl --user stop scalar-alice
rm -rf ~/scalar-testnet/alice
tar -C ~/scalar-testnet -xf ~/scalar-snapshots/alice-<stamp>.tar.zst
systemctl --user start scalar-alice
```

---

## Fault tolerance — one validator down is survivable, two is not

**This 5-validator set tolerates exactly one failure for finality.** GRANDPA's
supermajority threshold for `n` authorities is `n - (n-1)/3` voters (integer
division):

| `n` | threshold | tolerated down |                                          |
|-----|-----------|----------------|------------------------------------------|
| 3   | 3         | **0**          | what ROUND10 shipped — any stop froze it |
| 4   | 3         | 1              |                                          |
| 5   | 4         | 1              | **current**                              |
| 7   | 5         | 2              | next step up                             |

Be precise about what the fifth authority buys: **nothing for fault tolerance.**
Four and five both survive exactly one failure, because the threshold rises with
the set size. Five was chosen for slot spread and an odd set size. If the
requirement is surviving two simultaneous failures, the answer is seven, not
five.

### Evidence — charlie stopped for 93s, all five nodes sampled

Verbatim from `./deploy/finality-check.sh`. The column that matters is `final`:

```
--- BASELINE: all 5 up ---
[17:20:25Z]  alice best=   11 final=    8  bob best=   11 final=    8  charlie best=   11 final=    8  dave best=   11 final=    8  eve best=   11 final=    8
[17:20:37Z]  alice best=   13 final=   11  bob best=   13 final=   11  charlie best=   13 final=   11  dave best=   13 final=   11  eve best=   13 final=   11

--- STOPPING charlie at 17:20:37Z (4 of 5 authorities remain) ---
--- charlie is-active: inactive ---

[17:20:44Z]  alice best=   14 final=   12  bob best=   14 final=   12  charlie DOWN  dave best=   14 final=   12  eve best=   14 final=   12
[17:20:56Z]  alice best=   16 final=   14  bob best=   16 final=   14  charlie DOWN  dave best=   16 final=   14  eve best=   16 final=   14
[17:21:14Z]  alice best=   19 final=   17  bob best=   19 final=   17  charlie DOWN  dave best=   19 final=   17  eve best=   19 final=   17
[17:21:39Z]  alice best=   22 final=   20  bob best=   22 final=   20  charlie DOWN  dave best=   22 final=   20  eve best=   22 final=   20
[17:22:04Z]  alice best=   25 final=   23  bob best=   25 final=   23  charlie DOWN  dave best=   25 final=   23  eve best=   25 final=   23
[17:22:10Z]  alice best=   26 final=   24  bob best=   26 final=   24  charlie DOWN  dave best=   26 final=   24  eve best=   26 final=   24

--- RESTARTING charlie at 17:22:10Z ---

[17:22:16Z]  alice best=   27 final=   25  bob best=   27 final=   25  charlie best=   27 final=   25  dave best=   27 final=   25  eve best=   27 final=   25
```

**Finalized height advanced 11 → 24 across the 93-second outage** — 13 blocks
finalized with a validator down, tracking `best` two behind throughout. Compare
ROUND10's 3-validator run, where `finalized` sat frozen at 46 for the entire
outage while `best` climbed away from it.

The same window from alice's own log (`journalctl --user -u scalar-alice`),
which also shows her peer count dropping 4 → 3 as charlie leaves:

```
19:20:33 💤 Idle (4 peers), best: #12 (0xece5…381e), finalized #10 (0xace6…e7f6)
19:20:38 💤 Idle (3 peers), best: #13 (0x5b03…5fff), finalized #11 (0xd123…b272)
19:20:43 💤 Idle (3 peers), best: #14 (0xdeab…d7f8), finalized #12 (0xece5…381e)
19:21:03 💤 Idle (3 peers), best: #17 (0x2756…4455), finalized #15 (0x4891…846a)
19:21:33 💤 Idle (3 peers), best: #21 (0x4b04…d6aa), finalized #19 (0xbd2d…d8c6)
19:22:03 💤 Idle (3 peers), best: #25 (0xc30c…defe), finalized #23 (0x35e3…36ef)
19:22:08 💤 Idle (3 peers), best: #26 (0xb82f…65cc), finalized #24 (0xbc0e…62c2)
```

Rejoin, from charlie's log — back in consensus and authoring within 2 seconds,
no manual intervention:

```
19:20:37 Stopping scalar-charlie.service - Scalar Commons devnet validator — charlie...
19:22:10 Starting scalar-charlie.service - Scalar Commons devnet validator — charlie...
19:22:11 👶 Starting BABE Authorship worker
19:22:12 🙌 Starting consensus session on top of parent 0xb82f…65cc (#26)
19:22:12 🏆 Imported #27 (0xb82f…65cc → 0xd943…efca)
19:22:16 💤 Idle (4 peers), best: #27 (0xd943…efca), finalized #25 (0xc30c…defe)
```

### Negative control — two down does stall, as predicted

Three of five is below the threshold of 4, so finality must stop. It does; see
ROUND15.md for the verbatim run. This matters: without it, "finality survived
one node down" could just mean nothing was ever being tested.

**Operationally:** restart or snapshot one node freely. Never two at once.

---

## Resetting the chain

```bash
./deploy/reset-chain.sh     # prompts for confirmation
```

Needed after regenerating the chainspec: a new genesis hash is a new chain and
the existing databases are not compatible with it. Node keys are preserved, so
alice's bootnode multiaddr does not change.

---

## What mainnet needs that this testnet skips

This devnet is **not a template for mainnet.** It is deliberately insecure in
ways that are fine for a local testnet and disqualifying for anything holding
value:

- **Session keys are the well-known `//Alice`, `//Bob`, `//Charlie`, `//Dave`,
  `//Eve` seeds.** Every one of those private keys is public knowledge and in
  every Substrate test fixture on earth. Anyone can author and sign as these
  validators. Mainnet needs keys generated per validator (`scalar-node key
  generate-session-keys`), held in each validator's own keystore, and registered
  on chain via `session.setKeys` — never derived from a seed in a repo.
- **Node keys are `0x00…01` through `0x00…05`.** Real ones come from
  `scalar-node key generate-node-key --file <path>`, are 0600, and are backed up
  — losing one changes a bootnode's peer id.
- **`sudo` is a single Alice key** (`chain_spec.rs`: "replaced by multisig in
  staging/mainnet"). Mainnet needs the multisig, and the documented day-14
  referendum handoff that removes sudo entirely.
- **One host — and this is the big one after ROUND15.** Five validators sharing
  a box, a kernel, a disk, a NIC, a power supply and one `systemd --user`
  manager is **one fault domain, not five.** ROUND15 proved the chain survives
  one *validator process* stopping. It proved nothing whatsoever about surviving
  the loss of this machine, because every authority dies with it — and at that
  point the surviving voter count is zero, not four.

  Read the fault-tolerance result for exactly what it is: the GRANDPA authority
  set is now large enough that a single validator failure is not a finality
  outage. That is a real and necessary property, and it is the *consensus*
  half of the problem. The *infrastructure* half is untouched. What it takes:

  - five (ideally seven) validators on **separate hosts**, ideally separate
    providers and regions, so a host, rack, provider, or region failure takes
    at most one authority with it;
  - run by **separate operators** with separate credentials — five nodes one
    person can `systemctl --user stop` are not five independent failure
    probabilities, whatever the authority count says. The same applies to a
    single bad deploy: one operator pushing one broken binary to all five is a
    correlated failure the authority count does not model;
  - real p2p addressing between them (public multiaddrs, several bootnodes,
    not `/ip4/127.0.0.1`), and no single bootnode whose loss partitions the
    network;
  - independent key custody per operator, per the session-key point above.
- **Five authorities tolerate exactly one failure, not two** — the threshold
  rises to 4 of 5 with the set size. Four and five are equivalent here; **seven**
  is the next size that survives two simultaneous failures. Mainnet should size
  the set from the failure count it intends to survive, not from a round number.
- **SS58 prefix is 42**, the generic Substrate default. `chain_spec.rs` already
  flags this: `// MAINNET BLOCKER: register unique SS58 prefix`.
- **`ChainType::Local`** and a chainspec with no telemetry endpoints and no
  public bootnodes.
- **No TLS, no reverse proxy, no rate limiting, no monitoring/alerting.**
  Prometheus is exported on 127.0.0.1 but nothing scrapes it and nothing pages
  anyone when finality stalls.
- **No key backup, no disaster recovery, no runbook** beyond this file.
