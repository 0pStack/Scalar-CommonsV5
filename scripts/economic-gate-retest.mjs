#!/usr/bin/env node
/**
 * scripts/economic-gate-retest.mjs — #164, re-measured against the LIVE chain.
 *
 *   node scripts/economic-gate-retest.mjs accounts   # three fresh faucet accounts, register, heartbeat
 *   node scripts/economic-gate-retest.mjs work       # the 60 CMN of escrow, inside the target era
 *   node scripts/economic-gate-retest.mjs settle     # settle when due, claim, report the verdict
 *
 * WHY THIS EXISTS
 *
 * The economic gate is not re-declared passed by code merging. #164 was found by walking the
 * public tester guide from outside with two faucet-funded accounts, and it is closed by doing
 * that again and measuring what the accounts can take. This is that walk, scripted so the
 * next person can repeat it rather than take a number on trust.
 *
 * It reproduces the issue move for move: two registered agents, one 10 CMN and one 50 CMN
 * job settled between them and nobody else, and then the question — how much can they mint?
 * The answer must be no more than the 60 CMN of escrow they actually settled. On spec 305 it
 * was 90 068.37 CMN, 81.88 % of the era.
 *
 * THREE PHASES, BECAUSE AN ERA IS SIX HOURS
 *
 * State lives in `economic-gate-retest-state.json` beside this script, so the phases can be
 * hours apart. `accounts` does the fragile external steps (faucet, registration) well before
 * the measurement window opens; `work` must run inside the era being measured, because
 * `drain_era_maps` clears the era volume at settlement; `settle` reads the payout back.
 *
 * A THIRD ACCOUNT, AND WHY
 *
 * One drip is 1 100 CMN and registering costs 1 050.01, leaving 49.99 — one hundredth of a
 * CMN short of a single 50 CMN job (issue #162). Account C exists only to top the buyer up
 * with a plain `balances.transfer`, so the escrow volume can be exactly the 60 CMN from the
 * issue. That transfer is also a live demonstration of #167: no pallet can see it.
 *
 * READ THIS BEFORE TRUSTING A PASS
 *
 * If the era under test carries a zero emission override, the payout is zero for reasons
 * that have nothing to do with the rule and the result proves nothing. Hand the era back to
 * the normal schedule first:
 *
 *   node scripts/emissions-zero-override.mjs --era N --schedule-for N
 */
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = pathResolve(HERE, '..');
function load(pkg) {
  for (const c of ['sdk/package.json', 'indexer/package.json']) {
    try {
      const req = createRequire(pathResolve(REPO, c));
      return import(pathToFileURL(req.resolve(pkg)).href);
    } catch { /* try next */ }
  }
  throw new Error(`cannot resolve ${pkg}`);
}
const { ApiPromise, WsProvider } = await load('@polkadot/api');
const { Keyring } = await load('@polkadot/keyring');
const { cryptoWaitReady, mnemonicGenerate } = await load('@polkadot/util-crypto');

const WS = process.env.RETEST_WS || 'wss://rpc.scalarnet.io';
const FAUCET = process.env.RETEST_FAUCET || 'https://faucet.scalarnet.io';
const STATE = `${HERE}/economic-gate-retest-state.json`;
const CMN = 1_000_000_000_000n;
const cmn = (b) => (Number(b) / 1e12).toFixed(6);
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The state file holds the three throwaway accounts' MNEMONICS in plaintext, because the
// phases run as separate processes hours apart and have to sign as the same accounts. They
// are single-use testnet keys holding faucet CMN and nothing else — but it is still a seed
// phrase on disk, so it is written 0600 and `scripts/.gitignore` keeps it out of the repo.
// Delete it when the measurement is recorded.
const readState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {});
const writeState = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2), { mode: 0o600 });

/** Submit and wait for finalization; reject on any dispatch error. */
function send(api, tx, signer, label) {
  return new Promise((resolve, reject) => {
    tx.signAndSend(signer, ({ status, dispatchError, events }) => {
      if (dispatchError) {
        if (dispatchError.isModule) {
          const d = api.registry.findMetaError(dispatchError.asModule);
          return reject(new Error(`${label}: ${d.section}.${d.name}`));
        }
        return reject(new Error(`${label}: ${dispatchError.toString()}`));
      }
      if (status.isFinalized) {
        resolve({ block: status.asFinalized.toHex(), events });
      }
      if (status.isDropped || status.isInvalid || status.isUsurped) {
        reject(new Error(`${label}: transaction ${status.type}`));
      }
    }).catch(reject);
  });
}

async function drip(address) {
  const res = await fetch(`${FAUCET}/drip`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address }),
  });
  const body = await res.json();
  if (!res.ok || !body.ok) throw new Error(`faucet ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

const connect = async () => ApiPromise.create({ provider: new WsProvider(WS) });

async function accounts() {
  await cryptoWaitReady();
  const api = await connect();
  const kr = new Keyring({ type: 'sr25519', ss58Format: api.registry.chainSS58 ?? 42 });

  log(`chain ${(await api.rpc.system.chain()).toString()} spec ${api.runtimeVersion.specVersion.toNumber()}`);

  // Three FRESH accounts. A provides, B buys. C exists only to top B up so the escrow
  // volume can be exactly the 60 CMN from #164 — one drip leaves 49.99 CMN after
  // registration (issue #162), which is 0.01 CMN short of a single 50 CMN job.
  const seeds = { A: mnemonicGenerate(), B: mnemonicGenerate(), C: mnemonicGenerate() };
  const acct = Object.fromEntries(Object.entries(seeds).map(([k, m]) => [k, kr.addFromUri(m)]));
  for (const [k, a] of Object.entries(acct)) log(`${k} = ${a.address}`);

  for (const [k, a] of Object.entries(acct)) {
    const r = await drip(a.address);
    log(`drip ${k}: ${JSON.stringify(r.amountPlancks ?? r)}`);
    await sleep(1500);
  }
  await sleep(9000); // let the drips finalize

  for (const k of ['A', 'B', 'C']) {
    const bal = (await api.query.system.account(acct[k].address)).data.free.toBigInt();
    log(`${k} free ${cmn(bal)} CMN`);
  }

  // C tops B up. Plain transfer — no pallet can see it, which is the point made in #167.
  await send(api, api.tx.balances.transferKeepAlive(acct.B.address, 100n * CMN), acct.C, 'topup');
  log('C -> B topped up 100 CMN');

  for (const k of ['A', 'B']) {
    await send(api, api.tx.agents.register(1000n * CMN), acct[k], `register ${k}`);
    log(`registered ${k} with 1000 CMN stake`);
  }
  // Read LastHeartbeat BEFORE any heartbeat call: on spec 306 register must have set it.
  const hbAfterRegister = {};
  for (const k of ['A', 'B']) {
    hbAfterRegister[k] = (await api.query.agents.lastHeartbeat(acct[k].address)).toNumber();
    log(`${k} lastHeartbeat immediately after register = ${hbAfterRegister[k]}  (#161: 0 on spec 305)`);
  }
  for (const k of ['A', 'B']) {
    await send(api, api.tx.agents.heartbeat(), acct[k], `heartbeat ${k}`);
  }
  log('both heartbeated');

  writeState({
    ...readState(),
    seeds,
    addresses: Object.fromEntries(Object.entries(acct).map(([k, a]) => [k, a.address])),
    specVersion: api.runtimeVersion.specVersion.toNumber(),
    hbAfterRegister,
    accountsBlock: (await api.rpc.chain.getHeader()).number.toNumber(),
  });
  log('accounts ready. Run "work" once the target era has started.');
  await api.disconnect();
}

async function work() {
  await cryptoWaitReady();
  const api = await connect();
  const kr = new Keyring({ type: 'sr25519', ss58Format: api.registry.chainSS58 ?? 42 });
  const s = readState();
  if (!s.seeds) throw new Error('no state — run accounts first');
  const acct = Object.fromEntries(Object.entries(s.seeds).map(([k, m]) => [k, kr.addFromUri(m)]));

  const eraAtStart = (await api.query.agents.eraNumber()).toNumber();

  // #164's exact jobs: one 10 CMN and one 50 CMN, B -> A, and nobody else involved.
  //
  // Resumable on purpose. `record_delivery` enforces `escrow.minDeliveryBlocks` between
  // creation and delivery — a real guard against a buyer and provider settling a job faster
  // than any work could have happened — so this loop has to wait, and a run that dies in
  // that wait must not strand a `Created` agreement or double-create one. Each pass looks
  // for an unsettled agreement of the right size before making another.
  const minDeliver = api.consts.escrow.minDeliveryBlocks.toNumber();
  let volume = 0n;
  for (const amount of [10n * CMN, 50n * CMN]) {
    const existing = (await api.query.escrow.agreements(acct.B.address, acct.A.address))
      .toJSON()
      .find((a) => BigInt(a.amount) === amount && a.status !== 'Settled');

    let seq;
    let createdAt;
    if (existing) {
      seq = existing.seq;
      createdAt = existing.createdAt;
      log(`resuming existing ${cmn(amount)} CMN agreement (seq ${seq}, status ${existing.status})`);
    } else {
      seq = (await api.query.escrow.nextSeq(acct.B.address, acct.A.address)).toNumber();
      const now = (await api.rpc.chain.getHeader()).number.toNumber();
      await send(
        api,
        api.tx.escrow.createAgreement(acct.A.address, amount, '0x' + '11'.repeat(32), now + 400, null),
        acct.B,
        'createAgreement',
      );
      createdAt = now;
      log(`created ${cmn(amount)} CMN agreement (seq ${seq})`);
    }

    const deliverableAt = createdAt + minDeliver + 1;
    for (;;) {
      const now = (await api.rpc.chain.getHeader()).number.toNumber();
      if (now >= deliverableAt) break;
      log(`waiting ${deliverableAt - now} blocks for escrow.minDeliveryBlocks (${minDeliver})`);
      await sleep(12000);
    }

    const stateNow = (await api.query.escrow.agreements(acct.B.address, acct.A.address))
      .toJSON()
      .find((a) => a.seq === seq);
    if (stateNow && stateNow.status === 'Created') {
      await send(
        api,
        api.tx.escrow.recordDelivery(acct.B.address, seq, '0x' + '22'.repeat(32)),
        acct.A,
        'recordDelivery',
      );
    }
    await send(api, api.tx.escrow.confirmDelivery(acct.A.address, seq), acct.B, 'confirmDelivery');
    volume += amount;
    log(`escrow ${cmn(amount)} CMN B -> A settled (seq ${seq})`);
  }

  const eraVol = (await api.query.agents.eraEscrowVolume(acct.A.address)).toBigInt();
  const uniq = (await api.query.agents.eraUniqueBuyers(acct.A.address)).toNumber();
  const completions = (await api.query.agents.completedAgreements(acct.A.address)).toNumber();
  log(`A eraEscrowVolume ${cmn(eraVol)} CMN, eraUniqueBuyers ${uniq}, completions ${completions}`);

  const balAfterWork = {};
  for (const k of ['A', 'B']) {
    balAfterWork[k] = (await api.query.system.account(acct[k].address)).data.free.toBigInt().toString();
  }

  writeState({
    ...readState(),
    eraAtStart,
    escrowVolumePlancks: volume.toString(),
    eraEscrowVolumePlancks: eraVol.toString(),
    eraUniqueBuyers: uniq,
    completions,
    balAfterWork,
    workBlock: (await api.rpc.chain.getHeader()).number.toNumber(),
  });
  log(`work complete in era ${eraAtStart}. Run "settle" once era ${eraAtStart} is due.`);
  await api.disconnect();
}

async function settle() {
  await cryptoWaitReady();
  const api = await connect();
  const kr = new Keyring({ type: 'sr25519', ss58Format: api.registry.chainSS58 ?? 42 });
  const s = readState();
  if (!s.seeds) throw new Error('no state — run setup first');
  const acct = Object.fromEntries(Object.entries(s.seeds).map(([k, m]) => [k, kr.addFromUri(m)]));

  const era = (await api.query.agents.eraNumber()).toNumber();
  const lastSettled = await api.query.emissions.lastSettledEra();
  log(`era now ${era} (work was done in era ${s.eraAtStart}), lastSettledEra ${lastSettled.toString()}`);

  if (era === s.eraAtStart) {
    const now = (await api.rpc.chain.getHeader()).number.toNumber();
    const start = (await api.query.emissions.eraStartBlock()).toNumber();
    const dur = api.consts.emissions.eraDuration.toNumber();
    if (now < start + dur) {
      log(`NOT DUE — ${start + dur - now} blocks to go (~${Math.round(((start + dur - now) * 6) / 60)} min)`);
      await api.disconnect();
      process.exit(3);
    }
    log('era is due — submitting settle_era from account A (permissionless)');
    const { events } = await send(api, api.tx.emissions.settleEra(), acct.A, 'settleEra');
    for (const { event } of events) {
      if (event.section === 'emissions') {
        log(`event ${event.section}.${event.method} ${JSON.stringify(event.data.toHuman())}`);
      }
    }
  } else {
    log('era already settled by the keeper');
  }

  const lastEmission = (await api.query.emissions.lastEraEmission()).toBigInt();
  log(`LastEraEmission ${cmn(lastEmission)} CMN`);

  const payouts = {};
  for (const k of ['A', 'B']) {
    const before = (await api.query.system.account(acct[k].address)).data.free.toBigInt();
    const w = (await api.query.emissions.agentWeightSnapshot(acct[k].address)).toString();
    try {
      await send(api, api.tx.emissions.claim(), acct[k], `claim ${k}`);
    } catch (e) {
      log(`claim ${k} rejected: ${e.message}`);
    }
    const after = (await api.query.system.account(acct[k].address)).data.free.toBigInt();
    // A claim costs a fee, so a zero payout shows as a small negative. Report the raw
    // delta rather than clamping it — clamping would hide a payout that failed to arrive.
    payouts[k] = (after - before).toString();
    log(`${k} weightSnapshot ${w}  balance delta ${cmn(after - before)} CMN`);
  }

  const total = BigInt(payouts.A) + BigInt(payouts.B);
  const volume = BigInt(s.escrowVolumePlancks);
  console.log('');
  console.log('  ── ECONOMIC GATE RE-TEST ──────────────────────────────────');
  console.log(`  spec_version at setup   : ${s.specVersion}`);
  console.log(`  spec_version now        : ${api.runtimeVersion.specVersion.toNumber()}`);
  console.log(`  escrow volume settled   : ${cmn(volume)} CMN  (B -> A, two jobs, one buyer)`);
  console.log(`  era emission (whole era): ${cmn(lastEmission)} CMN`);
  console.log(`  A + B claimed           : ${cmn(total)} CMN`);
  console.log(`  verdict                 : ${total <= volume ? 'PASS — payout <= escrow volume' : 'FAIL — payout EXCEEDS escrow volume'}`);
  console.log('  ───────────────────────────────────────────────────────────');
  console.log('');

  writeState({ ...s, payouts, lastEraEmissionPlancks: lastEmission.toString(), verdict: total <= volume ? 'PASS' : 'FAIL' });
  await api.disconnect();
  if (total > volume) process.exit(1);
}

const cmdName = process.argv[2];
if (cmdName === 'accounts') await accounts();
else if (cmdName === 'work') await work();
else if (cmdName === 'settle') await settle();
else { console.error('usage: economic-gate-retest.mjs accounts|work|settle'); process.exit(2); }
