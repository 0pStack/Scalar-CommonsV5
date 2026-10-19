#!/usr/bin/env node
/**
 * experiments/live/run.mjs — execute attacker archetypes against a live chain.
 *
 * ENDGOAL §3.4 requires each archetype to be run against a live network and
 * says plainly: "If wash trading still pays, the project does not launch." That
 * gate had never been executed, and the tooling could not execute it — the
 * archetype runners imported no transport at all, `scripts/run-eras.sh` and
 * `extract-export.sh` were `exit 1` stubs, and zombienet.toml named a binary
 * that does not exist. TESTNETAUDIT.md §6 I-7, issue #124.
 *
 * This runner has no fixtures and no recorded ledger. Every archetype funds
 * fresh accounts from //Alice, submits real extrinsics, waits for real era
 * settlement by the keeper (#125), claims, and reports measured net CMN.
 */

import { parseArgs, USAGE } from './src/args.mjs';
import { connect, keyringFor, newRunSeed, deriveAccount, fundFromAlice, balanceOf, claimable, head, waitForBlock } from './src/chain.mjs';
import { ARCHETYPES } from './src/archetypes/index.mjs';
import { newLedger, recordFunding, settle } from './src/ledger.mjs';
import { PER_AGENT_FUNDING } from './src/archetypes/index.mjs';
import { claimEmissions, short } from './src/ops.mjs';
import { renderTable, renderVerdict, renderFailures } from './src/table.mjs';
import { signedCmn, plancksToCmn } from './src/units.mjs';
import { writeFileSync } from 'node:fs';

const log = (m = '') => console.log(m);

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${e.message}`);
    console.error(USAGE);
    process.exit(2);
  }
  if (opts.help) { console.log(USAGE); return; }

  const selected = opts.archetype === 'all'
    ? Object.keys(ARCHETYPES)
    : opts.archetype.split(',').map((s) => s.trim());
  for (const k of selected) {
    if (!ARCHETYPES[k]) {
      console.error(`error: unknown archetype '${k}'. Known: ${Object.keys(ARCHETYPES).join(', ')}`);
      process.exit(2);
    }
  }

  const api = await connect(opts.endpoint);
  const kr = keyringFor(api);
  const runSeed = newRunSeed();
  const runTag = Date.now().toString(36);

  log('');
  log('=== live archetype run ===');
  log(`  endpoint      ${opts.endpoint}`);
  log(`  chain         ${(await api.rpc.system.chain()).toString()}  spec ${api.runtimeVersion.specVersion.toString()}`);
  log(`  archetypes    ${selected.join(', ')}`);
  log(`  eras          ${opts.eras}   rounds ${opts.rounds}`);
  log(`  run seed      ${runSeed}`);
  log('                (accounts are derived from this; keep it to re-audit the run)');

  const startBlock = await head(api);
  const eraDuration = api.consts.emissions.eraDuration.toNumber();
  const eraStart = (await api.query.emissions.eraStartBlock()).toNumber();
  const settlesAt = eraStart + eraDuration;
  log(`  head          #${startBlock}`);
  log(`  era started   #${eraStart}, settles at #${settlesAt} (${Math.max(0, settlesAt - startBlock)} blocks away)`);
  log('');

  // ---- phase 1: fund and execute --------------------------------------------
  const results = [];
  for (const key of selected) {
    const arch = ARCHETYPES[key];
    log(`--- ${arch.title} (${key}) ---`);
    const ledger = newLedger(key);
    const accounts = [];
    for (let i = 0; i < arch.accounts; i++) {
      const acct = deriveAccount(kr, runSeed, `${key}-${runTag}-${i}`);
      const r = await fundFromAlice(api, kr, acct.address, PER_AGENT_FUNDING);
      if (!r.ok) {
        console.error(`FATAL: could not fund ${acct.address}: ${r.error}`);
        await api.disconnect();
        process.exit(1);
      }
      recordFunding(ledger, acct.address, PER_AGENT_FUNDING);
      accounts.push(acct);
    }
    log(`    funded ${accounts.length} account(s) with ${plancksToCmn(PER_AGENT_FUNDING, 0)} CMN each`);

    await arch.run({
      api, ledger, accounts, log, rounds: opts.rounds,
      runSeedTag: `${key}-${runTag}`,
      head: () => head(api),
    });
    results.push({ arch, ledger, accounts });
    log('');
  }

  // ---- phase 2: wait for settlement ----------------------------------------
  //
  // Costs are already real and already paid. Rewards are not reachable until an
  // era settles, so a run that does not wait measures only the cost side — and
  // says so, rather than reporting half a picture as a verdict.
  let settledEras = 0;
  let status = opts.eras === 0 ? 'COSTS-ONLY' : 'PARTIAL';
  if (opts.eras > 0) {
    const before = (await api.query.emissions.lastSettledEra()).toString();
    log(`--- waiting for ${opts.eras} settlement(s); LastSettledEra is ${before || 'None'} ---`);
    log(`    the keeper (scalar-keeper.timer) submits settle_era once due at #${settlesAt}`);
    const deadline = Date.now() + opts.waitMinutes * 60_000;
    let last = before;
    while (settledEras < opts.eras && Date.now() < deadline) {
      const now = (await api.query.emissions.lastSettledEra()).toString();
      if (now !== last) { settledEras += 1; last = now; log(`    settled: LastSettledEra now ${now}`); continue; }
      const h = await head(api);
      const mins = Math.max(0, Math.round((settlesAt - h) * 6 / 60));
      log(`    #${h} — ${Math.max(0, settlesAt - h)} blocks to settlement (~${mins} min), ${Math.round((deadline - Date.now()) / 60000)} min of budget left`);
      await waitForBlock(api, h + 25).catch(() => {});
    }
    status = settledEras >= opts.eras ? 'SETTLED' : 'PARTIAL';
    if (status === 'PARTIAL') {
      log(`    budget exhausted after ${opts.waitMinutes} min with ${settledEras}/${opts.eras} settlement(s)`);
    }
    log('');
  }

  // ---- phase 3: claim and measure ------------------------------------------
  const rows = [];
  for (const { arch, ledger, accounts } of results) {
    log(`--- measuring ${arch.title} ---`);
    if (status === 'SETTLED') {
      for (const a of accounts) await claimEmissions(api, ledger, a, log);
    }
    const balances = [];
    for (const a of accounts) {
      const b = await balanceOf(api, a.address);
      balances.push({
        spendablePlancks: b.spendable, frozenPlancks: b.frozen, reservedPlancks: b.reserved,
        claimablePlancks: await claimable(api, a.address),
      });
    }
    const row = settle(ledger, balances);
    rows.push({ ...row, key: arch.key, title: arch.title, status });
    log(`    spendable ${plancksToCmn(row.spendablePlancks, 4)}  locked ${plancksToCmn(row.frozenPlancks, 4)}  reserved ${plancksToCmn(row.reservedPlancks, 4)}  claimable ${plancksToCmn(row.claimablePlancks, 4)}`);
    log(`    net ${signedCmn(row.netPlancks)} CMN  (stake still locked counts as NOT recovered)`);
    log('');
  }

  // ---- report ---------------------------------------------------------------
  log('=== net CMN per archetype ===');
  log('');
  log(renderTable(rows));
  log('');
  log('=== verdict ===');
  log(renderVerdict(rows));
  log('');
  log('=== refused extrinsics ===');
  log(renderFailures(rows));
  log('');

  if (status !== 'SETTLED') {
    log('!! INCOMPLETE — no era settled during this run.');
    log('   The net figures above are REAL and measured, but they are the COST side only:');
    log('   registration fees, escrow completion fees and transaction fees are all paid,');
    log('   while era emissions are not reachable until settle_era runs. Do NOT read a');
    log(`   negative number here as "the attack is unprofitable". Re-run after #${settlesAt}.`);
    log('');
  }

  if (opts.json) {
    writeFileSync(opts.json, JSON.stringify({
      runSeed, runTag, status, settledEras, startBlock, eraStart, settlesAt,
      spec: api.runtimeVersion.specVersion.toNumber(),
      rows: rows.map((r) => ({
        key: r.key, title: r.title, accounts: r.accounts, extrinsics: r.extrinsics,
        fundedPlancks: r.fundedPlancks.toString(), spendablePlancks: r.spendablePlancks.toString(),
        frozenPlancks: r.frozenPlancks.toString(), reservedPlancks: r.reservedPlancks.toString(),
        claimablePlancks: r.claimablePlancks.toString(), netPlancks: r.netPlancks.toString(),
        netCmn: signedCmn(r.netPlancks), failures: r.failures, notes: r.notes,
      })),
    }, null, 2));
    log(`wrote ${opts.json}`);
  }

  await api.disconnect();
}

main().catch((e) => { console.error('FATAL: ' + (e?.stack ?? e)); process.exit(1); });
