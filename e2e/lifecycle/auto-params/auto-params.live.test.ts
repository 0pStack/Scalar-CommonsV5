// Lifecycle tests for pallet-auto-params against a local dev node.
import type { ApiPromise } from '@polkadot/api';
import type { KeyringPair } from '@polkadot/keyring/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectLiveSuite, devAccounts, submit } from '../../support/chain.js';

const WS = process.env.SCALAR_WS ?? 'ws://127.0.0.1:9955';
if (/scalarnet\.io/.test(WS)) throw new Error('refusing to run against the public testnet');

const ALPHA = 'Alpha';
const liveApi = await connectLiveSuite('auto-params lifecycle', WS);
const liveDescribe = liveApi ? describe : describe.skip;
let api = liveApi as ApiPromise;
let alice: KeyringPair;
let bob: KeyringPair;

beforeAll(async () => {
  if (!liveApi) return;
  api = liveApi;
  ({ Alice: alice, Bob: bob } = await devAccounts(['Alice', 'Bob']));
});

afterAll(async () => {
  await liveApi?.disconnect();
});

liveDescribe('auto-params lifecycle', () => {
  it('bounds are seeded and readable', async () => {
    const bounds = (await api.query.autoParams.alphaBounds()).toJSON() as any;
    expect(bounds).not.toBeNull();
    expect(bounds.min).toBeLessThanOrEqual(bounds.max);
    expect(bounds.maxStep ?? bounds.max_step).toBeGreaterThan(0);
  });

  it('signed set_param is BadOrigin: no event, storage unchanged (E13)', async () => {
    const before = (await api.query.autoParams.alpha()).toString();
    const outcome = await submit(api, api.tx.autoParams.setParam(ALPHA, 2000), bob, {
      resolveDispatchError: true,
    });
    expect(outcome.error).toBe('BadOrigin');
    expect(outcome.events.some(({ event }) => event.section === 'autoParams')).toBe(false);
    expect((await api.query.autoParams.alpha()).toString()).toBe(before);
  });

  it('sudo set_param in bounds writes storage and rejects out of bounds', async () => {
    const original = (await api.query.autoParams.alpha()).toString();
    const bounds = (await api.query.autoParams.alphaBounds()).toJSON() as any;
    try {
      const target = bounds.min;
      const ok = await submit(
        api,
        api.tx.sudo.sudo(api.tx.autoParams.setParam(ALPHA, target)),
        alice,
      );
      expect(ok.error).toBeUndefined();
      expect(
        ok.events.some(
          ({ event }) => event.section === 'autoParams' && event.method === 'ParamSetByGovernance',
        ),
      ).toBe(true);
      expect((await api.query.autoParams.alpha()).toString()).toBe(String(target));

      const bad = await submit(
        api,
        api.tx.sudo.sudo(api.tx.autoParams.setParam(ALPHA, bounds.max + 1)),
        alice,
      );
      const sudid = bad.events.find(
        ({ event }) => event.section === 'sudo' && event.method === 'Sudid',
      );
      expect(JSON.stringify(sudid?.event.data.toJSON())).toContain('"err"');
      expect(bad.events.some(({ event }) => event.method === 'ParamSetByGovernance')).toBe(false);
      expect((await api.query.autoParams.alpha()).toString()).toBe(String(target));
    } finally {
      await submit(
        api,
        api.tx.sudo.sudo(api.tx.autoParams.setParam(ALPHA, Number(original))),
        alice,
      );
    }
  });
});
