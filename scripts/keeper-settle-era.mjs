#!/usr/bin/env node
/**
 * scripts/keeper-settle-era.mjs — submit emissions.settle_era when it is due.
 *
 *   node scripts/keeper-settle-era.mjs [--dry-run] [--ws ws://127.0.0.1:9944]
 *
 * WHY THIS EXISTS
 *
 * `settle_era` is permissionless by design — CLAUDE.md first principle #3 says
 * no economically essential function may depend on a privileged caller. The
 * cost of that design is that if nobody calls it, it never happens, and that is
 * exactly what occurred: the Emissions storage prefix held one key (its own
 * storage version), `LastSettledEra` was null, and `agents::EraNumber` was 0
 * after ~512 000 blocks — about 142 elapsed six-hour eras. No CMN has ever been
 * emitted by the mechanism the project is about. TESTNETAUDIT.md §6 I-8,
 * issue #125.
 *
 * This keeper closes that gap without weakening the design: it is an ordinary
 * signed account calling a permissionless extrinsic, exactly as any agent could.
 * It holds no privilege. If it stops, anyone else can still call `settle_era`.
 *
 * IDEMPOTENT BY CONSTRUCTION
 *
 * The timer fires far more often than an era elapses. That is deliberate: the
 * script re-reads the chain's own guards each run and exits 0 without
 * submitting when settlement is not due, so a missed tick self-corrects on the
 * next one and a burst of ticks cannot double-settle. The runtime's F-04
 * double-settlement guard (`EraAlreadySettled`) is the real backstop; this
 * check exists so the common case costs no fee and writes no journal noise.
 */

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const CANDIDATES = ['../sdk/package.json', '../indexer/package.json'];
function loadPolkadot(pkg) {
  let lastErr;
  for (const c of CANDIDATES) {
    try {
      const req = createRequire(pathResolve(HERE, c));
      return import(pathToFileURL(req.resolve(pkg)).href);
    } catch (e) { lastErr = e; }
  }
  throw new Error(`cannot resolve ${pkg} from sdk/ or indexer/ node_modules (${lastErr && lastErr.message})`);
}
const { ApiPromise, WsProvider } = await loadPolkadot('@polkadot/api');
const { Keyring } = await loadPolkadot('@polkadot/keyring');
const { cryptoWaitReady } = await loadPolkadot('@polkadot/util-crypto');

const KEYFILE = process.env.KEEPER_KEY_FILE || `${homedir()}/.config/scalar-commons/keeper.key`;

let dryRun = false;
let ws = process.env.KEEPER_RPC_ENDPOINT || 'ws://127.0.0.1:9944';
for (let i = 0; i < process.argv.length - 2; i++) {
  const a = process.argv[i + 2];
  if (a === '--dry-run') dryRun = true;
  else if (a === '--ws') ws = process.argv[i + 3];
}

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const cmn = (b) => (Number(b) / 1e12).toFixed(6) + ' CMN';

const main = async () => {
  await cryptoWaitReady();

  if (!existsSync(KEYFILE)) { console.error(`FATAL: keeper key not found at ${KEYFILE}`); process.exit(1); }
  const mode = (statSync(KEYFILE).mode & 0o777).toString(8);
  if (mode !== '600') console.error(`WARNING: ${KEYFILE} is mode ${mode}, expected 600`);
  const phrase = readFileSync(KEYFILE, 'utf8').trim();
  if (!phrase) { console.error(`FATAL: ${KEYFILE} is empty`); process.exit(1); }

  const api = await ApiPromise.create({ provider: new WsProvider(ws) });
  const kr = new Keyring({ type: 'sr25519', ss58Format: api.registry.chainSS58 ?? 42 });
  const keeper = kr.addFromUri(phrase);

  const now = (await api.rpc.chain.getHeader()).number.toNumber();
  const eraStart = (await api.query.emissions.eraStartBlock()).toNumber();
  const eraDuration = api.consts.emissions.eraDuration.toNumber();
  const lastSettled = await api.query.emissions.lastSettledEra();
  const era = (await api.query.agents.eraNumber()).toNumber();
  const dueAt = eraStart + eraDuration;

  // Mirror the runtime's own two guards (pallets/emissions/src/lib.rs:242-251)
  // so the common "not due yet" case costs nothing. The runtime remains the
  // authority; this is an optimisation, not a substitute.
  const eraDue = now >= dueAt;
  const notSettled = lastSettled.isNone || era > lastSettled.unwrap().toNumber();

  log(`keeper ${keeper.address}`);
  log(`block ${now}  EraStartBlock ${eraStart}  EraDuration ${eraDuration}  due at ${dueAt}`);
  log(`era ${era}  LastSettledEra ${lastSettled.isNone ? 'None' : lastSettled.toString()}`);
  log(`guards: EraNotDue ${eraDue ? 'passes' : 'BLOCKS'}, EraAlreadySettled ${notSettled ? 'passes' : 'BLOCKS'}`);

  if (!eraDue || !notSettled) {
    log(`settlement not due (${!eraDue ? `${dueAt - now} blocks to go` : 'era already settled'}) — nothing to do`);
    await api.disconnect();
    return;
  }

  const acct = await api.query.system.account(keeper.address);
  const free = acct.data.free.toBigInt();
  const tx = api.tx.emissions.settleEra();
  const info = await tx.paymentInfo(keeper);
  const fee = info.partialFee.toBigInt();
  const ed = api.consts.balances.existentialDeposit.toBigInt();
  log(`balance ${cmn(free)}  estimated fee ${cmn(fee)}  ED ${cmn(ed)}`);
  if (free < fee + ed) {
    console.error(`FATAL: keeper cannot pay — free ${cmn(free)} < fee + ED ${cmn(fee + ed)}. Fund ${keeper.address}.`);
    await api.disconnect();
    process.exit(1);
  }

  if (dryRun) {
    log(`DRY RUN — would submit emissions.settleEra (call hash ${tx.method.hash.toHex()})`);
    await api.disconnect();
    return;
  }

  log(`submitting emissions.settleEra (call hash ${tx.method.hash.toHex()})`);
  const finalized = await new Promise((resolve, reject) => {
    tx.signAndSend(keeper, ({ status, dispatchError, events }) => {
      if (dispatchError) {
        if (dispatchError.isModule) {
          const d = api.registry.findMetaError(dispatchError.asModule);
          return reject(new Error(`${d.section}.${d.name}: ${d.docs.join(' ')}`));
        }
        return reject(new Error(dispatchError.toString()));
      }
      if (status.isFinalized) {
        for (const { event } of events) {
          log(`event ${event.section}.${event.method} ${JSON.stringify(event.data.toHuman())}`);
        }
        resolve(status.asFinalized.toHex());
      }
      if (status.isDropped || status.isInvalid || status.isUsurped) reject(new Error(`transaction ${status.type}`));
    }).catch(reject);
  });

  const hdr = await api.rpc.chain.getHeader(finalized);
  const after = await api.query.emissions.lastSettledEra();
  const eraAfter = (await api.query.agents.eraNumber()).toNumber();
  log(`finalized ${finalized} (#${hdr.number.toNumber()})`);
  log(`LastSettledEra now ${after.isNone ? 'None' : after.toString()}  agents.EraNumber now ${eraAfter}`);
  await api.disconnect();

  // Judge by storage, not by the extrinsic returning Ok.
  if (after.isNone) { console.error('FAILED: LastSettledEra is still None after a successful extrinsic.'); process.exit(1); }
};

main().catch((e) => { console.error('FATAL: ' + (e && e.message ? e.message : e)); process.exit(1); });
