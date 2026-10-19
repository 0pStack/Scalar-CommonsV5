// 01 · Chain. A river, not a ruler: blocks flow in from the right as
// bars whose height is the number of extrinsics each carried, placed
// along the plate by the chain's own clock so a late block leaves a visible
// gap. The finalized region is a tinted band that advances behind a labelled
// marker; when finality reaches a block, its bar settles from the live accent
// to the calm settled tone. A trail of the last sixty blocks fades to the
// left.
//
// Data: a WebSocket subscription to `chain_subscribeNewHeads` and
// `chain_subscribeFinalizedHeads`, so a bar appears the moment the node
// announces a block, seeded from `/v1/blocks` so the river is alive on first
// paint. Each live head is followed by two small reads on the same socket —
// `chain_getBlockHash(n)`, then `chain_getBlock(hash)` — for the block's
// extrinsic count and its timestamp inherent (the first extrinsic of every
// block, decoded here). Until they answer, the bar stands at the height of
// one extrinsic, half-toned, at its arrival time less the offset the
// previous blocks were seen to arrive with. If the socket cannot be opened
// the hero polls `/v1/status` every 6 s and says so; polled blocks have no
// body, so they are drawn at the minimum height. A fork (two heads at one
// height, or a head below the best) is drawn as a superseded bar rather than
// hidden.
//
// Motion: on each arrival the river shifts by the new block's interval with a
// 200 ms ease, so the new block slides in; the finality marker slides 200 ms
// when the finalized head moves; a bar that becomes final changes tone over
// 300 ms. Nothing moves between blocks; under prefers-reduced-motion every
// change is drawn in place. No bar glows: the live accent is the only mark
// of a block not yet final.
//
// Readings: the height, the finalized height, the finality lag, and blocks
// per minute. On load the rate is the index's last 200 block timestamps
// (/v1/blocks?limit=200); it switches to the blocks this page saw arrive once
// LIVE_MIN of them have, and is never mixed across the two, so an index that
// lags the chain cannot make one block look like hours. The rate is elapsed
// time over elapsed heights, never over blocks counted. It is never shown
// below MIN_RATE a minute: below that the chain is either stalled (no new
// block for STALL_MS, and the reading says "stalled") or the figure is not
// shown at all. Before any block arrives, the stall is timed from when the
// page began listening.

import { babePreDigestOf, hexToBytes, readCompact } from '../scale.js';
import { blockHashSource, blockSource } from '../data.js';

export const KEEP = 240; // blocks retained in the model
/** Bars on the plate at most: the trail. */
export const TRAIL = 60;
/** The chain's target block time (`SLOT_DURATION` in runtime/src/lib.rs). */
export const SLOT_MS = 6_000;
/** The Timestamp pallet's index in `construct_runtime`, and its one call, `set`. */
export const TIMESTAMP_PALLET_INDEX = 1;
const STATUS_POLL_MS = 6_000; // the fallback when the socket is down
const STATUS_ANNOUNCE_MS = 30_000; // screen-reader summary, at most this often
const CADENCE_WINDOW = 60; // live blocks the rhythm is computed over, once there are LIVE_MIN of them
/** Index block times the rate on load is computed over (the indexer's page size). */
export const INDEX_WINDOW = 200;
/** Live blocks this page must see before the rate is its own observation instead of the index's. */
export const LIVE_MIN = 10;
/** No new block for this long: the chain is stalled, and the rate says so. */
export const STALL_MS = 60_000;
/** Below this many blocks a minute a rate is never shown; the chain targets ten. */
export const MIN_RATE = 1;
const FINALITY_SAMPLES = 20;
const SETTLE_MS = 300; // a bar's change of tone when it becomes final
const OFFSET_SAMPLES = 12; // arrivals the arrival-to-chain-time offset is learned from

function headerNumber(header) {
  const n = header?.number;
  if (typeof n === 'string' && /^0x[0-9a-f]+$/i.test(n)) return parseInt(n, 16);
  if (typeof n === 'number') return n;
  throw new Error('header has no block number');
}

/** Identity of a header without its hash: height plus state root. */
function headerId(header) {
  if (typeof header?.stateRoot !== 'string') throw new Error('header has no state root');
  return `${headerNumber(header)}:${header.stateRoot}`;
}

/**
 * Blocks per minute and the mean interval over a run of timed blocks:
 * elapsed chain time over elapsed heights. Dividing by heights, not by the
 * blocks on hand, keeps a gap in the run (an index behind the chain, a
 * missed head) from reading as one very slow block. Pure; tested.
 */
export function rateOf(blocks) {
  const timed = blocks.filter((b) => !b.superseded && Number.isFinite(b.at)).sort((a, b) => a.number - b.number);
  if (timed.length < 2) return null;
  const first = timed[0];
  const last = timed[timed.length - 1];
  const heights = last.number - first.number;
  const span = last.at - first.at;
  if (heights <= 0 || span <= 0) return null;
  const intervalMs = span / heights;
  return { perMinute: 60_000 / intervalMs, intervalMs, blocks: timed.length, from: first.number, to: last.number };
}

/**
 * The moment a stall is measured from: the newest block's arrival or, before
 * any has arrived, when the page began listening for blocks — a page loaded
 * on a chain that has already stopped must still say so. Never earlier than
 * the tab was last shown: a tab hidden for minutes has seen no blocks because
 * it was not listening, not because the chain stopped. Null while the page is
 * not listening and nothing has arrived. Pure; tested.
 */
export function stallBase(lastArrival, shownAt, listeningSince = null) {
  const base = Number.isFinite(lastArrival) ? lastArrival : listeningSince;
  if (!Number.isFinite(base)) return null;
  return Number.isFinite(shownAt) ? Math.max(base, shownAt) : base;
}

/**
 * The rate the page shows. `stalled` when no new block has arrived for
 * STALL_MS (`lastArrival` is the wall-clock time of the newest one). Else the
 * index's last INDEX_WINDOW block times until LIVE_MIN blocks have been seen
 * live, then the last CADENCE_WINDOW live ones — one source or the other,
 * never a mix. Null when there is nothing to compute from, or when the result
 * is below MIN_RATE (a rate that low is a stall or a broken read, never a
 * figure). Pure; tested.
 */
export function cadenceOf(blocks, { now = null, lastArrival = null } = {}) {
  if (Number.isFinite(now) && Number.isFinite(lastArrival) && now - lastArrival > STALL_MS) {
    return { stalled: true, sinceMs: now - lastArrival };
  }
  const usable = blocks.filter((b) => !b.superseded && Number.isFinite(b.at));
  const live = usable.filter((b) => b.live);
  const source = live.length >= LIVE_MIN ? 'live' : 'index';
  const pool = source === 'live' ? live.slice(-CADENCE_WINDOW) : usable.filter((b) => !b.live).slice(-INDEX_WINDOW);
  const rate = rateOf(pool);
  if (!rate || rate.perMinute < MIN_RATE) return null;
  return { ...rate, source, stalled: false };
}

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The moment a block's timestamp inherent carries, from the hex of its first
 * extrinsic: length prefix, version byte (bare, so its high bit is clear),
 * pallet index, call index, then a compact u64 of milliseconds. Refuses
 * anything that is not `timestamp.set`, since guessing a time would put a
 * bar in the wrong place.
 */
export function timestampOf(extrinsicHex, palletIndex = TIMESTAMP_PALLET_INDEX) {
  const bytes = hexToBytes(extrinsicHex);
  const { next } = readCompact(bytes, 0);
  if (bytes.length < next + 3) throw new Error('extrinsic is too short to be timestamp.set');
  const version = bytes[next];
  if (version & 0x80) throw new Error('the first extrinsic is signed, not the timestamp inherent');
  if (bytes[next + 1] !== palletIndex || bytes[next + 2] !== 0) {
    throw new Error(`the first extrinsic is call ${bytes[next + 1]}.${bytes[next + 2]}, not timestamp.set`);
  }
  const { value } = readCompact(bytes, next + 3);
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) throw new Error('timestamp.set carries no moment');
  return ms;
}

/**
 * The height of a bar for a block's extrinsic count, as a fraction of the
 * plate: one extrinsic (the timestamp every block carries) is the floor, each
 * further one adds a step, and the bar never leaves the plate. A count that
 * is not known yet draws at the floor.
 */
export function barHeight(count, { floor = 0.26, step = 0.12, max = 0.94 } = {}) {
  if (!Number.isFinite(count) || count < 1) return floor;
  return Math.min(max, floor + (count - 1) * step);
}

/** The trail's fade: the newest bar is full ink, the oldest visible one faint. */
export function trailAlpha(k, visible = TRAIL, { min = 0.16 } = {}) {
  return Math.max(min, 1 - (k / visible) * (1 - min));
}

/**
 * The river's geometry for a plate `width` px wide: how many blocks it holds
 * at the chain's block time, the pixels per millisecond that follow, the bar
 * width and how many bars apart the labels go so they never overprint.
 */
export function riverLayout(width, { slotMs = SLOT_MS, labelPx = 84 } = {}) {
  const rightPad = 22;
  const leftPad = 4;
  const visible = Math.max(20, Math.min(TRAIL, Math.floor((width - rightPad - leftPad) / 17)));
  const pxPerMs = (width - rightPad - leftPad) / (visible * slotMs);
  const slotPx = pxPerMs * slotMs;
  const bar = Math.max(3, Math.min(8, Math.round(slotPx * 0.38)));
  const labelEvery = Math.max(1, Math.ceil(labelPx / slotPx));
  return { visible, pxPerMs, slotPx, bar, rightPad, leftPad, labelEvery };
}

/** The model: a bounded, ordered set of recent blocks with fork handling. Pure; tested. */
export class Stream {
  constructor() {
    this.blocks = []; // ascending by number; superseded blocks kept, flagged
    this.best = null;
    this.finalized = null;
    this.finalitySamples = [];
    this.offsetSamples = []; // arrival wall-clock minus chain time, from decoded live blocks
  }

  /** Adds an indexed block (chain time and extrinsic count known) without disturbing live ones. */
  seed({ number, id, at, count = null }) {
    if (this.blocks.some((b) => b.number === number)) return;
    this.blocks.push({ number, id, at, arrivedAt: NaN, count, live: false, superseded: false, settle: 1 });
    this.blocks.sort((a, b) => a.number - b.number);
    this.trim();
    if (this.best === null || number > this.best) this.best = number;
  }

  /** The arrival-to-chain-time offset the previous live blocks were seen with, in ms. */
  offset() {
    return median(this.offsetSamples) ?? 0;
  }

  /** A new best head. Returns what changed so the view can animate it. */
  head({ number, id, arrivedAt }) {
    let superseded = 0;
    for (const block of this.blocks) {
      if (block.superseded) continue;
      if (block.number > number || (block.number === number && block.id !== id)) {
        block.superseded = true;
        superseded += 1;
      }
    }
    const existing = this.blocks.find((b) => b.number === number && b.id === id);
    let added = false;
    if (existing) {
      existing.superseded = false;
    } else {
      this.blocks.push({
        number,
        id,
        at: arrivedAt - this.offset(),
        arrivedAt,
        count: null,
        live: true,
        superseded: false,
        settle: 0,
      });
      this.blocks.sort((a, b) => a.number - b.number);
      added = true;
    }
    this.trim();
    const advanced = this.best === null || number > this.best;
    this.best = number;
    return { added, advanced, superseded };
  }

  /** The block's body arrived: its extrinsic count and the chain's own time for it. */
  body(number, id, { count, at }) {
    const block = this.blocks.find((b) => b.number === number && b.id === id);
    if (!block) return false;
    if (Number.isFinite(count)) block.count = count;
    if (Number.isFinite(at)) {
      if (block.live && Number.isFinite(block.arrivedAt)) {
        this.offsetSamples.push(block.arrivedAt - at);
        if (this.offsetSamples.length > OFFSET_SAMPLES) this.offsetSamples.shift();
      }
      block.at = at;
    }
    return true;
  }

  finalize(number, now) {
    const advanced = this.finalized === null || number > this.finalized;
    if (!advanced) return { advanced: false, settled: [] };
    const settled = [];
    for (const block of this.blocks) {
      if (block.superseded || block.number > number || block.number <= (this.finalized ?? -1)) continue;
      if (block.live && Number.isFinite(block.arrivedAt)) this.finalitySamples.push(now - block.arrivedAt);
      settled.push(block);
    }
    if (this.finalitySamples.length > FINALITY_SAMPLES) {
      this.finalitySamples.splice(0, this.finalitySamples.length - FINALITY_SAMPLES);
    }
    this.finalized = number;
    return { advanced: true, settled };
  }

  trim() {
    if (this.blocks.length > KEEP) this.blocks.splice(0, this.blocks.length - KEEP);
  }

  /** Non-superseded blocks, newest first. */
  chain() {
    return this.blocks.filter((b) => !b.superseded).reverse();
  }

  lag() {
    if (this.best === null || this.finalized === null) return null;
    return Math.max(0, this.best - this.finalized);
  }

  /** Seconds a block takes to become final: measured when possible, else lag × interval. */
  finalitySeconds(cadence) {
    const measured = median(this.finalitySamples);
    if (measured !== null && this.finalitySamples.length >= 3) return { seconds: measured / 1000, measured: true };
    const lag = this.lag();
    if (lag === null || !cadence) return null;
    return { seconds: (lag * cadence.intervalMs) / 1000, measured: false };
  }
}

/**
 * Names the heights that were polled from /v1/status rather than streamed: they
 * have no header and no body, so their bars can only stand at the floor. A
 * polled height carries the `:status` id suffix. Empty when there are none.
 */
export function polledNote(blocks) {
  const n = blocks.filter((b) => !b.superseded && b.id.endsWith(':status')).length;
  if (!n) return '';
  return `${n} polled height${n === 1 ? '' : 's'} without a body, drawn at the floor`;
}

/**
 * `strip`, when given, is a second canvas the river is also drawn into — the
 * titled strip under the first screen, with its axis labels and its FINAL
 * marker, as section 01 draws it. It is the same stream and the same clock;
 * it is never a second source.
 */
export function init(root, ctx, { strip = null } = {}) {
  const canvas = root.querySelector('.pulse-canvas');
  const status = root.querySelector('.pulse-status');
  const targets = {
    best: ctx.reading('bestBlock', root),
    finalized: ctx.reading('finalizedBlock', root),
    lag: ctx.reading('finalityLag', root),
    perMinute: ctx.reading('blocksPerMinute', root),
  };

  const stream = new Stream();
  let headRecord = null; // provenance of the best-block figure
  let finalRecord = null; // provenance of the finalized figure
  let blocksRecord = null; // the index page the river was seeded from
  let liveCount = 0;
  let decodedCount = 0;
  let bodyNote = ''; // the latest body that could not be read, in words
  let mode = 'waiting';
  let stopPolling = null;
  let announcedAt = 0;
  let shownAt = null; // when the tab was last shown again: a stall is never counted across a hidden spell
  let listeningSince = null; // when the socket first opened or polling began: the stall clock before any block arrives

  // ── view state ──
  const box = ctx.fitCanvas(canvas, () => draw());
  const stripBox = strip ? ctx.fitCanvas(strip, () => draw()) : null;
  let anchor = { from: null, to: null, t: 1 }; // the chain time drawn at the right edge, sliding on arrival
  let marker = { fromX: null, t: 1 }; // the finality boundary, sliding when finality advances
  let cancelSlide = () => {};
  let cancelMarker = () => {};

  /** The stream's mode: waiting, live, polling, down or paused. The status bar says it in words. */
  function setMode(next) {
    mode = next;
  }

  // ── readouts ──
  /** Wall-clock time of the newest block that arrived (live or polled); null until one has. */
  function lastArrival() {
    let at = null;
    for (const b of stream.blocks) if (b.live && Number.isFinite(b.arrivedAt) && (at === null || b.arrivedAt > at)) at = b.arrivedAt;
    return at;
  }

  function showReadouts() {
    // With the socket and the poll both down there is no listening to time a stall against.
    const listening = mode === 'live' || mode === 'polling' ? listeningSince : null;
    const cadence = cadenceOf(stream.blocks, { now: ctx.now(), lastArrival: stallBase(lastArrival(), shownAt, listening) });
    if (headRecord && stream.best !== null) {
      ctx.readout.showValue(targets.best, headRecord, { value: stream.best, motion: ctx.motion });
    }
    if (finalRecord && stream.finalized !== null) {
      ctx.readout.showValue(targets.finalized, finalRecord, { value: stream.finalized, motion: ctx.motion });
      const lag = stream.lag();
      if (lag !== null) {
        ctx.readout.showValue(targets.lag, finalRecord, {
          value: lag,
          unit: lag === 1 ? ' block' : ' blocks',
          motion: ctx.motion,
        });
      }
    }
    // A stalled chain has no rate to give the dial: it keeps the last one, and the reading says "stalled".
    if (cadence && !cadence.stalled) ctx.bus.emit('cadence', { ...cadence, record: blocksRecord });
    if (blocksRecord && cadence?.stalled) {
      ctx.readout.showValue(targets.perMinute, blocksRecord, {
        value: 'stalled',
        extra: `no new block for ${Math.round(cadence.sinceMs / 1000)} s`,
      });
    } else if (blocksRecord && cadence) {
      const finality = stream.finalitySeconds(cadence);
      const polled = polledNote(stream.blocks);
      const fmt = ctx.format.formatInteger;
      const basis =
        cadence.source === 'live'
          ? `${cadence.blocks} blocks observed live, #${fmt(cadence.from)}–#${fmt(cadence.to)}`
          : `the index's last ${cadence.blocks} block times, #${fmt(cadence.from)}–#${fmt(cadence.to)}` +
            `${liveCount ? `; live from ${LIVE_MIN} observed blocks (${liveCount} so far)` : ''}`;
      ctx.readout.showValue(targets.perMinute, blocksRecord, {
        value: cadence.perMinute.toFixed(1),
        extra:
          basis +
          `${decodedCount ? `, ${decodedCount} bodies read over ${ctx.RPC_URL.replace('wss://', '')}` : ''}` +
          `${finality ? ` · finality within ${finality.measured ? '' : 'about '}${Math.round(finality.seconds)} s${finality.measured ? ', measured' : ''}` : ''}` +
          `${bodyNote ? ` · ${bodyNote}` : ''}` +
          `${polled ? ` · ${polled}` : ''}`,
      });
    }
    announce(cadence);
  }

  function announce(cadence) {
    if (!status || ctx.now() - announcedAt < STATUS_ANNOUNCE_MS) return;
    if (stream.best === null) return;
    announcedAt = ctx.now();
    const parts = [`Block ${ctx.format.formatInteger(stream.best)} produced.`];
    if (stream.finalized !== null) parts.push(`Block ${ctx.format.formatInteger(stream.finalized)} final.`);
    if (cadence?.stalled) parts.push(`No new block for ${Math.round(cadence.sinceMs / 1000)} seconds: the chain is stalled.`);
    else if (cadence) parts.push(`${cadence.perMinute.toFixed(0)} blocks per minute.`);
    status.textContent = parts.join(' ');
  }

  // ── drawing ──
  function newestAt() {
    const chain = stream.chain();
    for (const block of chain) if (Number.isFinite(block.at)) return block.at;
    return null;
  }

  function anchorAt() {
    if (anchor.to === null) return newestAt();
    if (anchor.from === null || anchor.t >= 1) return anchor.to;
    return anchor.from + (anchor.to - anchor.from) * anchor.t;
  }

  function draw() {
    paint(box());
    if (stripBox) paint(stripBox());
  }

  /** One plate, with its axis labels and its labelled FINAL marker: section 01's, or the strip under the hero. */
  function paint({ context: g, width, height }) {
    const { pxPerMs, bar, rightPad, labelEvery, visible } = riverLayout(width);
    const baseline = Math.round(height - 22) + 0.5;
    const plateTop = 24;
    const plateHeight = baseline - plateTop;
    const chain = stream.chain();
    const font = ctx.theme.font('mono');
    const colour = (name) => ctx.theme.color(name);
    const right = width - rightPad;
    const at0 = anchorAt();

    g.clearRect(0, 0, width, height);
    if (at0 === null) {
      g.strokeStyle = colour('border');
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, baseline);
      g.lineTo(width, baseline);
      g.stroke();
      return;
    }
    const xOf = (block) => right - (at0 - block.at) * pxPerMs;

    // The finalized region: a tinted band up to the newest final bar, with a labelled marker.
    let boundary = null;
    if (stream.finalized !== null) {
      const final = chain.find((b) => b.number <= stream.finalized && Number.isFinite(b.at));
      const target = final ? xOf(final) + bar / 2 + Math.max(3, bar * 0.6) : 0;
      boundary = marker.fromX !== null && marker.t < 1 ? marker.fromX + (target - marker.fromX) * marker.t : target;
      marker.target = target;
      // No tint: the final bars are already the settled tone, and a tinted
      // band read as a slab. The labelled marker is the boundary.
      g.strokeStyle = colour('settled');
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(Math.round(boundary) + 0.5, 4);
      g.lineTo(Math.round(boundary) + 0.5, baseline);
      g.stroke();
      // The marker is always labelled: a hairline is never left unexplained.
      g.fillStyle = colour('text-dim');
      g.font = `400 12px ${font}`;
      g.textBaseline = 'top';
      const label = `FINAL · ${ctx.format.formatInteger(stream.finalized)}`;
      const labelWidth = g.measureText(label).width;
      if (boundary - 6 - labelWidth >= 2) {
        g.textAlign = 'right';
        g.fillText(label, boundary - 6, 4);
      } else {
        g.textAlign = 'left';
        g.fillText(label, boundary + 6, 4);
      }
    }

    // Baseline.
    g.strokeStyle = colour('border');
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, baseline);
    g.lineTo(width, baseline);
    g.stroke();

    // Superseded blocks: a dashed outline at their time, in the slashed colour.
    g.setLineDash([2, 3]);
    g.strokeStyle = colour('slashed');
    g.lineWidth = 1;
    for (const block of stream.blocks) {
      if (!block.superseded || !Number.isFinite(block.at)) continue;
      const x = xOf(block);
      if (x < -bar || x > width) continue;
      const h = plateHeight * barHeight(block.count);
      g.strokeRect(Math.round(x - bar / 2) + 0.5, Math.round(baseline - h) + 0.5, bar, h - 1);
    }
    g.setLineDash([]);

    // Bars, newest at the right, fading to the left.
    g.textAlign = 'center';
    g.textBaseline = 'top';
    let k = 0;
    for (const block of chain) {
      if (!Number.isFinite(block.at)) continue;
      const x = xOf(block);
      if (x < -bar) break;
      const final = stream.finalized !== null && block.number <= stream.finalized;
      const h = plateHeight * barHeight(block.count);
      const left = Math.round(x - bar / 2);
      const top = Math.round(baseline - h);
      const fade = trailAlpha(k, visible);
      const pending = block.count === null ? 0.55 : 1;
      // Two coats: the settled tone beneath, the live accent above, fading out as the bar settles.
      const settle = final ? block.settle : 0;
      if (settle > 0) {
        g.globalAlpha = fade * settle * pending;
        g.fillStyle = colour('settled');
        g.fillRect(left, top, bar, h);
      }
      if (settle < 1) {
        g.globalAlpha = fade * (1 - settle) * pending;
        g.fillStyle = colour('live');
        g.fillRect(left, top, bar, h);
      }
      g.globalAlpha = 1;
      // A label needs room on both sides; one that would be cut by the plate's edge is left off.
      if ((k === 0 || block.number % labelEvery === 0) && x > 30 && x < width - 30) {
        g.fillStyle = k === 0 ? colour('text') : colour('text-dim');
        g.font = `400 12px ${font}`;
        g.fillText(ctx.format.formatInteger(block.number), Math.round(x), baseline + 6);
      }
      k += 1;
    }
  }

  function animateArrival(previousAt, nextAt) {
    cancelSlide();
    if (ctx.motion.reduced() || !Number.isFinite(previousAt) || !Number.isFinite(nextAt)) {
      anchor = { from: null, to: nextAt, t: 1 };
      draw();
      return;
    }
    anchor = { from: anchorAt() ?? previousAt, to: nextAt, t: 0 };
    cancelSlide = ctx.motion.tween(200, (t) => {
      anchor.t = t;
      draw();
    });
  }

  function animateMarker() {
    cancelMarker();
    if (ctx.motion.reduced() || marker.target === undefined) {
      marker = { fromX: null, t: 1 };
      draw();
      return;
    }
    const fromX = marker.fromX !== null && marker.t < 1 ? marker.fromX + (marker.target - marker.fromX) * marker.t : marker.target;
    marker = { fromX, t: 0 };
    cancelMarker = ctx.motion.tween(200, (t) => {
      marker.t = t;
      draw();
    });
  }

  /** Bars that just became final change tone from live to settled, once. */
  function animateSettle(settled) {
    const bars = settled.filter((b) => b.settle < 1);
    if (bars.length === 0) return;
    if (ctx.motion.reduced()) {
      for (const b of bars) b.settle = 1;
      draw();
      return;
    }
    ctx.motion.tween(SETTLE_MS, (t) => {
      for (const b of bars) b.settle = t;
      draw();
    });
  }

  // ── data ──
  async function readBody(number, id) {
    const hashRecord = await ctx.fetch(blockHashSource(number));
    if (!hashRecord.ok) {
      bodyNote = `block #${ctx.format.formatInteger(number)}: hash not read (${hashRecord.error})`;
      return;
    }
    let hash;
    try {
      hash = ctx.field(hashRecord.data, 'result');
    } catch (error) {
      bodyNote = `block #${ctx.format.formatInteger(number)}: ${error.message}`;
      return;
    }
    const record = await ctx.fetch(blockSource(hash));
    if (!record.ok) {
      bodyNote = `block #${ctx.format.formatInteger(number)}: body not read (${record.error})`;
      return;
    }
    try {
      const extrinsics = ctx.field(record.data, 'result.block.extrinsics');
      if (!Array.isArray(extrinsics) || extrinsics.length === 0) throw new Error('block body carries no extrinsics');
      const at = timestampOf(extrinsics[0]);
      const changed = stream.body(number, id, { count: extrinsics.length, at });
      decodedCount += 1;
      bodyNote = '';
      if (changed) {
        // A decoded time moves the newest bar from its estimate to the chain's clock.
        const chain = stream.chain();
        if (chain[0]?.number === number) animateArrival(anchorAt(), at);
        else draw();
      }
    } catch (error) {
      bodyNote = `block #${ctx.format.formatInteger(number)}: ${error.message}`;
    }
    showReadouts();
  }

  function onHead(record) {
    const header = record.data;
    const number = headerNumber(header);
    const id = headerId(header);
    const now = ctx.now();
    const previousAt = newestAt();
    const change = stream.head({ number, id, arrivedAt: now });
    headRecord = record;
    liveCount += change.added ? 1 : 0;
    let author = null;
    try {
      author = babePreDigestOf(header);
    } catch (error) {
      author = { error: error.message };
    }
    ctx.bus.emit('head', { record, number, header, author, forked: change.superseded > 0, arrivedAt: now });
    if (mode !== 'live') setMode('live');
    showReadouts();
    if (change.advanced && change.added) animateArrival(previousAt, newestAt());
    else draw();
    if (change.added) readBody(number, id);
  }

  function onFinalized(record) {
    const number = headerNumber(record.data);
    const change = stream.finalize(number, ctx.now());
    finalRecord = record;
    ctx.bus.emit('finalized', { record, number });
    showReadouts();
    if (change.advanced) {
      animateMarker();
      animateSettle(change.settled);
    }
  }

  function onStatus(record) {
    // Polling fallback: /v1/status has no headers, so bars are placed by the poll time alone.
    if (!record.ok) {
      setMode('down');
      ctx.readout.showError(targets.best, record);
      ctx.readout.showError(targets.finalized, record);
      ctx.readout.showError(targets.lag, record);
      ctx.bus.emit('poll', { record, number: null, finalized: null, arrivedAt: ctx.now() });
      draw();
      return;
    }
    try {
      const best = ctx.field(record.data, 'chain.bestBlock');
      const finalized = ctx.field(record.data, 'chain.finalizedBlock');
      const previousAt = newestAt();
      const change = stream.head({ number: best, id: `${best}:status`, arrivedAt: ctx.now() });
      const fin = stream.finalize(finalized, ctx.now());
      headRecord = record;
      finalRecord = record;
      
      // A polled height is not a head: it has no header and no author, so it
      // goes out as `poll`, and `head` keeps its contract for the instruments.
      ctx.bus.emit('poll', { record, number: best, finalized, arrivedAt: ctx.now() });
      showReadouts();
        if (change.advanced && change.added) animateArrival(previousAt, newestAt());
      if (fin.advanced) {
        animateMarker();
        animateSettle(fin.settled);
      } else if (!(change.advanced && change.added)) draw();
    } catch (error) {
      ctx.readout.showError(targets.best, record, error.message);
      ctx.readout.showError(targets.finalized, record, error.message);
      ctx.readout.showError(targets.lag, record, error.message);
    }
  }

  function startPolling() {
    if (stopPolling) return;
    setMode('polling');
    listeningSince ??= ctx.now();
    stopPolling = ctx.watch('status', onStatus, STATUS_POLL_MS);
  }

  function stopPollingIfAny() {
    if (!stopPolling) return;
    stopPolling();
    stopPolling = null;
  }

  ctx.bus.on('socket', ({ state, attempts }) => {
    if (state === 'open') {
      stopPollingIfAny();
      if (mode !== 'live') setMode('live');
      listeningSince ??= ctx.now();
    } else if (state === 'failed' || (state === 'closed' && attempts >= 1)) {
      startPolling();
    } else if (state === 'paused') {
      setMode('paused');
    }
  });

  ctx.bus.on('visibility', ({ hidden }) => {
    if (hidden) return;
    shownAt = ctx.now();
    // Fill the gap the hidden interval left, from the index.
    seed();
  });

  async function seed() {
    const [statusRecord, blocks] = await Promise.all([ctx.fetch(ctx.SOURCES.status), ctx.fetch(ctx.SOURCES.blocks)]);
    if (blocks.ok) {
      try {
        const items = ctx.field(blocks.data, 'items');
        for (const item of items) {
          const number = ctx.field(item, 'number');
          const at = item.timestampMs === null || item.timestampMs === undefined ? NaN : Number(item.timestampMs);
          const count = ctx.field(item, 'extrinsicCount');
          stream.seed({ number, id: `${number}:${ctx.field(item, 'hash')}`, at, count });
        }
        blocksRecord = blocks;
      } catch (error) {
        ctx.readout.showError(targets.perMinute, blocks, error.message);
      }
    } else {
      ctx.readout.showError(targets.perMinute, blocks);
    }
    if (headRecord === null || finalRecord === null) {
      // Nothing has arrived over the socket yet: show the indexed position now.
      if (statusRecord.ok) {
        try {
          const best = ctx.field(statusRecord.data, 'chain.bestBlock');
          const finalized = ctx.field(statusRecord.data, 'chain.finalizedBlock');
          if (stream.best === null || best > stream.best) stream.seed({ number: best, id: `${best}:status`, at: NaN });
          const fin = stream.finalize(finalized, ctx.now());
          for (const b of fin.settled) b.settle = 1;
          headRecord ??= statusRecord;
          finalRecord ??= statusRecord;
          ctx.bus.emit('poll', { record: statusRecord, number: best, finalized, arrivedAt: ctx.now() });
        } catch (error) {
          ctx.readout.showError(targets.best, statusRecord, error.message);
        }
      } else {
        ctx.readout.showError(targets.best, statusRecord);
        ctx.readout.showError(targets.finalized, statusRecord);
        ctx.readout.showError(targets.lag, statusRecord);
      }
    }
    showReadouts();
    draw();
  }

  seed();
  ctx.subscribe('newHeads', (record) => {
    try {
      onHead(record);
    } catch (error) {
      ctx.readout.showError(targets.best, record, error.message);
    }
  });
  ctx.subscribe('finalizedHeads', (record) => {
    try {
      onFinalized(record);
    } catch (error) {
      ctx.readout.showError(targets.finalized, record, error.message);
    }
  });
  ctx.bus.on('theme', () => draw());
  draw();
  // Re-reads the rate with no new block, so a stall is said within a check of STALL_MS (main.js holds the timer).
  return { tick: () => showReadouts() };
}
