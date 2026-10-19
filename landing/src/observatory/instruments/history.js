// 04 · History strips. Four small multiples of the chain's own record, each
// saying where its history begins. Nothing is extrapolated and nothing is
// faked: a strip that cannot be filled says so instead of drawing a guess,
// and a running total is marked as derived from the record it is summed from.
//
// Data (all polled once a minute through the shared scheduler):
//   blockTime             /v1/blocks?limit=200 — the seconds between consecutive
//                         blocks, oldest to newest, drawn inside the 5.5–6.5 s
//                         target band. A pair with no timestamp is a break in
//                         the line, not a segment.
//   agreementsCumulative  /v1/eras?limit=14 for the era boundaries, and the
//                         escrow.AgreementCreated events read back to the start
//                         of the oldest era drawn (agreementsReadFrom), counted
//                         into the twelve most recent whole settled eras plus
//                         the era still open; the running total over those eras
//                         (derived) is the line, the counts are the bars behind
//                         it. Eras whose span the fetched events do not reach
//                         are dropped, never shown short.
//   emissionCumulative    every settled era the index holds (/v1/eras, read
//                         whole) — the CMN each settlement paid out, as the
//                         pallet reported it, summed into a running total
//                         (derived); the per-era figure is the thin line. Total
//                         issuance from every source, from /v1/emissions/supply,
//                         is given beneath as context: it counts the genesis
//                         endowment and validator rewards too, so it is never
//                         shown as what agents were paid.
//   agentsOverTime        every agents.AgentRegistered and UnstakeCompleted
//                         event the index holds, walked forward from the agents
//                         that /v1/agents says were registered before the index
//                         began. The two must reconcile with today's total, or
//                         the strip is unavailable rather than a wrong line.
//
// Drawing: one SVG per strip, sized to its box (a ResizeObserver re-fits it),
// every one drawn from zero, with the zero line (`plot-zero`) in the text's
// dim ink so the four read as small multiples on one axis style;
// with d3-scale for the axes and d3-shape for the paths. Colours come from
// the design system's classes, so light and dark are the stylesheet's. None
// of it is live data — every figure here is history — so nothing in these
// strips uses the live accent.
//
// Motion: a strip is revealed left to right over 350 ms the first time it has
// data to show, once; later polls and resizes redraw without motion.

import { scaleBand, scaleLinear } from 'd3-scale';
import { area, curveLinear, curveStepAfter, line } from 'd3-shape';
import { max, mean, min } from 'd3-array';

const INTERVAL_MS = 60_000;
/** The chain's target block time (`SLOT_DURATION` in runtime/src/lib.rs). */
export const NOMINAL_BLOCK_S = 6;
/** The band a block time is counted as on target inside: half a second either side of the slot. */
export const TARGET_BAND_S = [5.5, 6.5];
/** The block-time strip's fixed ceiling, so the band reads at the same height every visit. */
export const BLOCK_TIME_CEILING_S = 12;
/** Whole settled eras a strip shows at most. */
export const ERAS_SHOWN = 12;
/** Pages of /v1/eras read for the running total: 200 eras a page, about 50 days each. */
export const ERAS_ALL_PAGES = 3;
/** Pages of AgreementCreated events read back to the oldest era drawn: 25 × 200 before a span is dropped as not reached. */
export const AGREEMENT_PAGES = 25;

/**
 * The block the agreement events are read back to: the start of the oldest
 * whole era the strip draws, or of the era still open when there is no whole
 * one yet; null until the era boundaries are known. Reading to it, and no
 * further, is what lets the strip reach back all twelve eras without paging
 * through the index's whole history. Pure; tested.
 */
export function agreementsReadFrom({ whole, open }) {
  if (whole.length) return whole[0].start;
  return open ? open.start : null;
}

/**
 * Where the agreements read starts, from the eras record: `{ from, error:
 * null }`, or `{ from: null, error }` saying why it cannot start yet — the
 * eras read failed, its body could not be read, or no era is recorded. The
 * strip shows that reason rather than waiting in silence. Pure; tested.
 */
export function agreementsStart(eras, field) {
  if (!eras?.ok) return { from: null, error: eras?.error ?? 'not read' };
  let from;
  try {
    from = agreementsReadFrom(eraSpans(field(eras.data, 'items'), field));
  } catch (error) {
    return { from: null, error: error.message };
  }
  return from === null ? { from: null, error: 'no era recorded yet' } : { from, error: null };
}

/**
 * 12 × 200 registrations. The public network carries about 200 operator-run
 * agents; this is headroom well past that (a 1,000-agent run lives on the
 * dev-fast replica, not here).
 */
export const REGISTRATION_PAGES = 12;
/** The drawing box before the strip has been measured. */
export const DEFAULT_WIDTH = 300;
export const DEFAULT_HEIGHT = 88;
const REVEAL_MS = 350;
/** The smallest mark for the era still open, so "in progress" is visible even at zero. */
const OPEN_BAR_MIN_PX = 2;

// ── pure helpers (unit-tested) ────────────────────────────────────────────────

/**
 * Seconds between consecutive blocks, oldest to newest, from a newest-first
 * page of /v1/blocks. A pair with a null timestamp, or a gap in the block
 * numbers, is kept as a sentinel with `seconds: NaN` so the line breaks there
 * instead of being drawn across it; `skipped` counts them. A block without a
 * `timestampMs` key at all is a decode failure, not a skip.
 */
export function blockIntervals(items, field) {
  const blocks = items
    .map((item) => {
      if (item === null || typeof item !== 'object' || !('timestampMs' in item)) {
        throw new Error('response has no timestampMs');
      }
      return { number: field(item, 'number'), at: item.timestampMs === null ? NaN : Number(item.timestampMs) };
    })
    .sort((a, b) => a.number - b.number);
  const points = [];
  let skipped = 0;
  for (let i = 1; i < blocks.length; i += 1) {
    const a = blocks[i - 1];
    const b = blocks[i];
    if (b.number !== a.number + 1 || !Number.isFinite(a.at) || !Number.isFinite(b.at)) {
      skipped += 1;
      points.push({ number: b.number, seconds: NaN });
      continue;
    }
    points.push({ number: b.number, seconds: (b.at - a.at) / 1000 });
  }
  return {
    points,
    skipped,
    blocks: blocks.length,
    first: blocks.length ? blocks[0].number : null,
    last: blocks.length ? blocks[blocks.length - 1].number : null,
  };
}

const isMeasured = (p) => Number.isFinite(p.seconds);

/** Last, mean, min and max of the measured intervals; null when there is none. */
export function intervalStats(points) {
  const seconds = points.filter(isMeasured).map((p) => p.seconds);
  if (seconds.length === 0) return null;
  return {
    last: seconds[seconds.length - 1],
    mean: mean(seconds),
    min: min(seconds),
    max: max(seconds),
    measured: seconds.length,
  };
}

/** How many measured intervals fall inside the target band, inclusive at both edges. */
export function withinBand(points, [low, high] = TARGET_BAND_S) {
  const measured = points.filter(isMeasured);
  const within = measured.filter((p) => p.seconds >= low && p.seconds <= high).length;
  return { within, measured: measured.length };
}

/** The interval line: breaks at every sentinel rather than bridging it. */
export function intervalLine(x, y) {
  return line()
    .defined(isMeasured)
    .x((p) => x(p.number))
    .y((p) => y(p.seconds))
    .curve(curveLinear);
}

/** The faint area under the interval line, broken at the same places. */
export function intervalArea(x, y, bottom) {
  return area()
    .defined(isMeasured)
    .x((p) => x(p.number))
    .y0(bottom)
    .y1((p) => y(p.seconds));
}

/**
 * The contiguous run of era entries (sorted by era, ascending) that ends at
 * the newest one. A missing entry leaves a boundary unknown, so anything
 * older than the gap is not used.
 */
export function contiguousRun(sorted) {
  let start = sorted.length - 1;
  while (start > 0 && sorted[start - 1].era === sorted[start].era - 1) start -= 1;
  return sorted.slice(Math.max(0, start));
}

/**
 * Era spans from a /v1/eras page: item 0 is the era in progress (with its
 * start block), the rest are settled, newest first. Settled era k spans
 * [settledAtBlock(k−1), settledAtBlock(k)), so n settled entries give n−1
 * whole eras; only the contiguous run ending at the newest settled era is
 * used. Returns the whole eras oldest first (at most `limit`), the open era
 * when present, and the settled run itself.
 */
export function eraSpans(items, field, limit = ERAS_SHOWN) {
  const settled = items
    .filter((item) => field(item, 'settled') === true)
    .map((item) => ({ era: field(item, 'era'), settledAt: field(item, 'settledAtBlock') }))
    .sort((a, b) => a.era - b.era);
  const run = contiguousRun(settled);
  const whole = [];
  for (let i = 1; i < run.length; i += 1) {
    whole.push({ era: run[i].era, start: run[i - 1].settledAt, end: run[i].settledAt });
  }
  const current = items.find((item) => field(item, 'settled') === false) ?? null;
  const open = current ? { era: field(current, 'era'), start: field(current, 'startBlock') } : null;
  return { whole: whole.slice(-limit), open, settled: run };
}

/**
 * Counts newest-first events (with `blockNumber`) into era spans. A span is
 * only kept when the events on hand cover all of it: when the list was cut
 * short (`complete` false) the oldest block fetched may hold further events
 * beyond the cut, so the floor is the block after it, and the index's own
 * first block is always a floor. Spans below the floor are dropped and
 * `historyFrom` says where the kept history begins.
 */
export function bucketByEra(spans, open, events, { complete = true, indexFrom = null } = {}) {
  let floor = Number.isFinite(indexFrom) ? indexFrom : -Infinity;
  const oldest = events.length ? Math.min(...events.map((e) => e.blockNumber)) : null;
  if (!complete && oldest !== null) floor = Math.max(floor, oldest + 1);
  const kept = spans.filter((span) => span.start >= floor).map((span) => ({ ...span, count: 0 }));
  const dropped = spans.length - kept.length;
  const soFar = open ? { ...open, count: 0 } : null;
  for (const event of events) {
    const b = event.blockNumber;
    const span = kept.find((s) => b >= s.start && b < s.end);
    if (span) span.count += 1;
    else if (soFar && b >= soFar.start) soFar.count += 1;
  }
  return {
    buckets: kept,
    open: soFar,
    dropped,
    historyFrom: kept.length ? kept[0].start : soFar?.start ?? null,
  };
}

/** Running totals of a series of numbers, in order: the derived line the strips draw. */
export function cumulativeTotals(values) {
  const out = [];
  let running = 0;
  for (const value of values) {
    running += value;
    out.push(running);
  }
  return out;
}

/** Running totals of a series of planck strings, exact (BigInt), in order. */
export function cumulativePlancks(plancks) {
  const out = [];
  let running = 0n;
  for (const value of plancks) {
    running += BigInt(value);
    out.push(running.toString());
  }
  return out;
}

/**
 * The settled eras' emission, oldest first, as numbers for a scale and as
 * plancks for the figure. Only the contiguous run ending at the newest
 * settled era is shown, so a hole in the page shortens the strip rather than
 * hiding inside it. With no `limit`, every era in the run.
 */
export function emissionSeries(items, field, cmnNumber, limit = ERAS_SHOWN) {
  const settled = items
    .filter((item) => field(item, 'settled') === true)
    .map((item) => ({
      era: field(item, 'era'),
      settledAt: field(item, 'settledAtBlock'),
      plancks: String(field(item, 'totalEmissionPlancks')),
    }))
    .sort((a, b) => a.era - b.era);
  const run = contiguousRun(settled);
  return (Number.isFinite(limit) ? run.slice(-limit) : run).map((entry) => ({ ...entry, cmn: cmnNumber(entry.plancks) }));
}

/**
 * Total issuance against the cap from a /v1/emissions/supply response: the
 * two planck strings the figure is set from and the percentage as the indexer
 * computed it. Throws on a missing field or a figure that is not a count.
 */
export function supplyFigures(data, field) {
  const issued = String(field(data, 'totalIssuancePlancks'));
  const cap = String(field(data, 'capPlancks'));
  const percent = field(data, 'percentIssued');
  if (!/^\d+$/.test(issued) || !/^\d+$/.test(cap)) throw new Error('supply figures are not counts of plancks');
  if (!Number.isFinite(percent)) throw new Error('response has a non-numeric percentIssued');
  return { issuedPlancks: issued, capPlancks: cap, percent };
}

/**
 * The agents /v1/agents lists as registered before the index began (their
 * `registeredAtBlock` is below `indexFrom`), and how many the page listed.
 * Throws when the page does not hold the whole list, since the count would
 * then be a floor.
 */
export function agentsBefore(items, field, indexFrom, total) {
  if (items.length < total) {
    throw new Error(`the agent list holds ${total} agents but only ${items.length} were listed`);
  }
  const before = items.filter((item) => field(item, 'registeredAtBlock') < indexFrom).length;
  return { before, listed: items.length };
}

/**
 * The cumulative count of registered agents over block number, from the
 * start of the index to now. Agents registered before the index began are
 * not in it as events, so they are the baseline, taken from the agent list
 * itself (`before`). The events must explain the whole difference between
 * that baseline and today's total: an agent removed some other way (a slash
 * that emptied its stake emits no departure event) would make the line wrong,
 * so the series throws instead of drawing.
 */
export function agentSteps({ registrations, unstakes, totalNow, before, indexFrom, nowBlock }) {
  const baseline = before;
  const explained = baseline + registrations.length - unstakes.length;
  if (!Number.isFinite(baseline) || baseline < 0 || explained !== totalNow) {
    throw new Error(
      `registrations and departures in the index do not reconcile with the agent list ` +
        `(${baseline} before the index + ${registrations.length} − ${unstakes.length} ≠ ${totalNow})`,
    );
  }
  const deltas = [
    ...registrations.map((b) => ({ block: b, delta: 1 })),
    ...unstakes.map((b) => ({ block: b, delta: -1 })),
  ].sort((a, b) => a.block - b.block || b.delta - a.delta);
  const start = deltas.length ? Math.min(indexFrom, deltas[0].block) : indexFrom;
  const points = [{ block: start, count: baseline }];
  let running = baseline;
  for (const { block, delta } of deltas) {
    running += delta;
    points.push({ block, count: running });
  }
  const end = Number.isFinite(nowBlock) ? Math.max(nowBlock, points[points.length - 1].block) : null;
  if (end !== null && end > points[points.length - 1].block) points.push({ block: end, count: running });
  return { baseline, points, registrations: registrations.length, unstakes: unstakes.length, total: running, start, end };
}

/** Above this many steps the agents-over-time line is drawn from a thinned series. */
export const MAX_STEP_POINTS = 240;

/**
 * Thins a step series to at most `max` points for drawing: the blocks are cut
 * into `max` equal spans and each span keeps its last point, so the line
 * still passes through every span's closing count, and the first and last
 * points are always kept. A strip a few hundred pixels wide cannot show more,
 * and 2,000 registrations no longer mean a 2,000-vertex path. The figure and
 * the summary still come from the whole series. Pure; tested.
 */
export function thinSteps(points, max = MAX_STEP_POINTS) {
  if (points.length <= max) return points;
  const first = points[0];
  const last = points[points.length - 1];
  const span = Math.max(1, last.block - first.block) / (max - 2);
  const kept = [first];
  let bucket = 0;
  let pending = null;
  for (let i = 1; i < points.length - 1; i += 1) {
    const b = Math.floor((points[i].block - first.block) / span);
    if (pending && b !== bucket) kept.push(pending);
    bucket = b;
    pending = points[i];
  }
  if (pending) kept.push(pending);
  kept.push(last);
  return kept;
}

/** The drawing frame inside a strip: room at the bottom for the end labels. */
export function plotFrame(width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT) {
  const left = 1;
  const right = width - 1;
  const top = 6;
  const bottom = height - 16;
  return { width, height, left, right, top, bottom, innerWidth: right - left, innerHeight: bottom - top };
}

/** The ceiling of a y scale: never zero, and a little above the tallest value. */
export function yCeiling(values, floor = 1) {
  const top = max(values) ?? 0;
  return Math.max(floor, top * 1.08);
}

/** Approximate width of `text` in the plot's 11 px mono labels. */
export const NOTE_CHAR_PX = 6.6;

/**
 * Where a note fits in a plot without the line running through it. The note
 * sits top-left when the marks under its extent stay clear of the top;
 * otherwise bottom-left when they stay clear of the baseline; otherwise
 * top-left, where its halo keeps it legible. `topAtLeft` and `bottomAtLeft`
 * are the smallest and largest y of the marks under the note's extent.
 */
export function notePosition(frame, topAtLeft, bottomAtLeft = topAtLeft) {
  const top = { x: frame.left + 3, y: frame.top + 8 };
  const bottom = { x: frame.left + 3, y: frame.bottom - 4 };
  if (!Number.isFinite(topAtLeft)) return top;
  if (topAtLeft > top.y + 6) return top;
  if (Number.isFinite(bottomAtLeft) && bottomAtLeft < bottom.y - 12) return bottom;
  return top;
}

/** Height of the bar for the era still open: never invisible, even at zero. */
export function openBarHeight(height, min = OPEN_BAR_MIN_PX) {
  return Math.max(min, height);
}

// ── SVG ───────────────────────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, className = '') {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (className) node.setAttribute('class', className);
  return node;
}

function label(x, y, content, anchor = 'start', className = 'plot-label') {
  const node = el('text', { x, y, 'text-anchor': anchor }, className);
  node.textContent = content;
  return node;
}

const fix = (n) => Number(n.toFixed(2));

/** One strip: its plot box, its reading, and the state needed to redraw it. */
class Strip {
  constructor(root, ctx, key) {
    this.ctx = ctx;
    this.key = key;
    this.target = ctx.reading(key, root);
    this.plot = this.target?.querySelector('[data-plot]') ?? null;
    this.drawn = null; // the last draw function, re-run on resize
    this.revealed = false; // the one reveal has run for the data on show
    this.cancel = () => {};
    if (this.target) {
      // Belt and braces for the figure's accessible name: the h3 inside the
      // caption names the figure explicitly, whatever the caption's box is.
      const heading = this.target.querySelector('.reading-label');
      if (heading) {
        heading.id ||= `history-${key}-label`;
        this.target.setAttribute('aria-labelledby', heading.id);
      }
    }
    if (this.plot && typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => {
        if (this.drawn) this.draw(this.drawn, { animate: false });
      }).observe(this.plot);
    }
  }

  size() {
    const width = this.plot?.clientWidth || DEFAULT_WIDTH;
    const height = this.plot?.clientHeight || DEFAULT_HEIGHT;
    return plotFrame(width, height);
  }

  /**
   * Replaces the plot with a fresh SVG built by `build(frame, svg, group)`.
   * The first drawing with data is revealed left to right; every later one
   * (a poll, a resize) is put in place without motion.
   */
  draw(build, { animate = true } = {}) {
    if (!this.plot) return;
    this.drawn = build;
    const frame = this.size();
    const svg = el('svg', {
      viewBox: `0 0 ${frame.width} ${frame.height}`,
      role: 'img',
      'aria-label': '',
    });
    const clipId = `history-${this.key}-reveal`;
    const clip = el('clipPath', { id: clipId });
    const window_ = el('rect', { x: 0, y: 0, width: frame.width, height: frame.height });
    clip.append(window_);
    const defs = el('defs');
    defs.append(clip);
    svg.append(defs);
    const group = el('g', { 'clip-path': `url(#${clipId})` });
    const summary = build(frame, svg, group) ?? '';
    svg.append(group);
    svg.setAttribute('aria-label', summary);
    this.plot.replaceChildren(svg);

    this.cancel();
    if (!animate || this.revealed) return;
    this.revealed = true;
    this.cancel = this.ctx.motion.tween(REVEAL_MS, (t) => {
      // The first frame's timestamp can precede the tween's start, so t is clamped here.
      window_.setAttribute('width', String(frame.width * Math.min(1, Math.max(0, t))));
    });
  }

  /** No figure and no plot: the box shows only the reason in its label. Data arriving later is revealed afresh. */
  clear(reason) {
    this.revealed = false;
    this.draw(() => reason, { animate: false });
  }
}

// ── the instrument ────────────────────────────────────────────────────────────

export function init(root, ctx) {
  const { formatInteger, formatCmn, cmnNumber, utcTime } = ctx.format;
  const strips = {
    blockTime: new Strip(root, ctx, 'blockTime'),
    agreements: new Strip(root, ctx, 'agreementsCumulative'),
    emission: new Strip(root, ctx, 'emissionCumulative'),
    agents: new Strip(root, ctx, 'agentsOverTime'),
  };
  const records = { eras: null, erasAll: null, supply: null, agreements: null, registrations: null, unstakes: null, agents: null };

  /**
   * Shows a strip from one or more records. `needed[0]` is the provenance
   * record — the response the figure shown was read from — unless another
   * is named; a failure in any of them replaces the figure and the plot with
   * the reason. Renders only once every record it needs has arrived.
   */
  function show(strip, needed, render, { provenance = needed[0] } = {}) {
    if (needed.some((record) => record === null)) return;
    const failed = needed.find((record) => !record.ok);
    if (failed) {
      ctx.readout.showError(strip.target, failed);
      strip.clear(`unavailable: ${failed.error}`);
      return;
    }
    let reason = null;
    const ok = ctx.readout.apply(strip.target, provenance, (data, record) => {
      try {
        render(data, record);
      } catch (error) {
        reason = error.message;
        throw error;
      }
    });
    if (!ok) strip.clear(`unavailable: ${reason ?? 'the response could not be read'}`);
  }

  /** A field reader for a record other than the provenance one, naming that record in any failure. */
  function readerOf(record) {
    return (value, path) => {
      try {
        return ctx.field(value, path);
      } catch (error) {
        throw new Error(`${record.label}: ${error.message}`);
      }
    };
  }

  const plural = (n, one, many = `${one}s`) => `${formatInteger(n)} ${n === 1 ? one : many}`;

  // ── 1 · block time, as a regularity strip ──
  function showBlockTime(record) {
    const strip = strips.blockTime;
    show(strip, [record], (data) => {
      const items = ctx.field(data, 'items');
      const series = blockIntervals(items, ctx.field);
      const stats = intervalStats(series.points);
      if (!stats) {
        ctx.readout.showAbsent(strip.target, record, 'no two consecutive blocks with timestamps in the page');
        strip.clear('No block times to show yet.');
        return;
      }
      const band = withinBand(series.points);
      const [low, high] = TARGET_BAND_S;
      const s = (n) => n.toFixed(1);
      ctx.readout.showValue(strip.target, record, {
        live: false,
        value: band.within,
        unit: ` of ${formatInteger(band.measured)} block times within target`,
        motion: ctx.motion,
        extra:
          `target ${low}–${high} s · latest ${s(stats.last)} s, mean ${s(stats.mean)}, min ${s(stats.min)}, max ${s(stats.max)} over ${formatInteger(series.blocks)} blocks` +
          (series.skipped ? ` · ${plural(series.skipped, 'pair')} without a timestamp, left as a break in the line` : ''),
      });
      const summary =
        `Seconds between consecutive blocks from block ${formatInteger(series.first)} to ${formatInteger(series.last)}: ` +
        `${formatInteger(band.within)} of ${formatInteger(band.measured)} inside the ${low} to ${high} second target band; ` +
        `the latest gap is ${s(stats.last)} seconds, the mean ${s(stats.mean)}, ranging from ${s(stats.min)} to ${s(stats.max)}` +
        (series.skipped ? `; ${plural(series.skipped, 'pair')} without a timestamp left as a break.` : '.');
      strip.draw((frame, svg, g) => {
        const measured = series.points.filter(isMeasured);
        const x = scaleLinear()
          .domain([series.points[0].number, series.points[series.points.length - 1].number])
          .range([frame.left, frame.right]);
        const y = scaleLinear()
          .domain([0, Math.max(BLOCK_TIME_CEILING_S, yCeiling(measured.map((p) => p.seconds)))])
          .range([frame.bottom, frame.top]);
        const bandTop = fix(y(high));
        const bandBottom = fix(y(low));
        g.append(el('rect', { x: frame.left, y: bandTop, width: frame.innerWidth, height: fix(bandBottom - bandTop) }, 'plot-band'));
        g.append(el('line', { x1: frame.left, x2: frame.right, y1: bandTop, y2: bandTop }, 'plot-axis plot-band-edge'));
        g.append(el('line', { x1: frame.left, x2: frame.right, y1: bandBottom, y2: bandBottom }, 'plot-axis plot-band-edge'));
        g.append(el('line', { x1: frame.left, x2: frame.right, y1: frame.bottom, y2: frame.bottom }, 'plot-zero'));
        g.append(el('path', { d: intervalLine(x, y)(series.points) ?? '' }, 'plot-line'));
        const last = measured[measured.length - 1];
        g.append(el('circle', { cx: fix(x(last.number)), cy: fix(y(last.seconds)), r: 2.5 }, 'plot-dot'));
        svg.append(label(frame.left + 3, bandTop - 4, `${low}–${high} s target`, 'start', 'plot-label plot-note'));
        svg.append(label(frame.left, frame.height - 3, `#${formatInteger(series.first)}`));
        svg.append(label(frame.right, frame.height - 3, `#${formatInteger(series.last)}`, 'end'));
        return summary;
      });
    });
  }

  // ── 2 · agreements, cumulative over the eras shown ──
  function showAgreements() {
    const strip = strips.agreements;
    const events = records.agreements;
    const eras = records.eras;
    show(strip, [events, eras], (data, record) => {
      const items = record.items;
      const field = readerOf(eras);
      const spans = eraSpans(field(eras.data, 'items'), field);
      const indexFrom = field(eras.data, 'settledHistoryFrom');
      if (spans.whole.length === 0) {
        ctx.readout.showAbsent(
          strip.target,
          record,
          `fewer than two settled eras since block #${formatInteger(indexFrom)}, where this site's record begins`,
        );
        strip.clear('No whole era to count yet.');
        return;
      }
      const list = items.map((item) => ({ blockNumber: ctx.field(item, 'blockNumber') }));
      const { buckets, open, dropped, historyFrom } = bucketByEra(spans.whole, spans.open, list, {
        // Read back past the oldest era's start: every event of every era drawn is in hand.
        complete: record.complete || record.reachedStart === true,
        indexFrom,
      });
      if (buckets.length === 0) {
        ctx.readout.showAbsent(
          strip.target,
          record,
          `the events fetched do not reach back a whole era; history from block #${formatInteger(historyFrom)}`,
        );
        strip.clear('No whole era the fetched events cover.');
        return;
      }
      const lastSettled = buckets[buckets.length - 1];
      const firstEra = buckets[0].era;
      const bars = open ? [...buckets, { ...open, open: true }] : buckets;
      const totals = cumulativeTotals(bars.map((b) => b.count));
      const totalSettled = totals[buckets.length - 1];
      const totalAll = totals[totals.length - 1];
      const extra = [
        `derived: running total over eras ${formatInteger(firstEra)}–${formatInteger(lastSettled.era)}`,
        `${formatInteger(lastSettled.count)} in era ${formatInteger(lastSettled.era)}, the last settled`,
        open ? `${formatInteger(open.count)} in era ${formatInteger(open.era)}, still open` : '',
        dropped ? `history from block #${formatInteger(historyFrom)}` : '',
        `era boundaries from ${eras.label}`,
      ]
        .filter(Boolean)
        .join(' · ');
      ctx.readout.showValue(strip.target, record, {
        live: false,
        value: totalAll,
        unit: ` agreements since era ${formatInteger(firstEra)}`,
        extra,
        motion: ctx.motion,
      });
      const busiest = buckets.reduce((a, b) => (b.count > a.count ? b : a), buckets[0]);
      const summary =
        `Agreements opened, cumulative over the last ${buckets.length} settled eras, ${formatInteger(firstEra)} to ${formatInteger(lastSettled.era)}: ` +
        `${formatInteger(totalSettled)} in all, ${formatInteger(lastSettled.count)} in the last settled era` +
        (open ? `, plus ${formatInteger(open.count)} in era ${formatInteger(open.era)}, which is still open` : '') +
        `; the busiest, era ${formatInteger(busiest.era)}, had ${formatInteger(busiest.count)}.`;
      strip.draw((frame, svg, g) => {
        drawBarsWithTotal(frame, svg, g, bars, totals, {
          value: (b) => b.count,
          isLast: (b) => b === lastSettled,
          leftLabel: `era ${formatInteger(firstEra)}`,
          rightLabel: open ? `era ${formatInteger(open.era)}, open` : `era ${formatInteger(lastSettled.era)}`,
        });
        return summary;
      });
    });
  }

  // ── 3 · CMN issued to agents, cumulative since the record begins ──
  function showEmission() {
    const strip = strips.emission;
    const eras = records.erasAll;
    const supply = records.supply;
    show(strip, [eras], (data, record) => {
      const series = emissionSeries(record.items, ctx.field, cmnNumber, Infinity);
      const indexFrom = ctx.field(data, 'settledHistoryFrom');
      if (series.length === 0) {
        ctx.readout.showAbsent(
          strip.target,
          record,
          `no settled era since block #${formatInteger(indexFrom)}, where this site's record begins`,
        );
        strip.clear('No settled era to sum yet.');
        return;
      }
      const totals = cumulativePlancks(series.map((e) => e.plancks));
      const totalPlancks = totals[totals.length - 1];
      const totalCmn = cmnNumber(totalPlancks);
      const last = series[series.length - 1];
      const allZero = series.every((e) => e.cmn === 0);
      // The run may stop short of the record's start at a hole in the eras
      // page; the provenance says which, never "since the record begins" when it is not.
      const settledHeld = record.items.filter((item) => ctx.field(item, 'settled') === true).length;
      const wholeRecord = record.complete && series.length === settledHeld;
      const coverage = wholeRecord
        ? `since block #${formatInteger(indexFrom)}, where this site's record begins`
        : `eras ${formatInteger(series[0].era)}–${formatInteger(last.era)}, the unbroken run the index holds${record.complete ? '' : ' of the pages read'}`;
      let sub;
      let supplyExtra = '';
      if (supply === null) sub = 'All issuance, every source: reading…';
      else if (!supply.ok) sub = `All issuance, every source: unavailable — ${supply.error}`;
      else {
        try {
          const figures = supplyFigures(supply.data, ctx.field);
          // Two lines at most: the context figure, and that it is not what agents were paid.
          sub = `All issuance, genesis and validators too: ${formatCmn(figures.issuedPlancks)} CMN, ${figures.percent.toFixed(2)} % of the cap.`;
          supplyExtra = ` · total issuance from ${supply.label} · ${utcTime(supply.at)}`;
        } catch (error) {
          sub = `All issuance, every source: unavailable — ${error.message}`;
        }
      }
      ctx.readout.showValue(strip.target, record, {
        live: false,
        value: formatCmn(totalPlancks),
        unit: ' CMN',
        sub: (allZero ? `No CMN was paid out in any of these ${formatInteger(series.length)} eras: no agent did enough verified work to qualify. ` : '') + sub,
        extra:
          `derived: running total of ${plural(series.length, 'settled era')}, ${coverage}` +
          ` · last: era ${formatInteger(last.era)} paid ${formatCmn(last.plancks)} CMN` +
          (record.complete ? '' : ' · the index holds more eras than were read, so this is a floor') +
          supplyExtra,
      });
      const summary =
        `CMN issued to agents, cumulative over ${series.length} settled eras, ${formatInteger(series[0].era)} to ${formatInteger(last.era)}: ` +
        `${formatCmn(totalPlancks)} CMN in all` +
        (allZero ? '; no era shown paid any, since no agent did enough verified work to qualify.' : `; the last era paid ${formatCmn(last.plancks)} CMN.`);
      strip.draw((frame, svg, g) => {
        const x = scaleLinear().domain([series[0].era, Math.max(last.era, series[0].era + 1)]).range([frame.left, frame.right]);
        const y = scaleLinear().domain([0, yCeiling([totalCmn])]).range([frame.bottom, frame.top]);
        const perEra = line()
          .x((e) => x(e.era))
          .y((e) => y(e.cmn))
          .curve(curveLinear);
        const total = line()
          .x((e) => x(e.era))
          .y((e, i) => y(cmnNumber(totals[i])))
          .curve(curveLinear);
        const fill = area()
          .x((e) => x(e.era))
          .y0(frame.bottom)
          .y1((e, i) => y(cmnNumber(totals[i])))
          .curve(curveLinear);
        g.append(el('path', { d: fill(series) ?? '' }, 'plot-area'));
        g.append(el('line', { x1: frame.left, x2: frame.right, y1: frame.bottom, y2: frame.bottom }, 'plot-zero'));
        g.append(el('path', { d: perEra(series) ?? '' }, 'plot-line plot-line-secondary'));
        g.append(el('path', { d: total(series) ?? '' }, 'plot-line'));
        g.append(el('circle', { cx: fix(x(last.era)), cy: fix(y(totalCmn)), r: 2.5 }, 'plot-dot'));
        svg.append(label(frame.left, frame.height - 3, `era ${formatInteger(series[0].era)}`));
        svg.append(label(frame.right, frame.height - 3, `era ${formatInteger(last.era)}`, 'end'));
        svg.append(
          label(frame.left + 3, frame.top + 8, allZero ? 'nothing issued to agents yet' : 'running total · per era beneath', 'start', 'plot-label plot-note'),
        );
        return summary;
      });
    });
  }

  /** Bars on a band scale with the running total as a line over them, on the same scale. */
  function drawBarsWithTotal(frame, svg, g, entries, totals, { value, isLast, leftLabel, rightLabel }) {
    const x = scaleBand()
      .domain(entries.map((_, i) => i))
      .range([frame.left, frame.right])
      .paddingInner(0.3)
      .paddingOuter(0.05);
    const y = scaleLinear().domain([0, yCeiling([...entries.map(value), ...totals])]).range([frame.bottom, frame.top]);
    entries.forEach((entry, i) => {
      const v = value(entry);
      let height = Math.max(0, frame.bottom - y(v));
      // The open era's outline is always drawn, so "in progress" has a mark as well as a label.
      if (entry.open) height = openBarHeight(height);
      const classes = ['plot-bar', isLast(entry) ? 'is-last' : '', entry.open ? 'is-open' : ''].filter(Boolean).join(' ');
      g.append(
        el(
          'rect',
          { x: fix(x(i)), y: fix(frame.bottom - height), width: fix(x.bandwidth()), height: fix(height) },
          classes,
        ),
      );
      const cx = fix(x(i) + x.bandwidth() / 2);
      svg.append(el('line', { x1: cx, x2: cx, y1: frame.bottom, y2: frame.bottom + 3 }, 'plot-axis plot-tick'));
    });
    const centre = (i) => x(i) + x.bandwidth() / 2;
    const settledCount = entries.filter((e) => !e.open).length;
    const total = line()
      .x((_, i) => centre(i))
      .y((t) => y(t))
      .curve(curveLinear);
    g.append(el('path', { d: total(totals.slice(0, settledCount)) ?? '' }, 'plot-line'));
    if (settledCount < totals.length && settledCount > 0) {
      // The open era's total is provisional: a dashed continuation.
      const tail = line()
        .x((_, i) => centre(settledCount - 1 + i))
        .y((t) => y(t))
        .curve(curveLinear);
      g.append(el('path', { d: tail(totals.slice(settledCount - 1)) ?? '' }, 'plot-line plot-line-open'));
    }
    if (settledCount > 0) {
      const lastIndex = settledCount - 1;
      g.append(el('circle', { cx: fix(centre(lastIndex)), cy: fix(y(totals[lastIndex])), r: 2.5 }, 'plot-dot'));
    }
    svg.append(el('line', { x1: frame.left, x2: frame.right, y1: frame.bottom, y2: frame.bottom }, 'plot-zero'));
    svg.append(label(frame.left, frame.height - 3, leftLabel));
    svg.append(label(frame.right, frame.height - 3, rightLabel, 'end'));
    svg.append(label(frame.left + 3, frame.top + 8, 'running total · per era as bars', 'start', 'plot-label plot-note'));
  }

  // ── 4 · agents over time ──
  function showAgents() {
    const strip = strips.agents;
    const { registrations, unstakes, agents, eras } = records;
    // The figure shown is the agent list's total, so that record is the
    // provenance (and the raw bytes behind the number); the events that
    // shape the line are named in the extra.
    show(
      strip,
      [registrations, unstakes, agents, eras],
      (data) => {
        if (!registrations.complete) {
          throw new Error(`${registrations.label}: the index holds more registrations than this page fetched`);
        }
        if (!unstakes.complete) {
          throw new Error(`${unstakes.label}: the index holds more departures than this page fetched`);
        }
        const erasField = readerOf(eras);
        const eventsField = readerOf(registrations);
        const unstakesField = readerOf(unstakes);
        if (ctx.field(data, 'truncated') === true) {
          throw new Error('the agent list was cut short, so the total is not exact');
        }
        const totalNow = ctx.field(data, 'total');
        const indexFrom = erasField(eras.data, 'settledHistoryFrom');
        const { before } = agentsBefore(ctx.field(data, 'items'), ctx.field, indexFrom, totalNow);
        const current = erasField(eras.data, 'items').find((item) => erasField(item, 'settled') === false);
        // The newest block the eras record knows: where the series ends, labelled "now".
        const nowBlock = current ? erasField(current, 'startBlock') + erasField(current, 'blocksElapsed') : null;
        const series = agentSteps({
          registrations: registrations.items.map((item) => eventsField(item, 'blockNumber')),
          unstakes: unstakes.items.map((item) => unstakesField(item, 'blockNumber')),
          totalNow,
          before,
          indexFrom,
          nowBlock,
        });
        const left = `#${formatInteger(series.start)}`;
        const departures = series.unstakes === 0 ? 'none has left' : `${formatInteger(series.unstakes)} left`;
        ctx.readout.showValue(strip.target, agents, {
        live: false,
          value: totalNow,
          unit: totalNow === 1 ? ' agent' : ' agents',
          motion: ctx.motion,
          extra:
            `${plural(series.registrations, 'registration')} since block ${left}, where this site's record begins; ` +
            `${plural(series.baseline, 'agent')} joined before that; ${departures} · registrations from ${registrations.label}`,
        });
        const summary =
          `Registered agents over time, from block ${formatInteger(series.start)}, where this site's record begins, to now: ` +
          `${formatInteger(series.baseline)} at the start, ${formatInteger(totalNow)} now, after ${plural(series.registrations, 'registration')} ` +
          `and ${plural(series.unstakes, 'departure')}.`;
        const note = `${formatInteger(series.baseline)} joined before this record`;
        strip.draw((frame, svg, g) => {
          const points = thinSteps(series.points);
          const lastBlock = points[points.length - 1].block;
          const x = scaleLinear().domain([series.start, Math.max(lastBlock, series.start + 1)]).range([frame.left, frame.right]);
          const y = scaleLinear().domain([0, yCeiling(points.map((p) => p.count))]).range([frame.bottom, frame.top]);
          const step = line()
            .x((p) => x(p.block))
            .y((p) => y(p.count))
            .curve(curveStepAfter);
          const fill = area()
            .x((p) => x(p.block))
            .y0(frame.bottom)
            .y1((p) => y(p.count))
            .curve(curveStepAfter);
          g.append(el('path', { d: fill(points) }, 'plot-area'));
          g.append(el('line', { x1: frame.left, x2: frame.right, y1: frame.bottom, y2: frame.bottom }, 'plot-zero'));
          g.append(el('path', { d: step(points) }, 'plot-line'));
          const end = points[points.length - 1];
          g.append(el('circle', { cx: fix(x(end.block)), cy: fix(y(end.count)), r: 2.5 }, 'plot-dot'));
          svg.append(label(frame.left, frame.height - 3, left));
          svg.append(label(frame.right, frame.height - 3, series.end === null ? `#${formatInteger(lastBlock)}` : 'now', 'end'));
          // The note goes where the step line is not: the highest count under
          // the note's extent decides whether it sits at the top or the bottom.
          const noteRight = frame.left + 3 + note.length * NOTE_CHAR_PX;
          const under = points.filter((p, i) => x(p.block) <= noteRight || (i > 0 && x(points[i - 1].block) <= noteRight));
          const topAtLeft = under.length ? y(max(under, (p) => p.count)) : NaN;
          const bottomAtLeft = under.length ? y(min(under, (p) => p.count)) : NaN;
          const at = notePosition(frame, topAtLeft, bottomAtLeft);
          svg.append(label(at.x, at.y, note, 'start', 'plot-label plot-note'));
          return summary;
        });
      },
      { provenance: agents },
    );
  }

  // ── data ──
  ctx.watch('blocks', showBlockTime, INTERVAL_MS);
  ctx.watch(
    'eras',
    (record) => {
      records.eras = record;
      watchAgreements(record);
      showAgreements();
      showAgents();
    },
    INTERVAL_MS,
  );
  ctx.watchAll(
    'erasAll',
    (record) => {
      records.erasAll = record;
      showEmission();
    },
    INTERVAL_MS,
    { maxPages: ERAS_ALL_PAGES },
  );
  ctx.watch(
    'supply',
    (record) => {
      records.supply = record;
      showEmission();
    },
    INTERVAL_MS,
  );
  // The agreement events are read once the era boundaries say how far back to go.
  let agreementsFrom = null;
  let agreementsWatched = false;
  function watchAgreements(eras) {
    const start = agreementsStart(eras, readerOf(eras));
    if (start.from !== null) agreementsFrom = start.from;
    if (agreementsWatched) return; // once reading, showAgreements reports a bad eras record itself
    if (agreementsFrom === null) {
      // Nothing to read back to yet: say why, never a silent wait.
      const strip = strips.agreements;
      ctx.readout.showError(strip.target, eras, start.error);
      strip.clear(`unavailable: ${start.error}`);
      return;
    }
    agreementsWatched = true;
    ctx.watchSince(
      'agreementsCreated',
      () => agreementsFrom,
      (record) => {
        records.agreements = record;
        showAgreements();
      },
      INTERVAL_MS,
      { maxPages: AGREEMENT_PAGES },
    );
  }
  ctx.watchAll(
    'registrations',
    (record) => {
      records.registrations = record;
      showAgents();
    },
    INTERVAL_MS,
    { maxPages: REGISTRATION_PAGES },
  );
  ctx.watchAll(
    'unstakes',
    (record) => {
      records.unstakes = record;
      showAgents();
    },
    INTERVAL_MS,
    { maxPages: 1 },
  );
  ctx.watch(
    'agents',
    (record) => {
      records.agents = record;
      showAgents();
    },
    INTERVAL_MS,
  );
}
