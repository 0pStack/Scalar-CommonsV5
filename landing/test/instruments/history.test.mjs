// Unit tests for the history strips' pure helpers: block intervals with
// missing timestamps (kept as breaks, never bridged), era bucketing against
// real boundaries (including the rule that drops eras the fetched events do
// not reach, at the boundary), the cumulative agent series with a baseline
// from the agent list that must reconcile, the emission series and CMN
// scaling, and the plot geometry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scaleLinear } from 'd3-scale';

import {
  agreementsReadFrom,
  agreementsStart,
  AGREEMENT_PAGES,
  thinSteps,
  MAX_STEP_POINTS,
  NOMINAL_BLOCK_S,
  ERAS_SHOWN,
  blockIntervals,
  intervalStats,
  intervalLine,
  intervalArea,
  contiguousRun,
  eraSpans,
  bucketByEra,
  emissionSeries,
  agentsBefore,
  agentSteps,
  plotFrame,
  yCeiling,
  notePosition,
  openBarHeight,
  withinBand,
  cumulativeTotals,
  cumulativePlancks,
  supplyFigures,
  TARGET_BAND_S,
} from '../../src/observatory/instruments/history.js';
import { field } from '../../src/observatory/data.js';
import { cmnNumber, formatCmn } from '../../src/observatory/format.js';

// The live shape of /v1/eras?limit=14 on 2026-09-29: the era in progress,
// then thirteen settled ones newest first.
const ERAS = [
  { era: 80, settled: false, totalEmissionPlancks: null, settledAtBlock: null, startBlock: 820862, durationBlocks: 3600, blocksElapsed: 14 },
  { era: 79, settled: true, totalEmissionPlancks: '0', settledAtBlock: 820862, startBlock: null },
  { era: 78, settled: true, totalEmissionPlancks: '0', settledAtBlock: 817157, startBlock: null },
  { era: 77, settled: true, totalEmissionPlancks: '0', settledAtBlock: 813442, startBlock: null },
  { era: 76, settled: true, totalEmissionPlancks: '0', settledAtBlock: 809739, startBlock: null },
  { era: 75, settled: true, totalEmissionPlancks: '0', settledAtBlock: 806033, startBlock: null },
  { era: 74, settled: true, totalEmissionPlancks: '0', settledAtBlock: 802328, startBlock: null },
  { era: 73, settled: true, totalEmissionPlancks: '0', settledAtBlock: 798623, startBlock: null },
  { era: 72, settled: true, totalEmissionPlancks: '0', settledAtBlock: 794903, startBlock: null },
  { era: 71, settled: true, totalEmissionPlancks: '0', settledAtBlock: 791227, startBlock: null },
  { era: 70, settled: true, totalEmissionPlancks: '0', settledAtBlock: 787529, startBlock: null },
  { era: 69, settled: true, totalEmissionPlancks: '0', settledAtBlock: 783814, startBlock: null },
  { era: 68, settled: true, totalEmissionPlancks: '0', settledAtBlock: 780099, startBlock: null },
  { era: 67, settled: true, totalEmissionPlancks: '0', settledAtBlock: 776394, startBlock: null },
];

/** A newest-first /v1/blocks page: `count` blocks ending at `last`, 6 s apart unless overridden. */
function blocksPage(last, count, { at = {}, missing = [] } = {}) {
  const items = [];
  for (let i = 0; i < count; i += 1) {
    const number = last - i;
    const base = 1_790_000_000_000 + number * 6_000;
    items.push({ number, timestampMs: missing.includes(number) ? null : (at[number] ?? base) });
  }
  return items;
}

const measured = (series) => series.points.filter((p) => Number.isFinite(p.seconds));

test('block intervals run oldest to newest, one per consecutive pair', () => {
  const page = blocksPage(820881, 200);
  const series = blockIntervals(page, field);
  assert.equal(series.blocks, 200);
  assert.equal(series.points.length, 199);
  assert.equal(series.first, 820682);
  assert.equal(series.last, 820881);
  assert.equal(series.skipped, 0);
  assert.equal(series.points[0].number, 820683);
  assert.equal(series.points[198].number, 820881);
  assert.ok(series.points.every((p) => p.seconds === 6));
});

test('a block with no timestamp leaves both its pairs as breaks, never a guessed gap', () => {
  const page = blocksPage(1000, 6, { missing: [998] });
  const series = blockIntervals(page, field);
  assert.equal(series.points.length, 5);
  assert.equal(series.skipped, 2);
  assert.deepEqual(
    measured(series).map((p) => p.number),
    [996, 997, 1000],
  );
  // The breaks keep their place in the series so the line can stop there.
  assert.ok(Number.isNaN(series.points[2].seconds) && series.points[2].number === 998);
  assert.ok(Number.isNaN(series.points[3].seconds) && series.points[3].number === 999);
  // A gap in the block numbers is not an interval either.
  const gap = blockIntervals([{ number: 10, timestampMs: 60_000 }, { number: 8, timestampMs: 48_000 }], field);
  assert.equal(measured(gap).length, 0);
  assert.equal(gap.skipped, 1);
});

test('a missing block number or a missing timestampMs key is a decode failure, not a skip', () => {
  assert.throws(() => blockIntervals([{ timestampMs: 1 }, { number: 1, timestampMs: 2 }], field), /response has no number/);
  // A null timestamp is a skip; a key that is not there at all is a renamed field.
  assert.throws(() => blockIntervals([{ number: 5 }, { number: 4 }], field), /response has no timestampMs/);
  assert.throws(() => blockIntervals([{ number: 5, timestampMs: 1 }, { number: 4 }], field), /response has no timestampMs/);
  assert.equal(blockIntervals([{ number: 5, timestampMs: null }, { number: 4, timestampMs: 1 }], field).skipped, 1);
});

test('the line and the area break at a skipped pair instead of bridging it', () => {
  const page = blocksPage(100, 5, { missing: [98] }); // 96..100, 98 unknown
  const series = blockIntervals(page, field);
  const x = scaleLinear().domain([97, 100]).range([0, 300]);
  const y = scaleLinear().domain([0, 12]).range([72, 6]);
  const path = intervalLine(x, y)(series.points);
  // Two sub-paths: 97 alone, then 100 alone — the pairs at 98 and 99 are not drawn.
  assert.equal((path.match(/M/g) ?? []).length, 2);
  assert.equal((intervalArea(x, y, 72)(series.points).match(/M/g) ?? []).length, 2);
  // An unbroken series is one sub-path.
  const whole = blockIntervals(blocksPage(100, 5), field);
  assert.equal((intervalLine(x, y)(whole.points).match(/M/g) ?? []).length, 1);
});

test('interval stats: last, mean, min, max of the measured pairs; null for an empty series', () => {
  const page = blocksPage(100, 5, { at: { 100: 1_790_000_000_000 + 100 * 6_000 + 6_000 } });
  const stats = intervalStats(blockIntervals(page, field).points);
  assert.equal(stats.last, 12);
  assert.equal(stats.min, 6);
  assert.equal(stats.max, 12);
  assert.equal(stats.mean, 7.5);
  assert.equal(stats.measured, 4);
  assert.equal(intervalStats([]), null);
  assert.equal(intervalStats([{ number: 1, seconds: NaN }]), null);
  // A break does not pull the mean.
  const broken = intervalStats(blockIntervals(blocksPage(100, 5, { missing: [98] }), field).points);
  assert.equal(broken.mean, 6);
  assert.equal(broken.measured, 2);
});

test('era spans: settled era k runs from the settlement of k−1 to its own, twelve at most', () => {
  const { whole, open, settled } = eraSpans(ERAS, field);
  assert.equal(settled.length, 13);
  assert.equal(whole.length, ERAS_SHOWN);
  assert.deepEqual(whole[0], { era: 68, start: 776394, end: 780099 });
  assert.deepEqual(whole[11], { era: 79, start: 817157, end: 820862 });
  assert.deepEqual(open, { era: 80, start: 820862 });
  // Thirteen settled entries make twelve whole eras; era 67's start is unknown.
  assert.ok(!whole.some((s) => s.era === 67));
});

test('era spans use only the contiguous run ending at the newest settled era', () => {
  const withGap = ERAS.filter((e) => e.era !== 74);
  const { whole } = eraSpans(withGap, field);
  assert.deepEqual(
    whole.map((s) => s.era),
    [76, 77, 78, 79],
  );
  assert.deepEqual(
    contiguousRun([{ era: 1 }, { era: 2 }, { era: 4 }, { era: 5 }]).map((e) => e.era),
    [4, 5],
  );
  assert.deepEqual(contiguousRun([]), []);
  // No settled era at all: nothing whole, and the open era still reported.
  const young = eraSpans([ERAS[0]], field);
  assert.deepEqual(young.whole, []);
  assert.deepEqual(young.open, { era: 80, start: 820862 });
  // One settled era gives no whole span either.
  assert.deepEqual(eraSpans(ERAS.slice(0, 2), field).whole, []);
});

test('bucketing counts each event into the era whose span holds it, with the era still open counted apart', () => {
  const { whole, open } = eraSpans(ERAS, field);
  const events = [
    { blockNumber: 820900 }, // era 80, in progress
    { blockNumber: 820862 }, // first block of era 80
    { blockNumber: 820861 }, // last block of era 79
    { blockNumber: 817157 }, // first block of era 79
    { blockNumber: 808507 }, // era 76
    { blockNumber: 808504 }, // era 76
    { blockNumber: 776394 }, // first block of era 68
  ];
  const result = bucketByEra(whole, open, events, { complete: true, indexFrom: 496606 });
  assert.equal(result.dropped, 0);
  assert.equal(result.historyFrom, 776394);
  const counts = Object.fromEntries(result.buckets.map((b) => [b.era, b.count]));
  assert.equal(counts[79], 2);
  assert.equal(counts[76], 2);
  assert.equal(counts[68], 1);
  assert.equal(counts[70], 0);
  assert.equal(result.open.count, 2);
  assert.equal(result.buckets.length, 12);
});

test('bucketing drops the eras a short event list cannot fill, and says where history begins', () => {
  const { whole, open } = eraSpans(ERAS, field);
  // The page cap cut the list short and the oldest event on hand is in era 74.
  const events = [{ blockNumber: 820900 }, { blockNumber: 805000 }, { blockNumber: 800000 }];
  const cut = bucketByEra(whole, open, events, { complete: false, indexFrom: 496606 });
  assert.deepEqual(
    cut.buckets.map((b) => b.era),
    [75, 76, 77, 78, 79],
  );
  assert.equal(cut.dropped, 7);
  assert.equal(cut.historyFrom, 802328);
  assert.equal(cut.buckets.find((b) => b.era === 75).count, 1);
  // The same events with the list complete: nothing older exists, so every era is fillable.
  const full = bucketByEra(whole, open, events, { complete: true, indexFrom: 496606 });
  assert.equal(full.dropped, 0);
  assert.equal(full.buckets.length, 12);
  // An index that begins inside the window drops the eras before it.
  const late = bucketByEra(whole, open, events, { complete: true, indexFrom: 790000 });
  assert.deepEqual(
    late.buckets.map((b) => b.era),
    [72, 73, 74, 75, 76, 77, 78, 79],
  );
  assert.equal(late.historyFrom, 791227);
  // Nothing fillable at all.
  const none = bucketByEra(whole, open, [{ blockNumber: 820900 }], { complete: false, indexFrom: 496606 });
  assert.deepEqual(none.buckets, []);
  assert.equal(none.historyFrom, 820862);
  assert.equal(none.open.count, 1);
});

test('at the boundary, an era that begins in the oldest fetched block is dropped: that block may hold more events past the cut', () => {
  const spans = [
    { era: 1, start: 100, end: 200 },
    { era: 2, start: 200, end: 300 },
  ];
  const open = { era: 3, start: 300 };
  const events = [{ blockNumber: 250 }, { blockNumber: 200 }];
  const cut = bucketByEra(spans, open, events, { complete: false });
  assert.deepEqual(cut.buckets, []);
  assert.equal(cut.dropped, 2);
  assert.equal(cut.historyFrom, 300);
  // One block older on hand, and era 2 is whole.
  const clear = bucketByEra(spans, open, [...events, { blockNumber: 199 }], { complete: false });
  assert.deepEqual(
    clear.buckets.map((b) => [b.era, b.count]),
    [[2, 2]],
  );
  assert.equal(clear.dropped, 1);
  // With the list complete the same block is a full boundary.
  const whole = bucketByEra(spans, open, events, { complete: true });
  assert.deepEqual(
    whole.buckets.map((b) => [b.era, b.count]),
    [
      [1, 0],
      [2, 2],
    ],
  );
});

test('emission series: settled eras oldest first, CMN as a number for the scale, plancks kept for the figure', () => {
  const series = emissionSeries(ERAS, field, cmnNumber);
  assert.equal(series.length, 12);
  assert.equal(series[0].era, 68);
  assert.equal(series[11].era, 79);
  assert.equal(series[11].settledAt, 820862);
  assert.ok(series.every((e) => e.cmn === 0 && e.plancks === '0'));
  const rich = emissionSeries(
    [{ era: 5, settled: true, totalEmissionPlancks: '1234567890123456789', settledAtBlock: 10 }],
    field,
    cmnNumber,
  );
  assert.equal(rich[0].cmn, 1234567.890123);
  assert.equal(formatCmn(rich[0].plancks), '1,234,567');
});

test('emission series shortens at a hole in the eras page rather than drawing across it', () => {
  const withGap = ERAS.filter((e) => e.era !== 74);
  const series = emissionSeries(withGap, field, cmnNumber);
  assert.deepEqual(
    series.map((e) => e.era),
    [75, 76, 77, 78, 79],
  );
  assert.deepEqual(emissionSeries([ERAS[0]], field, cmnNumber), []);
});

test('cmnNumber scales plancks to CMN for charts, keeping six decimals', () => {
  assert.equal(cmnNumber('0'), 0);
  assert.equal(cmnNumber('1000000000000'), 1);
  assert.equal(cmnNumber('1500000000000'), 1.5);
  assert.equal(cmnNumber('123456789012345678901234'), 123456789012.34567);
});

test('the agents registered before the index are counted from the agent list itself', () => {
  const items = [
    { registeredAtBlock: 0 },
    { registeredAtBlock: 0 },
    { registeredAtBlock: 496605 },
    { registeredAtBlock: 496606 },
    { registeredAtBlock: 719026 },
  ];
  assert.deepEqual(agentsBefore(items, field, 496606, 5), { before: 3, listed: 5 });
  // A page that does not hold the whole list is not a count.
  assert.throws(() => agentsBefore(items, field, 496606, 6), /holds 6 agents but only 5 were listed/);
  // A missing field is a decode failure.
  assert.throws(() => agentsBefore([{ address: 'x' }], field, 496606, 1), /response has no registeredAtBlock/);
});

test('the agent series starts from the agents the list says predate the index', () => {
  const registrations = [808497, 789416, 528191]; // newest first, as the index lists them
  const series = agentSteps({ registrations, unstakes: [], totalNow: 6, before: 3, indexFrom: 496606, nowBlock: 820876 });
  assert.equal(series.baseline, 3);
  assert.equal(series.total, 6);
  assert.equal(series.start, 496606);
  assert.equal(series.end, 820876);
  assert.deepEqual(series.points, [
    { block: 496606, count: 3 },
    { block: 528191, count: 4 },
    { block: 789416, count: 5 },
    { block: 808497, count: 6 },
    { block: 820876, count: 6 },
  ]);
});

test('a departure steps the series down, and the events must explain the whole difference', () => {
  const series = agentSteps({ registrations: [700, 600], unstakes: [650], totalNow: 4, before: 3, indexFrom: 500, nowBlock: 800 });
  assert.equal(series.baseline, 3);
  assert.deepEqual(
    series.points.map((p) => p.count),
    [3, 4, 3, 4, 4],
  );
  // An agent evicted by a slash leaves no departure event: the total is one
  // short of what the events explain, and the series refuses to draw.
  assert.throws(
    () => agentSteps({ registrations: [700, 600, 500], unstakes: [], totalNow: 4, before: 2, indexFrom: 100, nowBlock: 800 }),
    /do not reconcile with the agent list \(2 before the index \+ 3 − 0 ≠ 4\)/,
  );
  assert.throws(() => agentSteps({ registrations: [1, 2, 3], unstakes: [], totalNow: 2, before: 0, indexFrom: 0, nowBlock: 10 }), /reconcile/);
  // No now block: the series ends at its last event and says so.
  const open = agentSteps({ registrations: [700], unstakes: [], totalNow: 1, before: 0, indexFrom: 500, nowBlock: null });
  assert.equal(open.end, null);
  assert.equal(open.points[open.points.length - 1].block, 700);
  // No events at all: a flat line from the index start to now.
  const flat = agentSteps({ registrations: [], unstakes: [], totalNow: 3, before: 3, indexFrom: 500, nowBlock: 900 });
  assert.deepEqual(flat.points, [
    { block: 500, count: 3 },
    { block: 900, count: 3 },
  ]);
});

test('the plot frame leaves room for the end labels and the y ceiling is never zero', () => {
  const frame = plotFrame(300, 88);
  assert.equal(frame.top, 6);
  assert.equal(frame.bottom, 72);
  assert.equal(frame.left, 1);
  assert.equal(frame.right, 299);
  assert.equal(frame.innerHeight, 66);
  assert.equal(yCeiling([0, 0, 0]), 1);
  assert.equal(yCeiling([]), 1);
  assert.ok(yCeiling([6, 12, NOMINAL_BLOCK_S * 2]) > 12);
  assert.equal(yCeiling([50]), 54);
});

test('a note sits top-left unless the line is already there, then above the baseline if that is clear', () => {
  const frame = plotFrame(300, 88);
  assert.deepEqual(notePosition(frame, 60, 70), { x: 4, y: 14 });
  assert.deepEqual(notePosition(frame, NaN, NaN), { x: 4, y: 14 });
  // A step that plateaus near the top under the note pushes it down when the baseline corner is clear.
  assert.deepEqual(notePosition(frame, 8, 40), { x: 4, y: 68 });
  assert.deepEqual(notePosition(frame, 20, 55), { x: 4, y: 68 });
  assert.deepEqual(notePosition(frame, 21, 55), { x: 4, y: 14 });
  // A line that spans the whole height under the note (low on the left, high further on) gets the top and its halo.
  assert.deepEqual(notePosition(frame, 8, 70), { x: 4, y: 14 });
  assert.deepEqual(notePosition(frame, 8, 56), { x: 4, y: 14 });
  assert.deepEqual(notePosition(frame, 8, 55), { x: 4, y: 68 });
});

test('the open era bar is never invisible', () => {
  assert.equal(openBarHeight(0), 2);
  assert.equal(openBarHeight(1.5), 2);
  assert.equal(openBarHeight(30), 30);
});

test('the target band counts measured intervals inside 5.5–6.5 s, edges included, breaks excluded', () => {
  assert.deepEqual(TARGET_BAND_S, [5.5, 6.5]);
  const page = blocksPage(100, 6, { at: { 100: 1_790_000_000_000 + 100 * 6_000 + 6_000, 98: 1_790_000_000_000 + 98 * 6_000 - 500 } });
  const series = blockIntervals(page, field);
  // 96→97: 6, 97→98: 5.5 (on the edge), 98→99: 6.5 (on the edge), 99→100: 12.
  const band = withinBand(series.points);
  assert.equal(band.measured, 5);
  assert.equal(band.within, 4);
  assert.deepEqual(withinBand(blockIntervals(blocksPage(100, 5, { missing: [98] }), field).points), { within: 2, measured: 2 });
  assert.deepEqual(withinBand([]), { within: 0, measured: 0 });
});

test('running totals are exact, in order, and in plancks stay integers', () => {
  assert.deepEqual(cumulativeTotals([3, 0, 2, 5]), [3, 3, 5, 10]);
  assert.deepEqual(cumulativeTotals([]), []);
  assert.deepEqual(cumulativePlancks(['0', '0', '0']), ['0', '0', '0']);
  assert.deepEqual(cumulativePlancks(['1000000000000', '2500000000000']), ['1000000000000', '3500000000000']);
  assert.deepEqual(cumulativePlancks(['123456789012345678901234', '1']), ['123456789012345678901234', '123456789012345678901235']);
});

test('the emission series can take every era in the run, not only the last twelve', () => {
  assert.equal(emissionSeries(ERAS, field, cmnNumber).length, 12);
  assert.equal(emissionSeries(ERAS, field, cmnNumber, Infinity).length, 13);
  assert.equal(emissionSeries(ERAS, field, cmnNumber, Infinity)[0].era, 67);
});

test('supply figures are read as planck counts and the indexer’s own percentage, or refused', () => {
  const live = { capPlancks: '100000000000000000000000', totalIssuancePlancks: '6054850322518573352172', remainingPlancks: '93945149677481426647828', percentIssued: 6.0548 };
  assert.deepEqual(supplyFigures(live, field), { issuedPlancks: '6054850322518573352172', capPlancks: '100000000000000000000000', percent: 6.0548 });
  assert.equal(formatCmn(supplyFigures(live, field).issuedPlancks), '6,054,850,322');
  assert.throws(() => supplyFigures({ ...live, totalIssuancePlancks: '6e21' }, field), /counts of plancks/);
  assert.throws(() => supplyFigures({ ...live, percentIssued: '6' }, field), /non-numeric percentIssued/);
  assert.throws(() => supplyFigures({ capPlancks: '1' }, field), /response has no totalIssuancePlancks/);
});

test('the agents-over-time line is thinned to at most 240 points at 2,000 registrations, keeping each span’s closing count', () => {
  const points = [{ block: 0, count: 0 }];
  for (let i = 1; i <= 2_000; i += 1) points.push({ block: i * 7, count: i });
  const thin = thinSteps(points);
  assert.ok(thin.length <= MAX_STEP_POINTS, `${thin.length} points`);
  assert.deepEqual(thin[0], points[0]);
  assert.deepEqual(thin.at(-1), points.at(-1), 'the last count is always drawn');
  for (let i = 1; i < thin.length; i += 1) assert.ok(thin[i].block > thin[i - 1].block && thin[i].count >= thin[i - 1].count);
  const few = points.slice(0, 50);
  assert.equal(thinSteps(few), few, 'a short series is drawn as it is');
});

test('agreements opened read back to the start of the oldest era drawn, so all twelve eras are counted, not one', () => {
  const whole = Array.from({ length: 12 }, (_, k) => ({ era: 87 + k, start: 846_778 + k * 3_700, end: 846_778 + (k + 1) * 3_700 }));
  const open = { era: 102, start: 902_353 };
  assert.equal(agreementsReadFrom({ whole, open }), 846_778);
  assert.equal(agreementsReadFrom({ whole: [], open }), 902_353, 'no whole era yet: the open one');
  assert.equal(agreementsReadFrom({ whole: [], open: null }), null);
  assert.ok(AGREEMENT_PAGES * 200 >= 5_000);
  // 1,323 events, the newest 1,000 of them inside the last era: a 5-page read reaches one era at most.
  const events = [];
  for (let k = 0; k < 1_000; k += 1) events.push({ blockNumber: whole[11].end - 1 - Math.floor(k * 3.5) });
  for (let k = 0; k < 323; k += 1) events.push({ blockNumber: whole[11].start - 1 - k * 120 });
  const before = bucketByEra(whole, open, events.slice(0, 1_000), { complete: false });
  assert.ok(before.buckets.length <= 1, `the old read keeps ${before.buckets.length} era(s)`);
  // Read back past the oldest era's start (reachedStart): every era drawn is whole.
  const after = bucketByEra(whole, open, events, { complete: true });
  assert.equal(after.buckets.length, 12);
  assert.equal(after.buckets.reduce((n, b) => n + b.count, 0), events.filter((e) => e.blockNumber >= whole[0].start && e.blockNumber < whole[11].end).length);
});

test('the agreements read starts from the eras record, or says why it cannot: a failed or unreadable eras read is never a silent wait', () => {
  const eras = (items) => ({ ok: true, label: '/v1/eras', data: { items } });
  const start = agreementsStart(eras(ERAS), field);
  assert.equal(start.error, null);
  assert.equal(start.from, 776394, 'the start of era 68, the oldest of the twelve whole eras');
  assert.deepEqual(agreementsStart({ ok: false, label: '/v1/eras', error: 'HTTP 503' }, field), { from: null, error: 'HTTP 503' });
  const broken = agreementsStart({ ok: true, label: '/v1/eras', data: {} }, field);
  assert.equal(broken.from, null);
  assert.match(broken.error, /items/, 'an unreadable eras body names what is missing');
  assert.deepEqual(agreementsStart(eras([]), field), { from: null, error: 'no era recorded yet' });
});
