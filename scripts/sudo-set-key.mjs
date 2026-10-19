#!/usr/bin/env node
/**
 * scripts/sudo-set-key.mjs — rotate the chain's root key off //Alice.
 *
 * WHY THIS EXISTS
 *
 * The live chain's `Sudo::Key` is `//Alice` — a published Substrate dev seed
 * whose secret is in every Substrate tutorial. `runtime/src/lib.rs:668-669`
 * exempts `RuntimeCall::Sudo(_)` from SafeMode filtering and
 * `author_submitExtrinsic` is classified *safe*, so `--rpc-methods safe` does
 * not withhold it. The moment `wss://rpc.<domain>` is reachable, any stranger
 * can call `sudo.sudo(system.set_code)`, `balances.force_transfer`,
 * `system.kill_storage` or `sudo.set_key`. TLS, nginx rate limits and ufw do
 * not mitigate it. See TESTNETAUDIT.md §6 I-1 and issue #119.
 *
 * This script performs ONE call: `sudo.setKey(newAddress)`, signed by //Alice.
 * It is a rotation, not a removal — decision D1. Root still exists afterwards;
 * it is simply held by a key that only the operator has. Removal
 * (`sudo.remove_key`) is scheduled for mainnet and is deliberately NOT done
 * here, because a testnet that cannot `set_code` cannot rehearse a forkless
 * upgrade (I-20), and that rehearsal is still outstanding.
 *
 * IT IS ONE-WAY. After this succeeds, //Alice can no longer sign root calls;
 * only the holder of the new phrase can. If the new phrase is lost, the chain's
 * root is lost with it. The phrase lives in ~/.config/scalar-commons/sudo.key
 * (0600) and nowhere else — never in this repository.
 *
 *   node scripts/sudo-set-key.mjs <new-ss58-address> [--dry-run] [--ws <url>]
 *
 * --dry-run prints the exact call, its encoded form and its hash, reads the
 * current root key, and exits WITHOUT submitting anything.
 */

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';

// `scripts/` is not an npm package and has no node_modules of its own, and ESM
// bare-specifier resolution does not consult NODE_PATH. So resolve @polkadot
// out of whichever sibling subproject actually has it installed — sdk/ first,
// then indexer/ — and import it by file URL. This keeps the script standalone
// without adding a package.json here or hardcoding an absolute path.
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
  throw new Error(
    `cannot resolve ${pkg} from sdk/ or indexer/ node_modules — run \`npm ci\` ` +
    `in one of them first (${lastErr && lastErr.message})`);
}

const { ApiPromise, WsProvider } = await loadPolkadot('@polkadot/api');
const { Keyring } = await loadPolkadot('@polkadot/keyring');
const { cryptoWaitReady, encodeAddress, decodeAddress } = await loadPolkadot('@polkadot/util-crypto');
const { u8aToHex } = await loadPolkadot('@polkadot/util');

const ALICE_PUBKEY =
  '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d';

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error('usage: node scripts/sudo-set-key.mjs <new-ss58-address> [--dry-run] [--ws <url>]');
  process.exit(2);
}

const argv = process.argv.slice(2);
let target = null;
let dryRun = false;
let ws = 'ws://127.0.0.1:9944';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dry-run') dryRun = true;
  else if (a === '--ws') { ws = argv[++i]; if (!ws) usage('--ws needs a url'); }
  else if (a.startsWith('-')) usage(`unrecognised flag: ${a}`);
  else if (target === null) target = a;
  else usage('more than one address given');
}
if (!target) usage('no new address given');

const main = async () => {
  await cryptoWaitReady();

  // Validate the target BEFORE connecting to anything. Handing root to a
  // malformed or mistyped address is unrecoverable, so this fails closed on
  // anything that does not decode to 32 bytes.
  let targetPub;
  try {
    targetPub = decodeAddress(target);
  } catch (e) {
    usage(`'${target}' is not a valid SS58 address: ${e.message}`);
  }
  if (targetPub.length !== 32) usage(`'${target}' does not decode to a 32-byte account id`);
  const targetHex = u8aToHex(targetPub);
  if (targetHex === ALICE_PUBKEY) usage('refusing to set the root key to //Alice — that is the defect');

  const provider = new WsProvider(ws);
  const api = await ApiPromise.create({ provider });

  const chain = (await api.rpc.system.chain()).toString();
  const ss58 = api.registry.chainSS58 ?? 42;
  const before = (await api.query.sudo.key()).toString();
  const beforePub = before ? u8aToHex(decodeAddress(before)) : null;

  const keyring = new Keyring({ type: 'sr25519', ss58Format: ss58 });
  const alice = keyring.addFromUri('//Alice');

  const call = api.tx.sudo.setKey(target);

  console.log('');
  console.log('  chain                : ' + chain);
  console.log('  endpoint             : ' + ws);
  console.log('  ss58 format          : ' + ss58);
  console.log('  spec version         : ' + api.runtimeVersion.specVersion.toString());
  console.log('');
  console.log('  Sudo::Key BEFORE     : ' + before);
  console.log('    public key         : ' + beforePub);
  console.log('    is //Alice         : ' + (beforePub === ALICE_PUBKEY ? 'YES — this is the defect' : 'no'));
  console.log('');
  console.log('  signer               : ' + alice.address + '  (//Alice)');
  console.log('  call                 : ' + `${call.method.section}.${call.method.method}`);
  console.log('  argument new         : ' + encodeAddress(targetPub, ss58));
  console.log('    public key         : ' + targetHex);
  console.log('  call index           : ' + u8aToHex(call.method.callIndex));
  console.log('  encoded call         : ' + call.method.toHex());
  console.log('  call hash            : ' + call.method.hash.toHex());
  console.log('  human                : ' + JSON.stringify(call.method.toHuman()));
  console.log('');

  if (dryRun) {
    console.log('  DRY RUN — nothing was submitted. Sudo::Key is unchanged.');
    console.log('');
    await api.disconnect();
    return;
  }

  console.log('  SUBMITTING. This is one-way: after finalization //Alice can no');
  console.log('  longer sign root calls on this chain.');
  console.log('');

  const finalizedHash = await new Promise((resolve, reject) => {
    call.signAndSend(alice, ({ status, dispatchError, events }) => {
      if (dispatchError) {
        if (dispatchError.isModule) {
          const d = api.registry.findMetaError(dispatchError.asModule);
          return reject(new Error(`${d.section}.${d.name}: ${d.docs.join(' ')}`));
        }
        return reject(new Error(dispatchError.toString()));
      }
      if (status.isInBlock) {
        console.log('  in block             : ' + status.asInBlock.toHex());
      }
      if (status.isFinalized) {
        for (const { event } of events) {
          console.log(`  event                : ${event.section}.${event.method} ` +
                      JSON.stringify(event.data.toHuman()));
        }
        resolve(status.asFinalized.toHex());
      }
      if (status.isDropped || status.isInvalid || status.isUsurped) {
        reject(new Error(`transaction ${status.type}`));
      }
    }).catch(reject);
  });

  console.log('  finalized in         : ' + finalizedHash);
  console.log('');

  // Read the storage item back at the finalized block rather than trusting the
  // event: the event says what the runtime emitted, the storage says what the
  // chain now holds, and it is the storage that gates root.
  const at = await api.at(finalizedHash);
  const after = (await at.query.sudo.key()).toString();
  const afterPub = after ? u8aToHex(decodeAddress(after)) : null;

  console.log('  Sudo::Key AFTER      : ' + after);
  console.log('    public key         : ' + afterPub);
  console.log('');

  await api.disconnect();

  if (afterPub !== targetHex) {
    console.error('  FAILED — Sudo::Key is not the requested address.');
    process.exit(1);
  }
  if (afterPub === ALICE_PUBKEY) {
    console.error('  FAILED — Sudo::Key is still //Alice.');
    process.exit(1);
  }
  console.log('  OK — root is now held by ' + after + ' and is no longer //Alice.');
};

main().catch((e) => { console.error('FATAL: ' + (e && e.message ? e.message : e)); process.exit(1); });
