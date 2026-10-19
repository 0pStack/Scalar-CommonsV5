# Forkless runtime upgrade

How to bump the runtime on the live devnet without restarting a node, and how to
get back if it goes wrong.

ENDGOAL §3.1 requires "a forkless runtime upgrade rehearsed — `spec_version`
bumped and applied on a live network without restarting nodes", and calls a
chain that cannot upgrade itself "not an L1". Before spec 305 it had never
happened here: the on-chain `:code` at the finalized head was **byte-identical
to genesis**, and all five earlier bumps (300 → 304) were compiled into *fresh
geneses* before this chain started, not applied to it. `System::LastRuntimeUpgrade`
cannot tell those two cases apart — it reads `compact(304) ++ "scalar-commons"`
either way — so the `:code` comparison is what settles it. See TESTNETAUDIT.md
§6 I-20 and issue #136.

---

## Before you start

| | |
|---|---|
| root key | the rotated operator key, `~/.config/scalar-commons/sudo.key` (0600). **Not `//Alice`** — see #119 |
| endpoint | `ws://127.0.0.1:9944` (alice) |
| all five RPC | 9944 alice, 9945 bob, 9946 charlie, 9947 dave, 9948 eve |
| era length | six hours |

`system.setCode` is a root call whose weight is the entire block. It goes
through `sudo.sudo`, which is why it lands at all.

---

## 1. Build and identify the blob

```bash
git checkout master && git pull
cargo build --release
```

The runtime lands at:

```
target/release/wbuild/scalar-commons-runtime/scalar_commons_runtime.compact.compressed.wasm
```

Record its hash — this is the identity you will check against the chain
afterwards, and the thing you cite in the issue:

```bash
b2sum -l 256 target/release/wbuild/scalar-commons-runtime/scalar_commons_runtime.compact.compressed.wasm
```

**Confirm the blob's embedded `spec_version` before you submit it.** A blob whose
version does not differ from the running one is rejected by the node, and a blob
with the *wrong* version is worse — it applies:

```bash
node scripts/read-wasm-version.mjs \
  target/release/wbuild/scalar-commons-runtime/scalar_commons_runtime.compact.compressed.wasm \
  --expect 305
```

That reads the `runtime_version` custom section out of the wasm itself, not out
of `lib.rs`, so it catches a stale build directory or a blob copied from the
wrong place — cases where the source says 305 and the bytes say 304. Either
form of the blob works; the compressed one is unwrapped automatically. With
`--expect` it exits non-zero on a mismatch, so it can be an abort condition in a
script. **Abort if it is not the version you intend.**

---

## 2. Take a rollback point BEFORE submitting

Two artefacts, and the first is the one that actually matters.

**a. The current on-chain runtime.** This is the exact blob the chain is running
right now, and it is what a rollback re-applies. Pull it straight out of state:

```bash
TS=$(date -u +%Y%m%dT%H%M%SZ); mkdir -p ~/upgrade-backup/$TS
curl -s -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"state_getStorage","params":["0x3a636f6465"]}' \
  http://127.0.0.1:9944 \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"])' \
  > ~/upgrade-backup/$TS/code-before.json
python3 -c "
import json
h = json.load(open('$HOME/upgrade-backup/$TS/code-before.json'))['result']
open('$HOME/upgrade-backup/$TS/code-before.wasm','wb').write(bytes.fromhex(h[2:]))
"
```

(`xxd` is not installed on this host; the python one-liner does the same job.)

Confirm the artefact is what you think it is before you rely on it:

```bash
node scripts/read-wasm-version.mjs ~/upgrade-backup/$TS/code-before.wasm
```

It should report the version you are upgrading *from*. The on-chain blob is
zstd-compressed; the reader unwraps it.

**b. The head, the chainspec, and the new blob**, so the state of the chain at
the moment of the upgrade is recorded:

```bash
curl -s -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"chain_getFinalizedHead","params":[]}' \
  http://127.0.0.1:9944 | tee ~/upgrade-backup/$TS/finalized-head.json
cp deploy/scalar-local-raw.json ~/upgrade-backup/$TS/
cp target/release/wbuild/*/scalar_commons_runtime.compact.compressed.wasm ~/upgrade-backup/$TS/
```

A **database** snapshot (`./deploy/snapshot.sh <node>`) is optional here and is
*not* the rollback path for a runtime upgrade — see ROLLBACK below for why. If
you take one, take it on a node other than alice, and note that it stops and
starts that node, which will reset its uptime and muddy the "nothing restarted"
evidence.

---

## 3. Dry run

```bash
node scripts/apply-upgrade.mjs \
  target/release/wbuild/scalar-commons-runtime/scalar_commons_runtime.compact.compressed.wasm \
  --dry-run
```

It prints the signer, the on-chain `Sudo::Key`, whether they match, both call
hashes, and the wasm hash. It submits nothing.

**Abort if `signer is root` is not `YES`.** The script refuses anyway, but check
it yourself: submitting with the wrong key wastes a block and tells an observer
that the root key is not where you think it is.

---

## 4. Apply

```bash
node scripts/apply-upgrade.mjs \
  target/release/wbuild/scalar-commons-runtime/scalar_commons_runtime.compact.compressed.wasm \
  --expect-spec 305
```

The script submits `sudo.sudo(system.setCode(<wasm>))`, waits for finalization,
checks the `sudo.Sudid` event actually reports `Ok` (a sudo call can finalize
while the call it wrapped failed), then polls `state_getRuntimeVersion` on all
five ports until each reports the new version or 20 blocks pass. It exits
non-zero if any node lags.

Expect `system.CodeUpdated` in the event list.

---

## 5. Verify

**a. Every node reports the new version.**

```bash
for p in 9944 9945 9946 9947 9948; do
  printf '%s ' $p
  curl -s -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"state_getRuntimeVersion","params":[]}' \
    http://127.0.0.1:$p | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["specVersion"])'
done
```

**b. Nothing restarted.** This is the whole point of "forkless". Compare against
the timestamps you took before submitting:

```bash
for n in alice bob charlie dave eve; do
  printf '%-8s ' $n
  systemctl --user show scalar-$n -p ActiveEnterTimestamp -p NRestarts --value | tr '\n' ' '
  echo
done
```

`ActiveEnterTimestamp` must be unchanged and `NRestarts` must not have gone up.

**c. Blocks still produce and finalize.** Two samples, twelve seconds apart —
both `best` and `finalized` must advance:

```bash
./deploy/finality-check.sh
```

**d. The on-chain `:code` is no longer genesis.** This is the assertion that
distinguishes a real upgrade from a fresh genesis, and it is the one the audit
found had never been true:

```bash
GEN=$(curl -s -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"chain_getBlockHash","params":[0]}' http://127.0.0.1:9944 | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"])')
curl -s -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"state_getStorageHash\",\"params\":[\"0x3a636f6465\"]}" http://127.0.0.1:9944
curl -s -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"state_getStorageHash\",\"params\":[\"0x3a636f6465\",\"$GEN\"]}" http://127.0.0.1:9944
```

The two hashes must now **differ**.

---

## ROLLBACK

**A runtime upgrade is rolled back by applying the previous runtime, not by
restoring a database.** Understand which of these you are in before you touch
anything.

### If the new runtime is bad but the chain is still producing blocks

This is the normal case and it is not an emergency. Re-apply the blob you saved
in step 2a:

```bash
node scripts/apply-upgrade.mjs ~/upgrade-backup/<TS>/code-before.wasm --expect-spec 304
```

Caveats, both important:

- **`spec_version` goes backwards.** Substrate permits this — the node compares
  versions for equality when deciding whether to swap code, not ordering — but
  anything that cached "we are on 305" (an indexer, an explorer, a client with a
  pinned metadata version) needs to be told. Restart the indexer and explorer
  after a downgrade.
- **A downgrade does not undo state changes the new runtime made.** For spec 305
  specifically there are none — `EraPayout` is a Config type, not storage, and
  nothing is migrated — so the downgrade is clean. That will not be true of an
  upgrade that adds or reshapes storage. **An upgrade carrying a migration is
  not rollback-safe by this route** and needs a forward fix instead.

### If the chain has stalled — no new finalized blocks

`set_code` cannot help you: submitting an extrinsic requires block production.
Recover the node, not the runtime.

1. Check whether it is one node or all five: `./deploy/finality-check.sh`, then
   `systemctl --user status scalar-*`. Fewer than four of five authorities and
   GRANDPA cannot reach its threshold, so finality stops while block production
   may continue.
2. If a node is down, start it. Finality resumes on its own once four are up.
3. Only if the chain is genuinely unrecoverable, restore from a database
   snapshot (`~/upgrade-backup/<TS>/`, plus a `./deploy/snapshot.sh` archive if
   you took one) and note that **restoring a database rewinds state** — every
   block since the snapshot is gone. On a devnet that is acceptable; treat it as
   the last resort, not the first.

### What to keep

Keep `~/upgrade-backup/<TS>/` until the next upgrade has been applied and
verified. `code-before.wasm` is small and it is the only copy of the previous
runtime that does not require a rebuild at the exact previous commit.

---

## Notes for spec 305 specifically

Spec 305 sets `type EraPayout = ()`, ending staking inflation (issue #120,
TESTNETAUDIT.md §6 I-2). Two things to watch after applying, neither of which is
a failure of the upgrade:

- **The next era boundary must book a zero payout.** Watch for a
  `staking.EraPaid` event with a non-zero `validator_payout`; there must not be
  one. Eras are six hours, so this may be hours after the upgrade.
- **Already-booked rewards are unaffected and still claimable.**
  `ErasValidatorReward` holds 47 entries summing ~14 623 530.33 CMN, and
  `payout_stakers` is permissionless. Spec 305 stops new bookings; it does not
  and cannot cancel old ones. Seeing that mint later is expected behaviour, not
  a regression.
