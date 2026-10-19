// Unit tests for the observatory's pure modules: SCALE decoding, SS58 and
// blake2b, formatting, and the chain-pulse stream model.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  hexToBytes,
  bytesToHex,
  readCompact,
  decodeCompactLength,
  decodeFixedVec,
  decodeValidators,
  decodeBabeAuthorities,
  decodeQueuedKeys,
  decodeBabePreDigest,
  babePreDigestOf,
} from '../src/observatory/scale.js';
import { blake2b, base58Encode, encodeSs58 } from '../src/observatory/ss58.js';
import {
  formatInteger,
  relativeTime,
  formatDuration,
  shortAddress,
  shortHash,
  formatCmn,
  cmnNumber,
} from '../src/observatory/format.js';
import { field, countSince, pageOf, fetchAllPages, Scheduler, SOURCES } from '../src/observatory/data.js';
import {
  Stream,
  cadenceOf,
  rateOf,
  stallBase,
  INDEX_WINDOW,
  LIVE_MIN,
  STALL_MS,
  MIN_RATE,
  median,
  timestampOf,
  barHeight,
  trailAlpha,
  riverLayout,
  polledNote,
  TRAIL,
} from '../src/observatory/instruments/pulse.js';
import { stateWord, sealingPhrase, liveWord, init as initStatusBar, SEALING_GRACE_MS, FINALITY_LAG_ALERT, LATE_MS } from '../src/observatory/statusbar.js';
import * as presenterModule from '../src/observatory/presenter.js';
import { stepFor, keyAction, init as initPresenter, ADVANCE_MS } from '../src/observatory/presenter.js';
import { start as startReveal } from '../src/observatory/reveal.js';
import { payoutTotal } from '../src/observatory/instruments/economy.js';
import { SOURCES_PREF_KEY, readSourcesPreference, writeSourcesPreference, init as initSources } from '../src/observatory/sources.js';
import { railPositions } from '../src/observatory.mjs';

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

test('compact integers in all four modes', () => {
  assert.deepEqual(readCompact(hexToBytes('0x00')), { value: 0, next: 1 });
  assert.deepEqual(readCompact(hexToBytes('0x14')), { value: 5, next: 1 });
  assert.deepEqual(readCompact(hexToBytes('0x0101')), { value: 64, next: 2 });
  assert.deepEqual(readCompact(hexToBytes('0xb501')), { value: 109, next: 2 });
  assert.deepEqual(readCompact(hexToBytes('0x02000100')), { value: 16384, next: 4 });
  assert.deepEqual(readCompact(hexToBytes('0x0300000040')), { value: 1 << 30, next: 5 });
  assert.equal(decodeCompactLength('0x14aabb'), 5);
  assert.throws(() => decodeCompactLength('0x'), /empty/);
  assert.throws(() => decodeCompactLength(null), /hex/);
  assert.throws(() => readCompact(hexToBytes('0x01')), /truncated/);
});

test('fixed-entry vectors refuse a length that does not fit', () => {
  const five = `0x14${'ab'.repeat(32 * 5)}`;
  assert.equal(decodeValidators(five).length, 5);
  assert.equal(decodeValidators(five)[4].length, 32);
  assert.throws(() => decodeFixedVec(`0x14${'ab'.repeat(32 * 5 - 1)}`, 32), /expected 161/);
  assert.throws(() => decodeFixedVec(`0x14${'ab'.repeat(32 * 5 + 1)}`, 32), /bytes/);
});

test('Babe.Authorities and Session.QueuedKeys layouts', () => {
  const key = (n) => n.toString(16).padStart(2, '0').repeat(32);
  const authorities = `0x08${key(1)}0100000000000000${key(2)}0200000000000000`;
  const decoded = decodeBabeAuthorities(authorities);
  assert.equal(decoded.length, 2);
  assert.equal(hex(decoded[0].key), key(1));
  assert.equal(decoded[1].weight, 2);
  const queued = `0x04${key(9)}${key(1)}${key(2)}${key(3)}`;
  const [entry] = decodeQueuedKeys(queued);
  assert.equal(hex(entry.stash), key(9));
  assert.equal(hex(entry.babe), key(1));
  assert.equal(hex(entry.grandpa), key(2));
  assert.equal(hex(entry.authorityDiscovery), key(3));
});

test('BABE pre-digest: as seen on the live chain', () => {
  // Secondary plain, authority 1, from a real header on rpc.scalarnet.io.
  const secondary = decodeBabePreDigest('0x0642414245340201000000c0fcc91100000000');
  assert.deepEqual(secondary, { kind: 'secondary-plain', authorityIndex: 1, slot: 0x11c9fcc0 });
  // Primary (109-byte payload, two-byte compact prefix 0xb501), authority 0.
  const primary = decodeBabePreDigest(`0x0642414245b5010100000000c1fcc91100000000${'00'.repeat(96)}`);
  assert.equal(primary.kind, 'primary');
  assert.equal(primary.authorityIndex, 0);
  assert.equal(decodeBabePreDigest('0x05424142450101bcee'), null); // a seal, not a pre-runtime digest
  assert.throws(() => decodeBabePreDigest('0x0642414245340901000000c0fcc91100000000'), /variant/);
  assert.equal(babePreDigestOf({ digest: { logs: ['0x05424142450101bc', '0x0642414245340201000000c0fcc91100000000'] } }).authorityIndex, 1);
  assert.equal(babePreDigestOf({ digest: { logs: [] } }), null);
  assert.equal(bytesToHex(hexToBytes('0x00ff10')), '0x00ff10');
});

test('blake2b-512 matches the reference vector for "abc"', () => {
  const digest = blake2b(new TextEncoder().encode('abc'), 64);
  assert.equal(
    hex(digest),
    'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923',
  );
  // And for the empty message.
  assert.equal(
    hex(blake2b(new Uint8Array(0), 64)).slice(0, 32),
    '786a02f742015903c6c6fd852552d272',
  );
});

test('SS58 encoding reproduces well-known addresses', () => {
  // Alice on the generic (42) network.
  const alice = hexToBytes('0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d');
  assert.equal(encodeSs58(alice, 42), '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY');
  assert.equal(base58Encode(new Uint8Array([0, 0, 1])), '112');
  assert.throws(() => encodeSs58(new Uint8Array(31)), /32-byte/);
});

test('formatting helpers', () => {
  assert.equal(formatInteger(819086), '819,086');
  const now = Date.parse('2026-09-29T14:00:00Z');
  assert.equal(relativeTime(now - 30_000, now), 'less than a minute ago');
  assert.equal(relativeTime(now - 5 * 3600_000, now), '5 hours ago');
  assert.equal(relativeTime(now - 72 * 3600_000, now), '3 days ago');
  assert.equal(formatDuration(40), 'about 40 s');
  assert.equal(formatDuration(6120), 'about 1 h 42 min');
  assert.equal(formatDuration(3600), 'about 1 h');
  assert.equal(formatDuration(90), 'about 2 min');
  assert.equal(shortAddress('5Ck2miBfCe1JQ4cY3NDsXyBaD6EcsgiVmEFTWwqNSs25XDEq'), '5Ck2…XDEq');
  assert.equal(shortHash('9b67d2f14ce062442f6d6abe158fa2bf95d47b9ac7b45e2901f3e065ae60ed2a'), '9b67d2f1…ae60ed2a');
  assert.equal(formatCmn('1000000000000000'), '1,000');
  assert.equal(formatCmn('1999999999999999'), '1,999');
  assert.equal(cmnNumber('1500000000000'), 1.5);
});

test('field() refuses to guess; countSince and pageOf', () => {
  assert.equal(field({ chain: { bestBlock: 7 } }, 'chain.bestBlock'), 7);
  assert.equal(field({ items: [{ blockNumber: 3 }] }, 'items.0.blockNumber'), 3);
  assert.throws(() => field({ chain: {} }, 'chain.bestBlock'), /chain\.bestBlock/);
  assert.throws(() => field(null, 'chain'), /chain/);
  assert.deepEqual(countSince([{ blockNumber: 30 }, { blockNumber: 20 }, { blockNumber: 10 }], 20), {
    count: 2,
    reachedStart: true,
  });
  assert.equal(pageOf(SOURCES.registrations, 200), `${SOURCES.registrations.path}&offset=200`);
});

test('fetchAllPages walks a list and says whether it got everything', async () => {
  const pages = [
    { ok: true, data: { total: 5, items: [1, 2] } },
    { ok: true, data: { total: 5, items: [3, 4] } },
    { ok: true, data: { total: 5, items: [5] } },
  ];
  let calls = 0;
  const fetcher = async () => pages[calls++];
  const all = await fetchAllPages({ kind: 'api', path: '/x?limit=2' }, { fetcher, maxPages: 5 });
  assert.deepEqual(all.items, [1, 2, 3, 4, 5]);
  assert.equal(all.complete, true);
  calls = 0;
  const capped = await fetchAllPages({ kind: 'api', path: '/x?limit=2' }, { fetcher, maxPages: 2 });
  assert.deepEqual(capped.items, [1, 2, 3, 4]);
  assert.equal(capped.complete, false);
  calls = 0;
  const failing = await fetchAllPages(
    { kind: 'api', path: '/x' },
    { fetcher: async () => ({ ok: false, error: 'HTTP 502' }) },
  );
  assert.equal(failing.ok, false);
  assert.equal(failing.complete, false);
});

test('fetchAllPages reads a newest-first event list only back to a block, and says when the cap stopped it first', async () => {
  const ev = (blockNumber) => ({ blockNumber });
  const pages = [
    { ok: true, data: { total: 9, items: [ev(120), ev(110), ev(105)] } },
    { ok: true, data: { total: 9, items: [ev(101), ev(99), ev(90)] } },
    { ok: true, data: { total: 9, items: [ev(80), ev(70), ev(60)] } },
  ];
  let calls = 0;
  const fetcher = async () => pages[calls++];
  const source = (since) => ({ kind: 'api', path: '/x?limit=3', stopBelow: () => since });
  // The second page reaches below block 100: no third page is read.
  const hour = await fetchAllPages(source(100), { fetcher, maxPages: 10 });
  assert.equal(calls, 2);
  assert.equal(hour.since, 100);
  assert.equal(hour.reachedStart, true);
  assert.deepEqual(countSince(hour.items, hour.since), { count: 4, reachedStart: true });
  // The cap stops the read before the start: the count is a floor.
  calls = 0;
  const capped = await fetchAllPages(source(50), { fetcher, maxPages: 2 });
  assert.equal(capped.reachedStart, false);
  // The list ends before the start: everything since it is in hand.
  calls = 0;
  const whole = await fetchAllPages(source(10), { fetcher, maxPages: 10 });
  assert.equal(whole.complete, true);
  assert.equal(whole.reachedStart, true);
  // A failure carries no start reached, and no source without `stopBelow` gets the fields.
  const failing = await fetchAllPages(source(100), { fetcher: async () => ({ ok: false, error: 'HTTP 502' }) });
  assert.equal(failing.reachedStart, false);
  calls = 0;
  assert.equal('reachedStart' in (await fetchAllPages({ kind: 'api', path: '/x?limit=3' }, { fetcher, maxPages: 1 })), false);
});

test('Scheduler fetches a shared source once per interval and pauses', async () => {
  let fetches = 0;
  const scheduler = new Scheduler(async () => ({ ok: true, n: ++fetches }));
  const seen = [];
  const stopA = scheduler.watch('s', { kind: 'api' }, (r) => seen.push(['a', r.n]), 50);
  const stopB = scheduler.watch('s', { kind: 'api' }, (r) => seen.push(['b', r.n]), 1000);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, [['a', 1], ['b', 1]]);
  scheduler.pause();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(fetches, 1, 'no fetch while paused');
  scheduler.resume();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(fetches, 2);
  stopA();
  stopB();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(fetches, 2, 'no fetch after every watcher left');
});

test('Stream: seeding, arrival, forks and finality', () => {
  const s = new Stream();
  s.seed({ number: 10, id: '10:a', at: 1_000, count: 1 });
  s.seed({ number: 11, id: '11:a', at: 7_000, count: 3 });
  s.seed({ number: 12, id: '12:a', at: 13_000, count: 1 });
  assert.equal(s.best, 12);
  assert.deepEqual(s.head({ number: 13, id: '13:a', arrivedAt: 19_000 }), { added: true, advanced: true, superseded: 0 });
  // A live head is placed at its arrival less the learned offset (none yet), with its count unknown.
  const live = s.blocks.find((b) => b.id === '13:a');
  assert.equal(live.at, 19_000);
  assert.equal(live.count, null);
  assert.equal(live.settle, 0);
  // A competing head at the same height supersedes the earlier one.
  assert.deepEqual(s.head({ number: 13, id: '13:b', arrivedAt: 19_500 }), { added: true, advanced: false, superseded: 1 });
  assert.deepEqual(
    s.chain().map((b) => b.id),
    ['13:b', '12:a', '11:a', '10:a'],
  );
  assert.equal(s.blocks.filter((b) => b.superseded).length, 1);
  // A head below the best means a re-org: everything above it is superseded.
  s.head({ number: 12, id: '12:z', arrivedAt: 20_000 });
  assert.equal(s.best, 12);
  assert.deepEqual(s.chain()[0].id, '12:z');
  assert.equal(s.lag(), null);
  const fin = s.finalize(11, 21_000);
  assert.equal(fin.advanced, true);
  assert.deepEqual(
    fin.settled.map((b) => b.id),
    ['10:a', '11:a'],
    'the blocks that just became final are returned so the view can settle them',
  );
  assert.equal(s.lag(), 1);
  assert.deepEqual(s.finalize(11, 22_000), { advanced: false, settled: [] });
  const cadence = rateOf(s.blocks);
  // Three surviving blocks (10, 11, 12:z) span 1 000 → 20 000 ms: two heights.
  assert.ok(Math.abs(cadence.perMinute - 60_000 / ((20_000 - 1_000) / 2)) < 1e-9);
  // Fewer than LIVE_MIN live blocks: the rate is the indexed ones' alone (10 and 11), never mixed with the live head.
  assert.deepEqual([cadenceOf(s.blocks).source, cadenceOf(s.blocks).from, cadenceOf(s.blocks).to], ['index', 10, 11]);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(cadenceOf([]), null);
});

test('the rate on load is the index’s last 200 block times, even when a live block arrives hours past the index (the 0.1 a minute bug)', () => {
  assert.equal(INDEX_WINDOW, 200);
  assert.equal(LIVE_MIN, 10);
  assert.equal(STALL_MS, 60_000);
  assert.equal(MIN_RATE, 1);
  // The index stopped 17.7 h behind the head; its last 200 blocks are six seconds apart.
  const t0 = 1_791_145_296_001;
  const s = new Stream();
  for (let k = 0; k < 200; k += 1) s.seed({ number: 894_531 + k, id: `${894_531 + k}:i`, at: t0 + k * 6_000, count: 1 });
  const arrived = t0 + 199 * 6_000 + 17.7 * 3_600_000;
  s.head({ number: 905_363, id: '905363:a', arrivedAt: arrived });
  // The old reading: the last 60 timed blocks, 59 indexed and one live, over 59 intervals.
  const timed = s.blocks.filter((b) => Number.isFinite(b.at)).slice(-60);
  const old = 60_000 / ((timed.at(-1).at - timed[0].at) / (timed.length - 1));
  assert.ok(old < 0.1, `the bug: ${old.toFixed(3)} a minute`);
  const onLoad = cadenceOf(s.blocks, { now: arrived + 1_000, lastArrival: arrived });
  assert.equal(onLoad.source, 'index');
  assert.ok(Math.abs(onLoad.perMinute - 10) < 1e-9, `${onLoad.perMinute} a minute`);
  assert.deepEqual([onLoad.blocks, onLoad.from, onLoad.to], [200, 894_531, 894_730]);
  // Nine more live blocks (ten in all): the rate becomes this page's own observation.
  for (let k = 1; k < LIVE_MIN - 1; k += 1) s.head({ number: 905_363 + k, id: `${905_363 + k}:a`, arrivedAt: arrived + k * 6_000 });
  assert.equal(cadenceOf(s.blocks).source, 'index', 'nine live blocks: still the index');
  s.head({ number: 905_372, id: '905372:a', arrivedAt: arrived + 9 * 6_000 });
  const live = cadenceOf(s.blocks, { now: arrived + 9 * 6_000 + 500, lastArrival: arrived + 9 * 6_000 });
  assert.equal(live.source, 'live');
  assert.ok(Math.abs(live.perMinute - 10) < 1e-9);
  assert.deepEqual([live.from, live.to], [905_363, 905_372], 'live blocks only, never mixed with the index');
});

test('a rate is elapsed time over elapsed heights; a stall says "stalled"; nothing below one a minute is ever a rate', () => {
  // A missed head in the run is a gap, not one slow block.
  assert.equal(rateOf([{ number: 1, at: 0 }, { number: 101, at: 600_000 }]).perMinute, 10);
  assert.equal(rateOf([{ number: 5, at: 1_000 }, { number: 5, at: 2_000 }]), null);
  const index = Array.from({ length: 20 }, (_, k) => ({ number: k, at: k * 6_000, live: false, superseded: false }));
  // No new block for more than 60 s: stalled, whatever the history says.
  assert.deepEqual(cadenceOf(index, { now: 200_000, lastArrival: 139_000 }), { stalled: true, sinceMs: 61_000 });
  assert.equal(cadenceOf(index, { now: 200_000, lastArrival: 141_000 }).perMinute, 10, '59 s is not a stall');
  assert.equal(cadenceOf(index, { now: 200_000, lastArrival: null }).stalled, false, 'nothing has arrived yet: no stall to call');
  // A tab hidden for five minutes saw no blocks because it was not listening: the stall clock restarts when it is shown.
  assert.equal(stallBase(139_000, null), 139_000);
  assert.equal(stallBase(139_000, 190_000), 190_000);
  assert.equal(cadenceOf(index, { now: 200_000, lastArrival: stallBase(139_000, 190_000) }).stalled, false, 'shown 10 s ago: not stalled');
  assert.equal(stallBase(null, 190_000), null, 'nothing has arrived and the page is not listening: no stall clock at all');
  // Loaded while the chain is already stalled, with the index caught up: the head the socket
  // gives on subscribe is already in the index, so nothing ever "arrives". The clock runs from
  // when the page began listening, and 60 s later the page says "stalled".
  assert.equal(stallBase(null, null, 100_000), 100_000);
  assert.equal(cadenceOf(index, { now: 161_000, lastArrival: stallBase(null, null, 100_000) }).stalled, true, 'listening 61 s, nothing new: stalled');
  assert.equal(cadenceOf(index, { now: 159_000, lastArrival: stallBase(null, null, 100_000) }).stalled, false, 'listening 59 s: not yet');
  assert.equal(stallBase(130_000, null, 100_000), 130_000, 'once a block has arrived, the clock runs from it');
  assert.equal(stallBase(null, 150_000, 100_000), 150_000, 'a hidden spell restarts this clock too');
  // Two minutes a block is below the floor: not shown as a rate.
  const slow = index.map((b) => ({ ...b, at: b.number * 120_000 }));
  assert.equal(cadenceOf(slow), null);
});

test('Stream: a block body sets the count and the chain time, and the arrival offset is learned from it', () => {
  const s = new Stream();
  s.head({ number: 20, id: '20:a', arrivedAt: 101_200 });
  assert.equal(s.body(20, '20:a', { count: 2, at: 100_000 }), true);
  const block = s.blocks[0];
  assert.equal(block.count, 2);
  assert.equal(block.at, 100_000, 'the chain clock replaces the arrival estimate');
  assert.equal(s.offset(), 1_200);
  // The next arrival is estimated with that offset until its own body is read.
  s.head({ number: 21, id: '21:a', arrivedAt: 107_300 });
  assert.equal(s.blocks[1].at, 106_100);
  assert.equal(s.body(99, '99:a', { count: 1, at: 1 }), false, 'a body for a block not in the model is ignored');
  // Finality measures the wall-clock arrival, not the chain time.
  const fin = s.finalize(21, 110_000);
  assert.deepEqual(s.finalitySamples, [110_000 - 101_200, 110_000 - 107_300]);
  assert.equal(fin.settled.length, 2);
});

/** SCALE compact encoding, for building test vectors. */
function compact(n) {
  if (n < 64) return [n << 2];
  if (n < 2 ** 14) return [((n << 2) | 1) & 0xff, n >> 6];
  if (n < 2 ** 30) return [((n << 2) | 2) & 0xff, (n >> 6) & 0xff, (n >> 14) & 0xff, (n >> 22) & 0xff];
  const bytes = [];
  let v = BigInt(n);
  while (v > 0n) {
    bytes.push(Number(v & 0xffn));
    v >>= 8n;
  }
  return [((bytes.length - 4) << 2) | 3, ...bytes];
}
const toHex = (bytes) => `0x${bytes.map((b) => b.toString(16).padStart(2, '0')).join('')}`;

test('the timestamp inherent decodes from the first extrinsic, and nothing else passes for it', () => {
  const moment = 1_790_718_348_000; // 2026-09-29, as on the live chain
  const call = [0x04, 0x01, 0x00, ...compact(moment)];
  assert.equal(timestampOf(toHex([...compact(call.length), ...call])), moment);
  // A signed extrinsic (high bit of the version byte) is not the inherent.
  const signed = [0x84, 0x01, 0x00, ...compact(moment)];
  assert.throws(() => timestampOf(toHex([...compact(signed.length), ...signed])), /signed/);
  // Another pallet's call, or another call of the timestamp pallet, is refused rather than read as a time.
  const other = [0x04, 0x04, 0x00, ...compact(moment)];
  assert.throws(() => timestampOf(toHex([...compact(other.length), ...other])), /not timestamp\.set/);
  const otherCall = [0x04, 0x01, 0x01, ...compact(moment)];
  assert.throws(() => timestampOf(toHex([...compact(otherCall.length), ...otherCall])), /not timestamp\.set/);
  assert.throws(() => timestampOf('0x0c0401'), /too short/);
  assert.throws(() => timestampOf(toHex([...compact(3), 0x04, 0x01, 0x00])), /truncated|empty/);
});

test('bars are as tall as their extrinsic count, never off the plate, and the trail fades left', () => {
  assert.equal(barHeight(1), 0.26);
  assert.equal(barHeight(null), 0.26, 'an unread body stands at the floor');
  assert.equal(barHeight(0), 0.26);
  assert.ok(barHeight(2) > barHeight(1));
  assert.ok(Math.abs(barHeight(3) - barHeight(2) - (barHeight(2) - barHeight(1))) < 1e-12, 'each extrinsic adds one step');
  assert.ok(Math.abs(barHeight(100) - 0.94) < 1e-12, 'capped');
  assert.equal(trailAlpha(0), 1);
  assert.ok(trailAlpha(30) < trailAlpha(10));
  assert.ok(Math.abs(trailAlpha(TRAIL) - 0.16) < 1e-12, 'the oldest bar is faint, never gone');
  assert.equal(trailAlpha(10_000), 0.16);
});

test('the river holds sixty blocks on a wide plate and about two dozen on a phone, labels spaced to fit', () => {
  const wide = riverLayout(1200);
  assert.equal(wide.visible, 60);
  assert.ok(Math.abs(wide.slotPx - (1200 - 26) / 60) < 1e-9);
  assert.ok(wide.bar >= 3 && wide.bar <= 8);
  assert.equal(wide.labelEvery, Math.ceil(84 / wide.slotPx));
  const phone = riverLayout(358);
  assert.ok(phone.visible >= 20 && phone.visible < 25, `phone holds ${phone.visible}`);
  assert.ok(phone.bar >= 3 && phone.bar <= wide.bar, `phone bar ${phone.bar}, wide bar ${wide.bar}`);
  assert.ok(phone.labelEvery >= wide.labelEvery);
  assert.equal(riverLayout(100).visible, 20, 'never fewer than twenty');
});

test('polled heights are named as such: no body was read, so the bar stands at the floor', () => {
  // A height taken from /v1/status while the socket is down has no header and
  // no body: its bar can only stand at the one-extrinsic floor. The sentence's
  // provenance line must say so rather than leave a half-toned bar unexplained.
  const s = new Stream();
  s.seed({ number: 10, id: '10:a', at: 1_000, count: 1 });
  s.head({ number: 11, id: '11:b', arrivedAt: 7_000 });
  assert.equal(polledNote(s.blocks), '', 'live heads with a pending body are not polled heights');
  s.head({ number: 12, id: '12:status', arrivedAt: 13_000 });
  assert.equal(polledNote(s.blocks), '1 polled height without a body, drawn at the floor');
  s.head({ number: 13, id: '13:status', arrivedAt: 19_000 });
  assert.equal(polledNote(s.blocks), '2 polled heights without a body, drawn at the floor');
  // The socket returns and the real header for 13 supersedes the polled one: it no longer counts.
  s.head({ number: 13, id: '13:c', arrivedAt: 19_500 });
  assert.equal(polledNote(s.blocks), '1 polled height without a body, drawn at the floor');
  assert.equal(polledNote([]), '');
});

test('a figure is plain text in tabular figures: one text node, no digit cells', async () => {
  const element = () => ({ textContent: '', children: [], replaceChildren(...n) { this.children = n; } });
  const had = 'document' in globalThis;
  const before = globalThis.document;
  globalThis.document = { createTextNode: (t) => ({ nodeValue: String(t) }) };
  try {
    const readout = await import('../src/observatory/readout.js');
    assert.equal(readout.setDigits, undefined, 'the digit-cell workaround is gone');
    const node = element();
    node.children.push('stale');
    readout.setFigure(node, '847,724');
    assert.deepEqual(node.children.map((c) => c.nodeValue), ['847,724'], 'the figure is one unbroken text node, read once');
    readout.setFigure(node, 12);
    assert.deepEqual(node.children.map((c) => c.nodeValue), ['12']);
  } finally {
    if (had) globalThis.document = before;
    else delete globalThis.document;
  }
});

test('the status bar’s state word follows stated rules, worst first', () => {
  const normal = { socket: 'live', lastOk: true, seen: true, lag: 2, intervalMs: 6_000, hidden: false };
  assert.equal(stateWord(normal), 'Network normal');
  assert.equal(stateWord({ ...normal, hidden: true }), 'Paused');
  assert.equal(stateWord({ ...normal, seen: false }), 'Connecting');
  assert.equal(stateWord({ ...normal, lastOk: false }), 'Not updating');
  assert.equal(stateWord({ ...normal, seen: false, lastOk: false }), 'Not updating', 'an outage at first load is an outage, not a connection in progress');
  assert.equal(stateWord({ ...normal, lag: FINALITY_LAG_ALERT + 1 }), 'Finality lagging');
  assert.equal(stateWord({ ...normal, lag: FINALITY_LAG_ALERT }), 'Network normal');
  assert.equal(stateWord({ ...normal, intervalMs: 19_000 }), 'Blocks late');
  assert.equal(stateWord({ ...normal, socket: 'polling' }), 'Polling');
  assert.equal(stateWord({ ...normal, lag: null, intervalMs: null }), 'Network normal', 'unknowns are not faults');
});

test('the sealing phrase states the active set from the chain read, and counts who has sealed only after a minute', () => {
  // On load the page has seen a block or two: "2 of 5 seen so far" read as three validators down.
  assert.equal(sealingPhrase({ seen: 2, total: 5, sinceMs: 0 }), '5 validators in the active set');
  assert.equal(sealingPhrase({ seen: 5, total: 5, sinceMs: SEALING_GRACE_MS - 1 }), '5 validators in the active set', 'even a full count waits for the minute');
  assert.equal(sealingPhrase({ seen: 3, total: 5, sinceMs: SEALING_GRACE_MS }), '5 validators in the active set · 3 seen sealing since you opened this page');
  assert.equal(sealingPhrase({ seen: 5, total: 5, sinceMs: 600_000 }), '5 validators in the active set · 5 seen sealing since you opened this page');
  assert.equal(sealingPhrase({ seen: null, total: 5, sinceMs: 600_000 }), '5 validators in the active set', 'polling from the start: no author was ever seen');
  assert.equal(sealingPhrase({ seen: 1, total: 1, sinceMs: 600_000 }), '1 validator in the active set · 1 seen sealing since you opened this page');
  assert.equal(sealingPhrase({ seen: 2, total: null, sinceMs: 600_000 }), 'validators not yet read');
  assert.equal(sealingPhrase({ seen: 5, total: 5, sinceMs: 600_000, error: 'could not decode the set: bad length' }), 'validators unavailable · could not decode the set: bad length');
  assert.equal(sealingPhrase({ authors: null, total: null, observed: 0, error: 'HTTP 502' }), 'validators unavailable · HTTP 502');
});

// The status bar's event wiring, not only its pure helpers: the three faults
// the bar exists to flag (a finality stall, a block stall, a chain that is
// polled at one height) all live in `init`'s handlers, so these tests drive
// the real `init` against a fake root, bus and clock.

function fakeBar() {
  // Minimal DOM stand-ins: the bar only reads textContent/dataset.
  const el = () => ({ textContent: '', dataset: {}, classList: { add() {}, remove() {} }, offsetWidth: 0 });
  const nodes = { '.pulse-dot': el(), '.sb-state': el(), '.sb-validators': el(), '.sb-finality': el() };
  const root = { dataset: {}, querySelector: (s) => nodes[s] ?? null };
  const handlers = {};
  let clock = 1_000_000;
  const ctx = {
    bus: { on: (name, fn) => { (handlers[name] ||= []).push(fn); } },
    motion: { reduced: () => true },
    format: { formatInteger: (n) => String(n) },
    readout: { showValue() {}, showError() {} },
    watch() {},
    field: () => { throw new Error('not used'); },
    now: () => clock,
  };
  return {
    root, ctx, nodes,
    emit: (name, payload) => { for (const fn of handlers[name] ?? []) fn(payload); },
    advance: (ms) => { clock += ms; },
    now: () => clock,
    state: () => root.dataset.state,
  };
}

test('status bar: a finality stall is reported even though no finalized event arrives', async () => {
  const { root, ctx, emit, state } = fakeBar();
  const { init } = await import('../src/observatory/statusbar.js');
  init(root, ctx);

  emit('head', { record: { ok: true }, number: 100, author: { authorityIndex: 0 }, arrivedAt: ctx.now() });
  emit('finalized', { number: 98 });
  assert.equal(state(), 'network-normal', 'lag 2 is healthy');

  // Finality stops; blocks keep coming. No further `finalized` events.
  for (let n = 101; n <= 112; n++) {
    emit('head', { record: { ok: true }, number: n, author: { authorityIndex: n % 3 }, arrivedAt: ctx.now() });
  }
  assert.equal(state(), 'finality-lagging', 'lag must grow from heads alone');
});

test('status bar: a full block stall is reported with no event to prompt it', async () => {
  const { root, ctx, emit, advance, state } = fakeBar();
  const { init, LATE_MS, STALL_CHECK_MS } = await import('../src/observatory/statusbar.js');
  init(root, ctx);

  emit('head', { record: { ok: true }, number: 100, author: { authorityIndex: 0 }, arrivedAt: ctx.now() });
  emit('finalized', { number: 99 });
  assert.equal(state(), 'network-normal');

  // The chain dies. Nothing arrives. Only the clock moves.
  advance(LATE_MS + STALL_CHECK_MS);
  emit('visibility', { hidden: false }); // any re-render; the ticker does this unprompted in a browser
  assert.equal(state(), 'blocks-late', 'elapsed time since the last block must count');
});

test('status bar: polling that repeats the same height is not a stream of arrivals', async () => {
  const { root, ctx, emit, advance, state } = fakeBar();
  const { init, LATE_MS } = await import('../src/observatory/statusbar.js');
  init(root, ctx);

  emit('head', { record: { ok: true }, number: 100, author: null, arrivedAt: ctx.now() });
  emit('finalized', { number: 100 });

  // Polling emits a head every ~6 s whether or not the chain moved. Same
  // height each time: these are polls, not blocks.
  for (let i = 0; i < 6; i++) {
    advance(6_000);
    emit('head', { record: { ok: true }, number: 100, author: null, arrivedAt: ctx.now() });
  }
  advance(LATE_MS);
  emit('visibility', { hidden: false });
  assert.equal(state(), 'blocks-late', 'a height that never advances is a stalled chain, polling or not');
});

test('status bar: returning from a hidden tab is not a late block', async () => {
  const { root, ctx, emit, advance, state } = fakeBar();
  const { init } = await import('../src/observatory/statusbar.js');
  init(root, ctx);

  emit('head', { record: { ok: true }, number: 100, author: { authorityIndex: 0 }, arrivedAt: ctx.now() });
  emit('finalized', { number: 99 });
  emit('visibility', { hidden: true });
  advance(10 * 60_000); // ten minutes in another tab
  emit('visibility', { hidden: false });
  assert.equal(state(), 'network-normal', 'the hidden interval is not a chain fault');
});

test('sealing phrase never claims more validators than the set holds', async () => {
  const { sealingPhrase: phrase, SEALING_GRACE_MS: grace } = await import('../src/observatory/statusbar.js');
  // Validators seen before the set shrank were still seen; the count is clamped to the set.
  assert.equal(phrase({ seen: 6, total: 5, sinceMs: grace }), '5 validators in the active set · 5 seen sealing since you opened this page');
});

// A second harness for the paths the block above does not reach: the `poll`
// event, the readout calls, the validators read, and the ticker main.js drives.
function statusBarHarness() {
  const el = () => ({ textContent: '', dataset: {}, classList: { add() {}, remove() {} }, offsetWidth: 1 });
  const slots = { '.pulse-dot': el(), '.sb-state': el(), '.sb-validators': el(), '.sb-finality': el() };
  const root = { dataset: {}, querySelector: (sel) => slots[sel] ?? null };
  const listeners = new Map();
  const bus = {
    on: (name, fn) => listeners.set(name, [...(listeners.get(name) ?? []), fn]),
    emit: (name, payload) => (listeners.get(name) ?? []).forEach((fn) => fn(payload)),
  };
  const calls = { shown: [], errors: [] };
  const watches = new Map();
  let now = 1_000_000;
  const ctx = {
    bus,
    now: () => now,
    format: { formatInteger: (n) => n.toLocaleString('en-US') },
    motion: { reduced: () => false },
    readout: { showValue: (t, r, o) => calls.shown.push(o.value), showError: (t, r) => calls.errors.push(r) },
    field: (data, path) => path.split('.').reduce((v, k) => v[k], data),
    watch: (name, handler) => watches.set(name, handler),
  };
  // The hero's live line: a second view of the same state, never a second read.
  const mirrorSlots = { '.pulse-dot': el(), '.ll-state': el(), '.ll-finality': el() };
  const mirror = { dataset: {}, querySelector: (sel) => mirrorSlots[sel] ?? null };
  const controller = initStatusBar(root, ctx, { mirrors: [mirror] });
  return {
    root, slots, bus, calls, controller, watches, mirror, mirrorSlots,
    now: () => now,
    /** Advances the clock and lets the ticker ask, as main.js does every STALL_CHECK_MS. */
    tick(ms) { now += ms; controller.tick(); },
    head: (number) => bus.emit('head', { record: { ok: true }, number, header: {}, author: { authorityIndex: number % 5 }, arrivedAt: now }),
    poll: (number, finalized) => bus.emit('poll', { record: { ok: true }, number, finalized, arrivedAt: now }),
  };
}

test('status bar wiring: polled heights arrive on `poll`, carry finality, and read late when it stops', () => {
  const h = statusBarHarness();
  h.bus.emit('socket', { state: 'failed', attempts: 3 });
  h.poll(500, 498);
  h.tick(6_000);
  h.poll(501, 499);
  assert.equal(h.slots['.sb-state'].textContent, 'Polling');
  assert.equal(h.slots['.sb-finality'].textContent, 'finality 2 blocks');
  assert.equal(h.slots['.sb-validators'].textContent, 'validators not yet read');
  assert.deepEqual(h.calls.shown, [500, 501], 'each poll refreshes the figure and its provenance');
  assert.equal(h.controller.state().intervalMs, 6_000);
  for (let i = 0; i < 4; i += 1) { h.tick(6_000); h.poll(501, 499); }
  assert.equal(h.controller.state().best, 501);
  assert.equal(h.slots['.sb-state'].textContent, 'Blocks late', 'four polls at one height: the ticker said the stall');
  h.poll(502, 500);
  h.tick(6_000);
  h.poll(503, 501);
  assert.equal(h.slots['.sb-state'].textContent, 'Polling');
  // A failed poll is "Not updating", shown through the readout like a failed head.
  h.bus.emit('poll', { record: { ok: false, error: 'HTTP 502' }, number: null, finalized: null, arrivedAt: h.now() });
  assert.equal(h.slots['.sb-state'].textContent, 'Not updating');
  assert.equal(h.calls.errors.length, 1);
});

test('status bar wiring: the finality lag is held, not read from the DOM, and grows on heads alone', () => {
  const h = statusBarHarness();
  h.head(100);
  h.bus.emit('finalized', { record: { ok: true }, number: 98 });
  assert.equal(h.slots['.sb-finality'].textContent, 'finality 2 blocks');
  for (let n = 101; n <= 100 + FINALITY_LAG_ALERT + 1; n += 1) { h.tick(6_000); h.head(n); }
  assert.equal(h.slots['.sb-finality'].textContent, 'finality 9 blocks');
  assert.equal(h.slots['.sb-state'].textContent, 'Finality lagging');
  assert.deepEqual([h.controller.state().best, h.controller.state().lastFinalized], [107, 98]);
  h.tick(LATE_MS + 1);
  assert.equal(h.slots['.sb-state'].textContent, 'Finality lagging', 'the worse fault stays first');
});

test('status bar wiring: the validators read is said honestly — decoded, undecodable, or failed — and a changed set restarts the count', () => {
  const h = statusBarHarness();
  for (const n of [10, 11, 12]) { h.head(n); h.tick(6_000); }
  const validators = h.watches.get('validators');
  const five = { ok: true, data: { result: '0x' + '14' + '11'.repeat(32).repeat(5) } };
  validators(five);
  assert.equal(h.controller.state().total, 5);
  assert.equal(h.slots['.sb-validators'].textContent, '5 validators in the active set', 'the first minute states the set alone');
  h.tick(SEALING_GRACE_MS);
  assert.equal(h.slots['.sb-validators'].textContent, '5 validators in the active set · 3 seen sealing since you opened this page', 'the ticker adds the count once the minute has passed');
  const quiet = mock.method(console, 'error', () => {});
  validators({ ok: true, data: { result: '0x' + '05' + '11'.repeat(16) } });
  quiet.mock.restore();
  assert.equal(quiet.mock.callCount(), 1, 'the decode error is logged, not swallowed');
  assert.equal(h.controller.state().total, null);
  assert.match(h.slots['.sb-validators'].textContent, /^validators unavailable · could not decode the set: /);
  validators({ ok: false, error: 'HTTP 502' });
  assert.equal(h.slots['.sb-validators'].textContent, 'validators unavailable · HTTP 502');
  validators(five);
  assert.equal(h.slots['.sb-validators'].textContent, '5 validators in the active set', 'the count restarted when the set changed');
  h.head(13);
  assert.equal(h.slots['.sb-validators'].textContent, '5 validators in the active set · 1 seen sealing since you opened this page');
  // Falling back to polling adds nothing: a polled height has no author, but what was seen stays true.
  h.poll(14, 12);
  assert.equal(h.slots['.sb-validators'].textContent, '5 validators in the active set · 1 seen sealing since you opened this page');
});

test('status bar wiring: a height far below the best is a reset, not a stall', () => {
  const h = statusBarHarness();
  h.head(800_000);
  h.tick(6_000);
  h.head(800_001);
  h.bus.emit('finalized', { record: { ok: true }, number: 799_999 });
  assert.equal(h.slots['.sb-state'].textContent, 'Network normal');
  // The test network is reset: the next head is block 5.
  h.tick(6_000);
  h.head(5);
  assert.equal(h.controller.state().best, 5, 'the held height follows the reset');
  assert.equal(h.slots['.sb-finality'].textContent, 'finality —', 'the old finalized height is not compared with the new chain');
  h.tick(6_000);
  h.head(6);
  h.bus.emit('finalized', { record: { ok: true }, number: 4 });
  assert.equal(h.slots['.sb-finality'].textContent, 'finality 2 blocks');
  assert.equal(h.slots['.sb-state'].textContent, 'Network normal');
});

test('rail markers are equally spaced in order, whatever the block heights', () => {
  assert.deepEqual(railPositions(4), [8, 36, 64, 92]);
  assert.deepEqual(railPositions(1), [50]);
  assert.deepEqual(railPositions(0), []);
  const five = railPositions(5);
  for (let i = 1; i < five.length; i += 1) assert.ok(Math.abs(five[i] - five[i - 1] - 21) < 1e-9);
});

test('the Sources switch: off by default, remembered per browser, and a storage that throws is an off switch', () => {
  assert.equal(SOURCES_PREF_KEY, 'observatory:sources');
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  assert.equal(readSourcesPreference(storage), false);
  writeSourcesPreference(storage, true);
  assert.equal(store.get(SOURCES_PREF_KEY), '1');
  assert.equal(readSourcesPreference(storage), true);
  writeSourcesPreference(storage, false);
  assert.equal(store.has(SOURCES_PREF_KEY), false, 'off is the absence of the key, as a fresh browser is');
  assert.equal(readSourcesPreference(null), false);
  assert.equal(readSourcesPreference({ getItem() { throw new Error('private mode'); } }), false);
  assert.doesNotThrow(() => writeSourcesPreference({ setItem() { throw new Error('quota'); }, removeItem() { throw new Error('quota'); } }, true));

  // The switch: role=switch, aria-checked follows the attribute on <html>, a click flips both and the store.
  const html = { attrs: new Map(), setAttribute(k, v) { this.attrs.set(k, v); }, removeAttribute(k) { this.attrs.delete(k); }, hasAttribute(k) { return this.attrs.has(k); }, toggleAttribute(k, force) { if (force) this.attrs.set(k, ''); else this.attrs.delete(k); return force; } };
  const button = { attrs: new Map(), handlers: {}, setAttribute(k, v) { this.attrs.set(k, v); }, addEventListener(name, fn) { this.handlers[name] = fn; } };
  const doc = { documentElement: html, querySelector: (sel) => (sel === '.sb-sources' ? button : null), defaultView: { localStorage: storage } };
  const announced = [];
  initSources(doc, { announce: (t) => announced.push(t) });
  assert.equal(button.attrs.get('aria-checked'), 'false');
  button.handlers.click();
  assert.equal(html.hasAttribute('data-sources'), true);
  assert.equal(button.attrs.get('aria-checked'), 'true');
  assert.equal(store.get(SOURCES_PREF_KEY), '1');
  assert.match(announced.at(-1), /shown/);
  button.handlers.click();
  assert.equal(html.hasAttribute('data-sources'), false);
  assert.equal(store.has(SOURCES_PREF_KEY), false);
  // A page that booted with the attribute already set (the head script read the store) starts on.
  html.setAttribute('data-sources', '');
  const button2 = { attrs: new Map(), handlers: {}, setAttribute(k, v) { this.attrs.set(k, v); }, addEventListener(name, fn) { this.handlers[name] = fn; } };
  initSources({ ...doc, querySelector: () => button2 }, { announce() {} });
  assert.equal(button2.attrs.get('aria-checked'), 'true');
});


test('the hero’s live line says the bar’s state in a word and the finality lag, from the same reads, with no ceremony first', () => {
  assert.equal(liveWord('Network normal'), 'Live');
  for (const word of ['Connecting', 'Polling', 'Paused', 'Not updating', 'Finality lagging', 'Blocks late']) {
    assert.equal(liveWord(word), word, `${word} is said as it is, never as "Live"`);
  }
  const h = statusBarHarness();
  assert.equal(h.slots['.sb-state'].textContent, 'Connecting');
  assert.equal(h.mirrorSlots['.ll-state'].textContent, 'Connecting');
  assert.equal(h.mirrorSlots['.ll-finality'].textContent, 'finality —');
  h.bus.emit('socket', { state: 'open', attempts: 0 });
  h.head(1_000);
  h.bus.emit('finalized', { number: 998 });
  // No connection sequence: the real state word the moment a block is in.
  assert.equal(h.slots['.sb-state'].textContent, 'Network normal');
  assert.equal(h.mirrorSlots['.ll-state'].textContent, 'Live');
  assert.equal(h.mirrorSlots['.ll-finality'].textContent, 'finality 2 blocks');
  assert.equal(h.mirror.dataset.state, 'network-normal');
  h.bus.emit('poll', { record: { ok: false, error: 'HTTP 502' }, number: null, finalized: null, arrivedAt: h.now() });
  assert.equal(h.mirrorSlots['.ll-state'].textContent, 'Not updating', 'a failure is never shown as live');
  assert.equal(h.mirror.dataset.state, 'not-updating');
});

test('presenter mode is toggled by P and the Present button, never by the URL, and driven by the arrow keys', () => {
  assert.equal(presenterModule.wantsPresenter, undefined, 'no URL flag: /observatory is the one entry point');
  assert.equal(stepFor('ArrowRight', 0, 7), 1);
  assert.equal(stepFor('ArrowRight', 6, 7), 0, 'wraps');
  assert.equal(stepFor('ArrowLeft', 0, 7), 6);
  assert.equal(stepFor('Home', 5, 7), 0);
  assert.equal(stepFor('End', 2, 7), 6);
  assert.equal(stepFor(' ', 2, 7), null, 'space pauses rather than advances');
  assert.equal(stepFor('ArrowRight', 0, 0), null);
  // Off: P (either case) enters; nothing else is ours, so the arrows still scroll the page.
  assert.deepEqual(keyAction('p', 0, 7, false), { enter: true });
  assert.deepEqual(keyAction('P', 0, 7, false), { enter: true });
  for (const key of ['ArrowRight', 'Escape', ' ', 'a']) assert.equal(keyAction(key, 0, 7, false), null, `${key} is not ours off presenter mode`);
  // On: arrows go, space pauses, P or Escape leaves.
  assert.deepEqual(keyAction('ArrowRight', 0, 7, true), { go: 1 });
  assert.deepEqual(keyAction('ArrowLeft', 0, 7, true), { go: 6 });
  assert.deepEqual(keyAction(' ', 3, 7, true), { pause: true });
  assert.deepEqual(keyAction('Escape', 3, 7, true), { exit: true });
  assert.deepEqual(keyAction('p', 3, 7, true), { exit: true });
  assert.equal(keyAction('a', 3, 7, true), null);
});

/** A document just big enough for presenter.init: <html>, the screens, the button, keydown. */
function presenterHarness({ screens = 3 } = {}) {
  const attrs = () => {
    const map = new Map();
    return {
      map,
      setAttribute(k, v) { map.set(k, String(v)); },
      removeAttribute(k) { map.delete(k); },
      hasAttribute(k) { return map.has(k); },
      getAttribute(k) { return map.get(k) ?? null; },
      toggleAttribute(k, force) { if (force) map.set(k, ''); else map.delete(k); return force; },
    };
  };
  const html = attrs();
  const deck = Array.from({ length: screens }, (_, i) => ({
    ...attrs(),
    scrollTop: 5,
    querySelector: () => ({ textContent: `Screen ${i}` }),
    querySelectorAll: () => [],
  }));
  const handlers = {};
  const button = { ...attrs(), handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; }, textContent: 'Present' };
  const body = { children: [], append(n) { this.children.push(n); } };
  const doc = {
    documentElement: html,
    body,
    hidden: false,
    querySelector: (sel) => (sel === '.sb-present' ? button : null),
    querySelectorAll: (sel) => (sel === '[data-present-screen]' ? deck : []),
    createElement: () => ({ ...attrs(), className: '', textContent: '', remove() { body.children = body.children.filter((c) => c !== this); } }),
    addEventListener: (name, fn) => { handlers[name] = fn; },
    removeEventListener: () => {},
  };
  const timers = [];
  const announced = [];
  const presenter = initPresenter(doc, { announce: (t) => announced.push(t) }, {
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
  });
  const key = (k, extra = {}) => {
    let prevented = false;
    handlers.keydown({ key: k, target: { tagName: 'BODY' }, preventDefault: () => { prevented = true; }, ...extra });
    return prevented;
  };
  const visible = (hidden) => { doc.hidden = hidden; handlers.visibilitychange(); };
  return { html, deck, button, body, presenter, timers, announced, key, visible };
}

test('presenter wiring: the Present button and P enter, P and Escape leave in place, and the button says which', () => {
  const h = presenterHarness();
  assert.equal(h.html.hasAttribute('data-present'), false, 'the ordinary page loads; nothing in the URL turns it on');
  assert.equal(h.button.getAttribute('aria-pressed'), 'false');
  assert.equal(h.key('ArrowRight'), false, 'off presenter mode the arrows are the page’s');
  h.button.handlers.click();
  assert.equal(h.html.hasAttribute('data-present'), true);
  assert.equal(h.button.getAttribute('aria-pressed'), 'true');
  assert.equal(h.presenter.current(), 0);
  assert.ok(h.deck[0].hasAttribute('data-present-active'));
  assert.equal(h.timers.at(-1).ms, ADVANCE_MS, 'the advance is armed');
  assert.equal(h.key('ArrowRight'), true);
  assert.equal(h.presenter.current(), 1);
  assert.ok(!h.deck[0].hasAttribute('data-present-active') && h.deck[1].hasAttribute('data-present-active'));
  h.key(' ');
  assert.equal(h.presenter.paused(), true);
  assert.equal(h.key('p'), true);
  assert.equal(h.html.hasAttribute('data-present'), false, 'P leaves in place');
  assert.equal(h.button.getAttribute('aria-pressed'), 'false');
  assert.ok(h.deck.every((s) => !s.hasAttribute('data-present-active') && !s.hasAttribute('aria-hidden')));
  h.key('P');
  assert.equal(h.html.hasAttribute('data-present'), true, 'and P comes back to the first screen');
  assert.equal(h.presenter.current(), 0);
  assert.equal(h.presenter.paused(), false, 'a fresh deck advances');
  h.key('Escape');
  assert.equal(h.html.hasAttribute('data-present'), false);
  // Leaving is final: a tab hidden and shown again never re-arms the deck, so
  // nothing later sets aria-hidden on the ordinary page or writes to a removed counter.
  const armed = h.timers.length;
  h.visible(true);
  h.visible(false);
  assert.equal(h.timers.length, armed, 'returning to the tab after leaving arms nothing');
  assert.ok(h.deck.every((s) => !s.hasAttribute('aria-hidden')), 'the ordinary page keeps every screen in the accessibility tree');
  assert.equal(h.body.children.length, 0, 'the counter is gone');
  // Typing, or a key with a modifier, is never taken for a command.
  assert.equal(h.key('p', { target: { tagName: 'INPUT' } }), false);
  assert.equal(h.key('p', { ctrlKey: true }), false);
  assert.equal(h.html.hasAttribute('data-present'), false);
});

test('CMN issued to agents is the exact running total of every settled era’s payout, not total issuance', () => {
  const items = [
    { era: 4, settled: false, settledAtBlock: null, totalEmissionPlancks: '0' },
    { era: 3, settled: true, settledAtBlock: 10_800, totalEmissionPlancks: '1500000000000' },
    { era: 2, settled: true, settledAtBlock: 7_200, totalEmissionPlancks: '2500000000001' },
  ];
  assert.deepEqual(payoutTotal(items, field), { plancks: '4000000000001', eras: 2, first: 2, last: 3 });
  assert.equal(payoutTotal([items[0]], field), null, 'no settled era: nothing to sum, said rather than zero');
  // A hole in the eras shortens the run to the unbroken part ending at the newest, never hides inside it.
  const holed = [...items, { era: 0, settled: true, settledAtBlock: 0, totalEmissionPlancks: '9' }];
  assert.deepEqual(payoutTotal(holed, field), { plancks: '4000000000001', eras: 2, first: 2, last: 3 });
  assert.throws(() => payoutTotal([{ era: 1, settled: true, settledAtBlock: 1 }], field), /totalEmissionPlancks/);
});

test('the scroll reveal: sections fade up once as they enter, by script alone, never under reduced motion or without IntersectionObserver', () => {
  const classes = () => {
    const set = new Set();
    return { set, add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) };
  };
  const make = () => ({ classList: classes() });
  const html = { classList: classes() };
  const targets = [make(), make(), make()];
  let observer = null;
  class IO {
    constructor(callback, options) { this.callback = callback; this.options = options; this.observed = new Set(); observer = this; }
    observe(t) { this.observed.add(t); }
    unobserve(t) { this.observed.delete(t); }
    disconnect() { this.observed.clear(); }
  }
  const running = startReveal({ targets, html, IntersectionObserver: IO, reduced: () => false });
  assert.ok(html.classList.contains('reveal-ready'), 'the stylesheet hides a section only once the script is running');
  assert.equal(observer.observed.size, 3);
  observer.callback([{ target: targets[0], isIntersecting: true }, { target: targets[1], isIntersecting: false }]);
  assert.ok(targets[0].classList.contains('is-in'));
  assert.ok(!targets[1].classList.contains('is-in'));
  assert.ok(!observer.observed.has(targets[0]), 'once: a revealed section is no longer watched');
  running.stop();
  assert.ok(targets.every((t) => t.classList.contains('is-in')), 'stopping shows everything');
  assert.ok(!html.classList.contains('reveal-ready'));

  const still = { classList: classes() };
  assert.equal(startReveal({ targets, html: still, IntersectionObserver: IO, reduced: () => true }), null);
  assert.ok(!still.classList.contains('reveal-ready'), 'reduced motion: nothing is ever hidden');
  assert.equal(startReveal({ targets, html: still, IntersectionObserver: undefined, reduced: () => false }), null);
  assert.ok(!still.classList.contains('reveal-ready'), 'no IntersectionObserver: nothing is ever hidden');
});
