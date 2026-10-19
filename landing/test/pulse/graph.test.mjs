// Unit tests for the plate's pure helpers (src/pulse/graph.js): a point from
// an agents item, a thread from an escrows item, the neighbourhood a followed
// agent keeps bright, the parties of an agreement key, the deterministic
// settlement burst, the device-pixel-ratio cap and the palette's rgba. The
// canvas itself is exercised by the smoke harness in headless Chromium, not
// here: force-graph needs a canvas to paint on, and these tests have none.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agreementKey, nodeValue } from '../../src/pulse/model.js';
import { shortAddress } from '../../src/observatory/format.js';

// force-graph's wrapper reads window.innerWidth and innerHeight when its
// module is evaluated (the canvas's default size), so Node needs a window
// before graph.js can be imported. Nothing else touches it at import time.
globalThis.window ??= { innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1 };
const {
  createGraph,
  nodeOf,
  linkOf,
  neighbourhood,
  burstParticles,
  partiesOfKey,
  capDevicePixelRatio,
  rgba,
  endId,
  DPR_MAX,
  NODE_REL_SIZE,
  BURST_COUNT,
  DIM_ALPHA,
} = await import('../../src/pulse/graph.js');

const BUYER = '5Ck2fakeBuyerAddressAAAAAAAAAAAAAAAAAAAAAAAAXDEq';
const PROVIDER = '5Fy9fakeProviderAddressBBBBBBBBBBBBBBBBBBBBBBQpR2';
const OTHER = '5Hx1fakeOtherAddressCCCCCCCCCCCCCCCCCCCCCCCCCCMz7';

test('the contract names are exported', () => {
  for (const fn of [createGraph, nodeOf, linkOf, neighbourhood, burstParticles]) assert.equal(typeof fn, 'function');
  assert.equal(DPR_MAX, 2);
  assert.ok(NODE_REL_SIZE > 0);
  assert.equal(BURST_COUNT, 12);
  assert.ok(DIM_ALPHA > 0 && DIM_ALPHA < 0.3);
});

test('nodeOf: the contract fields, the name from the names map, the operator ring from the swarm- prefix', () => {
  const names = new Map([[BUYER, 'swarm-0042']]);
  const node = nodeOf({ address: BUYER, activeEscrowCount: 4, completedAgreements: 18 }, names);
  assert.equal(node.id, BUYER);
  assert.equal(node.name, 'swarm-0042');
  assert.equal(node.operator, true);
  assert.equal(node.val, nodeValue(4));
  assert.equal(node.completed, 18);
  assert.equal(node.disputed, false);
  assert.equal(node.alpha, 1);
});

test('nodeOf: no name means the shortened address and no ring; a named but not swarm- agent has no ring', () => {
  const plain = nodeOf({ address: PROVIDER, activeEscrowCount: 0, completedAgreements: 0 }, new Map());
  assert.equal(plain.name, shortAddress(PROVIDER));
  assert.equal(plain.name, '5Fy9…QpR2');
  assert.equal(plain.operator, false);
  assert.equal(plain.val, nodeValue(0));
  const named = nodeOf({ address: PROVIDER, name: 'atlas', activeEscrowCount: 0, completedAgreements: 0 }, null);
  assert.equal(named.name, 'atlas');
  assert.equal(named.operator, false);
});

test('nodeOf: a counted hour of activity sizes the point ahead of the open-escrow figure; junk counts as none', () => {
  const counted = nodeOf({ address: BUYER, activityLastHour: 9, activeEscrowCount: 1 }, null);
  assert.equal(counted.val, nodeValue(9));
  const junk = nodeOf({ address: BUYER, activeEscrowCount: 'many' }, null);
  assert.equal(junk.val, nodeValue(0));
  const busy = nodeOf({ address: BUYER, activityLastHour: 10_000 }, null);
  assert.equal(busy.val, 6);
});

test('linkOf: buyer → provider, keyed as the chain keys the agreement, with its status', () => {
  const link = linkOf({ buyer: BUYER, provider: PROVIDER, seq: 7, status: 'Disputed', amountPlancks: '10000000000000' });
  assert.equal(link.id, agreementKey(BUYER, PROVIDER, 7));
  assert.equal(link.source, BUYER);
  assert.equal(link.target, PROVIDER);
  assert.equal(link.seq, 7);
  assert.equal(link.status, 'Disputed');
  assert.equal(link.alpha, 1);
  assert.equal(linkOf({ buyer: BUYER, provider: PROVIDER, seq: 1, status: 'Delivered' }).status, 'Delivered');
  assert.equal(linkOf({ buyer: BUYER, provider: PROVIDER, seq: 1, status: 'Created' }).status, 'Created');
  assert.equal(linkOf({ buyer: BUYER, provider: PROVIDER, seq: 1 }).status, 'Created', 'an unknown status reads as open');
});

test('neighbourhood: the agent and every agent it has a thread with, whether the ends are ids or resolved nodes', () => {
  const links = [
    { source: BUYER, target: PROVIDER },
    { source: { id: OTHER }, target: { id: BUYER } },
    { source: PROVIDER, target: OTHER },
  ];
  const hood = neighbourhood(links, BUYER);
  assert.deepEqual([...hood].sort(), [BUYER, OTHER, PROVIDER].sort());
  const far = neighbourhood([{ source: PROVIDER, target: OTHER }], BUYER);
  assert.deepEqual([...far], [BUYER], 'an agent with no thread keeps only itself bright');
  assert.equal(endId({ id: 'x' }), 'x');
  assert.equal(endId('y'), 'y');
});

test('partiesOfKey: round-trips model.agreementKey and refuses anything else', () => {
  const key = agreementKey(BUYER, PROVIDER, 12);
  assert.deepEqual(partiesOfKey(key), { buyer: BUYER, provider: PROVIDER, seq: '12' });
  assert.equal(partiesOfKey('nonsense'), null);
  assert.equal(partiesOfKey(`${BUYER}>${PROVIDER}#`), null);
  assert.equal(partiesOfKey(`>${PROVIDER}#1`), null);
  assert.equal(partiesOfKey(`${BUYER}>#1`), null);
  assert.equal(partiesOfKey(null), null);
});

test('burstParticles: n particles around the circle, the same for the same seed, different for another', () => {
  const a = burstParticles(12, 99);
  const b = burstParticles(12, 99);
  const c = burstParticles(12, 100);
  assert.equal(a.length, 12);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  for (const [i, p] of a.entries()) {
    assert.ok(p.angle >= -0.2 && p.angle < Math.PI * 2 + 0.2, 'angle near the circle');
    assert.ok(p.speed >= 0.6 && p.speed <= 1, 'speed in range');
    assert.ok(p.size >= 0.5 && p.size <= 1, 'size in range');
    if (i > 0) assert.ok(p.angle > a[i - 1].angle, 'spread around the circle in order');
  }
  assert.equal(burstParticles(0, 1).length, 0);
});

test('capDevicePixelRatio: a ratio above the cap paints at the cap, one below is left alone, and the cap is idempotent', () => {
  const retina = { devicePixelRatio: 3 };
  assert.equal(capDevicePixelRatio(retina, 2), 2);
  assert.equal(retina.devicePixelRatio, 2);
  const before = Object.getOwnPropertyDescriptor(retina, 'devicePixelRatio').get;
  assert.equal(capDevicePixelRatio(retina, 2), 2);
  assert.equal(Object.getOwnPropertyDescriptor(retina, 'devicePixelRatio').get, before, 'not wrapped twice');
  const laptop = { devicePixelRatio: 1.5 };
  assert.equal(capDevicePixelRatio(laptop, 2), 1.5);
  // A window that exposes the ratio through a getter, as browsers do, is read through it and follows it.
  let native = 4;
  const live = {};
  Object.defineProperty(live, 'devicePixelRatio', { get: () => native, configurable: true });
  assert.equal(capDevicePixelRatio(live, 2), 2);
  native = 1.25;
  assert.equal(live.devicePixelRatio, 1.25, 'a monitor change below the cap shows through');
  const none = {};
  assert.equal(capDevicePixelRatio(none, 2), 1, 'no ratio at all reads as 1');
});

test('rgba: a theme hex at an alpha; junk is an error, never a guessed colour', () => {
  assert.equal(rgba('#5fd0c2', 0.14), 'rgba(95, 208, 194, 0.14)');
  assert.equal(rgba('rgb(230, 162, 60)', 1), 'rgba(230, 162, 60, 1)');
  assert.throws(() => rgba('', 1), /not a colour/);
  assert.throws(() => rgba('var(--accent)', 1), /not a colour/);
});
