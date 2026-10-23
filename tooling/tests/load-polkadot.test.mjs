import assert from 'node:assert/strict';
import test from 'node:test';

import { loadPolkadot } from '../../sdk/scripts/load-polkadot.mjs';

test('operator scripts resolve polkadot-js through the shared SDK loader', async () => {
  const [{ ApiPromise, WsProvider }, { Keyring }, { cryptoWaitReady }] = await Promise.all([
    loadPolkadot('@polkadot/api'),
    loadPolkadot('@polkadot/keyring'),
    loadPolkadot('@polkadot/util-crypto'),
  ]);

  assert.equal(typeof ApiPromise.create, 'function');
  assert.equal(typeof WsProvider, 'function');
  assert.equal(typeof Keyring, 'function');
  assert.equal(typeof cryptoWaitReady, 'function');
});
