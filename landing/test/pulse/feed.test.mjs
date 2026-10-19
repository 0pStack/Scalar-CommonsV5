// The live feed behind /pulse, driven through a hand-rolled fake context:
// one block-events read per finalized block, events handed on in block order
// and never twice, a 404 retried on the next head, the backlog cap, the live
// window, the stale and unavailable states, the socket's polling fallback,
// the hour seeds, and the pure helpers.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { Emitter, field, pageOf } from '../../src/observatory/data.js';
import { LIVE_WINDOW_BLOCKS } from '../../src/pulse/model.js';
import {
  createFeed,
  headNumber,
  backlogRange,
  withinWindow,
  nameOf,
  namesOf,
  blockInstant,
  stateOf,
  BLOCK_MS,
  BACKLOG_BLOCKS,
  AGENT_PAGES,
  LINK_PAGES,
  HOUR_PAGES,
  HOUR_SOURCES,
  STATUS_POLL_MS,
  LIST_INTERVAL_MS,
} from '../../src/pulse/feed.js';

const A = '5F45w5z8fz2iYWURwQndHS3USxrRnQkKexJSpyaiipqQ1o4b';
const B = '5Dt87gd2vXhAumh2P3cBbNDkTbnb983cWn6uhkTZrDp1BPXW';
const C = '5CcfBsejcZh26EKvLrRSVXFyTiVFwcQYusbqd3JhGByenM6o';

/** An event row as /v1/blocks/<n>/events emits it. */
const ev = (block, index, section, method, data) => ({
  id: `${block}-${index}`,
  blockNumber: block,
  index,
  section,
  method,
  phase: 'ApplyExtrinsic',
  extrinsicId: `${block}-${Math.floor(index / 3)}`,
  data,
  accounts: [],
});
const agreement = (block, index, buyer = A, provider = B, seq = 1) =>
  ev(block, index, 'escrow', 'AgreementCreated', { buyer, provider, seq, amount: '10000000000000' });
const message = (block, index, from = A, to = B) =>
  ev(block, index, 'messages', 'MessageSent', { from, to, kind: 'Offer', agreement: null, payload_hash: null, payload_len: 0, nonce: 1 });
const noise = (block, index) => ev(block, index, 'balances', 'Withdraw', { who: A, amount: '1' });

const statusBody = (synced, finalized = synced, best = finalized) => ({
  chain: { specVersion: 309, bestBlock: best, finalizedBlock: finalized },
  indexer: { syncedHeight: synced, indexedBlocks: 1, backfillDepth: 0 },
});

const okRecord = (label, data, at) => ({ ok: true, at, label, link: `https://api.scalarnet.io${label}`, raw: JSON.stringify(data), data, source: { kind: 'api', path: label } });

/**
 * The context the feed sees. `blocks` maps a block number to its event list,
 * to `{ status: 404 }` (not indexed yet), `{ fail: '…' }` (a failed read) or
 * `{ broken: true }` (a page without items/total).
 */
function fakeCtx({ blocks = {} } = {}) {
  const bus = new Emitter();
  const subscriptions = new Map();
  const watches = new Map();
  const paged = [];
  const reads = [];
  let nowMs = 1_700_000_000_000;
  const stopped = [];
  const ctx = {
    bus,
    field,
    pageOf,
    now: () => nowMs,
    setNow: (ms) => (nowMs = ms),
    blocks,
    reads,
    watches,
    paged,
    stopped,
    subscribe(name, handler) {
      if (!subscriptions.has(name)) subscriptions.set(name, new Set());
      subscriptions.get(name).add(handler);
      return () => {
        stopped.push(`subscribe:${name}`);
        subscriptions.get(name).delete(handler);
      };
    },
    /** A pushed head: the header as chain_subscribeFinalizedHeads sends it. */
    head(number) {
      const header = { number: `0x${number.toString(16)}`, parentHash: '0x00', stateRoot: '0x00', extrinsicsRoot: '0x00', digest: { logs: [] } };
      for (const handler of subscriptions.get('finalizedHeads') ?? []) {
        handler({ ok: true, at: new Date(nowMs), label: 'rpc.scalarnet.io · chain_subscribeFinalizedHeads', link: null, raw: JSON.stringify(header), data: header, source: { kind: 'subscription' } });
      }
    },
    watch(name, handler, intervalMs) {
      if (!watches.has(name)) watches.set(name, []);
      const entry = { handler, intervalMs };
      watches.get(name).push(entry);
      return () => {
        stopped.push(`watch:${name}`);
        watches.set(name, watches.get(name).filter((e) => e !== entry));
      };
    },
    /** A /v1/status read arriving for every watcher of `status`. */
    poll(name, record) {
      for (const { handler } of watches.get(name) ?? []) handler(record);
    },
    watchAll(name, handler, intervalMs, { maxPages } = {}) {
      const entry = { kind: 'all', name, handler, intervalMs, maxPages };
      paged.push(entry);
      return () => stopped.push(`watchAll:${name}`);
    },
    watchSince(name, since, handler, intervalMs, { maxPages } = {}) {
      const entry = { kind: 'since', name, since, handler, intervalMs, maxPages };
      paged.push(entry);
      return () => stopped.push(`watchSince:${name}`);
    },
    /** A paged read arriving for the watcher of `name`. */
    list(name, record) {
      for (const entry of paged) if (entry.name === name) entry.handler(record);
    },
    async fetch(source, path = source.path) {
      reads.push(path);
      const m = path.match(/^\/v1\/blocks\/(\d+)\/events\?limit=(\d+)(?:&offset=(\d+))?$/);
      assert.ok(m, `the feed reads only block events; got ${path}`);
      const number = Number(m[1]);
      const limit = Number(m[2]);
      const offset = Number(m[3] ?? 0);
      const base = { at: new Date(nowMs), label: `api.scalarnet.io${path}`, link: `https://api.scalarnet.io${path}`, source };
      const block = blocks[number];
      if (block === undefined || block?.status === 404) {
        return { ...base, ok: false, raw: `{"error":"block ${number} not found"}`, error: `HTTP 404: block ${number} not found` };
      }
      if (block?.fail) return { ...base, ok: false, raw: null, error: block.fail };
      if (block?.broken) return { ...base, ok: true, raw: '{}', data: {} };
      const items = block.slice(offset, offset + limit);
      const data = { total: block.length, limit, offset, items };
      return { ...base, ok: true, raw: JSON.stringify(data), data };
    },
  };
  return ctx;
}

/** Lets every pending read and its handlers run (the fake fetch resolves without I/O). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A feed on a fake context, started, with everything it emits collected. */
async function started(options = {}, feedOptions = {}) {
  const ctx = fakeCtx(options);
  const feed = createFeed(ctx, feedOptions);
  const events = [];
  const statuses = [];
  const errors = [];
  feed.on('event', (e) => events.push(e));
  feed.on('status', (s) => statuses.push(s));
  feed.on('error', (e) => errors.push(e));
  feed.start();
  await settle();
  return { ctx, feed, events, statuses, errors, last: () => statuses[statuses.length - 1] };
}

// ── pure helpers ─────────────────────────────────────────────────────────────

test('headNumber reads the hex number off a header and refuses anything else', () => {
  assert.equal(headNumber({ number: '0xe09d5' }, field), 920_021);
  assert.equal(headNumber({ number: '0x0' }, field), 0);
  assert.throws(() => headNumber({ number: 'zz' }, field), /not a block number/);
  assert.throws(() => headNumber({}, field), /response has no number/);
});

test('backlogRange: the first head reads only itself; later ones read from the last block read; the cap skips the rest', () => {
  assert.deepEqual(backlogRange(null, 100), { from: 100, to: 100, skipped: 0 });
  assert.deepEqual(backlogRange(100, 103), { from: 101, to: 103, skipped: 0 });
  assert.deepEqual(backlogRange(100, 100), { from: 101, to: 100, skipped: 0 });
  assert.deepEqual(backlogRange(100, 120), { from: 101, to: 120, skipped: 0 });
  assert.deepEqual(backlogRange(100, 121), { from: 102, to: 121, skipped: 1 });
  assert.deepEqual(backlogRange(100, 200), { from: 181, to: 200, skipped: 80 });
  assert.equal(200 - 181 + 1, BACKLOG_BLOCKS);
});

test('withinWindow holds only for blocks at or before the head and within the window', () => {
  assert.equal(withinWindow(100, 100, 30), true);
  assert.equal(withinWindow(70, 100, 30), true);
  assert.equal(withinWindow(69, 100, 30), false);
  assert.equal(withinWindow(101, 100, 30), false);
  assert.equal(withinWindow(NaN, 100, 30), false);
});

test('nameOf takes a string name, then the metadata name, else nothing', () => {
  assert.equal(nameOf({ address: A, name: 'swarm-0042' }), 'swarm-0042');
  assert.equal(nameOf({ address: A, metadata: { name: 'alpha', uri: '', updatedAtBlock: 1 } }), 'alpha');
  assert.equal(nameOf({ address: A, name: '', metadata: null }), undefined);
  assert.equal(nameOf({ address: A, name: 7 }), undefined);
  const names = namesOf([{ address: A, name: 'swarm-0042' }, { address: B, metadata: null }, { nope: true }]);
  assert.deepEqual([...names], [[A, 'swarm-0042'], [B, undefined]]);
});

test('blockInstant dates a block back from the head at six seconds a block', () => {
  assert.equal(blockInstant(100, 100, 50_000), 50_000);
  assert.equal(blockInstant(98, 100, 50_000), 50_000 - 2 * BLOCK_MS);
  assert.equal(blockInstant(101, 100, 50_000), 50_000);
});

test('stateOf: connecting until a head and an index height, stale beyond the window, unavailable on failures', () => {
  const w = LIVE_WINDOW_BLOCKS;
  assert.deepEqual(stateOf({ head: null, indexed: null, windowBlocks: w }), { state: 'connecting', reason: 'waiting for the first finalized block' });
  assert.deepEqual(stateOf({ head: 100, indexed: null, windowBlocks: w }), { state: 'connecting', reason: 'waiting for the first index read' });
  assert.deepEqual(stateOf({ head: 100, indexed: 100, windowBlocks: w }), { state: 'live', reason: '' });
  assert.deepEqual(stateOf({ head: 130, indexed: 100, windowBlocks: w }), { state: 'live', reason: '' });
  assert.deepEqual(stateOf({ head: 131, indexed: 100, windowBlocks: w }), { state: 'stale', reason: 'the index is 31 blocks behind the chain' });
  assert.deepEqual(stateOf({ head: 100, indexed: 100, windowBlocks: w, skipped: 80 }), { state: 'live', reason: 'skipped 80 blocks to stay near the present' });
  assert.equal(stateOf({ head: 100, indexed: 100, windowBlocks: w, source: 'poll' }).reason, 'heads polled from the index every 6 s while the socket is down');
  assert.deepEqual(stateOf({ head: 100, indexed: 100, windowBlocks: w, failure: 'HTTP 502' }), { state: 'unavailable', reason: 'block events read failed: HTTP 502' });
  assert.deepEqual(stateOf({ head: 100, indexed: 100, windowBlocks: w, noHeads: 'socket x; status poll y' }), { state: 'unavailable', reason: 'no head source: socket x; status poll y' });
});

// ── wiring ───────────────────────────────────────────────────────────────────

test('start() watches agents (10 pages), escrows (3), the finalized heads, and the seven hour lists (5 pages) once the hour is known', async () => {
  const { ctx, statuses, feed } = await started();
  const hours = [];
  feed.on('hour', (h) => hours.push(h));
  const all = ctx.paged.filter((e) => e.kind === 'all').map((e) => [e.name, e.maxPages, e.intervalMs]);
  assert.deepEqual(all, [
    ['agents', AGENT_PAGES, LIST_INTERVAL_MS],
    ['escrows', LINK_PAGES, LIST_INTERVAL_MS],
  ]);
  assert.equal(AGENT_PAGES, 10);
  assert.equal(LINK_PAGES, 3);
  // Until a status read fixes the hour's first block there is nothing to bound the lists by: an
  // unbounded read walks every list to the page cap for nothing, so they are not read yet.
  const since = () => ctx.paged.filter((e) => e.kind === 'since');
  assert.deepEqual(since(), []);
  // A failed status read: the page is told the hour is unavailable, and why, with no lists read.
  ctx.poll('status', { ok: false, at: new Date(), label: 'api.scalarnet.io/v1/status', link: null, raw: null, error: 'HTTP 503: Service Unavailable', source: { kind: 'api', path: '/v1/status' } });
  assert.deepEqual(hours, [{ records: {}, events: [], hour: null, error: 'HTTP 503: Service Unavailable' }]);
  assert.deepEqual(since(), []);
  ctx.poll('status', okRecord('/v1/status', statusBody(1_000), new Date()));
  assert.deepEqual(since().map((e) => e.name), HOUR_SOURCES);
  assert.deepEqual(HOUR_SOURCES, ['agreementsCreated', 'messagesSent', 'deliveriesConfirmed', 'disputesOpened', 'oracleAnswers', 'oracleBatches', 'registrations']);
  for (const e of since()) {
    assert.equal(e.maxPages, HOUR_PAGES);
    assert.equal(e.intervalMs, LIST_INTERVAL_MS);
  }
  // Not the observatory hour row's HOUR_PAGES (10): the scheduler keys on name:since:maxPages and the first bound wins.
  assert.equal(HOUR_PAGES, 5);
  assert.notEqual(HOUR_PAGES, 10);
  // The bound is the tracker's hour: its first block, 600 blocks before the index's height.
  assert.equal(since()[0].since(), 400);
  // Registered once: a later status read adds no watch.
  ctx.poll('status', okRecord('/v1/status', statusBody(1_010), new Date()));
  assert.equal(since().length, HOUR_SOURCES.length);
  assert.equal(since()[0].since(), 410);
  // The hour tracker's own status watch is at 30 s; no 6 s poll until the socket fails.
  assert.deepEqual(ctx.watches.get('status').map((w) => w.intervalMs), [30_000]);
  assert.deepEqual(statuses.map((s) => s.state), ['connecting']);
  assert.equal(statuses[0].reason, 'waiting for the first finalized block');
});

test('one read per finalized block, events in block order, matching events only, never twice', async () => {
  const blocks = {
    100: [noise(100, 0), agreement(100, 1), noise(100, 2), message(100, 3, B, C)],
    101: [ev(101, 0, 'escrow', 'DeliveryConfirmed', { buyer: A, provider: B, seq: 1, amount: '10000000000000' })],
  };
  const { ctx, events, last } = await started({ blocks });
  // A status read gives the index's height, so the first head can be judged live.
  ctx.poll('status', okRecord('/v1/status', statusBody(100), new Date()));
  ctx.setNow(1_700_000_000_000 + 10_000);
  ctx.head(100);
  await settle();
  assert.deepEqual(ctx.reads, ['/v1/blocks/100/events?limit=200']);
  assert.deepEqual(events.map((e) => [e.event.id, e.row.kind, e.parties]), [
    ['100-1', 'agreement', { from: A, to: B }],
    ['100-3', 'message', { from: B, to: C }],
  ]);
  assert.equal(events[0].at, 1_700_000_000_000 + 10_000);
  assert.equal(events[0].record.label, 'api.scalarnet.io/v1/blocks/100/events?limit=200');
  assert.deepEqual(last(), { ...last(), state: 'live', head: 100, indexed: 100 });

  ctx.head(101);
  await settle();
  assert.deepEqual(ctx.reads, ['/v1/blocks/100/events?limit=200', '/v1/blocks/101/events?limit=200']);
  assert.deepEqual(events.map((e) => e.event.id), ['100-1', '100-3', '101-0']);
  assert.equal(events[2].row.kind, 'settled');

  // The same head again, and a head below the last read: nothing re-read, nothing repeated.
  ctx.head(101);
  ctx.head(100);
  await settle();
  assert.equal(ctx.reads.length, 2);
  assert.deepEqual(events.map((e) => e.event.id), ['100-1', '100-3', '101-0']);
  // A block answering with an already-seen id is not handed on twice.
  blocks[102] = [agreement(102, 0, A, B, 2), { ...agreement(102, 1, A, C, 3), id: '100-1' }];
  ctx.head(102);
  await settle();
  assert.deepEqual(events.map((e) => e.event.id), ['100-1', '100-3', '101-0', '102-0']);
});

test('a block with more events than one page is read whole, offset by offset', async () => {
  const rows = [];
  for (let i = 0; i < 450; i += 1) rows.push(i % 50 === 0 ? message(200, i, A, B) : noise(200, i));
  const { ctx, events } = await started({ blocks: { 200: rows } });
  ctx.poll('status', okRecord('/v1/status', statusBody(200), new Date()));
  ctx.head(200);
  await settle();
  assert.deepEqual(ctx.reads, [
    '/v1/blocks/200/events?limit=200',
    '/v1/blocks/200/events?limit=200&offset=200',
    '/v1/blocks/200/events?limit=200&offset=400',
  ]);
  assert.equal(events.length, 9);
  assert.deepEqual(events.slice(0, 3).map((e) => e.event.id), ['200-0', '200-50', '200-100']);
});

test('a 404 (not indexed yet) stops the read and is retried from that block on the next head', async () => {
  const blocks = { 100: [agreement(100, 0)], 101: { status: 404 } };
  const { ctx, events, last } = await started({ blocks });
  ctx.poll('status', okRecord('/v1/status', statusBody(100), new Date()));
  ctx.head(100);
  await settle();
  ctx.head(101);
  await settle();
  assert.deepEqual(ctx.reads.slice(1), ['/v1/blocks/101/events?limit=200']);
  assert.equal(events.length, 1);
  assert.equal(last().state, 'live', 'one block behind is within the window');
  assert.equal(last().indexed, 100);

  blocks[101] = [message(101, 0)];
  blocks[102] = [message(102, 0, B, A)];
  ctx.head(102);
  await settle();
  assert.deepEqual(ctx.reads.slice(2), ['/v1/blocks/101/events?limit=200', '/v1/blocks/102/events?limit=200']);
  assert.deepEqual(events.map((e) => e.event.id), ['100-0', '101-0', '102-0']);
  assert.equal(last().indexed, 102);
});

test('the backlog is capped at 20 blocks; the gap is reported in the status reason and cleared on the next head', async () => {
  const blocks = {};
  for (let n = 100; n <= 201; n += 1) blocks[n] = [message(n, 0)];
  const { ctx, events, last } = await started({ blocks });
  ctx.poll('status', okRecord('/v1/status', statusBody(100), new Date()));
  ctx.head(100);
  await settle();
  ctx.head(200);
  await settle();
  const read = ctx.reads.slice(1).map((p) => Number(p.match(/blocks\/(\d+)/)[1]));
  assert.equal(read.length, BACKLOG_BLOCKS);
  assert.deepEqual([read[0], read[read.length - 1]], [181, 200]);
  assert.deepEqual(events.slice(1).map((e) => e.event.blockNumber), read);
  assert.equal(last().state, 'live');
  assert.equal(last().reason, 'skipped 80 blocks to stay near the present');
  // Dated back from the head's arrival: block 181 is 19 blocks before 200.
  assert.equal(events[1].at, ctx.now() - 19 * BLOCK_MS);
  ctx.head(201);
  await settle();
  assert.equal(last().reason, '');
});

test('stale: the index more than the window behind the head animates nothing and says how far behind', async () => {
  const blocks = { 100: [agreement(100, 0)] };
  const { ctx, events, last } = await started({ blocks });
  ctx.poll('status', okRecord('/v1/status', statusBody(100), new Date()));
  ctx.head(100);
  await settle();
  // Block 100 read, nothing else indexed: a head 31 blocks on is beyond LIVE_WINDOW_BLOCKS.
  ctx.head(100 + LIVE_WINDOW_BLOCKS + 1);
  await settle();
  assert.equal(last().state, 'stale');
  assert.equal(last().reason, `the index is ${LIVE_WINDOW_BLOCKS + 1} blocks behind the chain`);
  assert.equal(events.length, 1);
  // The capped backlog starts at 112; its first block answers 404 and the read stops there.
  assert.deepEqual(ctx.reads.slice(1), ['/v1/blocks/112/events?limit=200']);

  // The index catches up: the reads succeed from the capped start and the feed is live again.
  for (let n = 101; n <= 132; n += 1) blocks[n] = [message(n, 0)];
  ctx.head(132);
  await settle();
  assert.equal(last().state, 'live');
  const emitted = events.slice(1).map((e) => e.event.blockNumber);
  assert.deepEqual([emitted[0], emitted[emitted.length - 1]], [113, 132]);
  assert.ok(emitted.every((n) => 132 - n <= LIVE_WINDOW_BLOCKS));
});

test('no event older than the live window is ever handed on, whatever the index answers', async () => {
  const blocks = {
    200: [message(200, 0), { ...message(200, 1), blockNumber: 150, id: '150-1' }],
    1_000: [agreement(1_000, 0)],
  };
  for (let n = 981; n < 1_000; n += 1) blocks[n] = [message(n, 0)];
  const { ctx, events, last } = await started({ blocks });
  ctx.poll('status', okRecord('/v1/status', statusBody(200), new Date()));
  ctx.head(200);
  await settle();
  assert.deepEqual(events.map((e) => e.event.id), ['200-0']);

  // Polling fallback: the index holds block 1,000, the chain is at 1,040 — 40 behind, read but not animated.
  ctx.bus.emit('socket', { state: 'failed', detail: 'WebSocket connection failed', attempts: 1 });
  ctx.poll('status', okRecord('/v1/status', statusBody(1_000, 1_040), new Date()));
  await settle();
  assert.ok(ctx.reads.includes('/v1/blocks/1000/events?limit=200'));
  assert.deepEqual(events.map((e) => e.event.id), ['200-0']);
  assert.equal(last().state, 'stale');
  assert.equal(last().reason, 'the index is 40 blocks behind the chain');
  assert.equal(last().head, 1_040);
});

test('unavailable when the socket has failed and the status poll fails too; polling resumes heads; the socket reopening ends the poll', async () => {
  const blocks = { 500: [message(500, 0)], 501: [message(501, 0)] };
  const { ctx, events, last, feed } = await started({ blocks });
  ctx.bus.emit('socket', { state: 'failed', detail: 'WebSocket connection failed', attempts: 1 });
  assert.deepEqual(ctx.watches.get('status').map((w) => w.intervalMs), [30_000, STATUS_POLL_MS]);
  ctx.poll('status', { ok: false, at: new Date(), label: 'api.scalarnet.io/v1/status', link: null, raw: null, error: 'request failed: no response within 8 s', source: { kind: 'api', path: '/v1/status' } });
  await settle();
  assert.equal(last().state, 'unavailable');
  assert.equal(last().reason, 'no head source: socket WebSocket connection failed; status poll request failed: no response within 8 s');
  assert.equal(feed.head(), null);

  // The poll recovers: the index's height is the head to read, the chain's finalized block the head of the window.
  ctx.poll('status', okRecord('/v1/status', statusBody(500, 501), new Date()));
  await settle();
  assert.equal(last().state, 'live');
  assert.equal(last().reason, 'heads polled from the index every 6 s while the socket is down');
  assert.equal(feed.head(), 501);
  assert.deepEqual(events.map((e) => e.event.id), ['500-0']);
  ctx.poll('status', okRecord('/v1/status', statusBody(501, 501), new Date()));
  await settle();
  assert.deepEqual(events.map((e) => e.event.id), ['500-0', '501-0']);

  // The socket reopens: the 6 s poll is dropped, the tracker's 30 s watch stays.
  ctx.bus.emit('socket', { state: 'open', attempts: 0 });
  assert.deepEqual(ctx.watches.get('status').map((w) => w.intervalMs), [30_000]);
  assert.ok(ctx.stopped.includes('watch:status'));
});

test('a failed block read (not a 404) is unavailable with the reason, and clears when the next head reads', async () => {
  const blocks = { 100: [message(100, 0)], 101: { fail: 'HTTP 502: Bad Gateway' }, 102: { broken: true } };
  const { ctx, events, last } = await started({ blocks });
  ctx.poll('status', okRecord('/v1/status', statusBody(100), new Date()));
  ctx.head(100);
  await settle();
  ctx.head(101);
  await settle();
  assert.equal(last().state, 'unavailable');
  assert.equal(last().reason, 'block events read failed: HTTP 502: Bad Gateway');
  blocks[101] = [message(101, 0)];
  ctx.head(102);
  await settle();
  assert.equal(last().state, 'unavailable');
  assert.equal(last().reason, 'block events read failed: response has no items');
  assert.deepEqual(events.map((e) => e.event.id), ['100-0', '101-0']);
  blocks[102] = [];
  ctx.head(103);
  await settle();
  assert.equal(last().state, 'live', 'block 103 is not indexed, but the failure is gone');
  assert.equal(last().indexed, 102);
});

test('a decode mismatch in one event is reported, not drawn, and does not stop the block', async () => {
  const error = mock.method(console, 'error', () => {});
  try {
    const blocks = { 100: [ev(100, 0, 'escrow', 'AgreementCreated', { buyer: A, seq: 1, amount: '1' }), message(100, 1)] };
    const { ctx, events, errors } = await started({ blocks });
    ctx.poll('status', okRecord('/v1/status', statusBody(100), new Date()));
    ctx.head(100);
    await settle();
    assert.deepEqual(events.map((e) => e.event.id), ['100-1']);
    assert.equal(errors.length, 1);
    assert.match(errors[0].error.message, /response has no provider/);
    assert.equal(error.mock.callCount(), 1);
  } finally {
    error.mock.restore();
  }
});

test('after a hidden spell the backlog is dropped, not replayed, and the gap is reported', async () => {
  const blocks = {};
  for (let n = 100; n <= 130; n += 1) blocks[n] = [message(n, 0)];
  const { ctx, events, last } = await started({ blocks });
  ctx.poll('status', okRecord('/v1/status', statusBody(100), new Date()));
  ctx.head(100);
  await settle();
  ctx.bus.emit('visibility', { hidden: true });
  ctx.bus.emit('visibility', { hidden: false });
  ctx.head(130);
  await settle();
  assert.deepEqual(ctx.reads.slice(1), ['/v1/blocks/130/events?limit=200']);
  assert.deepEqual(events.map((e) => e.event.blockNumber), [100, 130]);
  assert.equal(last().reason, 'skipped 29 blocks to stay near the present');
});

test('the hour: records from the seven lists, events dated by block, none seen live, none before the hour', async () => {
  const blocks = { 1_000: [message(1_000, 0)] };
  const { ctx, feed } = await started({ blocks });
  const hours = [];
  feed.on('hour', (h) => hours.push(h));
  const at = new Date(1_700_000_000_000);
  const record = (name, items) => ({ ...okRecord(`/v1/events?${name}`, { total: items.length, items: items[0] ? [items[0]] : [] }, at), items, total: items.length, complete: true, since: 400, reachedStart: true });
  ctx.poll('status', okRecord('/v1/status', statusBody(1_000), at));
  ctx.head(1_000);
  await settle();
  for (const name of HOUR_SOURCES.slice(0, -1)) ctx.list(name, record(name, []));
  assert.equal(hours.length, 0, 'emitted once all seven have reported');
  ctx.list('registrations', record('registrations', []));
  assert.equal(hours.length, 1);
  assert.deepEqual(Object.keys(hours[0].records), HOUR_SOURCES);
  assert.deepEqual(hours[0].events, []);
  ctx.list('messagesSent', record('messagesSent', [message(1_000, 0), message(999, 4, B, A), message(399, 0)]));
  ctx.list('agreementsCreated', record('agreementsCreated', [agreement(998, 2)]));
  const hour = hours[hours.length - 1];
  assert.deepEqual(hour.hour, { since: 400, to: 1_000, best: 1_000, behind: 0 });
  assert.equal(hour.error, null);
  // 1000-0 was handed on live; 399-0 is before the hour.
  assert.deepEqual(hour.events.map((e) => [e.event.id, e.row.kind, e.parties.from]), [
    ['998-2', 'agreement', A],
    ['999-4', 'message', B],
  ]);
  assert.equal(hour.events[1].at, at.getTime() - BLOCK_MS);
  assert.equal(hour.events[0].at, at.getTime() - 2 * BLOCK_MS);
  assert.equal(hour.records.messagesSent.items.length, 3);
});

test('names() comes from the latest agents read; links pass the escrow items; stop() ends every watch', async () => {
  const { ctx, feed } = await started();
  const got = { agents: [], links: [] };
  feed.on('agents', (a) => got.agents.push(a));
  feed.on('links', (l) => got.links.push(l));
  assert.deepEqual([...feed.names()], []);
  const agents = [{ address: A, name: 'swarm-0042' }, { address: B }];
  ctx.list('agents', { ...okRecord('/v1/agents?limit=200', { total: 2, items: agents }, new Date()), items: agents, total: 2, complete: true });
  assert.deepEqual([...feed.names()], [[A, 'swarm-0042'], [B, undefined]]);
  assert.equal(got.agents[0].items, agents);
  const escrows = [{ buyer: A, provider: B, seq: 1, status: 'Created', amountPlancks: '1' }];
  ctx.list('escrows', { ...okRecord('/v1/escrows?limit=200', { total: 1, items: escrows }, new Date()), items: escrows, total: 1, complete: true });
  assert.equal(got.links[0].items, escrows);
  // A failed agents read empties the names: never the last list standing.
  ctx.list('agents', { ok: false, at: new Date(), label: 'x', link: null, raw: null, error: 'HTTP 503', items: [], complete: false, source: {} });
  assert.deepEqual([...feed.names()], []);
  assert.equal(got.agents[1].record.ok, false);
  ctx.poll('status', okRecord('/v1/status', statusBody(1_000), new Date()));
  feed.stop();
  assert.deepEqual(ctx.stopped.sort(), ['subscribe:finalizedHeads', 'watchAll:agents', 'watchAll:escrows', ...HOUR_SOURCES.map((n) => `watchSince:${n}`)].sort());
});
