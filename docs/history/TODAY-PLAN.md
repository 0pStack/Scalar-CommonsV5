# TODAY-PLAN — 2026-09-03

Unblocking the factory, landing finished work, and the honest distance to a public testnet.

---

## 0. Two things to read first

**`ENDGOAL.md` does not exist.** Part 4 asked me to read its §3.3 and §4. There is no such file
anywhere in the repo, no file references the string `ENDGOAL`, and nothing else carries a §3.3/§4
about public exposure (`AUDIT.md` §3–4 are "Is the autonomous loop wired?" and "The work queue";
`STATUS.md` §4 is factory state). **I did not guess what it said.** The audit below is built from
the live system, the repo, and PR #107 — all directly verifiable. If ENDGOAL.md exists somewhere
outside this checkout, the audit may be missing constraints it states.

**The two "finished" branches were empty.** `origin/task/104` and `origin/task/105` were stale
pointers at `93334d4` with **zero commits ahead of master**. The completed work existed only in
local detached-HEAD worktrees (`/home/dev/wt-104` at `642b7d5`, `/home/dev/wt-105` at `970e446`)
and had never been pushed. I recovered both from the worktrees.

---

## 1. What I fixed — factory gate mangling (F-05)

**PR #110** — `factory/fix-gate-mangling`

`gate_from_issue()` joined every **physical** line of a fenced gate block with `" && "`. For a
gate written with shell line-continuations:

```
cd landing && ! sed -n '...' src/content.mjs | grep -qE '...' \
  && npm ci && npm test
```

two defects compounded:

1. the trailing `\` was kept — mid-line it escapes a space instead of joining lines;
2. `" && "` was inserted before a line that **already opened with `&&`**.

Producing `... \ && && npm ci && npm test` →

```
bash: -c: line 1: syntax error near unexpected token `&&'
```

which can never exit 0. Issues #104 and #105 each burned all three attempts against a command
bash refuses to parse. **Both had already finished the work.** The worker on #104 diagnosed it
itself and was overruled by the harness.

### The fix (parsing only — no gate's meaning changed)

- Join backslash continuations **first**, before any chaining decision.
- Then chain logical lines with `" && "` as before, except a line already opening with a shell
  operator (`&&`, `||`, `|`, `;`, `&`) is appended directly.
- Validate with `bash -n`; reject what bash cannot parse, so a future mangling is caught at
  dispatch instead of three attempts later.

### A second bug found on the way

The runnable-prefix allowlist (which rejects prose) lacked the commands real gates open with.
**#103's `test -f ...` and #102's `shellcheck ...` were thrown out as prose** — and for a T3
issue `gate_for_tier` then refuses the issue outright, blocking it for a reason no worker could
act on. Added `test`, `[`, `shellcheck`, `systemd-analyze`, `grep`, `sed`, `awk`, `git`, `curl`,
`jq`, `diff`, `find`. That slightly widens the prose surface (`test` is also an English word),
which is why `bash -n` is part of the same change — net, validation is stricter than before.

### Test

`factory/tests/gate-parse.sh`, 13 assertions: the exact #104/#105 shapes parse as bash with no
surviving `\` and no `&& &&`; **meaning preserved** — genuinely independent lines still chain
with `&&`; single-line gates pass through byte-identical; `test`/`shellcheck` accepted; prose
still rejected.

```
RED before:  gate-parse: 6 passed, 7 failed
GREEN after: gate-parse: 13 passed, 0 failed
```

No regression: `gate-detect.sh` 18/18, `verdict-parse.sh` 51/51, `selftest.sh` 32/32.

Both `BLOCKED-issue-104.md` and `-105.md` moved to `factory/blocked/resolved/` with a resolution
note appended. (`factory/blocked/` is gitignored, so this is a filesystem move, not a commit.)

---

## 2. The two PRs and their review verdicts

| PR | Branch | Closes | Gate | Review verdict |
|---|---|---|---|---|
| **#108** | `task/104` | #104 | **GREEN** — 12/12 tests, build from block #433638 | **INCONCLUSIVE** (0 PASS / 0 FAIL / 3 ERROR) |
| **#109** | `task/105` | #105 | **GREEN** — docs lint validates at spec 304 @ #433616 | **INCONCLUSIVE** (0 PASS / 0 FAIL / 3 ERROR) |

Both merged current `origin/master` in first (each was two commits behind); after the merge the
diff vs master is exactly the intended files and nothing else.

### Why the verdicts are INCONCLUSIVE — not a pass

`factory/review.sh` refused to spawn any lens:

```
DAILY SPAWN CAP REACHED: 86 of 40 spawns used today (/home/dev/.factory/spend-20260903).
Refusing to start "review lens correctness for PR #108". The budget resets at 00:00 UTC.
```

All three lenses recorded **ERROR, not FAIL** — the review.sh hardening from PR #90 behaving
exactly as designed: "the reviewer could not run" and "the reviewer objects" stayed distinct.
Both PRs are flagged `needs-human`.

**I did not raise `DAILY_SPAWN_CAP`.** Raising a spend guard to manufacture a verdict is
precisely the check-weakening the round forbids. It is a budget decision for you: the cap is at
`factory/config.env:94`, and the budget resets at 00:00 UTC — re-running `./factory/review.sh 108`
and `109` after the reset costs 6 spawns (~$4.50 at the config's own $0.75/spawn estimate).

### What I verified myself, since no lens could

Both PRs commit chain data. I queried the live node independently to confirm the numbers are
genuine reads, not hand-edited:

```
chain_getBlockHash(433638) → 0x5400148f…556a2a   == committed in #108   MATCH
chain_getBlockHash(433616) → 0xda1bd0ad…2ebe94   == committed in #109   MATCH
```

Both diffs **add** tests (a "shipped components aren't advertised as planned" regression test, a
staleness floor) and weaken none.

### An unrelated defect surfaced while reviewing

`factory/review.sh` lines 429 and 737: `[: 0\n0: integer expression expected` — a variable
holding two newline-separated values used in an integer test. Cosmetic today; a latent comparison
bug. Not fixed here (out of this round's scope), noted in #110.

---

## 3. Corrected gate table

All seven rewritten as a single line, no backslashes, no newlines, semantically identical.
Each re-extracted from the live issue through the fixed `gate_from_issue` and confirmed
`bash -n` clean.

| Issue | Gate (one line) | On master |
|---|---|---|
| **#87** | `cd docs && sed -n '/^### Verify it joined/,/^### Devnet topology/p' guide/run-a-node.md \| grep -q '127\.0\.0\.1:9960' && ! sed -n '/^### Verify it joined/,/^### Devnet topology/p' guide/run-a-node.md \| grep -q '127\.0\.0\.1:9944' && npm ci && npm run lint && npm run build` | 🔴 RED |
| **#88** | `cd docs && sed -n '/^### 1\. Start with/,/^Generate the node key once/p' guide/run-a-node.md \| grep -q -- '--rpc-methods safe' && grep -q -- '--rpc-methods safe' reference/rpc.md && sed -n '/^### 2\. Generate and register session keys/,/^## Fault tolerance/p' guide/run-a-node.md \| grep -q -- '--rpc-methods unsafe' && npm ci && npm run lint && npm run build` | 🔴 RED |
| **#101** | `cd indexer && npm ci && npm test` | 🔴 RED |
| **#102** | `shellcheck deploy/products/*.sh && systemd-analyze verify deploy/products/*.service` | 🔴 RED ⚠ |
| **#103** | `test -f .github/workflows/pages.yml && ( cd docs && npm ci && npm run build ) && ( cd landing && npm ci && npm run build )` | 🔴 RED |
| **#104** | `cd landing && ! sed -n "/key: 'faucet'/,/^    },/p" src/content.mjs \| grep -qE "status: 'planned'\|issues/75" && node -e "…readAtBlock…" && npm ci && npm test && npm run build` | 🔴 RED → **GREEN on #108** |
| **#105** | `cd docs && node -e "…capturedAtBlock…" && npm ci && npm run lint && npm run build` | 🔴 RED → **GREEN on #109** |

Why each is red:

- **#87** — the "Verify it joined" section still curls `:9944` (alice) instead of `:9960`.
- **#88** — the validator start block passes no `--rpc-methods` flag at all.
- **#101** — real failure, and exactly the bug the issue describes:
  `every provider pair for //Alice is at MaxAgreementsPerPair (10); the devnet needs cleaning up`.
  The leak has already saturated the devnet. 55 pass, 48 skipped, 1 suite fails.
- **#102** — ⚠ **RED for the wrong reason: `exit 127, shellcheck: command not found`.** The gate
  cannot be evaluated on this host at all. A worker would burn every attempt on a missing tool.
  **Fix the environment (`sudo apt install -y shellcheck`), not the gate.**
- **#103** — `.github/workflows/pages.yml` does not exist.

---

## 4. Audit — distance to a public testnet

### 4.1 PR #107 (`deploy/public-rpc`) — what it adds

11 files, +818 lines, 0 deletions. Config only; **nothing applies itself.**

| File | + | Role |
|---|---|---|
| `deploy/public/domain.env` | 26 | **the single substitution point** |
| `deploy/public/render-config.sh` | 47 | renders templates → `deploy/public/rendered/` (gitignored) |
| `deploy/public/nginx/bootstrap-http.conf.template` | 27 | HTTP-only, for the ACME challenge before certs exist |
| `deploy/public/nginx/scalar-commons.conf.template` | 289 | the TLS edge |
| `deploy/public/INSTALL.md` | 194 | human runbook |
| `deploy/public/VERIFY.md` | 230 | post-install proof |
| `deploy/public/.gitignore` | 1 | ignores `rendered/` |
| `deploy/systemd/scalar-{bob,charlie,dave,eve}.service` | 1 each | `--rpc-methods safe` |

**The six nginx `server_name` lines, exactly:**

```nginx
server_name <DOMAIN> rpc.<DOMAIN> api.<DOMAIN> explorer.<DOMAIN> faucet.<DOMAIN>;   # :80 redirect + ACME
server_name rpc.<DOMAIN>;        # wss  -> 127.0.0.1:9944
server_name <DOMAIN>;            # landing at /, docs at /docs
server_name faucet.<DOMAIN>;     # -> 127.0.0.1:8082
server_name explorer.<DOMAIN>;   # -> 127.0.0.1:8081
server_name api.<DOMAIN>;        # -> 127.0.0.1:8080
```

**The complete ufw rule list, exactly as INSTALL.md gives it:**

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp                 comment 'ssh'
sudo ufw allow 80/tcp                 comment 'http - acme + redirect'
sudo ufw allow 443/tcp                comment 'https + wss'
sudo ufw allow 30333:30337/tcp        comment 'substrate p2p - alice..eve'
sudo ufw enable
sudo ufw status numbered
sudo ufw deny 9944:9948/tcp comment 'RPC stays loopback - proxy via 443 only'
```

RPC 9944–9948 are never allowed; `default deny incoming` covers them and the explicit `deny`
makes the intent visible in `ufw status`.

**Order INSTALL.md requires, with realistic timings:**

| # | Step | Time |
|---|---|---|
| 0 | Preconditions: 5 DNS names resolve; devnet healthy; confirm `--rpc-methods safe` | 10 min + DNS propagation (up to 30 min) |
| 1 | **Firewall first** — the ufw block above | 3 min |
| 2 | `apt install -y nginx certbot python3-certbot-nginx` | 3 min |
| 3 | Edit `deploy/public/domain.env` (the one substitution point) | 2 min |
| 4 | `./deploy/public/render-config.sh` | 1 min |
| 5 | Build landing + docs (**see the `/docs` blocker below**) | 5 min |
| 6 | Install bootstrap conf, `nginx -t`, reload, `certbot certonly --webroot` for all 5 names | 10 min |
| 7 | Swap in the TLS config, `nginx -t`, reload | 3 min — **budget 15–20**, see below |
| 8 | Run every check in VERIFY.md | 15 min |

Firewall precedes nginx deliberately, so there is no window where :80/:443 are open unruled.

### 4.2 The four public-facing things — BUILT but NOT RUNNING

Verified live: `ss -ltn` shows **only** 9944–9948, all on `127.0.0.1`/`::1`. Nothing on 80, 443,
8080, 8081, 8082. Five validators run, all five with `--rpc-methods safe` (5 of 5 processes).

| Thing | Built? | Running? | Blocker |
|---|---|---|---|
| **RPC over wss** | chain runs | ❌ loopback only | needs nginx + TLS + domain (PR #107) |
| **Faucet** | ✅ source, runs via strip-types | ❌ | no unit file; needs `FAUCET_PORT=8082` |
| **Docs** | ✅ `docs/.vitepress/dist` | ❌ nothing serves it | static; nginx or Pages (#103) |
| **Explorer** | ✅ builds — I ran it, `dist/index.js` OK | ❌ | no unit file; needs `EXPLORER_PORT=8081` |
| *(Indexer)* | ✅ source | ❌ | no unit file; defaults to 8080 already |

**Exact commands to start each as a systemd user service on loopback.** These unit files **do not
exist** — `deploy/products/` is absent on master and on every remote branch, and **issue #102 has
no branch and no PR**. So this is what #102 must produce, not something to copy today:

```ini
# ~/.config/systemd/user/scalar-indexer.service
[Service]
Type=exec
WorkingDirectory=/home/dev/scalar-commons-v4/indexer
Environment=INDEXER_HOST=127.0.0.1 INDEXER_PORT=8080 INDEXER_RPC_URL=ws://127.0.0.1:9944
ExecStart=/usr/bin/npm start
```

```ini
# ~/.config/systemd/user/scalar-explorer.service   (requires `npm run build` first)
Environment=EXPLORER_HOST=127.0.0.1 EXPLORER_PORT=8081 EXPLORER_RPC_ENDPOINT=ws://127.0.0.1:9944
ExecStart=/usr/bin/node dist/index.js
```

```ini
# ~/.config/systemd/user/scalar-faucet.service
Environment=FAUCET_HOST=127.0.0.1 FAUCET_PORT=8082 FAUCET_RPC_ENDPOINT=ws://127.0.0.1:9944
Environment=FAUCET_TRUST_PROXY=true
ExecStart=/usr/bin/npm start
```

Then `systemctl --user daemon-reload && systemctl --user enable --now scalar-{indexer,explorer,faucet}`.

⚠ **All three default to port 8080.** Without explicit `EXPLORER_PORT` / `FAUCET_PORT` they
collide and the second and third fail to bind. The env files are load-bearing, not decoration.

### 4.3 Domain vs bare IP

**Needs a real domain:** everything in PR #107. Let's Encrypt will not issue for an IP, and all
six vhosts key off `server_name`. No domain → no TLS → no `wss://` (browsers refuse mixed
content from an HTTPS page), and no `<DOMAIN>/docs`.

**Demonstrable on a bare IP today, no domain, no certificate:**

- All five products over an **SSH tunnel** —
  `ssh -L 8080:127.0.0.1:8080 -L 8081:127.0.0.1:8081 -L 8082:127.0.0.1:8082 -L 9944:127.0.0.1:9944 <host>`
  then Polkadot-JS Apps against `ws://127.0.0.1:9944`. This is the honest demo path and needs
  **nothing merged** beyond starting the three services.
- The landing page and docs are static — open `landing/dist/index.html` and
  `docs/.vitepress/dist/` locally, or serve on a loopback port.
- Docs at `/` (not `/docs`) via GitHub Pages once #103 lands — Pages supplies its own certificate,
  so **docs can be public today with no domain at all**. This is the cheapest first public artifact.

### 4.4 What I think is wrong or unsafe in #107

I wrote #107, so treat this as self-review, not an outside audit.

1. **`/docs` will 404 — real, called out but unfixed.** `docs/.vitepress/config.mts` sets no
   `base`, so the build emits absolute `/assets/…` URLs and root-relative links. Served under
   `/docs/` they break. INSTALL.md step 5 and VERIFY.md (d) flag it, but the fix (`base: '/docs/'`)
   is a source change I kept out of a config-only PR. **`/docs` does not work until it lands.**

2. **The faucet's per-IP rate limiting silently collapses behind the proxy.** `FAUCET_TRUST_PROXY`
   defaults to **`false`** (`faucet/src/config.ts:86`), so `clientIp()` ignores `X-Forwarded-For`
   and every request appears to come from `127.0.0.1` — nginx. All users share one bucket:
   the first requester per hour consumes the global per-IP allowance and everyone else is refused,
   while a single attacker cycling addresses is limited only by the per-address rule.
   **#107 proxies the faucet without mentioning this.** Any faucet unit file must set
   `FAUCET_TRUST_PROXY=true`, and nginx must be the only path to :8082 (it is — loopback bind).

3. **The faucet's default seed is `//Ferdie` — a publicly known dev key.** Fine on a private
   devnet, actively unsafe the moment `faucet.<DOMAIN>` is reachable: anyone can derive the key
   and drain the account directly, bypassing every rate limit the faucet enforces. Rate limiting
   an account whose private key is public is theatre. **Set a real `FAUCET_SEED` before exposing
   the faucet, or expose everything except the faucet.** #107 does not say this anywhere.

4. **The nginx config has never been parsed by nginx.** No nginx and no container runtime on this
   host, and installing one would start a listener on the live devnet box. I checked brace balance
   and block structure only. `nginx -t` at step 7 is the first real syntax check — hence the 15–20
   minute budget rather than 3.

5. **Rate-limit thresholds are reasoned, not measured.** `10r/s burst=20`, `limit_conn 5`. On the
   wss vhost `limit_req` bounds *connection attempts*, not calls inside an open socket — one
   connection issuing thousands of JSON-RPC calls is bounded by the node, not nginx. VERIFY.md (c)
   says so; don't record that check as "RPC call rate is limited".

6. **Minor, but worth knowing:** on master the repo's `scalar-{bob,charlie,dave,eve}.service`
   files do **not** carry `--rpc-methods safe`, while the *installed* units in
   `~/.config/systemd/user/` already do — and all five processes are running with it. So #107's
   systemd hunks bring the **repo into line with reality**; they do not change live behaviour.
   Nothing to fear in applying them, but also no security gain — that gain already happened.

---

## 5. Numbered, timed checklist to take the network public

Timings assume one person, no incidents. **Steps 1–4 need no domain.**

| # | Step | Command / action | Time |
|---|---|---|---|
| 1 | Merge the factory fix first — everything else depends on gates that run | merge **#110** | 5 min |
| 2 | Merge the two landed PRs | merge **#108**, **#109** (both gates GREEN; both `needs-human` because review could not spawn) | 5 min |
| 3 | Re-run the reviews after 00:00 UTC | `./factory/review.sh 108; ./factory/review.sh 109` — 6 spawns | 20 min |
| 4 | Install shellcheck so #102's gate can be evaluated at all | `sudo apt install -y shellcheck` | 2 min |
| 5 | Fix the `/docs` base | `base: '/docs/'` in `docs/.vitepress/config.mts`, rebuild | 10 min |
| 6 | Drain the devnet escrow so #101's gate can go green | see the release procedure; #101 is red because //Alice's pairs are all at `MaxAgreementsPerPair=10` | 20 min |
| 7 | Land #103 (Pages) — **first public artifact, no domain needed** | docs live on `github.io` with a Pages certificate | 30 min |
| 8 | Write #102's three unit files | `deploy/products/`; set `EXPLORER_PORT=8081`, `FAUCET_PORT=8082`, `FAUCET_TRUST_PROXY=true` | 45 min |
| 9 | Start the three services on loopback and verify | `systemctl --user enable --now …`; `curl 127.0.0.1:8080/health` | 15 min |
| 10 | **Demo checkpoint — everything works over an SSH tunnel here, with no domain and no TLS.** Stop here if a public endpoint isn't needed yet. | | — |
| 11 | Buy the domain; A records for `@`, `rpc`, `api`, `explorer`, `faucet` | | 15 min + up to 30 min propagation |
| 12 | **Set a real `FAUCET_SEED`** and fund it — do not expose `//Ferdie` | | 15 min |
| 13 | Merge #107 | | 5 min |
| 14 | ufw rules (§4.1) — **before nginx** | | 3 min |
| 15 | `apt install nginx certbot`; edit `domain.env`; `render-config.sh` | | 6 min |
| 16 | Bootstrap conf → `certbot certonly --webroot` for all 5 names | | 10 min |
| 17 | Swap in the TLS config; `nginx -t`; reload | first real syntax check — expect fixes | 20 min |
| 18 | Work every check in VERIFY.md, especially **(b) unsafe RPC refused** | must show `-32601 RPC call is unsafe to be called externally` over wss, and `nmap` from another host showing 9944–9948 unreachable | 20 min |

**Total to a tunnelled demo (1–10): ~2h30m.**
**Total to a public TLS endpoint (1–18): ~5h**, plus DNS propagation and domain purchase.

The single highest-value step is **#7** — GitHub Pages puts real, public, certificate-backed docs
on the internet today for zero infrastructure and zero risk to the devnet box.
