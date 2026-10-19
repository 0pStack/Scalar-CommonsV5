// The live feed behind /pulse: the one place the page learns that something
// happened on the chain, and the reason nothing on it moves without a real
// event behind it.
//
// The constellation animates runtime events, and the honest source of those
// is the finalized-block event index: `/v1/blocks/<n>/events` holds every
// event one finalized block emitted, in emission order, with the event's own
// id. So the feed follows finalized heads over the page's WebSocket and reads
// each new block exactly once — one request per block, never a poll of the
// event lists — and hands the page each matching event once, in block order,
// deduplicated by id. A poll of `/v1/events` would show the same event on
// every refresh and could never say "this just happened"; a per-block read
// can, and it is the only way the ticker's "4 s ago" is a claim about the
// chain rather than about the page's timer.
//
// What is live. An event is handed on only while it sits within the live
// window of the head (LIVE_WINDOW_BLOCKS, three minutes at six seconds a
// block). When the index falls further behind the chain than that, the feed
// reports `stale` and animates nothing until the index catches up: an old
// event drawn as new would be a lie about the present. When heads cannot be
// had at all — the socket is down and the status poll fails too — or a block
// read fails, the feed reports `unavailable` with the reason, and the page
// says so in a banner instead of drifting on what it last saw.
//
// Catching up. A block the index has not reached yet answers 404; the feed
// stops there and retries from that block on the next head. When the page
// falls behind the chain (a slow socket, a long read) the backlog is capped
// at BACKLOG_BLOCKS: older blocks are skipped and the gap is reported in the
// status reason, so the page stays near the present rather than replaying
// minutes of history as if it were happening now. After a hidden spell the
// backlog is dropped outright, for the same reason.
//
// The rest of the page's data rides the shared schedulers: the agents (every
// page of /v1/agents, 2,000 agents in ten pages), the open agreements
// (/v1/escrows, the threads), and the last hour's events from the six event
// lists, read back to the block of one hour ago exactly as the observatory's
// hour row reads them, and watched only once that block is known. The hour
// seeds the counters at load with index reads that carry provenance; it is
// never animated. Its watches use HOUR_PAGES = 5,
// a different page cap from the observatory's hour row (HOUR_PAGES = 10 in
// instruments/last-hour.js): the scheduler keys a bounded watch by
// `name:since:maxPages` and the first registrant's bound wins, so a shared
// key would silently hand this page another instrument's bound.
//
// Fallback. If the socket fails or closes, heads come from /v1/status every
// six seconds, with the index's `syncedHeight` as the block to read up to and
// the chain's `finalizedBlock` as the head the live window is measured from;
// the socket's reopening ends the poll.

import { Emitter, blockEventsSource } from '../observatory/data.js';
import { hourTracker } from '../observatory/hour.js';
import { kindOf, partiesOf, isLive, LIVE_WINDOW_BLOCKS } from './model.js';

/** The runtime's SECS_PER_BLOCK = 6: how an event's block is turned into an instant. */
export const BLOCK_MS = 6_000;
/** Agents, open agreements and the hour's events refresh together, as on the observatory. */
export const LIST_INTERVAL_MS = 30_000;
/** The status poll that stands in for the socket: one read per block time. */
export const STATUS_POLL_MS = 6_000;
/** 2,000 agents at the indexer's 200-row pages. */
export const AGENT_PAGES = 10;
/** The open-agreement scan is capped at 512 rows by the indexer; three pages cover it. */
export const LINK_PAGES = 3;
/** Distinct from last-hour.js's HOUR_PAGES (10) on purpose: see the header. */
export const HOUR_PAGES = 5;
/** The most blocks read to catch up with the chain in one go; older ones are skipped and the gap reported. */
export const BACKLOG_BLOCKS = 20;
/** Pages of one block's events before the read is called incomplete (2,000 events in a block). */
export const EVENT_PAGES = 10;
/** The event lists that seed the last hour: one per animated kind (oracle answers come from two). */
export const HOUR_SOURCES = [
  'agreementsCreated',
  'messagesSent',
  'deliveriesConfirmed',
  'disputesOpened',
  'oracleAnswers',
  'oracleBatches',
  'registrations',
];

// ── pure helpers (tested) ────────────────────────────────────────────────────

/** A header's `number` (a hex string on the wire) as a block number. Throws on anything else. */
export function headNumber(header, field) {
  const hex = field(header, 'number');
  const number = parseInt(String(hex), 16);
  if (!Number.isFinite(number) || number < 0) throw new Error(`header number ${JSON.stringify(hex)} is not a block number`);
  return number;
}

/**
 * The blocks to read for a head: from the block after the last one read, or
 * from the head itself on the first head, capped at `cap` blocks. `skipped`
 * is the gap the cap opened, for the status reason.
 */
export function backlogRange(lastRead, head, cap = BACKLOG_BLOCKS) {
  if (lastRead === null || lastRead === undefined) return { from: head, to: head, skipped: 0 };
  const next = lastRead + 1;
  const from = Math.max(next, head - cap + 1);
  return { from, to: head, skipped: Math.max(0, from - next) };
}

/**
 * Where the next read starts after a block the index has not reached: the
 * block before it, so the next head reads it again. With no block read yet,
 * reading only each new head would skip every block the index was late on
 * and, if it is always a block late, read nothing at all. Pure; tested.
 */
export function retryFrom(lastRead, block) {
  return lastRead === null || lastRead === undefined ? block - 1 : Math.min(lastRead, block - 1);
}

/** Within `windowBlocks` of the head, and not from its future. The feed's own window, beside the model's isLive. */
export function withinWindow(blockNumber, head, windowBlocks) {
  const behind = head - blockNumber;
  return Number.isFinite(behind) && behind >= 0 && behind <= windowBlocks;
}



/**
 * An agent's display name, when the index has one: the top-level `name` the
 * observatory keys operator-run on, else the on-chain metadata's name. A
 * non-string is "no name", never a guess.
 */
export function nameOf(agent) {
  if (typeof agent?.name === 'string' && agent.name !== '') return agent.name;
  const meta = agent?.metadata;
  if (meta && typeof meta === 'object' && typeof meta.name === 'string' && meta.name !== '') return meta.name;
  return undefined;
}

/** `Map<address, name|undefined>` from an agents list. */
export function namesOf(items) {
  const names = new Map();
  for (const agent of items ?? []) {
    if (typeof agent?.address === 'string') names.set(agent.address, nameOf(agent));
  }
  return names;
}

/** The instant an event's block was seen, dated back from the head's arrival at six seconds a block. */
export function blockInstant(blockNumber, head, headAt) {
  return headAt - Math.max(0, head - blockNumber) * BLOCK_MS;
}

/**
 * The feed's state from what it knows. `head` is the chain's head the live
 * window is measured from, `indexed` the newest block the index is known to
 * hold, `failure` a failed block read, `noHeads` the reason both head sources
 * are gone, `skipped` the blocks the backlog cap passed over. Pure; tested.
 */
export function stateOf({ head, indexed, windowBlocks, failure = null, noHeads = null, skipped = 0, source = 'socket' }) {
  if (noHeads) return { state: 'unavailable', reason: `no head source: ${noHeads}` };
  if (failure) return { state: 'unavailable', reason: `block events read failed: ${failure}` };
  if (head === null) return { state: 'connecting', reason: 'waiting for the first finalized block' };
  if (indexed === null) return { state: 'connecting', reason: 'waiting for the first index read' };
  const behind = head - indexed;
  if (behind > windowBlocks) {
    return { state: 'stale', reason: `the index is ${behind} blocks behind the chain` };
  }
  const notes = [];
  if (source === 'poll') notes.push('heads polled from the index every 6 s while the socket is down');
  if (skipped > 0) notes.push(`skipped ${skipped} blocks to stay near the present`);
  return { state: 'live', reason: notes.join('; ') };
}

// ── the feed ─────────────────────────────────────────────────────────────────

/**
 * The live feed: `on(name, fn)` for `agents`, `links`, `hour`, `event` and
 * `status` (returns an unsubscribe), `start()`, `stop()`, `names()` (the
 * latest agents read as `Map<address, name>`) and `head()` (the latest head
 * number, or null).
 */
export function createFeed(ctx, { windowBlocks = LIVE_WINDOW_BLOCKS } = {}) {
  const bus = new Emitter();
  const hour = hourTracker(ctx);
  const stops = [];

  let liveHead = null; // the chain's head the live window is measured from
  let readHead = null; // the block to read up to (the socket's head, or the index's height when polling)
  let headAt = null; // ctx.now() when it arrived
  let headRecord = null;
  let headSource = 'socket';
  let lastRead = null; // the newest block whose events were read whole
  let synced = null; // the index's own height, from the latest /v1/status read
  let hourError = null; // why the hour is not known, from the same read
  let hourStarted = false; // the hour's lists are watched once the hour is known
  let skipped = 0; // the gap the last catch-up opened
  let failure = null; // the last failed block read, if the latest
  let socketDown = null; // the socket's failure detail while it is down
  let pollError = null; // the status poll's failure while the socket is down
  let draining = false;
  let agentsRecord = null;
  let stopPoll = null;
  let hiddenSince = null; // lastRead when the tab hid, to report the dropped backlog
  let status = null;
  const seen = new Map(); // event id -> block number, for the dedupe
  const hourRecords = new Map(); // source name -> latest record

  /** The newest block the index is known to hold: measured by a read or reported by /v1/status, never assumed from a 404. */
  const indexedNow = () => (lastRead === null && synced === null ? null : Math.max(lastRead ?? -1, synced ?? -1));

  function publishStatus(record) {
    const indexed = indexedNow();
    const noHeads = socketDown !== null && pollError !== null ? `socket ${socketDown}; status poll ${pollError}` : null;
    const next = {
      ...stateOf({ head: liveHead, indexed, windowBlocks, failure, noHeads, skipped, source: headSource }),
      head: liveHead,
      indexed,
      record: record ?? headRecord,
    };
    const changed =
      !status ||
      status.state !== next.state ||
      status.reason !== next.reason ||
      status.head !== next.head ||
      status.indexed !== next.indexed;
    status = next;
    if (changed) bus.emit('status', next);
  }

  function emitEvents(items, block, record) {
    const at = blockInstant(block, readHead, headAt);
    for (const event of items) {
      const row = kindOf(event);
      if (!row) continue;
      const id = ctx.field(event, 'id');
      if (seen.has(id)) continue;
      seen.set(id, block);
      if (!isLive(event, liveHead) || !withinWindow(block, liveHead, windowBlocks)) continue;
      let parties;
      try {
        parties = partiesOf(event);
      } catch (error) {
        // A decode mismatch on one event is reported, not drawn as a guess and not fatal to the feed.
        console.error(error);
        bus.emit('error', { event, record, error });
        continue;
      }
      bus.emit('event', { event, row, parties, at, record });
    }
  }

  /** One block's events, every page: `{ ok, record, items }`, `notIndexed` on a 404, `complete` when every page came. */
  async function readBlock(number) {
    const source = blockEventsSource(number);
    const items = [];
    let first = null;
    for (let page = 0; page < EVENT_PAGES; page += 1) {
      const record = await ctx.fetch(source, page === 0 ? source.path : ctx.pageOf(source, items.length));
      first ??= record;
      if (!record.ok) {
        return { ok: false, record: first, items, notIndexed: /^HTTP 404\b/.test(record.error) };
      }
      const pageItems = ctx.field(record.data, 'items');
      const total = ctx.field(record.data, 'total');
      items.push(...pageItems);
      if (items.length >= total || pageItems.length === 0) return { ok: true, record: first, items, complete: true };
    }
    return { ok: true, record: first, items, complete: false };
  }

  function forget(block) {
    for (const [id, at] of seen) if (at < block) seen.delete(id);
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      for (;;) {
        const target = readHead;
        if (hiddenSince !== null) {
          // Back from a hidden spell: do not replay what happened meanwhile as if it were now.
          skipped = Math.max(0, target - hiddenSince - 1);
          lastRead = null;
          hiddenSince = null;
        }
        const range = backlogRange(lastRead, target, BACKLOG_BLOCKS);
        if (range.skipped > 0) skipped = range.skipped;
        else if (lastRead !== null) skipped = 0;
        failure = null;
        let latest = null;
        for (let n = range.from; n <= range.to; n += 1) {
          let result;
          try {
            result = await readBlock(n);
          } catch (error) {
            // A page without `items`/`total` is a decode mismatch: unavailable, with the reason, not a guess.
            failure = error.message;
            break;
          }
          latest = result.record;
          if (!result.ok) {
            // A 404 is "not indexed yet": stop here and retry from this block on the next head.
            if (!result.notIndexed) failure = result.record.error;
            // Not indexed yet: the next head reads from this block, not from itself.
            lastRead = retryFrom(lastRead, n);
            break;
          }
          lastRead = n;
          emitEvents(result.items, n, result.record);
        }
        forget(liveHead - windowBlocks - BACKLOG_BLOCKS);
        publishStatus(latest);
        if (readHead === target) break;
      }
    } finally {
      draining = false;
    }
  }

  function onHead(record) {
    if (!record.ok) return;
    let number;
    try {
      number = headNumber(record.data, ctx.field);
    } catch (error) {
      console.error(error);
      return;
    }
    headRecord = record;
    headAt = ctx.now();
    headSource = 'socket';
    liveHead = number;
    readHead = number;
    pollError = null;
    drain();
  }

  function onStatusPoll(record) {
    if (socketDown === null) return; // the socket came back while a read was in flight
    headRecord = record;
    if (!record.ok) {
      pollError = record.error;
      publishStatus(record);
      return;
    }
    try {
      const height = ctx.field(record.data, 'indexer.syncedHeight');
      const finalized = ctx.field(record.data, 'chain.finalizedBlock');
      pollError = null;
      headAt = ctx.now();
      headSource = 'poll';
      liveHead = finalized;
      readHead = height;
      synced = height;
      drain();
    } catch (error) {
      pollError = error.message;
      publishStatus(record);
    }
  }

  function startPoll() {
    if (stopPoll) return;
    stopPoll = ctx.watch('status', onStatusPoll, STATUS_POLL_MS);
  }

  function endPoll() {
    if (!stopPoll) return;
    stopPoll();
    stopPoll = null;
  }

  function onSocket({ state, detail }) {
    if (state === 'failed' || state === 'closed') {
      socketDown = detail ?? state;
      startPoll();
      publishStatus();
    } else if (state === 'open') {
      socketDown = null;
      pollError = null;
      endPoll();
    }
  }

  function onVisibility({ hidden }) {
    if (!hidden && lastRead !== null) hiddenSince = lastRead;
  }

  /**
   * The hour's event lists are watched only once the hour is known: a bound
   * of null reads every list to the page cap (1,000 rows a kind) for nothing,
   * and the status read that fixes the bound is seconds away. Until then, or
   * when that read fails, the page is told why the hour is not there.
   */
  // The hour's lists are read once, to seed the counters; after that the
  // per-block feed carries them forward, so seven lists are not re-read every
  // half minute for the page's whole life.
  const hourStops = [];
  function endHour() {
    for (const stop of hourStops) stop();
    hourStops.length = 0;
  }
  function startHour() {
    if (hourStarted) return;
    hourStarted = true;
    for (const name of HOUR_SOURCES) {
      hourStops.push(
        ctx.watchSince(
          name,
          () => hour.get()?.since ?? null,
          (record) => {
            hourRecords.set(name, record);
            publishHour();
          },
          LIST_INTERVAL_MS,
          { maxPages: HOUR_PAGES },
        ),
      );
    }
  }

  /** The hour tracker's status read doubles as the index-height measurement behind `stale`. */
  function onHour({ hour: window, error }) {
    hourError = error ?? null;
    if (window) {
      synced = Math.max(synced ?? -1, window.to);
      if (liveHead !== null && !draining) publishStatus();
      startHour();
    } else if (!hourStarted) {
      bus.emit('hour', { records: {}, events: [], hour: null, error: hourError ?? 'the hour is not known yet' });
    }
  }

  function publishHour() {
    if (hourRecords.size < HOUR_SOURCES.length) return;
    const window = hour.get();
    const anchor = hour.record();
    const records = Object.fromEntries(hourRecords);
    const events = [];
    const ids = new Set();
    if (window && anchor) {
      const anchorAt = anchor.at.getTime();
      for (const record of hourRecords.values()) {
        if (!record.ok) continue;
        for (const event of record.items) {
          const row = kindOf(event);
          if (!row) continue;
          const block = ctx.field(event, 'blockNumber');
          if (block < window.since) continue;
          const id = ctx.field(event, 'id');
          // Seen live already: the page has it from the feed; counting it twice would overstate the hour.
          if (ids.has(id) || seen.has(id)) continue;
          ids.add(id);
          let parties;
          try {
            parties = partiesOf(event);
          } catch (error) {
            console.error(error);
            bus.emit('error', { event, record, error });
            continue;
          }
          events.push({ event, row, parties, at: anchorAt - (window.to - block) * BLOCK_MS, record });
        }
      }
      events.sort((a, b) => a.event.blockNumber - b.event.blockNumber || a.event.index - b.event.index);
    }
    bus.emit('hour', { records, events, hour: window, error: window ? null : (hourError ?? 'the hour is not known yet') });
    if (window && [...hourRecords.values()].every((record) => record.ok)) Promise.resolve().then(endHour);
  }

  return {
    on: (name, fn) => bus.on(name, fn),
    names: () => (agentsRecord?.ok ? namesOf(agentsRecord.items) : new Map()),
    head: () => liveHead,
    status: () => status,

    start() {
      publishStatus();
      stops.push(
        ctx.watchAll(
          'agents',
          (record) => {
            agentsRecord = record;
            bus.emit('agents', { record, items: record.items ?? [] });
          },
          LIST_INTERVAL_MS,
          { maxPages: AGENT_PAGES },
        ),
      );
      stops.push(
        ctx.watchAll('escrows', (record) => bus.emit('links', { record, items: record.items ?? [] }), LIST_INTERVAL_MS, {
          maxPages: LINK_PAGES,
        }),
      );
      hour.onChange(onHour);
      stops.push(ctx.bus.on('socket', onSocket));
      stops.push(ctx.bus.on('visibility', onVisibility));
      stops.push(ctx.subscribe('finalizedHeads', onHead));
    },

    stop() {
      endHour();
      endPoll();
      for (const stop of stops.splice(0)) stop();
    },
  };
}
