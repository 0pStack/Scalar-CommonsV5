#!/usr/bin/env node
/**
 * scripts/emissions-zero-override.mjs — set the era emission to ZERO for every
 * era the existing lever can reach, using only the extrinsic that already ships.
 *
 *   node scripts/emissions-zero-override.mjs [--dry-run] [--ws ws://127.0.0.1:9944]
 *                                            [--amount <plancks>]
 *                                            [--era N] [--schedule-for N]
 *
 * With no era flag it covers every era the lever can reach with `--amount` (default 0).
 * `--era N` targets one era instead. `--schedule-for N` sets the amount to exactly what the
 * UN-overridden agent-count formula would have produced, which is how you hand one era back
 * to the normal schedule — needed before measuring the emission rule, so the measurement is
 * of the rule and not of this script's own pause.
 *
 * WHY THIS EXISTS
 *
 * Issue #164: a two-account faucet-funded tester captured 81.88 % of an era's
 * emission (90 068.37 CMN) for 60 CMN of self-directed escrow. The pot is sized
 * by `TargetEmissionPerAgent x agent_count` regardless of whether any work
 * happened, and the qualification gates in `compute_weight_cached` concentrate
 * rather than dilute. The economic gate is FAILED, not open, and emission must
 * stop until spec 306 lands.
 *
 * THE LEVER, AND ITS ONE LIMIT
 *
 * `emissions::set_era_emission_override(target_era, amount)` is root-gated and
 * `settle_era` reads it with `EmissionOverrides::take(era)`. An entry of 0 is
 * `Some(0)`, not absent, so the era mints exactly nothing.
 *
 * The guard is `target_era > current_era && target_era <= current_era +
 * MaxEmissionOverrideEras`. So THE ERA THAT SETTLES NEXT CANNOT BE OVERRIDDEN —
 * `settle_era` reads `EraNumber` and that is `current_era`. This script covers
 * `current_era + 1 ..= current_era + MaxEmissionOverrideEras` and says plainly
 * which era it could not reach. That guard is not worked around here: writing
 * the storage item directly through `system.setStorage` would bypass a check
 * rather than satisfy it.
 *
 * The override is consumed on read, so this must be re-run every
 * MaxEmissionOverrideEras eras until the real fix is live.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * `pallet-tx-pause` would also stop emission — `PauseOrigin` is root and
 * `WhitelistedCalls` is `()`, so `emissions.claim` and `emissions.settle_era`
 * are both pausable today. Both are refused here: CLAUDE.md first principle #3
 * says no economically essential function (era settlement, reward claims) may
 * depend on a privileged caller, and pausing either makes it depend on one.
 * Zeroing the pot leaves settlement permissionless and claims open; it just
 * makes there be nothing to concentrate.
 *
 * FEE PREFLIGHT
 *
 * Same pattern as apply-upgrade.mjs, and for the same reason: `sudo.sudo`
 * dispatches `paysFee: No`, but that is post-dispatch. ChargeTransactionPayment
 * runs inside validate_transaction and still requires the signer to cover the
 * estimated fee, so an unfunded root key cannot get the extrinsic into the pool
 * at all (UPGRADE-305.md, first attempt).
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

const KEYFILE = process.env.SUDO_KEY_FILE || `${homedir()}/.config/scalar-commons/sudo.key`;

const argv = process.argv.slice(2);
let dryRun = false;
let ws = 'ws://127.0.0.1:9944';
let amount = 0n;
let onlyEra = null;
let scheduleFor = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dry-run') dryRun = true;
  else if (a === '--ws') ws = argv[++i];
  else if (a === '--amount') amount = BigInt(argv[++i]);
  else if (a === '--era') onlyEra = Number(argv[++i]);
  else if (a === '--schedule-for') scheduleFor = Number(argv[++i]);
  else { console.error(`unrecognised argument: ${a}`); process.exit(2); }
}

const cmn = (b) => (Number(b) / 1e12).toFixed(4) + ' CMN';

const main = async () => {
  await cryptoWaitReady();

  if (!existsSync(KEYFILE)) {
    console.error(`FATAL: operator key not found at ${KEYFILE}`);
    process.exit(1);
  }
  const mode = (statSync(KEYFILE).mode & 0o777).toString(8);
  if (mode !== '600') console.error(`WARNING: ${KEYFILE} is mode ${mode}, expected 600`);
  const phrase = readFileSync(KEYFILE, 'utf8').trim();
  if (!phrase) { console.error(`FATAL: ${KEYFILE} is empty`); process.exit(1); }

  const api = await ApiPromise.create({ provider: new WsProvider(ws) });
  const keyring = new Keyring({ type: 'sr25519', ss58Format: api.registry.chainSS58 ?? 42 });
  const signer = keyring.addFromUri(phrase);

  const sudoKey = (await api.query.sudo.key()).toString();
  const now = (await api.rpc.chain.getHeader()).number.toNumber();
  const currentEra = (await api.query.agents.eraNumber()).toNumber();
  const eraStart = (await api.query.emissions.eraStartBlock()).toNumber();
  const eraDuration = api.consts.emissions.eraDuration.toNumber();
  const maxAhead = api.consts.emissions.maxEmissionOverrideEras.toNumber();

  // The reachable window is exactly the runtime's own guard, restated.
  let first = currentEra + 1;
  let last = currentEra + maxAhead;
  if (onlyEra !== null) {
    first = onlyEra;
    last = onlyEra;
  }
  const eras = [];
  for (let e = first; e <= last; e++) eras.push(e);

  // --schedule-for: set the amount to exactly what the un-overridden agent-count formula
  // would have produced for that era. Used to hand ONE era back to the normal schedule
  // after a blanket zero, so that measuring the emission rule measures the rule rather
  // than reading this script's own pause back out of storage. A re-measurement that passes
  // because emission was switched off proves nothing.
  if (scheduleFor !== null) {
    // `--schedule-for N` names the era it is computing for, and must agree with `--era N`.
    // The formula reads the CURRENT agent count, so quoting the era back is the only way
    // the script can tell that the caller means the era they are actually writing.
    if (onlyEra === null || scheduleFor !== onlyEra) {
      console.error(`FATAL: --schedule-for ${scheduleFor} needs a matching --era ${scheduleFor}.`);
      await api.disconnect();
      process.exit(2);
    }
    const agentCount = BigInt((await api.query.agents.agentStake.keys()).length);
    const target = api.consts.emissions.targetEmissionPerAgent.toBigInt();
    const floor = api.consts.emissions.floorEmissionPerEra.toBigInt();
    const ceiling = api.consts.emissions.initialEmissionsPerEra.toBigInt();
    let scaled = target * agentCount;
    if (scaled < floor) scaled = floor;
    if (scaled > ceiling) scaled = ceiling;
    amount = scaled;
    console.log('');
    console.log('  --schedule-for      : reproducing the un-overridden formula');
    console.log('  registered agents   : ' + agentCount);
    console.log('  target x agents     : ' + cmn(target * agentCount));
    console.log('  clamped [floor,ceil]: ' + cmn(amount));
  }

  console.log('');
  console.log('  chain               : ' + (await api.rpc.system.chain()).toString());
  console.log('  endpoint            : ' + ws);
  console.log('  spec_version        : ' + api.runtimeVersion.specVersion.toNumber());
  console.log('  head block          : #' + now);
  console.log('  agents.EraNumber    : ' + currentEra);
  console.log('  EraStartBlock       : #' + eraStart + '  EraDuration ' + eraDuration
    + '  next settlement due at #' + (eraStart + eraDuration));
  console.log('  MaxEmissionOverride : ' + maxAhead + ' eras');
  console.log('');
  if (onlyEra === null) {
    console.log('  NOT REACHABLE       : era ' + currentEra + ' — settle_era reads EraNumber, and the');
    console.log('                        runtime guard is target_era > current_era. Era ' + currentEra + ' will');
    console.log('                        mint its agent-count-scaled pot at #' + (eraStart + eraDuration) + '.');
  }
  console.log('  overriding eras     : ' + first + '..' + last + ' to ' + cmn(amount));
  console.log('');
  console.log('  signer              : ' + signer.address);
  console.log('  on-chain Sudo::Key  : ' + sudoKey);
  console.log('  signer is root      : ' + (signer.address === sudoKey ? 'YES' : 'NO — the call will fail'));
  console.log('');

  if (signer.address !== sudoKey) {
    console.error('FATAL: the operator key does not match the on-chain root key. Refusing.');
    await api.disconnect();
    process.exit(1);
  }

  const inner = api.tx.utility.batchAll(
    eras.map((e) => api.tx.emissions.setEraEmissionOverride(e, amount)),
  );
  const call = api.tx.sudo.sudo(inner);
  console.log('  call                : sudo.sudo(utility.batchAll(' + eras.length
    + ' x emissions.setEraEmissionOverride))');
  console.log('  inner call hash     : ' + inner.method.hash.toHex());
  console.log('  outer call hash     : ' + call.method.hash.toHex());
  console.log('');

  // ---- fee preflight (apply-upgrade.mjs pattern) --------------------------
  const acct = await api.query.system.account(signer.address);
  const free = acct.data.free.toBigInt();
  const ed = api.consts.balances.existentialDeposit.toBigInt();
  let fee = 0n;
  let feeNote = '';
  try {
    fee = (await call.paymentInfo(signer)).partialFee.toBigInt();
  } catch (e) {
    feeNote = ' (estimate unavailable: ' + e.message + ')';
  }
  const required = fee + ed;
  console.log('  signer free balance : ' + cmn(free));
  console.log('  estimated fee       : ' + cmn(fee) + feeNote);
  console.log('  existential deposit : ' + cmn(ed));
  console.log('  required (fee + ED) : ' + cmn(required));
  console.log('  can pay             : ' + (free >= required && free > 0n ? 'YES' : 'NO'));
  console.log('');
  if (free === 0n || free < required) {
    console.error('FATAL: signer cannot pay for this transaction.');
    console.error(`  free ${cmn(free)} < required ${cmn(required)} (estimated fee + existential deposit)`);
    console.error('  Fund ' + signer.address + ' and re-run.');
    await api.disconnect();
    process.exit(1);
  }

  if (dryRun) {
    console.log('  DRY RUN — nothing submitted. The chain is unchanged.');
    console.log('');
    await api.disconnect();
    return;
  }

  console.log('  SUBMITTING.');
  const finalized = await new Promise((resolve, reject) => {
    call.signAndSend(signer, ({ status, dispatchError, events }) => {
      if (dispatchError) {
        if (dispatchError.isModule) {
          const d = api.registry.findMetaError(dispatchError.asModule);
          return reject(new Error(`${d.section}.${d.name}: ${d.docs.join(' ')}`));
        }
        return reject(new Error(dispatchError.toString()));
      }
      if (status.isFinalized) {
        for (const { event } of events) {
          // sudo.Sudid carries the inner call's own Result — a sudo call can
          // finalize "successfully" while the call it wrapped failed.
          if (event.section === 'sudo' && event.method === 'Sudid') {
            const r = event.data[0];
            if (r && r.isErr) return reject(new Error('sudo.Sudid reported Err: ' + r.toString()));
          }
          if (event.section === 'utility' && event.method === 'BatchInterrupted') {
            return reject(new Error('utility.BatchInterrupted: ' + event.data.toString()));
          }
          console.log(`  event               : ${event.section}.${event.method} `
            + `${event.section === 'emissions' ? JSON.stringify(event.data.toHuman()) : ''}`);
        }
        resolve(status.asFinalized.toHex());
      }
      if (status.isDropped || status.isInvalid || status.isUsurped) {
        reject(new Error(`transaction ${status.type}`));
      }
    }).catch(reject);
  });

  const hdr = await api.rpc.chain.getHeader(finalized);
  console.log('');
  console.log('  finalized in        : ' + finalized);
  console.log('  PAUSE BLOCK         : #' + hdr.number.toNumber());
  console.log('');

  // Judge by storage, not by the extrinsic returning Ok.
  const after = await api.query.emissions.emissionOverrides.entries();
  const got = new Map(after.map(([k, v]) => [k.args[0].toNumber(), v.unwrap().toString()]));
  let bad = 0;
  for (const e of eras) {
    const v = got.get(e);
    console.log(`  EmissionOverrides[${e}] = ${v === undefined ? 'ABSENT' : v}`);
    if (v !== amount.toString()) bad++;
  }
  await api.disconnect();
  if (bad) {
    console.error(`FAILED: ${bad} of ${eras.length} overrides did not read back as ${amount}.`);
    process.exit(1);
  }
  console.log('');
  console.log(`  OK — eras ${first}..${last} will mint ${cmn(amount)}.`);
  if (onlyEra === null) {
    console.log(`  Era ${currentEra} is NOT covered and mints at #${eraStart + eraDuration}.`);
  }
  console.log(`  Overrides are consumed on read: re-run before era ${last} settles.`);
};

main().catch((e) => { console.error('FATAL: ' + (e && e.message ? e.message : e)); process.exit(1); });
