// Lifecycle tests for pallet-auto-params against a local dev node (#185).
// Skips (loudly) when no node answers at SCALAR_WS; never targets the public testnet.
import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import type { SubmittableExtrinsic } from '@polkadot/api/types';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const WS = process.env.SCALAR_WS ?? 'ws://127.0.0.1:9955';
if (/scalarnet\.io/.test(WS)) throw new Error('refusing to run against the public testnet');

// SCALE ParamId discriminants (wire format, pinned by the pallet's unit tests).
const ALPHA = 'Alpha';

let api: ApiPromise | undefined;
let alice: ReturnType<Keyring['addFromUri']>;
let bob: ReturnType<Keyring['addFromUri']>;

async function connect(): Promise<ApiPromise | undefined> {
  const provider = new WsProvider(WS, false);
  try {
    await Promise.race([
      provider.connect().then(() => new Promise<void>((r) => provider.on('connected', () => r()))),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5_000)),
    ]);
    return await ApiPromise.create({ provider });
  } catch {
    await provider.disconnect().catch(() => {});
    return undefined;
  }
}

/** Sign+send, resolve with in-block events once included. */
function send(tx: SubmittableExtrinsic<'promise'>, signer: typeof alice) {
  return new Promise<{ events: any[]; failed?: string }>((resolve, reject) => {
    api!.rpc.system.accountNextIndex(signer.address).then((nonce) => tx.signAndSend(signer, { nonce }, (res) => {
      if (res.dispatchError) {
        const d = res.dispatchError;
        const failed = d.isModule
          ? (() => { const m = api!.registry.findMetaError(d.asModule); return `${m.section}.${m.name}`; })()
          : d.toString();
        resolve({ events: res.events.map((e) => e.event), failed });
      } else if (res.status.isInBlock) {
        resolve({ events: res.events.map((e) => e.event) });
      } else if (res.status.isInvalid || res.status.isDropped || res.status.isUsurped) {
        reject(new Error(`tx not included: ${res.status.type}`));
      }
    })).catch(reject);
  });
}

beforeAll(async () => {
  await cryptoWaitReady();
  const kr = new Keyring({ type: 'sr25519' });
  alice = kr.addFromUri('//Alice');
  bob = kr.addFromUri('//Bob');
  api = await connect();
  if (!api) console.warn(`[testkit] no node at ${WS}: auto-params lifecycle tests SKIPPED`);
});
afterAll(async () => { await api?.disconnect(); });

describe('auto-params lifecycle', () => {
  it('bounds are seeded and readable', async (ctx) => {
    if (!api) return ctx.skip();
    const b = (await api.query.autoParams.alphaBounds()).toJSON() as any;
    expect(b).not.toBeNull();
    expect(b.min).toBeLessThanOrEqual(b.max);
    expect(b.maxStep ?? b.max_step).toBeGreaterThan(0);
  });

  it('signed set_param is BadOrigin: no event, storage unchanged (E13)', async (ctx) => {
    if (!api) return ctx.skip();
    const before = (await api.query.autoParams.alpha()).toString();
    const { events, failed } = await send(api.tx.autoParams.setParam(ALPHA, 2000), bob);
    expect(failed).toBe('BadOrigin');
    expect(events.some((e) => e.section === 'autoParams')).toBe(false);
    expect((await api.query.autoParams.alpha()).toString()).toBe(before);
  });

  it('sudo set_param in bounds writes storage and emits ParamSetByGovernance; out of bounds is rejected', async (ctx) => {
    if (!api) return ctx.skip();
    const original = (await api.query.autoParams.alpha()).toString();
    const b = (await api.query.autoParams.alphaBounds()).toJSON() as any;
    try {
      const target = b.min;
      const ok = await send(api.tx.sudo.sudo(api.tx.autoParams.setParam(ALPHA, target)), alice);
      expect(ok.failed).toBeUndefined();
      expect(ok.events.some((e) => e.section === 'autoParams' && e.method === 'ParamSetByGovernance')).toBe(true);
      expect((await api.query.autoParams.alpha()).toString()).toBe(String(target));

      // sudo wraps the inner result in Sudid{Err}; the extrinsic itself succeeds.
      const bad = await send(api.tx.sudo.sudo(api.tx.autoParams.setParam(ALPHA, b.max + 1)), alice);
      const sudid = bad.events.find((e) => e.section === 'sudo' && e.method === 'Sudid');
      expect(JSON.stringify(sudid?.data.toJSON())).toContain('"err"');
      expect(bad.events.some((e) => e.method === 'ParamSetByGovernance')).toBe(false);
      expect((await api.query.autoParams.alpha()).toString()).toBe(String(target));
    } finally {
      await send(api.tx.sudo.sudo(api.tx.autoParams.setParam(ALPHA, Number(original))), alice);
    }
  });
});
