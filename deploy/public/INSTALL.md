# Public exposure — install steps

Issue #76. **A human runs every command on this page.** Nothing in
`deploy/public/` applies itself; `render-config.sh` only writes into
`deploy/public/rendered/`.

Do the steps in the order given. The ordering is not cosmetic: the firewall
closes before nginx listens, and certificates exist before the config that
references them is installed.

> **Status: installed and serving.** This config is live on scalarnet.io as of
> 2026-09-09. It has been parsed by `nginx -t`, reloaded, and verified end to
> end from an external host — see `PUBLIC-LAUNCH.md` in the repo root for the
> full PASS/FAIL table. The template in `nginx/` is now the exact source of the
> installed file: `render-config.sh` with `DOMAIN=scalarnet.io` reproduces
> `/etc/nginx/sites-available/scalarnet` byte for byte (§4a below).

---

## 0. Preconditions

- All five names resolve to this host: `<DOMAIN>`, `rpc.<DOMAIN>`,
  `api.<DOMAIN>`, `explorer.<DOMAIN>`, `faucet.<DOMAIN>`.
- The devnet is running and healthy (`deploy/finality-check.sh`).
- The three product services from issue #102 are up on 8080/8081/8082, or you
  accept that those three vhosts will 502 until they are.

Confirm the node is in safe mode before exposing anything — this is the control
that refuses unsafe RPC, and step 8 depends on it:

```bash
grep -n 'rpc-methods' deploy/systemd/scalar-*.service
# every validator must show:  --rpc-methods safe
```

### The faucet must not be signing with a dev seed

**`FAUCET_SEED` is required before exposure and there is no safe default.** The
faucet's in-code fallback is `//Ferdie`, a published Substrate dev seed. Its
account held ~1e9 CMN, so once RPC is reachable anyone can empty it with a plain
`balances.transfer` — and then every rate limit and the 1 000 CMN reserve
protect nothing, because the attacker never touches the faucet at all.
TESTNETAUDIT.md §6 I-6, issue #123.

```bash
# generate a key; print the phrase ONCE and put it in the 0600 env file
./target/release/scalar-node key generate --scheme sr25519 --output-type json

# ~/.config/scalar-commons/faucet.env, mode 0600, never in git
grep -q '^FAUCET_SEED=' ~/.config/scalar-commons/faucet.env \
  || echo 'MISSING: FAUCET_SEED — the faucet is signing with //Ferdie'
```

Fund the resulting address, then confirm the running faucet is actually using
it — `/health` reports the address it signs with, so this catches an env file
that was written but never loaded:

```bash
curl -s http://127.0.0.1:8082/health | python3 -m json.tool
# faucetAddress must be YOUR address, not //Ferdie's
# 5CiPPseXPECbkjWCa6MnjNokrgYjMqmKndv2rSnekmSK2DjL
```

Set `FAUCET_TRUST_PROXY=true` in the same file **only** with the vhost from
`deploy/public/nginx/`, which overwrites `X-Forwarded-For`. With
`TRUST_PROXY=false` behind a proxy the per-IP limit degrades to one global
bucket for the whole internet; with it true behind a proxy that *appends*, it
was forgeable. Both halves are fixed in this repo, but a hand-rolled vhost can
undo one of them.

---

## 1. Firewall first

Set the firewall **before** nginx starts listening, so there is no window where
:80/:443 are open without rules.

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing

sudo ufw allow 22/tcp                 comment 'ssh'
sudo ufw allow 80/tcp                 comment 'http - acme + redirect'
sudo ufw allow 443/tcp                comment 'https + wss'
sudo ufw allow 30333:30337/tcp        comment 'substrate p2p - alice..eve'

sudo ufw enable
sudo ufw status numbered
```

**RPC ports 9944–9948 are deliberately absent.** They stay loopback-only and
are reached exclusively through the nginx proxy on 443. `default deny incoming`
already blocks them; the explicit rules below exist so the intent is visible in
`ufw status` and nobody "helpfully" opens them later:

```bash
sudo ufw deny 9944:9948/tcp comment 'RPC stays loopback - proxy via 443 only'
```

Verify no RPC port is listening on a public interface:

```bash
ss -ltnp | grep -E '994[4-8]'    # every line must show 127.0.0.1, never 0.0.0.0
```

---

## 2. Install nginx and certbot

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

---

## 3. Set the domain (the one substitution point)

Edit **`deploy/public/domain.env`** — the only file you change:

```bash
$EDITOR deploy/public/domain.env
# set DOMAIN=<your real domain>
# confirm LANDING_DIST / DOCS_DIST paths are right for this host
```

---

## 4. Render the configs

```bash
./deploy/public/render-config.sh
ls deploy/public/rendered/
# -> bootstrap-http.conf  scalar-commons.conf
```

The script refuses to run while `DOMAIN` is still `example.com`, and fails if
any placeholder survives substitution.

**Environment beats `domain.env`.** Any of the four variables may be exported
instead of edited into the file, so a host can render without dirtying a
tracked file and a real domain never has to be committed:

```bash
DOMAIN=example.org LANDING_DIST=/var/www/site/landing DOCS_DIST=/var/www/site/docs ACME_WEBROOT=/var/www/acme ./deploy/public/render-config.sh
```

### 4a. The template is the installed file

The scalarnet.io deployment is reproducible from this repo alone. On that host:

```bash
DOMAIN=scalarnet.io LANDING_DIST=/var/www/scalarnet/landing DOCS_DIST=/var/www/scalarnet/docs ACME_WEBROOT=/var/www/acme ./deploy/public/render-config.sh
sha256sum deploy/public/rendered/scalar-commons.conf /etc/nginx/sites-available/scalarnet
```

Both lines must print the same digest. Measured 2026-09-09:

```
9e5a834a6a6b9e7515d28407533da088ccebeee29aff2b738e2cdc4d9a1126b6  deploy/public/rendered/scalar-commons.conf
9e5a834a6a6b9e7515d28407533da088ccebeee29aff2b738e2cdc4d9a1126b6  /etc/nginx/sites-available/scalarnet
```

If they ever diverge, someone edited `/etc/nginx` by hand and the repo is no
longer the source of truth — reconcile before changing anything else.

The template's header comment describes the file as "derived from the template
and corrected"; that sentence is a historical note from the launch round, kept
verbatim because rewording it would change the rendered bytes and break the
digest above. Reword it in the next change that reinstalls the config.

---

## 5. Build the static output

```bash
sudo mkdir -p /var/www/acme
sudo mkdir -p /var/www/scalarnet/landing /var/www/scalarnet/docs
sudo chown "$USER" /var/www/scalarnet/landing /var/www/scalarnet/docs

./deploy/public/redeploy-site.sh
```

`redeploy-site.sh` is the only supported way to build these two sites. It runs
as an ordinary user, builds landing with `LANDING_OUT_DIR` pointing at the
webroot and docs with `DOCS_BASE=/docs/`, publishes the vitepress output, and
then **fails loudly** if either `index.html` is missing or if any emitted asset
URL still points at `/assets/` instead of `/docs/assets/`.

> **Run it after every merge that touches `landing/` or `docs/`.** CI does not
> build into the webroot and nginx serves files, not a repo, so until this runs
> the site is still serving the previous merge. That is precisely how the
> landing page came to advertise spec 304 while the chain was running 305.

Destinations default to `/var/www/scalarnet/{landing,docs}` and can be pointed
elsewhere with `LANDING_DEST` / `DOCS_DEST`.

> **The `/docs` base blocker is closed.** `docs/.vitepress/config.mts` now
> honours `DOCS_BASE` (`base: process.env.DOCS_BASE ?? '/'`), and
> `redeploy-site.sh` always sets it. The guard in the script exists so a future
> build that loses the setting fails the deploy instead of quietly publishing an
> unstyled site — the failure mode is a 200, not a crash, so nothing else would
> catch it.

---

## 6. Bootstrap HTTP, then get certificates

The full config references `/etc/letsencrypt/live/<DOMAIN>/`, which does not
exist yet — install the bootstrap config first so `nginx -t` passes and ACME
has a webroot.

```bash
sudo cp deploy/public/rendered/bootstrap-http.conf /etc/nginx/sites-available/scalar-commons.conf
sudo ln -sf /etc/nginx/sites-available/scalar-commons.conf /etc/nginx/sites-enabled/scalar-commons.conf
sudo rm -f /etc/nginx/sites-enabled/default

sudo nginx -t && sudo systemctl reload nginx
```

One certificate covering all five names:

```bash
sudo certbot certonly --webroot -w /var/www/acme \
  -d <DOMAIN> \
  -d rpc.<DOMAIN> \
  -d api.<DOMAIN> \
  -d explorer.<DOMAIN> \
  -d faucet.<DOMAIN> \
  --agree-tos -m <your-email> --no-eff-email

sudo ls /etc/letsencrypt/live/<DOMAIN>/    # fullchain.pem, privkey.pem
```

Check the renewal timer is armed (certbot's package installs it):

```bash
systemctl list-timers | grep certbot
sudo certbot renew --dry-run
```

---

## 7. Swap in the real config

```bash
sudo cp deploy/public/rendered/scalar-commons.conf /etc/nginx/sites-available/scalar-commons.conf
sudo nginx -t          # <-- first real syntax check; fix anything it reports
sudo systemctl reload nginx
```

Use `reload`, not `restart`: reload keeps established connections alive.

---

## 8. Verify

Run every check in [VERIFY.md](VERIFY.md). Check (b) — unsafe RPC refused — is
the one that must not be skipped.

---

## Rollback

```bash
sudo rm -f /etc/nginx/sites-enabled/scalar-commons.conf
sudo nginx -t && sudo systemctl reload nginx
sudo ufw deny 80/tcp && sudo ufw deny 443/tcp
```

The chain keeps running throughout: nothing here changes node state, and the
validators' RPC never left loopback.
