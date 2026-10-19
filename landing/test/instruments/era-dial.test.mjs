// Unit tests for the era dial's pure helpers: progress, settlement block,
// countdown, arc geometry, decoding guards and the "awaiting settlement" state.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NOMINAL_BLOCK_MS,
  CADENCE_STEP_MS,
  RADIUS,
  CENTRE,
  GRADUATIONS,
  progressFraction,
  settlementBlock,
  countdownSeconds,
  countdownFigure,
  blockTimeLabel,
  arcAngles,
  arcPath,
  pointAt,
  graduation,
  dialState,
  ariaSummary,
  elapsedPhrase,
  latestSettled,
  zeroEmissionNote,
} from '../../src/observatory/instruments/era-dial.js';
import { field } from '../../src/observatory/data.js';
import * as format from '../../src/observatory/format.js';

// The live shape of /v1/eras/current on 2026-09-29, era 79.
const CURRENT = {
  era: 79,
  startBlock: 817157,
  durationBlocks: 3600,
  currentBlock: 820715,
  blocksElapsed: 3558,
  blocksRemaining: 42,
  dueForSettlement: false,
  lastSettledEra: 78,
  ringSnapshot: 0,
  activeSnapshot: 0,
};

test('progress is elapsed over duration, clamped to [0, 1]', () => {
  assert.equal(progressFraction(0, 3600), 0);
  assert.equal(progressFraction(1800, 3600), 0.5);
  assert.equal(progressFraction(3558, 3600), 3558 / 3600);
  // The indexer does not clamp blocksElapsed once the era is due.
  assert.equal(progressFraction(3700, 3600), 1);
  assert.equal(progressFraction(-5, 3600), 0);
});

test('progress refuses input it cannot place, rather than defaulting to an empty arc', () => {
  assert.throws(() => progressFraction(10, 0), /durationBlocks is not positive/);
  assert.throws(() => progressFraction(10, -3600), /durationBlocks is not positive/);
  assert.throws(() => progressFraction(NaN, 3600), /blocksElapsed is not a number/);
  assert.throws(() => progressFraction('3558', 3600), /blocksElapsed is not a number/);
  assert.throws(() => progressFraction(3558, '3600'), /durationBlocks is not positive/);
});

test('settlement block is the start plus the duration', () => {
  assert.equal(settlementBlock(817157, 3600), 820757);
});

test('countdown seconds use the nominal 6 s block until one is observed', () => {
  assert.equal(NOMINAL_BLOCK_MS, 6000);
  assert.equal(countdownSeconds(42), 252);
  assert.equal(countdownSeconds(42, 6100), 256.2);
  assert.equal(countdownSeconds(0), 0);
  assert.equal(countdownSeconds(-3), 0);
  assert.equal(format.formatDuration(countdownSeconds(42)), 'about 4 min');
  assert.equal(format.formatDuration(countdownSeconds(3600)), 'about 6 h');
});

test('the countdown figure drops the hedge, which moves to the provenance line', () => {
  assert.equal(countdownFigure(252, format), '4 min');
  assert.equal(countdownFigure(19020, format), '5 h 17 min');
  assert.equal(countdownFigure(40, format), '40 s');
  // The longest running case fits a two-up column on one line.
  assert.ok(countdownFigure(21540, format).length <= 10, countdownFigure(21540, format));
});

test('the block-time phrase says whether the figure is nominal or observed', () => {
  assert.equal(blockTimeLabel(null), 'at 6 s per block');
  assert.equal(blockTimeLabel(0), 'at 6 s per block');
  assert.equal(blockTimeLabel(6120), 'at the observed 6.1 s per block');
  assert.equal(CADENCE_STEP_MS, 50);
});

test('arc angles start at twelve o’clock and sweep clockwise', () => {
  assert.deepEqual(arcAngles(0), { start: -Math.PI / 2, end: -Math.PI / 2, sweep: 0 });
  const half = arcAngles(0.5);
  assert.equal(half.sweep, Math.PI);
  assert.ok(Math.abs(half.end - Math.PI / 2) < 1e-12);
  assert.equal(arcAngles(2).sweep, 2 * Math.PI);
  assert.equal(arcAngles(-1).sweep, 0);
});

test('points on the dial: twelve, three, six and nine o’clock', () => {
  const twelve = pointAt(-Math.PI / 2);
  assert.ok(Math.abs(twelve.x - CENTRE) < 1e-9);
  assert.ok(Math.abs(twelve.y - (CENTRE - RADIUS)) < 1e-9);
  const three = pointAt(0);
  assert.ok(Math.abs(three.x - (CENTRE + RADIUS)) < 1e-9);
  const six = pointAt(Math.PI / 2);
  assert.ok(Math.abs(six.y - (CENTRE + RADIUS)) < 1e-9);
  const nine = pointAt(Math.PI);
  assert.ok(Math.abs(nine.x - (CENTRE - RADIUS)) < 1e-9);
});

test('arc path: empty at zero, one arc below half, large-arc flag above, two half-arcs at one', () => {
  assert.equal(arcPath(0), '');
  const quarter = arcPath(0.25);
  assert.match(quarter, /^M 160 24 A 136 136 0 0 1 296 160$/);
  const threeQuarters = arcPath(0.75);
  assert.match(threeQuarters, /^M 160 24 A 136 136 0 1 1 24 160$/);
  const full = arcPath(1);
  assert.match(full, /^M 160 24 A 136 136 0 1 1 160 296 A 136 136 0 1 1 160 24$/);
  // Just short of full is still one arc, ending a hair before the start.
  const nearly = arcPath(0.999);
  assert.equal((nearly.match(/ A /g) ?? []).length, 1);
});

test('graduations sit inside the track, one longer mark every fifth', () => {
  assert.equal(GRADUATIONS, 60);
  const top = graduation(0);
  assert.equal(top.major, true);
  assert.equal(top.x1, CENTRE);
  assert.equal(top.y1, CENTRE - RADIUS + 10);
  assert.equal(top.y2, CENTRE - RADIUS + 1);
  const minor = graduation(1);
  assert.equal(minor.major, false);
  const len = Math.hypot(minor.x2 - minor.x1, minor.y2 - minor.y1);
  assert.ok(Math.abs(len - 4) < 0.01, `minor mark is ${len} long`);
  // Every mark is inside the track radius.
  for (let k = 0; k < GRADUATIONS; k += 1) {
    const g = graduation(k);
    assert.ok(Math.hypot(g.x2 - CENTRE, g.y2 - CENTRE) <= RADIUS);
  }
});

test('dialState reads the live response shape', () => {
  const state = dialState(CURRENT, field);
  assert.equal(state.era, 79);
  assert.equal(state.due, false);
  assert.equal(state.settlesAt, 820757);
  assert.equal(state.percent, 98); // 3558/3600 = 98.8 %, floored: never "100 %" while blocks remain
  assert.equal(dialState({ ...CURRENT, blocksElapsed: 3599, blocksRemaining: 1 }, field).percent, 99);
  assert.equal(state.seconds, 252);
  assert.equal(state.fraction, 3558 / 3600);
  assert.equal(state.pastDue, 0);
  assert.equal(dialState(CURRENT, field, 6200).seconds, 260.4);
  // The first blocks of an era, as seen live for era 80.
  const fresh = dialState({ ...CURRENT, era: 80, startBlock: 820862, blocksElapsed: 352, blocksRemaining: 3248 }, field);
  assert.equal(fresh.percent, 9);
  assert.equal(fresh.settlesAt, 824462);
});

test('dialState refuses a response missing a field, rather than guessing', () => {
  const { blocksRemaining, ...partial } = CURRENT;
  void blocksRemaining;
  assert.throws(() => dialState(partial, field), /response has no blocksRemaining/);
  assert.throws(() => dialState({ ...CURRENT, durationBlocks: null }, field), /response has no durationBlocks/);
});

test('dialState refuses a field of the wrong type, rather than coercing it', () => {
  // The indexer ships u128 fields as decimal strings; if these ever became strings the dial must not draw.
  const strings = {
    ...CURRENT,
    startBlock: '817157',
    durationBlocks: '3600',
    blocksElapsed: '3558',
    blocksRemaining: '42',
    dueForSettlement: 'true',
  };
  assert.throws(() => dialState(strings, field), /response has a non-numeric startBlock/);
  assert.throws(() => dialState({ ...CURRENT, era: '79' }, field), /response has a non-numeric era/);
  assert.throws(() => dialState({ ...CURRENT, blocksElapsed: NaN }, field), /response has a non-numeric blocksElapsed/);
  assert.throws(() => dialState({ ...CURRENT, blocksElapsed: 12.5 }, field), /response has a non-numeric blocksElapsed/);
  assert.throws(() => dialState({ ...CURRENT, blocksRemaining: -1 }, field), /response has a non-numeric blocksRemaining/);
  assert.throws(() => dialState({ ...CURRENT, durationBlocks: 0 }, field), /response has a zero durationBlocks/);
  assert.throws(() => dialState({ ...CURRENT, dueForSettlement: 'true' }, field), /non-boolean dueForSettlement/);
  assert.throws(() => dialState({ ...CURRENT, dueForSettlement: 1 }, field), /non-boolean dueForSettlement/);
});

test('awaiting settlement: the arc is complete, the countdown is now, and past-due blocks are counted', () => {
  const due = { ...CURRENT, blocksElapsed: 3612, blocksRemaining: 0, dueForSettlement: true, currentBlock: 820769 };
  const state = dialState(due, field);
  assert.equal(state.due, true);
  assert.equal(state.fraction, 1);
  assert.equal(state.percent, 100);
  assert.equal(state.seconds, 0);
  assert.equal(state.pastDue, 12);
  assert.equal(arcPath(state.fraction).split(' A ').length - 1, 2);
  assert.equal(
    ariaSummary(state, format),
    'Era 79, complete, settlement due since block 820,757, which anyone may trigger',
  );
});

test('the elapsed phrase prints the chain’s figure unclamped, and says how far past due', () => {
  assert.equal(elapsedPhrase(dialState(CURRENT, field), format), '3,558 of 3,600 blocks');
  const due = dialState({ ...CURRENT, blocksElapsed: 3612, blocksRemaining: 0, dueForSettlement: true }, field);
  assert.equal(elapsedPhrase(due, format), '3,612 of 3,600 blocks · 12 blocks past due');
  const justDue = dialState({ ...CURRENT, blocksElapsed: 3601, blocksRemaining: 0, dueForSettlement: true }, field);
  assert.equal(elapsedPhrase(justDue, format), '3,601 of 3,600 blocks · 1 block past due');
});

test('the aria summary is one plain sentence', () => {
  const state = dialState({ ...CURRENT, blocksElapsed: 3276, blocksRemaining: 324 }, field);
  assert.equal(ariaSummary(state, format), 'Era 79, 91 % complete, settles at block 820,757, about 32 min from now');
});

test('the most recent settled era is the first settled entry of /v1/eras', () => {
  const items = [
    { era: 79, settled: false, totalEmissionPlancks: null, settledAtBlock: null },
    { era: 78, settled: true, totalEmissionPlancks: '0', totalWeight: '0', settledAtBlock: 817157 },
    { era: 77, settled: true, totalEmissionPlancks: '0', totalWeight: '0', settledAtBlock: 813442 },
  ];
  const settled = latestSettled(items, field);
  assert.equal(settled.era, 78);
  assert.equal(format.formatCmn(field(settled, 'totalEmissionPlancks')), '0');
  assert.equal(latestSettled([items[0]], field), null);
  assert.equal(latestSettled([], field), null);
  assert.throws(() => latestSettled([{ era: 1 }], field), /response has no settled/);
});

test('a zero payout is explained only when the weight says no agent earned a share', () => {
  assert.equal(
    zeroEmissionNote('0', '0'),
    'nothing issued: no agent did enough verified work that era to earn a share',
  );
  assert.equal(zeroEmissionNote('1500000000000000', '42'), null);
  // Zero emission with non-zero weight is not that rule's outcome; say nothing rather than guess.
  assert.equal(zeroEmissionNote('0', '42'), null);
  assert.throws(() => zeroEmissionNote('abc', '0'));
});
