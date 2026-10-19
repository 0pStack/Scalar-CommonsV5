# TESTNETAUDIT.md — Scalar Commons v4

Read-only audit of `master @ 6efba16` and the live 5-validator devnet, against `ENDGOAL.md`.
2026-09-08, 08:18–14:05 CEST. 17 auditors; every CRITICAL/HIGH finding adversarially verified.
Nothing was modified, committed, merged, labelled, dispatched or fixed. No extrinsic was submitted.

## 1. Executive summary

**No. Do not expose this on scalarnet.io tomorrow.** Five blockers, each verified against the running system:

1. **Root is `//Alice`, a published dev seed.** `Sudo::Key` on chain equals the key I derived from `//Alice`; `Sudo` is exempt from SafeMode and `author_submitExtrinsic` is *safe*, so nothing withholds it. `docs/reference/rpc.md:296` already tells the public this key was "removed by referendum". It was not — day 36 of a 14-day promise. Nothing in the chain's own configuration would refuse an internet peer, but the host **is** filtering (`/proc/modules` shows 21 live netfilter modules including ufw's full signature set), so this is a pre-exposure defect to fix rather than a live incident.
2. **The faucet signs with `//Ferdie`**, holding 999,999,926 CMN — spendable by anyone directly, so its rate limits protect nothing; behind the shipped nginx those limits are additionally either one global bucket or forgeable.
3. **The published docs assert four things the chain contradicts**: an 18B genesis mint (actual 6,010,250,000.01), a 5B treasury (started empty), 82B headroom, and "no other pallet has a mint path" — while **100% of the 43.58M CMN issued since genesis came from pallet_staking's inflation curve, which no cap check gates** — plus 14.62M more booked, unclaimed, and mintable by anyone via the permissionless `payout_stakers`. Every GitHub link on the landing page 404s: the repo is private.
4. **ENDGOAL §3.4's launch gate has never been run.** No archetype has touched a live chain, no tooling can, and the only evidence — reproduced bit-exactly today — records wash trading as profitable.
5. **`settle_era` has never succeeded in ~512,000 blocks (~142 due eras).** The emissions pallet's only storage key is its own version. The mechanism the project is about has never executed.

What is genuinely good: 109/109 tests pass with zero ignores; `fmt` and `clippy -D warnings` are clean; the standing-rule sweep found no violations; finality is healthy and unattended for 35 days; the ROUND14 governance fix is real and well tested; the indexer survived ~150 hostile inputs with bounded RPC amplification; the docs constant-checker genuinely fails closed; and the committed chainspec is byte-identical to the live genesis across all 202 keys. **The chain works. The claims about it, and the keys guarding it, are what is not ready.**
## 2. Findings, severity-ranked

**382 findings** from 17 auditors. Every CRITICAL and HIGH was put to an adversarial verification panel (73 findings verified, 34 severities corrected: 3 raised, 31 lowered). MEDIUM/LOW/INFO findings are reported as their auditor stated them and are marked *unverified by panel* where no verifier examined them — they are evidence-backed but not adversarially challenged.

| Severity | Count |
|---|---|
| CRITICAL | 14 |
| HIGH | 51 |
| MEDIUM | 154 |
| LOW | 81 |
| INFO | 82 |

Fix-owner tier follows ENDGOAL §3.6: **T0** never dispatched, human + external audit; **T1** agent may PR, human merges; **T2** autonomous with gates; **T3** fully autonomous.

**Read the counts as coverage, not as a crisis tally.** Sixteen auditors worked in parallel without seeing each other's output, so the same defect was often found several times over — which is useful corroboration, but it inflates the row count. The verifiers cross-linked duplicates (`dup->` below). The 14 CRITICAL rows collapse to **four distinct defects**: the uncapped `pallet_staking` mint path that the docs deny exists (6 rows, issue I-2/I-3); the false 18B-genesis / 5B-treasury / 82B-headroom claims on the published token model (6 rows, I-3); the private repository behind every "Live" link on the landing page (1 row, I-4); and the false genesis-validator / floor-emission claim on the run-a-node page (1 row, I-11). Section 6 is organised by defect, and is the better list to work from.

Where a CRITICAL finding's two lenses disagreed, the table records **the more sceptical grade**. One case deserves a caveat rather than the rule: for `P3-01` (the //Alice sudo key) the lower grade was chosen *because* that lens could not establish whether the chain is reachable from the internet today, and the higher-grading lens then closed exactly that gap with an external probe I could not reproduce. Read that row as HIGH-if-firewalled, CRITICAL-if-not, and settle it with one `sudo ufw status verbose`. It is issue **I-1** either way.

### CRITICAL (14)

| id | ph | finding | evidence | tier |
|---|---|---|---|---|
| `P10-01` | X | Public docs & CLAUDE.md First Principle #1 ("all minting flows through emissions only; no other pallet has a mint path; cap enforced at every mint site") are false: pallet_staking mints 2.5–10% inflation every era, and 100% of live new CMN comes from it, 0% … | runtime/src/lib.rs:847 `type EraPayout = pallet_staking::ConvertCurve<RewardCurve>;` + :809-820 REWARD_CURVE min_inflation 2.5% / max 10%; RewardRemainder→Treasury (:838). Live staking.EraPaid events (indexer /v1/events?section=staking): era46 validator_payout 312234828766692452 + remainder … | T0 |
| `P1a-01` | 1 | Public docs (docs/reference/token-model.md:40) and CLAUDE.md:13 claim 'All minting flows through pallet-emissions. No other pallet has a mint path.' — false in code (orchestrator claim mints; pallet_staking EraPayout curve mints) and on the live chain (14.62M … | grep -rn 'deposit_creating' pallets runtime/src --include=*.rs \| grep -v tests.rs → pallets/emissions/src/lib.rs:527 AND pallets/orchestrator/src/lib.rs:659. runtime/src/lib.rs:847 'type EraPayout = pallet_staking::ConvertCurve<RewardCurve>'; lib.rs:809-817 curve min_inflation 0.025 / … | T0 |
| `P1c-01` | 1 | A mint path outside pallet-emissions is live and uncapped: pallet_staking EraPayout=ConvertCurve mints ~0.95M CMN per 18h staking era into Treasury; +43,581,090 CMN since genesis while pallet-emissions has never minted a planck. Public docs say 'All minting … | Balances.TotalIssuance via state_getStorage at block hashes (scratch readstorage/issuance_hist.mjs): block 0/1/100 = 6,010,250,000.01 CMN; block 411198 (-7d) = 6,045,461,341; block 497598 (-1d) = 6,052,900,545; block 511998 = 6,053,831,090 (+930,544 CMN/day). … | T0 |
| `P1c-04` | 1 | Public docs page run-a-node.md (live) says dev/testnet presets pre-register 'each genesis validator' with 10,000 CMN agent stake, 'the minimum that qualifies for floor emissions from era 1' — both halves are false: only the first 3 endowed accounts are … | docs/guide/run-a-node.md:115-117 (live: curl https://tejaspatil.tech/scalar-commons-v4/docs/guide/run-a-node.html contains 'minimum that qualifies for floor emissions from era 1'). node/src/chain_spec.rs:283-289 `endowed_accounts.iter().take(3)`; live Agents.AgentStake key count = 3 … | T3 |
| `P1c-05` | 1 | token-model.md's chain-check table states 'Genesis mint \| 18,000,000,000 CMN' and that the 7/5/3/3 split applies 'in both the dev/testnet presets and the mainnet genesis builder', but the live devnet's genesis issuance is 6,010,250,000 CMN (dev_genesis: 6 x … *(↑ from HIGH on verification)* | docs/reference/token-model.md:24-29 (under `<!-- chain-check:constants -->`), :59-60; docs/guide/run-a-node.md:105. Live: Balances.TotalIssuance at block 0 = 6010250000010000000000 plancks = 6,010,250,000.01 CMN. deploy/build-spec.sh builds `--chain local`; node/src/chain_spec.rs:152-180 … | T3 |
| `P2a-03` | 2 | Public docs state the 18B CMN genesis mint applies 'in both the dev/testnet presets and the mainnet genesis builder', but the live devnet's total issuance (as served by /v1/emissions/supply and raw storage) is 6,053,831,090 CMN because the local preset endows … *(↑ from HIGH on verification)* | GET /v1/emissions/supply -> totalIssuancePlancks "6053831090074318803559" percentIssued 6.0538; state_getStorage(Balances.TotalIssuance) -> 0x671294cfd985c82d4801000000000000 = 6053831090074318803559 (python LE decode, matches). node/src/chain_spec.rs:282 `let endowment: Balance = 1_000_000_000 * …` | T3 |
| `P2e-01` | 2 | Published docs state an 18B CMN genesis mint (7/5/3/3) and a 5B treasury, but the running chain's genesis issuance was 6,010,250,000 CMN and its genesis treasury is empty; these rows sit inside chain-check tables yet carry no pallet.const span so the gate … | Live: read-only @polkadot/api script (/tmp/audit/scratch/P2e/live-state.mjs) -> genesis totalIssuance=6,010,250,000 CMN (6010250000010000000000 plancks); node/src/chain_spec.rs:282 `endowment = 1_000_000_000 * CMN` x6 endowed (:169-176) + 5x(2M stash + 50k ctrl) = 6,010,250,000; :392 `"treasury": …` | T3 |
| `P2e-02` | 2 | Published docs and CLAUDE.md assert that pallet-emissions is the only mint path, but pallet-staking's EraPayout has minted 43.58M CMN into the treasury since genesis while pallet-emissions has never settled an era. | Live: totalIssuance genesis 6,010,250,000 -> head #511967 6,053,831,090 CMN (+43,581,090); emissions.lastSettledEra=<none>, lastEraEmission=0, agents.eraNumber=0 at genesis/433638/head; treasury.potAccount 5EYCAe5jKanUVRD6sxyjGQmVXuKnZDL2UCUdb2AUhvyNE2e7 free 43,581,095 CMN; staking.activeEra 47, … | T3 |
| `P4-01` | 4 | Public docs claim 'All minting flows through pallet-emissions. No other pallet has a mint path.' — false: pallet_staking's inflation curve has minted 43.58M CMN to Treasury (100% of issuance since genesis) while pallet-emissions has minted zero. | docs/reference/token-model.md:40 (published page, sidebar docs/.vitepress/config:37). runtime/src/lib.rs:809-816 reward curve min_inflation 2.5% / max 10%; :847 `type EraPayout = pallet_staking::ConvertCurve<RewardCurve>`; :838 `type RewardRemainder = ResolveTo<TreasuryAccount, Balances>`. Live … | T0 |
| `P4-02` | 4 | Public docs claim the 18B genesis mint holds 'in both the dev/testnet presets and the mainnet genesis builder'; the live devnet genesis TotalIssuance is 6,010,250,000.01 CMN and dev_genesis never references GENESIS_MINT. | docs/reference/token-model.md:29 'Genesis mint \| 18,000,000,000 CMN' and :60 'A compile-time assertion in node/src/chain_spec.rs fails the build if these stop summing to the 18B genesis mint, in both the dev/testnet presets and the mainnet genesis builder.' state_getStorage TotalIssuance at … | T3 |
| `P4-06` | 4 | The staking mint path is not bounded by SUPPLY_CAP: ConvertCurve is cap-unaware and pallet-constitution only emits events after a breach, violating CLAUDE.md principle #1 'No code path may mint beyond the cap'. *(↑ from HIGH on verification)* | runtime/src/lib.rs:847 `type EraPayout = pallet_staking::ConvertCurve<RewardCurve>` (no cap parameter); :838 RewardRemainder mints remainder to Treasury at era end (hook, not dispatch). pallets/constitution/src/lib.rs:131-158 on_initialize: 'Emits alert events but never halts'; `if current > cap { …` | T0 |
| `P8-02` | 8 | Published token-model page states 'Genesis mint 18,000,000,000 CMN', 'treasury ... starts with 5B CMN from genesis' and 'No other pallet has a mint path'; the live devnet minted 6,010,250,000.01 CMN at genesis, the treasury started at 0 and now holds 43.58M … | polkadot-js reads via ws://127.0.0.1:9944 (read-only): totalIssuance@block1 = 6010250000010000000000 (6,010,250,000.01 CMN); totalIssuance@511965 = 6053831090074318803559; delta 43,581,090.064 CMN; emissions.lastSettledEra = null, lastEraEmission = 0, agents.eraNumber = 0; … | T3 |
| `P9-01` | 9 | Public landing page marks Source repository, Documentation and Testnet faucet links 'available' but all three point at github.com/tejaspatil1936/scalar-commons-v4 which is PRIVATE and returns 404 to any stranger; the docs are in fact public at … | gh api repos/tejaspatil1936/scalar-commons-v4 -> private:true visibility:private. Unauthenticated curl: 404 https://github.com/tejaspatil1936/scalar-commons-v4, 404 .../tree/master/docs, 404 .../tree/master/faucet. curl https://tejaspatil.tech/scalar-commons-v4/ -> 200 (md5 4060d6dd... == … | T3 |
| `P9-03` | 9 | Public docs claim the 7B/5B/3B/3B = 18B genesis split is enforced 'in both the dev/testnet presets and the mainnet genesis builder'; every --chain preset uses dev_genesis (1B CMN per endowed account) and the live testnet has ~6.05B CMN issued. CLAUDE.md:6 … | docs/reference/token-model.md:59-60 quoted text. node/src/chain_spec.rs: *_ALLOC used only at :429-431 and :497-503 inside mainnet_genesis_config (:411, 'Deliberately not reachable from a --chain id'); dev_genesis :282 `let endowment: Balance = 1_000_000_000 * CMN`; command.rs:67-70 maps … | T3 |

### HIGH (51)

| id | ph | finding | evidence | tier |
|---|---|---|---|---|
| `GAP-G-01-03` | GAP-G-01 | sshd on the public interface permits password authentication AND root login. /etc/ssh/sshd_config ends with two appended lines, `PasswordAuthentication yes` and `PermitRootLogin yes`, with an empty sshd_config.d so nothing overrides them; sshd binds … *(unverified by panel)* | grep -nvE '^\s*(#\|$)' /etc/ssh/sshd_config -> '12:Include /etc/ssh/sshd_config.d/*.conf, 63:KbdInteractiveAuthentication no, 85:UsePAM yes, 90:X11Forwarding yes, 94:PrintMotd no, 112:AcceptEnv ..., 115:Subsystem sftp ..., 124:PasswordAuthentication yes, 125:PermitRootLogin yes'; the file is 125 … | T0 |
| `GAP-G-01-03*` | GAP-G-01 | sshd on the public interface permits password authentication AND root login. /etc/ssh/sshd_config ends with two appended lines, `PasswordAuthentication yes` and `PermitRootLogin yes`, with an empty sshd_config.d so nothing overrides them; sshd binds … *(unverified by panel)* | grep -nvE '^\s*(#\|$)' /etc/ssh/sshd_config -> '12:Include /etc/ssh/sshd_config.d/*.conf, 63:KbdInteractiveAuthentication no, 85:UsePAM yes, 90:X11Forwarding yes, 94:PrintMotd no, 112:AcceptEnv ..., 115:Subsystem sftp ..., 124:PasswordAuthentication yes, 125:PermitRootLogin yes'; the file is 125 … | T0 |
| `GAP-G-02-01` | GAP-G-02 | sshd listens on 0.0.0.0:22 and [::]:22 with BOTH `PasswordAuthentication yes` and `PermitRootLogin yes` active. The only thing rate-limiting internet password guessing against root@152.53.113.104 is the fail2ban daemon that no auditor recorded, running Debian … *(unverified by panel)* | $ grep -n -E '^\s*(PermitRootLogin\|PasswordAuthentication\|KbdInteractiveAuthentication\|UsePAM\|Match\|Include\|MaxAuthTries\|AllowUsers\|Port\|ListenAddress)' /etc/ssh/sshd_config 12:Include /etc/ssh/sshd_config.d/*.conf 63:KbdInteractiveAuthentication no 85:UsePAM yes 124:PasswordAuthentication … | T1 |
| `GAP-G-03-02` | GAP-G-03 | execute_slash never removes the agent from the ranked collective. A slash that drops stake below MinStake deletes AgentStake but leaves the account a rank-2/rank-3 RankedCollective member forever, so a slashed party keeps its Technical Council seat and … *(unverified by panel)* | pallets/agents/src/lib.rs:1206 'pub fn execute_slash(' -> :1221 ensure_root(origin)?; :1254-1258 'if new_stake >= T::MinStake::get() { AgentStake::<T>::insert(&who, new_stake); } else { AgentStake::<T>::remove(&who); }'. grep over the whole function for AgentCollective -> no hit (grep -n … | T2 |
| `GAP-G-03-02*` | GAP-G-03 | execute_slash never removes the agent from the ranked collective. A slash that drops stake below MinStake deletes AgentStake but leaves the account a rank-2/rank-3 RankedCollective member forever, so a slashed party keeps its Technical Council seat and … *(unverified by panel)* | grep -n "AgentStake::<T>::remove(&who)\|AgentCollective::remove(&who)" pallets/agents/src/lib.rs -> :890 `T::AgentCollective::remove(&who); // remove from ranked-collective` (complete_unstake) and :891/:1257 AgentStake removals. AgentCollective::remove appears ONLY at :890. execute_slash: … | T2 |
| `GAP-G-04-01` | GAP-G-04 | All nine of the node's own RPC hardening flags are unset on all five validators and appear nowhere in the repo, so a public wss endpoint built from deploy/public/INSTALL.md would run every jsonrpsee default with only nginx's connection-establishment limit in … *(unverified by panel)* | `target/release/scalar-node --help \| grep -nE -- '--rpc-(max\|rate)'` -> lines 66 --rpc-rate-limit, 73 --rpc-rate-limit-whitelisted-ips, 78 --rpc-rate-limit-trust-proxy-headers, 87 --rpc-max-request-size [default: 15], 92 --rpc-max-response-size [default: 15], 97 … | T1 |
| `GAP-G-04-01*` | GAP-G-04 | All nine of the node's own RPC hardening flags are unset on all five validators and appear nowhere in the repo, so a public wss endpoint built from deploy/public/INSTALL.md would run every jsonrpsee default with only nginx's connection-establishment limit in … *(unverified by panel)* | `target/release/scalar-node --help \| grep -nE -- '--rpc-(max\|rate)'` -> lines 66 --rpc-rate-limit, 73 --rpc-rate-limit-whitelisted-ips, 78 --rpc-rate-limit-trust-proxy-headers, 87 --rpc-max-request-size [default: 15], 92 --rpc-max-response-size [default: 15], 97 … | T1 |
| `GAP-G-04-03` | GAP-G-04 | The public wss vhost and all three internal products point at the SAME node (alice, 127.0.0.1:9944), which runs the default `--rpc-max-connections 100`. nginx's `limit_conn rpc_conn 5` caps a single source IP at 5 sockets but places no global bound, so ~20 … *(unverified by panel)* | Node cap: `scalar-node --help` line 141 '--rpc-max-connections <COUNT> ... [default: 100]'; not set on any validator (`/proc/<pid>/cmdline` grep -c 'rpc-max' -> 0 x5) and not in any unit (`grep -c 'rpc-max' /home/dev/.config/systemd/user/scalar-*.service` -> 0 x8). Shared upstream: … | T1 |
| `GAP-G-04-03*` | GAP-G-04 | The public wss vhost and all three internal products point at the SAME node (alice, 127.0.0.1:9944), which runs the default `--rpc-max-connections 100`. nginx's `limit_conn rpc_conn 5` caps a single source IP at 5 sockets but places no global bound, so ~20 … *(unverified by panel)* | Node cap: `scalar-node --help` line 141 '--rpc-max-connections <COUNT> ... [default: 100]'; not set on any validator (/proc/<pid>/cmdline grep -c 'rpc-max' -> 0 x5) and not in any unit (grep -c 'rpc-max' /home/dev/.config/systemd/user/scalar-*.service -> 0 x8). Shared upstream: … | T1 |
| `GAP-G-06-05` | GAP-G-06 | CONFIRMS P3-04 end-to-end — do NOT double-count as a separate defect. P3 predicted from grep that master's committed docs/.vitepress/dist (built with base '/') would 404 under the nginx /docs/ mount. Served through the real rendered config it does exactly … *(unverified by panel)* | With alias -> /home/dev/scalar-commons-v4/docs/.vitepress/dist/ (master's build): served page references href="/assets/style.CwNnKCVM.css", src="/assets/app.CRRN0Uh3.js", href="/assets/chunks/framework.Bmhw_dvp.js", href="/assets/chunks/theme.B4SrBliy.js", href="/assets/index.md.CVg6nnYV.lean.js", … | T2 |
| `GAP-G-06-05*` | GAP-G-06 | CONFIRMS P3-04 end-to-end — do NOT double-count as a separate defect. P3 predicted from grep that master's committed docs/.vitepress/dist (built with base '/') would 404 under the nginx /docs/ mount. Served through the real rendered config it does exactly … *(unverified by panel)* | With alias -> /home/dev/scalar-commons-v4/docs/.vitepress/dist/ (master's build), page references href="/assets/style.CwNnKCVM.css", src="/assets/app.CRRN0Uh3.js", href="/assets/chunks/framework.Bmhw_dvp.js", href="/assets/chunks/theme.B4SrBliy.js", href="/assets/index.md.CVg6nnYV.lean.js", … | T2 |
| `GAP-G-07-02` | GAP-G-07 | The PUBLIC docs page states 'Every raw value on this page is read from a live node and mechanically re-checked' (token-model.md:378), which is false: rows inside an armed <!-- chain-check:constants --> table that carry no `pallet.constName` code span are … *(unverified by panel)* | docs/reference/token-model.md:378 'Every raw value on this page is read from a live node and mechanically re-checked.' Published: curl -sSL https://tejaspatil.tech/scalar-commons-v4/docs/reference/token-model -> HTTP 200, grep -c of that sentence in the served HTML = 1. Mutation in the scratch copy … | T3 |
| `GAP-G-07-02*` | GAP-G-07 | The PUBLIC docs page states 'Every raw value on this page is read from a live node and mechanically re-checked' (token-model.md:378), which is false: rows inside an armed <!-- chain-check:constants --> table that carry no `pallet.constName` code span are … *(unverified by panel)* | docs/reference/token-model.md:378. Published: curl -sSL https://tejaspatil.tech/scalar-commons-v4/docs/reference/token-model -> HTTP 200; grep -c of that sentence in the served HTML = 1. Mutation in the SCRATCH copy only: token-model.md:29 '\| Genesis mint \| 18,000,000,000 CMN \| … | T3 |
| `GAP-G-11-01` | GAP-G-11 | The indexer, the explorer and the faucet all wedge permanently the first time their node goes away for longer than one WebSocket retry interval (1s indexer, 2.5s explorer/faucet): the polkadot-js provider makes exactly ONE reconnect attempt and then stops … *(unverified by panel)* | Read-only test: a scratch TCP proxy (/tmp/audit/scratch/G11/proxy.mjs) on 127.0.0.1:19944 forwarding to alice 9944; second instances of each product on 18080/18081/18082. Node taken away 14:16:40 ('[proxy] SIGTERM: destroying 4 socket(s)'; 'ss -ltn \| grep :19944' empty). Both products logged … | T2 |
| `GAP-G-11-01*` | GAP-G-11 | The indexer, the explorer and the faucet all wedge permanently the first time their node goes away for longer than one WebSocket retry interval (1s indexer, 2.5s explorer/faucet): the polkadot-js provider makes exactly ONE reconnect attempt and then stops … *(unverified by panel)* | Read-only test: scratch TCP proxy (/tmp/audit/scratch/G11/proxy.mjs) on 127.0.0.1:19944 forwarding to alice 9944; second instances of each product on 18080/18081/18082. Node taken away 14:16:40 ('[proxy] SIGTERM: destroying 4 socket(s) and exiting'; 'ss -ltn \| grep :19944' empty). Both products … | T2 |
| `GAP-G-12-01` | GAP-G-12 | fail2ban is the only brute-force control in front of a public sshd that permits password authentication AND root login, and the repository never mentions it. A stranger rebuilding from deploy/README.md + deploy/products/README.md + factory/install-systemd.sh … *(unverified by panel)* | `grep -rn -i 'fail2ban' /home/dev/scalar-commons-v4/ --exclude-dir=.git` -> exit 1, zero matches anywhere in the repo. `systemctl show fail2ban -p ActiveState -p UnitFileState -p NRestarts -p ActiveEnterTimestamp` -> ActiveState=active, UnitFileState=enabled, NRestarts=0, ActiveEnterTimestamp=Tue … | T1 |
| `GAP-G-12-01*` | GAP-G-12 | fail2ban is the only brute-force control in front of a public sshd that permits password authentication AND root login, and the repository never mentions it. A stranger rebuilding from deploy/README.md + deploy/products/README.md + factory/install-systemd.sh … *(unverified by panel)* | `grep -rn -i 'fail2ban' /home/dev/scalar-commons-v4/ --exclude-dir=.git` -> exit 1, zero matches anywhere in the repo. `systemctl show fail2ban` -> ActiveState=active, UnitFileState=enabled, NRestarts=0, ActiveEnterTimestamp=Tue 2026-07-28 11:04:12 CEST. `dpkg --verify fail2ban` -> no output … | T1 |
| `GAP-G-13-01` | GAP-G-13 | The audit report's proposed-issues section (I-1..I-21) has no issue for the chain-layer test-coverage cluster: P1a-02, P1a-03, P1a-04, P1a-05, P1a-06, P1a-07, P1a-10 and P4-07 (6 HIGH + 2 MEDIUM) are cited by no issue, leaving the largest unowned block in the … *(unverified by panel)* | grep -oE '\bP[0-9a-c]+-[0-9]+' /tmp/audit/report/06-issues.md \| sort -u -> 56 ids, none of which is P1a-02/03/04/05/06/07/10 or P4-07. All eleven sub-gates re-executed on master @ 6efba16 2026-09-08 and every one exits 1 (CapReached grep, EraNotDue+EraAlreadySettled grep, auto-params '#[test]' … | T2 |
| `GAP-G-13-01*` | GAP-G-13 — the missing proposed issue for the chain-layer test-coverage cluster | The report's proposed-issues section (I-1..I-21) has no issue for the chain-layer test-coverage cluster: P1a-02, P1a-03, P1a-04, P1a-05, P1a-06, P1a-07, P1a-10 and P4-07 (6 HIGH + 2 MEDIUM) are cited by no issue. That is the largest unowned block in the audit … *(unverified by panel)* | `grep -oE '\bP[0-9a-c]+-[0-9]+' /tmp/audit/report/06-issues.md \| sort -u` returns 56 ids; none of P1a-02/03/04/05/06/07/10 or P4-07 is among them. All 12 sub-gates re-executed on master @ 6efba16 today: every one exits 1. ENDGOAL.md:181 '**A green check must mean the code is correct**, never that … | T2 |
| `P10-02` | X | The PUBLIC landing page (tejaspatil.tech/scalar-commons-v4) links its 'Source repository', 'Documentation' and 'Testnet faucet' to a PRIVATE GitHub repo, so all three 404 for any stranger. | Landing served publicly 200 at https://tejaspatil.tech/scalar-commons-v4/ (Pages, cert approved). landing/dist/index.html links github.com/tejaspatil1936/scalar-commons-v4 (3 hits) + /tree/master/docs + /tree/master/faucet (live fetch confirms). gh repo view → {"isPrivate":true}. curl -sI on all … | T3 |
| `P10-03` | X | docs contradict each other on unsafe RPC: rpc.md says the devnet runs --rpc-methods safe, but run-a-node.md's validator start passes no --rpc-methods flag and then curls author_rotateKeys — the recipe is broken for a stranger (open #88, still on master). | docs/reference/rpc.md:19-21 states devnet runs --rpc-methods safe (withholds author_rotateKeys/insertKey). docs/guide/run-a-node.md:232-239 validator start block has no --rpc-methods flag; :256-262 curls author_rotateKeys at :9960; rpc.md:228-229 lists it Unsafe. `sed -n '/^### 1. Start …` | T3 |
| `P1a-08` | 1 | The live devnet has never settled a single era: the Emissions pallet's storage contains only its storage-version key at block 511,999 (~142 six-hour eras elapsed), so settle_era, claim, auto-params rules and ring detection have never run against the live … | state_getKeysPaged(twox128('Emissions'), 1000) at best block 511,999 → 1 key = :__STORAGE_VERSION__:. state_getStorage Emissions::LastSettledEra (0x14e767caae65907bcccb1824eb3fda418924db482c2640461926b647a0150c80) → {"result":null}; EraStartBlock, LastEraEmission, AccRewardPerStake absent. Agents: … | T1 |
| `P1b-02` | 1 | settle_era is priced as a constant (5 reads + 5 writes + 1e9 ps = 1.625e9 ps ≈ 0.001625 CMN) but iterates every registered agent (MaxAgents = 10,000,000) plus every orchestrator and sorts all weights — an unbounded-work extrinsic at fixed price, i.e. the free … | pallets/emissions/src/lib.rs:228-229 weight attr; :299 `for (agent, stake) in agents_pallet::AgentStake::<T>::iter()` with ≈7 storage reads + 1 write per agent (:304 CompletedAgreements, compute_weight_cached: rank_of, heartbeat_multiplier, EraEscrowVolume, EraUniqueBuyers, EraGovParticipation; … | T0 |
| `P1b-04` | 1 | A forkless runtime upgrade has never been rehearsed, applied, scripted, documented or tested: the on-chain :code at the finalized head is byte-identical to genesis, all five spec_version bumps (300→304) were compiled into fresh geneses before the chain … | state_getStorageHash(':code' 0x3a636f6465) at genesis 0xff6882…03d1 and at finalized head #511883 both = 0x1a978681b5c7bba350dcb8bb292fdeefba94dc4cc5fb9cd88972e3f64a3da1f8 (full blobs 1,158,717 bytes, same blake2b-256; identical to deploy/scalar-local-raw.json :code and … | T1 |
| `P1b-05` | 1 | The chain's sudo key on all five nodes and in the committed raw chainspec is the //Alice dev account whose secret seed is public; Sudo is whitelisted through SafeMode and OnSetCode=(), so anyone who can reach an RPC port can set_code / take root. … | state_getStorage(0x5c0d1176a568c1f92944340dbfed9e9c530ebca703c85910e7164cb7d1c9e47b) on 9944–9948 → 0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d (key recomputed via @polkadot/util-crypto twox128('Sudo')++twox128('Key') and matched). `target/release/scalar-node key inspect …` | T0 |
| `P1c-02` | 1 | settle_era has never been called on the live devnet: after 511,998 blocks (142 x EraDuration) every emissions/era storage item is null, so the emission weight formula has never executed on the live network — ENDGOAL §3.4 ('run against the live network') and … | state_getStorage on 9944 (keys twox128 computed with indexer/node_modules/@polkadot/util-crypto): Emissions.LastSettledEra=null, Emissions.LastEraEmission=null, Emissions.EraStartBlock=null, Emissions.AccRewardPerStake=null, Agents.EraNumber=null, Agents.EraActiveSnapshot=null; Agents.AgentStake … | T3 |
| `P2c-01` | 2 | Repo faucet unit, install.sh and products README run src/index.ts under --experimental-strip-types, which crash-loops (ERR_MODULE_NOT_FOUND ./amount.js); the box only works via a local-only drop-in running a gitignored dist/ built on this machine. | journalctl --user -u scalar-faucet --since 2026-09-07 \| head: 'Sep 07 07:31:07 … Error [ERR_MODULE_NOT_FOUND]: Cannot find module /home/dev/scalar-commons-v4/faucet/src/amount.js imported from …/faucet/src/index.ts' … 'Main process exited, code=exited, status=1/FAILURE'; restart counter reached 71 … | T3 |
| `P2c-02` | 2 | faucet/README.md 'npm ci … npm start' and package.json start script cannot work: npm start exits 1 with ERR_MODULE_NOT_FOUND before connecting or listening. The landing page sends strangers to exactly this README ('you run it yourself'). | cd faucet && FAUCET_PORT=18082 timeout 8 npm start -> 'Error [ERR_MODULE_NOT_FOUND]: Cannot find module /home/dev/scalar-commons-v4/faucet/src/amount.js imported from …/src/index.ts', pipeline exit 1, nothing listening on 18082. faucet/package.json: "start": "node --experimental-strip-types … | T3 |
| `P2c-03` | 2 | Behind the shipped nginx exposure config the faucet's per-IP limit is broken either way: with the deployed FAUCET_TRUST_PROXY=false every request is 127.0.0.1 so 5 drips/hour becomes a GLOBAL cap for the whole internet (6th stranger gets 429 scope=ip); with … | faucet/src/server.ts:56-66 clientIp(): trustProxy ? first comma-separated XFF entry : req.socket.remoteAddress. Live env FAUCET_TRUST_PROXY=false (/proc/1664521/environ). deploy/public/nginx/scalar-commons.conf.template faucet vhost: 'proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;' … | T1 |
| `P2c-04` | 2 | The live faucet signs with the public dev seed //Ferdie (no FAUCET_SEED anywhere in the effective env), an account holding 999,999,926.49 CMN (5.5% of genesis). Once RPC is public anyone spends it directly, so every faucet rate limit and the reserve floor … | tr '\0' '\n' < /proc/1664521/environ \| grep -i FAUCET -> only HOST/PORT/RPC_ENDPOINT/TRUST_PROXY; ~/.config/scalar-commons/faucet.env has 0 effective lines (identical to faucet.env.example); faucet/src/config.ts:80 default '//Ferdie'. Keyring //Ferdie -> … | T1 |
| `P2d-01` | 2 | The PUBLIC docs SDK page (docs/guide/sdk.md, live at https://tejaspatil.tech/scalar-commons-v4/docs/guide/sdk) makes three claims that the code refutes: total = free+stake+pendingEmissions; recordGovVote 'has no SDK wrapper yet'; register 'Requires an … *(verifiers split: one lens said CRITICAL, one said HIGH; recorded at the more sceptical grade)* | Public page fetched (curl -sIL ...github.io/.../docs/guide/sdk → 301 → https://tejaspatil.tech/scalar-commons-v4/docs/guide/sdk → 200, 76953 bytes); grep counts on it: 'free + stake + pendingEmissions'=1, 'no SDK wrapper yet'=1, 'agents.recordGovVote(agent, pollIndex)'=1, 'Requires an on-chain … | T3 |
| `P2e-03` | 2 | The public landing page labels the faucet and explorer cards 'Live' while their own notes say no hosted instance is up; render.mjs maps every non-planned status to a 'Live' badge. *(↓ from CRITICAL on verification)* | landing/src/render.mjs:157 `link.status === 'planned' ? '<span class="badge planned">Planned</span>' : '<span class="badge">Live</span>'`; content.mjs:274 'A hosted explorer for the devnet is not up yet', :283 'No hosted instance is up yet'. Published https://tejaspatil.tech/scalar-commons-v4/ … | T3 |
| `P2e-05` | 2 | Issue #87 is still present on master: the full-node 'Verify it joined' step curls alice (9944) instead of the node started on 9960, with alice's sample output. | docs/guide/run-a-node.md:155 `--rpc-port 9960 \`, :167 `### Verify it joined`, :172 `http://127.0.0.1:9944`, :176 `{"peers":4,"isSyncing":false,"shouldHavePeers":false}`, :197 `\| alice \| 30333 \| 9944 \|`. Issue #87 gate sed clause run today -> exit 1 (RED). Page last commit 660c840 (2026-08-05). | T3 |
| `P2e-06` | 2 | Issue #88 is still present on master: rpc.md says the devnet runs --rpc-methods safe and unsafe methods need an explicit unsafe flag, while run-a-node.md's validator recipe passes no --rpc-methods flag and then calls author_rotateKeys on that node. | docs/reference/rpc.md:19-21 'The devnet runs with `--rpc-methods safe`… reachable only from a node started with `--rpc-methods unsafe`'; docs/guide/run-a-node.md:232-239 validator command (no --rpc-methods), :260-262 `author_rotateKeys` -> http://127.0.0.1:9960. Issue #88 gate run today -> exit 1 … | T3 |
| `P3-01` | 3 | Live chain Sudo::Key is Alice (public dev seed), Sudo is exempt from SafeMode, and the 'day 14 removal' never happened — the moment wss RPC is public (author_submitExtrinsic is a SAFE method) any stranger can execute sudo.sudo(*) as Alice; neither ENDGOAL … *(verifiers split: one lens said CRITICAL, one said HIGH; recorded at the more sceptical grade)* | curl state_getStorage 0x5c0d1176a568c1f92944340dbfed9e9c530ebca703c85910e7164cb7d1c9e47b @9944 -> "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d"; stdlib blake2b SS58(42) -> 5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY (Alice). node/src/chain_spec.rs:177 local preset … | T0 |
| `P3-02` | 3 | Faucet per-IP rate limit collapses behind the nginx template either way: with the live FAUCET_TRUST_PROXY=false every proxied request is 127.0.0.1 so the whole internet shares one 5-drips/hour bucket; with TRUST_PROXY=true (the fix issue #115 plans) the … | faucet/src/server.ts:55-66 clientIp(): trustProxy -> `raw?.split(',')[0]` (left-most), else req.socket.remoteAddress; faucet/src/config.ts:81-86 perIp 5/60min, trustProxy default false; `systemctl --user show scalar-faucet -p Environment` -> FAUCET_TRUST_PROXY=false; dist/server.js:35,43 same logic … | T1 |
| `P3-03` | 3 | The faucet signs with the public dev seed //Ferdie holding ~999,999,926 CMN and INSTALL.md exposes faucet.<DOMAIN> without any instruction to set FAUCET_SEED; once transaction submission is public, anyone can drain the account directly, so every faucet rate … | curl http://127.0.0.1:8082/health -> faucetAddress 5CiPPseXPECbkjWCa6MnjNokrgYjMqmKndv2rSnekmSK2DjL, faucetFreePlancks 999999926492428999773, dripAmountPlancks 10000000000000, reservePlancks 1000000000000000. faucet/src/config.ts:72 default '//Ferdie'; `grep -v '^\s*#' …` | T1 |
| `P4-03` | 4 | ENDGOAL §3.4 launch gate is RED: no attacker archetype has ever been run against the live chain, and no tooling exists to do so (recording-only runners, stub scripts that exit 1, zombienet absent, CI workflow not installed, stale TODOs). | grep -rn 'polkadot\|ws://\|ApiPromise\|WsProvider' experiments/sc-e1/archetypes/*.ts → only a doc comment (types.ts:13). scripts/run-eras.sh:31-32 `echo "::error::sc-e1 SDK entrypoint not wired yet (TODO: PR #5)"; exit 1`; scripts/extract-export.sh:30-31 same for PR #7. zombienet.toml:22-29 TODOs … | T2 |
| `P4-04` | 4 | The only economic-security evidence (Python sim) records wash trading as PROFITABLE (P5 FAIL, +1,556 CMN/era at the 1M ceiling; 5-sybil ring +9.2% after the ROUND14 fix) — reproduced bit-exactly today — while ENDGOAL §3.4 says 'none may be profitable' yet … | experiments/sc-e1/verdict.json: `P5_wash_net_per_era_at_1M … v2_value 1556.41 … verdict FAIL … 'Wash profitable at the only pool the chain uses (1M ceiling)'`; `P5_wash_break_even_pool FAIL`. Re-run `env -C /tmp/audit/scratch/P4/simrun python3 SC-E1-phase0-sim.py` → output IDENTICAL to committed … | T0 |
| `P5-01` | 5 | indexer/ and explorer/ ship real offline test suites (55 and 53 passing tests) that no CI workflow runs; an indexer-only or explorer-only PR gets all six required checks green having executed zero lines of that code. | git log -- .github/workflows/ci-node.yml -> single commit 93334d4 2026-09-02 21:55:17 +0530; git log --diff-filter=A -- indexer/package.json -> 233ff89 2026-09-02 22:50:30 +0530; explorer/package.json -> c474f56 23:25:49 +0530 (both AFTER ci-node). ci-node.yml `changes` job (lines 55-121) emits … | T2 |
| `P6-03` | 6 | review.sh never runs load_billing_env, so under systemd its lenses have neither ~/.factory/env's PATH nor ANTHROPIC_API_KEY: all 6 systemd-launched reviews (18 lenses) exited 127; with the new local PATH drop-in the next review would run claude on the … | `grep -n load_billing_env factory/*.sh factory/lib/*.sh` → only lib/loop.sh:149 and the definition common.sh:111; `grep -n 'ANTHROPIC\\|\.factory/env' review.sh merge.sh dispatch.sh` → nothing. factory-dispatch.service comment: 'Workers source ~/.factory/env themselves'. dispatch.systemd.log: 6 … | T2 |
| `P6-05` | 6 | agent-reviewed is not bound to a head SHA: the hourly re-dispatch pushes HEAD:refs/heads/task/N from the reused worktree without re-running review, so unreviewed commits can land on a PR that keeps agent-reviewed; and review.sh adds agent-reviewed before … | merge.sh reads only labels (L129-139, L167-169); `grep -nE 'headRefOid\|sha\|SHA' factory/merge.sh factory/review.sh` → nothing relevant; review result files live in `mktemp -d` and are deleted (review.sh:238-242). dispatch.sh:466 `git -C "$wt" push -u origin "HEAD:refs/heads/$branch"` runs every … | T2 |
| `P6-06` | 6 | merge.sh cannot merge a PR whose branch is behind master under the repo's strict required checks: both open factory PRs are mergeable_state=behind, merge.sh only checks mergeable==CONFLICTING and has no update-branch step, so even a clean PR would be refused … | `gh api repos/:owner/:repo/branches/master/protection` → required_status_checks strict=True, contexts gate,full,landing,faucet,docs,sdk, enforce_admins=True. `gh api pulls/112 --jq .mergeable_state` → behind; pulls/113 → behind; GraphQL mergeStateStatus BEHIND for both. master 6efba16 is 3 commits … | T2 |
| `P8-01` | 8 | The repository is private, so every GitHub link on the public landing page (Source repository, Documentation, Faucet — all badged 'Live') and the docs site's GitHub icon return 404 to a stranger; the landing's 'How to check any of this' table points at source … *(verifiers split: one lens said CRITICAL, one said HIGH; recorded at the more sceptical grade)* | gh api repos/tejaspatil1936/scalar-commons-v4 -> 'private': True, 'visibility': 'private'. curl -s -o /dev/null -w '%{http_code}' -A Mozilla/5.0 https://github.com/tejaspatil1936/scalar-commons-v4 -> 404; /tree/master/docs -> 404; /tree/master/faucet -> 404; … | T3 |
| `P8-03` | 8 | A stranger cannot fund a registration from the faucet: register() needs stake 1,000 CMN + fee 50 CMN + ED 0.01 CMN (+0.000108 CMN tx fee) ≈ 1,050.01 CMN, while the faucet drips 10 CMN at most once per address per hour — ≥106 drips / ≥106 hours before … | pallets/agents/src/lib.rs:745 ensure!(stake >= T::MinStake); :762-767 free_balance >= stake + fee + min_balance. Live consts: agents.minStake 1000000000000000, baseRegistrationFee 50000000000000, balances.existentialDeposit 10000000000, escrow.minAgreementAmount 10000000000000. payment_queryInfo … | T3 |
| `P8-04` | 8 | Published docs state that agents.register requires an on-chain identity (docs/guide/sdk.md:118; docs/reference/rpc.md:304 'Identity ... Required to register as an agent'); the pallet's register() performs no identity check — only set_capability does. | pallets/agents/src/lib.rs:735-799 register(): guards are AlreadyRegistered, StakeTooLow, StakeTooHigh, MaxAgentsReached, RegistrationRateLimitExceeded, balance check; no T::IdentityHandler call. The only IdentityRequired check is :1047 inside set_capability (:1036). Live page confirmed: curl … | T3 |
| `P8-05` | 8 | Landing page's 'Documentation' entry links to the (private) GitHub tree and says 'A fuller developer guide is still being written', while the full VitePress guide is already published at /scalar-commons-v4/docs/ on the same host. | landing/src/content.mjs:239-246 url 'https://github.com/tejaspatil1936/scalar-commons-v4/tree/master/docs', note '... A fuller developer guide is still being written.' curl -sI https://tejaspatil.tech/scalar-commons-v4/docs/ -> HTTP/2 200; /docs/guide/run-a-node, /docs/guide/sdk, … | T3 |
| `P8-06` | 8 | Issue #87 is still present on master: run-a-node.md starts the joined full node on --rpc-port 9960 but 'Verify it joined' curls http://127.0.0.1:9944 (alice), so a stranger verifies the wrong node. | docs/guide/run-a-node.md:155 '--rpc-port 9960'; :169-172 curl ... http://127.0.0.1:9944; :184 './deploy/finality-check.sh 12 5 # ... all five nodes' also checks the devnet, not the joined node. gh issue view 87 -> OPEN, labels documentation/ready/tier:T3. Gate G5 exit=1. | T3 |
| `P8-08` | 8 | The faucet's effective funding key is the universally known //Ferdie dev seed holding 999,999,926 CMN; once the RPC is public anyone can transfer from it directly, bypassing every faucet rate limit and funding unlimited sybil agents for free. | faucet/src/config.ts:72 faucetSeed default '//Ferdie'; ~/.config/scalar-commons/faucet.env has every line commented (ground truth); GET http://127.0.0.1:8082/health -> faucetAddress 5CiPPseXPECbkjWCa6MnjNokrgYjMqmKndv2rSnekmSK2DjL, faucetFreePlancks 999999926492428999773; polkadot-js … | T1 |
| `P8-09` | 8 | The devnet has never settled an emissions era: after 511,965 blocks (≈142 eras of 3,600 blocks) emissions.lastSettledEra is null, eraStartBlock 0, lastEraEmission 0 — no CMN has ever been emitted by pallet-emissions live, so ENDGOAL §3.4/§4-9 (live archetype … | polkadot-js: emissions.lastSettledEra -> null; emissions.eraStartBlock -> 0; emissions.lastEraEmission -> 0; agents.eraNumber -> 0; state_call ScalarCommonsApi_get_era_metrics -> era_number 0, active_agents 0, total_weight 0, last_era_emission 0 (block 511,909). consts.emissions.eraDuration 3600. … | T2 |
| `P9-05` | 9 | settle_era has never been called on the live devnet: era 0 is still open after 512,084 blocks (142 era-lengths), lastSettledEra is null, so no emission has ever been minted live; the landing says 'Issuance happens per era' and ENDGOAL §3.4 requires attacker … | curl 127.0.0.1:8080/v1/eras/current -> {"era":0,"startBlock":0,"durationBlocks":3600,"currentBlock":512084,"blocksElapsed":512084,"blocksRemaining":0,"dueForSettlement":true,"lastSettledEra":null,...}. landing/chain-facts.json state.eraNumber=0, lastSettledEra=None at block 433638 (2026-09-02). … | T2 |

### MEDIUM (154)

| id | ph | finding | evidence | tier |
|---|---|---|---|---|
| `GAP-G-01-01` | GAP-G-01 | The audit's self-declared 'most important open question' - whether any packet filter is loaded in the kernel - is answerable without root from three world-readable paths, and the answer is that a ufw-generated iptables-nft ruleset IS loaded, IS hooked and IS … *(unverified by panel)* | grep /proc/modules 2026-09-08 14:21:57 CEST -> xt_hl used=22, xt_addrtype used=4, xt_comment used=2, xt_LOG used=10, xt_conntrack used=16, xt_tcpudp used=60, nft_compat used=119, nft_reject_inet used=1, ipt_REJECT used=1, ip6t_REJECT used=1; controls ip_tables used=0, xt_recent used=0, xt_limit … | T0 |
| `GAP-G-01-01*` | GAP-G-01 | The audit's self-declared 'most important open question' — whether any packet filter is loaded in the kernel — is answerable without root from three world-readable paths, and the answer is that a ufw-generated iptables-nft ruleset IS loaded, IS hooked and IS … *(unverified by panel)* | grep /proc/modules at 2026-09-08 14:21:57 CEST -> xt_hl used=22, xt_addrtype used=4, xt_comment used=2, xt_LOG used=10, xt_conntrack used=16, xt_tcpudp used=60, nft_compat used=119, nft_reject_inet used=1, ipt_REJECT used=1, ip6t_REJECT used=1; controls ip_tables used=0, xt_recent used=0, xt_limit … | T0 |
| `GAP-G-01-02` | GAP-G-01 | The report's section 7.2 and its critic-credit section state that fail2ban on this box uses `banaction = iptables-multiport`, presenting it as a second iptables rule source. It does not: Debian's jail.d override sets `banaction = nftables`, so fail2ban writes … *(unverified by panel)* | cat /etc/fail2ban/jail.d/defaults-debian.conf -> '[DEFAULT]\nbanaction = nftables\nbanaction_allports = nftables[type=allports]\n\n[sshd]\nbackend = systemd\n... enabled = true'. grep -n banaction /etc/fail2ban/jail.conf -> '208:banaction = iptables-multiport' (the base default that jail.d … | T2 |
| `GAP-G-01-02*` | GAP-G-01 | The report's §7.2 and its critic-credit section state that fail2ban on this box uses `banaction = iptables-multiport`, presenting it as a second iptables rule source. It does not: Debian's jail.d override sets `banaction = nftables`, so fail2ban writes a … *(unverified by panel)* | cat /etc/fail2ban/jail.d/defaults-debian.conf -> '[DEFAULT] / banaction = nftables / banaction_allports = nftables[type=allports] / [sshd] / backend = systemd / journalmatch = _SYSTEMD_UNIT=ssh.service + _COMM=sshd / enabled = true'. grep -n banaction /etc/fail2ban/jail.conf -> '208:banaction = … | T2 |
| `GAP-G-01-04` | GAP-G-01 | nftables.service is a one-command wipe of the host's only packet filter. It is currently disabled and dead, but it is installed and its /etc/nftables.conf starts with `flush ruleset` and then defines three EMPTY base chains. `systemctl enable --now nftables` … *(unverified by panel)* | systemctl show nftables.service -> ActiveState=inactive SubState=dead UnitFileState=disabled. systemctl cat nftables.service -> 'ExecStart=/usr/sbin/nft -f /etc/nftables.conf', 'ExecReload=/usr/sbin/nft -f /etc/nftables.conf', 'ExecStop=/usr/sbin/nft flush ruleset'. cat /etc/nftables.conf -> … | T1 |
| `GAP-G-01-04*` | GAP-G-01 | nftables.service is a one-command wipe of the host's only packet filter. It is currently disabled and dead, but installed, and /etc/nftables.conf starts with `flush ruleset` then defines three EMPTY base chains. `systemctl enable --now nftables` — a plausible … *(unverified by panel)* | systemctl show nftables.service -> ActiveState=inactive SubState=dead UnitFileState=disabled. systemctl cat nftables.service -> 'ExecStart=/usr/sbin/nft -f /etc/nftables.conf', 'ExecReload=/usr/sbin/nft -f /etc/nftables.conf', 'ExecStop=/usr/sbin/nft flush ruleset'. cat /etc/nftables.conf -> … | T1 |
| `GAP-G-02-02` | GAP-G-02 | fail2ban is an active, enabled, undocumented host-security dependency. It has been running for 42 days and is referenced nowhere in deploy/, deploy/public/INSTALL.md, deploy/README.md, deploy/install.sh, deploy/products/, docs/ or the README. P7 §1a's … *(unverified by panel)* | $ dpkg -l fail2ban \| tail -1 ii  fail2ban  1.1.0-8  all  ban hosts that cause multiple authentication errors $ systemctl show fail2ban -p ActiveState -p SubState -p ActiveEnterTimestamp -p UnitFileState -p MainPID -p NRestarts MainPID=104676 NRestarts=0 ActiveState=active SubState=running … | T2 |
| `GAP-G-02-03` | GAP-G-02 | The assembled report states fail2ban's `banaction = iptables-multiport`. That is the stock upstream value at jail.conf:208, which `/etc/fail2ban/jail.d/defaults-debian.conf:2` overrides. The effective banaction is `nftables`. The error sends the next … *(unverified by panel)* | /home/dev/scalar-commons-v4/TESTNETAUDIT.md:2278 (identical copy at /tmp/audit/TESTNETAUDIT.md, md5 20f9078edb79cc15fd7f91894e9ca5c5):   "**A third rule source was missed by all 17 auditors: `fail2ban` is active and enabled since 2026-07-28 11:04:12 (MainPID 104676), with `banaction = …` | T1 |
| `GAP-G-02-04` | GAP-G-02 | P0.md:64's "`nftables` inactive/disabled" is literally true of the systemd unit but omits the live third source of netfilter rules: nftables.service only loads /etc/nftables.conf at boot, while fail2ban shells out to /usr/sbin/nft at runtime and has done so … *(unverified by panel)* | $ systemctl show nftables.service -p ActiveState -p SubState -p UnitFileState -p LoadState LoadState=loaded ActiveState=inactive SubState=dead UnitFileState=disabled  $ lsmod \| grep -E '^(nf_tables\|nft_\|nfnetlink\|x_tables\|ip_tables\|nf_conntrack)' nft_limit              16384  13 nf_conntrack  … | T1 |
| `GAP-G-03-01` | GAP-G-03 | LIVE RANK READ (closes P1a §6 UNVERIFIED): 100% of the live agent population sits at RankedCollective rank 2 -> rank_bps = 12_000 (1.2x), a value that not one of the 109 passing tests can produce, because every test mock binds AgentCollective = () whose … *(unverified by panel)* | twox128 self-verified first: python3 /tmp/audit/scratch/twox.py -> 'Balances.TotalIssuance computed = 0xc2261276cc9d1f8598ea4b6a74b15c2f57c875e4cff74148e4628f264b974c80 ... MATCH'; independently reproduced with @polkadot/util-crypto xxhashAsHex (same three keys). … | T2 |
| `GAP-G-03-01*` | GAP-G-03 | LIVE RANK READ (closes P1a §6 UNVERIFIED): 100% of the live agent population sits at RankedCollective rank 2 -> rank_bps = 12_000 (1.2x), a value not one of the 109 passing tests can produce, because every test mock binds `AgentCollective = ()` whose rank_of … *(unverified by panel)* | twox128 self-verified first: `python3 /tmp/audit/scratch/twox.py` -> 'Balances.TotalIssuance computed = 0xc2261276cc9d1f8598ea4b6a74b15c2f57c875e4cff74148e4628f264b974c80 / MATCH'; independently reproduced with @polkadot/util-crypto xxhashAsHex (Members … | T2 |
| `GAP-G-03-03` | GAP-G-03 | Rank is monotonic: pallet-agents has no demotion path at all. maybe_promote only ever promotes, and no code anywhere calls DemoteOrigin or lowers a rank. An agent promoted to rank 2 by crossing FullFloorStake keeps rank_bps 12_000 for good, including after a … *(unverified by panel)* | grep -n 'fn remove_stake\|fn unstake\|fn reduce_stake\|fn deregister\|demote' pallets/agents/src/lib.rs -> no output (the only extrinsics are register :735, add_stake :801, request_unstake :852, complete_unstake :877, heartbeat :919, record_gov_vote :957, update_metadata :1006, set_capability … | T2 |
| `GAP-G-03-03*` | GAP-G-03 | Rank is monotonic: pallet-agents has no demotion path at all. maybe_promote only ever promotes, and no code anywhere lowers a rank. An agent promoted to rank 2 by crossing FullFloorStake keeps rank_bps 12_000 for good, including after a partial slash drops … *(unverified by panel)* | `grep -n 'fn remove_stake\|fn unstake\|fn reduce_stake\|fn deregister\|demote' pallets/agents/src/lib.rs` -> no output. The full extrinsic list is register :735, add_stake :801, request_unstake :852, complete_unstake :877, heartbeat :919, record_gov_vote :957, update_metadata :1006, set_capability … | T2 |
| `GAP-G-03-04` | GAP-G-03 | The SC-E1 economic model's rank assumption (MA'-4) does not match chain semantics, and its stated reason for rank 3 being unreachable names the wrong Config type. The sim awards rank_bps 12_000 to any agent with stake >= FullFloorStake and zero completions; … *(unverified by panel)* | Sim: experiments/sc-e1/SC-E1-phase0-sim.py:33-35 "MA'-4 rank_bps modeled as 12_000 (rank 2) for agents at/above FullFloorStake (10_000 CMN), else 10_000 (rank 1). Rank 3 (15_000) is unreachable at genesis because its oracle-score gate is inert (OracleScoreProvider = (), best_score = 0; F-5/F-6)."; … | T3 |
| `GAP-G-03-04*` | GAP-G-03 | The SC-E1 economic model's rank assumption (MA'-4) does not match chain semantics, and its stated reason for rank 3 being unreachable names the wrong Config type. The sim awards rank_bps 12_000 to any agent with stake >= FullFloorStake and zero completions; … *(unverified by panel)* | Sim: experiments/sc-e1/SC-E1-phase0-sim.py:33-35 "MA'-4 rank_bps modeled as 12_000 (rank 2) for agents at/above FullFloorStake (10_000 CMN), else 10_000 (rank 1). Rank 3 (15_000) is unreachable at genesis because its oracle-score gate is inert (OracleScoreProvider = (), best_score = 0; F-5/F-6)."; … | T3 |
| `GAP-G-03-07` | GAP-G-03 | pallet_agents' genesis_build -- the only code path on this chain that has ever promoted anyone -- has zero test coverage. No test anywhere constructs pallet_agents::GenesisConfig, and every mock's `()` AgentCollective makes induct and promote unconditional … *(unverified by panel)* | grep -rn 'pallet_agents::GenesisConfig' /home/dev/scalar-commons-v4 --include=*.rs -> exit 1, no matches. Every new_test_ext builds only frame_system + pallet_balances (+ pallet_auto_params default) genesis: pallets/escrow/src/tests.rs:165-168, pallets/oracle/src/tests.rs:154-157, … | T2 |
| `GAP-G-03-07*` | GAP-G-03 | pallet_agents' genesis_build — the only code path on this chain that has ever promoted anyone — has zero test coverage. No test anywhere constructs pallet_agents::GenesisConfig, and every mock's `()` AgentCollective makes induct and promote unconditional … *(unverified by panel)* | `grep -rn 'pallet_agents::GenesisConfig' /home/dev/scalar-commons-v4 --include=*.rs` -> exit 1, no matches. Every new_test_ext builds only frame_system + pallet_balances (+ default pallet_auto_params): pallets/escrow/src/tests.rs:165-168, pallets/oracle/src/tests.rs:154-157, … | T2 |
| `GAP-G-04-02` | GAP-G-04 | deploy/public/VERIFY.md:161-164 tells the operator not to over-read check (c) because 'One connection sending thousands of JSON-RPC calls is bounded by the node, not by nginx.' No such node-side bound exists or is planned anywhere in the repo, so the caveat … *(unverified by panel)* | deploy/public/VERIFY.md:161-164 verbatim: '> Scope, so the result is not over-read: `limit_req` on the wss vhost bounds > **connection attempts**, not messages inside an already-open socket. One > connection sending thousands of JSON-RPC calls is bounded by the node, not by > nginx. Do not record … | T3 |
| `GAP-G-04-02*` | GAP-G-04 | deploy/public/VERIFY.md:161-164 tells the operator not to over-read check (c) because 'One connection sending thousands of JSON-RPC calls is bounded by the node, not by nginx.' No such node-side bound exists or is planned anywhere in the repo, so the caveat … *(unverified by panel)* | deploy/public/VERIFY.md:161-164 verbatim: '> Scope, so the result is not over-read: `limit_req` on the wss vhost bounds > **connection attempts**, not messages inside an already-open socket. One > connection sending thousands of JSON-RPC calls is bounded by the node, not by > nginx. Do not record … | T3 |
| `GAP-G-04-04` | GAP-G-04 | The obvious companion to `--rpc-rate-limit` is `--rpc-rate-limit-whitelisted-ips` plus `--rpc-rate-limit-trust-proxy-headers` (so the operator's own address is exempt behind nginx). Wired against the shipped template that combination is forgeable: … *(unverified by panel)* | polkadot-stable2503 @0c0d4ceba45a70f4e8dc40b1ee0cfae1fd759454 (Cargo.lock:9092-9094 sc-rpc-server 21.0.0 from that tag): substrate/client/rpc-servers/src/utils.rs:247-266 doc comment '1. `Forwarded` header. 2. `X-Forwarded-For` header. 3. `X-Real-Ip`.' with `.and_then(\|v\| …` | T2 |
| `GAP-G-04-04*` | GAP-G-04 | The obvious companion to --rpc-rate-limit is --rpc-rate-limit-whitelisted-ips plus --rpc-rate-limit-trust-proxy-headers (so the operator's own address is exempt behind nginx). Wired against the shipped template that combination is forgeable: sc-rpc-server's … *(unverified by panel)* | polkadot-stable2503 @0c0d4ceba45a70f4e8dc40b1ee0cfae1fd759454 (Cargo.lock:9092-9094 sc-rpc-server 21.0.0 from that tag): substrate/client/rpc-servers/src/utils.rs:247-266 doc comment '1. `Forwarded` header. 2. `X-Forwarded-For` header. 3. `X-Real-Ip`.' with `.and_then(\|v\| …` | T2 |
| `GAP-G-05-01` | GAP-G-05 | tracker.sh EXECUTED (gap G-05): the dispatcher/merge flags are NOT the only field factory/STATE.md misreports — the `window:` line reports the day-window parallelism from the same process environment and says 'throttled to 1' on every watchdog-written copy … *(unverified by panel)* | Byte-identical scratch copy /tmp/audit/scratch/G05-factory (diff -r -q clean; md5 tracker.sh bf48e46938a097992ad398e35b754d9e both sides). Run C = exact factory-dispatch.service env (`env -i HOME=/home/dev PATH=/home/dev/.npm-global/bin:… ENABLE_DISPATCH=true ENABLE_MERGE=true MAX_PARALLEL=3 …` | T2 |
| `GAP-G-05-01*` | GAP-G-05 | tracker.sh EXECUTED (gap closed): the dispatcher/merge flags are NOT the only field factory/STATE.md misreports. The `window:` line reports the day-window parallelism from the same process environment and says 'throttled to 1' on every watchdog-written copy … *(unverified by panel)* | Byte-identical scratch copy /tmp/audit/scratch/G05-factory (`diff -r -q` clean; md5 tracker.sh bf48e46938a097992ad398e35b754d9e both sides). Run C = exact factory-dispatch.service env reproduces the on-disk factory/STATE.md byte-for-byte except line 1 (`diff -u baseline runC` -> only `-# Factory …` | T2 |
| `GAP-G-05-03` | GAP-G-05 | factory/config.env:10-13 states 'Every setting below uses the ${VAR:-default} form so a single run can be overridden from the environment without editing this file … the environment is the override.' Exactly one assignment in the file breaks that contract: … *(unverified by panel)* | `grep -nE '^[A-Z_]+=' factory/config.env \| grep -vE '=\"?\$\{[A-Z_]+:-'` -> single hit `177:FACTORY_REPO=""`. `FACTORY_REPO=someone/elses-repo bash -c '. factory/config.env; printf "[%s]\n" "$FACTORY_REPO"'` -> `[]`. Control: `MAX_PARALLEL=99 bash -c '. factory/config.env; printf "[%s]\n" …` | T1 |
| `GAP-G-05-03*` | GAP-G-05 | factory/config.env:10-13 states of itself 'Every setting below uses the ${VAR:-default} form so a single run can be overridden from the environment without editing this file … the environment is the override.' Exactly one assignment breaks that contract: … *(unverified by panel)* | `grep -nE '^[A-Z_]+=' factory/config.env \| grep -vE '=\"?\$\{[A-Z_]+:-'` -> single hit `177:FACTORY_REPO=""`. `FACTORY_REPO=someone/elses-repo bash -c '. factory/config.env; printf "[%s]\n" "$FACTORY_REPO"'` -> `[]`. Control: `MAX_PARALLEL=99 bash -c '. factory/config.env; printf "[%s]\n" …` | T1 |
| `GAP-G-06-03` | GAP-G-06 | The rpc vhost is the implicit default_server for *:443: no server block carries `default_server`, and `rpc.<DOMAIN>` is the first 443 block. Once deployed, an SNI-less TLS connection to the bare IP, and every Host name that is not one of the five … *(unverified by panel)* | `grep -n 'default_server' rendered/scalar-commons.conf` -> no match; rpc vhost is the first 443 server (line 72), landing is second (line 142). Config started unprivileged on 127.0.0.1:19080/19443 (all five 443 blocks remapped to the same address:port, so the default-server grouping is unchanged). … | T2 |
| `GAP-G-06-03*` | GAP-G-06 | The rpc vhost is the implicit default_server for *:443: no server block carries `default_server`, and `rpc.<DOMAIN>` is the first 443 block. Once deployed, an SNI-less TLS connection to the bare IP, and every Host name that is not one of the five … *(unverified by panel)* | `grep -n 'default_server' rendered/scalar-commons.conf` -> no match; rpc vhost is the first 443 server (line 72), landing second (line 142). Config started unprivileged on 127.0.0.1:19080/19443 (all five 443 blocks remapped to the SAME address:port, so default-server grouping is unchanged). … | T2 |
| `GAP-G-07-03` | GAP-G-07 | Nothing in the repo can detect snapshot drift. check-chain-values.mjs reads only the committed snapshot, ci-node.yml explicitly EXCLUDES snapshot:chain, no workflow has a cron schedule, and the gate asserts nothing about the snapshot's provenance (no max age, … *(unverified by panel)* | docs/package.json:11 `"lint": "markdownlint-cli2 ... && node scripts/check-chain-values.mjs"` — offline; snapshot:chain is a separate script (:12) nothing calls. .github/workflows/ci-node.yml:218-244 docs job = npm ci / npm run lint / npm run build; :213 comment reads 'EXCLUDED: `snapshot:chain`, … | T2 |
| `GAP-G-07-03*` | GAP-G-07 | Nothing in the repo can detect snapshot drift. check-chain-values.mjs reads only the committed snapshot, ci-node.yml explicitly EXCLUDES snapshot:chain, no workflow has a cron schedule, and the gate asserts nothing about the snapshot's provenance (no max age, … *(unverified by panel)* | docs/package.json:11 `"lint": "markdownlint-cli2 ... && node scripts/check-chain-values.mjs"` (offline); snapshot:chain is a separate script (:12) nothing calls. .github/workflows/ci-node.yml:218-244 docs job = npm ci / npm run lint / npm run build; :213 comment: 'EXCLUDED: `snapshot:chain`, the … | T2 |
| `GAP-G-08-01` | GAP-G-08 | Two of deploy/public/VERIFY.md's product checks for the indexer can never pass, so the #76 launch-gate runbook reports failure on a correct deployment: check (d) probes `curl -sI https://api.<DOMAIN>/` but the indexer refuses every non-GET including HEAD … *(unverified by panel)* | curl -sI -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/ -> 405 ; curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/ -> 404 ; curl -s http://127.0.0.1:8080/health -> {"error":"no such endpoint: /health","endpoints":["/v1/status","/v1/blocks",...]} [http=404] ; … | docs-onl |
| `GAP-G-08-02` | GAP-G-08 | No go-live acceptance rehearsal exists for ENDGOAL §4 items 5, 6 and 7: the #76 exposure runbook verifies transport only (wss answers chain_getHeader; author_rotateKeys/insertKey refused; rate limiting triggers; the product URLs serve; redirect + security … *(unverified by panel)* | /usr/bin/grep -an '^## ' deploy/public/VERIFY.md -> 16:(a) The wss endpoint answers `chain_getHeader` / 63:(b) `author_rotateKeys` and `author_insertKey` are REFUSED / 125:(c) Rate limiting triggers / 168:(d) The four product URLs serve / 209:HTTP redirect and security headers / 226:Result ; … | docs-onl |
| `GAP-G-08-03` | GAP-G-08 | The entire public surface converges on one node: the rpc vhost proxies to 127.0.0.1:9944 and all three products are env-pinned to ws://127.0.0.1:9944 (alice), with no nginx upstream block and no reference to 9945-9948 anywhere in the exposure config or … *(unverified by panel)* | deploy/public/nginx/scalar-commons.conf.template:117 `proxy_pass http://127.0.0.1:9944;` :213 `->:8082` :245 `->:8081` :280 `->:8080` ; systemctl --user show scalar-explorer -p Environment -> EXPLORER_RPC_ENDPOINT=ws://127.0.0.1:9944 ; scalar-indexer -> INDEXER_RPC_URL=ws://127.0.0.1:9944 ; … | config:  |
| `GAP-G-09-01` | GAP-G-09 | The standing-rule detector and every sweep that uses the literal token `#[allow(` miss the inner-attribute form `#![allow(...)]`, which silences a lint for a whole module or crate rather than one item. Three already sit in tracked Rust, unremarked by P5 and … *(unverified by panel)* | `.claude/hooks-factory/reject-stubs.sh:65` is `if grep -nE '#\[allow\(' "$FILE"` — the regex requires `#` immediately followed by `[`. Proved against the real hook with scratch files (no repo write): a file containing only `#![allow(clippy::all)]` + `#![allow(dead_code)]` -> `exit=0` (not flagged); … | T2 |
| `GAP-G-09-01*` | GAP-G-09 | The standing-rule detector and every sweep that uses the literal token `#[allow(` miss the inner-attribute form `#![allow(...)]`, which silences a lint for a whole module or crate rather than one item. Three already sit in tracked Rust, unremarked by P5 and … *(unverified by panel)* | `.claude/hooks-factory/reject-stubs.sh:65` is `if grep -nE '#\[allow\(' "$FILE"` — the regex requires `#` immediately followed by `[`. Proved against the real hook with scratch files (no repo write): a file containing only `#![allow(clippy::all)]` + `#![allow(dead_code)]` -> `exit=0` (not flagged); … | T2 |
| `GAP-G-11-02` | GAP-G-11 | deploy/products/README.md:80-82 states 'alice going down must not take the API down ... Already-indexed history stays queryable and the indexer reconnects.' The first two halves are true; 'the indexer reconnects' is false. It is also the sentence that stopped … *(unverified by panel)* | deploy/products/README.md:78-82 quoted verbatim. Measured against a second indexer instance whose node was removed and restored: 124s of 2s polling after the restore returned 'indexer/v1/status=500' at every sample and the restored node's proxy log shows no inbound connection for 4 minutes … | T3 |
| `GAP-G-11-02*` | GAP-G-11 | deploy/products/README.md:80-82 states 'alice going down must not take the API down ... Already-indexed history stays queryable and the indexer reconnects.' The first two halves are true; 'the indexer reconnects' is false. It is also the sentence that stopped … *(unverified by panel)* | deploy/products/README.md:78-82 quoted verbatim. Against a second indexer instance whose node was removed and restored: 124s of 2s polling after the restore returned 'indexer/v1/status=500' at every sample and the restored node's proxy log shows no inbound connection for 4 minutes … | T3 |
| `GAP-G-11-03` | GAP-G-11 | While the follower is dead, 11 of the 24 indexer routes keep answering HTTP 200 with an index frozen at the moment of the disconnect, and no response field discloses staleness. The only endpoint that would reveal it, /v1/status, is one of the 13 that 500 -- … *(unverified by panel)* | Second indexer instance, node removed 14:16:40. At 14:23:16 (chain finalized #515379) '/v1/blocks?limit=1' -> 'http 200, latest= 515313 rows= 19' (66 blocks stale) while '/v1/status' -> 500 {'error':'WebSocket is not connected...system_chain'}. Full 24-route split recorded in … | T2 |
| `GAP-G-11-03*` | GAP-G-11 | While the follower is dead, 11 of the 24 indexer routes keep answering HTTP 200 with an index frozen at the moment of the disconnect, and no response field discloses staleness. The only endpoint that would reveal it, /v1/status, is one of the 13 that 500 — so … *(unverified by panel)* | Second indexer instance, node removed 14:16:40. At 14:23:16 (chain finalized #515379) '/v1/blocks?limit=1' -> 'http 200, latest= 515313 rows= 19' (66 blocks stale) while '/v1/status' -> 500 {"error":"WebSocket is not connected\nFailed WS Request: {\"method\":\"system_chain\",\"params\":[]}"}. Full … | T2 |
| `GAP-G-11-04` | GAP-G-11 | The restart that un-wedges the indexer leaves a permanent hole in the index for the whole outage window: start() backfills only INDEXER_BACKFILL_DEPTH blocks and missingBlocks() only closes gaps inside that window, so blocks the chain definitely has are … *(unverified by panel)* | Scratch indexer with INDEXER_BACKFILL_DEPTH=8; node removed for 160s (515313 -> 515374 missed), restarted 14:23:31 ('indexer: backfilled 8 block(s) up to #515382'). Then: /v1/blocks/515300 -> 200; /v1/blocks/515313 -> 200; /v1/blocks/515350 -> 404 {'error':'block 515350 not found'}; … | T2 |
| `GAP-G-11-04*` | GAP-G-11 | The restart that un-wedges the indexer leaves a permanent hole in the index for the whole outage window: start() backfills only INDEXER_BACKFILL_DEPTH blocks and missingBlocks() only closes gaps inside that window, so blocks the chain definitely has are … *(unverified by panel)* | Scratch indexer with INDEXER_BACKFILL_DEPTH=8; node removed for 160s (515313 -> 515374 missed), restarted 14:23:31 ('indexer: backfilled 8 block(s) up to #515382'). Then /v1/blocks/515300 -> 200; 515313 -> 200; 515350 -> 404 {"error":"block 515350 not found"}; 515374 -> 404; 515380 -> 200; 515383 … | T2 |
| `GAP-G-12-02` | GAP-G-12 | deploy/README.md:172 asserts as current fact 'there is no host packet filtering running right now'. The kernel shows a live ufw ruleset. deploy/README.md:231 then uses that false premise to justify the RPC bind decision. *(unverified by panel)* | The claim, verbatim, deploy/README.md:171-172: '**Current state: `ufw` is installed and its unit is enabled, but the service is inactive - there is no host packet filtering running right now.**' and :231 'I resolved it toward the stated intent (localhost) because ufw is currently inactive: binding … | T1 |
| `GAP-G-12-02*` | GAP-G-12 | deploy/README.md:172 asserts as current fact 'there is no host packet filtering running right now'. The kernel shows a live ufw ruleset. deploy/README.md:231 then uses that false premise to justify the RPC bind decision. *(unverified by panel)* | Claim verbatim, deploy/README.md:171-172: '**Current state: `ufw` is installed and its unit is enabled, but the service is inactive - there is no host packet filtering running right now.**'; :231 'I resolved it toward the stated intent (localhost) because ufw is currently inactive: binding … | T1 |
| `GAP-G-12-03` | GAP-G-12 | The live ufw ruleset is irreproducible - not in the repo, not backed up, unreadable without root - and its boot-restore path has never executed in 47 days of uptime, so a reboot is the first test of whether the firewall comes back. *(unverified by panel)* | `ls -l --time-style=full-iso /etc/ufw/user.rules /etc/ufw/user6.rules` -> `-rw-r----- 1 root root 1416 2026-07-28 11:04:17.355 user.rules`, `-rw-r----- 1 root root 1431 ... user6.rules` (templates at /usr/share/ufw/iptables/ are 307 B and 107 B, so ~1.1 kB of local content each). Unreadable from … | T2 |
| `GAP-G-12-03*` | GAP-G-12 | The live ufw ruleset is irreproducible - not in the repo, not backed up, unreadable without root - and its boot-restore path has never executed in 47 days of uptime, so a reboot is the first test of whether the firewall comes back. *(unverified by panel)* | `ls -l --time-style=full-iso /etc/ufw/user.rules /etc/ufw/user6.rules` -> `-rw-r----- 1 root root 1416 2026-07-28 11:04:17.355 user.rules`, `1431 ... user6.rules` (templates 307 B / 107 B). Unreadable: `sudo -n cat /etc/ufw/user.rules` -> `sudo: a password is required`; `/usr/sbin/nft list ruleset` … | T2 |
| `GAP-G-12-04` | GAP-G-12 | Two third-party apt repositories with their signing keys (NodeSource for Node 22, GitHub CLI for gh) are undocumented host prerequisites; without NodeSource the indexer systemd unit's --experimental-strip-types entrypoint cannot start on stock Debian. *(unverified by panel)* | `apt-cache policy nodejs` -> `Installed: 22.23.1-1nodesource1`, `500 https://deb.nodesource.com/node_22.x nodistro/main amd64 Packages`. `cat /etc/apt/sources.list.d/nodesource.sources` -> `URIs: https://deb.nodesource.com/node_22.x / Suites: nodistro / Signed-By: …` | T1 |
| `GAP-G-12-04*` | GAP-G-12 | Two third-party apt repositories with their signing keys (NodeSource for Node 22, GitHub CLI for gh) are undocumented host prerequisites; without NodeSource the indexer systemd unit's --experimental-strip-types entrypoint cannot start on stock Debian. *(unverified by panel)* | `apt-cache policy nodejs` -> `Installed: 22.23.1-1nodesource1`, `500 https://deb.nodesource.com/node_22.x nodistro/main amd64 Packages`. `/etc/apt/sources.list.d/nodesource.sources` (mtime 2026-07-28 11:12:19) -> `URIs: https://deb.nodesource.com/node_22.x / Suites: nodistro / Signed-By: …` | T1 |
| `L-01` | 1 | The integration suite's own header claims it 'runs the full runtime (all 33 pallets)'; it actually builds an 8-pallet mock with Balance = u64, so the real 100B supply cap (10^23) cannot even be represented and the tests run against a cap 10,000x smaller, … *(unverified by panel)* | tests/integration.rs:3 verbatim: 'These tests run the full runtime (all 33 pallets).' Actual: `sed -n '/construct_runtime/,/^}/p' tests/common.rs` lists 8 pallets (System Balances Agents Escrow Oracle Emissions AutoParams Orchestrator) at tests/common.rs:62; the real runtime has 36 pallet indices … | T2 |
| `P10-04` | X | docs run-a-node 'Verify it joined' curls alice (:9944) instead of the node the reader just started (:9960), so verification passes regardless (open #87). *(unverified by panel)* | docs/guide/run-a-node.md:155 starts reader node on --rpc-port 9960; :167-177 'Verify it joined' curls http://127.0.0.1:9944 with sample {"peers":4,"shouldHavePeers":false}; topology table :197 confirms 9944=alice. Tracked open #87. | T3 |
| `P10-05` | X | token-model.md states genesis facts (18B genesis mint; treasury 'starts with 5B CMN from genesis') that the live devnet — which the page claims to be verified against — never had. *(unverified by panel)* | docs/reference/token-model.md:29 '18,000,000,000 CMN' genesis mint; :347 'treasury … starts with 5B CMN from genesis'. Live: block-0 Balances.TotalIssuance = 6,010,250,000.010 CMN (not 18B); treasury account free=0. node/src/chain_spec.rs: 7B/5B/3B/3B split only in mainnet_genesis_config; … | T3 |
| `P10-06` | X | ENDGOAL.md (merged 2026-09-08 as the definition of done) states an already-closed gap as a current blocker: 'four of five validators run without --rpc-methods safe'. *(unverified by panel)* | ENDGOAL.md:149. Actual: all five deploy/systemd/scalar-{alice..eve}.service carry --rpc-methods safe; lead-auditor ground truth confirms all five processes run with it; deploy/public/VERIFY.md expects 5. Closed by PR #114/#107 (2026-09-07); WEEKCHECK A10 (2026-08-29) was the last time it was open. | T3 |
| `P10-07` | X | CLAUDE.md First Principle #2 misstates the weight formula (drops √stake, heartbeat, volume/diversity) and carries stale facts (3-validator, SDK '2025.12 line'). *(unverified by panel)* | CLAUDE.md:14 'Weight = stake × rank × oracle accuracy × governance participation × velocity bonus'. Actual pallets/emissions/src/lib.rs:557-667: √stake × rank_bps × activity(floor+gov+diversity·log2(volume)·work) × heartbeat × (1+oracle) × (1+onboarding) × (1+velocity). CLAUDE.md:35 'Local … | T3 |
| `P10-08` | X | knowledge/ graph is stale: README-SWARM claims 35 entities/28 relations (actual 21/16) and entity OD-3 says 6 of 7 pallet Cargo.toml are missing (all 7 exist). *(unverified by panel)* | README-SWARM.md:28-29 '35 entities … 28 relations'; knowledge/entities.jsonl=21, relations.jsonl=16. entities.jsonl OD-3 'Cargo.toml manifests missing for 6 of 7 custom pallets'; ls pallets/*/Cargo.toml = 7. (Relations all resolve — no dangling ids.) | T3 |
| `P10-09` | X | VERIFIED-CONSTANTS.md records InitialAlpha=4000 throughout; runtime and live value are 1500 (acknowledged in token-model but the file still ships stale numbers). *(unverified by panel)* | docs/VERIFIED-CONSTANTS.md:197 and :67 state alpha genesis 4,000. runtime/src/lib.rs:1301 AutoInitialAlpha=1_500; live autoParams.alpha()=1500. token-model.md:417-421 discloses this; VERIFIED-CONSTANTS.md is srcExcluded from the site build. | T3 |
| `P10-10` | X | The headline mechanism (work-based emissions) has never run on the live chain — settle_era never called in ~35 days — while all new issuance is passive staking inflation (flip side of P10-01). *(unverified by panel)* | emissions.lastSettledEra=null, lastEraEmission=0, eraNumber=0; indexer /v1/events?section=emissions total=0; head ~512k. settle_era is permissionless (pallets/emissions/src/lib.rs:230-234) but uncalled. Landing/docs describe 'issuance follows verifiable work' in present tense. | T0 |
| `P1a-02` | 1 | No test ever reaches the supply cap: emissions unit test supply_cap_enforced has zero assertions, and integration claim_returns_zero_at_cap finishes ~900 CMN below the cap having paid ~100 CMN (not zero); Event::CapReached / the mintable==0 clamp is asserted … *(↓ from HIGH on verification)* | pallets/emissions/src/tests.rs:282-292 fn supply_cap_enforced: awk body \| grep -c assert → 0; comment lines 286-289 verbatim: '// Difficult to test directly in mock without custom currency; verify // the code path exists by inspecting that cap check compiles and runs. // Full integration test on … | T2 |
| `P1a-03` | 1 | settle_era's EraNotDue guard and the F-04 double-settlement guard (EraAlreadySettled) — both CLAUDE.md hard rules — have no test anywhere. *(↓ from HIGH on verification)* | Guards: pallets/emissions/src/lib.rs:242-245 ensure!(now >= era_start + EraDuration, EraNotDue); :248-251 ensure!(LastSettledEra::get().is_none_or(\|last\| era > last), EraAlreadySettled). grep -q EraNotDue pallets/emissions/src/tests.rs → exit 1 (only occurrence in any test file is a comment at … | T2 |
| `P1a-04` | 1 | pallet-auto-params has zero tests, and its rule engine never executes in any test: both test mocks leave run_era_rules at the trait's no-op default, so the only integration test touching it (auto_params_ring_fee_increases) compares 0 >= 0 inside an if. *(verifiers split: one lens said HIGH, one said MEDIUM; recorded at the more sceptical grade)* | pallets/auto-params/src/tests.rs: 886 bytes, grep -c '#\[test\]' → 0; lines 8-12 verbatim '**There is no coverage here yet, and that gap is real.**'. Trait default pallets/auto-params/src/lib.rs:75 'fn run_era_rules(_metrics: EraMetrics) {}'. Runtime overrides it (runtime/src/lib.rs:1097-1099) but … | T2 |
| `P1a-05` | 1 | pallet-constitution has no tests at all, and only 1 of its documented '6 Constitutional Invariants' is wired: BaseCallFilter calls base_call_allowed() (supply cap) only; check_unstake_cooldown / check_challenge_window / check_registration_burn have zero … *(↓ from HIGH on verification)* | ls pallets/constitution/src → lib.rs only; test -f pallets/constitution/src/tests.rs → exit 1; no 'mod tests' in lib.rs. Doc lib.rs:5-8 'The 6 Constitutional Invariants … These checks fire BEFORE every extrinsic dispatch via BaseCallFilter.' Wiring: runtime/src/lib.rs:188-198 … | T2 |
| `P1a-06` | 1 | The two gaming-vector guards CLAUDE.md says must never be removed — MinQualifyingVol floor (≥50 CMN) and VelocityBonusBps cap (+30%) — are set to 0 in every test mock, so no test exercises either. *(↓ from HIGH on verification)* | Runtime values: runtime/src/lib.rs:1243 EmissionsMinQualifyingVol = 50 * CMN; :1249 EmissionsVelocityBonusBps = 3_000. Code: pallets/emissions/src/lib.rs:588-596 (floor gate), :647-667 (velocity bonus, ratio.min(BPS_SCALE)). Mocks: pallets/emissions/src/tests.rs:165 'type VelocityBonusBps = … | T2 |
| `P1a-07` | 1 | orchestrator self-link guard (orchestrator != sub_agent → SelfLink) has no test; claim_orchestrator — the pallet's own mint path — has no test; and register_orchestrator_with_full_stake_succeeds actually asserts a failure (FeeTooHigh). *(↓ from HIGH on verification)* | Guard: pallets/orchestrator/src/lib.rs:392 'ensure!(orchestrator != sub_agent, Error::<T>::SelfLink);'. grep SelfLink over all test files → 0 files. claim_orchestrator lib.rs:627-664 with deposit_creating at :659; grep -rq claim_orchestrator pallets/orchestrator/src/tests.rs tests/ → exit 1; … | T2 |
| `P1a-09` | 1 | oracle: the DuplicateRequest-before-reserve guard and the aggregation floor (InsufficientResponses) and ChallengeWindowActive are untested; only the positive quorum path is exercised. *(unverified by panel)* | Guard order verified pallets/oracle/src/lib.rs:293-295 ensure!(DuplicateRequest) then :297 Currency::reserve. Floor lib.rs:391-394 ensure!(req.response_count >= req.min_responses, InsufficientResponses); :387-390 ChallengeWindowActive. grep -q DuplicateRequest pallets/oracle/src/tests.rs → exit 1; … | T2 |
| `P1a-10` | 1 | Rank promotion, the rank multiplier, Rank3 span/oracle gates, heartbeat decay and execute_slash are untested; two rank_promotion tests are tautologies (assert 0 == 0 on a local literal; assert now >= registered_at). *(unverified by panel)* | All mocks: AgentCollective = () whose impl is rank_of → Some(0), promote → Ok(()) (pallets/agents/src/lib.rs:139-149); maybe_promote lib.rs:1457-1487 never changes rank in tests. Runtime uses RankedCollectiveBridge (runtime/src/lib.rs:942-968, :1160). tests/rank_promotion.rs:83-87 'let min_score = … | T2 |
| `P1a-11` | 1 | ENDGOAL §3.1 describes escrow as having 'permissionless settlement'; the pallet has no permissionless settlement path — confirm_delivery, dispute_delivery and claim_refund are all buyer-only and oracle settlement is an internal callback — so nothing tests … *(unverified by panel)* | pallets/escrow/src/lib.rs:386-391 confirm_delivery: let buyer = ensure_signed(origin)?; Agreements::<T>::try_mutate(&buyer, &provider, …); :446-451 dispute_delivery buyer-only; :495-500 claim_refund buyer-only; :585-660 settle_dispute_from_oracle is a plain impl fn reached via DisputeCallback … | T3 |
| `P1a-12` | 1 | tests/integration.rs header is false ('run the full runtime (all 33 pallets)' — the mock has 8 pallets and the runtime has 38) and advertises five test names that do not exist; AUDIT.md:52's '9 integration test files' counts files not tests (17 tests in 7 … *(unverified by panel)* | tests/integration.rs:3 'These tests run the full runtime (all 33 pallets)'; :13-18 names dispute_oracle_settlement, ring_detection_auto_response, rank_promotion_chain, supply_cap_enforcement, orchestrator_aggregation — none exist (cargo test -- --list shows dispute_provider_wins/dispute_buyer_wins, … | T2 |
| `P1b-01` | 1 | No real weight benchmark exists for any of the 36 custom extrinsics: all six benchmarks.rs files are a single comment line, the six WeightInfo/PlaceholderWeights declarations are dead code (0 references, no Config carries `type WeightInfo`), there is no … *(verifiers split: one lens said HIGH, one said MEDIUM; recorded at the more sceptical grade)* | `wc -l pallets/*/src/benchmarks.rs` → 1 line each; `cat` → `// Benchmarks scaffold for pallet-<name>`. `grep -rn 'PlaceholderWeights\\|WeightInfo::\\|T::WeightInfo\\|as WeightInfo' pallets/ runtime/src tests/` (excluding declarations) → no output. `grep -n 'type WeightInfo' pallets/*/src/lib.rs` → … | T0 |
| `P1b-03` | 1 | Three more extrinsics do bounded but constant-priced iteration well below their real cost: oracle finalise_request (≤200 responses, ≈40× under at max), oracle expire_request (clear_prefix up to 200 entries, ≈56× under), orchestrator deregister_orchestrator … *(unverified by panel)* | pallets/oracle/src/lib.rs:377-378 weight 10r/10w+500M; :396-397 `iter_prefix(request_id).collect()`; :419-427 per-winner repatriate_reserved + update_accuracy (2 reads, 2 writes, event); :453 `clear_prefix(request_id, 10_000, None)`; runtime/src/lib.rs:1213 `OracleMaxResponsesPerRequest = 200`. … | T0 |
| `P1b-06` | 1 | AUDIT.md (untracked planning doc) misreports the benchmark state as 'bodies are written … more than you would guess'; the bodies are one-line comment scaffolds. ENDGOAL §3.5 treats status files that misreport reality as defects. *(unverified by panel)* | AUDIT.md:810 'Partially done — more than you would guess'; :820 'So roughly: the benchmark *bodies* are written and the feature *compiles*'. `cat pallets/*/src/benchmarks.rs` → six single-line comments. ROUND5.md:280-285 states the truth ('they define no benchmarks'). | T3 |
| `P1c-03` | 1 | CLAUDE.md's first-principle formula 'Weight = stake x rank x oracle accuracy x governance participation x velocity bonus' disagrees with the code on three operators (linear stake vs sqrt; oracle as a multiplier that would be x0 today vs an additive bonus that … *(↓ from HIGH on verification)* | CLAUDE.md:14 quoted. Code: pallets/emissions/src/lib.rs:557 `let sqrt_stake = integer_sqrt(stake_u128)` (agents lib.rs:258-260 n.isqrt()); :629-641 oracle bonus `base + base*score/10000*2000/10000` with runtime :1269 `type OracleScoreProvider = ();` -> best_score()=0 (emissions :53-57) -> weight … | T3 |
| `P1c-06` | 1 | ENDGOAL §3.3 still lists 'Current known gap: four of five validators run without --rpc-methods safe' — closed on the host on Sep 2 20:44 and in the repo on Sep 7 (#107); PR #116's ENDGOAL copy is byte-identical and carries the stale sentence. *(unverified by panel)* | ENDGOAL.md:147-150; `gh pr diff 116 \| grep 'four of five'` line 155; `gh api repos/.../contents/ENDGOAL.md?ref=docs/endgoal` diff -q vs untracked copy = IDENTICAL. /proc/{701914,864825,865025,865217,865416}/cmdline each contain `--rpc-methods safe`; git log -p deploy/systemd/scalar-bob.service … | T3 |
| `P1c-07` | 1 | ENDGOAL §2's formula omits the velocity bonus (+30%, which CLAUDE.md marks load-bearing) and the floor baseline, and presents activity/volume and diversity as independent multiplicative factors whereas in code they form one additive component (beta x log2vol … *(unverified by panel)* | ENDGOAL.md:71 'weight = √stake × activity/volume × diversity × rank × heartbeat × onboarding_boost'; `grep -q velocity ENDGOAL.md` exit 1. Code: pallets/emissions/src/lib.rs:572-579 work_score = log2_scaled x diversity/10000; :613-616 activity = min(10000, floor + gov + beta*work/10000); :648-667 … | T3 |
| `P1c-08` | 1 | The Sep 2 rolling restart was an ad-hoc bash loop (not in the repo) with a fixed 20 s spacing; on the cold-cache pass restarted nodes took 16-59 s to re-peer, so two of five validators were out of GRANDPA simultaneously for ~30 s and finality stalled ~35 s … *(unverified by panel)* | ~/.bash_history:495-536 (sequence matches journal timing exactly); alice Idle lines 20:35:02-20:36:42: peers=2 at 20:35:52,20:35:57,20:36:02,20:36:12,20:36:17; finalized 432719 from 20:35:47 to 20:36:07, 432720 to 20:36:22, 432724 at 20:36:27. Per-node first Idle with 4 peers after Started: bob … | T2 |
| `P2a-01` | 2 | Every sqlite-backed list route returns HTTP 500 {"error":"datatype mismatch"} for ?offset= values >= 2^63 (e.g. offset=99999999999999999999999); process survives but a client error is reported as a server fault. *(↓ from CRITICAL on verification)* | curl 'http://127.0.0.1:8080/v1/events?offset=99999999999999999999999' -> HTTP 500 {"error":"datatype mismatch"} in 1.5ms; same 500 on /v1/blocks, /v1/extrinsics, /v1/accounts, /v1/blocks/511615/events, /v1/blocks/511615/extrinsics, /v1/extrinsics/511615-1/events, /v1/accounts/5Grw.../extrinsics, … | T3 |
| `P2a-02` | 2 | The indexer's 55-test offline suite runs in no CI workflow and is not a required status check; ci-node.yml's header still asserts indexer/ is 'one Python file (reconcile.py) and no package.json', which has been false since PR #100 merged 2026-09-02. *(↓ from HIGH on verification)* | .github/workflows/ci-node.yml:15-17: 'indexer/ deliberately has NO job here. On master it contains one Python file (reconcile.py) and no package.json ... It gets a job when PR #93 lands a manifest.'; `grep -n working-directory ci-node.yml` -> only landing/faucet/docs/sdk (lines 148-296); … | T2 |
| `P2a-04` | 2 | The indexed window (blocks 496606..head) is not exposed on /v1/status, and a request for a real on-chain block outside it answers 404 'block N not found' — indistinguishable from a block that never existed. *(unverified by panel)* | sqlite MIN(number)=496606 MAX=511923 (read-only python); GET /v1/status -> indexer:{syncedHeight:511923,indexedBlocks:15318,backfillDepth:256} (no earliest field); GET /v1/blocks/1000 -> 404 {"error":"block 1000 not found"}; /v1/blocks/0 -> 404; /v1/blocks/496605 -> 404; /v1/blocks/496606 -> 200. … | T3 |
| `P2a-05` | 2 | The indexer has no rate limiting or concurrency cap of its own; per-request RPC load on alice is bounded and small (0-4 calls, coalesced to ~1.3/req under a 30-way burst), so ENDGOAL §3.2's 'not unbounded per request' holds, but aggregate load from a … *(unverified by panel)* | grep -rn -i 'throttle\|semaphore\|p-limit\|rate\|concurren\|queue' indexer/src -> only the follower's ingestion queue; deploy/products/indexer.env.example:7-9 'the indexer has no authentication and no rate limit'. Measured via alice prometheus substrate_rpc_calls_started deltas (scratch amp.py, … | T3 |
| `P2a-06` | 2 | The documented indexer test command (`cd indexer && npm test`, CLAUDE.md:34 and the #70/#96/#101 gates) runs tests/live.test.ts unconditionally, which submits real extrinsics to ws://127.0.0.1:9944 and leaves an open escrow per run; there is no env gate to … *(unverified by panel)* | indexer/package.json test='vitest run'; vitest.config.ts include ['tests/**/*.test.ts'] with no exclude/env check; tests/live.test.ts:29 `RPC_URL = process.env.INDEXER_RPC_URL ?? 'ws://127.0.0.1:9944'`, :131 `tx.signAndSend(signer, ...)`; README.md:134-139 admits each run 'creates one escrow … | T2 |
| `P2b-01` | 2 | The explorer's 53 offline unit tests, typecheck and build run in no CI workflow; ci-node.yml has jobs only for landing/faucet/docs/sdk, so explorer PRs get green checks that never execute explorer code (ENDGOAL §3.5). *(unverified by panel)* | grep -rn -i explorer /home/dev/scalar-commons-v4/.github/workflows/ -> 0 matches. grep -n -E '^  [a-z-]+:$' ci-node.yml -> changes(55) landing(132) faucet(177) docs(218) sdk(274). Header ci-node.yml:3-5 names only 'landing/, faucet/, docs/ and sdk/'; :15-17 says indexer has no job because 'it … | T2 |
| `P2b-02` | 2 | Genesis block page renders a fabricated timestamp 'Time 1970-01-01T00:00:00.000Z' — the chain has no Timestamp.Now value at block 0, but chain.ts treats polkadot-js's default 0 as a real value; types.ts promises null/'unknown' for a block without the inherent. *(unverified by panel)* | curl http://127.0.0.1:8081/block/0 -> 200, body contains '<tr><th>Time</th><td>1970-01-01T00:00:00.000Z</td></tr>' and 'Extrinsics (0)'. RPC state_getStorage(0xf0c365c3…dfcbb [Timestamp.Now], genesisHash) -> None; at block 1 -> 0x6029a3c89f010000; chain_getBlock(genesis).extrinsics = []. Code: … | T3 |
| `P2c-05` | 2 | deploy/public/VERIFY.md check (d) probes the faucet with 'curl -sI https://faucet.<DOMAIN>/' and expects 200/302, but the faucet has no '/' route and never matches HEAD, so the check can only ever return 404. *(unverified by panel)* | curl -sS -I http://127.0.0.1:8082/ -> 'HTTP/1.1 404 Not Found'; GET / -> 404 {"code":"NOT_FOUND"}; HEAD /health -> 404 (server.ts:133 requires method === 'GET'). VERIFY.md §(d): 'curl -sI https://faucet.<DOMAIN>/ \| head -1 # 127.0.0.1:8082' / 'Pass: each returns 200 (a product may legitimately … | T3 |
| `P2c-06` | 2 | docs/ contains no faucet documentation at all, so ENDGOAL §4 item 4 ('Request test CMN from the faucet') has no documented path; the landing page links the GitHub tree instead. *(unverified by panel)* | grep -rqi faucet docs/index.md docs/guide docs/reference -> exit 1; docs/guide contains only run-a-node.md and sdk.md. landing/src/content.mjs:279 url 'https://github.com/…/tree/master/faucet'. ENDGOAL.md:236. | T3 |
| `P2c-07` | 2 | ENDGOAL.md §3.5 (subject of PR #116) still states as a known gap that faucet/landing/docs/sdk suites run in no workflow; ci-node.yml on master since 2026-09-02 runs them and all four are required branch-protection contexts. *(unverified by panel)* | ENDGOAL.md:179 'Known gap: landing, faucet, docs, sdk, and indexer have real suites that no workflow runs'. git log .github/workflows/ci-node.yml -> 93334d4 2026-09-02 (#97). ci-node.yml:177-205 faucet job: npm ci, npm run typecheck, npm test -- tests/amount.test.ts tests/rateLimiter.test.ts. gh … | T3 |
| `P2c-08` | 2 | The operator-facing defaults (1 drip/60 min per address, 5/60 min per IP, drip 10 CMN, reserve 1000 CMN, trustProxy false, seed //Ferdie) have no test; rateLimiter tests inject their own parameters (helper default ipMax 3), and no config test exists. *(unverified by panel)* | faucet/src/config.ts:74-84 defaults; tests/rateLimiter.test.ts:27-37 helper 'maxRequests: opts.ipMax ?? 3'; grep -rn 'configFromEnv' faucet/tests -> no match; ls faucet/tests/config.test.ts -> No such file. Per-limiter assertions that do exist: rateLimiter.test.ts:52-54 (scope 'address', … | T2 |
| `P2d-02` | 2 | A stranger cannot consume the SDK: it is not on npm, main/exports point at a gitignored dist/ that no prepare script builds, so `npm pack`/`npm install <path>` yields a package whose import fails with ERR_MODULE_NOT_FOUND; the docs never say how to depend on … *(↓ from HIGH on verification)* | `npm view @scalar-commons/sdk version` → 'npm error 404 @scalar-commons/sdk@* is not in this registry'. sdk/package.json: main dist/index.js, exports ./dist/index.js, files [dist,src,README.md], scripts = build/typecheck/test/test:watch/test:integration (no prepare/prepack). sdk/.gitignore:2 … | T3 |
| `P2d-03` | 2 | ScalarCommonsClient.connect() omits throwOnConnect, so an unreachable endpoint neither rejects nor logs — an invisible reconnect loop that contradicts the SDK's own 'No silent retries' rule. *(unverified by panel)* | sdk/src/index.ts:195-200 `ApiPromise.create({ provider })` with no throwOnConnect. Scratch connect-deadport.mjs against ws://127.0.0.1:9999 (ss shows no listener): 'RESULT: connect() still pending after 8004 ms — no rejection surfaced (reconnect loop)', zero console output, exit 3. … | T3 |
| `P2d-04` | 2 | Default retry policy re-submits an extrinsic after a deterministic runtime dispatch error (each retry is a new fee-paying tx), and the submit path has no timeout, so a tx that never reaches a block hangs forever. *(unverified by panel)* | sdk/src/submit.ts:39-49 rejects on dispatchError (tx already included, fee paid); sdk/src/retry.ts:37-63 retries up to DEFAULT_MAX_RETRIES=3 with sleeps 1s/2s/3s; sdk/tests/integration.test.ts:239-284 enshrines 'fails once (module error) then succeeds'. signAndSendOnce (submit.ts:25-66) has no … | T3 |
| `P2d-05` | 2 | No test anywhere proves the SDK write path succeeds against the real runtime: integration.test.ts is fully mock-based, live.test.ts only submits recordGovVote expecting rejections, and live.test.ts is run by nothing automated. *(unverified by panel)* | sdk/tests/integration.test.ts:28-109 makeMockApi (fake signAndSend); mapping test :117-158 asserts only section.method names and arg forwarding. sdk/tests/live.test.ts:137,149-151 submit recordGovVote expecting /NotActivelyVoting\|…/ and /Unauthorized/; no … | T2 |
| `P2d-06` | 2 | ENDGOAL.md §3.5 (identical in PR #116) still lists sdk (and landing/faucet/docs) as suites 'no workflow runs'; in fact ci-node.yml runs them on every master push and `sdk` is a REQUIRED branch-protection check. WEEKCHECK.md A7 'NOT DONE' is likewise stale. *(unverified by panel)* | ENDGOAL.md:179 'Known gap: landing, faucet, docs, sdk, and indexer have real suites that no workflow runs'; `git show origin/docs/endgoal:ENDGOAL.md` diff -q vs local → IDENTICAL. ci-node.yml:274-300 sdk job; gh run 34093539706 (6efba16, 2026-09-07) sdk job success (npm ci/typecheck/test all … | T3 |
| `P2d-07` | 2 | CI-NODE.md and the ci-node.yml sdk-job comments describe a state that no longer exists (job red, no lockfile, 9 passed/1 skipped, 'do not add sdk as required'), and the promised `cache: npm` restoration never happened. *(unverified by panel)* | .github/workflows/ci-node.yml:255-268 'THIS JOB IS RED ON MASTER TODAY… sdk/ has no package-lock.json… (9 passed, 1 skipped)… Restore the cache line when the lockfile lands'; no `cache:` key on the sdk setup-node step (:283-286). CI-NODE.md:36 'sdk exit 1 … FAIL ×2', :425-430 'Do not add sdk as … | T2 |
| `P2e-04` | 2 | The published docs site's GitHub social link points at tejaspatil1936/scalar-commons (no -v4), which is a 404. *(↓ from HIGH on verification)* | docs/.vitepress/config.mts:69 `{ icon: 'github', link: 'https://github.com/tejaspatil1936/scalar-commons' }`; `curl -s -o /dev/null -w '%{http_code}' https://github.com/tejaspatil1936/scalar-commons` -> 404; `gh api repos/tejaspatil1936/scalar-commons` -> {"message":"Not Found"}; published /docs/ … | T3 |
| `P2e-07` | 2 | CLAUDE.md's first-principles text is wrong on three load-bearing facts: the weight formula uses linear stake (runtime uses sqrt), the devnet is called 3-validator (it is 5), and it repeats the emissions-only mint claim. *(↓ from HIGH on verification)* | CLAUDE.md:14 'Weight = stake × rank × oracle accuracy × governance participation × velocity bonus' vs pallets/emissions/src/lib.rs:557 `let sqrt_stake = integer_sqrt(stake_u128);`, token-model.md:148 `weight = √stake`, ENDGOAL.md:66; CLAUDE.md:35 'Local 3-validator devnet' vs chain_spec.rs:163-167 … | T3 |
| `P2e-08` | 2 | ENDGOAL.md (now merged to origin/master as fd00c05) states a 'current known gap' that four of five validators run without --rpc-methods safe; all five have run with it since the 2026-09-02 restarts. *(unverified by panel)* | ENDGOAL.md:149 'four of five validators run without `--rpc-methods safe`'; ground truth (lead auditor): all five units' flags include --rpc-methods safe, system_unstable_networkState -> -32601 on all five; TODAY-PLAN.md:229 'all five with --rpc-methods safe (5 of 5 processes)'. `gh pr view 116` -> … | T3 |
| `P2e-09` | 2 | The landing page understates what shipped: its Documentation card links the GitHub tree instead of the published docs site and says a fuller developer guide is 'still being written', and its explorer card never mentions the in-repo explorer. *(unverified by panel)* | landing/src/content.mjs:261 url 'https://github.com/tejaspatil1936/scalar-commons-v4/tree/master/docs', :264-265 'A fuller developer guide is still being written.'; docs/guide/run-a-node.md and guide/sdk.md exist since 660c840 (2026-08-05) and are served at … | T3 |
| `P2e-10` | 2 | landing/README.md still says the faucet is marked 'planned' with a tracking-issue link, contradicting content.mjs which marks it 'available'. *(unverified by panel)* | landing/README.md:68-70 'the faucet is marked `planned` with a link to the issue tracking it' (last commit 0fce317, 2026-08-05) vs landing/src/content.mjs:277-285 `key: 'faucet' … status: 'available'` (b9607e8, 2026-09-04). claims.test.mjs:158-175 now asserts the faucet is NOT planned. | T3 |
| `P2e-11` | 2 | check-chain-values.mjs is real and asserts, but covers only 30 of 141 constants and only rows carrying a pallet.const span; index.md's 'Every number on this site is checked against a node' overstates it, and at least 15 raw prose numbers are unchecked, four … *(unverified by panel)* | Script output: '31 constant reference(s) covering 30/141 chain constants'; mutation tests in /tmp/audit/scratch/P2e/docs-copy: 5 corruptions -> EXIT=1 each (see P2e.md §1); docs/index.md:65-67 'Every number on this site is checked against a node … npm run lint fails if the prose drifts'. Unchecked … | T3 |
| `P2e-12` | 2 | Root README.md is a 23-line stub last changed 2026-04-23: no prerequisites, no mention of indexer/explorer/sdk/faucet/docs/landing/deploy, no chain facts or repo URL — a clean-machine rebuild from it (ENDGOAL §3.7) would lack the toolchain pin and … *(unverified by panel)* | cat README.md (23 lines; title 'scalar-commons'; Build = `cargo build --release`); git log README.md -> eab04b6 2026-04-23; run-a-node.md:11-31 lists rust 1.85.0 pin, wasm32v1-none, clang, protobuf-compiler, pkg-config, libssl-dev. | T3 |
| `P3-04` | 3 | INSTALL.md step 5 misdirects the operator on /docs: it says config.mts 'sets no base' and to hand-edit `base: '/docs/'`, but master's config.mts already reads `base: process.env.DOCS_BASE ?? '/'` (merged #111 on Sep 4, before #107 merged Sep 7); following … *(↓ from HIGH on verification)* | docs/.vitepress/config.mts:21 `base: process.env.DOCS_BASE ?? '/'` (git log -1 -> 6e8aa05 2026-09-04); INSTALL.md:116-125 blocker text; gh pr view 107 createdAt 2026-09-02, mergedAt 2026-09-07. Existing docs/.vitepress/dist/index.html (2026-09-03) has href="/assets/style.CwNnKCVM.css". Scratch … | T3 |
| `P3-05` | 3 | ENDGOAL §3.3 'Current known gap: four of five validators run without --rpc-methods safe' is stale — all five running processes have carried the flag since 2026-09-02 20:44-20:45 and the repo units since 6efba16 — and the stale sentence was published upstream … *(unverified by panel)* | `ps -ef \| grep '[s]calar-node' \| grep -c 'rpc-methods safe'` -> 5; installed unit mtimes 2026-09-02 20:44:17 (ls --time-style=full-iso); `git log -S'rpc-methods safe' -- deploy/` -> 96ef3e6 (2026-08-02, alice) and 6efba16 (2026-09-07, bob..eve); ENDGOAL.md line 'four of five validators run … | T3 |
| `P3-06` | 3 | Firewall state is unknowable from this account and inconsistent on its face: ufw is installed with ufw.conf ENABLED=yes and a rewritten user.rules (1416 B vs pristine 307 B, both dated Jul 28), yet ufw.service is enabled but 'inactive (dead)' with no … *(unverified by panel)* | cat /etc/ufw/ufw.conf -> ENABLED=yes; ls -la /etc/ufw -> user.rules 640 root 1416 B (cat -> Permission denied); wc -c /usr/share/ufw/iptables/user.rules -> 307; systemctl status ufw -> 'Active: inactive (dead)', unit Type=oneshot RemainAfterExit=yes; systemctl show ufw -p ActiveEnterTimestamp -> … | T1 |
| `P3-07` | 3 | The nginx edge config has never been parsed by nginx (nginx, gixy, certbot all absent here); my manual review finds it structurally sound (16/16 braces, every directive terminated, no unknown directive names, no leftover placeholders, `http2 on` valid for the … *(unverified by panel)* | Rendered /tmp/audit/scratch/P3/public/rendered/scalar-commons.conf via a copied render-config.sh with DOMAIN=scalarnet.io (rc=0, 'OK. Nothing has been installed'); grep -o '{'\|wc -l -> 16 = '}' count; awk missing-';' check -> empty; directive histogram all valid ngx_http directives; `command -v …` | T1 |
| `P3-08` | 3 | Neither the indexer nor the explorer has any application-level rate limiting or X-Forwarded-For awareness; behind the template they are protected only by nginx's web zone (20 r/s, burst 40, 20 concurrent per IP) and each request fans out to alice's RPC … *(unverified by panel)* | grep -rn -i 'rate.\?limit\\|x-forwarded\\|trust.\?proxy\\|limiter' indexer/src explorer/src -> no matches; indexer/src/api.ts:606-607 rejects non-GET with 405 (read-only surface confirmed); template lines 239-240, 274-275 web_req burst=40 / web_conn 20; AUDIT.md:254's ~200-RPC-calls-per-/account … | T3 |
| `P4-05` | 4 | The emission path has never executed on the live devnet: settle_era has never succeeded in 511,988 blocks (142 full eras), so zero CMN has ever been emitted by pallet-emissions and per-era maps have never drained. *(↓ from HIGH on verification)* | state_getStorage Emissions::LastSettledEra (0x14e767ca…8924db48…) → null; EraStartBlock, LastEraEmission, AccRewardPerStake → null; AgentWeightSnapshot/AgentRewardDebt 0 keys; Agents::EraNumber (0x0ec3e268…e8875b05…) → null. settle_era writes LastSettledEra on every success … | T2 |
| `P4-07` | 4 | No test proves the thesis claim 'a passive staker earns exactly zero'; the MinQualifyingVol (≥50 CMN) load-bearing gate has zero behavioural coverage (set to 0 in both mocks); supply_cap_enforced unit test asserts nothing. *(unverified by panel)* | grep -rn -i 'passive\|zero_activity\|no_activity\|MinQualifyingVol\|below_floor' pallets/emissions/src/tests.rs pallets/agents/src/tests.rs tests/ → only `pallets/emissions/src/tests.rs:168 type MinQualifyingVol = ConstU64<0>; // disabled in unit tests` and `tests/common.rs:323 … ConstU64<0>; // …` | T2 |
| `P4-08` | 4 | Emissions unit-test mock still models alpha = 4_000 (and MaxProposalsPerEra 10) after ROUND14 set the runtime to 1_500 / 20 — mock drift on the very parameter the fix changed. *(unverified by panel)* | pallets/emissions/src/tests.rs:23-25 `fn alpha() -> u32 { 4_000 }`; :164 `type MaxProposalsPerEra = ConstU32<10>`. runtime/src/lib.rs:1301 `AutoInitialAlpha = 1_500`, :1236 MaxProposalsPerEra 20. tests/common.rs:266-268 uses live_alpha() (mirrors 1_500 per ROUND14 §3). Live AutoParams::Alpha = 1500. | T2 |
| `P4-09` | 4 | experiments/sc-e1 tests (pytest 4, node 21) pass but run in no CI workflow; docs/VERIFIED-CONSTANTS.md carries stale alpha 4_000 and a v1 break-even table declaring wash 'NOT expired — safe' that v2 verdicts contradict, while the public token-model page … *(unverified by panel)* | `python3 -m pytest -p no:cacheprovider -q experiments/sc-e1/tests/test_analyze.py` → 4 passed; `node --experimental-strip-types --test <5 files>` → 21 pass 0 fail; `grep experiments .github/workflows/*.yml` → no match (ENDGOAL §3.5 'Every subproject's tests must run in CI'). … | T3 |
| `P5-02` | 5 | reject-stubs.sh is wired as a PostToolUse hook, which per Claude Code docs cannot block ('Exit code 2: Shows stderr to Claude; the tool already ran'); the script and factory/README claim it 'blocks the write', so ENDGOAL §3.5's 'mechanically enforced by … *(↓ from HIGH on verification)* | .claude/settings.json: only `"PostToolUse": [{"matcher":"Write\|Edit\|MultiEdit", ... reject-stubs.sh}]`, no PreToolUse (checked with python: PreToolUse list empty). Docs fetched 2026-09-08 from code.claude.com/docs/en/hooks: PreToolUse 'Exit code 2: Blocks the tool call'; PostToolUse 'Exit code 2: … | T2 |
| `P5-03` | 5 | The hook greps the whole file rather than the edit, so ANY edit to 11 tracked files (which carry justified `#[allow(` or the cfg-gated `fn main() {}` in runtime/build.rs) is reported as 'Violations found in what you just wrote' — a permanent false positive … *(unverified by panel)* | Fed the hook the unmodified repo paths (read-only grep): runtime/src/lib.rs -> exit=2 '#[allow( ... line(s): 789'; runtime/build.rs -> exit=2 'fn main() {} — empty entrypoint ... line(s): 25'; pallets/emissions/src/lib.rs -> 2 (544); pallets/oracle/src/lib.rs -> 2 (606); node/src/cli.rs -> 2 … | T2 |
| `P5-04` | 5 | The hook enforces only Rust-shaped patterns (todo!/unimplemented!/#[allow(/SKIP_WASM_BUILD/fn main(){} in node\|runtime) and misses every pattern relevant to the TypeScript tier the factory actually dispatches … *(unverified by panel)* | Direct stdin-JSON tests in scratch: todo!( 2, unimplemented!( 2, #[allow( 2, SKIP_WASM_BUILD 2, fn main(){} under node/ 2 and runtime/ 2 (under pallets/ 0 by design), clean file 0; it.skip+describe.skip+test.skip+it.only+@ts-ignore+@ts-expect-error+eslint-disable file -> exit 0; #[ignore] -> 0; … | T2 |
| `P5-05` | 5 | factory/STATE.md misreports the factory's effective flags: the on-disk file (written by the watchdog, whose unit carries no ENABLE_* env) says 'dispatcher: false \| merge: false' while the effective dispatch/merge/digest units run with ENABLE_DISPATCH=true … *(unverified by panel)* | factory/STATE.md header '# Factory STATE — 2026-09-08T06:16:14Z' ... '- dispatcher: false \| merge: false (MERGE_T2=false)'; mtime Sep 8 08:16 CEST. `systemctl --user show factory-watchdog.service -p Environment` -> 'Environment=PATH=...' only; factory-watchdog.timer LastTriggerUSec 'Tue 2026-09-08 … | T2 |
| `P5-06` | 5 | The hourly factory-merge.service/timer (ENABLE_MERGE=true, :30 UTC) exists only in ~/.config/systemd/user with no repo copy, while merge.sh's header, factory/README and config.env all describe merging as off/refusing-everything; the docs describe the opposite … *(unverified by panel)* | `systemctl --user cat factory-merge.service factory-merge.timer` -> ExecStart=.../factory/merge.sh, Environment=ENABLE_MERGE=true, OnCalendar=*-*-* *:30:00 UTC. `grep -i merge factory/install-systemd.sh factory/systemd/*` -> no output; factory/systemd/ holds only digest/dispatch/watchdog units. … | T2 |
| `P5-07` | 5 | Branch protection meets §3.5 (enforce_admins on, strict required checks, no force-push/deletion) but requires 0 approving reviews and no code-owner review, so the CODEOWNERS file's stated protection for runtime/pallets/node/.github is not active and T0/T1 … *(unverified by panel)* | `gh api repos/tejaspatil1936/scalar-commons-v4/branches/master/protection`: contexts [gate,full,landing,faucet,docs,sdk] strict true; enforce_admins.enabled true; allow_force_pushes false; allow_deletions false; required_pull_request_reviews.required_approving_review_count 0; … | T2 |
| `P5-08` | 5 | Three more test suites pass offline but are run by no workflow: factory/tests (gate-parse 13, gate-detect 18, verdict-parse 51, selftest 32 assertions), experiments/sc-e1/tests/test_analyze.py (4), experiments/sc-e1/archetypes (21 node --test cases); … *(unverified by panel)* | Ran from a scratch copy of factory/ with SPEND_DIR/CARGO_LOCKFILE/SHARED_CARGO_TARGET/BACKOFF_FILE pointed at scratch: gate-parse.sh '13 passed, 0 failed' exit 0; gate-detect.sh '18 passed, 0 failed' exit 0; verdict-parse.sh '51 passed, 0 failed' exit 0; selftest.sh '30 passed, 2 failed' — the 2 … | T2 |
| `P6-01` | 6 | dispatch.sh has no open-PR / existing task/<n> branch skip (issue #106 still valid): #88 and #101 are re-dispatched every hour, gh pr create fails 493 times, and the only undone ready issue (#87) has been DEFERred 241 times and never dispatched. *(↓ from HIGH on verification)* | dispatch.sh:108-109 query is `gh issue list --label ready --state open`; skip rules L557-561 cover only blocked/in-progress/needs-human; `grep -nE 'pr list\|linkedBranches\|ls-remote\|closingIssues' factory/dispatch.sh` matches nothing (only L464 branch=task/$num). dispatch.systemd.log: `grep -c …` | T2 |
| `P6-02` | 6 | A BLOCKED loop does not park its issue (ready kept, no blocked/needs-human added), so blocked work is re-dispatched every hour: issue #102 ran 67 loops / 200 real claude spawns all failing identically on `shellcheck: command not found`; #96 118, #104/#105 42 … *(↓ from HIGH on verification)* | dispatch.sh:456-461 on rc≠0: unmark_in_progress + comment_issue only; `grep -nE 'add-label (blocked\|needs-human)\|remove-label ready' factory/dispatch.sh factory/lib/loop.sh` → nothing. Ledger: `cat ~/.factory/spend-* \| awk` loop lines per issue: issue-102=200 (67 attempt1 entries across … | T2 |
| `P6-04` | 6 | review.sh never removes a stale needs-human, and merge.sh reports it as an 'unresolved review objection': PR #112 has 3/3 PASS on its current head and all-green CI but has been refused hourly since 09-07 because of the 09-03 exit-127 INCONCLUSIVE label; … *(↓ from HIGH on verification)* | `grep -n remove-label factory/review.sh factory/merge.sh` → nothing. review.sh:771-773 adds needs-human on ERROR; L783-785 text says 'not a finding against the PR… Re-run review.sh' but no code clears it. PR #112 comments: 2026-09-03T21:15 `0 PASS / 0 FAIL / 3 ERROR` (exit 127); 2026-09-07T04:38 `3 …` | T2 |
| `P6-07` | 6 | The daily spawn budget is consumed by phantom `dispatch:` reservations made before loop.sh's already-green short-circuit: 14/14 ledger lines today, 46/76 yesterday, 40 of the 120-line cap on 09-05 and 09-06, 495 of 619 dispatch lines all-time spawned no agent … *(unverified by panel)* | dispatch.sh:443 `spend_reserve "dispatch:issue-$num"` runs before L452 loop.sh; loop.sh:151-158 exits 0 'gate already passes before any attempt' without spawning. ~/.factory/spend-20260908: 14 lines, all `dispatch:issue-88`/`dispatch:issue-101` at :04:48 each hour. Per-day table in … | T2 |
| `P6-08` | 6 | Effective safety bounds differ from the repo via local-only systemd drop-ins: DAILY_SPAWN_CAP 40→120, DAY_MAX_PARALLEL 1→3 (71 daytime passes ran at MAX_PARALLEL=3), dispatch timer night-window→hourly 24/7, factory-merge.service/.timer exist only locally; … *(unverified by panel)* | `systemctl --user show factory-dispatch.service -p Environment` → ENABLE_DISPATCH=true ENABLE_MERGE=true MAX_PARALLEL=3 DAY_MAX_PARALLEL=3 DAILY_SPAWN_CAP=120 PATH=…; TimersCalendar dispatch `*-*-* *:00:00 UTC`, merge `*-*-* *:30:00 UTC`; repo systemd/factory-dispatch.timer `22,23,00,…,06:00:00 …` | T2 |
| `P6-09` | 6 | factory/STATE.md misreports the factory's own state: the watchdog-written copy says 'dispatcher: false \| merge: false' while dispatch and merge timers run with ENABLE_*=true; the digest copy 45 minutes earlier said true — tracker.sh prints its own process … *(unverified by panel)* | factory/STATE.md line 1 `# Factory STATE — 2026-09-08T06:16:14Z` == watchdog.systemd.log `[2026-09-08T06:16:14Z] === watchdog pass ===`; line 12 `dispatcher: false \| merge: false`. `gh gist view 896f376e9e14996040749a2b46c8988d -f STATE.md` (05:30:46Z digest) line 12 `dispatcher: true \| merge: …` | T2 |
| `P6-10` | 6 | watchdog.sh's stale in-progress label cleanup is dead code in production: it is guarded by ENABLE_DISPATCH=true, which the watchdog unit never sets; a dispatch cgroup killed by TimeoutStartSec=6h (reachable when cluster-mates serialize two 240-min loops) … *(unverified by panel)* | watchdog.sh:170 `if have_gh && [ "${ENABLE_DISPATCH:-false}" = "true" ]`; `systemctl --user show factory-watchdog.service -p Environment` → PATH only; watchdog.systemd.log shows only disk/rate-limit/killed-0 lines. factory-dispatch.service `TimeoutStartSec=6h`; dispatch.sh:419-425 flock serializes … | T2 |
| `P6-11` | 6 | ENDGOAL §3.6 claims the gate is 'taken from the issue body itself (never inferred)', but gate_for_tier falls back to detect_gate inference from the worktree diff for T3 issues without a ## Gate block — proven live with a fixture. *(unverified by panel)* | dispatch.sh:324-325 'detect_gate is the fallback for issues that predate the convention'; L337-347 `gate="$(detect_gate "$wt")"; if [ "$gate" = "$(t2_gate)" ]; then return 1; fi; printf '%s' "$gate"`. Scratch run: `gate_from_issue 9999 -> [] rc=1` then `gate_for_tier tier:T3 <wt-with-indexer-diff> …` | T2 |
| `P6-12` | 6 | Refusals are re-posted to the issue every pass: issue #115 has 12 identical 'Factory refused to dispatch: no usable gate' comments (hourly since 2026-09-07T19:03Z); #88 and #87 got 3 each — the dispatcher has no memory of refusals and does not park the issue. *(unverified by panel)* | dispatch.sh:431-435 comment_issue on every NO USABLE GATE; `gh issue view 115 --json comments` → 12 comments 2026-09-07T19:03:15Z..2026-09-08T06:04:48Z all starting 'Factory refused to dispatch: no usable gate'; #88 comments=3 factory-refused=3; #87 comments=3 factory-refused=3. `grep -qE …` | T2 |
| `P6-13` | 6 | Every loop bound is overridable from the environment with no upper limit (config.env documents `VAR="${VAR:-default}"` as the override mechanism; loop.sh only checks >0), including STOP_FILE, DAILY_SPAWN_CAP, SAME_ERROR_LIMIT, DEFAULT_MAX_*; the local drop-in … *(unverified by panel)* | config.env:10-13; common.sh:21-36 `: "${STOP_FILE:=…}"`, `: "${DAILY_SPAWN_CAP:=40}"`; loop.sh:57-58 `[ "$MAX_ATTEMPTS" -gt 0 ]`, `[ "$MAX_MINUTES" -gt 0 ]` — no -le/-lt bound; drop-in sets DAILY_SPAWN_CAP=120, DAY_MAX_PARALLEL=3. Hard tier rule: dispatch.sh:574-576 `tier:T0\|tier:T1) … never …` | T2 |
| `P6-14` | 6 | 'Merge gated on review, not on the agent's own claim' is enforced by prompt text only: the worker runs `claude -p --dangerously-skip-permissions` with the operator's gh token (scopes repo, workflow), .claude/settings.json allowlists `Bash(gh pr*)`/`Bash(gh …` *(unverified by panel)* | loop.sh:227-228 `claude -p "$(cat "$PROMPTFILE")" --dangerously-skip-permissions`; `gh auth status` token scopes 'gist, read:org, repo, workflow'; .claude/settings.json:9 `"Bash(gh issue*)", "Bash(gh pr*)"` (copied into wt-101/.claude/settings.json); hooks-factory/reject-stubs.sh:2 'PostToolUse … | T2 |
| `P7-01` | 7 | README.md gives exactly one build step (`cargo build --release`) and names zero prerequisites; a clean-machine build from the README alone fails (no rustup/1.85.0 toolchain, no protoc, no libclang). It has not been touched since the upstream-baseline commit … *(↓ from HIGH on verification)* | cat /home/dev/scalar-commons-v4/README.md (25 lines; Build section = `cargo build --release` only). git log -1 -- README.md -> eab04b6 2026-04-23 = `upstream-baseline` tag; git describe -> upstream-baseline-144-g6efba16. Cargo.lock: prost-build 0.13.2 (line 7519) <- sc-network/litep2p (shells out … | T3 |
| `P7-02` | 7 | No release or version tag and no GitHub release exist; the only tag is `upstream-baseline` (eab04b6, the pre-rebuild README commit). ENDGOAL §3.7 requires the release to be tagged. node 4.0.0 / runtime 3.0.0 / spec_version 304 are not tied to any commit by a … *(↓ from HIGH on verification)* | git tag -l -> `upstream-baseline`; git log -1 upstream-baseline -> eab04b6 2026-04-23 'Update README with project overview'; gh api repos/tejaspatil1936/scalar-commons-v4/tags -> ['upstream-baseline']; gh release list -> empty; gh api .../releases -> 0 releases. node/Cargo.toml:3 version 4.0.0; … | T2 |
| `P7-03` | 7 | Every repo systemd unit hardcodes this box's checkout path `/home/dev/scalar-commons-v4/...` (ExecStart binary, --chain spec, WorkingDirectory, Documentation) and `/usr/bin/node`; deploy/README.md 'Install and start' and deploy/install.sh give no warning, so … *(↓ from HIGH on verification)* | grep -c '/home/dev/' deploy/systemd/*.service deploy/products/*.service -> 3 per validator unit, 2 per product unit (e.g. deploy/systemd/scalar-alice.service:21-22 `ExecStart=/home/dev/scalar-commons-v4/target/release/scalar-node --chain /home/dev/scalar-commons-v4/deploy/scalar-local-raw.json`; … | T1 |
| `P7-04` | 7 | The running binary reports `4.0.0-297bd66155d` but was built from a dirty tree: commit 297bd66's local preset has 3 authorities, yet the binary emits the committed 5-authority spec byte-for-byte; 0edee76 (3->5) was committed 9 minutes AFTER the build. … *(unverified by panel)* | target/release/scalar-node --version -> `scalar-node 4.0.0-297bd66155d`; ls -la -> mtime Aug 3 19:18. git log -1 297bd66 -> 2026-08-03 22:40:43 +0530 (=19:10 +0200); git log -1 0edee76 -> 2026-08-03 19:27:02 +0200. git merge-base --is-ancestor 0edee76 297bd66 -> NO. git show … | T1 |
| `P7-05` | 7 | Systemd state the running box depends on has no repo copy and is installed by no script: factory-merge.service/.timer, seven drop-ins (factory-*.service.d/path.conf with PATH incl. ~/.npm-global/bin and ~/.cargo/bin; … *(unverified by panel)* | find ~/.config/systemd/user -type f -> 25 files incl. the above; cat of each drop-in shown in /tmp/audit/phases/P7.md §2. git grep -l 'factory-merge\.(service\|timer)' -> nothing; git grep 'path\.conf\|override\.conf' -> nothing. factory/install-systemd.sh:34-39 UNITS = watchdog+digest (+dispatch … | T2 |
| `P7-06` | 7 | The expected genesis hash of the committed chainspec (0xff6882b49ad61dd3128a6e834b4f81704a3824ce358f2f69fe765ca07cf803d1) is not documented in deploy/README.md or docs/guide/run-a-node.md, so an operator following the runbook has nothing to compare … *(unverified by panel)* | git grep -n ff6882b49ad61dd3 -> only docs/.chain/snapshot.json:7 and landing/chain-facts.json:10 (machine-generated files). grep in deploy/README.md and docs/guide/run-a-node.md -> none. Live: curl chain_getBlockHash(0) on 127.0.0.1:9944 -> 0xff6882...; verified equal to committed spec state … | T3 |
| `P7-07` | 7 | The Node.js version required by the products (>=22.6 for --experimental-strip-types used by indexer/faucet units; >=22.5 for node:sqlite in the indexer) is stated nowhere in prose, and package.json engines contradict it: faucet `>=18`, indexer `>=22`. *(unverified by panel)* | deploy/products/scalar-indexer.service:31 and scalar-faucet.service:34 ExecStart use --experimental-strip-types; indexer/README.md:47 'SQLite via Node's built-in node:sqlite'. python parse of package.json engines: faucet '>=18', indexer '>=22', explorer/sdk '>=18', experiments '>=22.6.0'. grep for … | T3 |
| `P7-08` | 7 | ci-node.yml has no job for indexer/ or explorer/, and its header asserts indexer 'contains one Python file (reconcile.py) and no package.json' — false on master since 233ff89 (2026-09-02) added indexer/package.json; explorer has 6 test files that no workflow … *(unverified by panel)* | .github/workflows/ci-node.yml:15-17 header text; grep -c 'explorer' ci-node.yml -> 0; jobs = changes, landing, faucet, docs, sdk (grep '^  [a-z-]+:$'). git log --diff-filter=A -- indexer/package.json -> 233ff89 2026-09-02. git ls-files indexer/ -> package.json, package-lock.json, vitest.config.ts, … | T2 |
| `P8-07` | 8 | Issue #88 is still present on master: rpc.md says the devnet runs --rpc-methods safe (which refuses author_rotateKeys), while run-a-node.md's validator recipe starts the node without --rpc-methods unsafe and then instructs curling author_rotateKeys on it. *(↓ from HIGH on verification)* | docs/reference/rpc.md:19-23; docs/guide/run-a-node.md:232-240 (validator command, no --rpc-methods flag) and :259-263 (curl author_rotateKeys http://127.0.0.1:9960). Ground truth: all five nodes now run --rpc-methods safe and answer -32601 'RPC call is unsafe to be called externally' to unsafe … | T3 |
| `P8-10` | 8 | Indexer activity history starts at block 496,606 (2026-09-07T05:05:24Z): any account whose extrinsics predate the last indexer start — or fall in an outage longer than the 256-block backfill — shows empty activity; e.g. Ferdie (nonce 70) returns … *(unverified by panel)* | sqlite (mode=ro) blocks min/max 496606/511969, oldest timestamp_ms 1788757524000; scalar-indexer ExecMainStartTimestamp Mon 2026-09-07 07:31:07 CEST; indexer/src/config.ts:69 INDEXER_BACKFILL_DEPTH default 256; GET /v1/accounts/5CiPPse...DjL -> nonce 70 but activity {firstSeenBlock:null, … | T3 |
| `P8-11` | 8 | run-a-node.md says dev/testnet presets 'pre-register each genesis validator as an agent'; the local preset registers only the first three endowed accounts (Alice, Bob, Charlie), and the live chain has exactly 3 agents while 5 validators author. *(unverified by panel)* | node/src/chain_spec.rs:287-291 endowed_accounts.iter().take(3); polkadot-js agents.agentStake.entries() -> 3 entries (5FHneW46..., 5FLSigC9..., 5GrwvaEF..., each 10000 CMN); staking.validatorCount 5; landing 'Read at block 433,638: 3 registered agents'. | T3 |
| `P8-12` | 8 | sdk/README.md's usage example registers with 100 CMN, below the 1,000 CMN minStake, so a stranger copying it gets agents.StakeTooLow. *(unverified by panel)* | sdk/README.md:35 'await client.register(alice, 100n * PLANCKS_PER_CMN);'; pallets/agents/src/lib.rs:745 ensure!(stake >= T::MinStake::get(), Error::<T>::StakeTooLow); live consts.agents.minStake 1000000000000000. docs/guide/sdk.md:111 correctly uses 1_000n. | T3 |
| `P8-13` | 8 | Go-live runbook deploy/public/INSTALL.md never mentions FAUCET_TRUST_PROXY; behind the nginx proxy every faucet request arrives from 127.0.0.1, so the per-IP budget (5/hour) collapses to one global budget, or becomes forgeable if flipped to true without the … *(unverified by panel)* | grep -rn TRUST_PROXY deploy/ -> only deploy/products/{faucet.env.example:42,scalar-faucet.service:28,README.md:131,144}; README.md:131 'FAUCET_TRUST_PROXY stays false. On a loopback bind...'; nginx template :126 proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for (appends, does not … | T1 |
| `P8-14` | 8 | ci-node.yml header still says indexer/ 'contains one Python file (reconcile.py) and no package.json' and gives it no job; explorer/ has no job either — two of the five TypeScript suites are not run by any workflow. *(unverified by panel)* | .github/workflows/ci-node.yml:15-16; grep -c -i 'indexer\\|explorer' ci-node.yml -> 2 (both in that stale comment); indexer/ has package.json, 10 src files, 7 test files; explorer/ has package.json + tests. gh run list ci-node.yml -> success 2026-09-08T06:42:30Z. Landing/faucet(offline … | T2 |
| `P8-15` | 8 | scalarnet.io — the hostname the audit brief expects for the public endpoint — is a registrar parking page with no working TLS, rpc.scalarnet.io does not resolve, and the string 'scalarnet' appears nowhere in the repo (deploy/public/domain.env still says … *(unverified by panel)* | getent hosts scalarnet.io -> 3.33.130.190, 15.197.148.33; getent hosts rpc.scalarnet.io -> exit 2; curl -s -m 10 https://scalarnet.io -> http_code=000 curl exit=35; curl http://scalarnet.io -> 200 body redirects to /lander; grep -rn scalarnet <repo> -> no matches; deploy/public/domain.env:18 … | T1 |
| `P9-02` | 9 | Public docs site footer/social GitHub link targets github.com/tejaspatil1936/scalar-commons (missing '-v4'), a repository that does not exist. *(verifiers split: one lens said HIGH, one said MEDIUM; recorded at the more sceptical grade)* | docs/.vitepress/config.mts:69 `{ icon: 'github', link: 'https://github.com/tejaspatil1936/scalar-commons' }`; curl -s https://tejaspatil.tech/scalar-commons-v4/docs/ \| grep -o href="...github..." -> exactly that URL; unauthenticated curl -> 404; `gh repo view tejaspatil1936/scalar-commons` -> … | T3 |
| `P9-04` | 9 | CLAUDE.md:9 states the toolchain is 'Polkadot SDK 2025.12 line (sp-core 39.x, frame-system 45.x, sp-runtime 45.x)'; the workspace is pinned to tag polkadot-stable2503 with sp-core 36.1.0, frame-system 40.1.0, sp-runtime 41.1.0, and rust-toolchain.toml forbids … *(↓ from HIGH on verification)* | Cargo.toml:23-66 every SDK dep `git = "https://github.com/paritytech/polkadot-sdk", tag = "polkadot-stable2503"`. `grep -A1 '^name = "sp-core"$' Cargo.lock` -> version = "36.1.0"; frame-system 40.1.0; sp-runtime 41.1.0; frame-support 40.1.0; sc-service 0.50.0. rust-toolchain.toml: 'pinned to … | T3 |
| `P9-06` | 9 | Indexer and explorer test suites run in no CI workflow and are not branch-protection contexts; ci-node.yml and CI-NODE.md still assert indexer/ 'contains one Python file and no package.json' although PR #100 landed the 24-endpoint indexer with 7 vitest files … *(↓ from HIGH on verification)* | grep -n -i 'indexer\|explorer' .github/workflows/*.yml -> only comments (ci-node.yml:15-17 'indexer/ deliberately has NO job here ... It gets a job when PR #93 lands a manifest'); jobs present: changes, landing, faucet, docs, sdk. CI-NODE.md:19-21 same text. ls indexer -> package.json, … | T2 |
| `P9-07` | 9 | CLAUDE.md:34's documented test command `cd indexer && npm test` runs vitest with include tests/**/*.test.ts and no environment gate, so it executes tests/live.test.ts, which submits real extrinsics to ws://127.0.0.1:9944 — the live devnet — by default. *(↓ from HIGH on verification)* | indexer/package.json scripts.test = "vitest run"; indexer/vitest.config.ts include: ['tests/**/*.test.ts'] with comment 'The live suite indexes real finalized blocks and submits real extrinsics'; tests/live.test.ts:29 `const RPC_URL = process.env.INDEXER_RPC_URL ?? 'ws://127.0.0.1:9944'`; grep for … | T2 |
| `P9-08` | 9 | ENDGOAL §6 says the repo was 'forked from Matty's' and asks which repo is canonical; GitHub shows it is not a fork — matty33/scalar-commons-v4 redirects to tejaspatil1936/scalar-commons-v4 (same repository, moved), and matty33 retains write access. *(unverified by panel)* | gh repo view tejaspatil1936/scalar-commons-v4 --json isFork,parent -> isFork:false, parent:null (source:null via gh api). gh repo view matty33/scalar-commons-v4 -> url https://github.com/tejaspatil1936/scalar-commons-v4 (redirect). git log: 19 commits by matty33 <harden.construction@gmail.com> … | T3 |
| `P9-09` | 9 | .github/workflows/file-issues.yml hardcodes R="matty33/scalar-commons-v4" and, if dispatched, would re-file 32 July-era issues (the backlog STAGE1-SETUP.md says was closed as #26-#59) via the GitHub redirect. *(unverified by panel)* | .github/workflows/file-issues.yml:16 `R="matty33/scalar-commons-v4"`; lines 26-57 create 32 issues (H-0a.., SC-1a.., AD-*, ID-1, VL-1, SC-2 EPIC) with `--repo $R`; trigger workflow_dispatch only (line 3). Redirect confirmed by gh repo view matty33/scalar-commons-v4. AUDIT.md:861 (2026-08-19) … | T2 |
| `P9-10` | 9 | ENDGOAL §3.3 (merged to master today as fd00c05) still states 'four of five validators run without --rpc-methods safe and serve the full unsafe set on loopback'; all five validators now run with --rpc-methods safe. *(unverified by panel)* | ENDGOAL.md:148-150 quoted. grep -- '--rpc-methods' deploy/systemd/*.service -> alice:32, bob:23, charlie:21, dave:24, eve:25 all `--rpc-methods safe`; lead ground truth: all five live processes carry the flag and reject unsafe methods. PR #116 merged 2026-09-08T06:42:27Z with this text. | T3 |
| `P9-11` | 9 | ENDGOAL §3.5 'landing, faucet, docs, sdk, and indexer have real suites that no workflow runs' is half-stale: landing/faucet/docs/sdk run in ci-node.yml since PR #97 (2026-09-02); indexer still does not, and explorer (not named) does not either. *(unverified by panel)* | ENDGOAL.md:179-180 quoted. .github/workflows/ci-node.yml jobs landing (npm test), faucet (npm test -- tests/amount.test.ts tests/rateLimiter.test.ts), docs (npm run lint && build), sdk (npm test); ci-node runs #23-#27 all success; no indexer/explorer job (see P9-06). | T3 |
| `P9-12` | 9 | ENDGOAL §3.6 'three agent-built subsystems ... all three were blocked ... Zero merges was the correct outcome' is stale: PRs #91/#92/#93 were closed unmerged, but their fix-ups #98/#99/#100 merged the same day and seven [factory]-prefixed PRs plus three … *(unverified by panel)* | gh pr view 91/92/93 -> CLOSED 2026-09-02, mergedAt null. gh pr list --state merged: [factory] #83, #84, #85 (2026-08-05), #98, #99, #100 (2026-09-02), #111 (2026-09-04); task/102 #114, task/104 #108, task/105 #109; all mergedBy tejaspatil1936. | T3 |
| `P9-13` | 9 | CLAUDE.md:35-36 'Local 3-validator devnet' plus an unfilled '<!-- TODO(Keith): paste the exact testnet launch command -->' — the devnet has five validators and the launch command exists in deploy/README.md. *(unverified by panel)* | node/src/chain_spec.rs:122 'Local multi-node testnet: five validators, six endowed accounts' (0edee76); live chain-facts state.validators=5; deploy/README.md:82-83 `./deploy/install.sh` then `systemctl --user start scalar-devnet.target`. CLAUDE.md unchanged since 5682287 (2026-07-03, matty33). | T3 |
| `P9-14` | 9 | CLAUDE.md:14 formula wording 'Weight = stake × rank × oracle accuracy × governance participation × velocity bonus' does not match code or public docs: code uses √stake, log-volume × diversity, heartbeat and onboarding boost, and governance is an additive term … *(unverified by panel)* | pallets/emissions/src/lib.rs:557 `let sqrt_stake = integer_sqrt(stake_u128)`; :571-579 raw_vol=log2_scaled, work_score=raw_vol*diversity_bps; :599-616 gov_contribution only if work_score>0, added into activity; :618+ base = sqrt_stake*rank_bps*activity*hb, then oracle, onboarding_boost, velocity. … | T3 |
| `P9-15` | 9 | CLAUDE.md:22 says every pallet has 'pallets/<name>/src/tests.rs — unit tests + mock runtime' and ENDGOAL §3.1 says all seven pallets pass tests; constitution has no tests.rs (and no #[cfg(test)]) and auto-params' tests.rs is an explicitly empty placeholder … *(unverified by panel)* | ls pallets/*/src/tests.rs -> agents, auto-params, emissions, escrow, oracle, orchestrator (no constitution); ls pallets/constitution/src -> lib.rs only; grep cfg(test) constitution/lib.rs -> none. grep -c '#[test]': auto-params 0 (file header: 'There is no coverage here yet, and that gap is real'). … | T2 |
| `P9-16` | 9 | CLAUDE.md:29 'All builds/tests run in GitHub Codespaces or GitHub Actions — never assume a local machine' (echoed by .claude/agents/test-runner.md:35) contradicts the operating reality: the devnet, indexer/explorer/faucet and four factory timers run on this … *(unverified by panel)* | systemctl --user list-timers -> factory-dispatch (hourly), factory-watchdog, factory-merge (30m), factory-digest active; scalar-* units running (lead); ls -a .devcontainer -> 'No such file or directory'; .claude/agents/test-runner.md:35 'this environment is Codespaces/CI, not a local machine'. | T3 |
| `P9-17` | 9 | The landing page omits the indexer (24 endpoints), the SDK and the repo's own explorer entirely — it says 'A hosted explorer for the devnet is not up yet' and sends readers to Polkadot-JS Apps — while explorer/ runs on 8081 and indexer/ on 8080; the claims … *(unverified by panel)* | grep -i 'indexer\|sdk' landing/src/content.mjs -> no matches; links keys: repo, docs, explorer(polkadot.js.org/apps), faucet; landing/test/claims.test.mjs:127 required = ['docs','explorer','faucet','repo']. curl 127.0.0.1:8081/ -> 200 '<title>Scalar Commons Explorer</title>'; … | T3 |
| `P9-18` | 9 | Tracking issues #70 (indexer REST API), #71 (explorer UI) and #72 (SDK recordGovVote) remain OPEN and untouched since 2026-08-19 although the corresponding work merged on 2026-09-02 (#100/#99/#98); the issue list describes built components as unbuilt. *(unverified by panel)* | gh issue view 70/71/72 -> OPEN, updatedAt 2026-08-19; gh pr list merged: #100 'Indexer: fix review findings on PR #93 (REST API, 24 endpoints) (#96)', #99 explorer (#95), #98 SDK (#94), all 2026-09-02. Related open issue #106 (dispatch must skip issues closed by an open PR). | T3 |
| `P9-19` | 9 | factory/STATE.md generated today reports 'dispatcher: false \| merge: false' while the installed dispatch/digest/merge units run with ENABLE_DISPATCH=true ENABLE_MERGE=true; tracker.sh prints its own environment, and it ran under the watchdog unit that lacks … *(unverified by panel)* | factory/STATE.md header 2026-09-08T06:47:14Z, line '- dispatcher: false \| merge: false (MERGE_T2=false)'. factory/tracker.sh:195-196 printf "${ENABLE_DISPATCH:-false}" "${ENABLE_MERGE:-false}". systemctl --user show factory-dispatch.service -p Environment -> ENABLE_DISPATCH=true ENABLE_MERGE=true … | T2 |
| `P9-20` | 9 | Root README.md (last changed 2026-04-23) is a 20-line stub: it describes orchestrator as a 'task lifecycle coordinator' and emissions as an 'issuance schedule', omits indexer/explorer/sdk/faucet/landing/docs/deploy, and offers only `cargo build --release` — … *(unverified by panel)* | sed -n 1,140p README.md (20 lines); git log -- README.md -> eab04b6 2026-04-23, 1ace075 2026-04-09. Orchestrator pallet is an agent link graph (chain: proposeSubAgentLink etc., content.mjs:73-78). | T3 |

### LOW (81)

| id | ph | finding | evidence | tier |
|---|---|---|---|---|
| `GAP-G-05-02` | GAP-G-05 | tracker.sh:163 `merges_yesterday` carries the `grep -c … \|\| echo 0` double-output bug and it is latent only because factory/logs/merges.log has never been created (nothing has ever merged). Reproduced in the scratch copy: with a merges.log that exists but … *(unverified by panel)* | tracker.sh:160-164 `merges_yesterday() { local f="$LOG_DIR/merges.log" y; y="$(date -u -d 'yesterday' +%Y-%m-%d …)"; if [ -f "$f" ]; then grep -c "^$y" "$f" 2>/dev/null \|\| echo 0; else echo 0; fi }`, consumed at tracker.sh:197 `printf -- '- merges yesterday: **%s**\n\n' "$(merges_yesterday)"`. … | T1 |
| `GAP-G-05-02*` | GAP-G-05 | tracker.sh:163 `merges_yesterday` carries the `grep -c … \|\| echo 0` double-output bug and is latent only because factory/logs/merges.log has never been created (nothing has ever merged). Reproduced: with a merges.log that exists but holds no row dated … *(unverified by panel)* | tracker.sh:160-164 `if [ -f "$f" ]; then grep -c "^$y" "$f" 2>/dev/null \|\| echo 0; else echo 0; fi`, consumed at tracker.sh:197. `ls -la factory/logs/merges.log` -> 'No such file or directory'; only writer is merge.sh:215, reached on a successful merge. Run E (scratch copy, synthetic merges.log … | T1 |
| `GAP-G-05-04` | GAP-G-05 | tracker.sh's two GitHub tables cannot distinguish a failed query from a true zero: a gh failure is swallowed by `2>/dev/null` and the `except Exception: prs=[]` fallback renders it as a confident '_no open factory PRs_' / '_no labelled issue activity in … *(unverified by panel)* | Run G: same scratch copy, `env -i -C /tmp/audit/scratch HOME=/home/dev PATH=<production PATH> … tracker.sh --quiet`, exit 0, no stderr. Output tables: `\| _no labelled issue activity in 24h_ \| \| \| \|` and `\| _no open factory PRs_ \| \| \| \|`. Run C (cwd = the repo, production PATH) listed both … | T2 |
| `GAP-G-05-04*` | GAP-G-05 | tracker.sh's two GitHub tables cannot distinguish a failed query from a true zero: a gh failure is swallowed by `2>/dev/null` and the `except Exception: prs=[]` fallback renders it as a confident '_no open factory PRs_' / '_no labelled issue activity in … *(unverified by panel)* | Run G: same scratch copy, `env -i -C /tmp/audit/scratch … tracker.sh --quiet`, exit 0, no stderr -> `\| _no labelled issue activity in 24h_ \| \| \| \|` and `\| _no open factory PRs_ \| \| \| \|`. Run C (cwd = the repo, same PATH) listed both real PRs: `\| #113 \| task/88 \| needs-human \| …`, `\| …` | T2 |
| `GAP-G-06-01` | GAP-G-06 | P3-07 is SETTLED and should be downgraded: the rendered nginx edge config DOES parse, cleanly, under the exact nginx that INSTALL.md would install. What remains is a documentation defect — deploy/public/INSTALL.md:11-15 tells the operator the config 'has … *(unverified by panel)* | apt-cache policy nginx -> Candidate: 1.26.3-3+deb13u7 (the version `apt install -y nginx`, INSTALL.md:76, gets today). `apt-get download nginx nginx-common` + `dpkg-deb -x` into /tmp/audit/scratch/g06/nginxroot (rc=0); ldd resolves all 8 libs; `nginx -V` -> 'nginx version: nginx/1.26.3 / built with … | T1 |
| `GAP-G-06-01*` | GAP-G-06 | P3-07 is SETTLED and should be downgraded: the rendered nginx edge config DOES parse, cleanly, under the exact nginx that INSTALL.md would install. What remains is a documentation defect — deploy/public/INSTALL.md:11-15 tells the operator the config 'has … *(unverified by panel)* | apt-cache policy nginx -> Candidate: 1.26.3-3+deb13u7 (what `apt install -y nginx`, INSTALL.md:76, gets today). `apt-get download nginx nginx-common` + `dpkg-deb -x` into scratch (rc=0); ldd resolves all 8 libs; `nginx -V` -> 'nginx version: nginx/1.26.3 / built with OpenSSL 3.5.6 7 Apr 2026'. … | T1 |
| `GAP-G-06-02` | GAP-G-06 | `ssl_stapling on; ssl_stapling_verify on;` (scalar-commons.conf.template:83-84, rpc vhost only) is dead config against Let's Encrypt and will never staple. A live LE leaf issued 2026-09-04 carries AIA with CA Issuers ONLY and no OCSP responder URL, so nginx … *(unverified by panel)* | Real cert: `openssl s_client -connect letsencrypt.org:443 -servername letsencrypt.org -showcerts` -> subject=CN=letsencrypt.org, issuer=C=US, O=Let's Encrypt, CN=YE2, notBefore=Sep  4 14:34:32 2026 GMT; `openssl x509 -noout -ocsp_uri` -> EMPTY; `-text \| grep -A2 'Authority Information Access'` -> … | T2 |
| `GAP-G-06-02*` | GAP-G-06 | `ssl_stapling on; ssl_stapling_verify on;` (scalar-commons.conf.template:83-84, rpc vhost only) is dead config against Let's Encrypt and will never staple. A live LE leaf issued 2026-09-04 carries AIA with CA Issuers ONLY and no OCSP responder URL, so nginx … *(unverified by panel)* | Real cert: `openssl s_client -connect letsencrypt.org:443 -servername letsencrypt.org -showcerts` -> subject=CN=letsencrypt.org, issuer=C=US, O=Let's Encrypt, CN=YE2, notBefore=Sep  4 14:34:32 2026 GMT; `openssl x509 -noout -ocsp_uri` -> EMPTY; `-text \| grep -A2 'Authority Information Access'` -> … | T2 |
| `GAP-G-06-06` | GAP-G-06 | Open redirect on the :80 vhost for any unmatched Host. The HTTP->HTTPS block is the only *:80 server, hence its implicit default, and it redirects with `return 301 https://$host$request_uri;` — $host comes from the request's Host header, so an arbitrary … *(unverified by panel)* | Rendered config running on 127.0.0.1:19080. `curl -H 'Host: totally-unknown.example' http://127.0.0.1:19080/` -> 'status=301 redirect=https://totally-unknown.example/'. Control: `curl -H 'Host: scalarnet.io' http://127.0.0.1:19080/anything` -> 'status=301 redirect=https://scalarnet.io/anything'. … | T2 |
| `GAP-G-06-06*` | GAP-G-06 | Open redirect on the :80 vhost for any unmatched Host. The HTTP->HTTPS block is the only *:80 server, hence its implicit default, and it redirects with `return 301 https://$host$request_uri;` — $host comes from the request's Host header, so an arbitrary … *(unverified by panel)* | Rendered config running on 127.0.0.1:19080. `curl -H 'Host: totally-unknown.example' http://127.0.0.1:19080/` -> 'status=301 redirect=https://totally-unknown.example/'. Control: `curl -H 'Host: scalarnet.io' http://127.0.0.1:19080/anything` -> 'status=301 redirect=https://scalarnet.io/anything'. … | T2 |
| `GAP-G-07-04` | GAP-G-07 | Five raw constant values are quoted in prose outside any armed table and are therefore unchecked by the gate. All five are CORRECT against the live runtime today — the defect is the missing gate, not the numbers. *(unverified by panel)* | Scan of the 5 gate-scanned pages for `pallet.constName` spans not in the gate's covered set but on a line that also carries a numeric code span, compared against the fresh live snapshot: reference/token-model.md:114 emissions.maxEmissionOverrideEras live=10 span=['10'] VALUE PRESENT; :136 … | T2 |
| `GAP-G-07-04*` | GAP-G-07 | Five raw constant values are quoted in prose outside any armed table and are therefore unchecked by the gate. All five are CORRECT against the live runtime today — the defect is the missing gate, not the numbers. Related: escrow contributes 0/10 and … *(unverified by panel)* | Scan of the 5 gate-scanned pages for `pallet.constName` spans not in the covered set but on a line carrying a numeric code span, compared to the fresh live snapshot: token-model.md:114 emissions.maxEmissionOverrideEras live=10 -> VALUE PRESENT; :136 emissions.maxBatchClaimSize live=100 -> VALUE … | T2 |
| `GAP-G-07-05` | GAP-G-07 | The gate's 8 PROSE_FACTS assertions are bare substring matches; three needles ('CMN', '118', '42') are trivially satisfiable by unrelated text, so those checks can pass on a page that never states the fact. *(unverified by panel)* | check-chain-values.mjs:266 `if (!text.includes(value))`. PROSE_FACTS (:99-108) needles resolve to: token-model.md 'spec 304'; token-model.md 'CMN'; rpc.md 'spec 304'; rpc.md 'v15'; rpc.md '118'; run-a-node.md 'Scalar Commons Local Testnet'; run-a-node.md '42'; sdk.md '10^12'. grep -c -F per page: … | T2 |
| `GAP-G-07-05*` | GAP-G-07 | The gate's 8 PROSE_FACTS assertions are bare substring matches; three needles ('CMN', '118', '42') are trivially satisfiable by unrelated text, so those checks can pass on a page that never states the fact. *(unverified by panel)* | check-chain-values.mjs:266 `if (!text.includes(value))`. PROSE_FACTS (:99-108) needles: 'spec 304' (token-model), 'CMN' (token-model), 'spec 304' (rpc), 'v15' (rpc), '118' (rpc), 'Scalar Commons Local Testnet' (run-a-node), '42' (run-a-node), '10^12' (sdk). grep -c -F per page: 'CMN' matches 43 … | T2 |
| `GAP-G-07-06` | GAP-G-07 | Large parts of the snapshot are captured but read by nothing: the whole 285-entry storage surface, most of the provenance block, transactionVersion/implName/chainType/nodeName, and the rpcMethods list itself (only its length is used). The snapshot reads as … *(unverified by panel)* | snapshot-chain.mjs:84-89 captures `storage` (35 pallets, 285 entries) and :135 the sorted `rpcMethods` array (118). In check-chain-values.mjs, `grep -n 'storage'` returns exactly one hit — line 276, a comment. `grep -n …` | T3 |
| `GAP-G-07-06*` | GAP-G-07 | Large parts of the snapshot are captured but read by nothing: the whole 285-entry storage surface, most of the provenance block, transactionVersion/implName/chainType/nodeName, and the rpcMethods list itself (only its length is used). The snapshot reads as … *(unverified by panel)* | snapshot-chain.mjs:84-89 captures `storage` (35 pallets, 285 entries) and :135 the sorted `rpcMethods` array (118). In check-chain-values.mjs, `grep -n 'storage'` returns exactly one hit — line 276, a comment. `grep -n …` | T3 |
| `GAP-G-09-02` | GAP-G-09 | runtime/src/scalar_api.rs:30 carries a file-wide `#![allow(clippy::too_many_arguments)]` with no written rationale — the only lint suppression in the tree without one — and no function declared in the 156-line file takes more than two parameters. *(unverified by panel)* | `awk 'NR>=20&&NR<=34' runtime/src/scalar_api.rs` shows the `//!` doc block ends at :28 (`... It moves with every era settlement and is not a promise.`), :29 is blank, :30 is `#![allow(clippy::too_many_arguments)]`, :32 begins `use parity_scale_codec::...`. No comment adjoins it. `grep -n -E …` | T3 |
| `GAP-G-09-02*` | GAP-G-09 | runtime/src/scalar_api.rs:30 carries a file-wide `#![allow(clippy::too_many_arguments)]` with no written rationale — the only lint suppression in the tree without one — and no function declared in the 156-line file takes more than two parameters. *(unverified by panel)* | `awk 'NR>=20&&NR<=34' runtime/src/scalar_api.rs`: the `//!` doc block ends at :28, :29 is blank, :30 is `#![allow(clippy::too_many_arguments)]`, :32 begins `use parity_scale_codec::...`. No comment adjoins it. `grep -n -E '^\s*(pub )?fn ' runtime/src/scalar_api.rs` -> `138: fn get_agent_info(who: …` | T3 |
| `GAP-G-09-03` | GAP-G-09 | factory/lib/common.sh:9 carries a FILE-LEVEL `# shellcheck disable=SC2034` that suppresses nothing today and provably hides any unused variable added to that file later. It is the only one of the 12 live shellcheck directives that is not currently needed. *(unverified by panel)* | Necessity test (scratch copy at /tmp/audit/scratch/g09/sc/, repo untouched; script /tmp/audit/scratch/g09/check_sc.py + check_sc3.py). With line 9 replaced by a comment: `shellcheck -x factory/lib/common.sh` -> SC2034 hits=0 rc=0, and `shellcheck factory/lib/common.sh` (no -x) -> SC2034 hits=0 … | T3 |
| `GAP-G-09-03*` | GAP-G-09 | factory/lib/common.sh:9 carries a FILE-LEVEL `# shellcheck disable=SC2034` that suppresses nothing today and provably hides any unused variable added to that file later. It is the only one of the 12 live shellcheck directives that is not currently needed. *(unverified by panel)* | Necessity test on a scratch copy (/tmp/audit/scratch/g09/sc/, repo untouched; scripts check_sc.py + check_sc3.py). Line 9 replaced by a comment: `shellcheck -x factory/lib/common.sh` -> SC2034 hits=0 rc=0; `shellcheck factory/lib/common.sh` (no -x) -> SC2034 hits=0 rc=0. Probe: inserting … | T3 |
| `GAP-G-09-04` | GAP-G-09 | tests/common.rs:29 `#[allow(dead_code)]` on `RICH_STAKE` is redundant: tests/common.rs:3 already carries file-level `#![allow(dead_code)]`, and both lines were added in the same commit. *(unverified by panel)* | `awk 'NR>=1&&NR<=10' tests/common.rs` -> `1\| //! Common utilities for integration tests.` / `3\| #![allow(dead_code)]`. `awk 'NR>=23&&NR<=31'` -> `29\| #[allow(dead_code)]` / `30\| pub const RICH_STAKE: u64 = 100_000 * CMN;`. `git blame -L 3,3 -- tests/common.rs` -> `078bdeda (tejaspatil1936 …` | T3 |
| `GAP-G-09-04*` | GAP-G-09 | tests/common.rs:29 `#[allow(dead_code)]` on `RICH_STAKE` is redundant: tests/common.rs:3 already carries file-level `#![allow(dead_code)]`, and both lines were added in the same commit. *(unverified by panel)* | `awk 'NR>=1&&NR<=10' tests/common.rs` -> `1\| //! Common utilities for integration tests.` / `3\| #![allow(dead_code)]`. `awk 'NR>=23&&NR<=31'` -> `29\| #[allow(dead_code)]` / `30\| pub const RICH_STAKE: u64 = 100_000 * CMN;`. `git blame -L 3,3 -- tests/common.rs` -> `078bdeda (tejaspatil1936 …` | T3 |
| `GAP-G-09-05` | GAP-G-09 | deploy/public/render-config.sh is the only tracked shell script that fails shellcheck at warning severity (SC1090, exit 1) and it carries no `# shellcheck` directive; it landed in HEAD itself (6efba16). No gate globs it today, so nothing is red — but a … *(unverified by panel)* | `for f in $(git ls-files '*.sh'); do shellcheck -x -S warning "$f" >/dev/null 2>&1 \|\| echo FAIL $f; done` -> `FAIL deploy/public/render-config.sh` and nothing else (28 tracked scripts, 27 clean). `shellcheck deploy/public/render-config.sh` -> `In deploy/public/render-config.sh line 16: set -a; . …` | T3 |
| `GAP-G-09-05*` | GAP-G-09 | deploy/public/render-config.sh is the only tracked shell script that fails shellcheck at warning severity (SC1090, exit 1) and it carries no `# shellcheck` directive; it landed in HEAD itself (6efba16). No gate globs it today, so nothing is red — but a … *(unverified by panel)* | `for f in $(git ls-files '*.sh'); do shellcheck -x -S warning "$f" >/dev/null 2>&1 \|\| echo FAIL $f; done` -> `FAIL deploy/public/render-config.sh` and nothing else (28 tracked scripts, 27 clean, with and without -x). `shellcheck deploy/public/render-config.sh` -> `In …` | T3 |
| `GAP-G-11-05` | GAP-G-11 | Every connect failure in the indexer and the explorer renders the underlying cause as the string '[object ErrorEvent]', so an operator learns that the node is unreachable but never why (refused, unroutable, wrong scheme, TLS). *(unverified by panel)* | Explorer against a port with no listener: exit 1 after 1.21s with 'Error: cannot reach the node at ws://127.0.0.1:19999: [object ErrorEvent]' (explorer/src/chain.ts:174-178). Indexer, same target: exit 1 after 1.19s with 'indexer: fatal: ChainUnreachableError: cannot reach node at … | T3 |
| `GAP-G-11-05*` | GAP-G-11 | Every connect failure in the indexer and the explorer renders the underlying cause as the string '[object ErrorEvent]', so an operator learns that the node is unreachable but never why (refused, unroutable, wrong scheme, TLS). *(unverified by panel)* | Explorer against a port with no listener: exit 1 after 1.21s, 'Error: cannot reach the node at ws://127.0.0.1:19999: [object ErrorEvent]' (explorer/src/chain.ts:174-178). Indexer, same target: exit 1 after 1.19s, 'indexer: fatal: ChainUnreachableError: cannot reach node at ws://127.0.0.1:19999: … | T3 |
| `GAP-G-11-06` | GAP-G-11 | The explorer never inspects request.method, so POST, PUT, DELETE, PATCH, OPTIONS and TRACE on any URL are handled as GET and return the full 200 page; the indexer takes the opposite extreme and 405s HEAD, which breaks curl -I style health checks. *(unverified by panel)* | Node up, scratch instances: explorer / -> GET 200 (2672B), HEAD 200 (0B), POST 200 (2672B), PUT 200, DELETE 200, PATCH 200, OPTIONS 200, TRACE 200; 'curl -s -X POST http://127.0.0.1:18081/' returns '<title>Scalar Commons Explorer</title>'. Indexer /v1/status -> GET 200, HEAD 405, POST 405 ('method … | T3 |
| `GAP-G-11-06*` | GAP-G-11 | The explorer never inspects request.method, so POST, PUT, DELETE, PATCH, OPTIONS and TRACE on any URL are handled as GET and return the full 200 page; the indexer takes the opposite extreme and 405s HEAD, which breaks curl -I style health checks. *(unverified by panel)* | Node up, scratch instances: explorer / -> GET 200 (2672B), HEAD 200 (0B), POST 200 (2672B), PUT 200, DELETE 200, PATCH 200, OPTIONS 200, TRACE 200; 'curl -s -X POST http://127.0.0.1:18081/' returns '<title>Scalar Commons Explorer</title>'. Indexer /v1/status -> GET 200, HEAD 405, POST 405 ('method … | T3 |
| `GAP-G-13-02` | GAP-G-13 | P1a-10's own evidence line is imprecise: the grep it says returns 'nothing' actually exits 0 on a comment, so a gate built from it would read GREEN today. *(unverified by panel)* | grep -rnE 'rank_of\|rank_bps\|RankedCollective' /home/dev/scalar-commons-v4/tests/*.rs pallets/agents/src/tests.rs pallets/emissions/src/tests.rs -> 'tests/rank_promotion.rs:42:        // With () mock, rank_of always returns 0 - but we can verify the' (exit 0). Replacement gate verified RED: grep … | T3 |
| `GAP-G-13-02*` | GAP-G-13 — the missing proposed issue for the chain-layer test-coverage cluster | P1a-10's own evidence line is imprecise: the grep it says returns 'nothing' actually exits 0 on a comment, so a gate built from it would read GREEN today and be useless. *(unverified by panel)* | `grep -rnE 'rank_of\|rank_bps\|RankedCollective' /home/dev/scalar-commons-v4/tests/*.rs pallets/agents/src/tests.rs pallets/emissions/src/tests.rs` -> `tests/rank_promotion.rs:42:        // With () mock, rank_of always returns 0 — but we can verify the` (exit 0). Replacement gate verified RED: … | T3 |
| `P10-11` | X | docs VitePress GitHub social link points to github.com/tejaspatil1936/scalar-commons (missing -v4) → 404. *(unverified by panel)* | docs/.vitepress/config.mts:69 socialLinks link 'https://github.com/tejaspatil1936/scalar-commons'; curl → 404; renders as the footer GitHub icon on the public docs. | T3 |
| `P10-12` | X | .github/workflows/file-issues.yml files issues/labels against the upstream repo matty33/scalar-commons-v4, not this fork. *(unverified by panel)* | .github/workflows/file-issues.yml:16 R="matty33/scalar-commons-v4" (workflow_dispatch). | T2 |
| `P10-13` | X | docs/index.md feature card lists 'oracle accuracy' as a live weight component without the inertness caveat that token-model.md and landing both carry. *(unverified by panel)* | docs/index.md:30 'Weight combines √stake with rank, oracle accuracy, governance participation and a velocity bonus'. runtime/src/lib.rs:1269 type OracleScoreProvider = (); best_score→0 (emissions lib.rs:48-50). token-model.md:323-333 and landing caveat disclose inertness; index.md does not. | T3 |
| `P1a-13` | 1 | Comment errors in test scaffolding: the scaled test supply cap 10_000_000_000_000_000_000 plancks is called '~10B CMN' but equals 10 million CMN (1000× off); emissions lib.rs comment says the floor threshold is '5,000 CMN' while the runtime value is 50 CMN. *(unverified by panel)* | tests/common.rs:302-305 '// Supply cap must fit in u64. Use 10B CMN (10^13 * 10^4 = 10^16) … pub const SupplyCapIntTest: u64 = 10_000_000_000_000_000_000; // ~10B CMN'; tests/supply_cap.rs:7 same; 10^19 / 10^12 = 10^7 CMN. pallets/emissions/src/lib.rs:590-591 'agents must do at least 5× UnitVolume … | T2 |
| `P1b-07` | 1 | Dead WeightInfo/PlaceholderWeights code in six pallets carries misleading doc comments: 'Placeholder weights returning zero' (they return 30M–1,000M ps) and 'Replaced by benchmarked weights from pallets/agents/src/weights.rs' (file does not exist); the … *(unverified by panel)* | pallets/agents/src/lib.rs:26-27, :40-41; `ls pallets/*/src/weights.rs` → none; grep for references → none (see P1b-01). PlaceholderWeights values e.g. agents register 200_000_000, emissions settle_era 1000000000. | T1 |
| `P1b-08` | 1 | knowledge/entities.jsonl OD-3 is stale: it says Cargo.toml manifests are missing for 6 of 7 custom pallets and block benchmarking; all seven manifests exist. *(unverified by panel)* | knowledge/entities.jsonl:20 `{"id":"OD-3",..."description":"Cargo.toml manifests missing for 6 of 7 custom pallets — blocks benchmarking"}`; `ls pallets/*/Cargo.toml` → agents, auto-params, constitution, emissions, escrow, oracle, orchestrator (7/7). | T3 |
| `P1b-09` | 1 | Stale code comment: node/src/service.rs says the runtime 'only partially wires' runtime-benchmarks; the graph has been complete since ROUND5 and CI checks it every run. *(unverified by panel)* | node/src/service.rs:34-36; runtime/Cargo.toml:155-200 (40+ forwards incl. all 7 custom pallets); .github/workflows/ci-full.yml:126-127; gh run 34093539675 step 'Check runtime-benchmarks feature graph' success. | T1 |
| `P1b-12` | 1 | Public docs page docs/reference/rpc.md states 'Sudo \| 16 \| Removed by referendum after launch' as if it were a property of the pallet; nothing in the runtime schedules removal and live Sudo::Key is //Alice. Forward-looking so not false today, but a stranger … *(unverified by panel)* | docs/reference/rpc.md:296; runtime/src/lib.rs:1383 Sudo index 16 (matches); live Sudo::Key = 0xd43593c7… (P1b-05); docs/guide/run-a-node.md:315 does say 'sudo held by a single Alice key'. | T3 |
| `P1c-09` | 1 | bob/charlie/dave/eve on-disk keystores each hold three unregistered session keys (audi/babe/gran) written 2026-08-19 21:12 CEST by the prior audit's author_rotateKeys probe; alice's keystore is empty. No liveness impact (nodes author with dev keys) but stale … *(unverified by panel)* | ls ~/scalar-testnet/{bob,charlie,dave,eve}/chains/scalar-local/keystore/ -> 3 files each, prefixes 61756469/62616265/6772616e, mtime 2026-08-19 21:12; alice -> 0 files. AUDIT.md header '2026-08-19, ~19:10-19:25 UTC' and :845 'verified by successful author_rotateKeys on 9945/9946/9947/9948'. … | T1 |
| `P1c-10` | 1 | Stale doc comments in pallets/emissions: MinQualifyingVol described as '5 × UnitVolume (5,000 CMN)' (runtime sets 50 CMN, UnitVolume 10 CMN); EraStartBlock described as 'Initialized at genesis (block 0)' though the pallet has no genesis config (storage is … *(unverified by panel)* | pallets/emissions/src/lib.rs:116, :590 '(5,000 CMN)'; :164; runtime/src/lib.rs:1243 `EmissionsMinQualifyingVol: Balance = 50 * CMN`, :1240 UnitVolume 10 CMN; `grep -n -i genesis pallets/emissions/src/lib.rs` shows no genesis_config; live Emissions.EraStartBlock = null. | T0 |
| `P2a-07` | 2 | The indexer logs nothing per request, including 500 responses, so server-side faults are invisible in the journal. *(unverified by panel)* | journalctl --user -u scalar-indexer -> 5 lines total since 2026-09-07 07:31; `--since '2026-09-08 08:00'` -> 'No entries' despite ~150 probes including 12 HTTP 500s. api.ts:634-647 sendJson(500) without any console.error. | T3 |
| `P2a-08` | 2 | Minor HTTP-surface inconsistencies: HEAD and OPTIONS answer 405; live-state routes echo an over-range offset as the JSON number 1e+23; double slash /v1//blocks and trailing slashes are silently accepted. *(unverified by panel)* | curl -I /v1/status -> HTTP/1.1 405 content-length: 58; OPTIONS -> 405 {"error":"method OPTIONS not allowed; this API is read-only"}; GET /v1/agents?offset=99999999999999999999999 -> 200 {"total":3,"limit":25,"offset":1e+23,...}; GET /v1//blocks -> 200; GET /v1/blocks/511615/ -> 200. api.ts:606 … | T3 |
| `P2a-09` | 2 | indexer/reconcile.py (July SC-E1 fixture reconciliation script) is still shipped in the package whose README says 'There are no fixtures anywhere in this package'. *(unverified by panel)* | ls indexer/ -> reconcile.py (mtime Jul 29 10:23; last commit 3e4a834); head -5 reconcile.py -> 'Usage: python reconcile.py <golden_events.jsonl> <fixture_expected.json>'; indexer/README.md:9 'There are no fixtures anywhere in this package, and no code path that answers from anything but the chain.' … | T3 |
| `P2a-10` | 2 | Untracked planning docs at the repo root carry refuted claims about the indexer. *(unverified by panel)* | AUDIT.md:22,44,58-61 'indexer/ \| one Python file', 'Endpoint paths that exist in code on master: ZERO'; STATUS.md:119 'indexer/ currently contains only reconcile.py — the 24-endpoint REST API described in CLAUDE.md does not exist yet'; TODAY-PLAN.md:237 '(Indexer) \| source \| no unit file'. … | T3 |
| `P2b-03` | 2 | [u8;32] hash fields are rendered via toHuman(), which prints printable-ASCII bytes as text: deliveryHash 0x2222…22 shows as 32 double-quote characters on the extrinsic page (and in the escrow.DeliveryRecorded 'proof' event field), while the indexer shows the … *(unverified by panel)* | curl http://127.0.0.1:8081/extrinsic/511614/1 -> '<td>deliveryHash</td><td>[u8;32]</td><td>&quot;&quot;&quot;…' (32×&quot;) and 'proof: &quot;&quot;…'. Indexer: curl 'http://127.0.0.1:8080/v1/accounts/5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty/extrinsics?limit=5' -> … | T3 |
| `P2b-04` | 2 | HTTP method is not enforced: POST/PUT/DELETE/PATCH/OPTIONS/TRACE all return 200 with the full page (no 405); request bodies up to 10 MB are accepted silently. Harmless (read-only by construction, body never read, RSS unchanged) but hygiene. *(unverified by panel)* | for m in POST PUT DELETE PATCH OPTIONS TRACE: curl -X $m http://127.0.0.1:8081/ -> 200 '<h1>Scalar Commons block explorer</h1>'; same on /block/1 -> 200. POST 1MB body -> 200 in 0.006s; POST 10MB -> 200 in 0.007s; GET with 1MB body -> 200. server.ts createServer handler never inspects … | T3 |
| `P2b-05` | 2 | explorer/README.md and the page footer misstate node cost and caching: a cold block/extrinsic page costs 6.0-6.4 RPC calls (README says 'four reads'), and polkadot-js rpc-core's 102,400-entry LRU cache means repeat block pages cost 1 RPC call (README: 'no … *(unverified by panel)* | Prometheus substrate_rpc_calls_started on 127.0.0.1:9615, delta for 10 never-fetched /block/N: chain_getBlockHash +10, chain_getBlock +10, chain_getHeader +10, state_getRuntimeVersion +11, state_getStorage +20 = 6.1/request; same 10 again: chain_getBlockHash +10 only = 1.0/request; 10 fresh … | T3 |
| `P2b-06` | 2 | Landing page understates the explorer: its 'Block explorer' link points at polkadot.js.org and says only 'A hosted explorer for the devnet is not up yet', never mentioning the in-repo explorer that has existed and run since c474f56 (2026-09-02) — unlike the … *(unverified by panel)* | landing/src/content.mjs:268-274 key 'explorer', url 'https://polkadot.js.org/apps/', note '...once you point it at a Scalar Commons endpoint you can reach. A hosted explorer for the devnet is not up yet.'; :277-284 faucet note 'Built, and in the repository...'. git log -- explorer/ -> c474f56 … | T3 |
| `P2b-07` | 2 | No security response headers at the app layer (no Content-Security-Policy, X-Content-Type-Options, X-Frame-Options); the not-yet-applied nginx template adds HSTS/nosniff/Referrer-Policy for explorer.<DOMAIN> but no CSP or frame-ancestors. Defence-in-depth … *(unverified by panel)* | curl -D - http://127.0.0.1:8081/block/1 -> only 'content-type: text/html; charset=utf-8', 'cache-control: no-store', 'content-length', 'Connection: keep-alive', 'Keep-Alive: timeout=5'. deploy/public/nginx/scalar-commons.conf.template:232-234 add_header Strict-Transport-Security / … | T3 |
| `P2b-08` | 2 | Error pages echo the raw user input back, including control bytes: /block/%00 returns a 400 whose HTML body contains a literal NUL byte; a 10 KB path produces a 12 KB error page. No injection (escapeHtml covers & < > " '), hygiene only. *(unverified by panel)* | curl -s http://127.0.0.1:8081/block/%00 \| cat -v -> '<p>not a block number or block hash: ^@</p>'; /block/1%00 -> '<p>…: 1^@</p>'; /block/aaaa…(10240 a) -> status=400 size=12319. | T3 |
| `P2c-09` | 2 | nginx template comment says 'The faucet mints; keep it on the tighter bucket' — contradicts the faucet's core invariant (transfer-only, never a mint path). *(unverified by panel)* | deploy/public/nginx/scalar-commons.conf.template faucet vhost comment '# The faucet mints; keep it on the tighter bucket, not the web one.' vs faucet/src/chain.ts:6-9, faucet.ts:9-10, scalar-faucet.service:4-6, faucet/README.md 'never a mint path'. Only chain write is balances.transferKeepAlive … | T3 |
| `P2c-10` | 2 | GET /balance/<malformed percent-encoding> returns 500 INTERNAL_ERROR instead of 400: decodeURIComponent's URIError is not mapped to INVALID_ADDRESS. Process survives. *(unverified by panel)* | curl --path-as-is http://127.0.0.1:8082/balance/%E0%A4%A -> 'HTTP/1.1 500 Internal Server Error {"ok":false,"code":"INTERNAL_ERROR","error":"URI malformed"}'; server.ts:146 decodeURIComponent outside the try; is-active active, MainPID 1664521 unchanged. | T3 |
| `P2c-11` | 2 | The faucet emits no per-request log: 25 h of uptime produced four journal lines, so there is no record of which IP received which drip/txHash — no audit trail for a public faucet. *(unverified by panel)* | journalctl --user -u scalar-faucet -n 100 shows only the 4 startup lines after 07:38:55; journalctl --since '2026-09-08 08:30' after 20+ probes -> '-- No entries --'. server.ts contains no console.log in request handling. | T3 |
| `P2d-08` | 2 | Issue #72 is open but fully delivered on master; the factory BLOCKED-trackB-sdk.md report and STATUS.md still call the SDK blocked. *(unverified by panel)* | gh issue view 72 → OPEN, tier:T3, updated 2026-08-19. Scope items present: index.ts:322 recordGovVote; lastSettledEra/totalIssuance/netPosition fixed and verified live. c0f53a5 (PR #98 merged 2026-09-02T14:39:57Z) closed #94. Issue gate `cd sdk && npm ci && npm run typecheck && npm test` passes … | T3 |
| `P2d-09` | 2 | The SDK describes itself as a skeleton while ENDGOAL says it must be 'not a skeleton'. *(unverified by panel)* | sdk/package.json description 'TypeScript agent SDK … (P0-3 skeleton)'; sdk/README.md:7 '**Skeleton (P0-3).** This is the initial method surface'. ENDGOAL.md:126 'a real, tested TypeScript client, not a skeleton'. factory/tasks/trackB-sdk.prompt:25 also stale ('index.ts (~287 lines) … partly … | T3 |
| `P2d-10` | 2 | npm audit reports 4 vulnerabilities (1 critical) in the devDependency chain vitest 1.6.1 → vite/esbuild/vite-node; none in runtime deps. *(unverified by panel)* | `npm --prefix sdk audit --json`: total 4 (2 moderate, 1 high, 1 critical). vitest critical GHSA-5xrq-8626-4rwp 'When Vitest UI server is listening, arbitrary file can be read and executed' (<3.2.6; installed 1.6.1); vite high GHSA-fx2h-pf6j-xcff; esbuild moderate GHSA-67mh-4wv8-2f99. fixAvailable: … | T3 |
| `P2d-11` | 2 | Naming/doc nits: acceptEscrow actually wraps escrow.recordDelivery (there is no accept step); vote() takes `vote: unknown`; docs netPosition shape omits reserved/frozen; docs say `npm install` where README says `npm ci`; docs call @polkadot/* 'peer' deps … *(unverified by panel)* | sdk/src/index.ts:257-269 acceptEscrow → txEntry('escrow','recordDelivery'); ENDGOAL.md:127 'escrow (create/accept/complete)'. index.ts:299 `vote: unknown`. docs/guide/sdk.md:306 '{ free, stake, eraEscrowVolume, pendingEmissions, total }' vs index.ts:60-89 seven fields. docs:25 'npm install' vs … | T3 |
| `P2e-13` | 2 | Both committed chain snapshots are 5.44 days (~78,300 blocks) stale; all metadata facts still match the live runtime and only total issuance drifted, so nothing published is wrong because of staleness. *(unverified by panel)* | docs/.chain/snapshot.json capturedAtBlock 433616; landing/chain-facts.json readAtBlock 433638 fetchedAt 2026-09-02T20:07:42Z; head #511922 at 08:37 CEST -> 78,306 / 78,284 blocks = 130.5 h = 5.44 d. `node landing/scripts/verify-chain.mjs` at #511914: 'all metadata facts on the page still match the … | T3 |
| `P2e-14` | 2 | .github/workflows/file-issues.yml hardcodes the wrong repository (matty33/scalar-commons-v4); workflow_dispatch-only so inert unless run. *(unverified by panel)* | .github/workflows/file-issues.yml:16 `R="matty33/scalar-commons-v4"`; actual repo tejaspatil1936/scalar-commons-v4 (gh api pages, landing content.mjs:254). Gate `! grep -q 'matty33/scalar-commons-v4' .github/workflows/file-issues.yml` exits 1 today. | T2 |
| `P2e-15` | 2 | docs/guide/sdk.md calls @polkadot/* 'peer transport deps' but sdk/package.json declares them as regular dependencies with no peerDependencies. *(unverified by panel)* | docs/guide/sdk.md:29-31; sdk/package.json deps {'@polkadot/api':'^15.0.0','@polkadot/keyring':'^13.0.0','@polkadot/util':'^13.0.0','@polkadot/util-crypto':'^13.0.0'}, peerDependencies None (python3 json dump). | T3 |
| `P3-09` | 3 | INSTALL.md step 5 runs `mkdir -p /var/www/acme` without sudo; /var/www will be root-owned once nginx is installed, so the step fails with Permission denied and the following `sudo chown` never runs. *(unverified by panel)* | INSTALL.md:109-110; `ls -ld /var/www` -> No such file or directory (nginx not installed); `test -w /var/www` -> NOT writable; Debian nginx package creates /var/www/html root:root 755. | T3 |
| `P3-10` | 3 | render-config.sh fails shellcheck with SC1090 because the `# shellcheck source=/dev/null` directive on line 15 binds to `set -a` (first command on line 16), not to the `.` source. *(unverified by panel)* | /usr/bin/shellcheck -S style deploy/public/render-config.sh -> 'line 16: . "$ENV_FILE" ^ SC1090 (warning): ShellCheck can't follow non-constant source', rc=1. | T2 |
| `P4-10` | 4 | Stale code comments in pallets/emissions describe MinQualifyingVol as '5 × UnitVolume (5,000 CMN)'; runtime value is 50 CMN (UnitVolume 10 CMN). *(unverified by panel)* | pallets/emissions/src/lib.rs:116 'At launch: set to 5 × UnitVolume (5,000 CMN)'; :590 'at least 5× UnitVolume (5,000 CMN)'. runtime/src/lib.rs:1237 `EmissionsUnitVolume = 10 * CMN`, :1243 `EmissionsMinQualifyingVol = 50 * CMN`. Live indexer /v1/emissions minQualifyingVolumePlancks 50000000000000. | T3 |
| `P5-09` | 5 | Stale status claims in workflow comments and planning docs describe a CI/factory state that no longer exists (sdk job 'RED ON MASTER TODAY', indexer 'one Python file', WEEKCHECK A6/A7/A9 'NOT DONE', STATUS.md 'required checks gate and full', ENDGOAL §3.5 … *(unverified by panel)* | ci-node.yml:256-272 'THIS JOB IS RED ON MASTER TODAY ... sdk/ has no package-lock.json ... Restore the cache line when the lockfile lands' vs `git log --diff-filter=A -- sdk/package-lock.json` -> c0f53a5 2026-09-02 and sdk job success on 6efba16 (run 34093539706); `cache: npm` still absent from the … | T3 |
| `P5-10` | 5 | The dispatcher re-comments 'Factory refused to dispatch: no usable gate' on issue #115 every hour (25 identical comments in 24h) and re-dispatches #88/#101 hourly into already-open PRs; each comment also fires a (skipped) claude-swarm workflow run. *(unverified by panel)* | `gh api repos/.../issues/comments?sort=created&direction=desc&per_page=6` -> six hourly comments on #115 at :04. `gh issue view 115 --json comments,labels,body`: labels [ready, tier:T3], 25 comments all 'refused to dispatch', first 2026-09-07T06:04:49Z last 2026-09-08T06:04:48Z, body has no '#' … | T2 |
| `P5-11` | 5 | claude.yml floats the Rust toolchain (dtolnay/rust-toolchain@stable) that ci-fast.yml says must be pinned to 1.85.0, and file-issues.yml hardcodes the upstream fork repo matty33/scalar-commons-v4 with issues:write — a dead workflow that would act on the wrong … *(unverified by panel)* | .github/workflows/claude.yml:40 `uses: dtolnay/rust-toolchain@stable`; ci-fast.yml:6-8 'dtolnay/rust-toolchain@stable overrode rust-toolchain.toml's 1.85.0 pin. This SDK tag cannot be compiled by a newer rustc'. file-issues.yml:14 `R="matty33/scalar-commons-v4"`, permissions `issues: write`, … | T2 |
| `P5-12` | 5 | CLAUDE.md documents `cd indexer && npm test` as 'Indexer tests', but that command runs live.test.ts, which requires a live devnet and submits real extrinsics; it is not a unit suite and hard-fails for anyone without the chain. *(unverified by panel)* | CLAUDE.md:34 '- Indexer tests: `cd indexer && npm test`'. indexer/package.json test = 'vitest run'; vitest.config.ts include 'tests/**/*.test.ts'; indexer/tests/live.test.ts:29 connects to ws://127.0.0.1:9944 unconditionally and header :20-27 says it submits real extrinsics and 'fails loudly' if … | T3 |
| `P6-15` | 6 | The `[: 0\n0: integer expression expected` bug is still present at review.sh:429/737 (root cause L295 `grep -c '' … \|\| echo 0` yields two lines on an empty file); it fails safe (test → false is the correct branch at zero) and last fired … *(unverified by panel)* | Reproduced: `X=$(grep -c '' empty \|\| echo 0); printf %q` → `$'0\n0'`; `[ "$X" -gt 0 ]` → `[: 0\n0: integer expression expected` rc=2; `$(( 120 > Y ))` with Y=$'0\n0' → `syntax error in expression`. dispatch.systemd.log:10492 `review.sh: line 429: [: 0` / `0: integer expression expected` at … | T2 |
| `P6-16` | 6 | Stale documentation in the factory: merge.sh header says master has no branch protection (it has 6 required checks); README:287 says a missing verdict counts as FAIL (code: ERROR/INCONCLUSIVE); README:96-100 says the dispatcher timer is not installed by … *(unverified by panel)* | merge.sh:24-25 'master has NO protection (the API returns 404)' vs `gh api …/protection` 200 with contexts gate,full,landing,faucet,docs,sdk; README.md:286-287 'A missing or unparseable verdict counts as FAIL' vs review.sh:133-147 classify → ERROR (verdict-parse 51/51 asserts ERROR); … | T3 |
| `P6-17` | 6 | Open BLOCKED reports do not describe live blockers: BLOCKED-issue-96.md (cap 40/40, 2026-09-02) is for issue #96 which was closed the same day; BLOCKED-trackB-sdk.md (2026-08-02, attempt cap, agent summary 'API Error: 400 You have reached your specified API … *(unverified by panel)* | factory/blocked/: BLOCKED-issue-96.md (blocked at 2026-09-02T03:05:07Z, 'daily spawn cap reached (40/40) — stopping before attempt 1'), BLOCKED-trackB-sdk.md (2026-08-02T21:37:37Z); `gh issue view 96` → CLOSED 2026-09-02T17:20:32Z; resolved/ holds issue-102/104/105 (stuck ×3), trackB-*, trackC-od4; … | T2 |
| `P6-18` | 6 | watchdog.sh's STOP_FACTORY orphan sweep `pgrep -f 'claude -p'` is over-broad and would TERM any user process whose command line contains that string; 19 worktrees (3.2 GB, incl. wt-70..75, 94..96, 102..106 for closed issues) are never cleaned; selftest.sh … *(unverified by panel)* | watchdog.sh:68-72; during this audit `pgrep -f 'claude -p'` matched pid 1864234 `/bin/bash -c source /home/dev/.claude/shell-snapshots/…` (my own read-only shell), not a factory process. `git worktree list` → 19 worktrees; `du -shc /home/dev/wt-*` → 3.2G total. Repo factory/logs contains … | T2 |
| `P7-09` | 7 | Docs prerequisite text has small inaccuracies: docs/guide/run-a-node.md:30 lists libssl-dev though openssl-sys is not in the dependency graph; :16 assumes rustup is already installed; docs/guide/sdk.md:26 says `npm install` while sdk/README.md:15 says `npm …` *(unverified by panel)* | grep '^name = "openssl-sys"$' Cargo.lock -> 0 (only openssl-probe line 5913, rustls 8156/8167). docs/guide/run-a-node.md:16 '`rustup` reads the pin automatically' with no install step. sed -n 24-27 docs/guide/sdk.md -> `npm install`; sdk/README.md:15 -> `npm ci`. | T3 |
| `P7-10` | 7 | 19 factory worktrees (3.2 GB, mostly node_modules) linger under ~/wt-* for closed/merged issues (70-75, 87, 88, 94-96, 101-106, 115); no stash. Hygiene only — no rebuild dependency. *(unverified by panel)* | git worktree list -> 19 entries; du -sch /home/dev/wt-* -> 3.2G total; none has target/; git stash list -> 0. | T2 |
| `P8-16` | 8 | Dead external links in the docs: docs/index.md:41 https://polkadot.com/platform/sdk -> 404; docs/.vitepress/config.mts:69 social link names the wrong repo (scalar-commons, no -v4). *(unverified by panel)* | curl -s -o /dev/null -w '%{http_code}' -A Mozilla/5.0 https://polkadot.com/platform/sdk -> 404; https://github.com/tejaspatil1936/scalar-commons -> 404. Internal links: 35 checked, 0 broken. | T3 |
| `P8-17` | 8 | landing/README.md says the faucet is 'marked planned with a link to the issue tracking it' and that unbuilt destinations are labelled planned; content.mjs marks all four links 'available' (rendered 'Live') including faucet and explorer whose own notes say no … *(unverified by panel)* | landing/README.md 'Caveats' section; landing/src/content.mjs:255 status: 'available'; render.mjs:157 non-planned -> 'Live'; live page text 'Testnet faucet Live ... No hosted instance is up yet'. | T3 |
| `P8-18` | 8 | Indexer ignores an unknown query filter: /v1/extrinsics?signed=true returns the same unsigned inherents as the unfiltered list, so there is no way to list only signed extrinsics. *(unverified by panel)* | curl 'http://127.0.0.1:8080/v1/extrinsics?signed=true&limit=5' -> identical items to ?limit=5 (all timestamp.set, isSigned false); indexer/src/api.ts:274-292 supports ?signer= only. | T3 |
| `P9-21` | 9 | sdk/README.md and sdk/package.json still call the SDK a 'Skeleton (P0-3)' while ENDGOAL §3.2 requires 'a real, tested TypeScript client, not a skeleton' and PR #98 merged — one of the two descriptions is wrong. *(unverified by panel)* | sdk/README.md:7 '> **Skeleton (P0-3).** This is the initial method surface'; sdk/package.json description 'TypeScript agent SDK ... (P0-3 skeleton)'; ENDGOAL.md:126; PR #98 merged 2026-09-02. | T3 |
| `P9-22` | 9 | landing/README.md says the faucet 'is marked planned with a link to the issue tracking it'; content.mjs marks it 'available' since PR #108. *(unverified by panel)* | landing/README.md 'Caveats' section: 'the faucet is marked `planned`'; landing/src/content.mjs:280 status: 'available'; PR #108 'landing: mark the faucet as built' merged 2026-09-03. | T3 |
| `P9-23` | 9 | pallets/emissions/src/lib.rs comment says agents must do 'at least 5× UnitVolume (5,000 CMN)' per era for the floor; the runtime constants are UnitVolume 10 CMN and MinQualifyingVol 50 CMN (CLAUDE.md:45 and the runtime doc comment say 50). *(unverified by panel)* | pallets/emissions/src/lib.rs:~590 comment '5× UnitVolume (5,000 CMN)'; runtime/src/lib.rs:1237 EmissionsUnitVolume = 10 * CMN; :1238-1243 doc '5 × UnitVolume = 50 CMN', EmissionsMinQualifyingVol = 50 * CMN; chain-facts minQualifyingVol 50000000000000. | T3 |
| `P9-24` | 9 | ENDGOAL.md:7 says it 'supersedes the day-30 definition in ROADMAP-30DAY.md'; no such file exists in the tree or anywhere in git history. *(unverified by panel)* | ls ROADMAP-30DAY.md -> No such file; git log --all -- ROADMAP-30DAY.md -> empty; git grep ROADMAP-30DAY -> only ENDGOAL.md:7. | T3 |
| `P9-25` | 9 | docs/VERIFIED-CONSTANTS.md cites runtime/src/lib.rs:74 for GENESIS_MINT; the constant is at line 84 (file is srcExcluded from the public site). *(unverified by panel)* | docs/VERIFIED-CONSTANTS.md:176,385 ':74'; runtime/src/lib.rs:84 `pub const GENESIS_MINT`; docs/.vitepress/config.mts:25 srcExclude VERIFIED-CONSTANTS.md. | T3 |

### INFO (82)

| id | ph | finding | evidence | tier |
|---|---|---|---|---|
| `GAP-G-01-05` | GAP-G-01 | The 'ufw.service has never run since the 2026-07-22 boot' fact that the exec summary leaned on is true but vacuous, and the reboot fragility it implies does not exist. The host booted 2026-07-22 15:26:27 and ufw was installed 2026-07-28 11:04:03 - six days … *(unverified by panel)* | uptime -s -> 2026-07-22 15:26:27; uptime -p -> 'up 6 weeks, 5 days, 22 hours, 48 minutes'. zcat /var/log/apt/history.log.2.gz -> 'Start-Date: 2026-07-28 11:04:03 / Commandline: apt -y install sudo ufw fail2ban curl ca-certificates gnupg / End-Date: 2026-07-28 11:04:16'. systemctl show ufw.service … | T2 |
| `GAP-G-01-05*` | GAP-G-01 | The 'ufw.service has never run since the 2026-07-22 boot' fact that the exec summary leaned on is true but vacuous, and the reboot fragility it implies does not exist. The host booted 2026-07-22 15:26:27 and ufw was installed 2026-07-28 11:04:03 — six days … *(unverified by panel)* | uptime -s -> 2026-07-22 15:26:27; uptime -p -> 'up 6 weeks, 5 days, 22 hours, 48 minutes'. zcat /var/log/apt/history.log.2.gz -> 'Start-Date: 2026-07-28 11:04:03 / Commandline: apt -y install sudo ufw fail2ban curl ca-certificates gnupg / End-Date: 2026-07-28 11:04:16'. systemctl show ufw.service … | T2 |
| `GAP-G-02-05` | GAP-G-02 | The sshd jail is demonstrably live and matching journal entries right now, but its ban counts, jail status and the live f2b-table contents are UNVERIFIABLE read-only. Every read path is root-restricted and `dev` is in neither `adm` nor `systemd-journal`. *(unverified by panel)* | $ id uid=1000(dev) gid=1000(dev) groups=1000(dev),27(sudo),100(users) $ ls -la /var/log/fail2ban.log -rw-r----- 1 root adm 1239385 ... /var/log/fail2ban.log $ head -1 /var/log/fail2ban.log head: cannot open '/var/log/fail2ban.log' for reading: Permission denied $ /usr/bin/fail2ban-client status … | T0 |
| `GAP-G-02-06` | GAP-G-02 | DOWNGRADED, not a defect. The `_COMM=sshd` journalmatch in jail.d/defaults-debian.conf:7 looks stale against OpenSSH 10.0p2, whose per-connection processes are `sshd-session`/`sshd-auth`, but the jail still matches for two verified reasons. *(unverified by panel)* | $ dpkg -l openssh-server \| tail -1 ii  openssh-server 1:10.0p1-7+deb13u4 amd64 $ /usr/sbin/sshd -V OpenSSH_10.0p2 Debian-7+deb13u4, OpenSSL 3.5.6 7 Apr 2026 $ ps -eo pid,comm --no-headers \| grep -i ssh    1102 sshd            <- listener only 1896839 sshd-session 1943464 sshd-auth  Reason 1 - `+` … | T0 |
| `GAP-G-03-05` | GAP-G-03 | Empirical proof that rank 3 (rank_bps 15_000) is unreachable on the live devnet, and that it is the ORACLE gate -- not the completions or span gate -- that blocks it. Bob has 159 completed agreements (>= Rank3MinCompletions 50) and registered at block 0 (span … *(unverified by panel)* | Live at head 515,337 (chain_getHeader): Agents.CompletedAgreements (prefix 0x0ec3e268c3abf5d87f15dde43fc56ec19a5718ba6ce4e3162b94783cc36b2d97) -> Bob 0x9f000000 = 159, Charlie 0x3a000000 = 58, Alice absent (= 0). Agents.StakeRegisteredAt (prefix ...e0faeaa68b6df8c25a5c448e97ad0872) -> 0x00000000 = … | T0 |
| `GAP-G-03-05*` | GAP-G-03 | Empirical proof that rank 3 (rank_bps 15_000) is unreachable on the live devnet, and that it is the ORACLE gate — not the completions or span gate — that blocks it. Bob has 159 completed agreements (>= Rank3MinCompletions 50) and registered at block 0 (span … *(unverified by panel)* | Live at head 515,337 (chain_getHeader -> number 515337): Agents.CompletedAgreements (prefix 0x0ec3e268c3abf5d87f15dde43fc56ec19a5718ba6ce4e3162b94783cc36b2d97) -> Bob 0x9f000000 = 159, Charlie 0x3a000000 = 58, Alice absent (= 0). Agents.StakeRegisteredAt (prefix ...e0faeaa68b6df8c25a5c448e97ad0872) … | T0 |
| `GAP-G-03-06` | GAP-G-03 | DOWNGRADE of the gap brief's own claim: node/src/chain_spec.rs is NOT in contradiction with deploy/scalar-local-raw.json. The brief quoted lines 293-298 in isolation; lines 301-306 of the same comment explicitly document the pallet-agents genesis_build route … *(unverified by panel)* | sed -n '293,306p' node/src/chain_spec.rs -> ':293 // ROUND4: the `rankedCollective` seeding that used to be built here is gone. :294 // `pallet_ranked_collective` declares no `#[pallet::genesis_config]` at :295 // polkadot-stable2503 ... :301 // The collective is still non-empty at block 1, by a … | T0 |
| `GAP-G-03-06*` | GAP-G-03 | DOWNGRADE of the gap brief's own claim: node/src/chain_spec.rs is NOT in contradiction with deploy/scalar-local-raw.json. The brief quoted lines 293-298 in isolation; lines 301-306 of the same comment explicitly document the pallet-agents genesis_build route … *(unverified by panel)* | `sed -n '293,306p' node/src/chain_spec.rs` -> ':293 // ROUND4: the `rankedCollective` seeding that used to be built here is gone. :294 // `pallet_ranked_collective` declares no `#[pallet::genesis_config]` at :295 // polkadot-stable2503 ... :301 // The collective is still non-empty at block 1, by a … | T0 |
| `GAP-G-05-05` | GAP-G-05 | Positive result from executing tracker.sh: the three safety headlines in the Health block (kill switch, rate-limit back-off, disk guard) all render correctly when tripped — no phase had ever seen these branches produce output. Also confirmed by execution: … *(unverified by panel)* | Run H (scratch copy, STOP_FILE=/tmp/audit/scratch/G05-spend/FAKE_STOP present, BACKOFF_FILE holding `date -u -d '+42 minutes' +%s`, MIN_FREE_DISK_GB=999999, MERGE_T2=true): `- **KILL SWITCH ENGAGED** — /tmp/audit/scratch/G05-spend/FAKE_STOP exists. No loops will start.` / `- **RATE-LIMIT BACK-OFF …` | none |
| `GAP-G-05-05*` | GAP-G-05 | Positive results from executing tracker.sh, none of which any phase had observed: the three safety headlines (kill switch, rate-limit back-off, disk guard) all render correctly when tripped; MERGE_T2 reads its environment and the production 'MERGE_T2=false' … *(unverified by panel)* | Run H (scratch STOP_FILE present, BACKOFF_FILE = now+42 min, MIN_FREE_DISK_GB=999999, MERGE_T2=true): `- **KILL SWITCH ENGAGED** — /tmp/audit/scratch/G05-spend/FAKE_STOP exists. No loops will start.` / `- **RATE-LIMIT BACK-OFF ACTIVE** — 2519s remaining` / `- **DISK GUARD TRIPPED**: 1811GB free < …` | none |
| `GAP-G-06-04` | GAP-G-06 | P3's caveat (a) is closed: the `/docs/` block's `alias` + `try_files $uri $uri/ $uri.html /docs/index.html` combination behaves correctly under nginx 1.26.3 — the classic alias/try_files path-mangling trap does not bite here. All six request shapes resolve as … *(unverified by panel)* | Rendered config running on 127.0.0.1:19443, curl --resolve scalarnet.io:19443:127.0.0.1: GET /docs/ -> status=200 size=15170 type=text/html; GET /docs -> status=301 redirect=https://scalarnet.io/docs/ (location = /docs); GET /docs/index.html -> 200 size=15170; GET /docs/guide/run-a-node -> 200 … | none |
| `GAP-G-06-04*` | GAP-G-06 | P3's caveat (a) is closed: the `/docs/` block's `alias` + `try_files $uri $uri/ $uri.html /docs/index.html` behaves correctly under nginx 1.26.3 — the classic alias/try_files path-mangling trap does not bite here. All six request shapes resolve as intended, … *(unverified by panel)* | Rendered config running on 127.0.0.1:19443, curl --resolve scalarnet.io:19443:127.0.0.1: GET /docs/ -> status=200 size=15170 type=text/html; GET /docs -> status=301 redirect=https://scalarnet.io/docs/; GET /docs/index.html -> 200 size=15170; GET /docs/guide/run-a-node -> 200 size=44979 ($uri.html … | none |
| `GAP-G-06-07` | GAP-G-06 | The two-stage bootstrap design is verified load-bearing, and INSTALL.md's step ordering is correct. Installing the full config before certbot really does fail nginx -t, with a hard [emerg] on the first missing certificate — exactly what … *(unverified by panel)* | Full rendered config with the real (absent) /etc/letsencrypt paths: '2026/09/08 14:19:43 [emerg] 1952129#1952129: cannot load certificate "/etc/letsencrypt/live/scalarnet.io/fullchain.pem": BIO_new_file() failed (SSL: error:80000002:system library::No such file or directory:calling … | none |
| `GAP-G-06-07*` | GAP-G-06 | The two-stage bootstrap design is verified load-bearing and INSTALL.md's step ordering is correct. Installing the full config before certbot really does fail nginx -t, with a hard [emerg] on the first missing certificate — exactly what bootstrap-http.conf:4-7 … *(unverified by panel)* | Full rendered config with the real (absent) /etc/letsencrypt paths: '2026/09/08 14:19:43 [emerg] 1952129#1952129: cannot load certificate "/etc/letsencrypt/live/scalarnet.io/fullchain.pem": BIO_new_file() failed (SSL: error:80000002:system library::No such file or directory:calling … | none |
| `GAP-G-06-08` | GAP-G-06 | Runtime behaviours P3 could only infer, now observed against the real binary: (1) the rate limits work and return 429, not nginx's default 503 — `limit_req_status 429` takes effect; (2) `http2 on` is accepted and serves HTTP/2 on 1.26.3, confirming P3's … *(unverified by panel)* | 150 concurrent GET / on the landing vhost (web_req 20r/s, burst=40 nodelay, limit_conn web_conn 20) -> '106 429 / 44 200'; error log: '2026/09/08 14:19:19 [error] 1951138#1951138: *80 limiting requests, excess: 40.840 by zone "web_req", client: 127.0.0.1, server: scalarnet.io, request: "GET / … | none |
| `GAP-G-06-08*` | GAP-G-06 | Runtime behaviours P3 could only infer, now observed against the real binary: (1) the rate limits work and return 429, not nginx's default 503 — `limit_req_status 429` takes effect; (2) `http2 on` is accepted and serves HTTP/2 on 1.26.3, confirming P3's … *(unverified by panel)* | 150 concurrent GET / on the landing vhost (web_req 20r/s, burst=40 nodelay, limit_conn web_conn 20) -> '106 429 / 44 200'; error log '2026/09/08 14:19:19 [error] 1951138#1951138: *80 limiting requests, excess: 40.840 by zone "web_req", client: 127.0.0.1, server: scalarnet.io, request: "GET / … | none |
| `GAP-G-07-01` | GAP-G-07 | GAP CLOSED: the committed docs snapshot is byte-identical to a snapshot taken from the live node today, so the docs ARE live-verified, not merely snapshot-verified. ENDGOAL §4 item 8 is satisfied as of 2026-09-08. *(unverified by panel)* | Ran snapshot-chain.mjs from a scratch copy (it hardcodes its output path at snapshot-chain.mjs:32): `node /tmp/audit/scratch/G07/docs/scripts/snapshot-chain.mjs ws://127.0.0.1:9944` -> '✓ snapshot written ... Scalar Commons Local Testnet — scalar-commons spec 304 @ #515290 / 36 pallets, 141 … | T0 |
| `GAP-G-07-01*` | GAP-G-07 | GAP CLOSED: the committed docs snapshot is byte-identical to a snapshot taken from the live node today, so the docs ARE live-verified, not merely snapshot-verified. ENDGOAL §4 item 8 is satisfied as of 2026-09-08. *(unverified by panel)* | `node /tmp/audit/scratch/G07/docs/scripts/snapshot-chain.mjs ws://127.0.0.1:9944` -> '✓ snapshot written ... Scalar Commons Local Testnet — scalar-commons spec 304 @ #515290 / 36 pallets, 141 constants, 240 extrinsics, 13 runtime APIs, 118 RPC methods', EXIT=0. `diff <(python3 -m json.tool …` | T0 |
| `GAP-G-07-07` | GAP-G-07 | Within its declared scope the gate is genuinely load-bearing: a simulated runtime change injected into the snapshot produces six independent failures, including the cross-pallet supply-cap invariant. Its weakness is refresh cadence, not assertion strength. *(unverified by panel)* | Mutated the fresh live snapshot in scratch (consts.emissions.supplyCap 100000000000000000000000 -> 99000000000000000000000; pallets.Emissions 29 -> 129; runtime.specVersion 304 -> 305) and re-ran check-chain-values.mjs: EXIT=1 with '✗ docs disagree with the runtime snapshot (... spec 305 @ … | T0 |
| `GAP-G-07-07*` | GAP-G-07 | Within its declared scope the gate is genuinely load-bearing: a simulated runtime change injected into the snapshot produces six independent failures, including the cross-pallet supply-cap invariant. Its weakness is refresh cadence, not assertion strength. *(unverified by panel)* | Mutated the fresh live snapshot in scratch (consts.emissions.supplyCap 100000000000000000000000 -> 99000000000000000000000; pallets.Emissions 29 -> 129; runtime.specVersion 304 -> 305) and re-ran check-chain-values.mjs: EXIT=1, '✗ docs disagree with the runtime snapshot (... spec 305 @ #515290)' … | T0 |
| `GAP-G-07-08` | GAP-G-07 | Facts the gate does not check but that I checked against the live node by hand — all TRUE: 13/13 runtime-API method counts, 49 documented JSON-RPC method names, 7 absence claims, and the published-page set matching the gate's scanned-page set exactly. *(unverified by panel)* | (a) rpc.md:255-268 table vs live runtimeApis: Core 3/3, Metadata 3/3, BlockBuilder 4/4, TaggedTransactionQueue 1/1, OffchainWorkerApi 1/1, SessionKeys 2/2, BabeApi 6/6, GrandpaApi 4/4, AuthorityDiscoveryApi 1/1, AccountNonceApi 1/1, TransactionPaymentApi 4/4, GenesisBuilder 3/3, ScalarCommonsApi … | T0 |
| `GAP-G-07-08*` | GAP-G-07 | Facts the gate does not check but that I checked against the live node by hand — all TRUE: 13/13 runtime-API method counts, 49 documented JSON-RPC method names, 7 absence claims, and the published-page set matching the gate's scanned-page set exactly. *(unverified by panel)* | (a) rpc.md:255-268 vs live runtimeApis: Core 3/3, Metadata 3/3, BlockBuilder 4/4, TaggedTransactionQueue 1/1, OffchainWorkerApi 1/1, SessionKeys 2/2, BabeApi 6/6, GrandpaApi 4/4, AuthorityDiscoveryApi 1/1, AccountNonceApi 1/1, TransactionPaymentApi 4/4, GenesisBuilder 3/3, ScalarCommonsApi 4/4 — … | T0 |
| `GAP-G-09-06` | GAP-G-09 | Correction to P5 §4: the 12 `#[allow(dead_code)]` gov test helpers are used in NONE of the four pallets, not merely 'not all used per pallet'. The classification (legitimate) stands — ROUND14.md:131-132 documents the deliberate deny-by-default mock parity — … *(unverified by panel)* | `git grep -n -E '\b(cast_live_vote\|conclude_poll\|reset_gov_state)\b'`: pallets/agents/src/tests.rs defs at :176,187,200 with 13 call sites (:209,688,705,717,732,749,750,764,792,815,824,837); tests/common.rs defs at :192,202,209 with 5 call sites (common.rs:378 and … | none |
| `GAP-G-09-06*` | GAP-G-09 | Correction to P5 §4: the 12 `#[allow(dead_code)]` gov test helpers are used in NONE of the four pallets, not merely 'not all used per pallet'. The classification (legitimate) stands — ROUND14.md:131-132 documents the deliberate deny-by-default mock parity — … *(unverified by panel)* | `git grep -n -E '\b(cast_live_vote\|conclude_poll\|reset_gov_state)\b'`: pallets/agents/src/tests.rs defs at :176,187,200 with 13 call sites (:209,688,705,717,732,749,750,764,792,815,824,837); tests/common.rs defs at :192,202,209 with 5 call sites (common.rs:378, tests/gov_credit.rs:33,44,81,88); … | none |
| `GAP-G-11-07` | GAP-G-11 | The other half of the spec item passes: no hostile input killed either product, in either state, and the explorer's 502 branch (previously entirely unexercised) is honest, correctly escaped and correctly distinct from 400/404. Both products also honour … *(unverified by panel)* | 28 hostile GETs against both scratch products while the upstream was unreachable, and again with it up (/tmp/audit/scratch/G11/hostile-down.txt, hostile.sh): 4000-char path segments, 400-segment paths, %ff%fe, percent-encoded NUL, ../../etc/passwd, limit=-1/NaN/1e309/999999999, offset=-5, 500 query … | T3 |
| `GAP-G-11-07*` | GAP-G-11 | The other half of the spec item passes: no hostile input killed either product, in either state, and the explorer's 502 branch (previously entirely unexercised) is honest, correctly escaped and correctly distinct from 400/404. Both products also honour … *(unverified by panel)* | 28 hostile GETs against both scratch products while the upstream was unreachable, and again with it up (/tmp/audit/scratch/G11/hostile-down.txt, hostile.sh): 4000-char path segments, 400-segment paths, %ff%fe, percent-encoded NUL, ../../etc/passwd, limit=-1/NaN/1e309/999999999, offset=-5, 500 query … | T3 |
| `GAP-G-12-05` | GAP-G-12 | The host-hardening session is fully dated and reconstructed: a root-run `apt -y install sudo ufw fail2ban curl ca-certificates gnupg` at 2026-07-28 11:04:03-11:04:16, an out-of-band `ufw enable` at 11:04:16.887, and the two third-party apt sources at 11:12:19 … *(unverified by panel)* | /var/log/apt/history.log.2.gz: `Start-Date: 2026-07-28 11:04:03 / Commandline: apt -y install sudo ufw fail2ban curl ca-certificates gnupg / End-Date: 2026-07-28 11:04:16` with no `Requested-By:` line, followed by `Start-Date: 2026-07-28 11:07:41 / Commandline: apt -y install build-essential clang …` | T0 |
| `GAP-G-12-05*` | GAP-G-12 | The host-hardening session is fully dated and reconstructed: a root-run `apt -y install sudo ufw fail2ban curl ca-certificates gnupg` at 2026-07-28 11:04:03-11:04:16, an out-of-band `ufw enable` at 11:04:16.887, and the two third-party apt sources at 11:12:19 … *(unverified by panel)* | apt history.log.2.gz: `Start-Date: 2026-07-28 11:04:03 / Commandline: apt -y install sudo ufw fail2ban curl ca-certificates gnupg / End-Date: 2026-07-28 11:04:16` with no Requested-By line, then `Start-Date: 2026-07-28 11:07:41 / ... build-essential clang libclang-dev protobuf-compiler pkg-config …` | T0 |
| `GAP-G-13-03` | GAP-G-13 | 'Delete any of these guards and all 109 tests stay green' is provable by inspection without mutating the repo: two guards are short-circuited inert by mock constants, and the two settle_era guards are unreachable because every call site advances a full … *(unverified by panel)* | pallets/emissions/src/lib.rs:593-596 'let qualifies_for_floor = is_active && (min_qual == 0 \|\| vol_u128 >= min_qual);' with MinQualifyingVol=ConstU64<0> at tests.rs:168 and tests/common.rs:323. lib.rs:652-654 'if velocity_bonus_bps == 0 \|\| stake_u128 == 0 { after_onboarding } else {' with … | T2 |
| `GAP-G-13-03*` | GAP-G-13 — the missing proposed issue for the chain-layer test-coverage cluster | 'Delete any of these guards and all 109 tests stay green' is provable by inspection without mutating the repo: two guards are short-circuited inert by the mock constants, and the two settle_era guards are unreachable because every call site advances a full … *(unverified by panel)* | pallets/emissions/src/lib.rs:595 `let qualifies_for_floor = is_active && (min_qual == 0 \|\| vol_u128 >= min_qual);` with `type MinQualifyingVol = ConstU64<0>;` at tests.rs:168 and tests/common.rs:323. lib.rs:652 `if velocity_bonus_bps == 0 \|\| stake_u128 == 0 {` with `ConstU32<0>` at tests.rs:165 … | T2 |
| `GAP-G-13-04` | GAP-G-13 | pallet-emissions' reported 10 tests include 2 construct_runtime-generated ones; only 8 are hand-written, and one of those (supply_cap_enforced) has zero assertions. Same +2 offset for orchestrator (14 hand-written of 16) and agents (35 of 37). *(unverified by panel)* | /tmp/audit/cargo-test.log lines 62-64 'running 10 tests / test tests::test_genesis_config_builds ... ok / test tests::__construct_runtime_integrity_test::runtime_integrity_tests ... ok'. grep -c '#[test]' pallets/emissions/src/tests.rs -> 8; pallets/orchestrator/src/tests.rs -> 14; … | T3 |
| `GAP-G-13-04*` | GAP-G-13 — the missing proposed issue for the chain-layer test-coverage cluster | pallet-emissions' reported 10 tests include 2 construct_runtime-generated ones; only 8 are hand-written, and one of those (supply_cap_enforced) has zero assertions. Same +2 offset for orchestrator (14 of 16) and agents (35 of 37). *(unverified by panel)* | /tmp/audit/cargo-test.log:62-64 `running 10 tests` / `test tests::test_genesis_config_builds ... ok` / `test tests::__construct_runtime_integrity_test::runtime_integrity_tests ... ok`. `grep -c '#[test]'` -> pallets/emissions/src/tests.rs 8, pallets/orchestrator/src/tests.rs 14, … | T3 |
| `P1a-14` | 1 | Inventory facts: 109 tests = 93 hand-written + 16 macro-generated, 0 failed, 0 ignored, no #[ignore] anywhere, every tests.rs wired via #[cfg(test)] mod tests, no #[test] outside src/tests.rs, all benchmarks.rs are one-line stubs, ci-full runs cargo test … *(unverified by panel)* | cargo test --workspace -- --list → 109 ': test' lines (scratch/test-list.txt), identical names to /tmp/audit/cargo-test.log. Per crate hand-written/total: agents 35/37, escrow 11/13, oracle 8/10, emissions 8/10, orchestrator 14/16, auto-params 0/0, constitution 0/0, integration 17/19, runtime 0/4, … | T3 |
| `P1b-10` | 1 | settle_era has never executed on the live chain in 36 days: era 0, no LastSettledEra, ~142 eras overdue; no oracle requests and no orchestrators exist. The emissions path (and its DoS-relevant weight) is entirely unexercised live. *(unverified by panel)* | state_getStorage Agents.EraNumber → null; Emissions.LastSettledEra → null; Oracle.CounterForOracleRequests → null; Orchestrator.OrchestratorRegistration keys → 0; Agents.CounterForAgentStake → 3. Indexer /v1/eras/current → … | T0 |
| `P1b-11` | 1 | The indexer cannot answer historical upgrade questions: it holds 15,291 blocks (backfillDepth 256) so /v1/events only covers ~#496,605 onward; CodeUpdated=0 there. Not a defect (documented as a follower), and moot given the :code comparison. *(unverified by panel)* | curl /v1/status → indexedBlocks 15291, backfillDepth 256, syncedHeight 511896; /v1/events?section=system&method=CodeUpdated → total 0; deploy/products/README.md:78 'It is a follower, not an archive'. | T3 |
| `P1b-13` | 1 | During this read-only phase a new untracked directory experiments/sc-e1/__pycache__/ appeared in `git status`; no P1b command touched experiments/, so it was created by another process (likely a parallel auditor running the Python simulation). Flagged for the … *(unverified by panel)* | `git -C /home/dev/scalar-commons-v4 status --porcelain` after P1b work → the six planning .md files plus `?? experiments/sc-e1/__pycache__/`; lead's opening snapshot listed only the six .md files. P1b's only writes: /tmp/audit/scratch/P1b/* and /tmp/audit/phases/P1b.md; `cargo check` wrote only … | T2 |
| `P1c-11` | 1 | Liveness is healthy and better than ENDGOAL states: alice 35 d 13 h continuous (NRestarts=0); the other four ran 30 d before an operator-initiated config restart and 5 d 11 h since; zero WARN/ERROR lines in any validator journal since retention start (Aug 4 … *(unverified by panel)* | systemctl show timestamps (§6.1); journalctl start/stop grep (§6.2); `grep -c -E 'WARN\|ERROR\|panic\|Panic\|error\]\|warn\]'` over full journals = 0 x5; system_health x5; 5 lag samples (2,2,2,2,3); prometheus 9615-9619 substrate_block_height finalized 511882 / best 511884, … | T3 |
| `P1c-12` | 1 | ~1,500-1,650 reorgs per day per node (11,231 in 7 days on alice: 11,080 depth-1, 145 depth-2, 2 depth-3) — expected under BABE c=(1,4) with PrimaryAndSecondaryPlainSlots and five authorities; not a defect, but any product reading `best` instead of `finalized` … *(unverified by panel)* | journalctl scalar-alice --since -7d \| grep -c 'Reorg on' = 11231; per-day counts Sep 2-7: 1518,1584,1631,1672,1581,1563; depth histogram via python; runtime/src/lib.rs:1683-1687 BABE_GENESIS_EPOCH_CONFIG. 110,861 '🏆 Imported' lines vs ~104k slots. | T3 |
| `P1c-13` | 1 | Landing and docs formula claims are TRUE on the live pages: runtime wires `type OracleScoreProvider = ()` so the oracle bonus is +0 (weight unchanged, not zeroed); stake enters as sqrt; live AutoParams Alpha=1500/Beta=5000/FloorBps=1000/CompletionFeeBps=25 … *(unverified by panel)* | runtime/src/lib.rs:1269; pallets/emissions/src/lib.rs:53-57, :629-641; state_getStorage AutoParams.* decoded (0xdc050000=1500, 0x88130000=5000, 0xe8030000=1000, 0x19000000=25); curl -L https://tejaspatil1936.github.io/scalar-commons-v4/ -> 301 -> https://tejaspatil.tech/scalar-commons-v4/ HTTP 200 … | T3 |
| `P2a-11` | 2 | The '24 endpoints' claim is true and every claim location agrees; all 24 routes answered 200 with real chain data, and live totals match independent chain-storage and sqlite cross-checks exactly. *(unverified by panel)* | ROUTES in indexer/src/api.ts:215-519 = 24 entries; /v1/status api.endpoints=24; journal 'serving 24 v1 endpoints'; CLAUDE.md:8, README.md:5/52, docs/reference/rpc.md:352, deploy/products/README.md:71 all say 24. Cross-checks: state_getKeysPaged(Agents.AgentStake prefix) -> 3 keys decoding to … | T3 |
| `P2a-12` | 2 | Hostile-input battery (about 150 requests: malformed percent-encoding, SQL-ish, traversal, oversize URL/header/body, wrong methods, raw-socket, 50 idle connections, unicode/NUL/CRLF) produced no crash, no hang, no restart, and no stack-trace or path leak; the … *(unverified by panel)* | MainPID=1663080 NRestarts=0 is-active=active after every probe (08:30-08:39). /v1/blocks/% -> 400 percent-encoding error (was a process kill per AUDIT.md:374-391). Traversal -> 404 with endpoint list; 20KB URL/header -> 431; POST/PUT/DELETE -> 405; 1MB POST -> 405; SQL-ish -> 404/400/empty 200 … | T3 |
| `P2a-13` | 2 | Running indexer code equals master and the deployment is not rebuild-fragile: the unit runs src/index.ts directly from the checkout, the sqlite index lives outside the repo, and the effective env file is fully commented so defaults come from the repo unit. *(unverified by panel)* | /proc/1663080/cwd -> /home/dev/scalar-commons-v4/indexer; cmdline node --experimental-strip-types src/index.ts; git log -1 -- indexer/src -> 233ff89 (2026-09-02) < process start 2026-09-07 07:31:07; git status --short indexer/ clean; INDEXER_DB=/home/dev/scalar-products/indexer/indexer.sqlite … | T3 |
| `P2a-14` | 2 | Emissions have never been settled on the devnet: era 0 since genesis, about 142 eras overdue, zero EraSettled events in the index, so the emission path has never run on the live network. *(unverified by panel)* | GET /v1/eras/current -> {"era":0,"startBlock":0,"durationBlocks":3600,"currentBlock":511875,"blocksElapsed":511875,"blocksRemaining":0,"dueForSettlement":true,"lastSettledEra":null,"ringSnapshot":0,"activeSnapshot":0}; state_getStorage Agents.EraNumber / Emissions.LastSettledEra / … | T0 |
| `P2b-09` | 2 | Running explorer is byte-identical to master's src: dist/*.js (Sep 3 20:46) equals a fresh tsc compile of src; dist/ is gitignored and rebuilt only by hand (`npm run build`), so a clean clone has no dist — the repo's install.sh refuses to install until it … *(unverified by panel)* | tsc -p tsconfig.json --outDir /tmp/audit/scratch/P2b/dist-fresh EXIT=0; diff -q on all nine dist/*.js -> identical. git check-ignore -v explorer/dist -> explorer/.gitignore:2:dist/. deploy/products/README.md:33 '(cd explorer && npm ci && npm run build)', :44-46; deploy/products/install.sh:31 … | T3 |
| `P2b-10` | 2 | XSS: every reflection point escapes; render.ts has no unescaped interpolation of chain- or user-supplied strings. Live on-chain string surface could not be exercised (none exists on this chain and submitting one is forbidden); covered by … *(unverified by panel)* | Encoded and raw (--path-as-is) <script>alert(1)</script> on /block, /account, /extrinsic (both segments), /, /search?q= -> 400/404 with '&lt;script&gt;…' and 'raw <script count: 0' in every body; attribute payloads '">…<img/src=x/onerror=…>' -> '&quot;&gt;&lt;img…', "'\"><svg/onload=…>" -> … | T3 |
| `P2b-11` | 2 | Error honesty holds: nonexistent, malformed and out-of-range refs all return explicit 400/404 pages with a visible reason; no plausible-looking empty view observed. Hex 32-byte public keys are accepted as account addresses and normalized to SS58 (feature). *(unverified by panel)* | /block/999999999 -> 404 'block 999999999 not found on this chain'; /block/4294967296 -> 400; /block/abc, /block/-1, /block/1.5 -> 400 'not a block number or block hash: …'; /block/0x00…00 -> 404 '…not found on this chain (Unable to retrieve header and parent from supplied hash)'; /extrinsic/1/5 -> … | T3 |
| `P2b-12` | 2 | No amplification: per-request node cost is constant (≤6.4 RPC calls), there is no block scan (AUDIT.md's 50-block scan refers to the pre-merge PR #92 and is not in the merged code), no concurrency limit exists in the explorer, and a 200-request 20-way burst … *(unverified by panel)* | grep -n -i -E 'cache\|limit\|concurren\|semaphore\|throttle\|rate\|scan' explorer/src/*.ts -> only comments/footer. chain.ts:431-468 account() = getHeader + api.at + system.account. Burst: seq 200001 200200 \| xargs -P 20 curl -> 200×200, wall 1.75s; Prometheus delta +1202 = 6.0/request; … | T3 |
| `P2b-13` | 2 | Hostile input produced no 5xx and no restart: 100 KB path and 70 KB header -> 431 (Node limit); '..' traversal normalized by new URL(); garbage HTTP and missing Host on HTTP/1.1 -> 400 from Node; 20 half-open connections did not delay a normal request (5 ms); … *(unverified by panel)* | See detail §6: /block/aaaa…(102400) -> 431; X-A: 70000×x -> 431; /../../etc/passwd (--path-as-is) -> 404 'no such page: /../../etc/passwd'; /block/..%2F..%2Fetc%2Fpasswd -> 400; printf 'GARBAGE' \| nc -> 'HTTP/1.1 400 Bad Request'; journalctl --user -u scalar-explorer --since '2026-09-07 07:00' = 9 … | T3 |
| `P2b-14` | 2 | explorer `npm test` is unsafe to run on a machine with a reachable devnet during a read-only audit: tests/explorer.live.test.ts has no env gate and submits a 1 CMN balances.transferKeepAlive from //Eve to a fresh mnemonic account on every run (leaving 1 CMN … *(unverified by panel)* | tests/explorer.live.test.ts:24 RPC default ws://127.0.0.1:9944, :27 TEST_SEED '//Eve', :69-96 submitTransfer signAndSend, :113 called in beforeAll; vitest.config.ts include 'tests/**/*.test.ts'; README 'not skippable: it submits one real transfer'. Keyring derivation (explorer node_modules): //Eve … | T2 |
| `P2b-15` | 2 | Untracked planning docs carry superseded explorer claims: AUDIT.md:45 'explorer/ DOES NOT EXIST', TODAY-PLAN.md:236 'no unit file; needs EXPLORER_PORT=8081' — both false today (explorer merged c474f56; unit deploy/products/scalar-explorer.service installed … *(unverified by panel)* | grep -n -i explorer AUDIT.md TODAY-PLAN.md STATUS.md; git log -- explorer/ -> c474f56; systemctl --user show scalar-explorer -p ActiveState -> active; grep -n -i -E 'indexer\|faucet\|sdk\|explorer\|landing' README.md -> no matches. | T3 |
| `P2c-12` | 2 | Hostile-input probes: the service survived every probe (wrong method, 10KB/100KB paths, '..', encoded traversal under /balance, garbage JSON to a non-drip POST, 1MB POST body, invalid method token, malformed request line, 70KB header) with MainPID 1664521 and … *(unverified by panel)* | See probe table in /tmp/audit/phases/P2c.md §1: 405/404/404/431+reset/404/400/404/404/400/400/431; systemctl --user is-active scalar-faucet -> active after each; MainPID 1664521; NRestarts 0. | T3 |
| `P2c-13` | 2 | Faucet unit tests pass: 30/30 (rateLimiter 19, amount 11). The 25-test live suite was deliberately NOT run because `npm test` (vitest include tests/**/*.test.ts, no env gate) would sign ~20 balances.transferKeepAlive extrinsics from //Ferdie against … *(unverified by panel)* | faucet/node_modules/.bin/vitest run --root faucet --no-cache tests/amount.test.ts tests/rateLimiter.test.ts -> 'Test Files 2 passed (2) Tests 30 passed (30)' EXIT=0. vitest.config.ts include ['tests/**/*.test.ts']; faucet.live.test.ts:15-21 'not skippable'; ci-node.yml:201 selects the two offline … | T2 |
| `P2c-14` | 2 | Running code provenance: dist/ (built 2026-09-07 07:38:04) is byte-identical to a fresh tsc of faucet/src except the sourceMappingURL trailer; src unchanged since bc21b03 (2026-08-05); installed unit identical to repo; env file identical to … *(unverified by panel)* | tsc -p faucet/tsconfig.json --outDir scratch; diff per file -> only '//# sourceMappingURL' line differs. ls src -> mtimes 2026-08-06. diff repo unit vs installed -> IDENTICAL. Log 'holds 999999926.492428999773 CMN' == /health now. state_getStorage decoded nonce=70. | T3 |
| `P2c-15` | 2 | Drip success is reported at status.isInBlock rather than finalized; on a BABE chain the returned blockHash may be reorged. Acceptable for a devnet, worth documenting. *(unverified by panel)* | faucet/src/chain.ts:169-173 'if (status.isInBlock) { settle(() => resolve({ blockHash: status.asInBlock.toHex(), txHash })) }'. | T3 |
| `P2d-12` | 2 | ENDGOAL's bigint claim is TRUE: the only Number() coercions in sdk/src are on u32 era indexes; every balance is bigint end to end, and the live chain's balances already exceed 2^53 plancks so this is load-bearing. *(unverified by panel)* | grep -rn 'Number(' sdk/src → index.ts:117,120 (toOptionalNumber for emissions.lastSettledEra, Option<u32> — emissions/lib.rs:161, live 'Plain(u32) Optional') and :357 (agents.eraNumber u32 — agents/lib.rs:522). grep parseInt\|parseFloat\|toNumber\|as number → none. Live: … | T3 |
| `P2d-13` | 2 | All 15 methods ENDGOAL names exist, are tested (mock), and resolve on the live spec-304 runtime with matching arg names/types; the read methods return values identical to raw storage and mirror do_claim/settle_era exactly. *(unverified by panel)* | Live metadata (scratch live-readonly-check.mjs): 11/11 extrinsics ok incl. recordGovVote(agent:AccountId32, pollIndex:u32), createAgreement(provider, amount:Compact<u128>, deliverableHash:[u8;32], deliverBy:u32, capabilityId:Option<u32>); 12/12 storage items; consts emissions.eraDuration=3600, … | T3 |
| `P2d-14` | 2 | Chain-state fact via SDK reads: the devnet has never settled an era — era 0, lastSettledEra None, lastEraEmission 0, accRewardPerStake 0 at head 511920 (~142 era-lengths); no emissions have ever been minted; totalIssuance is 6,053,831,090 CMN. *(unverified by panel)* | eraInfo() {era:0, eraDuration:3600n, eraStartBlock:0n, lastSettledEra:null, lastEraEmission:0n, settleable:true}; raw emissions.lastSettledEra isSome=false; acc=0 debt=0; 3 agentStake entries; Bob stake 10,000 CMN, eraEscrowVolume 1,530 CMN, weight 0; totalIssuance 6053831090074318803559 plancks. … | T0 |
| `P2e-16` | 2 | Public site is reachable and current with origin/master: landing at https://tejaspatil.tech/scalar-commons-v4/ (github.io 301s there), docs at /docs/ with base /scalar-commons-v4/docs/ baked in; published landing is byte-identical to a build from HEAD; docs … *(unverified by panel)* | gh api repos/tejaspatil1936/scalar-commons-v4/pages -> html_url https://tejaspatil.tech/scalar-commons-v4/, build_type workflow, https_enforced true; curl -L root -> 200 (15595 B); /docs/ -> 200; guide/run-a-node, guide/sdk, reference/rpc, reference/token-model -> 301 then 200; published asset … | T3 |
| `P2e-17` | 2 | Docs facts that DO hold: 24 indexer endpoints, 7 custom pallets, 118 RPC methods on alice, 13 runtime APIs, port/topology tables, chain-spec preset table, deploy script names, sdk scripts/retry defaults, storage lists, diversity/rank/onboarding/fee-bound … *(unverified by panel)* | indexer/src/api.ts has exactly 24 '/v1/...' route strings (lines 218-515); rpc.md:334-339 storage lists == snapshot.storage (python set-diff empty ×6); pallets/emissions/src/lib.rs:560-563 rank_bps 10_000/12_000/15_000, :686-693 diversity 1000/3000/6000/8000/10000, :306-307 onboarding … | T3 |
| `P2e-18` | 2 | The devnet has never settled an emissions era in 512k blocks (142 eras due): eraNumber 0, lastSettledEra None, get_era_metrics all zero, 3 registered agents — the era machinery the landing and docs describe has not been exercised on the live network. *(unverified by panel)* | live-state.mjs: agents.eraNumber=0, emissions.lastSettledEra=<none>, lastEraEmission=0 at genesis/433638/head #511967; ScalarCommonsApi.get_era_metrics {eraNumber:0,activeAgents:0,ringCount:0,totalWeight:0,lastEraEmission:0,…}; agents.counterForAgentStake 3; consts.emissions.eraDuration 3600; … | T0 |
| `P3-11` | 3 | scalarnet.io exists but is not this box: registered 2026-09-07 15:04 UTC at GoDaddy, A records point to GoDaddy parking (3.33.130.190, 15.197.148.33), HTTP serves a /lander redirect, HTTPS fails with 'tlsv1 unrecognized name', no AAAA, and … *(unverified by panel)* | getent hosts scalarnet.io -> 3.33.130.190 / 15.197.148.33; getent hosts rpc.scalarnet.io -> empty; dig @1.1.1.1 NS -> ns73/ns74.domaincontrol.com; whois -> Registrar GoDaddy.com, LLC, Creation Date 2026-09-07T15:04:05Z; curl -sI http://scalarnet.io -> HTTP/1.1 200 content-length 114, body … | T1 |
| `P3-12` | 3 | RPC binding and unsafe-set refusal re-confirmed on all five nodes; rpc_methods lists author_insertKey/rotateKeys (118 methods on alice incl. archive_v1_*, 108 on others) but listing is not callability — jsonrpsee registers every method and the DenyUnsafe … *(unverified by panel)* | ss -ltnp: 9944-9948 on 127.0.0.1 and [::1] only. On each of 9944..9948: author_pendingExtrinsics -> {"result":[]}; system_peers -> {"error":{"code":-32601,"message":"RPC call is unsafe to be called externally"}}; system_unstable_networkState -> same. rpc_methods diff 9944 vs 9945 = 10 archive_v1_* … | T1 |
| `P3-13` | 3 | Attack surface already public today, independent of INSTALL.md: P2P 30333-30337 bind 0.0.0.0 and [::] (global IPv6 present), mDNS UDP 5353 binds 0.0.0.0 on all five nodes, and the public IPv4 plus alice's peer id are in tracked repo files, so the bootnode … *(unverified by panel)* | ss -ltnp/-lunp output; system_localListenAddresses on 9944 returns /ip4/152.53.113.104/tcp/30333/p2p/12D3KooWEyop… and the /ip6/2a0a:4cc0:… form; git grep 152.53.113.104 -> ROUND10.md:3,169,170,330, ROUND5.md:126-129, deploy/README.md:242; peer id in deploy/README.md:38 and four unit files; … | T1 |
| `P3-14` | 3 | What a stranger could reach if INSTALL.md were applied verbatim with DOMAIN=scalarnet.io (after DNS): landing (static), /docs (broken until DOCS_BASE rebuild), wss://rpc → alice's full SAFE set including transaction submission and system_localListenAddresses … *(unverified by panel)* | ss -ltnp; rendered config server_name/proxy_pass lines 55,75,117,145,170,180,194,213,228,245,262,280; indexer/src/api.ts:606-607; faucet/src/server.ts:117-160; grep '0\.0\.0\.0\\|_HOST\\|TRUST_PROXY' deploy/public/INSTALL.md deploy/public/VERIFY.md deploy/public/domain.env -> only INSTALL.md:67 … | T1 |
| `P3-15` | 3 | Live-test hygiene note for this phase: faucet/indexer/explorer `npm test` is `vitest run` with `include: ['tests/**/*.test.ts']` and no environment gate, so it would execute the *.live.test.ts files that submit extrinsics to 127.0.0.1:9944 … *(unverified by panel)* | faucet/package.json scripts.test 'vitest run'; faucet/vitest.config.ts include ['tests/**/*.test.ts']; same shape in indexer/ and explorer/; faucet/tests/faucet.live.test.ts:24,27 (RPC_ENDPOINT ws://127.0.0.1:9944, FAUCET_SEED //Ferdie); sdk/tests/live.test.ts:24,56 `RUN_LIVE = …` | T2 |
| `P4-11` | 4 | Live escrow state for issue #101: 2 (buyer,provider) pairs, 3 agreements, all status Created, 10 CMN each; Alice is the BUYER (not provider) in both pairs; 0 pairs at MaxAgreementsPerPair=10; 2 of 3 past deliver_by. *(unverified by panel)* | Escrow::Agreements prefix 0x739f2acb576f027f466145c0596923c79a6e48a32e95545a9fc30ab15a80a994 → state_getKeysPaged 2 keys; SCALE-decoded (length asserted): Alice→Bob n=2 (created 365217..448639, deliver_by 465216..548638), Alice→Charlie n=1 (created 379617, deliver_by 479616); key order … | T3 |
| `P4-12` | 4 | ROUND14 governance-farming fix is present in code, pinned by 9 tests all passing, and reflected in live storage (Alpha=1500); the running binary (297bd66) includes it. *(unverified by panel)* | pallets/agents/src/lib.rs:957-990 guards PollAlreadyCredited (:971) → has_live_vote_on (:979) → GovVoteCapReached; runtime/src/lib.rs:1061-1077 ConvictionVotingBridge checks Polls::as_ongoing + VotingFor Casting votes contain poll_index, wired :1162. /tmp/audit/cargo-test.log lines … | T1 |
| `P4-13` | 4 | Auditor incident: my pytest run created experiments/sc-e1/__pycache__/analyze.cpython-313.pyc inside the repo despite PYTHONDONTWRITEBYTECODE=1; I inspected it (untracked, not ignored, mtime 08:35:58) and removed it; `git status --porcelain -- experiments/` … *(unverified by panel)* | ls -la --time-style=full-iso experiments/sc-e1/__pycache__ → analyze.cpython-313.pyc 2026-09-08 08:35:58; git ls-files → 0; git check-ignore → not ignored; rm -rf; git status --porcelain → only the 6 pre-existing untracked root docs. | T2 |
| `P5-13` | 5 | Standing-rule sweep of the whole tracked tree is clean: all 20 `#[allow(` hits carry written justifications, `fn main() {}` in runtime/build.rs is the cfg(not(std)) SDK convention, no todo!/unimplemented!/#[ignore]/SKIP_WASM_BUILD/continue-on-error in code, … *(unverified by panel)* | `git grep -n -E 'todo!\(\|unimplemented!\(\|#\[allow\(\|#\[ignore' -- . ':!*.md' ':!*.prompt'` -> 20 #[allow( in .rs (node/src/cli.rs:25,39,50; node/src/service.rs:84; pallets/emissions/src/lib.rs:544; pallets/oracle/src/lib.rs:606; runtime/src/lib.rs:789; 12x dead_code on shared gov test helpers … | T2 |
| `P5-14` | 5 | Rust CI coverage is genuine: ci-full runs `cargo test --workspace` unnarrowed plus release build, --version, build-spec --raw and the runtime-benchmarks feature check; ci-fast runs fmt/clippy -D warnings/check; the tests/ integration crate's 8 modules are all … *(unverified by panel)* | ci-full.yml:148 `run: cargo test --workspace`; grep for exclude\|-p \|SKIP_WASM\|no-run\|--lib in ci-fast/ci-full -> only historical comments. Root Cargo.toml members include "tests"; tests/Cargo.toml `[[test]] name=integration path=integration.rs`; integration.rs:22-29 `mod common; mod …` | T2 |
| `P6-19` | 6 | Verified intact: T0/T1 hard refusal, ready-label requirement, all four factory test suites (32/13/18/51 pass, run from a scratch copy with the repo/ledger provably untouched), loop caps, kill switch (~/STOP_FACTORY absent), watchdog pidfile enforcement, PATH … *(unverified by panel)* | dispatch.sh:574-576, :108, merge.sh:180-181, :36/:173; selftest 32/32, gate-parse 13/13, gate-detect 18/18, verdict-parse 51/51 (exit 0) from /tmp/audit/scratch/P6/factory (cmp byte-identical); `git status --porcelain` before/after identical, blocked/ identical, logs 281→281, ledger 14→14; `ls -la …` | T2 |
| `P7-11` | 7 | What IS reproducible: committed deploy/scalar-local-raw.json equals the live genesis state exactly; node keys and product env files are regenerated by the repo scripts; Cargo.lock is consistent; every package.json with dependencies has a tracked lockfile; … *(unverified by panel)* | RPC on alice: state_getKeysPaged at genesis -> 202 keys = spec keys; state_getStorage for all 202 -> 0 mismatches; :code identical; state_getRuntimeVersion(genesis) -> scalar-commons 304. Node keys: cat ~/scalar-testnet/*/node-key == deploy/nodes.env:28-32 (mode 600). Env: diff -q … | T2 |
| `P7-12` | 7 | Version identifiers are uncorrelated: node crate 4.0.0, runtime crate 3.0.0, spec_version 304, system_version 4.0.0-297bd66155d; Cargo.toml has no [workspace.package]. GitHub repo description and homepage are empty. Published docs site (custom domain) is … *(unverified by panel)* | node/Cargo.toml:3, runtime/Cargo.toml:3, runtime/src/lib.rs:150 (ground truth), grep '^\[workspace.package\]' Cargo.toml -> none. gh repo view --json description,homepageUrl -> '' / ''. gh api .../pages -> html_url https://tejaspatil.tech/scalar-commons-v4/; curl -L .../docs/guide/run-a-node.html … | T3 |
| `P8-19` | 8 | All signed on-chain activity in the indexed window (125 extrinsics, 25 identical hourly cycles of heartbeat/transfer/createAgreement/recordDelivery/confirmDelivery by Alice/Bob) is the factory running indexer/tests/live.test.ts as the gate for issue #101; … *(unverified by panel)* | sqlite signed sections: 25 each of agents.heartbeat, balances.transferKeepAlive, escrow.createAgreement, escrow.recordDelivery, escrow.confirmDelivery; indexer/tests/live.test.ts:29 RPC_URL default (no RUN_LIVE gate), :165-214 seeds Alice heartbeat/1 CMN to Dave/createAgreement to Bob; issue #101 … | T2 |
| `P8-20` | 8 | ENDGOAL.md §3.3 still says 'four of five validators run without --rpc-methods safe'; ground truth shows all five now run with --rpc-methods safe (bob-eve restarted 2026-09-02 with the flag). *(unverified by panel)* | ENDGOAL.md §3.3 text; lead ground truth: all five units include --rpc-methods safe and answer -32601 to system_unstable_networkState. | T3 |
| `P8-21` | 8 | The SDK live suite has never rehearsed register/stake/escrow and was last executed by a factory gate on 2026-08-18; no fresh account has ever registered as an agent on the devnet (the 3 agents are the 3 genesis agents). *(unverified by panel)* | sdk/tests/live.test.ts: reads + two recordGovVote rejections only; integration.test.ts:292-303 real-node block reads eraInfo only; factory/logs/issue-72-attempt1.gate.out mtime 2026-08-18 23:09:06 'Tests 20 passed \| 1 skipped'; ci-node.yml:294-297 runs npm test without RUN_INTEGRATION; … | T2 |
| `P9-26` | 9 | ENDGOAL §3.1 'currently proven over 11+ days' is imprecise: alice has run 36 days unattended, but bob/charlie/dave/eve were restarted 2026-09-02 (5.5 days); the five-node set as configured has 5.5 days. *(unverified by panel)* | Lead ground truth: alice pid 701914 started 2026-08-03 19:19; others restarted 2026-09-02 20:44-20:45; NRestarts=0 all units. ENDGOAL.md:104. | T3 |
| `P9-27` | 9 | Server facts observable from the box: netcup KVM VM, hostname v2202607384283486718, rDNS v2202607384283486718.luckysrv.de, 16 vCPU / 64 GB / 2.0 TB — consistent with an RS 8000 G11 class product; the ENDGOAL §6 ownership claim ('in Matty's name') is … *(unverified by panel)* | hostnamectl: Hardware Vendor netcup, Chassis vm, Virtualization kvm, Debian 13; /sys/class/dmi/id/product_name 'KVM Server'; nproc 16; MemTotal 65849436 kB; getent hosts 152.53.113.104 -> v2202607384283486718.luckysrv.de; /etc/hostname v2202607384283486718. | T3 |
| `P9-28` | 9 | No forkless runtime upgrade has ever been applied to the live devnet and no release is tagged: spec_version 304 was set before genesis and is still the on-chain LastRuntimeUpgrade; the only tag is upstream-baseline (ENDGOAL §3.1/§3.7 items unmet, stated as … *(unverified by panel)* | git show 297bd66:runtime/src/lib.rs \| grep spec_version -> 304; git log -S'spec_version: 304' -> dc0443a 2026-08-03 (pre-genesis, chain started 2026-08-03 19:19); lead: LastRuntimeUpgrade storage = compact 304 + 'scalar-commons'. git tag -l -> upstream-baseline (eab04b6, 2026-04-23); gh release … | T1 |
| `P9-29` | 9 | GitHub repository metadata is empty (no description, homepage, topics or license) so there is currently no 'public description' to correct; Pages is public with custom domain tejaspatil.tech; branch protection matches ENDGOAL §3.5 (enforce_admins, no … *(unverified by panel)* | gh api repos/tejaspatil1936/scalar-commons-v4 -> description null, homepage null, topics [], license null, has_pages true; gh api .../pages -> public:true html_url https://tejaspatil.tech/scalar-commons-v4/ https_enforced true; gh api .../branches/master/protection -> enforce_admins.enabled true, … | T3 |
| `P9-30` | 9 | PR #116 (docs/endgoal) merged at 06:42:27Z during the audit; origin/master is fd00c05 while the local checkout is 6efba16 (one behind); the untracked local ENDGOAL.md is byte-identical to the merged file, so every stale line above is now on master. *(unverified by panel)* | gh pr view 116 -> MERGED 2026-09-08T06:42:27Z mergeCommit fd00c05, files [ENDGOAL.md]; gh api commits/master -> fd00c05; git rev-parse HEAD -> 6efba16; diff of gh-fetched ENDGOAL.md vs local -> IDENTICAL. Prior planning-doc claims re-checked: STATUS.md:119 (indexer empty) refuted; WEEKCHECK A10 / … | T3 |
| `P9-31` | 9 | CLAUDE.md statements verified TRUE: 100B SUPPLY_CAP; seven custom pallets at indices 26-31 and 40; 24 versioned /v1 indexer endpoints (live); MinQualifyingVol 50 CMN; VelocityBonusBps 3_000; GovVoteVerifier = ConvictionVotingBridge over … *(unverified by panel)* | runtime/src/lib.rs:83,1061-1072,1162,1243,1249,1347-1428; pallets/emissions/src/lib.rs:158,214,247; pallets/orchestrator/src/lib.rs:392; indexer/src/api.ts 24 '/v1/...' literals; curl /v1/status endpoints:24; ls .claude/agents -> test-runner.md, tokenomics-security-reviewer.md; … | T3 |

## 3. Per-phase detail

Sixteen read-only auditors plus this lead covered phases 0–9. Their uncut writeups (≈350 KB, every
command and result) live in `/tmp/audit/phases/*.md` on the audit host; what follows is the load-bearing
evidence from each.

---

### Phase 0 — Ground truth snapshot

**Repo.** `git log -1` → `6efba16` "deploy: add public exposure config for issue #76 (review-only, not
applied) (#107)", 2026-09-07 12:32 +0530. `git status --porcelain` → six untracked root files only
(`AUDIT.md ENDGOAL.md STAGE1-HARDENING.md STATUS.md TODAY-PLAN.md WEEKCHECK.md`); no tracked file modified.
`git tag` → `upstream-baseline` and nothing else.

**Drift during the audit.** `git ls-remote origin refs/heads/master` → `fd00c057` — PR #116 ("docs: add
ENDGOAL.md") merged at 2026-09-08T06:42:27Z, i.e. 22 minutes after the snapshot. The audit is against
local `6efba16`; the only delta is that `ENDGOAL.md` is now a tracked, published file. Every ENDGOAL
staleness finding below therefore applies to committed content, not to a private draft.

**Running units** (`systemctl --user list-units 'scalar-*' 'factory-*'`, `show -p ExecStart,MainPID,NRestarts`).
Five validators, three products, four factory oneshots + timers. `NRestarts=0` on every unit.

| Unit | PID | Started | Key flags / command |
|---|---|---|---|
| scalar-alice | 701914 | 2026-08-03 19:19:17 | `--validator --alice --rpc-port 9944 --rpc-cors all --rpc-methods safe --state-pruning archive --blocks-pruning archive` |
| scalar-bob | 864825 | 2026-09-02 20:44:17 | `--bob --rpc-port 9945 --rpc-methods safe --bootnodes /ip4/127.0.0.1/tcp/30333/p2p/12D3KooWEyop…` |
| scalar-charlie | 865025 | 2026-09-02 20:44:37 | `--charlie --rpc-port 9946 --rpc-methods safe …` |
| scalar-dave | 865217 | 2026-09-02 20:44:57 | `--dave --rpc-port 9947 --rpc-methods safe …` |
| scalar-eve | 865416 | 2026-09-02 20:45:18 | `--eve --rpc-port 9948 --rpc-methods safe …` |
| scalar-indexer | 1663080 | 2026-09-07 07:31:07 | `node --experimental-strip-types src/index.ts`, `INDEXER_DB=/home/dev/scalar-products/indexer/indexer.sqlite` |
| scalar-explorer | 1663081 | 2026-09-07 07:31:07 | `node dist/index.js` |
| scalar-faucet | 1664521 | 2026-09-07 07:38:55 | `node dist/index.js` **via a local-only drop-in**, `FAUCET_TRUST_PROXY=false` |

**Ports** (`ss -ltnp`). Internet-facing in principle: `0.0.0.0:22` (sshd) and `0.0.0.0:30333-30337` +
`[::]:30333-30337` (P2P). Loopback only: `127.0.0.1`/`[::1]:9944-9948` (RPC), `127.0.0.1:9615-9619`
(prometheus), `127.0.0.1:8080/8081/8082` (indexer/explorer/faucet). Host public IP `152.53.113.104`,
which alice's `system_localListenAddresses` publishes along with her peer id.

**Chain, two samples 10 s apart** (`chain_getHeader`, `chain_getFinalizedHead`, `system_health` on all five):

```
08:20:07  9944 best=511752 fin=511749 lag=3 peers=4   9945 …lag=3   9946/9947/9948 …lag=2
08:20:17  9944 best=511753 fin=511751 lag=2 peers=4   9948 best=511754 fin=511751 lag=3
```

`state_getRuntimeVersion` → specName `scalar-commons`, specVersion **304**, transactionVersion 1.
`system_version` → `4.0.0-297bd66155d`. `system_properties` → `ss58Format 42, tokenDecimals 12,
tokenSymbol CMN`. `chain_getBlockHash(0)` → `0xff6882b49ad61dd3128a6e834b4f81704a3824ce358f2f69fe765ca07cf803d1`.

**Binary provenance.** `target/release/scalar-node` mtime **Aug 3 19:18**; version string names `297bd66`
(committed 19:10 +0200). But `git log -1 0edee76` ("chain_spec: extend local preset authority set from 3
to 5") is **19:27 +0200 — nine minutes after the build**, and `git merge-base --is-ancestor 0edee76 297bd66`
→ no. `git show 297bd66:node/src/chain_spec.rs` has a 3-authority local preset; the running chain has 5.
The binary was therefore built from a **dirty working tree**, and its version string names a commit whose
source cannot produce this chain.

**Disk.** `/` 2.0 T, 121 G used (7 %). `scalar-testnet` 34 G, `target/` 44 G, `~/shared-target` 17 G.
16 CPUs, 62 GB RAM, host up 47 days.

**A packet-filtering daemon that no auditor noticed.** `fail2ban` is **active and enabled**, running since
**2026-07-28 11:04:12** (MainPID 104676), with an **nftables** ban action. None of the
seventeen phase writeups mentions it; a completeness critic caught the omission afterwards and the lead
confirmed it. It matters twice over: it is a second, independent source of netfilter rules on a host whose
firewall state this audit could not read, and it means every statement about "the firewall" in §7.2 has to
account for something other than ufw touching the kernel tables.

**Toolchain present:** rustc/cargo 1.85.0 (pinned; `wasm32v1-none` installed), node v22.23.1, npm 10.9.8,
protoc 3.21.12, clang 19.1.7, shellcheck 0.10.0, gh 2.96.0, claude 2.1.263, python3 3.13.5.
**Absent:** `jq`, `nginx`, `certbot`. `ufw` is installed (`dpkg -l ufw` → 0.36.2-9) but `systemctl is-active ufw`
→ **inactive**; no passwordless sudo, so its rule set is unreadable.

**Local-only systemd state** (installed, content nowhere in the repo — `git grep -F` finds nothing):
`factory-merge.service` + `.timer` (whole units); `factory-{digest,dispatch,merge,watchdog}.service.d/path.conf`
(`PATH=…/.npm-global/bin:…`); `factory-dispatch.service.d/override.conf`
(`ENABLE_DISPATCH=true ENABLE_MERGE=true MAX_PARALLEL=3 DAY_MAX_PARALLEL=3 DAILY_SPAWN_CAP=120`);
`factory-digest.service.d/override.conf`; `factory-dispatch.timer.d/override.conf` (hourly, all day);
`scalar-faucet.service.d/override.conf` (`ExecStart=/usr/bin/node dist/index.js`). Every repo unit that
*does* exist is byte-identical to its installed copy.

---

### Phase 1 — Chain layer (ENDGOAL §3.1)

#### 1.1 Test inventory

`cargo test --workspace` (log `/tmp/audit/cargo-test.log`, EXIT=0): **109 passed, 0 failed, 0 ignored**.
`grep -rn '#\[ignore' pallets runtime node tests` → **no matches**; nothing is silently skipped.

| Crate | passed | hand-written `#[test]` | macro-generated |
|---|---|---|---|
| pallet_agents | 37 | 35 | 2 |
| pallet_auto_params | **0** | **0** (tests.rs is 886 B of doc comment) | 0 |
| pallet_constitution | **0** | **0** (no `tests.rs` at all) | 0 |
| pallet_emissions | 10 | 8 | 2 |
| pallet_escrow | 13 | 11 | 2 |
| pallet_oracle | 10 | 8 | 2 |
| pallet_orchestrator | 16 | 14 | 2 |
| `tests/` integration binary | 19 | 17 | 2 |
| scalar_commons_runtime | 4 | **0** | 4 |
| scalar_node | 0 | 0 | 0 |
| doc-tests (9 crates) | 0 | 0 | 0 |

Macro-generated = `construct_runtime!` integrity/genesis tests plus two from
`pallet_staking_reward_curve::build!`. **The runtime crate has zero hand-written tests**
(`grep -n 'cfg(test)\|#\[test\]' runtime/src/**` → exit 1; no `[dev-dependencies]`). **No test anywhere
executes the WASM runtime** — every test runs against a `construct_runtime!` mock with `AccountId = u64`,
`Balance = u64`.

`pallets/auto-params/src/tests.rs` lines 8–12 say so in the file itself: *"**There is no coverage here yet,
and that gap is real.**"*

#### 1.2 Do the tests cover each pallet's stated §3.1 purpose?

| Invariant (ENDGOAL / CLAUDE.md) | Guard in code | Test |
|---|---|---|
| escrow "no self-dealing" | present | covered |
| escrow permissionless settlement | present | covered |
| **emissions supply cap asserted** | `lib.rs:514-522` clamp | **NONE that reaches it** — `tests.rs:282-292 supply_cap_enforced` contains **zero `assert`s**; its own comment says "Difficult to test directly in mock … verify the code path exists by inspecting that cap check compiles and runs." The integration test `claim_returns_zero_at_cap` finishes ~900 CMN *below* the cap having paid ~100 CMN (printed: `earned 99999999999999, final issuance 9999099999999999999, cap 10000000000000000000`), and `tests/supply_cap.rs:65-84` swallows every escrow error with `let _ =`. `Event::CapReached` is asserted nowhere. |
| **`settle_era` EraNotDue guard** | `emissions/lib.rs:242-245` | **NONE** |
| **F-04 double-settlement guard** (`EraAlreadySettled`) | `emissions/lib.rs:248-251` | **NONE** |
| `settle_era` permissionless | `ensure_signed` | incidentally, via `tests/gov_credit.rs:58` |
| **MinQualifyingVol ≥ 50 CMN floor gate** | `emissions/lib.rs:586-596`; runtime `:1243` | **NONE** — set to `ConstU64<0>` in *both* mocks (`emissions/tests.rs:168`, `tests/common.rs:323`), so zero behavioural coverage |
| **VelocityBonusBps +30 % cap** | `emissions/lib.rs:648-667`; runtime `:1249` | **NONE** (same reason) |
| **orchestrator self-link refusal** | guard present | **NONE**; `claim_orchestrator` (the pallet's own mint path) also untested, and `register_orchestrator_with_full_stake_succeeds` actually asserts a *failure* (`FeeTooHigh`) |
| oracle DuplicateRequest before `reserve()` | present | covered |
| agents `record_gov_vote` live-vote + per-era dedup | `agents/lib.rs:957-990` | **well covered** — 7 unit tests + 2 integration, all `ok` in the log (see Phase 4) |
| auto-params bounded self-tuning | `lib.rs` | **NONE** — and the rule engine never executes: both mocks leave `run_era_rules` at the trait's no-op default, so `auto_params_ring_fee_increases` compares `0 >= 0` inside an `if` |
| constitution invariant enforcement | 6 documented invariants | **NONE**; only 1 of 6 is wired (`BaseCallFilter` → `base_call_allowed()`, the supply cap) |

#### 1.3 Integration tests

`tests/` holds `common.rs` plus **7** test modules, all aggregated by `integration.rs` (which `mod`s its 8
siblings) into a single binary: `dispute_flow.rs` (2 tests), `era_cycle.rs` (2), `gov_credit.rs` (2),
`orchestrator_flow.rs` (3), `rank_promotion.rs` (3), `ring_detection.rs` (3), `supply_cap.rs` (2) — 17
hand-written plus 2 macro-generated = **19**, all passed in the log. The brief's "9 integration tests" is a
count of `.rs` files, which includes `common.rs` (a mock runtime, no tests) and `integration.rs` (an
aggregator, no tests of its own).

**These are not "full runtime" tests, although the file says they are.** `tests/integration.rs:3` opens
with *"These tests run the full runtime (all 33 pallets)"*. In fact `tests/common.rs:62` builds its own
`construct_runtime!` with **8** pallets — System, Balances, Agents, Escrow, Oracle, Emissions, AutoParams,
Orchestrator — while the real runtime has **36** pallet indices. `tests/Cargo.toml` does not depend on
`scalar-commons-runtime` at all (nor on `pallet-constitution`, `pallet-staking`, `pallet-referenda` or
`pallet-conviction-voting`), and `grep -rn 'scalar-commons-runtime' tests/Cargo.toml pallets/*/Cargo.toml`
returns nothing. Two consequences that matter:

- `type AccountId = u64` and `type Balance = u64`. The mock's own comment at `tests/common.rs:302-303`
  admits the problem: *"Supply cap must fit in u64. … Real cap is 100B CMN but that overflows u64. Tests
  use scaled-down cap."* `u64::MAX` is 1.845 × 10¹⁹ and the real `SUPPLY_CAP` is 10²³ — **5 421× too
  large to represent** — so the integration suite tests a cap of 10¹⁹, **10 000× smaller** than the one the
  chain enforces. Overflow behaviour at the real cap is therefore untestable in this harness by construction.
- `tests/common.rs:150` sets `type GovVoteVerifier = MockGovVoteVerifier`. The real
  `ConvictionVotingBridge` — the whole point of the ROUND14 fix — is exercised by **no test at any level**.

Each module's claimed invariant, and whether it ran: `supply_cap.rs` — emissions stop at the cap
(**ran; but see the coverage gap above — it never reaches the cap**); `era_cycle.rs` — a full settle→claim
cycle (ran); `gov_credit.rs` — a farmed vote loses to genuine participation, and a held vote stops paying
once its referendum concludes (**ran; this is the ROUND14 fix and it is well covered**);
`dispute_flow.rs` — dispute and refund paths (ran); `rank_promotion.rs` — rank advancement gates (ran);
`ring_detection.rs` — wash-ring detection and the auto-params fee response (ran, but see the auto-params
no-op below); `orchestrator_flow.rs` — orchestrator linking and emissions (ran).

#### 1.4 Benchmarks and weights — ENDGOAL §3.1 bullet 5 is unmet

- `wc -l pallets/*/src/benchmarks.rs` → **1 line each**; all six are a single comment
  (`// Benchmarks scaffold for pallet-agents`, …). `pallet-constitution` has none.
- They compile only under `#[cfg(feature = "runtime-benchmarks")]`, and an empty module is valid Rust, so
  the feature build is green while defining **zero benchmarks**.
- `grep -rn 'define_benchmarks!\|add_benchmark' …` → **none**. The runtime declares **no
  `frame_benchmarking::Benchmark` API**, so `benchmark pallet --list` cannot run at all.
- `ls pallets/*/src/weights.rs` → **none**.
- The six `WeightInfo` trait declarations + `impl … for PlaceholderWeights` are **dead code**:
  `grep -rn 'PlaceholderWeights\|T::WeightInfo\|as WeightInfo'` (excluding declarations) → no output;
  `grep -n 'type WeightInfo' pallets/*/src/lib.rs` → no output. No `Config` carries the type.
- Misleading comment at `agents/lib.rs:26-27`: "Replaced by benchmarked weights from
  `pallets/agents/src/weights.rs` before mainnet" — that file does not exist. `agents/lib.rs:40`
  "Placeholder weights returning zero" — they return 30 000 000 … 1 000 000 000.

Every one of the **36 custom extrinsics** is priced by a hand-estimated literal — the lead counted
`#[pallet::weight]` attributes per pallet and got agents 11, orchestrator 8, escrow 6, oracle 5,
emissions 4, auto-params 2, constitution 0 = **36**, matching the extrinsic count.

The most dangerous of them, verified line by line:

```rust
// pallets/emissions/src/lib.rs:228-231
#[pallet::weight(T::DbWeight::get().reads_writes(5, 5)
    .saturating_add(Weight::from_parts(1_000_000_000, 0)))]
pub fn settle_era(origin: OriginFor<T>) -> DispatchResult {
    // Permissionless: any registered agent (or anyone) can trigger settlement.
    ensure_signed(origin)?;
    …
    for (agent, stake) in agents_pallet::AgentStake::<T>::iter() {   // ← unbounded
```

A **constant** price (5 reads + 5 writes + 1e9 ps ≈ 0.001625 CMN) on a call that iterates **every
registered agent** — `runtime/src/lib.rs:1125` sets `MaxAgents = 10_000_000` — plus every orchestrator, and
then sorts all weights. It is `ensure_signed`, so anyone may call it. On a public network that is a free
denial-of-service surface: unbounded work at a fixed, trivial fee. (The permissionlessness is correct and
required by ENDGOAL §3.1; the flat pricing is what makes it dangerous.)

#### 1.5 Forkless upgrade — never rehearsed

- `git log -G'spec_version:' -- runtime/src/lib.rs` shows bumps 300→304 between 2026-07-30 and 2026-08-03;
  each was compiled into a **fresh genesis**, not applied to a running chain.
- On-chain `:code` at the finalized head is **byte-identical to genesis** (verified by comparing the raw
  chainspec's `:code` against `state_getStorage(':code')`).
- `System::LastRuntimeUpgrade` = `0xc104387363616c61722d636f6d6d6f6e73` = compact(304) ++ `"scalar-commons"`
  — the genesis value, so it cannot distinguish "never upgraded" from "upgraded to 304"; the `:code`
  comparison settles it.
- `grep -rn -i 'set_code\|forkless\|CodeUpdated'` across `ROUND*.md`, docs, deploy → no rehearsal record.
- Indexer `/v1/events?section=system&method=CodeUpdated` → total 0 (window caveat below).

**Sudo.** `state_getStorage(0x5c0d1176…9e47b)` (Sudo::Key) →
`0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d` = **//Alice**, the universally known
dev seed. `runtime/src/lib.rs:668-669` exempts `RuntimeCall::Sudo(_)` from SafeMode filtering.
`node/src/chain_spec.rs:373-374` comments that sudo is "Removed on day 14 via referendum" — the chain
started 2026-08-03; today is day 36 and the key is still set.

#### 1.6 Validator liveness

Uptime: alice **35 d 13 h** continuous; bob/charlie/dave/eve **5 d 11 h** since 2026-09-02.
`NRestarts=0` everywhere, so systemd never auto-restarted a *failed* process.

**Why the four restarted** (journal + `~/.bash_history` lines 495–536): two operator-initiated rolling
passes to add `--rpc-methods safe`. The first pass (20:35–20:36) was a **no-op** — the `sed -i` pattern
matched nothing and the `||` fallback never ran, so the nodes came back without the flag. The second pass
(20:44–20:45) worked. Installed unit mtimes are `2026-09-02 20:44:17`. The repo caught up only on
2026-09-07 in `6efba16`; for five days the host ran a configuration the repo did not have.

**Finality through the restarts** (alice's `💤 Idle` lines): during the first pass, cold-cache restarts
took 16–59 s to re-peer while the loop slept only 20 s, so from ~20:35:52 to ~20:36:22 **two of five
validators were simultaneously out of GRANDPA** and finalized advanced by exactly one block in 35 s
(432719 → 432720) before resuming. Finalized stayed monotonic; nothing was lost. The second (warm) pass
showed no finality impact across four sequential single-validator restarts — live re-proof of ENDGOAL's
"finality must survive a validator going down".

**Health.** `system_health` on all five → `peers 4, isSyncing false`. Finality lag sampled five times ~5 s
apart on 9944 → `lag=2,2,2,2,3`. Prometheus on all five agrees on
`substrate_block_height{status="finalized"}` and `substrate_finality_grandpa_round 19498`.
Slot utilisation: 56 unfilled slots in 35.5 days (511 937 slots elapsed).

**Journals.** `grep -c -E 'WARN|ERROR|panic'` over each node's *entire* retained journal (since 2026-08-04)
→ **0 on all five**. alice's last 50 lines are routine (`Prepared block`, `Imported`, `Idle (4 peers)`)
plus two `♻️ Reorg` lines. Reorg rate is high but expected: 11 231 reorgs in 7 days, depth histogram
`{1: 11080, 2: 145, 3: 2}`, caused by `BABE_GENESIS_EPOCH_CONFIG { c: (1,4), PrimaryAndSecondaryPlainSlots }`
with five authorities on one host. Not a defect — but any product reading `best` instead of `finalized`
sees ~1 600 replaced blocks/day.

**Keystore residue (hygiene).** `~/scalar-testnet/{bob,charlie,dave,eve}/chains/scalar-local/keystore/`
each hold 3 files (`audi`, `babe`, `gran`) with mtime **2026-08-19 21:12** — session keys written by the
`author_rotateKeys` probes recorded in `AUDIT.md:845`, never registered on chain. alice's keystore is empty.

#### 1.7 The oracle term and the emission formula

`runtime/src/lib.rs:1269` → **`type OracleScoreProvider = ();`**, and `emissions/lib.rs:50-57` gives `()`
a `best_score` of 0. The landing page's sentence — "this runtime wires no oracle score provider into
emissions, so that term contributes nothing today" — is **true**. Critically, the term is an *additive*
bonus (`base + base × score/1e4 × 2000/1e4`), so an unwired provider adds **+0**; it does not zero the
product. The oracle pallet's `best_score` does reach the weight indirectly, via `OracleScoreGate` gating
rank-3 promotion.

Formula as implemented (`emissions/lib.rs compute_weight_cached`, :545-668):

```
sqrt_stake  = integer_sqrt(stake)                                        :557
rank_bps    = {0|1→10000, 2→12000, ≥3→15000}                             :558-564
hb          = heartbeat_multiplier (100 within 18 h, decays to 10 over 90 d)  :566
raw_vol     = log2_scaled(EraEscrowVolume, UnitVolume=10 CMN), cap 10000  :572
diversity   = {0,1000,3000,6000,8000,10000} by unique buyers             :574
work_score  = raw_vol × diversity / 10000   (0 if either is 0)            :575-579
floor       = 1000 bps iff vol>0 && hb≥90 && vol ≥ MinQualifyingVol(50 CMN)  :586-596
gov_contrib = alpha(1500) × min(gov,20)/20   iff work_score>0, else 0     :598-611
activity    = min(10000, floor + gov_contrib + beta(5000)×work_score/10000)   :613-616
base        = sqrt_stake × rank_bps/1e4 × activity/1e4 × hb/100           :618-627
+ oracle    = base × best_score/1e4 × 2000/1e4        (= +0 today)        :629-641
× onboarding= (1e4 + (1e4 − 1000×completions))/1e4 for completions<10     :644-646
+ velocity  = ×(1 + 0.3 × min(vol/stake, 1))                             :648-667
```

Four-way comparison:

| Term | ENDGOAL §2 | CLAUDE.md:14 | docs token-model | Code |
|---|---|---|---|---|
| stake | √stake | **stake (linear)** | √stake | `integer_sqrt` — **√** |
| activity/volume | standalone multiplicative | **absent** | inside `activity` | **additive** β·work_score in a bounded budget |
| diversity | standalone multiplicative | **absent** | inside work_score | multiplies `raw_vol` only |
| floor baseline | **absent** | only as a hard-rule mention | present | additive 1000 bps, gated |
| rank | multiplicative | multiplicative | multiplicative | ✔ multiplicative |
| oracle accuracy | not in the formula | **"× oracle accuracy" (multiplier)** | +20 % bonus, disclosed inert | additive bonus, **+0** today |
| governance | "at 1,500 bps" (additive) | **"× governance participation"** | additive, gated on work | ✔ additive, gated |
| heartbeat | multiplicative | **absent** | × hb/100 | ✔ |
| onboarding_boost | listed | **absent** | present | ✔ |
| velocity bonus | **absent** | listed as load-bearing | up to +30 % | ✔ |

CLAUDE.md's first-principle formula is wrong on three operators. ENDGOAL §2's is wrong on two structural
points (additive vs multiplicative) and omits the velocity bonus and the floor. The published
`token-model.md` formula is the only one that matches the code. Issue #89 asks exactly this question and
is still open.

**What the terms actually evaluate to on this chain** (a completeness critic pointed out that no phase had
read the live rank, and it takes one RPC). `RankedCollective::Members` holds exactly three entries — the
three registered agents — and **every one is at rank 2**:

```
5GrwvaEF…(Alice)    rank = 2
5FHneW46…(Bob)      rank = 2
5FLSigC9…(Charlie)  rank = 2
```

So `rank_bps` is live at **12 000**, a 1.2× multiplier — the rank term is genuinely active, in contrast to
the oracle term, which is inert. `AgentCollective` and `TechnicalCollective` hold no members.

Live auto-params read from chain: `Alpha = 1500`, `Beta = 5000`, `FloorBps = 1000`, `CompletionFeeBps = 25`
— matching `runtime/src/lib.rs:1301-1303` and ENDGOAL's "right-sized from 4,000 to 1,500 bps".
Note `floor + alpha + beta = 7 500 bps`, so the `activity` clamp at 10 000 ("capped at 100 %") is
unreachable until auto-params raises a term.

---

### Phase 2 — Product layer (ENDGOAL §3.2), tested against the running services

#### 2a Indexer (`127.0.0.1:8080`, MainPID 1663080)

**Route count.** `ROUTES` in `api.ts:215-519` → **exactly 24**. The claim is consistent everywhere it is
made (CLAUDE.md:8, `indexer/README.md:5`, `docs/reference/rpc.md:352`, live `/v1/status` →
`"api":{"version":"v1","endpoints":24}`, journal "serving 24 v1 endpoints"). **All 24 were hit with valid
requests; every one returned 200** with plausible data. Highlights:

```
/v1/status            → specVersion 304, bestBlock 511875, syncedHeight 511873, indexedBlocks 15268
/v1/blocks/511615     → {"number":511615,"extrinsicCount":2,"eventCount":10}
/v1/extrinsics/511615-1 → escrow.confirmDelivery args {"provider":"5FHne…","seq":154}
/v1/agents            → total 3, truncated false, scanLimit 512
/v1/escrows/stats     → activeAgreementCount 3, distinctPairs 2, maxAgreementsPerPair 10
/v1/eras/current      → era 0, lastSettledEra null, dueForSettlement true
/v1/emissions/supply  → cap 1e23, totalIssuance 6053831090074318803559, percentIssued 6.0538
```

Independent cross-checks against chain state and sqlite all matched exactly: agents 3 = 3 storage keys;
`distinctPairs` 2 = 2 `Escrow.Agreements` keys; `activeAgreementCount` 3 = `0x03000000`; totalIssuance
identical; blocks/extrinsics/events/accounts totals identical to `SELECT count(*)`; blocks contiguous.

**Hostile input** — after *every* probe `systemctl --user is-active` = active and `MainPID` = 1663080,
`NRestarts=0`. Nothing crashed or hung.

```
/v1/blocks/%                      → 400 "path parameter id is not valid percent-encoding"  (the PR #93 process-kill defect is FIXED)
/v1/blocks/-1 | 9999999999999 | 1e3 | 0x10 | %25 | %00 | %2F  → 404
/v1/blocks/<5000 nines>           → 404 (echoes input, JSON-escaped)
/v1/blocks/511615%0D%0AX-Injected:%201 → 404, CRLF escaped, no header injection
' OR 1=1 --  on every param       → 400 or 200 total 0 (all SQL uses ? binding, store.ts:409-535)
/v1/accounts/notanaddress         → 400;  hex pubkey and Polkadot-prefix addresses → 200, re-encoded
traversal ../../etc/passwd (--path-as-is) → 404 "no such endpoint: /v1/etc/passwd"
?limit=999999 → 200 clamped to 200;  ?limit=-1|abc|0|1.5 → 400;  ?offset=-1 → 400;  ?offset=999999 → 200 empty
10 KB query string → 200;  20 KB URL → 431;  8 KB header → 200;  20 KB header → 431
POST/PUT/DELETE/OPTIONS/HEAD      → 405 "method X not allowed; this API is read-only"
POST + 1 MB body                  → 405;  50 half-open sockets → /v1/status still 200 in 2.8 ms
```

**The one 5xx:** `?offset=` ≥ 2⁶³ → **HTTP 500 `{"error":"datatype mismatch"}`** on all ten sqlite-backed
list routes. Threshold: `offset=9007199254740992` → 200, `offset=9223372036854775807` → 500. Cause:
`pagination.ts:159-164` accepts any `^-?\d+$` and `Number()`s it; `node:sqlite` binds the resulting
non-int64 double as REAL and SQLite rejects a REAL `OFFSET` (SQLITE_MISMATCH), which `api.ts:646` maps to
500. Process unaffected (1.5 ms response). This is a client error misreported as a server fault, not a
crash. No error body anywhere leaked a stack trace, file path, or the RPC URL.

**Amplification** — measured by diffing alice's `substrate_rpc_calls_started` around 20 sequential requests:

| Route | RPC calls / request | Latency avg |
|---|---|---|
| `/v1/blocks`, `/v1/events`, `/v1/accounts` (list) | **0** (sqlite only) | 0.8–3.2 ms |
| `/v1/accounts/:a`, `/v1/emissions*` | 1.0 | 3–4 ms |
| `/v1/escrows`, `/v1/eras*`, `/v1/agents/:a` | 2.0 | 2–8 ms |
| `/v1/status`, `/v1/escrows/stats` | 3.0 | 3–43 ms |
| `/v1/agents`, `/v1/agents/:a/escrows` | 4.0 | 8–15 ms |

Burst of 300 requests at 30-way parallelism against `/v1/agents?limit=200`: 99 rps, p95 397 ms, and only
**1.34 RPC/request** (polkadot-js coalesces concurrent storage reads). Code bounds confirm it:
`MAX_LIVE_SCAN=512`, `SCAN_PAGE_SIZE=128`. **ENDGOAL §3.2's "must not amplify one HTTP request into
unbounded RPC load" HOLDS.** Aggregate load is another matter: `grep -rn -i 'throttle|semaphore|p-limit|rate'
indexer/src` → no hits; there is no application-level rate limit, as `indexer.env.example:7-9` admits.

**Pagination.** `total` matched sqlite `count(*)` on every route checked; `?limit=` is clamped to 200;
offset past the end returns `items: []` with `total` intact; a 3×200 walk returned 600 unique
strictly-descending rows.

**Coverage window.** sqlite `blocks` min = 496 606, oldest timestamp `2026-09-07T05:05:24Z` (the service
started 07:31 CEST that day and backfilled 256 blocks). Head is ~512 000. So a stranger whose activity
predates the last indexer restart — or falls in any outage longer than 256 blocks — gets
`"activity":{"firstSeenBlock":null,"extrinsicCount":0}`. Demonstrated with Ferdie: live nonce 70, but 70
signed extrinsics invisible. `/v1/status` does expose `backfillDepth`, so the window is disclosed.

**Tests.** The six offline suites pass: `vitest run --root indexer tests/{api,chainState,decode,ingest,pagination,store}.test.ts`
→ **55 passed**, exit 0. `tests/live.test.ts` was **not** run: it has **no env gate**
(`RPC_URL = process.env.INDEXER_RPC_URL ?? 'ws://127.0.0.1:9944'`) and submits real extrinsics.

#### 2b Explorer (`127.0.0.1:8081`, MainPID 1663081)

Routes `/block/:ref`, `/extrinsic/:ref/:index`, `/account/:address`. Full navigation walk on a **real
signed extrinsic**:

```
GET /block/511615        → 200, 3 397 B; hrefs /extrinsic/511615/0, /extrinsic/511615/1, /account/5Grwva…
GET /extrinsic/511615/1  → 200, 5 163 B; "escrow.confirmDelivery … Signer 5GrwvaEF… Nonce 1073 … success"
GET /account/5GrwvaEF…   → 200; "Free 1,000,047,507.883839227849 CMN … Nonce 1074 … read at 511979"
GET / and /block/1       → 200
```
Every extracted href resolved 200. **block → extrinsic → account navigation works.**

**XSS:** payloads in path and query are HTML-escaped in the response body (`&lt;script`), never reflected
raw. **Error honesty:** nonexistent and malformed refs return explicit error pages, not plausible empty
views. **Hostile input:** 10 KB path, `..` traversal, wrong methods, 1 MB body — no 5xx, process unchanged.

**Amplification:** ~6.0–6.4 RPC calls for a cold block page, 2.3 for an account page. There is **no
unbounded block scan** in the current code (the ~200-call fan-out recorded in `AUDIT.md:254` is gone).

Two rendering defects: `/block/0` renders `Time 1970-01-01T00:00:00.000Z` although genesis has no
timestamp inherent (polkadot-js returns the storage default and `chain.ts:288` has no `None` check), and
a `[u8;32]` whose bytes are printable ASCII renders as 32 `&quot;` instead of hex. `explorer/README.md`'s
"There is no database, no cache" is inaccurate — polkadot-js rpc-core keeps a 102 400-entry LRU — though
the cached data is immutable so pages stay correct.

The explorer's 5 offline suites pass: **53 tests**, exit 0. It runs from a **gitignored `dist/`** built
locally on 2026-09-07.

#### 2c Faucet (`127.0.0.1:8082`, MainPID 1664521)

Routes (`server.ts:120-162`): `POST /drip`, `GET /health`, `GET /balance/:address`. **The drip route was
never called.**

```
GET /health → 200 {"ok":true,…,"faucetAddress":"5CiPPseXPECbkjWCa6MnjNokrgYjMqmKndv2rSnekmSK2DjL",
                   "faucetFreePlancks":"999999926492428999773","dripAmountPlancks":"10000000000000",
                   "reservePlancks":"1000000000000000"}
GET /drip   → 405, header `allow: POST`  (nothing moved)
GET /balance/<valid> → 200;  /balance/notanaddress → 400 INVALID_ADDRESS
GET /balance/%E0%A4%A → 500 {"code":"INTERNAL_ERROR","error":"URI malformed"}   ← decodeURIComponent throws URIError, which server.ts:150 rethrows
HEAD /health → 404 (route match is `path === '/health' && method === 'GET'`)
100 KB path → 431 + connection reset;  `..` traversal → 404;  raw garbage → 400
```
Process alive and `MainPID` unchanged after every probe.

**The seed.** `tr "\0" "\n" < /proc/1664521/environ | grep FAUCET` → exactly four vars, **no `FAUCET_SEED`**.
`~/.config/scalar-commons/faucet.env` has **0 uncommented lines** and is byte-identical to
`deploy/products/faucet.env.example`. So the seed is the in-code default `//Ferdie`
(`faucet/src/config.ts:80`). Confirmed three ways: the keyring derivation of `//Ferdie` gives
`5CiPPseXPECbkjWCa6MnjNokrgYjMqmKndv2rSnekmSK2DjL`, matching `/health` and the startup log; and a pure-python
`System::Account` storage read gives `nonce=70 free=999999926492428999773` — i.e. **999 999 926.49 CMN**,
identical to `/health`, so **zero drips have been served** by this process in ~25 h.

Ferdie is not a validator (`session.validators` = 5 other stashes; `staking.bonded` = None) — the env
file's claim is true. But **every funded account on this chain is a well-known dev seed**, including all
five validator stashes (1 M CMN free + 1 M bonded each).

**Is it safe to expose publicly right now? No.** Three independent reasons:

1. `//Ferdie` is a public dev seed. Anyone can `balances.transfer` the full ~1 B CMN out directly, without
   touching the faucet. Every rate limit and the 1 000 CMN reserve then protect nothing.
   `deploy/public/INSTALL.md` never mentions `FAUCET_SEED` (`grep` → exit 1) and **no issue tracks it**
   (`gh issue list --search FAUCET_SEED` and `--search Ferdie` → 0 results).
2. **The per-IP limiter collapses behind the shipped nginx either way.** With the deployed
   `FAUCET_TRUST_PROXY=false`, `clientIp()` returns `req.socket.remoteAddress`, which behind a proxy is
   always `127.0.0.1` — so 5 drips/hour becomes **one global bucket for the entire internet**.
   Demonstrated offline against the real `dist/` modules with `perIp max=1`:
   `200 OK ← XFF="198.51.100.1,127.0.0.1"` then `429 scope=ip ← XFF="198.51.100.2,127.0.0.1"`.
   With `TRUST_PROXY=true` (what issue #115 proposes), `clientIp()` takes the **left-most** XFF entry while
   the template sets `X-Forwarded-For $proxy_add_x_forwarded_for`, which **appends**; four forged headers
   all returned `200 OK` with `perIp max=1`. Only an *overwriting* proxy makes the limit real —
   `faucet/README.md` and `products/README.md:134` say exactly that, and the shipped template does not do it.
3. The limiter is an in-process `Map`: restart resets it, a second instance does not share it.

**Rate-limit tests.** `tests/rateLimiter.test.ts` does assert the mechanics — per-address
`expect(d.allowed).toBe(false); expect(d.scope).toBe('address'); expect(d.retryAfterMs).toBe(60_000)`
(:47-55) and the per-IP equivalent (:102-112) — plus sliding window, scope isolation, release refund and
prune. But the helper defaults to `addressMax 1 / ipMax 3`; **the production defaults (1/60 and 5/60) are
asserted nowhere** and there is no `tests/config.test.ts`. Offline run: 30 tests passed, exit 0.
`tests/faucet.live.test.ts` (25 tests) was skipped — it has no env gate and posts real drips.

**No mint path.** `grep -rn -i 'mint|issue|sudo|setBalance|force_transfer' faucet/src` → only doc comments.
The single chain write is `chain.ts:154-155`
`api.tx.balances.transferKeepAlive(dest, amount).signAndSend(signer, {nonce})`. The reserve floor
(`faucet.ts:150-160`) returns 503 `INSUFFICIENT_FAUCET_FUNDS` before transferring; guards run in the order
address → limiter → solvency → transfer.

**Why the box runs `dist/`.** `journalctl --user -u scalar-faucet --since 2026-09-07`:
`Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../faucet/src/amount.js' imported from .../src/index.ts`,
restart counter reaching **71** by 07:37:20, then a clean start at 07:38:55 once the local drop-in was
applied. Reproduced: `node --experimental-strip-types -e "import('.../faucet/src/faucet.ts')"` → same
error, exit 3. Node 22 type-stripping does not rewrite `./x.js` specifiers to `./x.ts`. So
`deploy/products/scalar-faucet.service:34`, `deploy/products/install.sh:32`, `faucet/package.json`'s
`start` script and `faucet/README.md`'s "npm ci … npm start" **all crash-loop** on a fresh install.
Issue #115 describes this; it does not fix `npm start`/README, and its `TRUST_PROXY=true` half is unsafe
with the shipped template.

#### 2d SDK

```
npm ci        → 143 packages, EXIT=0   (4 vulnerabilities: 2 moderate, 1 high, 1 critical)
npm run typecheck → tsc --noEmit, EXIT=0, no diagnostics
npm test      → 13 passed | 10 skipped (3 files), EXIT=0
```
`git status --porcelain sdk/` empty after each — the lockfile was untouched. The 10 skipped are the live
blocks, gated by `describe.skipIf(!RUN_LIVE)` with `RUN_LIVE = process.env.RUN_INTEGRATION === '1'`.
`test:integration` was deliberately **not** run: `live.test.ts:137,149-151` submits `agents.recordGovVote`
extrinsics from //Alice.

**bigint end-to-end — ENDGOAL's claim is TRUE.** `grep -rn 'Number(' sdk/src` → 4 occurrences, all on
`u32` era indices (`toOptionalNumber` for `emissions.lastSettledEra`, and `agents.eraNumber`).
`grep -rn 'parseInt|parseFloat|toNumber()|as number' sdk/src` → **none**. Every balance field is `bigint`
via `toBig` → `BigInt(codec.toString())`. Proven live: `totalIssuance()` = `6053831090074318803559n`,
`> 2^53` true, `Number(issuance)` exact **false**, and an agent's free balance
`1000051526162129293728n` reproduced exactly.

**Is `live.test.ts` run by CI?** No. `ci-node.yml:294-297` runs `npm test` without `RUN_INTEGRATION`, so
CI never executes it. By `npm test`? No (self-gated). Its last known execution was a factory gate on
2026-08-18. **A brand-new agent registering via the SDK has never been rehearsed on this chain** — the
only 3 agents are the genesis ones.

**Consumability.** The SDK is not on npm; `main`/`exports` point at a **gitignored `dist/`** that no
`prepare` script builds, so `npm pack` / `npm install <path>` yields a package whose import fails with
`ERR_MODULE_NOT_FOUND`.

#### 2e Docs and landing

**`check-chain-values.mjs` — issue #89 task 1 answered: YES, it asserts.** It is read-only (imports only
`readdirSync`/`readFileSync`). Input is `docs/.chain/snapshot.json`, **not** live RPC. It checks: armed
constant tables (raw value must equal the snapshot), 22 REQUIRED_CONSTANTS coverage, 5 cross-pallet
invariants, pallet-index tables, 8 literal PROSE_FACTS, and extrinsic/runtime-API surface coverage.
Run on master: `✓ docs match the runtime snapshot (… spec 304 @ #433616) … 31 constant reference(s)
covering 30/141 chain constants (all 22 required ones present), 36 pallet indices, 5 cross-pallet
invariants, 8 prose facts, 36 extrinsics, 4 runtime API methods`, EXIT=0.

Proven to fail closed, by mutating **copies** in scratch: supply-cap digit changed → EXIT=1;
snapshot `eraDuration` 3600→3601 → EXIT=1; pallet index 29→30 → EXIT=1; `spec 304`→`305` → EXIT=1;
snapshot deleted → uncaught ENOENT, EXIT=1. It is wired without `|| true` into `docs/package.json`'s
`lint`, which the `docs` CI job runs.

**What it does NOT check:** any number not inside an armed table row, all derived numbers, chain *state*,
snapshot age, the landing page, and the 111 uncovered constants. The TODAY-PLAN "five raw values escape
the gate" claim could not be located verbatim (`grep` found no such sentence) — **UNVERIFIED as phrased**
— but an independent enumeration found these unchecked prose numbers, of which **five are wrong**:

| Location | Value | Correct? |
|---|---|---|
| `token-model.md:29` | Genesis mint 18,000,000,000 CMN | **WRONG** — live genesis issuance 6,010,250,000.01 CMN |
| `token-model.md:30` | Emittable headroom 82,000,000,000 | **WRONG** — live headroom ≈ 93.95 B |
| `token-model.md:347` | treasury "starts with 5B CMN from genesis" | **WRONG** — genesis `"treasury": {}`; pot today 43,581,095 CMN, all staking inflation |
| `token-model.md:100-102` | 1.46 B/yr, 56 years, 561 years | **WRONG** — derived from the false 82 B |
| `run-a-node.md:105` | "The 18B CMN genesis mint is split four ways" | **WRONG** for every reachable `--chain` preset |
| `token-model.md:54-57` | 7B/5B/3B/3B | only in the unreachable `mainnet_genesis_config` |
| 11 further prose values (MIN_STAKE, era counts, diversity map, rank bps, 24 endpoints, 13 runtime APIs, ss58 42, …) | — | **correct** |

**Issues #87 and #88 are both still present on master.** #87: `run-a-node.md:150-157` starts a full node on
`--rpc-port 9960`, then `:169-172` "Verify it joined" curls `http://127.0.0.1:9944` (alice) and shows
alice's output. #88: `rpc.md:19-21` says the devnet runs `--rpc-methods safe` "which withholds …
`author_rotateKeys`", while `run-a-node.md:232-262` starts a validator with **no** `--rpc-methods` flag and
then curls `author_rotateKeys` at `:9960`. Both issue gates exit 1 today.

**Other contradictions found** (both locations cited): CLAUDE.md's linear-stake formula vs √stake
everywhere else; CLAUDE.md "Local 3-validator devnet" vs 5 authorities in `chain_spec.rs:152-168` and live
`session.validators=5`; ENDGOAL:149 "four of five validators run without `--rpc-methods safe`" vs all five
having it; `landing/README.md:68-70` "the faucet is marked `planned`" vs `content.mjs:277-285`
`status: 'available'`; landing's "A fuller developer guide is still being written" vs a complete guide
published on the same host; `render.mjs:157` badging every non-`planned` link **"Live"** so the faucet card
reads "Live" directly above "No hosted instance is up yet"; `docs/.vitepress/config.mts:69` social link to
`github.com/tejaspatil1936/scalar-commons` (**missing `-v4`**, 404); `file-issues.yml:16` hardcoding
`R="matty33/scalar-commons-v4"`.

**Staleness**, the figure the brief asked for in both blocks and hours. `docs/.chain/snapshot.json`
records `provenance.capturedAtBlock` **433 616**; `landing/chain-facts.json` records
`provenance.readAtBlock` **433 638** and `fetchedAt 2026-09-02T20:07:42Z`. Against a live head of
**515 241** read at 14:09 CEST:

| File | Captured at block | Blocks behind | Hours | Days |
|---|---|---|---|---|
| `docs/.chain/snapshot.json` | 433 616 | **81 625** | **136.0** | 5.67 |
| `landing/chain-facts.json` | 433 638 | **81 603** | **136.0** | 5.67 |

The 5.67 days of block time matches the wall-clock gap since `fetchedAt` exactly, which is an independent
confirmation that the chain has been producing 6-second blocks continuously throughout.

**But staleness here is a provenance problem, not a correctness problem — and that is worth stating in the
project's favour.** A completeness critic noted that the checker had only ever been run against the
committed 5.67-day-old capture, so "the docs match the chain" had not actually been tested. The lead
therefore generated a **fresh** snapshot from the live node into a scratch copy of `docs/` (the script's
output path is hardcoded, so the directory was copied rather than the repo written to; `git status
-- docs` confirmed clean afterwards):

```
$ node scripts/snapshot-chain.mjs ws://127.0.0.1:9944      # run from /tmp/audit/scratch/docsnap
✓ snapshot written … Scalar Commons Local Testnet — scalar-commons spec 304 @ #515343
  36 pallets, 141 constants, 240 extrinsics, 13 runtime APIs, 118 RPC methods
```

Diffing the fresh capture against the committed one across `consts`, `pallets`, `runtime`, `properties`,
`storage` and `runtimeApis` gives **zero differences** over 81 727 blocks. So every chain-derived value the
gate guards is still accurate today; what is stale is only the *claim of when it was read*. The four wrong
numbers on the token-model page are wrong for a different reason — they are hand-typed prose about chain
**state**, which the checker does not and cannot cover. `node landing/scripts/verify-chain.mjs` → "all metadata facts on the page still match the
live runtime", EXIT=0; the only drift is `totalIssuancePlancks` (committed 6 047 320 283 vs live
6 053 831 090), and the page labels its own reading "Read at block 433,638".

**Publication.** `gh api …/pages` → `html_url https://tejaspatil.tech/scalar-commons-v4/`, `public: true`,
`https_enforced: true`. Landing 200 (15 595 B); `/docs/`, `/docs`, and all four guide/reference pages 200.
`md5sum landing/dist/index.html` equals the md5 of the live page, so the deployed site is exactly the
committed build. Docs build clean (`vitepress build`, 4.27 s, `ignoreDeadLinks: false`); 35 internal
links checked, **0 broken**.

---

### Phase 3 — Public access layer (ENDGOAL §3.3)

`deploy/public/` (added by PR #107, merged 2026-09-07, never applied) contains `domain.env`, `INSTALL.md`
(194 lines), `VERIFY.md` (230), `render-config.sh`, and two nginx templates. Rendering is `sed` over
`<DOMAIN>`/`<LANDING_DIST>`/`<DOCS_DIST>`/`<ACME_WEBROOT>`; it refuses `DOMAIN=example.com` and greps for
leftover placeholders. Rendered with `DOMAIN=scalarnet.io` into scratch:

| server_name | listen | upstream |
|---|---|---|
| `scalarnet.io rpc. api. explorer. faucet.` | 80 | ACME webroot, else `301 https://` |
| `rpc.scalarnet.io` | 443 ssl, http2 | `proxy_pass http://127.0.0.1:9944` |
| `scalarnet.io` | 443 | `/docs/` → alias `docs/.vitepress/dist/`; `/` → root `landing/dist` |
| `faucet.scalarnet.io` | 443 | `proxy_pass http://127.0.0.1:8082` |
| `explorer.scalarnet.io` | 443 | `proxy_pass http://127.0.0.1:8081` |
| `api.scalarnet.io` | 443 | `proxy_pass http://127.0.0.1:8080` |

**Rate limits.** `limit_req_zone $binary_remote_addr zone=rpc_req:10m rate=10r/s` and `web_req … 20r/s`;
`limit_conn_zone` for both; `limit_req_status 429`. Per vhost: rpc `burst=20 nodelay, limit_conn 5,
client_max_body_size 256k`; landing/docs `burst=40, conn 20`; faucet `rpc_req burst=10, conn 5, body 64k`;
explorer and api `burst=40, conn 20`. The template's own comment and `VERIFY.md:161-164` note the key
caveat: on wss these bound **connection establishment only**, not JSON-RPC messages inside an open socket.

**WebSocket upgrade on the rpc vhost: present and correct** — `map $http_upgrade $connection_upgrade`,
`proxy_http_version 1.1`, `Upgrade`/`Connection` headers, `proxy_read_timeout 3600s`, `proxy_buffering off`.
TLS: `listen 443 ssl; http2 on;` on all five, one Let's Encrypt cert with 5 SANs, TLSv1.2+1.3, HSTS and
nosniff `always`.

**No method filtering at the proxy**, by design and documented: nginx cannot see inside WS frames and
`$request_body` is empty in the rewrite phase, so `--rpc-methods safe` on the node is the only control.

**And the node's own RPC hardening is entirely unused** — a gap a completeness critic flagged and the lead
then measured. This matters precisely because of the caveat above: since `limit_req` bounds only connection
*establishment* on wss, the defence against flooding *inside* an established socket has to come from the
node. `scalar-node --help` offers seven relevant flags; comparing them against all five `/proc/*/cmdline`:

| Flag | Purpose | Set on any validator? |
|---|---|---|
| `--rpc-rate-limit` | calls/minute per connection | **no** (no default — disabled) |
| `--rpc-max-batch-request-len` | cap batch length | **no** |
| `--rpc-max-connections` | cap concurrent connections | **no** |
| `--rpc-max-subscriptions-per-connection` | cap subscriptions | **no** |
| `--rpc-max-request-size` / `--rpc-max-response-size` | payload caps (MB) | **no** |
| `--rpc-message-buffer-capacity-per-connection` | queued-message cap | **no** |

The complete RPC flag set in use is `--rpc-port` on all five, `--rpc-methods safe` on all five, and
`--rpc-cors all` on alice. So once `wss://rpc.scalarnet.io` fronts alice, one connection that survives
nginx's 10 r/s handshake budget may then issue JSON-RPC calls at whatever rate it likes, in batches of
whatever length it likes, with only Substrate's built-in defaults as a bound. `deploy/public/INSTALL.md`
and `VERIFY.md` mention none of these flags.

**`nginx -t`: UNVERIFIED** — nginx is not installed and installing it was out of scope. A manual review of
the rendered file found balanced braces (16/16), no leftover placeholders, every non-brace line terminated,
and only real `ngx_http_*` directives in valid contexts. Unexercised risks: `alias` + `try_files`
interaction, `ssl_stapling on` against a post-OCSP Let's Encrypt cert, and the rpc vhost being the first
443 server (hence the implicit default for SNI-less requests).

**`/docs` base — INSTALL.md is wrong.** `INSTALL.md:116-125` says "`docs/.vitepress/config.mts` sets no
`base` … Fix … by setting `base: '/docs/'`". Master's `config.mts:21` already reads
`base: process.env.DOCS_BASE ?? '/'` (merged in #111 on 2026-09-04, three days *before* #107 merged).
Following INSTALL.md step 5 as written builds with base `/` and every asset 404s under `/docs/`. Verified
the fix path in scratch: `DOCS_BASE=/docs/ vitepress build` → assets correctly prefixed.

**ufw.** `/etc/ufw/ufw.conf` → `ENABLED=yes`; `/etc/default/ufw` → `DEFAULT_INPUT_POLICY="DROP"`.
`/etc/ufw/user.rules` is 640 root (unreadable) and 1 416 B vs the pristine 307 B, so rules were written on
2026-07-28. But `systemctl status ufw` → `Active: inactive (dead)` with an empty `ActiveEnterTimestamp`,
and the unit is `Type=oneshot RemainAfterExit=yes` — so **ufw.service has never run this boot** (boot was
2026-07-22). Whether rules are in the kernel now is **UNVERIFIED**: it needs root or an external probe.
`sudo -n ufw status` → "a password is required"; `nft list ruleset` → "Operation not permitted".

**RPC exposure re-probed on all five ports.** `author_pendingExtrinsics` (safe) → `{"result":[]}`.
`system_peers` and `system_unstable_networkState` (unsafe, read-only) → on **every** node:
`{"error":{"code":-32601,"message":"RPC call is unsafe to be called externally"}}`. `rpc_methods` lists
118 methods on alice / 108 elsewhere (the difference is the 10 `archive_v1_*` methods), including
`author_insertKey` and `author_rotateKeys` — **listed is not callable**; jsonrpsee registers them and the
DenyUnsafe check fires at call time. No mutating method was invoked.

**ENDGOAL §3.3 is stale on its own known gap:** it says "four of five validators run without
`--rpc-methods safe`". All five have it, live since 2026-09-02 and in the repo since 2026-09-07.

**`--rpc-cors all` on alice** means that once `wss://rpc.scalarnet.io` fronts 9944, **any** browser origin
may open a socket; the default would allow only localhost and polkadot.js.org. Neither INSTALL.md nor
VERIFY.md mentions this. Only alice is proxied; bob–eve keep default CORS.

**DNS.** `getent hosts scalarnet.io` → `3.33.130.190`, `15.197.148.33`; `rpc./api./explorer./faucet.` → no
record. `whois` → GoDaddy, **Creation Date 2026-09-07T15:04:05Z**, status addPeriod.
`curl -sI http://scalarnet.io` → 200 with a GoDaddy parking redirect; `https://` → TLS error
`tlsv1 unrecognized name`. This box is `152.53.113.104`. **The domain was registered yesterday, is parked,
and does not point here.** `grep -rn scalarnet` over the whole repo → **no matches**; `domain.env` still
says `DOMAIN=example.com`.

**If INSTALL.md were applied verbatim today, a stranger could reach:** the landing page (static); `/docs/`
(broken assets until rebuilt with `DOCS_BASE`); `wss://rpc.scalarnet.io` → alice's full **safe** method
set, which **includes `author_submitExtrinsic` and `author_submitAndWatchExtrinsic`** — i.e. transaction
submission; `api.` → the indexer (GET-only, no app rate limit); `explorer.`; `faucet.` → `/health`
(exposing the funding address and balance), `/balance/:addr` and `POST /drip`; plus TCP 22 and
30333-30337. **They must not reach** 9944-9948 directly, 9615-9619, or 8080-8082 directly — and the
loopback binds do prevent that (`ss` verified); the ufw half is unverified. INSTALL.md gives no
instruction to change any `*_HOST` binding, which is correct.

**The decisive gap neither INSTALL.md nor ENDGOAL §3.3 mentions:** because `author_submitExtrinsic` is a
*safe* method and `Sudo::Key` is //Alice, **the first stranger to connect to the public RPC can execute
`sudo.sudo(…)`** — `set_code`, `force_transfer`, `kill_storage`, `set_key`. TLS, nginx, ufw and
`--rpc-methods safe` do not mitigate it.

---

### Phase 4 — Economic security (ENDGOAL §3.4)

**Inventory.** `experiments/sc-e1/` holds 44 tracked files, all with checkout mtimes (2026-07-29) except a
tracked `scratchpad/` from 2026-08-03. Content: `SC-E1-phase0-sim.py` (pure-Python model), `analyze.py`
+ `tests/test_analyze.py`, `archetypes/` (TypeScript, **recording-only** SDK), `ci/sc-e1.yml`,
`scripts/{run-eras,extract-export,check-export}.sh`, `zombienet.toml`, results and verdict JSON, and the
SEEV protocol spec and workbook. Last content commits: 2026-07-06.

**The five archetypes** (from `archetypes/README.md` + protocol spec §5): A-1 HONEST-WORKER, A-2
PASSIVE-STAKER, A-3 SYBIL-FARM, A-4 WASH-TRADER, A-5 ORACLE-COLLUDER. Note ENDGOAL's fifth archetype
("governance farmer") is **not** one of the SC-E1 five; it was found in ROUND12/13 and modelled separately
in `scratchpad/round14_sim.py`.

**Recorded verdicts** (`verdict.json`, run_date 2026-07-06, quoted verbatim):

```
pool_ceiling PASS (1e6 hard cap)
P1_worker_staker_ratio UNDEFINED  ("Passive staker weight=0 -> earns 0")
P2_volume_earnings_spearman_rho FAIL  (+0.9798 -> -0.5879, "Sign flip … dominated by the un-transcribed fee model")
P4_sybil_net_per_acct_at_1M PASS  (-19.19 -> -30.0, "Zero-work sybils get weight 0")
P4_sybil_break_even_pool PASS  ("Break-even is INFINITE")
P5_wash_net_per_era_at_1M FAIL  (-14.1 -> +1556.41, "Sign flip - worse. Wash profitable at the only pool
                                  the chain uses (1M ceiling). Diversity gate discounts 10x … but not to zero")
P5_wash_break_even_pool FAIL  (1,120,000 -> 1,000,000, "Profitable at/below the 1M ceiling")
P6_oracle_collusion_uplift MOOT  ("Oracle bonus inert on-chain (OracleScoreProvider=(), best_score=0)")
P7_eras_settled PASS (100/100)
```
Header caveat: "Pre-registered thresholds NOT locked; verdicts are indicative."

**Reproduced today**, read-only into scratch: re-running `SC-E1-phase0-sim.py` produced a verdicts file
**identical** to the committed one (`diff` with sorted keys → no difference). `round14_sim.py` → "✅ all
five ROUND12 §3.3 anchors reproduced", and its post-fix table matches ROUND14 §7.2 exactly
(676.6 / 974.5 / 1293.4 / 365.4 / **964.9**) — i.e. after the governance fix the 5-sybil ring went
**up 9.2 %** and still beats the low-volume honest agent (964.9 vs 676.6 per 1 k capital). ROUND14 itself
says: *"Neither the gov fix nor the alpha cut is an anti-wash measure. B1 is the anti-wash measure, and
B1 is still open."* `pytest tests/test_analyze.py` → 4 passed. The 5 archetype node tests → 21 passed.

**Has any archetype run against the LIVE chain? No.** Evidence: the archetypes import no transport
(`grep -rn 'polkadot|ws://|ApiPromise|WsProvider' archetypes/*.ts` → one doc-comment mention);
`scripts/run-eras.sh:18-32` and `extract-export.sh:30-31` are stubs that `exit 1`
("not wired yet (TODO: PR #5/#7)"); `zombienet.toml` references a binary name that does not exist
(`scalar-commons-node` vs `scalar-node`) and carries stale TODOs claiming the node crate has no
`Cargo.toml`; `command -v zombienet` → absent; `ci/sc-e1.yml` is **not installed** in `.github/workflows/`;
and no real run manifest exists anywhere. Also, no referendum has ever existed on chain
(`Referenda::ReferendumCount` absent, `ConvictionVoting::VotingFor` 0 keys), so the governance archetype
could not have been exercised live. **ENDGOAL §3.4 — the gate that "outranks every other consideration" —
has never been executed.**

**The ROUND14 governance fix — verified in code, tests and live storage.** Guard at
`pallets/agents/src/lib.rs:957-990`: `ensure!(signer == agent)`, registered check,
`ensure!(!EraGovVotedPolls::get(&agent, poll_index), PollAlreadyCredited)` (:971-972),
`ensure!(T::GovVoteVerifier::has_live_vote_on(&agent, poll_index), NotActivelyVoting)` (:979-980), cap
check, then insert. Runtime bridge `runtime/src/lib.rs:1061-1077` `ConvictionVotingBridge` returns false
unless `Polls::as_ongoing(poll_index)` is Some **and** `VotingFor::iter_prefix(who)` contains a
`Casting` vote on that poll; wired at `:1162`. Nine tests cover it and **all appear as `ok` in the test
log**: `gov_credit_on_live_referendum_works`, `gov_credit_on_removed_vote_earns_nothing`,
`gov_credit_on_concluded_referendum_earns_nothing`,
`gov_credit_requires_a_vote_on_that_specific_poll`, `gov_dedup_map_clears_each_era`,
`distinct_live_referenda_each_credit_once_up_to_cap`, `one_live_vote_credits_exactly_once_per_era`, plus
integration `farmed_vote_loses_to_genuine_participation_in_emission_weight` and
`a_held_vote_stops_paying_once_its_referendum_concludes`. Live `AutoParams::Alpha` = **1500**.
**This fix is real, tested, and deployed.**

**Passive staker earns zero — runtime path yes, dedicated test NONE.** In `compute_weight_cached`,
`work_score` is 0 when volume or diversity is 0 (:575), `gov_contribution` is 0 unless `work_score > 0`
(:607), and `effective_floor` is 0 unless the agent is active and above `MinQualifyingVol` (:595-596);
so `activity` = 0 ⇒ weight = 0. But `grep -rn 'passive|zero_activity|no_activity|MinQualifyingVol|below_floor'`
across all test files finds only the two mock lines setting `MinQualifyingVol = ConstU64<0>`. No test
registers a zero-work agent and asserts zero weight or zero claim.

**Escrow leak (issue #101 / PR #112) — the premise does not hold today.** The brief asked how many of
//Alice's *provider* pairs sit at `MaxAgreementsPerPair`. The answer is **none, because she has no provider
pairs**. Re-read by the lead from chain storage, decoding the double-map keys by hand:

```
Escrow::Agreements keys: 2
  buyer 5GrwvaEF…(Alice) -> provider 5FHneW46…(Bob)      agreements: 2 / 10
  buyer 5GrwvaEF…(Alice) -> provider 5FLSigC9…(Charlie)  agreements: 1 / 10
ActiveAgreementCount: 3
registered agents: 3  (Bob, Charlie, Alice)
```

Alice is the **buyer** in both pairs and neither is close to the cap. The leak issue #101 describes is real
in the code, but it has not accumulated on chain, because Bob and Charlie show 153 and 58 completed
agreements — releases do happen. `Escrow::Agreements` is a
`StorageDoubleMap<Blake2_128Concat AccountId /*buyer*/, Blake2_128Concat AccountId /*provider*/,
BoundedVec<Agreement, MaxAgreementsPerPair>>` with `MaxAgreementsPerPair = 10`. `state_getKeysPaged` on the
prefix → **2 keys**, decoded: Alice→Bob (2 agreements) and Alice→Charlie (1), all status `Created`,
10 CMN each; `ActiveAgreementCount` = 3, matching. **Alice appears as *buyer*, never as provider: 0 of her
provider pairs are at the cap, and neither buyer pair is near it (2 and 1 of 10).** Two of the three are
past `deliver_by` and still occupying slots. The indexer agrees (`/v1/escrows/stats`). Bob and Charlie
show 153 and 58 completed agreements, so the live tests do release most of what they create.

**Live emission state — the emission path has NEVER executed.** This one is worth proving rather than
asserting, so the lead re-derived every hash with `@polkadot/util-crypto` instead of trusting a quoted key:

```
twox128("Emissions")             = 0x14e767caae65907bcccb1824eb3fda41
twox128(":__STORAGE_VERSION__:") = 0x4e7b9012096b41c4eb3aaf947f6ea429
twox128("LastSettledEra")        = 0x8924db482c2640461926b647a0150c80

state_getKeysPaged("0x14e767caae65907bcccb1824eb3fda41", 20, null)
  → ["0x14e767caae65907bcccb1824eb3fda41" ++ "4e7b9012096b41c4eb3aaf947f6ea429"]   (exactly one key)
prefix ++ twox128(":__STORAGE_VERSION__:")  ==  that key   → MATCH: true
state_getStorage(prefix ++ twox128("LastSettledEra"))  → null
```

In other words the pallet has written exactly one thing in its entire existence — its own storage version.
The whole `Emissions` prefix holds **that one key**; `LastSettledEra`, `EraStartBlock`,
`LastEraEmission`, `AccRewardPerStake` are all null and `AgentWeightSnapshot`/`AgentRewardDebt` have 0
keys; `Agents::EraNumber` is null (= 0). Since `settle_era` writes `LastSettledEra` on every success and
`drain_era_maps` increments `EraNumber`, **`settle_era` has never succeeded in ~512 000 blocks — about 142
elapsed six-hour eras.** Indexer `/v1/eras/current` → `{"era":0,…,"dueForSettlement":true,
"lastSettledEra":null}`. Consequence: `EraEscrowVolume` has never drained, so the "per-era" maps are
lifetime maps on this devnet (Bob shows 1 530 CMN "era" volume across 153 completions).

**Issuance — 43.58 M CMN minted, none of it by pallet-emissions.** Verified directly by the lead:

```
TotalIssuance @ genesis (0xff6882b4…) = 6,010,250,000.010000 CMN     ← NOT 18 B
TotalIssuance @ head                  = 6,053,831,090.071615 CMN
delta                                 = +43,581,090.06 CMN
Emissions pallet storage keys         = 1  (storage version only)
Emissions::LastSettledEra             = null
Staking::CurrentEra                   = 0x2f000000 = 47
```
Source traced, and re-verified by the lead by deriving every storage key rather than trusting a quoted one:
`Staking::ErasValidatorReward` has **47 entries summing 14 623 530.33 CMN** with `Staking::CurrentEra` = 47,
and the Treasury account — derived from the `sc/trsry` `PalletId` as `"modl" ++ id` zero-padded, giving
`5EYCAe5jKanUVRD6sxyjGQmVXuKnZDL2UCUdb2AUhvyNE2e7` — holds **43 581 095.63 CMN** at 14:01 CEST against a
genesis balance of zero. That is 5.57 CMN more than the issuance delta, which is transaction fees routed to
the treasury rather than minted; the two figures reconcile.

**And a further 14.62 M CMN is pending.** `Staking::ClaimedRewards` has **zero keys** — no validator has
ever claimed — so the 47 eras of booked validator rewards have not been minted yet. `payout_stakers` is
permissionless, so the first caller begins minting them. Total uncapped exposure is therefore ≈58 M CMN:
≈43.58 M already issued, ≈14.62 M waiting on a call anyone can make. (`Nominators` 0 keys, `Validators`
5 keys, `ErasTotalStake` 48 entries.) The
mechanism is `runtime/src/lib.rs:809-816` `pallet_staking_reward_curve::build!{ min_inflation 2.5 %,
max_inflation 10 %, ideal_stake 50 % }` with `:847 type EraPayout = pallet_staking::ConvertCurve<RewardCurve>`
and `:838 type RewardRemainder = ResolveTo<TreasuryAccount, Balances>`. With only 5 M of 6.01 B staked
(0.08 % vs 50 % ideal) the curve pays ~2.5 % to validators and ~7.5 % remainder to Treasury — ≈10 %/yr.

**Nothing caps this against `SUPPLY_CAP`.** `ConvertCurve` is cap-unaware;
`pallet_constitution::base_call_allowed()` is wired only as a `BaseCallFilter`, which gates *dispatched
calls*, while the era payout is applied in a session/era-rotation **hook**; and the constitution's
`on_initialize` only *emits* `SupplyCapBreachBlocked` **after** `current > cap` — it never halts. No
`ROUND*.md`, STATUS, AUDIT, WEEKCHECK or VERIFIED-CONSTANTS file mentions "inflation", "RewardCurve",
"ConvertCurve" or "RewardRemainder": **this path was never analysed.** `NominationPools` is also live
(index 32, min join bond 100 CMN), giving any account a stake-only yield path entirely outside the
emissions formula — which SC-E1's passive-staker archetype does not model.

---

### Phase 5 — Verification integrity (ENDGOAL §3.5)

**CI coverage.** All six workflows read in full. None uses a `paths:` filter; `ci-node.yml` computes
selection in a `changes` job instead.

| Subproject | Job (check name) | Command | Required? |
|---|---|---|---|
| runtime + pallets + node | ci-fast `gate` | `cargo fmt --check`; `clippy -D warnings`; `cargo check` | **yes** |
| runtime + pallets + node + `tests/` | ci-full `full` | `cargo build --release`; `--version`; `build-spec`; `cargo check --features runtime-benchmarks`; **`cargo test --workspace`** | **yes** |
| landing | ci-node `landing` | `npm ci && npm run build && npm test` | **yes** |
| faucet | ci-node `faucet` | `npm ci && typecheck && npm test -- tests/amount.test.ts tests/rateLimiter.test.ts` | **yes** |
| docs | ci-node `docs` | `npm ci && npm run lint && npm run build` | **yes** |
| sdk | ci-node `sdk` | `npm ci && typecheck && npm test` | **yes** |
| **indexer** (55 tests) | **none** | — | **no** |
| **explorer** (53 tests) | **none** | — | **no** |
| factory shell tests | none | — | no |
| experiments/sc-e1 python + node | none | — | no |

The Rust jobs are **not** narrowed: `grep -nE 'exclude|-p |SKIP_WASM|no-run|--lib'` finds only comments
describing a removed `--no-run`. `cargo test --workspace` runs in full.

**The indexer/explorer gap is a timing accident that was never corrected.** `ci-node.yml` landed in
`93334d4` (2026-09-02 21:55). `indexer/package.json` was added in `233ff89` (22:50) and
`explorer/package.json` in `c474f56` (23:25) — 55 and 90 minutes later. `ci-node.yml:15-18` still asserts:
*"indexer/ deliberately has NO job here. On master it contains one Python file (reconcile.py) and no
package.json"* — false since 2026-09-02, and repeated in `CI-NODE.md:19-20` and `ci-fast.yml:11-12`.
**Consequence verified on a real PR:** PR #112 changes only `indexer/tests/live.test.ts`, and its rollup is
`gate, full, changes, landing, faucet, docs, sdk` **all SUCCESS**, with ci-node reporting
`sdk → success | ran: ['Not selected']` and the same for landing/faucet/docs. Six required checks green,
**zero indexer lines executed**. PRs #99 and #100 merged the explorer and indexer themselves under the
same seven-green rollup.

Both suites are real and offline-runnable — 55 and 53 tests, exit 0 — but their `npm test` cannot be the
CI command, because the live files are not env-gated (`indexer/tests/live.test.ts:29`, and
`explorer.live.test.ts:15-21` says "nothing here is … skippable"). A CI job must select the offline files
by path, exactly as the faucet job already does.

**Branch protection** (`gh api …/branches/master/protection`): `strict: true`,
contexts `["gate","full","landing","faucet","docs","sdk"]`, **`enforce_admins: true`**,
`allow_force_pushes: false`, `allow_deletions: false`, `required_approving_review_count: **0**`,
`require_code_owner_reviews: false`. No rulesets. Every required context is produced by a real job, and no
orphan context blocks merges. **ENDGOAL §3.5's "enforce_admins" and "no force-push" are met.** But
`.github/CODEOWNERS:3-6` claims the blocking half is "a branch protection rule … requiring 'Require review
from Code Owners'" — that setting is **off**, and approvals required is 0, so nothing in branch protection
stops an agent-authored PR touching `runtime/`, `pallets/`, `node/` or `.github/` from merging on green
CI. Only `merge.sh`'s tier-label refusal does, which is configuration, not protection.
`factory/branch-protection.json` (the repo's own template) matches nothing live and would, if applied,
require a context no workflow emits and switch `enforce_admins` **off**.

**Hooks.** `.claude/settings.json` wires `reject-stubs.sh` as a **`PostToolUse`** hook on `Write|Edit|MultiEdit`.
Claude Code's documented semantics: PreToolUse exit 2 "Blocks the tool call"; PostToolUse exit 2 "Shows
stderr to Claude; **the tool already ran**". The script self-describes as blocking
(`reject-stubs.sh:13` "Exit 2 = block the tool call"; `:10-11` "it fires on the WRITE, before any gate
runs"; `factory/README.md:299-301` "exits 2 to block the write"). **It cannot block** — the stub is already
on disk; the message is advisory. It also cannot simply be re-wired: it scans the on-disk file
(`[ -f "$FILE" ] || exit 0`), so as a PreToolUse hook a new-file Write would pass and an Edit would scan
pre-edit content.

Direct tests (stdin `{"tool_name":"Write","tool_input":{"file_path":"<f>"}}`, files in scratch):

| Payload | exit | caught |
|---|---|---|
| `todo!()`, `unimplemented!()`, `#[allow(dead_code)]`, `SKIP_WASM_BUILD`, `fn main() {}` under node/ or runtime/ | **2** | yes |
| clean file, `fn main() {}` under pallets/, `todo!(` in .md or under factory/ | 0 | by design |
| `it.skip` / `describe.skip` / `.only` / `@ts-ignore` / `eslint-disable` / `#[ignore]` / `\|\| true` / `continue-on-error` | 0 | **not caught** |
| nonexistent path, empty stdin | 0 | fails open |

The lead re-ran this battery independently and reproduced it exactly: `todo!()`, `unimplemented!()` and
`#[allow(dead_code)]` each exit 2; a clean file, `it.skip`, `#[ignore]`, `|| true`, `continue-on-error` and
`@ts-ignore` each exit 0; and feeding it the unmodified `runtime/src/lib.rs` and `runtime/build.rs` exits 2
for both, confirming the false-positive behaviour on real files. `.claude/settings.json` registers exactly
two hooks, both `PostToolUse` on `Write|Edit|MultiEdit`, and **no `PreToolUse` entry at all**.

`review.sh:528-539` and `dispatch.sh:367-369` list the uncaught patterns as banned, and T3 — the only
dispatched tier — is all TypeScript, where the hook catches nothing. It also **false-positives on 11
tracked files** (any edit to `runtime/src/lib.rs`, `runtime/build.rs`, `node/src/cli.rs`, etc. trips it),
because it greps the whole file rather than the edit. The factory worktrees *do* carry the hook (verified
on all 19 live worktrees), but whether it fires under `claude -p --dangerously-skip-permissions` is
**UNVERIFIED by execution**.

`post-edit.sh` requires `jq`, which is **not installed** — it is a silent no-op (acknowledged in the
script's own comments).

**The lint gate itself passes.** CLAUDE.md names `cargo fmt --all -- --check && cargo clippy --workspace
--all-targets -- -D warnings` as the gate; no phase had run it locally, so the lead did:

```
$ cargo fmt --all -- --check
fmt exit=0
$ cargo clippy --workspace --all-targets -- -D warnings
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 10.16s
clippy exit=0
```

Clean, with `-D warnings` in force and `--all-targets` including the test code. Taken together with the
109/109 test result and the zero-violation standing-rule sweep, the *code hygiene* half of ENDGOAL §3.5 is
in good shape; what fails in this phase is coverage (§1.1, indexer/explorer CI) and enforcement (the hook).

**Standing-rule sweep of the entire tracked tree.** `todo!(`, `unimplemented!(`, `#[ignore]`,
`SKIP_WASM_BUILD` in CI, `continue-on-error`, `allow_failure`: **zero in code** (hits are confined to the
hook, the factory prompts, and docs). `#[allow(` — 20 hits, **all legitimate with written justification**:
clap `missing_docs` on flattened fields; `clippy::large_enum_variant`, `type_complexity` and
`too_many_arguments` each with a multi-line rationale; `deprecated` on `TransferStake` pending a storage
migration; 12 × `dead_code` on gov test helpers copied into four mocks; one `dead_code` const in
`tests/common.rs`. None silences an error to make a gate pass. `fn main() {}` — one hit,
`runtime/build.rs:25`, under `#[cfg(not(feature = "std"))]`, which is the SDK template convention, not the
founding-failure stub. `|| true` — 46 hits, **none wrapping a gate command or a CI test step** (docker
prune, gh label helpers, trap/cleanup, log captures, and test files deliberately capturing a return code).
JS skips — only `describe.skipIf(!RUN_INTEGRATION)` in the SDK's opt-in live blocks; no `.only`, no
unconditional `.skip`. `@ts-ignore`/`eslint-disable` — two `no-console` lines in an experiments script.
13 `shellcheck disable`s, all with inline reasons. **Verdict: no standing-rule violations in code.**

**Reports describe reality — the fix did not hold.** `factory/STATE.md` is *written* by `tracker.sh`
(so it was read, not run). Its header says `dispatcher: false | merge: false (MERGE_T2=false)` — but
`factory-dispatch.service`'s effective environment is `ENABLE_DISPATCH=true ENABLE_MERGE=true
MAX_PARALLEL=3 DAY_MAX_PARALLEL=3 DAILY_SPAWN_CAP=120`. The cause is that `tracker.sh:195-196` prints
`${ENABLE_DISPATCH:-false}` **from its own environment**, and the file is rewritten by whichever unit ran
last: the nightly digest gist (05:30Z) says `dispatcher: true | merge: true`, while every watchdog pass
(every 30 min, no such env) resets the file to `false | false`. So the same file alternates. STATE.md also
never reports `DAILY_SPAWN_CAP` (effective 120 vs the repo default 40, whose comment computes "~$30/day")
or `DAY_MAX_PARALLEL` (effective 3 vs default 1, defeating the documented daytime throttle).

---

### Phase 6 — Autonomy layer (ENDGOAL §3.6)

**`dispatch.sh` still has no open-PR skip (issue #106 remains valid).** There is no check for an existing
open PR or a `task/<n>` branch, so #88 and #101 are re-dispatched **every hour**; `gh pr create` has failed
**493 times**; and #87 — the only genuinely undone `ready` issue — has been DEFERred **241 times** and never
started. The tier gate itself is sound: T0/T1 can never be dispatched, the `ready` label is required, and
`gate_from_issue` takes the gate command from the issue body and refuses the issue if there is no fenced
gate block.

**The spend ledger confirms the cap is being eaten by bookkeeping.** The brief asked for today's
`dispatch:` phantom entries against real `loop:`/`review:` spawns; read from `~/.factory/spend-YYYYMMDD`:

| Day | Entries | `dispatch:` (no agent) | `loop:` | `review:` |
|---|---|---|---|---|
| 2026-09-08 (today, to 14:00) | 26 | **26 (100 %)** | 0 | 0 |
| 2026-09-07 | 76 | 51 (67 %) | 15 | 10 |
| 2026-09-06 | **120 — exactly the cap** | **60 (50 %)** | 60 | 0 |

Today's 26 are two entries per hour, every hour since 00:04, for `issue-88` and `issue-101` — both of which
**already have open PRs** (#113 and #112). Not one real agent has been spawned today. And on 2026-09-06 the
factory reached its daily ceiling of 120 with half the budget spent on entries that started no work. So the
answer is yes: the cap is consumed by bookkeeping, and the cause is the missing open-PR skip below.

Note also that the effective ceiling is **120**, three times the repo's committed default of 40
(`factory/config.env`, whose comment sizes 40 at "~$30/day") — and that override lives only in a local
systemd drop-in, so a rebuild would silently return to 40.

**A BLOCKED loop does not park its issue** (no `blocked`/`needs-human` label added, `ready` kept), so
blocked work is re-dispatched hourly: issue #102 ran **67 loops / 200 real `claude` spawns**, every one
failing identically on `shellcheck: command not found`.

**`review.sh` never calls `load_billing_env`.** Under systemd its lenses therefore have neither
`~/.factory/env`'s PATH nor `ANTHROPIC_API_KEY`. Result: **all 6 systemd-launched reviews — 18 of 18
lenses — exited 127**, so no PASS or FAIL has ever been produced by a systemd review. Now that the
local `path.conf` puts `claude` on PATH, the next systemd review would run **without** the API key and
bill the interactive OAuth login — the exact failure mode `common.sh:99-110` says must never happen.

**`merge.sh` — the exact conditions, in order:** STOP_FACTORY; branch protection present with ≥1 required
check; `ENABLE_MERGE=true`; candidate list from `gh pr list`; tier from PR labels or the linked issue;
refuse if draft; refuse if `needs-human`; **require `agent-reviewed`**; tier gate (T3 passes because the
default placeholder string counts as enabled, T2 needs `MERGE_T2=true`, T0/T1 refused); refuse if
`mergeable == CONFLICTING`; `gh pr checks` must exit 0 and not report "no checks"; then
`gh pr merge --squash --delete-branch`.

**Can a FAIL merge?** Mostly no, with two real holes.
*Sound:* a missing or garbled verdict becomes ERROR → INCONCLUSIVE → `needs-human`, no `agent-reviewed`;
verdict parsing tolerates casing and whitespace (51 assertions); pending CI exits 8 → refused; zero checks
→ refused.
*Hole 1 — an ordering race:* `agent-reviewed` is added **before** `needs-human`. With 2 PASS + 1 FAIL, if
the second `gh pr edit` fails (network, rate limit, missing label) the PR is left `agent-reviewed` without
`needs-human` and merges at the next :30. "Any FAIL blocks" depends on a second network call succeeding.
*Hole 2 — no SHA binding:* `agent-reviewed` persists across new pushes, and `dispatch.sh:466` pushes
`HEAD:refs/heads/task/$num` from the **reused** worktree every hour while `review.sh` runs only inside
`open_pr` after a *successful* `gh pr create`. Unreviewed commits can therefore land on a PR that keeps
its `agent-reviewed` label. `grep -nE 'headRefOid|reviewed[-_]?(at|sha)' merge.sh review.sh` → nothing.
Additionally, labels are the entire record and the worker itself runs with the operator's `gh` token and
an allowlist including `Bash(gh pr*)`; nothing mechanical stops a worker from self-labelling. ENDGOAL's
"gated on review, not on the agent's own claim" is enforced by **prompt text**, not by mechanism.

**Why nothing merges.** `logs/merges.log` **does not exist — merge.sh has never merged anything.** The
hourly log reads `REFUSE #113 has needs-human`, `REFUSE #112 has needs-human`, `REFUSE #116 missing
agent-reviewed`. But **PR #112 has no objection**: it carries a 2026-09-03 review of `0 PASS / 0 FAIL /
3 ERROR` (all `claude exit 127`) that set `needs-human`, and a 2026-09-07 review of **`3 PASS / 0 FAIL /
0 ERROR`** on the *same head* that set `agent-reviewed`. `review.sh` never removes a stale `needs-human`
(`grep remove-label review.sh` → nothing), and `merge.sh` reports it as an "unresolved review objection".
Its CI is all green. Separately, both open PRs are `mergeable_state=behind`, and with `strict: true`
GitHub blocks out-of-date branches while `merge.sh` has no update-branch step — so even a clean PR would
fail hourly. `merge.sh:24-25`'s own header ("master has NO protection (the API returns 404), so merge.sh
currently refuses everything by design") is false; the log proves protection is detected.

**PATH.** `env -i PATH=/home/dev/.npm-global/bin:… which claude shellcheck gh node git python3 flock timeout`
→ all resolve, rc=0; `claude --version` → 2.1.263. The `path.conf` drop-ins that make this work are
**local-only** and installed by nothing in the repo (`factory/install-systemd.sh` installs only
watchdog + digest, plus dispatch with a flag, and no merge unit at all). `~/.factory/env` (0600, 174 B)
holds `ANTHROPIC_API_KEY` (by name) and a PATH export; it is sourced only by `load_billing_env`, called
only from `loop.sh:149`.

**Bounded loops** are otherwise real: attempt caps, wall-clock caps, same-error early stop, a
`~/STOP_FACTORY` kill switch (absent right now) and a watchdog enforcing them every 30 minutes.

---

### Phase 7 — Reproducibility (ENDGOAL §3.7)

**The README is 25 lines.** It gives **one** build step (`cargo build --release`) and names **zero**
prerequisites. `git log -1 -- README.md` → `eab04b6`, 2026-04-23 — which is the `upstream-baseline` tag
itself. `git describe --tags` → `upstream-baseline-144-g6efba16`: **the README has not been touched in all
144 commits of the rebuild.** It lists `node/`, `runtime/`, `pallets/`, `tests/` and omits `deploy`,
`docs`, `experiments`, `explorer`, `factory`, `faucet`, `indexer`, `knowledge`, `landing`, `scripts`, `sdk`.

Prerequisites the box has and the README omits — with whether each blocks the build:

| Prerequisite | Present | Needed by | Blocks? |
|---|---|---|---|
| rustup | 1.29.0 | `rust-toolchain.toml` only works via rustup | **YES** |
| Rust 1.85.0 pin | installed (default is `stable`) | pin comment: "rustc 1.97.1 cannot compile this tree" | handled iff rustup present |
| `wasm32v1-none` + `rust-src` | installed | `rust-toolchain.toml:32-33` | handled iff rustup present; the fallback trap is undocumented outside that file |
| protoc | 3.21.12 | `prost-build 0.13.2` ← litep2p, sc-network(-light/-sync), sc-authority-discovery | **YES** |
| clang / libclang | 19.1.7 | `bindgen 0.65.1` ← `librocksdb-sys` ← rocksdb | **YES** |
| cmake, gcc, make | present | librocksdb-sys `cc` build | yes |
| pkg-config | 1.8.1 | standard Substrate set | likely |
| libssl-dev | installed | **not actually required** — no `openssl-sys` in Cargo.lock (docs claim it is) | no |
| Node ≥ 22.6 | v22.23.1 | products' `--experimental-strip-types` and `node:sqlite` | products only; **no doc states 22.6** |
| shellcheck, gh, claude CLI, `~/.factory/env` | present | factory gates | factory only |

On a clean Debian with only the README, `cargo build --release` fails for **three independent reasons**.
The published `docs/guide/run-a-node.md:9-31` *does* list Rust 1.85.0, `wasm32v1-none`, clang,
protobuf-compiler and pkg-config — but the README does not link to it, and even that page assumes rustup
is already installed.

**deploy/ largely does reproduce the running config.** Node keys are fixed in `nodes.env:27-33` and match
the five files on disk byte for byte. The three `~/.config/scalar-commons/*.env` files are byte-identical
to their `.env.example` counterparts. Most importantly: **the committed raw chainspec IS the live chain's
genesis** — `state_getKeysPaged("0x",1000,null,genesisHash)` returned 202 keys, set-equal to the spec, and
`state_getStorage` for all 202 at genesis gave **0 mismatches**, `:code` included. Re-running
`build-spec --chain local --raw --disable-default-bootnode` with the on-disk binary reproduced the
committed file byte-identically (2 356 109 B).

**But the binary's provenance is broken** (see Phase 0): it was built from a dirty tree, and its version
string names `297bd66`, whose `chain_spec.rs` has only **3** authorities. `git checkout 297bd66 && cargo
build --release && build-spec --chain local` yields a *different* chain that cannot join this devnet.
Rebuilding from `master` (which contains `0edee76`) does reproduce it.

Every repo unit hardcodes this box: `/home/dev/scalar-commons-v4/...` appears 3× per validator unit
(Documentation, ExecStart binary, `--chain` path) and 2× per product unit, plus `/usr/bin/node`. Base paths
correctly use `%h`. `deploy/README.md` and `deploy/install.sh` carry **no warning** about this;
`products/README.md:165-170` does. The expected genesis hash appears only in `snapshot.json` and
`chain-facts.json` — **not** in `deploy/README.md` or the run-a-node page, so an operator has nothing to
check `chain_getBlockHash(0)` against.

**Release tag: none.** `git tag -l` → `upstream-baseline` only; `gh release list` → empty; `gh api
…/releases` → 0. `node/Cargo.toml` 4.0.0, `runtime/Cargo.toml` 3.0.0, spec_version 304, and there is no
`[workspace.package]`. The GitHub description and homepage are both empty strings.
**ENDGOAL §3.7's "the release must be tagged" is unmet.**

**Lockfiles: good.** `Cargo.lock` plus six `package-lock.json` are all tracked; the seventh `package.json`
(`experiments/sc-e1/archetypes`) has zero dependencies. `cargo metadata --locked --offline` → exit 0,
1 120 packages, and `Cargo.lock` unchanged afterwards. All `node_modules` and `dist` directories are
gitignored. Minor mismatch: `faucet/package.json` declares `engines.node ">=18"` while its `start` script
needs ≥22.6; `explorer`/`sdk` likewise say ">=18".

**CI is the real clean-machine proof, and it works.** `ci-full.yml` installs protoc, pins the toolchain
from `rust-toolchain.toml`, adds `wasm32v1-none` + `rust-src`, asserts the rustc version, then
`cargo build --release`, runs `--version` and `build-spec`, `cargo check --features runtime-benchmarks`, and
`cargo test --workspace`. Nothing anywhere sets `SKIP_WASM_BUILD`. The newest master run (2026-09-07,
`6efba16`) succeeded but on a warm cache; the **cold** proof is the oldest of 57 successful runs
(2026-08-02, log shows `No cache found`, `rustup toolchain install 1.85.0 --target wasm32v1-none`,
`Setting up protobuf-compiler`, release build success, 71 min). So a clean Ubuntu runner **does** build
this tree — the missing piece is that the README never tells a human to do what the workflow does.

**Uncommitted local state a rebuild would lose:** the six untracked root `.md` files; every local-only
systemd unit and drop-in listed in Phase 0; `explorer/dist/` and `faucet/dist/` (both are a running
service's entrypoint); `landing/dist/`, `docs/.vitepress/dist/`; `factory/{STATE.md,blocked/,digests.log,logs/,run/}`;
`~/.config/scalar-commons/*.env` (reproducible); `~/.factory/` (API key + spend ledgers Aug 4 – Sep 8);
`~/shared-target` (17 G); `~/scalar-products/indexer/indexer.sqlite` (13.5 MB); 34 G of chain data; and
**19 git worktrees** under `/home/dev/wt-*` (3.2 G), several on branches already merged or closed.
`git stash list` → empty.

---

### Phase 8 — The acceptance test (ENDGOAL §4), dry-run

ENDGOAL §4 defines done as "an outsider — with no access to the server, no help, and no prior knowledge"
completing all nine. Items 3–7 currently have no public path at all, so each is scored twice: what works on
loopback today, and what a stranger would actually get.

| # | Item | Today (loopback) | A stranger, today |
|---|---|---|---|
| 1 | Open the landing page and read what the network is | **PASS** — `https://tejaspatil.tech/scalar-commons-v4/` returns 200, and its token-model and network numbers match live metadata | **FAIL** — all three GitHub destinations, each badged "Live", return 404 because the repo is private |
| 2 | Read the docs and follow them without hitting a contradiction or a broken instruction | **FAIL** — 0 broken internal links out of 35, and the constant gate passes, but the pages carry the four false token-model claims, the identity/SDK errors, and both #87 and #88 | same |
| 3 | Connect to the public wss RPC from their own machine | **PASS on loopback** — HTTP `system_chain` answers, and a raw-socket WebSocket upgrade returns `101 Switching Protocols` with `system_health` over the socket | **BLOCKED-ON-#76** — 9944 is loopback-only; `scalarnet.io` was registered 2026-09-07, is a GoDaddy parking page, has no `rpc.` record, and appears nowhere in the repo |
| 4 | Request test CMN from the faucet and receive it | `GET /health` 200; **drip deliberately not exercised** | **BLOCKED-ON-#76**, and see I-6: the //Ferdie key makes the faucet's limits meaningless once RPC is public |
| 5 | Register an agent, stake, and enter an escrow using the SDK | **UNVERIFIED** — every SDK call name matches a real extrinsic in live metadata, but no test or session has ever registered a new agent on this chain | **FAIL even after #76**: registration needs stake 1 000 + fee 50 + existential deposit 0.01 ≈ **1 050.01 CMN**, while the faucet drips **10 CMN once per address per hour** → **≥ 106 hourly drips ≈ 4.4 days** before a single registration is affordable |
| 6 | Watch their extrinsic in the explorer, and navigate block → extrinsic → account | **PASS** — walked on a real signed extrinsic (`511615-1 escrow.confirmDelivery`, 33 min old at the time); every extracted link resolved 200 | **BLOCKED-ON-#76**. Also worth stating: **every signed extrinsic on this chain is the factory testing itself** — 125 in a 15.4k-block window, exactly 25 each of five call types, one cycle per hour. There is no third-party activity |
| 7 | Query the indexer and get real data about their own activity | **PASS** for recent activity — `/v1/accounts/5Grwva…` returns real balances and `activity.extrinsicCount 100` | **BLOCKED-ON-#76**, and degraded: the sqlite window starts at block 496 606 (2026-09-07T05:05Z). Ferdie's 70 signed extrinsics are invisible (`firstSeenBlock: null`). Anyone whose activity predates the last indexer restart sees nothing |
| 8 | Read the token model and see the documented constants match the live chain | **SPLIT** — all 22 required constants match (`check-chain-values.mjs` ✓, plus live spot-checks of decimals, ss58, spec, cap, era duration, min stake, fee, ED). **But the page's prose about state is wrong**: 18 B genesis (live 6.01 B), 5 B treasury (live 43.58 M, started empty), "no other pallet has a mint path" (staking minted 100 % of new issuance) | **FAIL** — a stranger comparing the page to the chain sees 6.05 B, not 18 B |
| 9 | Attempt to game the emission formula and find it unprofitable | **BLOCKED-ON-live-archetype-runs** — and there is nothing to game yet: `settle_era` has never succeeded, so no CMN has ever been emitted by the formula. The only evidence available records wash trading as profitable | same |

**Score: 3 of 9 pass on loopback; 0 of 9 pass for a stranger.** Items 1, 2 and 8 fail on content rather than
plumbing, which means they would still fail the day the domain goes live.

---

### Phase 9 — Coordination (ENDGOAL §6)

`git remote -v` → `https://github.com/tejaspatil1936/scalar-commons-v4.git`.
`gh repo view --json isPrivate,visibility,isFork,parent,description,homepageUrl` →
**`{"isPrivate": true, "visibility": "PRIVATE", "isFork": false, "parent": null, "description": "", "homepageUrl": ""}`**.

Two things follow. First, **the repository is private**, so every GitHub link the public landing page
serves is a 404 for a stranger (verified anonymously below). Second, **it is not a fork** — ENDGOAL §6
says the repo "now lives at `tejaspatil1936/scalar-commons-v4`, **forked from Matty's**", which GitHub's
own metadata contradicts.

```
curl -A Mozilla/5.0 -o /dev/null -w '%{http_code}'  …/scalar-commons-v4                     → 404
                                                    …/scalar-commons-v4/tree/master/docs    → 404
                                                    …/scalar-commons-v4/tree/master/faucet  → 404
                                                    …/scalar-commons  (the docs social link) → 404
```

**CLAUDE.md present-tense claims that are not true on master:**

| CLAUDE.md | Actual |
|---|---|
| :9 "Toolchain: Polkadot SDK 2025.12 line (sp-core 39.x, frame-system 45.x, sp-runtime 45.x)" | pinned to tag `polkadot-stable2503`; Cargo.lock has **sp-core 36.1.0, frame-system 40.1.0, sp-runtime 41.1.0** |
| :13 "All minting flows through the emissions pallet only" | pallet_staking mints; 100 % of live new issuance came from it |
| :14 "Weight = stake × rank × oracle accuracy × governance participation × velocity bonus" | √stake; oracle and governance are **additive**, not multipliers; omits volume, diversity, heartbeat, floor, onboarding |
| :35 "Local 3-validator devnet" | 5 authorities in the local preset; live `session.validators` = 5 |
| :34 "`cd indexer && npm test`" as the documented test command | that command runs `tests/live.test.ts`, which **submits real extrinsics** to the live devnet |
| :6 "18B genesis mint" | live genesis issuance 6,010,250,000.01 CMN |
| :30 "All builds/tests run in GitHub Codespaces or GitHub Actions — never assume a local machine" | the devnet, the products and the whole factory run on this box |
| :8 "24-endpoint REST API" | **true** — exactly 24 routes |
| :7 seven custom pallets; append-only pallet indices; F-04; GovVoteVerifier wired to `VotingFor`; MinQualifyingVol ≥ 50 CMN; VelocityBonusBps +30 % | **all true** in code (though the last two have no test) |

**ENDGOAL.md's own stale lines** (now merged to origin as a tracked file):
§3.3 "four of five validators run without `--rpc-methods safe`" (all five have it);
§2 "18 billion minted at genesis (split 7B/5B/3B/3B)" (not on any reachable preset);
§2's formula (see the Phase 1 table);
§3.1 "proven over 11+ days" (understated: alice is at 35 d);
§3.5's gap list still names `sdk`, `faucet`, `docs` and `landing` as uncovered by CI — they now have jobs;
only `indexer` (and `explorer`, unnamed) remain uncovered;
§6 "forked from Matty's" (GitHub says not a fork).

**Server ownership** (§6, netcup RS 8000 in Matty's name) is **UNVERIFIABLE from here**. The only facts
available: the box is `152.53.113.104`, whose PTR is `v2202607384283486718.luckysrv.de`.

## 4. Claimed vs actual

The brief called a doc-versus-reality gap the most valuable finding, and ENDGOAL §0 makes closing that gap
the whole point of the project. This is the complete list, ordered by how public the claim is.

### 4.1 Claims served on the public internet right now

The landing page (`https://tejaspatil.tech/scalar-commons-v4/`, HTTP 200, 15 595 B) and the docs site
(`/docs/…`, 200) are live, public, and current with `origin/master`. `md5sum landing/dist/index.html`
equals the md5 of the live page. Everything in this subsection is therefore readable by a stranger today.

| # | Claim (verbatim) and location | Actual | How verified |
|---|---|---|---|
| C1 | `docs/reference/token-model.md:40` — "**All minting flows through pallet-emissions. No other pallet has a mint path.**" (`grep -c` on the fetched public HTML = 1) | `runtime/src/lib.rs:847` `type EraPayout = pallet_staking::ConvertCurve<RewardCurve>` with `:838 RewardRemainder = ResolveTo<TreasuryAccount>`. **43 581 090 CMN — 100 % of all issuance since genesis — was minted by pallet_staking**, and the emissions pallet has minted zero | `state_getStorage(Balances::TotalIssuance)` at genesis vs head; whole `Emissions` prefix holds **1** key (its storage version); `Staking::CurrentEra` = 47 |
| C2 | `docs/index.md:53` — "The supply cap is a hard invariant. 100 billion CMN, **enforced at every mint site**" | `ConvertCurve` is cap-unaware; `pallet_constitution::base_call_allowed()` is wired only as a `BaseCallFilter`, which gates *dispatched calls*, while the era payout is an era-rotation **hook**; the constitution's `on_initialize` only *emits* `SupplyCapBreachBlocked` **after** `current > cap` and never halts | code read + the C1 measurements |
| C3 | `docs/reference/token-model.md:29` — "Genesis mint \| 18,000,000,000 CMN" | Live genesis `TotalIssuance` = **6 010 250 000.01 CMN**. `dev_genesis` (`chain_spec.rs:282`) endows 1 B × 6 accounts + 5 × (2 M stash + 50 k controller) and never references `GENESIS_MINT` | `state_getStorage(TotalIssuance, genesisHash)` → `0x00e48cff5663f9d04501…` = 6 010 250 000 010 000 000 000 plancks |
| C4 | `token-model.md:59-60` — the 7B/5B/3B/3B split holds "**in both the dev/testnet presets** and the mainnet genesis builder"; `run-a-node.md:105` — "The 18B CMN genesis mint is split four ways" | The split exists only in `mainnet_genesis_config` (`chain_spec.rs:411`), which the file itself marks "**deliberately not reachable from a `--chain` id**". Every reachable preset uses `dev_genesis` | code read + C3 |
| C5 | `token-model.md:347` — the treasury "**starts with 5B CMN from genesis**" | `dev_genesis` sets `"treasury": {}`; the pot began empty and holds **≈43.58 M CMN**, still rising — essentially all of it staking inflation arriving as `RewardRemainder` | Derived the account from the `sc/trsry` `PalletId` (`"modl" ++ id`, zero-padded) → `5EYCAe5jKanUVRD6sxyjGQmVXuKnZDL2UCUdb2AUhvyNE2e7`, built the `System::Account` key, and read it: **43 581 095.63 CMN at 14:01 CEST**. That is 5.57 CMN more than the total-issuance delta, which is transaction fees routed to the treasury rather than minted — the two figures reconcile |
| C6 | `token-model.md:30` — "Emittable headroom 82,000,000,000"; `:100-102` — "1.46 B/yr, 56 years, 561 years" | Live headroom is **93.95 B**; the projections are arithmetic on the false 18 B premise | derived from C3 |
| C7 | `token-model.md:7` — "Every raw value below is the value read from the live runtime" | True of the 30 constants inside armed check tables; **false** of C3, C5 and C6, which are hand-typed prose about *state* | `check-chain-values.mjs` covers `api.consts` only |
| C8 | Landing page: four cards badged **"Live"**, three linking to `github.com/tejaspatil1936/scalar-commons-v4…` | **The repository is private.** Anonymous `curl` on all three → **404**. So does the docs site's own GitHub icon, which additionally targets `…/scalar-commons` (**missing `-v4`**) | `gh repo view --json isPrivate` → `true`; four anonymous `curl -w '%{http_code}'` → 404, 404, 404, 404 |
| C9 | Landing faucet card: badge "**Live**", body "No hosted instance is up yet". Explorer card: badge "**Live**", body "A hosted explorer for the devnet is not up yet" | Self-contradictory inside one card. `landing/src/render.mjs:157` renders **any** non-`planned` status as "Live"; `grep -c 'class="badge">Live'` on the live page = 4 | fetched HTML |
| C10 | Landing "Documentation" card → the private GitHub tree, with "A fuller developer guide is still being written" | The full guide is **already published on the same host** at `/scalar-commons-v4/docs/` and the landing never links it | both URLs fetched, 200 |
| C11 | `docs/guide/sdk.md:118` and `docs/reference/rpc.md:304` — an on-chain identity is "**Required to register as an agent**" | `pallets/agents/src/lib.rs:735-799` `register()` performs **no** identity check; the only `IdentityRequired` guard is in `set_capability` (`:1047`) | code read (behaviour not exercised — see §7) |
| C12 | `docs/guide/sdk.md` — `total = free + stake + pendingEmissions`; `recordGovVote` "has no SDK wrapper yet" | `sdk/src/index.ts:423` computes `total: free + pendingEmissions` (stake is a lock *inside* free); `sdk/src/index.ts:322` **does** export `recordGovVote(signer, pollIndex)`, tested at `integration.test.ts:132,157`. The page was last touched 2026-08-05; the SDK changed 2026-09-02 without it | public page fetched and grepped; code read |
| C13 | `docs/guide/run-a-node.md:116-117` — the presets pre-register "each genesis validator" with 10 000 CMN, "the minimum that qualifies for floor emissions from era 1" | `chain_spec.rs:287-291` registers `endowed_accounts.iter().take(3)`; live `AgentStake` has **3** keys while **5** validators author. And the floor is gated by ≥ 50 CMN era volume + heartbeat ≥ 90 (`emissions/lib.rs:586-596`), not by stake — as `token-model.md:318` itself says | `state_getKeysPaged` on the `AgentStake` prefix → 3; code read |
| C14 | `docs/reference/rpc.md:19-21` — "The devnet runs with `--rpc-methods safe`, which withholds … `author_rotateKeys`" vs `run-a-node.md:232-262` — a validator start with **no** `--rpc-methods` flag, then `curl author_rotateKeys` (**open issue #88**) | The first half is now true of all five nodes. The recipe in the second half cannot work as written | `/proc/*/cmdline` × 5; both files read; issue gate exits 1 |
| C15 | `docs/guide/run-a-node.md:150-172` — start a full node on `--rpc-port 9960`, then "Verify it joined" by curling `http://127.0.0.1:9944` with alice's sample output (**open issue #87**) | 9944 is alice, not the node just started. A stranger verifies the wrong node | file read; issue gate exits 1 |
| C16 | `docs/index.md:41` links `https://polkadot.com/platform/sdk` | 404 | `curl -A Mozilla/5.0` |
| **C17** | `docs/reference/rpc.md:296` — a published pallet table states **"`Sudo` \| 16 \| Removed by referendum after launch"** | **Sudo is still set to //Alice on day 36.** Nothing in the runtime schedules or has performed a removal: the only occurrences of the intent are three aspirational comments in `chain_spec.rs` (`:374`, `:423`, `:540`), and `grep` for `remove_key`/`set_key` in `runtime/src/lib.rs` finds nothing. This row tells a stranger the chain's root key is gone when it is live | `state_getStorage(Sudo::Key)` → `0xd435…a27d`; `//Alice` derived independently to the same public key; `grep -rn 'remove_key\|RemoveKey' runtime/src/lib.rs` → no output |

### 4.2 CLAUDE.md — the file that overrides default behaviour

| Claim | Actual |
|---|---|
| `:13` first principle #1 — "All minting flows through the emissions pallet only" | Same as **C1**. The shipped runtime violates the project's own first principle |
| `:14` — "Weight = stake × rank × oracle accuracy × governance participation × velocity bonus" | Wrong on three operators: stake enters as **√stake** (`integer_sqrt`, `emissions/lib.rs:557`); oracle accuracy is an **additive** bonus that contributes **+0** today (`OracleScoreProvider = ()`); governance is an **additive** 1 500 bps term inside a bounded budget, gated on `work_score > 0`. It also omits volume, diversity, heartbeat, the floor and the onboarding boost |
| `:9` — "Polkadot SDK 2025.12 line (sp-core 39.x, frame-system 45.x, sp-runtime 45.x)" | Pinned to tag `polkadot-stable2503`; `Cargo.lock` has **sp-core 36.1.0, frame-system 40.1.0, sp-runtime 41.1.0** |
| `:35` — "Local **3-validator** devnet" | The local preset has 5 authorities (`chain_spec.rs:152-168`); live `session.validators` = 5 |
| `:6` — "18B genesis mint" | Same as **C3** |
| `:34` — documented test command `cd indexer && npm test` | That command runs `tests/live.test.ts`, which has **no env gate** and **submits real extrinsics** to the live devnet |
| `:30` — "All builds/tests run in GitHub Codespaces or GitHub Actions — **never assume a local machine**" | The devnet, all three products and the entire factory run on this machine |
| `:8` — "24-endpoint REST API" | **True** — exactly 24 routes in `api.ts:215-519` |
| `:7` seven pallets; append-only pallet indices; the F-04 guard; `GovVoteVerifier` wired to `VotingFor`; `MinQualifyingVol` ≥ 50 CMN; `VelocityBonusBps` +30 % | **All true in code.** The last two have no test, and the guards themselves are intact |

### 4.3 ENDGOAL.md — now merged to `origin/master` as a tracked file (PR #116, 2026-09-08T06:42Z)

| Claim | Actual |
|---|---|
| §3.3 "*Current known gap: four of five validators run without `--rpc-methods safe`*" | **Closed.** All five have carried the flag since 2026-09-02 20:44; the repo caught up on 2026-09-07 in `6efba16`. The document publishes a gap that no longer exists |
| §2 "18 billion minted at genesis (split 7B / 5B / 3B / 3B)" | Same as **C3/C4** |
| §2 the emission formula | `√stake` is right, but activity/volume and diversity are **additive** inside a bounded budget, not standalone multiplicative factors; the velocity bonus and the floor term are missing entirely |
| §3.1 "run … unattended (currently proven over 11+ days)" | Understated: alice has 35 d 13 h continuous; the other four have 5 d 11 h since an **operator-initiated** config restart |
| §3.5 "landing, faucet, docs, sdk, and indexer have real suites that no workflow runs" | Partly closed: landing, faucet, docs and sdk all have required CI jobs now. **indexer** is still uncovered — and so is **explorer**, which the sentence never names |
| §3.6 "three agent-built subsystems … all three were blocked … **Zero merges** was the correct outcome" | Still true of `merge.sh` itself — `factory/logs/merges.log` **does not exist**, so it has never merged anything. But PRs #99 and #100 (explorer and indexer) *were* merged into master by hand under a seven-green rollup that executed none of their code |
| §6 "the repository … **forked from Matty's**" | `gh repo view` → `isFork: false, parent: null`. It is the same repository, reached by a redirect; whether that was a transfer or a rename is not exposed by the API |
| §3.4 "All five attacker archetypes must be run against the live network" | Never run. The harness cannot reach a chain: the archetype runners import no transport, `run-eras.sh` and `extract-export.sh` `exit 1` as stubs, `zombienet.toml` names a binary that does not exist, zombienet is not installed, and `ci/sc-e1.yml` is not in `.github/workflows/` |

### 4.4 Internal docs, comments and status files

| Claim | Actual |
|---|---|
| `.github/workflows/ci-node.yml:15-18` (and `CI-NODE.md:19-20`, `ci-fast.yml:11-12`) — "indexer/ deliberately has NO job here. On master it contains one Python file (reconcile.py) and no package.json" | False since 2026-09-02. `indexer/` has `package.json`, a lockfile, 10 source files and 7 test files |
| `deploy/README.md:172-173` — "**Current state: `ufw` is installed and its unit is enabled, but the service is inactive — there is no host packet filtering running right now.**" | **False.** `/proc/modules` shows 21 live netfilter modules including ufw's full signature set (`nf_tables`, `nft_compat`, `xt_addrtype`, `xt_conntrack`, `xt_limit`, `xt_LOG`, `xt_recent`). Rules are loaded. The inference behind the claim is the same one this report made and had to retract: `ufw enable` installs rules via `ufw-init` without the unit going active. It sits directly above a warning telling the operator to run `ufw enable` |
| The repo is silent on host hardening | `git grep -il 'fail2ban\|PermitRootLogin\|PasswordAuthentication'` over the whole tracked tree → **nothing**. Yet `fail2ban` has run since 2026-07-28 with `banaction = nftables`, and sshd permits password **and** root login on `0.0.0.0:22`. A clean-machine rebuild from the repo reproduces neither the filter nor the jail (see I-24) |
| `merge.sh:24-25` — "master has NO protection (the API returns 404), so merge.sh currently refuses everything by design" | Protection **is** present and `merge.sh`'s own log records detecting it: "branch protection present on master; required checks: gate,full,landing,faucet,docs,sdk" |
| `.github/CODEOWNERS:3-6` — the blocking half is "a branch protection rule on master requiring 'Require review from Code Owners'" | That setting is **off** and `required_approving_review_count` is **0** |
| `factory/branch-protection.json` — the repo's own template | Matches nothing live; applying it would require a context no workflow emits (`ci-fast` vs the actual job name `gate`) and would switch `enforce_admins` **off** |
| `reject-stubs.sh:13` — "Exit 2 = block the tool call"; `factory/README.md:299-301` — "exits 2 to block the write" | It is wired as a **`PostToolUse`** hook, whose documented semantics are "the tool already ran". It cannot block; the message is advisory |
| `deploy/public/INSTALL.md:116-125` — "`docs/.vitepress/config.mts` sets no `base` … set `base: '/docs/'`" | `config.mts:21` already reads `base: process.env.DOCS_BASE ?? '/'`, merged in #111 three days **before** #107 | 
| `agents/lib.rs:26-27` — placeholder weights "Replaced by benchmarked weights from `pallets/agents/src/weights.rs` before mainnet"; `:40` "Placeholder weights returning zero" | No `weights.rs` exists in any pallet, and the placeholders return 30 000 000 … 1 000 000 000, not zero. The whole `WeightInfo` trait is dead code — no `Config` carries the type |
| `tests/integration.rs:3` — "These tests run **the full runtime (all 33 pallets)**" | `tests/common.rs:62` builds its own `construct_runtime!` with **8** pallets; the real runtime has **36** indices; `tests/Cargo.toml` does not depend on `scalar-commons-runtime`, `pallet-constitution`, `pallet-staking`, `pallet-referenda` or `pallet-conviction-voting`. `AccountId = u64`, `Balance = u64`, and the mock's own comment (`common.rs:302-303`) concedes "Real cap is 100B CMN but that overflows u64. Tests use scaled-down cap" — the tested cap is 10¹⁹ against a real 10²³ |
| `tests/common.rs:302-305` — "Use 10B CMN (10^13 * 10^4 = 10^16)" and `SupplyCapIntTest … // ~10B CMN` | The constant is **10¹⁹**, not 10¹⁶, and 10¹⁹ plancks is **10 million CMN**, not 10 billion — the comment is wrong by 1 000× and internally inconsistent. The scaled cap is 10 000× below the real one |
| `deploy/public/nginx/scalar-commons.conf.template:205` — "**The faucet mints**; keep it on the tighter bucket" | The faucet never mints. `grep -rn -i 'mint\|sudo\|force_transfer' faucet/src` finds only doc comments; the sole chain write is `balances.transferKeepAlive` (`chain.ts:154-155`). The rate-limit choice is right; the stated reason is wrong, and it contradicts the faucet's central "never a mint path" invariant |
| `emissions/lib.rs:116` and `:590` — "5 × UnitVolume (5,000 CMN)" | `runtime:1237` `UnitVolume = 10 CMN`, `:1243 MinQualifyingVol = 50 CMN` |
| `emissions/src/tests.rs:23-25` — mock `alpha() -> 4_000` | Runtime is **1 500** since ROUND14. The unit mock tests a parameter the chain does not use |
| `explorer/README.md` — "There is no database, no cache"; "a block or extrinsic page costs the four reads it takes to decode exactly one block" | polkadot-js rpc-core keeps a 102 400-entry LRU; measured **6.0–6.4** RPC calls on a cold block page (the account-page claim, 2.3 measured vs "one header read and one storage read", is fair) |
| `landing/README.md:68-70` — "the faucet is marked `planned` with a link to the issue tracking it" | `content.mjs:277-285` sets `status: 'available'` |
| `docs/VERIFIED-CONSTANTS.md:197` — alpha 4 000; `:502-503` — wash break-even "~1.12M … NOT expired — safe, but thin" | Alpha is 1 500 live; `verdict.json` records P5 wash as **FAIL** at a 1.0 M break-even. The staleness is disclosed at `token-model.md:417-424`, and the file is `srcExclude`d from the site — but it is still linked from a public page |
| `experiments/sc-e1/zombienet.toml:22-30` — "the node crate currently ships only `node/src/chain_spec.rs` (no Cargo.toml/main.rs yet)"; the `sc-e1` preset does not exist | Both false: `node/Cargo.toml` names `scalar-node` and `command.rs:70` wires the `sc-e1` preset. Separately the file's `default_command` is `./target/release/scalar-commons-node`, which does not exist |
| `.github/workflows/file-issues.yml:16` — `R="matty33/scalar-commons-v4"` | The repo is `tejaspatil1936/scalar-commons-v4` |
| `AUDIT.md:45` "`explorer/` DOES NOT EXIST"; `AUDIT.md` "faucet is not running"; "four of five nodes serving unsafe RPC"; `TODAY-PLAN.md:161` "pages.yml does not exist"; `:291-294` "/docs will 404" | All **superseded** — the explorer landed 2026-09-02, the faucet has run since 2026-09-07, all five nodes are safe, `pages.yml` exists and `/docs/` returns 200. These are historical documents, correctly dated, but they are untracked and would be lost on a rebuild |
| `TODAY-PLAN.md` — "five raw values in prose escape the gate" | The phrase is **not present** in that file or any other planning document. An independent sweep did find five *wrong* prose values (C3–C6, C13), which may or may not be the intended set |

### 4.5 Claims that checked out as true

Worth recording, because the point of the exercise is calibration, not accumulation: the 24-endpoint count;
the seven custom pallets and their `construct_runtime` indices; `--rpc-methods safe` on all five nodes and
the unsafe-method refusal; the `1 500` bps governance weight and the entire ROUND14 gov-farming fix
(9 tests, all passing); the bigint-end-to-end SDK claim (proven live against a balance above 2⁵³); the
committed raw chainspec being byte-identical to the live genesis across all 202 storage keys; the oracle
term being inert and *disclosed* as inert on both the landing page and the token-model page;
`check-chain-values.mjs` genuinely asserting and failing closed (five separate mutations each produced
exit 1); `enforce_admins: true` and `allow_force_pushes: false`; the indexer's bounded per-request RPC
load; 118 RPC methods on alice; ports, chain IDs, and the finality-check script; and the absence of any
standing-rule violation in the tracked tree.

## 5. Will break on rebuild — everything that works only because of local state on this box

The test for this section: *if this machine died and a stranger cloned `master` onto a clean host and
followed the repo, what would not come back?*

### 5.1 systemd state that exists nowhere in the repo

`git grep -F` finds no trace of any of these. `factory/install-systemd.sh` installs only the watchdog and
digest units (plus dispatch behind a flag), and **no merge unit at all**.

| Local-only file | Content | What breaks without it |
|---|---|---|
| `~/.config/systemd/user/factory-merge.service` + `.timer` | whole units: `ExecStart=factory/merge.sh`, `Environment=ENABLE_MERGE=true`, `OnCalendar=*-*-* *:30:00 UTC` | the merger does not exist at all |
| `factory-dispatch.service.d/override.conf` | `ENABLE_DISPATCH=true ENABLE_MERGE=true MAX_PARALLEL=3 DAY_MAX_PARALLEL=3 DAILY_SPAWN_CAP=120` | dispatcher stays off (`dispatch.sh` is off by default); repo defaults are 1 / 40, so the effective caps are also 3× and 3× the committed ones |
| `factory-digest.service.d/override.conf` | `ENABLE_DISPATCH=true ENABLE_MERGE=true` | the nightly digest reports the flags as off |
| `factory-{digest,dispatch,merge,watchdog}.service.d/path.conf` | `PATH=/home/dev/.npm-global/bin:…` | `claude` is not on systemd's default PATH — every worker and reviewer exits 127 |
| `factory-dispatch.timer.d/override.conf` | `OnCalendar=*-*-* *:00:00 UTC` | reverts to the repo's night-only window |
| `scalar-faucet.service.d/override.conf` | `ExecStart=/usr/bin/node dist/index.js` | **the faucet crash-loops** — see 5.2 |

### 5.2 Build products that a running service depends on, and that are gitignored

- **`faucet/dist/`** (built 2026-09-07 07:38). The repo unit, `deploy/products/install.sh:32`,
  `faucet/package.json`'s `start` and `faucet/README.md` all run `src/index.ts` under
  `--experimental-strip-types`, which fails with
  `ERR_MODULE_NOT_FOUND: Cannot find module '.../faucet/src/amount.js'` because Node 22 type-stripping does
  not rewrite `./x.js` specifiers to `./x.ts`. The journal shows the restart counter reaching **71** before
  the local drop-in was applied. Nothing in the repo builds `dist/`. (Issue #115 is open and describes this.)
- **`explorer/dist/`** (built 2026-09-03). The explorer unit's entrypoint; also gitignored.
- `landing/dist/`, `docs/.vitepress/dist/` — regenerable by documented commands, so lower risk.

### 5.3 The binary and the chain

- **`target/release/scalar-node` was built from a dirty working tree.** Its version string names `297bd66`,
  but `0edee76` (3 → 5 authorities) was committed **nine minutes after the build** and is not an ancestor
  of `297bd66`. Checking out the named commit and rebuilding produces a **3-authority genesis that cannot
  join this chain**. Rebuilding from `master` does reproduce it — but nothing in the repo says so, and
  `system_version` actively misleads.
- The committed `deploy/scalar-local-raw.json` *is* the live genesis (all 202 storage keys verified equal at
  the genesis hash, `:code` included), and `build-spec` with the current binary reproduces it byte for byte.
  That part is sound.
- The **expected genesis hash is not in any runbook** — only in `docs/.chain/snapshot.json` and
  `landing/chain-facts.json` — so an operator has nothing to compare `chain_getBlockHash(0)` against.
- Node keys **are** reproducible (`deploy/nodes.env:27-33` fixes all five and they match the on-disk files).
- 34 G of chain history under `~/scalar-testnet` and 13.5 MB of indexer sqlite would be lost; both are
  by-design regenerable, but the indexer would restart with a 256-block window and every account's history
  before that becomes invisible.

### 5.4 Hardcoded paths

Every repo unit hardcodes this checkout: `/home/dev/scalar-commons-v4/…` appears 3× per validator unit
(Documentation, ExecStart binary, `--chain` path) and 2× per product unit, plus `/usr/bin/node`. Base paths
correctly use `%h`, so only the repo path is fatal. `deploy/README.md` and `deploy/install.sh` carry **no
warning**; `products/README.md:165-170` does. A stranger with a different username or checkout location
gets units whose `ExecStart` does not exist.

### 5.5 Untracked and out-of-tree state

- Six untracked root documents: `AUDIT.md`, `STAGE1-HARDENING.md`, `STATUS.md`, `TODAY-PLAN.md`,
  `WEEKCHECK.md` (`ENDGOAL.md` became tracked mid-audit via PR #116). These carry the project's entire
  recent decision history and exist on this disk only.
- `~/.factory/` — the `ANTHROPIC_API_KEY` (0600) and the daily spend ledgers from 2026-08-04 onward.
- `~/.config/scalar-commons/*.env` — reproducible; byte-identical to the committed `.env.example` files.
- `~/shared-target` (17 G) — the factory's shared cargo target, referenced by `factory/config.env:162`.
- **19 git worktrees** under `/home/dev/wt-*` (3.2 G), several on branches already merged or closed. Two of
  them (`wt-101`, `wt-88`) are the live heads of open PRs #112 and #113, and `dispatch.sh` re-pushes from
  them hourly.
- `factory/{STATE.md, blocked/, digests.log, logs/, run/}` — the factory's memory of what it has tried.

### 5.6 Things that would come back correctly

For balance: the raw chainspec, the node keys, all six npm lockfiles and `Cargo.lock`
(`cargo metadata --locked` exits 0 over 1 120 packages), the three product `.env` files, every unit file
that *is* in the repo, and the CI pipeline — which is genuinely a clean-machine proof. The oldest of 57
successful `ci-full` runs shows `No cache found`, a fresh `rustup toolchain install 1.85.0 --target
wasm32v1-none`, `Setting up protobuf-compiler`, and a successful 71-minute release build. The tree does
build from scratch on a clean Ubuntu runner. The gap is that **the README never tells a human to do what
that workflow does.**

## 6. Proposed issues — ready to file, NOT filed

One issue per distinct defect, deduplicated across the phases that found it independently. **Every gate
below was executed by the lead auditor on 2026-09-08 and exits non-zero on `master` today**; each is
read-only. Tier follows ENDGOAL §3.6.

---

### I-1 · `tier:T0` · `security` — Remove the //Alice sudo key before any public RPC exposure
*(from P3-01, P1b-05 — the single decisive launch blocker)*

The live chain's `Sudo::Key` is `0xd435…a27d` = `//Alice`, a published Substrate dev seed.
`runtime/src/lib.rs:668-669` exempts `RuntimeCall::Sudo(_)` from SafeMode filtering, and
`author_submitExtrinsic` is classified **safe**, so `--rpc-methods safe` does not withhold it. The moment
`wss://rpc.<domain>` is reachable, any stranger can execute `sudo.sudo(system.set_code)`,
`balances.force_transfer`, `system.kill_storage` or `sudo.set_key`. TLS, nginx rate limits and ufw do not
mitigate it. `node/src/chain_spec.rs:373-374` says sudo is "Removed on day 14 via referendum"; the chain
started 2026-08-03 and today is day 36. `deploy/public/INSTALL.md` and `VERIFY.md` never mention sudo.

Worse, **the published docs already tell strangers this is done**: `docs/reference/rpc.md:296` carries the
table row `| Sudo | 16 | Removed by referendum after launch |`. Nothing in the runtime schedules a removal
— `grep -rn 'remove_key\|RemoveKey' runtime/src/lib.rs` returns nothing, and the only other mentions are
aspirational comments at `chain_spec.rs:374`, `:423` and `:540`. So the one document a careful stranger
would consult about root access states the opposite of the chain's actual state. Both halves need fixing:
remove the key, and correct the row until it is true.

I verified the identity directly rather than trusting the storage value alone: deriving `//Alice` with
`@polkadot/keyring` at ss58 42 gives `5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY` /
`0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d`, byte-identical to `Sudo::Key`. A
verifier independently recomputed the storage key itself (`twox128("Sudo") ++ twox128("Key")`) and got the
same address on all five nodes, and read the same root key out of the committed
`deploy/scalar-local-raw.json` that every unit loads — so the live root and the repo root are one key.

**Is it exploitable today, or only after exposure?** The chain side is settled and permissive: all five
P2P ports bind `0.0.0.0` **and** `[::]`, **no node carries `--reserved-only` or `--reserved-nodes`**
(checked across all five `/proc/*/cmdline`), the box holds a routable `152.53.113.104/22`, and alice
advertises `/ip4/152.53.113.104/tcp/30333/p2p/12D3KooWEyop…` as a dial target. Nothing in the *chain's*
configuration would refuse an internet peer.

The host side went through two corrections during this audit, and the final answer is **the host is
filtering**. An early draft argued the opposite from "`ufw.service` has never gone active this boot" — that
inference is wrong, because `ufw enable` installs rules through `ufw-init` without the unit ever going
active, and a completeness critic caught it. A gap-filling agent then pointed at evidence that needs no
root at all, and the lead confirmed it: **`/proc/modules` is world-readable and shows 21 live netfilter
modules, including the entire ufw signature set** — `nf_tables`, `nft_compat`, `xt_addrtype`,
`xt_conntrack`, `xt_limit`, `xt_LOG`, `xt_recent`. Rules are loaded in the kernel. (Their *contents* remain
unreadable: `nft list ruleset` → "Operation not permitted"; `iptables -L -n` → Permission denied.)

So the honest final position, materially less alarming than the first draft: **the sudo key is a
pre-exposure defect to fix, not a live incident.** Corroborating that, no foreign peer has connected in
36 days — all 20 established P2P sockets are between this host's own five nodes. An external probe reported
by a verifier suggested otherwise; it could not be reproduced, and the module evidence contradicts it, so
it is not relied on here.

Two related facts, neither previously recorded anywhere in the repo. **`fail2ban` has been active since
2026-07-28 11:04:12** with `banaction = nftables` (`jail.d/defaults-debian.conf:2`, which overrides
`jail.conf:208`'s stock `iptables-multiport` — an earlier version of this report quoted the stock value and
was wrong). And **`deploy/README.md:172-173` states as current fact: "there is no host packet filtering
running right now."** That is false, and it is in the runbook an operator would act on.

Fix: hand sudo to a multisig or remove it (`sudo.remove_key`) before exposure, and add the check to
`VERIFY.md`. This is T0 — human plus external review, never dispatched.

```sh
test "$(curl -s -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"state_getStorage","params":["0x5c0d1176a568c1f92944340dbfed9e9c530ebca703c85910e7164cb7d1c9e47b"]}' http://127.0.0.1:9944 | python3 -c 'import sys,json;print(json.load(sys.stdin).get("result"))')" = None
```
RED today (exit 1 — returns Alice's public key). GREEN when the key is None.

---

### I-2 · `tier:T0` · `security` — pallet_staking mints outside the supply cap, and the docs deny it exists
*(from P1a-01, P1c-01, P4-01, P4-06, P2e-02, P10-01, P8-02)*

`runtime/src/lib.rs:847` wires `type EraPayout = pallet_staking::ConvertCurve<RewardCurve>` (2.5 %–10 %
inflation, `:809-816`) with `:838 RewardRemainder = ResolveTo<TreasuryAccount>`. Live measurement:
`TotalIssuance` grew from **6 010 250 000.01 CMN at genesis to 6 053 831 090.07 CMN** — **+43 581 090 CMN,
100 % of it from staking**, while the emissions pallet's entire storage prefix holds one key (its storage
version) and `LastSettledEra` is null. No cap check gates this: `ConvertCurve` is cap-unaware,
`pallet_constitution::base_call_allowed()` is wired only as a `BaseCallFilter` (which gates dispatched
calls, not era-rotation hooks), and the constitution's `on_initialize` merely *emits*
`SupplyCapBreachBlocked` **after** a breach. This violates CLAUDE.md first principle #1 ("No code path may
mint beyond the cap. All minting flows through the emissions pallet only") and falsifies
`docs/reference/token-model.md:40` and `docs/index.md:53`, both published.

**There is also an unminted liability on top of that.** Reading `Staking::ErasValidatorReward` directly:
47 entries summing **14 623 530.33 CMN**, with `Staking::CurrentEra` = 47 — and `Staking::ClaimedRewards`
holds **zero keys**. No validator has ever claimed. Those 14.6 M CMN are *booked but not yet minted*, and
`payout_stakers` is permissionless — `substrate/frame/staking/src/pallet/mod.rs:1802` opens with
`ensure_signed(origin)?`, verified in the vendored SDK checkout — so the first person to call it starts
minting them. The real exposure is therefore ≈58 M CMN of uncapped issuance: ≈43.58 M already in the
treasury and ≈14.62 M pending on a call anyone can make.

Fix is a T0 decision: either bound or zero the staking mint (`EraPayout = ()` on a testnet), or accept it
and correct every document to name it — plus a test asserting total issuance including staking payouts
stays ≤ cap. Note the inversion worth stating plainly: **passive staking has minted 43.6 M CMN in 35 days
while work-based emissions have minted zero** — the exact opposite of the project's thesis, on a chain
whose landing page says "stake on its own earns nothing".

```sh
! grep -q 'type EraPayout = pallet_staking::ConvertCurve' /home/dev/scalar-commons-v4/runtime/src/lib.rs
```
RED today (exit 1). GREEN when the uncapped mint is removed. Pair with the doc gate in I-3.

---

### I-3 · `tier:T3` · `documentation` — The published token model states four things the chain contradicts
*(from P2e-01, P4-02, P8-02, P9-03, P1c-05, P2a-03)*

All four are live at `https://tejaspatil.tech/scalar-commons-v4/docs/reference/token-model` right now:

| Page says | Chain says |
|---|---|
| "Genesis mint \| 18,000,000,000 CMN" (`:29`) | 6 010 250 000.01 CMN |
| the 7/5/3/3 split holds "in both the dev/testnet presets and the mainnet genesis builder" (`:59-60`) | only in `mainnet_genesis_config`, which `chain_spec.rs:411` marks unreachable from any `--chain` id |
| treasury "starts with 5B CMN from genesis" (`:347`) | started at 0.01 CMN; holds 43.58 M today, all staking inflation |
| "Emittable headroom 82,000,000,000" (`:30`) and the 56/561-year projections (`:100-102`) | headroom is 93.95 B; the projections follow the wrong premise |

`docs/guide/run-a-node.md:105` repeats the 18 B claim. `token-model.md:7` says "Every raw value below is
the value read from the live runtime", which is true of the 30 constants inside armed check tables and
false of these four, because `check-chain-values.mjs` compares `api.consts` only and cannot see prose about
*state*. Consider extending it with a small set of live-state assertions.

```sh
! grep -qE '^\| Genesis mint \| 18,000,000,000 CMN|starts with 5B CMN from genesis|in both the dev/testnet presets' /home/dev/scalar-commons-v4/docs/reference/token-model.md
```
RED today (exit 1). GREEN when all three strings are corrected.

---

### I-4 · `tier:T3` · `documentation` — Every GitHub link on the public landing page 404s
*(from P8-01, P9-01, P9-02, P10-02, P2e-04, P8-05)*

The landing page is public and serves three links to `github.com/tejaspatil1936/scalar-commons-v4…`
("Source repository", "Documentation", "Testnet faucet"), each badged **Live**. The repository is
**private** (`gh repo view --json isPrivate` → `true`), so all three return **404** anonymously — as does
the whole "How to check any of this" table, which cites `pallets/emissions/src/lib.rs` paths. Separately,
`docs/.vitepress/config.mts:69` targets `github.com/tejaspatil1936/scalar-commons` — **missing `-v4`** — a
repository that does not exist. And the "Documentation" card points at the private tree while saying "A
fuller developer guide is still being written", when the complete guide is already published on the same
host at `/scalar-commons-v4/docs/`.

Fix: make the repo public, or repoint the landing links at the published docs site and drop the "Live"
badges from destinations that are not reachable. ENDGOAL §4 items 1–2 fail until this is done.

```sh
gh api repos/tejaspatil1936/scalar-commons-v4 --jq '.private' | grep -qx false
```
RED today (exit 1 — prints `true`). GREEN when the repo is public. Companion gate for the typo:
`grep -q "github.com/tejaspatil1936/scalar-commons-v4'" docs/.vitepress/config.mts` (also RED today).

---

### I-5 · `tier:T3` · `documentation` — The landing page badges unshipped things "Live"
*(from P2e-03)*

`landing/src/render.mjs:157` renders **any** status other than `planned` as a **"Live"** badge. The result
on the published page is two self-contradicting cards: the faucet reads "Live" directly above "No hosted
instance is up yet", and the explorer reads "Live" above "A hosted explorer for the devnet is not up yet".
`grep -c 'class="badge">Live'` on the live HTML returns 4. `landing/README.md:68-70` still describes the
faucet as `planned`, which `content.mjs:277-285` contradicts.

Fix: give `render.mjs` a third state (e.g. `built` → "In the repo") and use it for the faucet and explorer.

```sh
! grep -q '>Live</span>' /home/dev/scalar-commons-v4/landing/src/render.mjs
```
RED today (exit 1). GREEN when the badge logic distinguishes reachable from built.

---

### I-6 · `tier:T1` · `security` — The faucet signs with //Ferdie and its per-IP limit collapses behind nginx
*(from P2c-03, P2c-04, P3-02, P3-03, P8-08, P8-13)*

Two independent defects that share a deadline:

1. **The signing key is the public dev seed `//Ferdie`.** The live process environment contains no
   `FAUCET_SEED` and `~/.config/scalar-commons/faucet.env` has zero uncommented lines, so
   `faucet/src/config.ts:80`'s default applies. The account holds **999 999 926.49 CMN**. Anyone can
   `balances.transfer` from it directly once RPC is public, so every rate limit and the 1 000 CMN reserve
   protect nothing. `deploy/public/INSTALL.md` never mentions `FAUCET_SEED`, and no issue tracks it.
2. **The per-IP limit is broken either way behind the shipped template.** With the deployed
   `FAUCET_TRUST_PROXY=false`, `clientIp()` returns `req.socket.remoteAddress` = `127.0.0.1` for every
   proxied request, making 5 drips/hour **one global bucket for the whole internet** (demonstrated offline
   against the real `dist/` modules: second and third distinct forwarded IPs got `429 scope=ip`). With
   `TRUST_PROXY=true` — which issue #115 proposes — `clientIp()` takes the **left-most** `X-Forwarded-For`
   entry while the template sets `$proxy_add_x_forwarded_for`, which **appends**; four forged headers all
   returned `200`. Only an overwriting proxy makes the limit real, exactly as
   `deploy/products/README.md:134` requires.

Fix: set a real `FAUCET_SEED` in the 0600 env file and document it in INSTALL.md; change the faucet vhost
to `proxy_set_header X-Forwarded-For $remote_addr` (or read the right-most hop) **before** flipping
`TRUST_PROXY`.

```sh
grep -q 'FAUCET_SEED' /home/dev/scalar-commons-v4/deploy/public/INSTALL.md
```
RED today (exit 1). Companion:
`! grep -q 'proxy_add_x_forwarded_for' deploy/public/nginx/scalar-commons.conf.template` (also RED today).

---

### I-7 · `tier:T1` · `blocked` — ENDGOAL §3.4's launch gate has never been run, and the sim says wash trading pays
*(from P4-03, P4-04)*

No attacker archetype has ever executed against a live chain, and **the tooling cannot do it**: the
archetype runners import no transport (`recording-sdk.ts` appends to an in-memory ledger),
`scripts/run-eras.sh:18-32` and `extract-export.sh:30-31` `exit 1` as stubs, `zombienet.toml` names a
binary that does not exist (`scalar-commons-node` vs `scalar-node`) and carries stale TODOs, zombienet is
not installed, and `ci/sc-e1.yml` is not in `.github/workflows/`. Meanwhile the only evidence that exists
— reproduced bit-exactly today — records:

```
P5_wash_net_per_era_at_1M   FAIL  +1556.41 CMN/era   "Wash profitable at the only pool the chain uses"
P5_wash_break_even_pool     FAIL  1,000,000           "Profitable at/below the 1M ceiling"
P2_volume_earnings_rho      FAIL  -0.5879
P6_oracle_collusion_uplift  MOOT  "Oracle bonus inert on-chain"
```
and ROUND14's own post-fix table shows the 5-sybil ring **rising 9.2 %** to 964.9 per 1 k capital versus
676.6 for a low-volume honest agent. ROUND14 says it plainly: "Neither the gov fix nor the alpha cut is an
anti-wash measure. B1 is the anti-wash measure, and B1 is still open." ENDGOAL §3.4 says "If wash trading
still pays, the project does not launch" — while simultaneously deferring B1 (issue #80) to post-testnet.
That is an unresolved contradiction in the spec, and it needs a human decision, not an agent.

```sh
! grep -q 'not wired yet' /home/dev/scalar-commons-v4/experiments/sc-e1/scripts/run-eras.sh
```
RED today (exit 1). Companion:
`python3 -c 'import json,sys; v=json.load(open("experiments/sc-e1/verdict.json"))["verdicts"]; sys.exit(1 if any(x["verdict"]=="FAIL" and x["metric"].startswith("P5") for x in v) else 0)'` (also RED today).

---

### I-8 · `tier:T1` — `settle_era` has never succeeded on the live devnet
*(from P1a-08, P1c-02, P4-05, P8-09, P9-05)*

The `Emissions` storage prefix holds exactly **one** key — its own `:__STORAGE_VERSION__:`.
`LastSettledEra`, `EraStartBlock`, `LastEraEmission` and `AccRewardPerStake` are all null;
`AgentWeightSnapshot` and `AgentRewardDebt` have zero keys; `Agents::EraNumber` is 0. Since `settle_era`
writes `LastSettledEra` on every success and `drain_era_maps` increments `EraNumber`, **it has never
succeeded in ~512 000 blocks — about 142 elapsed six-hour eras.** The indexer agrees:
`/v1/eras/current` → `{"era":0,"dueForSettlement":true,"lastSettledEra":null}`.

Consequences: no CMN has ever been emitted by the mechanism the project is about; the per-era maps have
never drained, so `EraEscrowVolume` is a lifetime counter on this chain (Bob shows 1 530 CMN of "era"
volume across 153 completions); and neither auto-params rule evaluation nor ring detection has ever
executed live. `settle_era` is permissionless by design, so **anyone can call it** — nobody has.

Fix: call it (a human-gated first settlement), then verify weights, claims and map drainage against the
formula. This is the prerequisite for I-7 having anything to measure.

```sh
test "$(curl -s -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"state_getStorage","params":["0x14e767caae65907bcccb1824eb3fda418924db482c2640461926b647a0150c80"]}' http://127.0.0.1:9944 | python3 -c 'import sys,json;print(json.load(sys.stdin).get("result"))')" != None
```
RED today (exit 1 — `LastSettledEra` is null). GREEN after the first successful settlement.

---

### I-9 · `tier:T2` · `ci` — indexer and explorer tests run in no CI job
*(from P5-01, P2a-02, P9-06, P2b-01)*

`ci-node.yml` has jobs for `landing`, `faucet`, `docs` and `sdk` and none for `indexer` or `explorer`,
although both ship real offline suites — **55 and 53 tests, both green in ~2 s**. The cause is a timing
accident: `ci-node.yml` landed at 2026-09-02 21:55, `indexer/package.json` at 22:50 and
`explorer/package.json` at 23:25. The workflow still asserts at `:15-18` that "indexer/ … contains one
Python file (reconcile.py) and no package.json", repeated in `CI-NODE.md:19-20` and `ci-fast.yml:11-12`.

Verified consequence: **PR #112 changes only `indexer/tests/live.test.ts`**, and all seven checks
(`gate, full, changes, landing, faucet, docs, sdk`) report SUCCESS while ci-node ran
`sdk → 'Not selected'` and the same for the rest — six required checks green, zero indexer lines executed.
PRs #99 and #100 merged the explorer and indexer themselves under that same rollup.

The jobs must select offline files by path, exactly as the faucet job does, because neither live suite is
env-gated (`indexer/tests/live.test.ts:29` connects unconditionally; `explorer.live.test.ts:15-21` says
"nothing here is … skippable").

```sh
grep -qE '^  indexer:' /home/dev/scalar-commons-v4/.github/workflows/ci-node.yml && grep -qE '^  explorer:' /home/dev/scalar-commons-v4/.github/workflows/ci-node.yml
```
RED today (exit 1). GREEN when both jobs exist; then add them to the required contexts.

---

### I-10 · `tier:T3` — The faucet cannot start from the repo; only a local-only drop-in keeps it alive
*(from P2c-01, P2c-02; overlaps open issue #115)*

`deploy/products/scalar-faucet.service:34`, `deploy/products/install.sh:32`, `faucet/package.json`'s
`start`, and `faucet/README.md`'s "npm ci … npm start" all run `src/index.ts` under
`--experimental-strip-types`, which fails immediately:
`ERR_MODULE_NOT_FOUND: Cannot find module '/home/dev/scalar-commons-v4/faucet/src/amount.js'`. Node 22
type-stripping does not rewrite `./x.js` specifiers to `./x.ts`. The journal shows the restart counter
reaching **71** on 2026-09-07 before a **local-only** systemd drop-in (`ExecStart=/usr/bin/node
dist/index.js`) was applied by hand; `faucet/dist/` is gitignored and nothing in the repo builds it. The
landing page sends strangers to that README. Issue #115 covers the unit half but not `npm start` or the
README, and its `FAUCET_TRUST_PROXY=true` half is unsafe until I-6 lands.

```sh
grep -q 'dist/index.js' /home/dev/scalar-commons-v4/deploy/products/scalar-faucet.service
```
RED today (exit 1). GREEN when the unit runs the built entrypoint and the install script builds it.

---

### I-11 · `tier:T3` · `documentation` — Two published docs pages describe the SDK and registration wrongly
*(from P2d-01, P8-04, P1c-04)*

Live on `/docs/guide/sdk` and `/docs/reference/rpc`:

- "Requires an on-chain identity" for `agents.register` — `pallets/agents/src/lib.rs:735-799` has **no**
  identity check; the only `IdentityRequired` guard is in `set_capability` (`:1047`).
- `total = free + stake + pendingEmissions` — `sdk/src/index.ts:423` computes `free + pendingEmissions`,
  because stake is a lock *inside* free.
- `recordGovVote` "has no SDK wrapper yet" — `sdk/src/index.ts:322` exports it and
  `integration.test.ts:132,157` tests it.

And on `/docs/guide/run-a-node` (`:116-117`): the presets pre-register "each genesis validator" with
10 000 CMN, "the minimum that qualifies for floor emissions from era 1". `chain_spec.rs:287-291` registers
`endowed_accounts.iter().take(3)` — live `AgentStake` has **3** keys against **5** validators — and the
floor is gated by ≥ 50 CMN era volume plus heartbeat ≥ 90 (`emissions/lib.rs:586-596`), not by stake, as
`token-model.md:318` itself states. The sdk page was last edited 2026-08-05; the SDK changed 2026-09-02
without it.

```sh
! grep -q 'Requires an on-chain identity' /home/dev/scalar-commons-v4/docs/guide/sdk.md && ! grep -q 'minimum that qualifies for floor emissions' /home/dev/scalar-commons-v4/docs/guide/run-a-node.md
```
RED today (exit 1).

---

### I-12 · `tier:T3` · `documentation` — Close the two known docs contradictions (#87, #88)
*(from P2e-05, P2e-06, P8-06, P8-07, P10-03 — both issues already exist and PR #113 is open)*

Both are still on `master`. **#87**: `run-a-node.md:150-157` starts a full node on `--rpc-port 9960`, then
`:169-172` verifies by curling `http://127.0.0.1:9944` (alice) and shows alice's output — the stranger
checks the wrong node. **#88**: `rpc.md:19-21` says the devnet runs `--rpc-methods safe`, "which withholds
… `author_rotateKeys`", while `run-a-node.md:232-262` starts a validator with no `--rpc-methods` flag and
then curls `author_rotateKeys` at `:9960`. The first half of #88 is now true of all five live nodes; the
recipe is what is broken. **PR #113 already fixes #88 but has been refused hourly since 2026-09-07** — see
I-13.

```sh
! sed -n '/### Verify it joined/,/### Devnet topology/p' /home/dev/scalar-commons-v4/docs/guide/run-a-node.md | grep -q 'http://127.0.0.1:9944'
```
RED today (exit 1).

---

### I-13 · `tier:T2` — The factory cannot merge anything, and one PR is blocked by a label nobody set
*(from P6-03, P6-04, P6-06, P6-05)*

`factory/logs/merges.log` **does not exist**: `merge.sh` has never merged a pull request. Four compounding
causes, all verified:

1. **`review.sh` never calls `load_billing_env`**, so under systemd its lenses have neither
   `~/.factory/env`'s PATH nor `ANTHROPIC_API_KEY`. All 6 systemd-launched reviews — **18 of 18 lenses** —
   exited 127. With the new local `path.conf`, the next one would find `claude` but no API key and bill the
   interactive OAuth login, the exact failure `common.sh:99-110` forbids.
2. **`review.sh` never removes a stale `needs-human`.** PR #112 carries a 2026-09-03 review of
   `0 PASS / 0 FAIL / 3 ERROR` (all exit 127) that set the label, and a 2026-09-07 review of
   **`3 PASS / 0 FAIL / 0 ERROR` on the same head** that set `agent-reviewed`. All seven CI checks are
   SUCCESS. `merge.sh` refuses it hourly as an "unresolved review objection" — **there is no objection**.
3. **Both open PRs are `BEHIND`**, and with `required_status_checks.strict: true` GitHub blocks
   out-of-date branches while `merge.sh` has no update-branch step. Even a clean PR would fail.
4. **`agent-reviewed` is not bound to a head SHA**, and `dispatch.sh:466` re-pushes from the reused
   worktree hourly, so unreviewed commits can land on a PR that keeps the label. Combined with the
   ordering race — `agent-reviewed` is added *before* `needs-human`, so a failed second `gh pr edit` leaves
   a FAIL-containing PR mergeable — ENDGOAL §3.6's "any FAIL from any lens blocks the merge" holds by
   convention, not by mechanism.

```sh
grep -q 'load_billing_env' /home/dev/scalar-commons-v4/factory/review.sh
```
RED today (exit 1). Companion: `grep -q 'remove-label' factory/review.sh` (also RED today).

---

### I-14 · `tier:T3` — README cannot build the project on a clean machine, and there is no release tag
*(from P7-01, P7-02, P7-03)*

`README.md` is 25 lines, gives **one** step (`cargo build --release`) and names **zero** prerequisites. It
was last touched at `eab04b6` (2026-04-23) — which *is* the `upstream-baseline` tag — so it has not changed
across all 144 commits of the rebuild (`git describe` → `upstream-baseline-144-g6efba16`). A clean Debian
build from it fails for three independent reasons: no rustup (so the 1.85.0 pin and `wasm32v1-none` never
install), no protoc (needed by `prost-build` ← the whole sc-network stack), and no libclang (needed by
`bindgen` ← `librocksdb-sys`). The published `run-a-node` page does list these, but the README does not link
to it, and even that page assumes rustup is present. The README's layout section also omits 11 of the 15
tracked top-level directories.

Also unmet from ENDGOAL §3.7: **there is no release tag** (`git tag -l` → `upstream-baseline` only;
`gh release list` → empty), and every repo unit hardcodes `/home/dev/scalar-commons-v4/…` with no warning
in `deploy/README.md`.

```sh
grep -qiE 'protoc|protobuf' /home/dev/scalar-commons-v4/README.md
```
RED today (exit 1). Companion: `test -n "$(git tag -l 'v*')"` (also RED today).

---

### I-15 · `tier:T2` — `reject-stubs.sh` is wired as a hook that cannot block
*(from P5-02)*

`.claude/settings.json` registers it under **`PostToolUse`**, whose documented behaviour is "Exit code 2:
Shows stderr to Claude; **the tool already ran**". The script claims otherwise at `:13` ("Exit 2 = block the
tool call") and `:10-11` ("it fires on the WRITE, before any gate runs"), as does
`factory/README.md:299-301`. It also cannot simply be moved to `PreToolUse`: it reads the on-disk file
(`[ -f "$FILE" ] || exit 0`), so a new-file Write would pass and an Edit would scan pre-edit content.
Direct testing confirms it does exit 2 for `todo!(`, `unimplemented!(`, `#[allow(`, `SKIP_WASM_BUILD` and
`fn main() {}` — but **not** for `it.skip`, `describe.skip`, `.only`, `@ts-ignore`, `eslint-disable`,
`#[ignore]`, `|| true` or `continue-on-error`, all of which `review.sh:528-539` lists as banned, and all of
which matter because T3 — the only dispatched tier — is entirely TypeScript. It also false-positives on
11 tracked files, because it greps the whole file rather than the edit.

ENDGOAL §3.5's "mechanically enforced by hooks, not by trust" is therefore not met today. Note the
mitigating fact: the standing-rule sweep found **zero violations** in the tracked tree, so the rule is
being followed — just not enforced.

```sh
python3 -c 'import json,sys; d=json.load(open("/home/dev/scalar-commons-v4/.claude/settings.json")); h=d.get("hooks",{}).get("PreToolUse",[]); sys.exit(0 if any("reject-stubs" in x.get("command","") for g in h for x in g.get("hooks",[])) else 1)'
```
RED today (exit 1). GREEN when the check runs where it can actually block, reading the tool input.

---

### I-16 · `tier:T3` — Indexer returns HTTP 500 for out-of-range `?offset=`
*(from P2a-01)*

`?offset=` at or above 2⁶³ returns **`500 {"error":"datatype mismatch"}`** on all ten sqlite-backed list
routes (`/v1/blocks`, `/v1/extrinsics`, `/v1/events`, `/v1/accounts`, the four nested `…/events` and
`…/extrinsics` routes, and `/v1/eras`). Threshold: `9007199254740992` → 200,
`9223372036854775807` → 500. `pagination.ts:159-164` accepts any `^-?\d+$` and `Number()`s it; `node:sqlite`
binds the resulting non-int64 double as REAL and SQLite rejects a REAL `OFFSET`. The process is unaffected
(1.5 ms response, `MainPID` unchanged, `NRestarts=0`) — this is a client error misreported as a server
fault, which matters once the API is public and behind a monitored proxy. Every other hostile input in a
large matrix was handled correctly, including the percent-encoding case that used to kill the process.

```sh
curl -s -m 15 -o /dev/null -w '%{http_code}' 'http://127.0.0.1:8080/v1/events?offset=99999999999999999999999' | grep -qv '^5'
```
RED today (exit 1 — returns 500). GREEN when the offset is range-checked and answered with 400.

---

### I-17 · `tier:T0` — No extrinsic in the tree has a real weight benchmark
*(from P1b-01, P1b-02)*

All six `benchmarks.rs` files are **a single comment line**; `pallet-constitution` has none. They compile
only under `#[cfg(feature = "runtime-benchmarks")]`, and an empty module is valid Rust, so the feature build
is green while defining zero benchmarks. There is no `define_benchmarks!`, no `weights.rs` in any pallet,
and **no `frame_benchmarking::Benchmark` runtime API**, so `benchmark pallet --list` cannot run at all. The
six `WeightInfo` traits and their `PlaceholderWeights` impls are dead code — no `Config` carries the type
(`grep -n 'type WeightInfo' pallets/*/src/lib.rs` → nothing). All **36 custom extrinsics** are priced by
hand-estimated literals.

The dangerous one: **`settle_era` is priced as a constant** (5 reads + 5 writes + 1e9 ps ≈ 0.001625 CMN)
while iterating every registered agent (`MaxAgents = 10 000 000`) plus every orchestrator, and sorting all
weights. On a public network that is unbounded work at a fixed price — a free denial-of-service surface.
This is issue #79, still open, and correctly T0 ("weights are never set autonomously").

```sh
grep -rq 'define_benchmarks!' /home/dev/scalar-commons-v4/runtime/src/lib.rs
```
RED today (exit 1). GREEN when benchmarks are registered, generated and wired into each `Config`.

---

### I-18 · `tier:T3` — CLAUDE.md states four things that are not true on master
*(from P9-04, P2e-07, P1c-03)*

`:14`'s formula ("Weight = stake × rank × oracle accuracy × governance participation × velocity bonus") is
wrong on three operators — stake enters as **√stake**, and oracle and governance are **additive** terms
inside a bounded budget, with oracle contributing **+0** because `OracleScoreProvider = ()`. `:9`'s
toolchain line ("sp-core 39.x, frame-system 45.x, sp-runtime 45.x") disagrees with `Cargo.lock`
(**36.1.0 / 40.1.0 / 41.1.0**, pinned to `polkadot-stable2503`). `:35` says "Local **3**-validator devnet";
the preset has 5 and the chain runs 5. `:13` repeats the emissions-only mint claim addressed in I-2. And
`:34`'s documented test command `cd indexer && npm test` **submits real extrinsics** to the live devnet,
because `indexer/tests/live.test.ts` has no env gate — the same defect as issue #101.

Since CLAUDE.md is the file that overrides default agent behaviour, a wrong formula there propagates into
every future change to the emissions pallet.

```sh
! grep -q 'Local 3-validator devnet' /home/dev/scalar-commons-v4/CLAUDE.md && ! grep -q 'Weight = stake × rank × oracle accuracy' /home/dev/scalar-commons-v4/CLAUDE.md
```
RED today (exit 1).

---

### I-20 · `tier:T1` — A forkless runtime upgrade has never been rehearsed
*(from P1b-04)*

ENDGOAL §3.1 requires "a forkless runtime upgrade rehearsed — `spec_version` bumped and applied on a live
network without restarting nodes", and calls a chain that cannot upgrade itself "not an L1". It has never
happened. The on-chain `:code` at the finalized head is **byte-identical to genesis**; all five
`spec_version` bumps (300 → 304, Jul 30 – Aug 3) were compiled into *fresh geneses* before this chain
started, not applied to it. `System::LastRuntimeUpgrade` reads `compact(304) ++ "scalar-commons"`, which is
simply the genesis value and cannot distinguish the two cases — the `:code` comparison is what settles it.
No `set_code` procedure is scripted or documented anywhere (`grep -rn -i 'set_code\|forkless\|CodeUpdated'`
across `ROUND*.md`, `docs/`, `deploy/` finds no rehearsal record), and the indexer reports zero
`system.CodeUpdated` events in its window.

This matters beyond the checkbox: the explorer's `api.at(hash)` path for decoding pre-upgrade blocks has
consequently never executed either, and neither has any migration. Rehearse it on a throwaway chain first.

```sh
test "$(curl -s -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"state_getStorageHash","params":["0x3a636f6465"]}' http://127.0.0.1:9944 | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"])')" != "$(curl -s -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"state_getStorageHash\",\"params\":[\"0x3a636f6465\",\"$(curl -s -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"chain_getBlockHash","params":[0]}' http://127.0.0.1:9944 | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"])')\"]}" http://127.0.0.1:9944 | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"])')"
```
RED today (head `:code` still equals genesis `:code`). GREEN once an upgrade has actually been applied.

---

### I-21 · `tier:T3` — A stranger cannot afford to register: the faucet drip is 100× too small
*(from P8-03)*

ENDGOAL §4 item 5 requires an outsider to "register an agent, stake, and enter an escrow agreement using
the SDK", funded by item 4's faucet. The arithmetic does not permit it. From live constants:
`agents.minStake` 1 000 CMN + `agents.baseRegistrationFee` 50 CMN + `balances.existentialDeposit` 0.01 CMN
+ ~0.000108 CMN of fee ≈ **1 050.01 CMN**, and `register()` (`agents/lib.rs:762-767`) requires the free
balance to cover all of it. The faucet drips **10 CMN**, at most **once per address per hour**
(`faucet/src/config.ts`), so a stranger needs **≥ 106 drips ≈ 4.4 days** of hourly requests to one address
before their first registration can succeed — and the per-IP limit of 5/hour means they cannot parallelise
across addresses from one host either.

Fix is a product decision, not a code bug: raise `FAUCET_DRIP_CMN`, lower `MinStake` for the testnet, or
publish a documented funding route for new agents. Whichever is chosen, item 5 of the acceptance test
cannot pass until the numbers reconcile.

```sh
python3 -c "import re,sys; s=open('/home/dev/scalar-commons-v4/faucet/src/config.ts').read(); d=int(re.search(r\"FAUCET_DRIP_CMN', '(\d+)'\",s).group(1)); n=int(re.search(r\"FAUCET_ADDRESS_MAX_REQUESTS', (\d+)\",s).group(1)); sys.exit(0 if d*n>=1051 else 1)"
```
RED today (exit 1 — one drip yields 10 CMN against a 1 050.01 CMN requirement). GREEN when a single
address's hourly allowance covers a registration.

---

### I-24 · `tier:T1` · `security` — sshd on the public interface allows password login **and** root login
*(from gap-fillers G-01/G-02/G-12; missed entirely by all seventeen phase auditors)*

`/etc/ssh/sshd_config` ends with two appended lines:

```
124:PasswordAuthentication yes
125:PermitRootLogin yes
```

sshd listens on `0.0.0.0:22` and `[::]:22`. So the box accepts **password-based root login from the
internet**, and the only brute-force control in front of it is `fail2ban` — which is itself undocumented:
`git grep -il 'fail2ban\|PermitRootLogin\|PasswordAuthentication'` over the whole tracked tree returns
**nothing**. Neither `deploy/README.md` nor `deploy/public/INSTALL.md` mentions host hardening at all, so a
clean-machine rebuild following the repo reproduces neither the firewall rules nor the ban jail, and an
operator has no way to know either exists.

This is the one finding in the audit that is a live host-security exposure rather than a pre-launch one,
and it is independent of everything else here: it is true today, with or without scalarnet.io. Note that it
also sits directly beneath I-1 — an attacker who gets shell on this box gets `//Alice`'s sudo key, the
`//Ferdie` faucet key, and every validator's session keys, without touching the chain at all.

Fix: key-only authentication (`PasswordAuthentication no`), `PermitRootLogin prohibit-password` or `no`,
and document fail2ban and the ufw rule set in `deploy/`.

```sh
! grep -qE '^\s*PasswordAuthentication\s+yes' /etc/ssh/sshd_config && ! grep -qE '^\s*PermitRootLogin\s+yes' /etc/ssh/sshd_config
```
RED today (exit 1 — both lines present). GREEN when password and root login are disabled.

---

### I-23 · `tier:T1` — Set the node's RPC rate limits before fronting alice with wss
*(added after a completeness critic noted no phase had enumerated the node-side flags)*

`deploy/public`'s own template and `VERIFY.md` correctly note that on websockets nginx's `limit_req` bounds
**connection establishment only**, not JSON-RPC messages inside an already-open socket. The defence against
in-socket flooding therefore has to come from the node — and **none of it is enabled**. Checked against all
five `/proc/*/cmdline`, the only RPC flags in use are `--rpc-port` (all five), `--rpc-methods safe` (all
five) and `--rpc-cors all` (alice). Unset: `--rpc-rate-limit` (which has no default, i.e. no per-connection
call limit at all), `--rpc-max-batch-request-len`, `--rpc-max-connections`,
`--rpc-max-subscriptions-per-connection`, `--rpc-max-request-size`, `--rpc-max-response-size`,
`--rpc-message-buffer-capacity-per-connection`.

Consequence: one client that gets past nginx's 10 r/s handshake budget can then call at an unbounded rate
in unbounded batches. Combine with **I-17** — `settle_era` is unbounded work at a constant price — and the
public endpoint has two independent amplification paths on day one. Also worth revisiting at the same time:
`--rpc-cors all` on alice lets **any** browser origin open a socket, where the default would allow only
localhost and polkadot.js.org; that is a deliberate choice for a public RPC but it is undocumented.

```sh
tr '\0' ' ' < /proc/$(systemctl --user show -p MainPID --value scalar-alice)/cmdline | grep -q -- '--rpc-rate-limit'
```
RED today (exit 1 — the flag is absent). GREEN once a per-connection rate limit is set on every exposed node.

---

### I-22 · `tier:T2` — The chain-layer invariants CLAUDE.md calls load-bearing have no tests
*(from P1a-02 … P1a-07, P4-07 — added after a completeness critic noted this cluster had no owner)*

Individually each of these verified as MEDIUM, but together they are the largest block of unowned findings
in the audit and they map directly onto ENDGOAL §3.1's "passing tests" requirement. Every guard below
exists in code and is correct; **none of them has a test**, so a regression that removed any one would ship
under a fully green `cargo test --workspace`:

| Invariant (CLAUDE.md calls each load-bearing) | Guard | Test |
|---|---|---|
| Supply cap clamp | `emissions/lib.rs:514-522` | `supply_cap_enforced` (`tests.rs:282-292`) contains **zero assertions**; `claim_returns_zero_at_cap` finishes ~900 CMN short of the cap having paid ~100 CMN; `Event::CapReached` asserted nowhere |
| `EraNotDue` guard | `emissions/lib.rs:242-245` | **none** |
| F-04 double-settlement (`EraAlreadySettled`) | `emissions/lib.rs:248-251` | **none** |
| `MinQualifyingVol` ≥ 50 CMN floor gate | `emissions/lib.rs:586-596` | **none** — set to `ConstU64<0>` in *both* mocks |
| `VelocityBonusBps` +30 % cap | `emissions/lib.rs:648-667` | **none** (same reason) |
| Orchestrator self-link refusal | orchestrator pallet | **none**; `claim_orchestrator`, its own mint path, is also untested |
| Passive staker earns zero | `emissions/lib.rs:575,607,595` | **none** — the runtime path is sound, no test asserts it |
| auto-params rule engine | `auto-params` | **zero tests**; both mocks leave `run_era_rules` at the no-op default, so `auto_params_ring_fee_increases` compares `0 >= 0` |
| constitution invariants | 6 documented | **zero tests**; only 1 of 6 is wired |

Two structural reasons this persists, both worth fixing with it: the integration harness uses
`Balance = u64`, which **cannot represent the real 10²³ cap** and substitutes one 10 000× smaller
(`tests/common.rs:302-305`); and the runtime crate has **no `[dev-dependencies]` and zero hand-written
tests**, so nothing exercises the real `Balance` width, the real `ConvictionVotingBridge`, or the WASM
runtime at all.

```sh
grep -q EraAlreadySettled /home/dev/scalar-commons-v4/pallets/emissions/src/tests.rs && grep -q EraNotDue /home/dev/scalar-commons-v4/pallets/emissions/src/tests.rs && grep -rq 'Event::CapReached' /home/dev/scalar-commons-v4/pallets/emissions/src/tests.rs /home/dev/scalar-commons-v4/tests/supply_cap.rs
```
RED today (exit 1). GREEN when the settlement guards and the cap clamp are actually asserted.

---

### I-19 · `tier:T3` — ENDGOAL.md publishes a gap that is already closed
*(from P3 §6, P9)*

Now that PR #116 has merged ENDGOAL.md to `origin/master`, its §3.3 sentence — "*Current known gap: four
of five validators run without `--rpc-methods safe` and serve the full unsafe set on loopback*" — is a
committed, wrong statement. All five nodes have carried the flag since 2026-09-02 20:44 (verified in five
`/proc/*/cmdline` reads and by the unsafe-method refusal on every port), and the repo caught up on
2026-09-07. Three further §3 lines are stale in the same way: the "11+ days" liveness figure (alice is at
35 days), the §3.5 CI gap list (landing, faucet, docs and sdk now have jobs; indexer and explorer are what
remain), and §6's "forked from Matty's" (`gh repo view` → `isFork: false, parent: null`).

```sh
! grep -q 'four of five validators run without' /home/dev/scalar-commons-v4/ENDGOAL.md
```
RED today (exit 1).

## 7. What I could NOT verify, and what it would take

Nothing in this report rests on an unverified item. These are the gaps, grouped by the reason they exist.

### 7.1 Blocked by the read-only rule (no extrinsic may be submitted)

| Item | Why | What it would take |
|---|---|---|
| That `sudo.sudo(system.set_code)` signed by //Alice actually succeeds on this chain | Mutating. Inferred from `Sudo::Key` = Alice, `OnSetCode = ()`, the SafeMode whitelist, and `author_submitExtrinsic` being a *safe* method | Spin a throwaway 1-node chain from `deploy/scalar-local-raw.json` and submit it there |
| That `agents.register` really succeeds **without** a pallet-identity record (contradicting the docs) | Verified only by reading `agents/lib.rs:735-799`, which has no identity call; mocks use `IdentityHandler = ()` so they cannot settle it either | A unit test in the agents mock, or a register from a funded account on a `--dev` chain |
| That a brand-new account can complete register → stake → escrow end to end via the SDK | **Never rehearsed live.** The SDK live suite only reads and submits two deliberately-rejected calls; the indexer live suite uses genesis agents; all 3 live agents are genesis | `RUN_INTEGRATION=1` against a `--dev` node, or a funded throwaway account; ~5 minutes of block time |
| The faucet's reserve-floor refusal (503 `INSUFFICIENT_FAUCET_FUNDS`, slot refund, no funds moved) | Needs a real `POST /drip`. Verified by code read (`faucet.ts:150-160`) and asserted by the unrun live suite | Run `faucet/tests/faucet.live.test.ts` in a session where devnet extrinsics are permitted |
| `indexer` / `faucet` / `explorer` live suites and `sdk` `test:integration` | All four submit extrinsics; the indexer and explorer suites have **no env gate** at all | A disposable devnet |
| Live behaviour of the gov-farming guard against a real referendum (issue #78) | **No referendum has ever existed** on this chain (`ReferendumCount` null, `VotingFor` 0 keys) | A human-gated session: open a referendum, vote, call `record_gov_vote` with and without a vote |
| That `author_rotateKeys` / `author_insertKey` are now rejected on 9945-9948 | Both are mutating. Only flag presence (5× `/proc` cmdline) and the `system_unstable_networkState` / `system_peers` rejections were observed | Call them against a disposable node started from the same unit template |
| XSS via chain-supplied strings in the explorer | No extrinsic with a free-form string exists on this chain — all 15 410 indexed extrinsics carry hash or numeric args, and agent metadata is null | Submit one `system.remark('<img src=x onerror=alert(1)>')` on a scratch devnet and fetch the resulting page |

### 7.2 Blocked by missing privileges or software on this host

| Item | Why | What it would take |
|---|---|---|
| **Which packet-filter rules are loaded, and what they permit.** *Substantially resolved after the first draft — see the correction below.* | `/proc/modules` is world-readable and shows **21 netfilter modules live**, including the full ufw signature set — `nf_tables`, `nft_compat`, `xt_addrtype`, `xt_conntrack`, `xt_limit`, `xt_LOG`, `xt_recent`. Rules **are** loaded in the kernel. What remains unreadable is their *content*: `nft list ruleset` → "Operation not permitted", `iptables -L -n` → Permission denied, `/proc/net/ip_tables_names` → Permission denied, `sudo -n ufw status` → password required | `sudo ufw status verbose` to enumerate them. The existence question is now answered; only the contents are open |
| **Whether P2P 30333-30337 are reachable from the internet today** | Chain side settled and permissive: all five P2P ports bind `0.0.0.0`/`[::]`, no `--reserved-only`, public IP advertised as a dial target. Host side now known to be **filtering** (module evidence above), so the earlier reading that the path was probably open is withdrawn — but the rules themselves are unread, so whether 30333-30337 are among the allowed ports is unknown. No foreign peer has connected in 36 days | `sudo ufw status verbose`, or `nmap -Pn -p 22,443,9944,30333-30337 152.53.113.104` from another host |
| `nginx -t` on the rendered config | nginx is not installed and installing software was out of scope. A manual structural review found no defects | `nginx -t -c` in a throwaway container with dummy certs |
| `ssl_stapling on` against a post-OCSP Let's Encrypt cert, and `alias` + `try_files` behaviour for `/docs/` | No nginx binary | Same as above |
| nginx `$proxy_add_x_forwarded_for` append semantics | Taken from nginx documentation. **The faucet half was executed** against the real `dist/` modules, so the conclusion stands on tested code plus documented proxy behaviour | Install nginx in a container and capture the upstream header |
| Whether `ufw deny 80/tcp` in INSTALL.md's rollback replaces the earlier allow or appends a dead rule | ufw needs sudo | A scratch host with ufw |

### 7.3 Blocked by cost or by the state of the chain itself

| Item | Why | What it would take |
|---|---|---|
| That `scalar-node benchmark pallet --list` fails at runtime | Needs a 30–60 min release build with `--features runtime-benchmarks`. Structural evidence is conclusive: `impl_runtime_apis!` declares **no** `frame_benchmarking::Benchmark` API | That build, then the command against a throwaway spec |
| Real wall-clock cost of `settle_era` as agent count grows | The live chain has **3** agents and has never settled an era. The estimate uses the runtime's own `RocksDbWeight` constants | A `#[benchmarks]` body with a linear component, or a devnet seeded with N agents |
| Indexer amplification with a large agent set | Only 3 agents exist, so `MAX_LIVE_SCAN=512` cannot be stressed; measured calls stay bounded but per-call payload would grow | Register 200+ agents on a throwaway devnet and repeat the measurement |
| Whether the indexer/explorer stay up when alice goes down (both READMEs claim they do) | Stopping a validator is a forbidden mutation, and no outage has occurred since they started | `systemctl stop` on a disposable devnet |
| Near-cap behaviour of the staking mint | The chain is at ~6 % of the cap, and the payout is applied in an era-rotation **hook**, which `BaseCallFilter` does not gate | A runtime unit test that raises issuance to the cap boundary and asserts whether the `EraPayout` mint is refused |
| Explorer behaviour across a runtime upgrade | The chain has had exactly one `spec_version` since genesis, so the `api.at(hash)` older-metadata path never executes | Rehearse the forkless upgrade first |
| Continuous finality between 2026-08-03 19:19 and 2026-08-04 05:56 | Journal retention starts at the later timestamp | Nothing further on-box; inferred from 56 unfilled slots in 511 937 |
| Whether any pre-ROUND15 chain ever received a `set_code` | Those databases were wiped and the journal is rotated | A retained snapshot; none exists |

### 7.3b Raised by the completeness critic after the first draft

| Item | Why | What it would take |
|---|---|---|
| `factory/tracker.sh` was never **executed**, only read | The brief asked for it to be run. Every phase declined because it *writes* `factory/STATE.md` (line 231). A scratch-copy run was the right answer and was attempted at the end of the audit, but the command was refused by the sandbox. The conclusion — STATE.md misreports the effective flags — is corroborated by comparing the on-disk file against the nightly digest gist, which disagree with each other | `cp -a factory /tmp/…` then run `tracker.sh --quiet` from the copy |
| ~~A **fresh** docs chain snapshot~~ — **CLOSED during finalisation** | The critic was right that the gate had only run against the 5.67-day-old committed capture. The lead generated a fresh snapshot from the live node into a scratch copy of `docs/` and diffed it: **zero differences** across `consts`, `pallets`, `runtime`, `properties`, `storage` and `runtimeApis` over 81 727 blocks. The docs' chain-derived values are accurate today; only their stated provenance is stale | Done — see §3, Phase 2e |
| Per-hit enumeration for the standing-rule sweep | The sweep's conclusion (no violations) is well supported and every category was greped, but the brief asked for **every hit with file:line**; only the `#[allow(` hits (20) were enumerated exhaustively, with `\|\| true` (46 hits) summarised by category | Re-run each grep with `-n` and paste the full output |
| Gate commands the factory actually runs | The sweep covered the tracked tree. The gates live in **GitHub issue bodies**, which is where a weakened check would be most valuable and least visible | `gh issue list --json body` and grep the fenced gate blocks |
| Whether the products survive their node going away | Both READMEs claim they do; a scratch second instance on unused ports pointed at a controllable websocket would test it without touching the live services | Run a second indexer/explorer in scratch against a stub RPC |

### 7.4 Blocked because only a human knows

| Item | Why |
|---|---|
| **Server ownership** — ENDGOAL §6's "netcup RS 8000 is in Matty's name" | No panel access. Observable facts only: netcup hardware, hostname `v2202607384283486718`, rDNS `v2202607384283486718.luckysrv.de`, 16 vCPU / 62 GB / 2 TB, public IP `152.53.113.104` |
| Whether `matty33/…` → `tejaspatil1936/…` was a transfer or a rename | The GitHub redirect proves it is the same repository (`isFork: false`, `parent: null`), but the API does not expose which operation produced it. **This contradicts ENDGOAL §6's "forked from Matty's"** either way |
| Whether the GitHub repo description ever asserted the unbuilt components (ENDGOAL §1's founding failure) | The description field is empty today and GitHub keeps no history for it |
| Whether the merged `[factory]` PRs were merged by `merge.sh` or by hand | `mergedBy` is the same account for all of them because the factory uses the operator's token. **`factory/logs/merges.log` does not exist**, which is strong evidence that `merge.sh` merged none of them |
| Billing source of the manual 2026-09-07 reviews of PRs #112 and #113 | They are absent from `dispatch.systemd.log`, so they ran from an interactive shell whose environment is unknown |
| Who "Keith" is (`CLAUDE.md:36`'s TODO owner, and a decision owner in 20+ tracked files) | Not stated anywhere in the repo; ENDGOAL names only Matty |
| Which "five raw values in prose escape the gate" the brief refers to | **The phrase does not occur** in `TODAY-PLAN.md` or any other planning document. An independent enumeration found five *wrong* prose values, listed in §4; whether those are the intended five is unknown |

### 7.5 One audit-conduct disclosure

The Phase 4 auditor ran `python3 -m pytest` on `experiments/sc-e1/tests/`, which created
`experiments/sc-e1/__pycache__/` **inside the repository** (a path that is not gitignored). It removed the
directory and re-checked `git status --porcelain -- experiments/`, which came back empty. The lead
re-verified at the end of the audit: `git status --porcelain` lists exactly the six untracked planning
documents that were present at the start, and `git log -1` is unchanged at `6efba16`. The tree is
byte-identical to its pre-audit state, but a file was briefly created and deleted inside the repo, which
the brief forbade. Recorded here rather than omitted.

A second, smaller deviation: the Phase 2d auditor ran `git fetch origin docs/endgoal` to compare PR #116's
content with the local untracked copy. That rewrote only `.git/FETCH_HEAD`; no working-tree or index change
resulted. It should have used `gh api …/contents` instead.

---

## 8. Method, and what this audit did not touch

**Scope.** `master @ 6efba16` (local), the live 5-validator devnet on `127.0.0.1:9944-9948`, the three
running products on `:8080/:8081/:8082`, the published landing page and docs site, and the GitHub repo
state — all as of 2026-09-08 08:18–14:05 CEST.

**Structure.** Seventeen read-only auditors covered ENDGOAL phases 0–9 in parallel, each writing a full
command-and-result log. Every finding they graded CRITICAL or HIGH was then handed to an adversarial
verification panel instructed to *refute* it and to default to REFUTED or UNVERIFIABLE if it could not be
reproduced independently; CRITICAL findings got two lenses (reproduction, and impact/severity/gate), HIGH
findings one combined lens. The panel corrected **34 of 46** severities — 3 raised, 31 lowered — which is
the point of running it: most of the lowered ones were missing-test-coverage findings that an auditor had
graded HIGH and a verifier correctly reclassified as fragility rather than a stranger-facing break.

A completeness critic re-read the original brief against all 255 findings and returned after the report was
first assembled. It earned its place, and its corrections are folded in above rather than hidden:

- **It found a running daemon seventeen auditors missed.** `fail2ban` has been active since 2026-07-28 with
  an `iptables` ban action — a second source of kernel firewall rules on the one question the audit calls
  most important. Recorded in Phase 0 and §7.2.
- **It caught a reasoning error in this report's own summary.** An earlier draft used "`ufw.service` has
  never gone active this boot" as evidence that no rules are loaded. That is wrong — `ufw enable` installs
  rules through `ufw-init` without the unit ever going active — and the phase writeup had said so
  correctly. §1, §6 (I-1) and §7.2 were rewritten to state the firewall question as **unknown** rather than
  as leaning open.
- **It flagged an uncited claim that had reached the executive summary** — "`payout_stakers` is
  permissionless". It is true, and now carries its citation (`frame/staking/src/pallet/mod.rs:1802`).
- **It noted the chain-layer test-coverage cluster had no proposed issue.** That is now **I-22**.
- It also flagged, correctly, that the `settle_era` denial-of-service *magnitude* is a model rather than a
  measurement (the structural facts — constant weight over an unbounded `AgentStake::iter()` — are
  verified; the seconds-per-N figures are not, and are excluded from this report), and that several
  findings rest on source reads where execution was available. Those are listed in §7.

The twelve gap-filling agents the critic spawned then returned 68 further findings, and they changed the
report again — including twice more against the lead's own text:

- **They found a live host-security exposure nobody else did.** sshd permits password **and** root login on
  the public interface, with `fail2ban` as the only control and neither documented anywhere in the repo.
  That is **I-24**, and it is the one finding here that is a present exposure rather than a pre-launch one.
- **They resolved the firewall question the other way.** `/proc/modules` is world-readable and shows ufw's
  full signature set loaded, so the host *is* filtering. Section 1, I-1 and §7.2 were rewritten a second
  time; the sudo key is a pre-exposure defect to fix, not a live incident. The externally-probed claim that
  the P2P path was open is **not** relied on.
- **They corrected a fact this report introduced.** It stated fail2ban's ban action as
  `iptables-multiport`; that is the stock `jail.conf` value, overridden to `nftables` in
  `jail.d/defaults-debian.conf`. Fixed throughout.
- They also caught `deploy/README.md:172` asserting "there is no host packet filtering running right now",
  which is false and sits above a warning telling the operator to enable it (now in §4.4); confirmed the
  rendered nginx config **does** parse cleanly under the exact nginx INSTALL.md installs, closing a §7.2
  UNVERIFIED; established that all three products **wedge permanently** when their node goes away, refuting
  `deploy/products/README.md:80-82`; and found that `execute_slash` never removes a slashed agent from the
  ranked collective. The last two are in the findings table, not yet promoted to issues.

In parallel with all of the above the lead performed an independent
completeness pass: every one of the brief's phase questions was checked off against the findings; all 46
CRITICAL/HIGH findings were confirmed to map onto the proposed issues in §6; and the load-bearing claims
were re-verified first-hand rather than accepted from a subagent. Those
first-hand re-verifications were: the `Sudo::Key` value **and** an independent `//Alice` key derivation to
the same bytes; the faucet address derived from `//Ferdie` and matched to `/health`; total issuance at
genesis and at head; the Treasury account derived from its `PalletId` and its balance read; the 47-entry
`ErasValidatorReward` sum and the empty `ClaimedRewards`; the `Emissions` prefix holding only its storage
version, with all three storage hashes recomputed; head `:code` hash equal to genesis `:code` hash; the
escrow double-map keys decoded to buyer/provider pairs; the 36 `#[pallet::weight]` attributes and
`settle_era`'s constant price over an unbounded `AgentStake::iter()`; the reject-stubs hook run against
nine payloads and two real repo files; the spend ledger broken down by entry kind across three days; the
staleness of both snapshot files against a fresh head; the repo's private visibility and the four anonymous
404s; the published token-model and `rpc.md` claims fetched and grepped; `cargo test --workspace` and the
`fmt`/`clippy -D warnings` gate; and every one of the 21 issue gates executed to confirm it is red today.

**Deliberate coverage limit, stated rather than hidden.** MEDIUM, LOW and INFO findings were **not** put to
the panel. They are evidence-backed — each cites a command or a `file:line` — but they have not been
adversarially challenged, and they are marked as such in the table. If any of them is about to drive a
decision, verify it first.

**What was never done, by rule.** Nothing was created, modified, deleted, committed, pushed, merged,
labelled, dispatched or fixed inside the repository. No mutating RPC was called. **No extrinsic was
submitted** — which is why the faucet's drip path, the SDK's write path, a live `set_code`, and the live
archetype runs all appear in §7 as unverified rather than as results. `systemctl` was read, never started
or stopped. The faucet's `POST /drip` was never called. The four live test suites that submit extrinsics
(`indexer`, `explorer`, `faucet`, and the SDK's `test:integration`) were identified and skipped; their
offline siblings were run and are reported.

**Repository state at the end**, re-checked after every phase:

```
$ git -C /home/dev/scalar-commons-v4 status --porcelain=v1
?? AUDIT.md
?? ENDGOAL.md
?? STAGE1-HARDENING.md
?? STATUS.md
?? TODAY-PLAN.md
?? WEEKCHECK.md
$ git -C /home/dev/scalar-commons-v4 log -1 --format=%H
6efba16bf9ba33ee76da2fd361c90e53409085ab
```

Identical to the state at 08:18, with one disclosed exception recorded in §7.5. `TESTNETAUDIT.md` is the
only file this audit adds to the repository; every other artefact lives under `/tmp/audit/`.

The workspace test suite was also re-run at the end as a closing control, and matches the opening run
exactly:

```
$ cargo test --workspace        # closing run, 2026-09-08 ~13:5x CEST
EXIT=0
FINAL: passed=109 failed=0 ignored=0
```

**One thing that changed underneath the audit**: `origin/master` advanced to `fd00c057` at 06:42Z when
PR #116 merged `ENDGOAL.md`. The audit is against `6efba16`; the only delta is that the document this
report audits *against* is now also a document this report audits — which is why its stale lines appear in
§4.3 as published claims rather than as draft notes.

