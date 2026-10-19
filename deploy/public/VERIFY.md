# Public exposure — verification

Run after [INSTALL.md](INSTALL.md) step 7. Replace `<DOMAIN>` with the real
domain. Every check states its pass condition; a check that does not clearly
pass is a failure — do not interpret a partial result as success.

Tooling:

```bash
sudo apt install -y curl
npm i -g wscat        # or: sudo apt install -y websocat
```

---

## (a) The wss endpoint answers `chain_getHeader`

```bash
wscat -c wss://rpc.<DOMAIN> \
  -x '{"jsonrpc":"2.0","id":1,"method":"chain_getHeader","params":[]}'
```

**Pass:** a JSON object with a `result` containing `parentHash`, `number`,
`stateRoot`. Shape, taken from the live node on 2026-09-02:

```json
{"jsonrpc":"2.0","id":1,"result":{
  "parentHash":"0x9ac0428566c64264f672962ba9ade65011da5c0b43c025815e8da0276bc0df0b",
  "number":"0x69c45",
  "stateRoot":"0xe882009f9b8bb05eb7f0e50f836b9b96ea6da7567367ce0be5fbd650a1982f22",
  "extrinsicsRoot":"0x92fe0062f9c378996c99b3eee046de58a609f1240a19b87298aa30e7783716d7",
  "digest":{"logs":["0x06424142453402000000000c14c41100000000", "..."]}}}
```

`number` is a moving head — `0x69c45` was 433,221 at capture. It must be
**greater** than that and must advance between two runs a few seconds apart:

```bash
for i in 1 2; do
  wscat -c wss://rpc.<DOMAIN> \
    -x '{"jsonrpc":"2.0","id":1,"method":"chain_getHeader","params":[]}' \
    | grep -o '"number":"[^"]*"'
  sleep 8
done
```

**Pass:** the second number is higher. A static head means you are talking to a
stalled node, not a working endpoint.

TLS is genuinely terminated (not a self-signed placeholder):

```bash
curl -sI https://rpc.<DOMAIN> | head -1
echo | openssl s_client -connect rpc.<DOMAIN>:443 -servername rpc.<DOMAIN> 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

**Pass:** issuer is Let's Encrypt, `notAfter` is in the future, and the subject
/ SAN set covers `rpc.<DOMAIN>`.

---

## (b) `author_rotateKeys` and `author_insertKey` are REFUSED

**This is the check that matters.** Both must be refused *through the proxy*,
over wss — the path a real attacker uses.

```bash
wscat -c wss://rpc.<DOMAIN> \
  -x '{"jsonrpc":"2.0","id":1,"method":"author_rotateKeys","params":[]}'
```

```bash
wscat -c wss://rpc.<DOMAIN> \
  -x '{"jsonrpc":"2.0","id":1,"method":"author_insertKey","params":["aura","//Alice","0x00"]}'
```

**Pass — exactly this shape, captured from the live node on 2026-09-02:**

```json
{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"RPC call is unsafe to be called externally"}}
```

Pass condition, stated precisely:

- the response has an **`error`** member, and
- it has **no `result`** member, and
- `error.code` is **`-32601`**.

**Fail — treat as an incident, revoke exposure immediately:** any response
carrying a `result`. For `author_rotateKeys` a `result` is a freshly generated
session key, which means the endpoint is minting session keys for anonymous
callers.

### Where the refusal comes from

`--rpc-methods safe` on the node (`deploy/systemd/scalar-alice.service`).
**nginx is not filtering these method names and cannot** — it cannot see inside
WebSocket frames, and `$request_body` is unavailable in its rewrite phase. The
proxy contributes TLS and rate limiting, nothing more.

So the check is only meaningful while safe mode is on. Confirm the flag is
actually live on the running process, not merely present in the unit file:

```bash
systemctl --user show scalar-alice.service -p ExecStart | grep -o 'rpc-methods safe'
ps -ef | grep '[s]calar-node' | grep -c 'rpc-methods safe'   # expect 5
```

**Pass:** the flag appears for every running validator. If a unit file was
edited without a `daemon-reload` + restart, the file and the process disagree —
the process is what serves traffic.

Finally, confirm nothing bypasses the proxy:

```bash
nmap -Pn -p 9944-9948 <DOMAIN>       # run from a DIFFERENT host
```

**Pass:** all five `filtered` or `closed`. Any `open` means ufw is wrong — fix
before continuing.

---

## (c) Rate limiting triggers

Config as installed: rpc 10 r/s `burst=20` and **20** concurrent connections per
IP; faucet **10 r/m** `burst=5` on its own `faucet_req` zone; web/api 20 r/s
`burst=40`.

```bash
for i in $(seq 1 60); do
  curl -s -o /dev/null -w '%{http_code}\n' https://rpc.<DOMAIN> &
done | sort | uniq -c
```

**Pass:** a mix of non-429 codes and a clear block of **`429`**. All-200 means
`limit_req` is not applying — check the zone is defined and the vhost is the one
actually serving.

Concurrent-connection cap (limit is 20, so open 26):

Open them **slowly** — about 3/s. A burst of 26 trips `limit_req` first and you
learn nothing about `limit_conn`; staggering below 10 r/s isolates it.

```bash
for i in $(seq 1 26); do
  wscat -c wss://rpc.<DOMAIN> --wait 30 &
  sleep 0.3
done
wait
```

**Pass:** exactly the first 20 upgrade (101) and the rest are refused with 429.
Measured 2026-09-09: `#1–#20 → 101 Switching Protocols`, `#21–#26 → 429`.

The faucet's own bucket, which is 60× tighter than the rpc one because it
dispenses balance:

```bash
for i in $(seq 1 15); do
  curl -s -o /dev/null -w '%{http_code}\n' https://faucet.<DOMAIN>/health &
done | sort | uniq -c
```

**Pass:** 6 × `200` (burst 5 plus one refill) and 9 × `429`. All-200 means the
faucet vhost is on the wrong zone — check it uses `faucet_req`, not `rpc_req`.

Confirm from the log side:

```bash
sudo grep -c 'limiting requests' /var/log/nginx/scalar-rpc.error.log
sudo tail -5 /var/log/nginx/scalar-rpc.error.log
```

**Pass:** count is non-zero and the entries name `zone=rpc_req` or
`zone=rpc_conn`.

> Scope, so the result is not over-read: `limit_req` on the wss vhost bounds
> **connection attempts**, not messages inside an already-open socket. One
> connection sending thousands of JSON-RPC calls is bounded by the node, not by
> nginx. Do not record this check as "RPC call rate is limited".

---

## (d) The four product URLs serve

```bash
curl -sI https://<DOMAIN>/           | head -1   # landing
curl -sI https://<DOMAIN>/docs/      | head -1   # docs
curl -sI https://explorer.<DOMAIN>/  | head -1   # 127.0.0.1:8081
curl -s -o /dev/null -w '%{http_code}\n' https://faucet.<DOMAIN>/  # 127.0.0.1:8082
curl -s -o /dev/null -w '%{http_code}\n' https://api.<DOMAIN>/     # 127.0.0.1:8080
```

`api.` and `faucet.` are probed with **GET, not `-sI`**: both services answer
`GET` only, so a HEAD gets `405`/`404` from every path they have, `/health` and
`/v1/status` included. That is not a proxy fault and never was.

**Pass:** all five return `200`. `api.` and `faucet.` answer `/` with a one-line
JSON index naming `/v1/status` and `/health` respectively; a **`404` at `/`**
means the deployed build predates issue #156, and the endpoint checks below are
what prove those two services actually work either way. `502`
means the loopback service behind that vhost is down — an issue #102 problem,
not an nginx one, and note the indexer takes ~3.5 minutes after a restart to
bind :8080 (it serves only once its backfill completes), during which `api.`
502s legitimately.

`404` on `/docs/` would mean the docs were published without
`DOCS_BASE=/docs/`; rebuild with `deploy/public/redeploy-site.sh`, which fails
rather than publishing such a build.

Landing serves real content, not an empty directory index:

```bash
curl -s https://<DOMAIN>/ | grep -o '<title>[^<]*</title>'
curl -sI https://<DOMAIN>/styles.css | head -1
```

Docs assets resolve under the `/docs/` prefix — this is what the missing `base`
breaks:

```bash
curl -s https://<DOMAIN>/docs/ | grep -oE '(src|href)="/[^"]*"' | head
```

**Pass:** asset paths begin with `/docs/assets/...`. If they begin with
`/assets/...`, the docs were built without `base: '/docs/'` and the site will
render unstyled — go back to INSTALL.md step 5.

API returns real indexer JSON. **The indexer has no `/health` route** — that
path 404s with a list of the 25 endpoints. The status endpoint is:

```bash
curl -s https://api.<DOMAIN>/v1/status
```

**Pass:** JSON carrying `chain.specVersion`, `chain.bestBlock` and
`indexer.syncedHeight`, with `syncedHeight` within a few blocks of `bestBlock`.
A `syncedHeight` that does not advance between two runs means the indexer's
websocket to the node has dropped — it stays "running" and returns 500 on every
chain-backed route until restarted.

---

## HTTP redirect and security headers

```bash
curl -sI http://<DOMAIN>/ | head -3
```

**Pass:** `301` to `https://<DOMAIN>/`.

```bash
curl -sI https://<DOMAIN>/ | grep -i 'strict-transport\|x-content-type\|x-frame'
```

**Pass:** `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, and
`X-Frame-Options` all present.

---

## (f) A caller cannot forge its own IP to the faucet

The faucet's per-IP drip limit is only worth anything if the IP it reads is one
the caller cannot choose. Two halves, both required:

1. the vhost sets `proxy_set_header X-Forwarded-For $remote_addr;` — **overwrite**,
   never nginx's stock appending `$proxy_add_x_forwarded_for`; and
2. `faucet/src/server.ts` reads the **right-most** entry, so even an appending
   proxy could not be talked into trusting a caller-supplied hop.

Confirm half 1 is present on every faucet location:

```bash
sudo awk '/server_name faucet\./,/^}/' /etc/nginx/sites-available/scalar-commons.conf | grep -c 'X-Forwarded-For   \$remote_addr'
sudo grep -c 'proxy_add_x_forwarded_for' /etc/nginx/sites-available/scalar-commons.conf
```

**Pass:** the first count equals the number of `location` blocks on the faucet
vhost (one, as shipped); the second is `0` outside comments.

Then confirm it end to end. **The faucet logs no client IP**, so a forged
request cannot be checked from its journal — point a copy of the config at any
echo server that prints the headers it receives, and send:

```bash
curl -s https://faucet.<DOMAIN>/health -H 'X-Forwarded-For: 1.2.3.4'
curl -s https://faucet.<DOMAIN>/health -H 'X-Forwarded-For: 1.2.3.4, 9.9.9.9'
```

**Pass:** the upstream receives `X-Forwarded-For: <your real IP>` in both cases.
**Fail:** it receives `1.2.3.4`, or a list with `1.2.3.4` in it — every forged
value is a fresh rate-limit bucket and the drip limit is decorative.
Measured 2026-09-09: both forgeries arrived at the upstream as the real peer.

> Until the faucet logs the IP it charged (see the "products" issue), this
> check cannot be run against the live faucet — only against an echo upstream
> with the same config. Do not record it as verified end to end on the real
> service.

---

## (e) `Sudo::Key` is not the published `//Alice` dev seed

**This is the single decisive launch blocker and it is not optional.**
`runtime/src/lib.rs` exempts `RuntimeCall::Sudo(_)` from SafeMode filtering, and
`author_submitExtrinsic` is classified *safe* — so `--rpc-methods safe`, which
check (b) confirms, does **not** withhold it. The moment `wss://rpc.<DOMAIN>` is
reachable, whoever holds the root key can `sudo.sudo(system.set_code)`,
`balances.force_transfer`, `system.kill_storage` or `sudo.set_key`. TLS, nginx
rate limits and the firewall do not mitigate it at all.

`//Alice`'s public key is `0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d`
and its seed is in every Substrate tutorial.

```bash
curl -s -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"state_getStorage","params":["0x5c0d1176a568c1f92944340dbfed9e9c530ebca703c85910e7164cb7d1c9e47b"]}' \
  http://127.0.0.1:9944 | python3 -c 'import sys,json;print(json.load(sys.stdin).get("result"))'
```

**Pass:** anything other than
`0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d`.
**Fail:** that value, or `None` when you did not intend to remove sudo.

One line, exit 0 = pass:

```sh
test "$(curl -s -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"state_getStorage","params":["0x5c0d1176a568c1f92944340dbfed9e9c530ebca703c85910e7164cb7d1c9e47b"]}' http://127.0.0.1:9944 | python3 -c 'import sys,json;print(json.load(sys.stdin).get("result"))')" != "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d"
```

### Holding root is not the same as being able to use it

A root key with no balance cannot sign anything. `sudo.sudo` dispatches
`paysFee: No`, but that is *post-dispatch* — `ChargeTransactionPayment` runs in
`validate_transaction` first and still requires the signer to cover the
estimated fee, so a zero-balance root account is rejected at submission with
`1010: Inability to pay some fees`. That is not hypothetical: it is exactly what
happened on the first attempt to apply the spec-305 runtime upgrade, after the
key had been rotated and never funded (#119, #136).

```bash
# substitute the address the check above returned
curl -s -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"state_getRuntimeVersion","params":[]}' \
  http://127.0.0.1:9944 | python3 -c 'import sys,json;print("specVersion", json.load(sys.stdin)["result"]["specVersion"])'
```

**Pass:** the root account's free balance comfortably exceeds the existential
deposit plus a transaction fee. `scripts/apply-upgrade.mjs --dry-run` prints
exactly this comparison and refuses if it fails.

**Note on the published docs.** `docs/reference/rpc.md` used to carry the table
row `| Sudo | 16 | Removed by referendum after launch |`, which was false — the
key existed and nothing in the runtime scheduled its removal. It now reads
"held by operator; removal scheduled for mainnet". If you change the sudo
arrangement, change that row in the same commit: the one page a careful stranger
consults about root access must not describe a state the chain is not in.

---

## Result

Exposure is correct only when (a), (b), (c), (d), (e) and (f) all pass **and**
the `nmap` sweep in (b) shows 9944–9948 unreachable from off-host. If any check
fails, roll back per INSTALL.md before debugging in place.

(e) is the one that cannot be deferred: (a)–(d) failing means the deployment is
broken, but (e) failing means anyone on the internet owns the chain.

### Last full run

scalarnet.io, 2026-09-09. All checks pass; the complete PASS/FAIL table with raw
evidence is in `PUBLIC-LAUNCH.md` at the repo root. The off-host sweep, which
cannot be run from the server itself, was confirmed from an external host at
14:40 CEST: **9944/9945/9948/8080/8082 unreachable, port 80 answers, ws upgrade
101, `author_rotateKeys` refused.**
