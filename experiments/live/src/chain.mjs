/**
 * Chain access: connect, fund fresh accounts from //Alice, submit and wait.
 *
 * Everything here talks to a real node. There are no fixtures and no recorded
 * ledger — the previous generation of this tooling imported no transport at all
 * (`recording-sdk.ts` appended to an in-memory array), which is why ENDGOAL
 * §3.4's launch gate had never actually been executed against a chain.
 * TESTNETAUDIT.md §6 I-7.
 */

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
function load(pkg) {
  const req = createRequire(pathResolve(HERE, '../package.json'));
  return import(pathToFileURL(req.resolve(pkg)).href);
}
const { ApiPromise, WsProvider } = await load('@polkadot/api');
const { Keyring } = await load('@polkadot/keyring');
const { cryptoWaitReady, mnemonicGenerate, blake2AsU8a } = await load('@polkadot/util-crypto');

export async function connect(endpoint) {
  await cryptoWaitReady();
  const api = await ApiPromise.create({ provider: new WsProvider(endpoint) });
  return api;
}

export function keyringFor(api) {
  return new Keyring({ type: 'sr25519', ss58Format: api.registry.chainSS58 ?? 42 });
}

/**
 * A run-scoped mnemonic, so every run uses accounts that have never existed.
 *
 * Reusing accounts across runs would let one run's leftover stake, era volume
 * or rank leak into the next run's "net", and the resulting number would be
 * unattributable. The mnemonic is printed so a run can be re-derived and
 * audited after the fact.
 */
export function newRunSeed() {
  return mnemonicGenerate(12);
}

export function deriveAccount(kr, runSeed, label) {
  return kr.addFromUri(`${runSeed}//${label}`);
}

/** Deterministic 32-byte hash for deliverable/answer/question fields. */
export function hash32(text) {
  return blake2AsU8a(text, 256);
}

/**
 * Submit and wait for FINALIZATION, returning the dispatch outcome.
 *
 * Resolves `{ ok: false, error }` on a module error rather than throwing: a
 * refused extrinsic is a measurement, not a crash. The caller decides whether
 * a refusal ends the strategy or is the point of it.
 */
export function submit(api, tx, signer, { tip = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let unsub;
    tx.signAndSend(signer, { tip }, (result) => {
      const { status, dispatchError, events } = result;
      if (dispatchError) {
        let msg;
        if (dispatchError.isModule) {
          const d = api.registry.findMetaError(dispatchError.asModule);
          msg = `${d.section}.${d.name}`;
        } else {
          msg = dispatchError.toString();
        }
        if (unsub) unsub();
        return resolve({ ok: false, error: msg, events: [] });
      }
      if (status.isFinalized) {
        const evs = events.map(({ event }) => `${event.section}.${event.method}`);
        if (unsub) unsub();
        return resolve({ ok: true, blockHash: status.asFinalized.toHex(), events: evs });
      }
      if (status.isDropped || status.isInvalid || status.isUsurped) {
        if (unsub) unsub();
        return resolve({ ok: false, error: `transaction ${status.type}`, events: [] });
      }
    })
      .then((u) => { unsub = u; })
      .catch(reject);
  });
}

/**
 * Fund `to` from //Alice and wait for finalization.
 *
 * transferKeepAlive, not transfer: draining //Alice below the existential
 * deposit mid-run would reap the one account every archetype depends on.
 */
export async function fundFromAlice(api, kr, to, plancks) {
  const alice = kr.addFromUri('//Alice');
  return submit(api, api.tx.balances.transferKeepAlive(to, plancks), alice);
}

/**
 * Spendable balance = free - frozen.
 *
 * NOT `data.free`. pallet-agents holds stake with LockableCurrency's set_lock,
 * not `reserve`, so a staked agent's `free` STILL CONTAINS its bonded stake and
 * only `frozen` reveals it. Measured on a live wash account: free 2949.6995,
 * frozen 1000.0000, reserved 0.0000.
 *
 * The first version of this runner used `data.free` and reported the wash
 * trader at -100.60 CMN — the two registration fees and change — while
 * silently treating 2 000 CMN of locked stake as money the strategy still had.
 * An archetype that ends an era with its stake bonded has not recovered it, and
 * a ring-farming row that ignores that reads as nearly free.
 *
 * `reserved` is returned separately because escrow holds in-flight agreement
 * amounts there; it is money the archetype has committed but not yet lost, so
 * it is reported rather than folded silently into either side.
 */
export async function balanceOf(api, address) {
  const a = await api.query.system.account(address);
  const free = a.data.free.toBigInt();
  const frozen = a.data.frozen.toBigInt();
  const reserved = a.data.reserved.toBigInt();
  const spendable = free > frozen ? free - frozen : 0n;
  return { free, frozen, reserved, spendable };
}

/** Emissions currently claimable by `address`, via the runtime API if present. */
export async function claimable(api, address) {
  try {
    if (api.call?.emissionsApi?.pendingRewards) {
      const v = await api.call.emissionsApi.pendingRewards(address);
      return BigInt(v.toString());
    }
  } catch { /* fall through */ }
  return 0n;
}

export async function head(api) {
  return (await api.rpc.chain.getHeader()).number.toNumber();
}

/** Resolve once the chain reaches `target`, reporting progress. */
export async function waitForBlock(api, target, onTick = () => {}) {
  let now = await head(api);
  if (now >= target) return now;
  return new Promise((resolve, reject) => {
    api.rpc.chain.subscribeNewHeads((h) => {
      now = h.number.toNumber();
      onTick(now, target);
      if (now >= target) resolve(now);
    }).catch(reject);
  });
}
