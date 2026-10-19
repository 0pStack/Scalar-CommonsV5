// Unit tests for the validator ring's pure helpers: point placement on the
// ring, chords, label placement and the fit check, the vote ticks, the
// authority-index → stash mapping, the finality-vote sampler, queued-vs-active
// diffing and the phrases the list carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SIZE,
  CENTRE,
  RADIUS,
  LABEL_PAD,
  VOTE_TICKS,
  VOTE_TICK_IN,
  VOTE_TICK_OUT,
  TICK_FROM,
  MIN_SAMPLES,
  ALL_CHORDS_UP_TO,
  QUEUED_LABEL,
  pointAt,
  ringPositions,
  chordPairs,
  labelAnchor,
  labelPlacement,
  ringLayout,
  voteTicks,
  buildSet,
  stashForAuthority,
  unmappedReason,
  VoteSampler,
  sealedPhrase,
  votesPhrase,
  ariaSummary,
  headKey,
} from '../../src/observatory/instruments/validator-ring.js';
import { decodeValidators, decodeQueuedKeys, decodeBabeAuthorities, bytesToHex } from '../../src/observatory/scale.js';
import { encodeSs58 } from '../../src/observatory/ss58.js';
import { formatInteger } from '../../src/observatory/format.js';

// The live storage values on 2026-09-29 (five validators, all with queued keys).
const VALIDATORS_HEX =
  '0x141e07379407fecc4b89eb7dbd287c2c781cfb1907a96947a3eb18e4f8e71986258ac59e11963af19174d0b94d5d78041c233f55d2e19324665bafdfb62925af2dbe5ddb1579b72e84524fc29e78609e3caf42e85aa118ebfe0b0ad404b5bdd25fe860f1b1c7227f7c22602f53f15af80747814dffd839719731ee3bba6edc126cfe65717dad0447d715f660a0a58411de509b42e6efb8375f562f58a554d5860e';
const QUEUED_HEX =
  '0x141e07379407fecc4b89eb7dbd287c2c781cfb1907a96947a3eb18e4f8e719862590b5ab205c6974c9ea841be688864633dc9ca8a357843eeacf2314649965fe22439660b36c6c03afafca027b910b4fecf99801834c62a5e6006f27d978de234f90b5ab205c6974c9ea841be688864633dc9ca8a357843eeacf2314649965fe228ac59e11963af19174d0b94d5d78041c233f55d2e19324665bafdfb62925af2de659a7a1628cdd93febc04a4e0646ea20e9f5f0ce097d9a05290d4a9e054df4e1dfe3e22cc0d45c70779c1095f7489a8ef3cf52d62fbd8c2fa38c9f1723502b5e659a7a1628cdd93febc04a4e0646ea20e9f5f0ce097d9a05290d4a9e054df4ebe5ddb1579b72e84524fc29e78609e3caf42e85aa118ebfe0b0ad404b5bdd25fd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d88dc3417d5058ec4b4503e0c12ea1a0a89be200fe98922423d4334014fa6b0eed43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27de860f1b1c7227f7c22602f53f15af80747814dffd839719731ee3bba6edc126c306721211d5404bd9da88e0204360a1a9ab8b87c66c1bc2fcdd37f3c2222cc205e639b43e0052c47447dac87d6fd2b6ec50bdd4d0f614e4299c665249bbd09d9306721211d5404bd9da88e0204360a1a9ab8b87c66c1bc2fcdd37f3c2222cc20fe65717dad0447d715f660a0a58411de509b42e6efb8375f562f58a554d5860e8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48d17c2d7823ebf260fd138f2d7e27d114c0145d968b5ff5006125f2414fadae698eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48';
const BABE_HEX =
  '0x1490b5ab205c6974c9ea841be688864633dc9ca8a357843eeacf2314649965fe220100000000000000e659a7a1628cdd93febc04a4e0646ea20e9f5f0ce097d9a05290d4a9e054df4e0100000000000000d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d0100000000000000306721211d5404bd9da88e0204360a1a9ab8b87c66c1bc2fcdd37f3c2222cc2001000000000000008eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a480100000000000000';

// grandpa_roundState.best.precommits.missing on the same day: the SS58 of the grandpa keys.
const MISSING_ALL = [
  '5Ck2miBfCe1JQ4cY3NDsXyBaD6EcsgiVmEFTWwqNSs25XDEq',
  '5DbKjhNLpqX3zqZdNBc9BGb4fHU1cRBaDhJUskrvkwfraDi6',
  '5ECTwv6cZ5nJQPk6tWfaTrEk8YH2L7X1VT4EL5Tx2ikfFwb7',
  '5FA9nQDVg267DEd8m1ZypXLBnvN7SFxYwV7ndqSYGiN9TTpu',
  '5GoNkf6WdbxCFnPdAnYYQyCjAKPJgLNxXwPjwTh6DGg6gN3E',
];

const validators = decodeValidators(VALIDATORS_HEX);
const queued = decodeQueuedKeys(QUEUED_HEX);
const babe = decodeBabeAuthorities(BABE_HEX);

/** A grandpa_roundState-shaped sample; `weight` is the arrived weight of each stage. */
const sample = (round, { setId = 76, threshold = 4, prevotes = [], precommits = [], prevoteWeight, precommitWeight } = {}) => ({
  setId,
  round,
  threshold,
  prevotes: { currentWeight: prevoteWeight ?? 5 - prevotes.length, missing: prevotes },
  precommits: { currentWeight: precommitWeight ?? 5 - precommits.length, missing: precommits },
});

test('positions: evenly spaced from twelve o’clock, clockwise, on the track', () => {
  assert.equal(SIZE, 320);
  const five = ringPositions(5);
  assert.equal(five.length, 5);
  assert.equal(five[0].x, CENTRE);
  assert.equal(five[0].y, CENTRE - RADIUS);
  // The second point is to the right of and below the first (clockwise).
  assert.ok(five[1].x > five[0].x && five[1].y > five[0].y);
  // The last point mirrors the second across the vertical axis.
  assert.ok(Math.abs(five[4].x - (2 * CENTRE - five[1].x)) < 1e-6);
  assert.ok(Math.abs(five[4].y - five[1].y) < 1e-6);
  for (const p of five) assert.ok(Math.abs(Math.hypot(p.x - CENTRE, p.y - CENTRE) - RADIUS) < 0.01);
  // Four points: twelve, three, six, nine o'clock.
  const four = ringPositions(4);
  assert.equal(four[1].x, CENTRE + RADIUS);
  assert.equal(four[2].y, CENTRE + RADIUS);
  assert.equal(four[3].x, CENTRE - RADIUS);
  assert.deepEqual(ringPositions(0), []);
  const one = ringPositions(1);
  assert.equal(one[0].y, CENTRE - RADIUS);
});

test('pointAt agrees with the positions and rounds to a thousandth', () => {
  const p = pointAt(0, 10, 0, 0);
  assert.deepEqual(p, { x: 10, y: 0 });
  assert.equal(pointAt(Math.PI / 2, 10, 0, 0).y, 10);
});

test('chords: every pair up to twelve validators, neighbours only above', () => {
  assert.equal(ALL_CHORDS_UP_TO, 12);
  assert.deepEqual(chordPairs(0), []);
  assert.deepEqual(chordPairs(1), []);
  assert.deepEqual(chordPairs(2), [[0, 1]]);
  assert.equal(chordPairs(5).length, 10);
  assert.equal(chordPairs(12).length, 66);
  const ring = chordPairs(13);
  assert.equal(ring.length, 13);
  assert.deepEqual(ring[12], [12, 0]);
  assert.equal(chordPairs(40).length, 40);
});

test('labels anchor away from the ring: start on the right, end on the left, middle at top and bottom', () => {
  assert.equal(labelAnchor(-Math.PI / 2), 'middle');
  assert.equal(labelAnchor(Math.PI / 2), 'middle');
  assert.equal(labelAnchor(0), 'start');
  assert.equal(labelAnchor(Math.PI), 'end');
  const five = ringPositions(5);
  assert.deepEqual(five.map((p) => labelAnchor(p.angle)), ['middle', 'start', 'start', 'end', 'end']);
});

test('the label block, the hairline tick and the vote band never touch, for 3 to 12 validators, with and without addresses', () => {
  // The hairline tick starts outside the vote band.
  assert.ok(TICK_FROM - RADIUS > VOTE_TICK_OUT + 2);
  for (const showAddress of [false, true]) {
    for (let n = 3; n <= 12; n += 1) {
      for (const scale of [0.9, 1, 1.13]) {
        for (const p of ringPositions(n)) {
          const { box, indexY, addrY, anchor } = labelPlacement(p.angle, { scale, showAddress, indexDigits: String(n).length });
          // Nearest point of the label box to the point centre, against the vote band.
          const nx = Math.max(box.x0, Math.min(p.x, box.x1));
          const ny = Math.max(box.y0, Math.min(p.y, box.y1));
          const distance = Math.hypot(nx - p.x, ny - p.y);
          assert.ok(distance > VOTE_TICK_OUT + 1, `n=${n} k=${p.index} scale=${scale} addr=${showAddress}: label ${distance.toFixed(1)} from the point`);
          // Nor may the label box cover the hairline tick's outer end.
          const tickEnd = pointAt(p.angle, TICK_FROM + 6);
          const inside = tickEnd.x >= box.x0 && tickEnd.x <= box.x1 && tickEnd.y >= box.y0 && tickEnd.y <= box.y1;
          assert.ok(!inside, `n=${n} k=${p.index}: label box covers the tick end`);
          // At the top the address sits above the index; elsewhere below it.
          if (Math.sin(p.angle) < -0.6) assert.ok(addrY < indexY);
          else assert.ok(addrY > indexY);
          assert.ok(['start', 'middle', 'end'].includes(anchor));
        }
      }
    }
  }
});

test('the vote band sits clear of the point and of the twelve-o’clock label', () => {
  assert.ok(VOTE_TICK_IN > 7 + 2);
  const top = labelPlacement(-Math.PI / 2, { scale: 1, showAddress: true });
  assert.ok(top.box.y1 < CENTRE - RADIUS - VOTE_TICK_OUT - 1);
  assert.ok(top.box.y0 >= 0);
});

test('ringLayout: addresses only when wide and every label fits inside the padded viewBox, compact otherwise', () => {
  const five = Array.from({ length: 5 }, () => ({ indexDigits: 1, addrChars: 9 }));
  // The 1440 px column (≈ 416 px host) shows addresses in a viewBox widened by LABEL_PAD each side.
  const wide = ringLayout(five, 416, true);
  assert.equal(wide.compact, false);
  assert.deepEqual(wide.viewBox, [-LABEL_PAD, 0, SIZE + 2 * LABEL_PAD, SIZE]);
  assert.ok(Math.abs(wide.scale - 416 / (SIZE + 2 * LABEL_PAD)) < 1e-9);
  // Below 64rem the addresses are never shown, whatever the width.
  const narrowViewport = ringLayout(five, 416, false);
  assert.equal(narrowViewport.compact, true);
  assert.deepEqual(narrowViewport.viewBox, [0, 0, SIZE, SIZE]);
  assert.equal(narrowViewport.scale, 416 / SIZE);
  // The 1024 px column (288 px host): the address would leave the plate, so compact.
  assert.equal(ringLayout(five, 288, true).compact, true);
  // A 320 px host at 64rem+: still too tight for 11 px addresses; compact, not overflowing.
  assert.equal(ringLayout(five, 320, true).compact, true);
  // Every label of a compact ring stays inside the plain viewBox.
  for (let n = 1; n <= 12; n += 1) {
    const layout = ringLayout(Array.from({ length: n }, () => ({ indexDigits: String(n).length, addrChars: 9 })), 288, true);
    for (const p of ringPositions(n)) {
      const { box } = labelPlacement(p.angle, { scale: layout.scale, showAddress: !layout.compact, indexDigits: String(n).length });
      assert.ok(box.x0 >= layout.viewBox[0] && box.x1 <= layout.viewBox[0] + layout.viewBox[2], `n=${n} k=${p.index} leaves the plate`);
      assert.ok(box.y0 >= 0 && box.y1 <= SIZE, `n=${n} k=${p.index} leaves the plate vertically`);
    }
  }
  // A queued label ('queued') is shorter than an address and never decides the fit.
  assert.ok(QUEUED_LABEL.length < 9);
  assert.equal(ringLayout([...five, { indexDigits: 1, addrChars: QUEUED_LABEL.length }], 416, true).compact, false);
  // Nothing to lay out: compact with a plain viewBox.
  assert.equal(ringLayout([], 416, true).compact, true);
  assert.equal(ringLayout(five, 0, true).compact, true);
});

test('vote ticks: one hairline per sampled round from the point’s twelve o’clock, the last VOTE_TICKS only, lit where seen', () => {
  assert.equal(VOTE_TICKS, 12);
  assert.deepEqual(voteTicks([], 100, 100), []);
  const one = voteTicks([{ seen: true }], 100, 100);
  assert.equal(one.length, 1);
  assert.deepEqual(one[0], { x1: 100, y1: 100 - VOTE_TICK_IN, x2: 100, y2: 100 - VOTE_TICK_OUT, seen: true });
  const four = voteTicks([{ seen: true }, { seen: false }, { seen: true }, { seen: true }], 100, 100);
  assert.deepEqual(four.map((t) => t.seen), [true, false, true, true]);
  // The fourth tick is a quarter turn round (three o'clock) — 30° per round.
  assert.ok(Math.abs(four[3].x1 - (100 + VOTE_TICK_IN)) < 0.01 && Math.abs(four[3].y1 - 100) < 0.01);
  // Every tick is radial: both ends on the same bearing from the point.
  for (const t of four) {
    const a = Math.atan2(t.y1 - 100, t.x1 - 100);
    const b = Math.atan2(t.y2 - 100, t.x2 - 100);
    assert.ok(Math.abs(a - b) < 1e-6);
  }
  // Only the most recent VOTE_TICKS rounds are drawn.
  const many = voteTicks(Array.from({ length: 20 }, (_, k) => ({ seen: k >= 8 })), 100, 100);
  assert.equal(many.length, VOTE_TICKS);
  assert.ok(many.every((t) => t.seen));
});

test('buildSet decodes the live set: five active, none queued, keys mapped by stash', () => {
  const set = buildSet({ validators, queued, babe });
  assert.equal(set.active.length, 5);
  assert.equal(set.queued.length, 0);
  assert.deepEqual(
    set.active.map((v) => v.address),
    [
      '5Ck5SLSHYac6WFt5UZRSsdJjwmpSZq85fd5TRNAdZQVzEAPT',
      '5FCfAonRZgTFrTd9HREEyeJjDpT397KMzizE6T3DvebLFE7n',
      '5GNJqTPyNqANBkUVMN1LPPrxXnFouWXoe2wNSmmEoLctxiZY',
      '5HKPmK9GYtE1PSLsS1qiYU9xQ9Si1NcEhdeCq9sw5bqu4ns8',
      '5HpG9w8EBLe5XCrbczpwq5TSXvedjrBGCwqxK1iQ7qUsSWFc',
    ],
  );
  assert.deepEqual(set.active.map((v) => v.index), [0, 1, 2, 3, 4]);
  // Every grandpa address the node names as missing belongs to one of the five.
  const grandpa = new Set(set.active.map((v) => v.grandpaAddress));
  for (const id of MISSING_ALL) assert.ok(grandpa.has(id), `${id} is not a validator's grandpa key`);
  // The BABE authority list, in order, maps to the stashes in Session.Validators order today.
  assert.deepEqual(set.authorities, set.active.map((v) => v.stashHex));
});

test('authority index → stash: through Babe.Authorities and the queued babe key', () => {
  const set = buildSet({ validators, queued, babe });
  assert.equal(stashForAuthority(0, set.authorities), bytesToHex(validators[0]));
  assert.equal(stashForAuthority(4, set.authorities), bytesToHex(validators[4]));
  assert.equal(stashForAuthority(5, set.authorities), null);
  assert.equal(stashForAuthority(-1, set.authorities), null);
  assert.equal(stashForAuthority(1.5, set.authorities), null);
  assert.equal(stashForAuthority(undefined, set.authorities), null);
  // A babe key the queued keys do not name cannot be attributed.
  const stranger = { key: new Uint8Array(32).fill(9), weight: 1 };
  const shifted = buildSet({ validators, queued, babe: [stranger, ...babe] });
  assert.equal(stashForAuthority(0, shifted.authorities), null);
  assert.equal(stashForAuthority(1, shifted.authorities), bytesToHex(validators[0]));
  // The list's reason distinguishes the three causes.
  assert.equal(unmappedReason(0, shifted.authorities, 'ok'), 'not in queued keys');
  assert.equal(unmappedReason(7, shifted.authorities, 'ok'), 'beyond the authority list');
  assert.equal(unmappedReason(7, shifted.authorities, 'failed'), 'session keys unavailable');
  assert.equal(unmappedReason(0, [], 'pending'), 'sealed before the session keys were read');
  assert.equal(unmappedReason(0, [], 'ok'), 'beyond the authority list');
});

test('without queued keys or authorities the set is still drawn, and nothing is attributed', () => {
  const set = buildSet({ validators });
  assert.equal(set.active.length, 5);
  assert.deepEqual(set.authorities, []);
  assert.equal(set.active[0].grandpaAddress, null);
  assert.equal(set.active[0].babeHex, null);
  assert.equal(stashForAuthority(0, set.authorities), null);
  const withBabe = buildSet({ validators, babe });
  assert.deepEqual(withBabe.authorities, [null, null, null, null, null]);
});

test('queued-vs-active: a stash in QueuedKeys but not in Session.Validators is drawn at the next position as queued', () => {
  const joiner = {
    stash: new Uint8Array(32).fill(0xaa),
    babe: new Uint8Array(32).fill(0xbb),
    grandpa: new Uint8Array(32).fill(0xcc),
    authorityDiscovery: new Uint8Array(32).fill(0xdd),
  };
  const set = buildSet({ validators, queued: [...queued, joiner], babe });
  assert.equal(set.active.length, 5);
  assert.equal(set.queued.length, 1);
  const q = set.queued[0];
  assert.equal(q.index, 5);
  assert.equal(q.queued, true);
  assert.equal(q.address, encodeSs58(joiner.stash, 42));
  assert.equal(q.grandpaAddress, encodeSs58(joiner.grandpa, 42));
  // Once it is in Session.Validators it is active, not queued.
  const next = buildSet({ validators: [...validators, joiner.stash], queued: [...queued, joiner], babe });
  assert.equal(next.active.length, 6);
  assert.equal(next.queued.length, 0);
  // A validator that left the queue but is still active keeps its point, with no keys to attribute.
  const leaving = buildSet({ validators, queued: queued.slice(1), babe });
  assert.equal(leaving.active.length, 5);
  assert.equal(leaving.active[0].grandpaAddress, null);
  assert.equal(leaving.queued.length, 0);
  // The same queued stash twice is one point.
  const twice = buildSet({ validators, queued: [...queued, joiner, joiner], babe });
  assert.equal(twice.queued.length, 1);
});

test('the vote sampler counts a round only once a stage reached the threshold, once per round, seen if present in such a stage', () => {
  const set = buildSet({ validators, queued, babe });
  const ids = set.active.map((v) => v.grandpaAddress);
  const s = new VoteSampler();
  assert.equal(s.roundsSampled(), 0);
  assert.deepEqual(s.countsFor(ids[0]), { seen: 0, sampled: 0 });
  // Round 360 sampled at its start: nothing has arrived from anyone (0 of 5 in
  // both stages). It says nothing about any validator, so it is not a sampled round.
  assert.equal(s.add(sample(360, { prevotes: MISSING_ALL, precommits: MISSING_ALL }), ids), false);
  assert.equal(s.roundsSampled(), 0);
  assert.deepEqual(s.countsFor(ids[0]), { seen: 0, sampled: 0 });
  // Two prevotes in (3 of 5 missing): below the threshold of 4, still not evidence.
  assert.equal(s.add(sample(360, { prevotes: MISSING_ALL.slice(0, 3), precommits: MISSING_ALL }), ids), false);
  assert.equal(s.roundsSampled(), 0);
  // Four prevotes in: the stage reached the threshold, and the one still missing was absent from it.
  assert.equal(s.add(sample(360, { prevotes: MISSING_ALL.slice(0, 1), precommits: MISSING_ALL }), ids), true);
  assert.equal(s.roundsSampled(), 1);
  const seen = ids.map((id) => s.countsFor(id).seen);
  assert.equal(seen.filter((n) => n === 1).length, 4);
  assert.equal(seen.filter((n) => n === 0).length, 1);
  assert.deepEqual(s.countsFor(MISSING_ALL[0]), { seen: 0, sampled: 1 });
  // The same round sampled again with its precommits in: still one round, and the late one is now seen.
  assert.equal(s.add(sample(360, { prevotes: [], precommits: [] }), ids), true);
  assert.equal(s.roundsSampled(), 1);
  assert.deepEqual(s.countsFor(MISSING_ALL[0]), { seen: 1, sampled: 1 });
  // A later sample of the same round cannot un-see a vote.
  s.add(sample(360, { prevotes: MISSING_ALL.slice(0, 1), precommits: MISSING_ALL }), ids);
  assert.deepEqual(s.countsFor(MISSING_ALL[0]), { seen: 1, sampled: 1 });
  // A precommit stage at the threshold alone also counts (the live shape: prevotes 5 of 5, precommits 0 of 5 does too).
  assert.equal(s.add(sample(361, { prevotes: MISSING_ALL, precommits: MISSING_ALL.slice(0, 1) }), ids), true);
  assert.equal(s.add(sample(362, { prevotes: [], precommits: MISSING_ALL }), ids), true);
  assert.equal(s.roundsSampled(), 3);
  const present = ids.find((id) => id !== MISSING_ALL[0]);
  assert.deepEqual(s.countsFor(present), { seen: 3, sampled: 3 });
  assert.deepEqual(s.countsFor(MISSING_ALL[0]), { seen: 2, sampled: 3 });
  // A validator not in the set at the time of a sample is not counted for that round.
  s.add(sample(363), ids.slice(0, 2));
  assert.deepEqual(s.countsFor(ids[0]), { seen: 4, sampled: 4 });
  assert.equal(s.countsFor(ids[4]).sampled, 3);
  // A validator without a known grandpa key is skipped, not counted.
  s.add(sample(364), [null, ids[0]]);
  assert.equal(s.countsFor(ids[0]).sampled, 5);
  assert.equal(s.roundsSampled(), 5);
  // A sample with no known grandpa key at all is nobody's round, so it is not counted as sampled.
  assert.equal(s.add(sample(365), [null, null]), false);
  assert.equal(s.roundsSampled(), 5);
  // The threshold is the round's own, not a constant.
  assert.equal(s.add(sample(366, { threshold: 5, prevotes: MISSING_ALL.slice(0, 1), precommits: MISSING_ALL }), ids), false);
  assert.equal(s.add(sample(366, { threshold: 5, prevotes: [], precommits: MISSING_ALL }), ids), true);
  // A malformed sample is refused rather than counted as a round.
  assert.throws(() => s.add(sample('367'), ids), /round/);
  assert.throws(() => s.add({ ...sample(367), setId: '76' }, ids), /setId/);
  assert.throws(() => s.add({ ...sample(367), threshold: 0 }, ids), /threshold/);
  assert.throws(() => s.add({ ...sample(367), prevotes: { currentWeight: 5, missing: null } }, ids), /missing/);
  assert.throws(() => s.add({ ...sample(367), precommits: { currentWeight: '5', missing: [] } }, ids), /currentWeight/);
  assert.throws(() => s.add({ ...sample(367), precommits: undefined }, ids), /currentWeight/);
  assert.equal(s.roundsSampled(), 6);
  assert.equal(MIN_SAMPLES, 3);
});

test('the vote sampler keys rounds by voter-set id, so round numbers restarting at a set change are new rounds', () => {
  const set = buildSet({ validators, queued, babe });
  const ids = set.active.map((v) => v.grandpaAddress);
  const s = new VoteSampler();
  assert.equal(s.add(sample(5, { setId: 1 }), ids), true);
  assert.equal(s.add(sample(5, { setId: 2, prevotes: MISSING_ALL.slice(4), precommits: MISSING_ALL }), ids), true);
  assert.equal(s.roundsSampled(), 2);
  assert.deepEqual(s.countsFor(ids[0]), { seen: 2, sampled: 2 });
  // The one missing from set 2's round 5 is not seen there on the strength of set 1's round 5.
  assert.deepEqual(s.countsFor(MISSING_ALL[4]), { seen: 1, sampled: 2 });
  // recentFor lists the rounds oldest first, the last `limit` only, with the seen flag per round.
  assert.deepEqual(s.recentFor(MISSING_ALL[4]), [{ key: '1:5', seen: true }, { key: '2:5', seen: false }]);
  assert.deepEqual(s.recentFor(MISSING_ALL[4], 1), [{ key: '2:5', seen: false }]);
  for (let round = 6; round < 30; round += 1) s.add(sample(round, { setId: 2 }), ids);
  assert.equal(s.recentFor(ids[0]).length, VOTE_TICKS);
  assert.equal(s.recentFor(ids[0])[0].key, `2:${30 - VOTE_TICKS}`);
  // A validator that joined the set later has fewer sampled rounds, and no entries before it joined.
  const late = 'LATE';
  s.add(sample(30, { setId: 2 }), [...ids, late]);
  assert.deepEqual(s.countsFor(late), { seen: 1, sampled: 1 });
  assert.deepEqual(s.recentFor(late), [{ key: '2:30', seen: true }]);
});

test('the phrases state floors and samples, never a percentage, and say "since you opened this page" once, in the heading', () => {
  assert.equal(sealedPhrase(undefined, formatInteger), 'not seen sealing a block');
  assert.equal(sealedPhrase({ count: 0, last: null }, formatInteger), 'not seen sealing a block');
  assert.equal(sealedPhrase({ count: 1, last: 820715 }, formatInteger), 'seen sealing 1 block · last #820,715');
  assert.equal(sealedPhrase({ count: 12, last: 820800 }, formatInteger), 'seen sealing 12 blocks · last #820,800');
  assert.equal(votesPhrase({ seen: 0, sampled: 0 }, formatInteger), 'no finality round sampled yet');
  assert.equal(votesPhrase({ seen: 1, sampled: 1 }, formatInteger), 'finality votes seen in 1 of 1 round sampled');
  const phrase = votesPhrase({ seen: 4, sampled: 5 }, formatInteger);
  assert.equal(phrase, 'finality votes seen in 4 of 5 rounds sampled');
  assert.ok(!phrase.includes('%'));
  for (const text of [phrase, sealedPhrase({ count: 3, last: 1 }, formatInteger)]) {
    assert.ok(!/GRANDPA|BABE|prevote|precommit/.test(text), `${text} leans on a protocol name`);
    assert.ok(!/sealed \d/.test(text), `${text} states an exact count`);
  }
});

test('the aria summary names the set, the last author and anyone joining', () => {
  assert.equal(ariaSummary({ active: 5, queued: 0, lastAuthor: null }), '5 validators in the active set');
  assert.equal(
    ariaSummary({ active: 5, queued: 0, lastAuthor: 3 }),
    '5 validators in the active set; validator 3 sealed the latest block',
  );
  assert.equal(
    ariaSummary({ active: 5, queued: 1, lastAuthor: 3 }),
    '5 validators in the active set; validator 3 sealed the latest block; 1 joining next session',
  );
  assert.equal(ariaSummary({ active: 1, queued: 0, lastAuthor: null }), '1 validator in the active set');
});

test('a head is identified by height and state root, so a fork at one height is a new head', () => {
  assert.equal(headKey(820932, { stateRoot: '0xabc' }), '820932:0xabc');
  assert.notEqual(headKey(820932, { stateRoot: '0xabc' }), headKey(820932, { stateRoot: '0xdef' }));
  assert.equal(headKey(820932, {}), '820932');
  assert.equal(headKey(820932, undefined), '820932');
});
