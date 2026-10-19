#!/usr/bin/env node
/**
 * scripts/apply-upgrade.mjs — apply a forkless runtime upgrade.
 *
 *   node scripts/apply-upgrade.mjs <path/to/runtime.compact.compressed.wasm> [--dry-run]
 *                                  [--ws ws://127.0.0.1:9944] [--expect-spec 305]
 *                                  [--ports 9944,9945,9946,9947,9948] [--blocks 20]
 *
 *   node scripts/apply-upgrade.mjs --call <pallet.method> [--args '<json array>'] [--dry-run]
 *
 * The --call form wraps ONE other root call in `sudo.sudo(...)` — e.g. the D11
 * staking parameters, `--call staking.setValidatorCount --args '[7]'`. It goes
 * through the same key-file handling, root check and fee preflight as set_code,
 * and checks sudo.Sudid's inner Result the same way, so there is one audited
 * path for root calls rather than a second script holding the operator key.
 * It skips the spec_version poll, which only means something for set_code.
 *
 * Submits `sudo.sudo(system.setCode(<wasm>))` signed by the operator key in
 * ~/.config/scalar-commons/sudo.key, waits for finalization, then polls
 * state_getRuntimeVersion on every listed port until they all report the
 * expected spec_version or the block budget runs out.
 *
 * WHY THIS IS A SCRIPT AND NOT A SEQUENCE OF COMMANDS
 *
 * ENDGOAL §3.1 requires a forkless upgrade "rehearsed — spec_version bumped and
 * applied on a live network without restarting nodes", and calls a chain that
 * cannot upgrade itself "not an L1". It has never happened here: the on-chain
 * `:code` at the finalized head was byte-identical to genesis, and all five
 * previous spec bumps (300 -> 304) were compiled into fresh geneses before this
 * chain started. So this is the first one, and it needs to be repeatable and
 * auditable rather than typed once. See TESTNETAUDIT.md §6 I-20, issue #136.
 *
 * SAFETY
 *
 * - `--dry-run` prints the signer and the call hash and submits nothing.
 * - The signer is derived from the key file, never from //Alice; the file is
 *   0600 and lives outside the repository.
 * - `system.setCode` is a root call and its weight is the whole block. It goes
 *   through `sudo.sudo`, so it bypasses the normal fee/weight path by design.
 * - Success is judged by reading `state_getRuntimeVersion` back from every
 *   node, not by the extrinsic returning Ok. A blob that applies but that the
 *   other four nodes reject would still be a failed upgrade.
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
const { cryptoWaitReady, blake2AsHex } = await loadPolkadot('@polkadot/util-crypto');
const { u8aToHex } = await loadPolkadot('@polkadot/util');

const KEYFILE = `${homedir()}/.config/scalar-commons/sudo.key`;

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error('usage: node scripts/apply-upgrade.mjs <runtime.wasm> [--dry-run] [--ws url]');
  console.error('       [--expect-spec N] [--ports a,b,c] [--blocks N]');
  console.error('   or: node scripts/apply-upgrade.mjs --call <pallet.method> [--args <json array>]');
  console.error('       [--dry-run] [--ws url]');
  process.exit(2);
}

const argv = process.argv.slice(2);
let wasmPath = null, dryRun = false;
let ws = 'ws://127.0.0.1:9944';
let expectSpec = 305;
let ports = [9944, 9945, 9946, 9947, 9948];
let blockBudget = 20;
let callName = null, callArgs = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dry-run') dryRun = true;
  else if (a === '--ws') ws = argv[++i] || usage('--ws needs a url');
  else if (a === '--expect-spec') expectSpec = Number(argv[++i]);
  else if (a === '--ports') ports = (argv[++i] || '').split(',').map(Number).filter(Boolean);
  else if (a === '--blocks') blockBudget = Number(argv[++i]);
  else if (a === '--call') callName = argv[++i] || usage('--call needs pallet.method');
  else if (a === '--args') {
    try { callArgs = JSON.parse(argv[++i]); } catch (e) { usage(`--args is not JSON: ${e.message}`); }
    if (!Array.isArray(callArgs)) usage('--args must be a JSON array');
  }
  else if (a.startsWith('-')) usage(`unrecognised flag: ${a}`);
  else if (wasmPath === null) wasmPath = a;
  else usage('more than one wasm path given');
}
if (callName && wasmPath) usage('give either a wasm path or --call, not both');
if (!callName && !wasmPath) usage('no wasm path given');
if (callName && !/^[a-zA-Z]+\.[a-zA-Z]+$/.test(callName)) usage(`--call must be pallet.method, got ${callName}`);
if (!Number.isInteger(expectSpec)) usage('--expect-spec needs an integer');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  await cryptoWaitReady();

  // --call mode: no wasm to validate; the runtime metadata validates the call.
  let wasm = null, isCompressed = false, wasmHash = null;
  if (wasmPath) {
  if (!existsSync(wasmPath)) usage(`wasm not found: ${wasmPath}`);
  wasm = readFileSync(wasmPath);
  if (wasm.length === 0) usage('wasm file is empty');
  // A runtime blob is one of two shapes and BOTH are valid to submit:
  //
  //   - raw wasm, starting with the WebAssembly magic 0x0061736d
  //   - Substrate's zstd-wrapped form, starting with the 8-byte marker
  //     0x52bc537646db8e05 — this is what `*.compact.compressed.wasm` is, what
  //     genesis stores, and what comes back out of on-chain `:code`
  //
  // An earlier version of this check accepted only the first, which would have
  // refused the exact file the runbook tells you to submit. Caught by
  // dry-running against the blob pulled from `:code`. Anything that is neither
  // shape is a text file, a truncated copy, or the wrong file entirely.
  const magic = wasm.subarray(0, 4);
  const isRawWasm = magic[0] === 0x00 && magic[1] === 0x61 && magic[2] === 0x73 && magic[3] === 0x6d;
  const ZSTD_PREFIX = Buffer.from([0x52, 0xbc, 0x53, 0x76, 0x46, 0xdb, 0x8e, 0x05]);
  isCompressed = Buffer.from(wasm.subarray(0, 8)).equals(ZSTD_PREFIX);
  if (!isRawWasm && !isCompressed) {
    usage(`${wasmPath} is neither raw wasm nor a Substrate-compressed runtime `
      + `(first bytes ${u8aToHex(wasm.subarray(0, 8))})`);
  }
  wasmHash = blake2AsHex(wasm, 256);
  }

  if (!existsSync(KEYFILE)) {
    console.error(`FATAL: operator key not found at ${KEYFILE}`);
    console.error('This upgrade is signed by the rotated sudo key, never by //Alice.');
    process.exit(1);
  }
  const mode = (statSync(KEYFILE).mode & 0o777).toString(8);
  if (mode !== '600') console.error(`WARNING: ${KEYFILE} is mode ${mode}, expected 600`);
  const phrase = readFileSync(KEYFILE, 'utf8').trim();
  if (!phrase) { console.error(`FATAL: ${KEYFILE} is empty`); process.exit(1); }

  const provider = new WsProvider(ws);
  const api = await ApiPromise.create({ provider });

  const ss58 = api.registry.chainSS58 ?? 42;
  const keyring = new Keyring({ type: 'sr25519', ss58Format: ss58 });
  const signer = keyring.addFromUri(phrase);

  const sudoKey = (await api.query.sudo.key()).toString();
  const before = api.runtimeVersion.specVersion.toNumber();

  let inner;
  if (callName) {
    const [section, method] = callName.split('.');
    const fn = api.tx[section] && api.tx[section][method];
    if (!fn) {
      console.error(`FATAL: ${callName} is not a call in this runtime's metadata.`);
      await api.disconnect();
      process.exit(2);
    }
    inner = fn(...callArgs);
  } else {
    inner = api.tx.system.setCode(u8aToHex(wasm));
  }
  const call = api.tx.sudo.sudo(inner);

  console.log('');
  console.log('  chain               : ' + (await api.rpc.system.chain()).toString());
  console.log('  endpoint            : ' + ws);
  if (callName) {
    console.log('  root call           : ' + JSON.stringify(inner.method.toHuman()));
    console.log('  spec_version        : ' + before);
  } else {
    console.log('  wasm                : ' + wasmPath);
    console.log('  wasm bytes          : ' + wasm.length);
    console.log('  wasm form           : ' + (isCompressed ? 'zstd-compressed (the form to submit)' : 'raw wasm'));
    console.log('  wasm blake2-256     : ' + wasmHash);
    console.log('');
    console.log('  spec_version before : ' + before);
    console.log('  spec_version target : ' + expectSpec);
  }
  console.log('');
  console.log('  signer              : ' + signer.address);
  console.log('  on-chain Sudo::Key  : ' + sudoKey);
  console.log('  signer is root      : ' + (signer.address === sudoKey ? 'YES' : 'NO — the call will fail'));
  console.log('');
  console.log('  call                : sudo.sudo(' + (callName || 'system.setCode(<wasm>)') + ')');
  console.log('  inner call hash     : ' + inner.method.hash.toHex());
  console.log('  outer call hash     : ' + call.method.hash.toHex());
  console.log('');

  if (signer.address !== sudoKey) {
    console.error('FATAL: the operator key does not match the on-chain root key. Refusing.');
    await api.disconnect();
    process.exit(1);
  }

  // ---- can the signer actually PAY for this? ------------------------------
  //
  // This check exists because its absence cost a full upgrade attempt. The
  // rotated root key (#119) was never funded, so the first real root call was
  // rejected with "1010: Invalid Transaction: Inability to pay some fees" —
  // AFTER a six-minute release build, and with a dry run that had reported
  // "signer is root: YES" and no hint of a problem.
  //
  // The trap is that `sudo.sudo` dispatches with `paysFee: No`, so it is easy
  // to assume no balance is needed. That flag is POST-dispatch. The
  // ChargeTransactionPayment signed extension runs inside validate_transaction,
  // BEFORE the call is dispatched, and it requires the signer to cover the
  // estimated fee — so a zero-balance account cannot even get the extrinsic
  // into the pool.
  //
  // A dry run cannot discover this by submitting, because it deliberately does
  // not submit. So the check is an explicit balance-vs-fee comparison, and it
  // runs in dry-run mode too — that is the mode where you want to find out.
  const acct = await api.query.system.account(signer.address);
  const free = acct.data.free.toBigInt();
  const ed = api.consts.balances.existentialDeposit.toBigInt();
  let fee = 0n;
  let feeNote = '';
  try {
    const info = await call.paymentInfo(signer);
    fee = info.partialFee.toBigInt();
  } catch (e) {
    // A non-existent account makes paymentInfo fail outright. That is itself
    // the answer, so treat it as a zero estimate and let the comparison below
    // refuse — never as "no fee required".
    feeNote = ' (estimate unavailable: ' + e.message + ')';
  }
  const required = fee + ed;
  const cmn = (b) => (Number(b) / 1e12).toFixed(4) + ' CMN';

  console.log('  signer free balance : ' + cmn(free));
  console.log('  estimated fee       : ' + cmn(fee) + feeNote);
  console.log('  existential deposit : ' + cmn(ed));
  console.log('  required (fee + ED) : ' + cmn(required));
  console.log('  can pay             : ' + (free >= required && free > 0n ? 'YES' : 'NO'));
  console.log('');

  if (free === 0n || free < required) {
    console.error('FATAL: signer cannot pay for this transaction.');
    console.error(`  free ${cmn(free)} < required ${cmn(required)} (estimated fee + existential deposit)`);
    console.error('');
    console.error('  sudo.sudo dispatches paysFee:No, but that is post-dispatch. The pre-dispatch');
    console.error('  validity check still requires the signer to cover the estimated fee, so this');
    console.error('  would be rejected at submission with:');
    console.error('    1010: Invalid Transaction: Inability to pay some fees');
    console.error('');
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

  if (callName) console.log('  SUBMITTING sudo.sudo(' + callName + ').');
  else console.log('  SUBMITTING set_code. Nodes will switch runtime WITHOUT restarting.');
  console.log('');

  const applied = await new Promise((resolve, reject) => {
    call.signAndSend(signer, ({ status, dispatchError, events }) => {
      if (dispatchError) {
        if (dispatchError.isModule) {
          const d = api.registry.findMetaError(dispatchError.asModule);
          return reject(new Error(`${d.section}.${d.name}: ${d.docs.join(' ')}`));
        }
        return reject(new Error(dispatchError.toString()));
      }
      if (status.isInBlock) console.log('  in block            : ' + status.asInBlock.toHex());
      if (status.isFinalized) {
        for (const { event } of events) {
          // sudo.Sudid carries the inner call's own Result. A sudo call can be
          // finalized "successfully" while the call it wrapped failed, so this
          // is checked rather than assumed.
          if (event.section === 'sudo' && event.method === 'Sudid') {
            const r = event.data[0];
            if (r && r.isErr) return reject(new Error('sudo.Sudid reported Err: ' + r.toString()));
          }
          console.log(`  event               : ${event.section}.${event.method}`);
        }
        resolve(status.asFinalized.toHex());
      }
      if (status.isDropped || status.isInvalid || status.isUsurped) {
        reject(new Error(`transaction ${status.type}`));
      }
    }).catch(reject);
  });

  const hdr = await api.rpc.chain.getHeader(applied);
  const appliedNumber = hdr.number.toNumber();
  console.log('  finalized in        : ' + applied);
  console.log('  applied at block    : #' + appliedNumber);
  console.log('  extrinsic hash      : ' + call.hash.toHex());
  console.log('');

  if (callName) {
    // No spec change to poll for. The caller reads the storage it meant to
    // change back from the chain; the Sudid check above already refused an
    // inner Err.
    await api.disconnect();
    console.log(`  OK — sudo.sudo(${callName}) finalized at block #${appliedNumber}.`);
    return;
  }

  // ---- poll every node -----------------------------------------------------
  // The upgrade is not done when one node says so. Ask all of them, on their
  // own RPC ports, and give up after a block budget rather than hanging.
  console.log(`  polling ports ${ports.join(', ')} for spec ${expectSpec} (budget ${blockBudget} blocks)`);
  const deadlineBlock = appliedNumber + blockBudget;
  const seen = new Map();
  let head = appliedNumber;

  while (head < deadlineBlock) {
    for (const p of ports) {
      if (seen.get(p) === expectSpec) continue;
      try {
        const res = await fetch(`http://127.0.0.1:${p}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'state_getRuntimeVersion', params: [] }),
        });
        const j = await res.json();
        const sv = j && j.result && j.result.specVersion;
        if (typeof sv === 'number') {
          if (seen.get(p) !== sv) console.log(`    port ${p}: specVersion ${sv}`);
          seen.set(p, sv);
        }
      } catch { /* node briefly unreachable; the budget is the timeout */ }
    }
    if (ports.every((p) => seen.get(p) === expectSpec)) break;
    await sleep(3000);
    head = (await api.rpc.chain.getHeader()).number.toNumber();
  }

  console.log('');
  const laggards = ports.filter((p) => seen.get(p) !== expectSpec);
  for (const p of ports) console.log(`  port ${p} : specVersion ${seen.get(p) ?? 'unreachable'}`);
  console.log('');

  await api.disconnect();

  if (laggards.length) {
    console.error(`FAILED — ${laggards.join(', ')} did not report spec ${expectSpec} within ${blockBudget} blocks.`);
    process.exit(1);
  }
  console.log(`  OK — all ${ports.length} nodes report specVersion ${expectSpec}.`);
  console.log(`  applied at block #${appliedNumber} (${applied})`);
  console.log(`  wasm blake2-256 ${wasmHash}`);
};

main().catch((e) => { console.error('FATAL: ' + (e && e.message ? e.message : e)); process.exit(1); });
