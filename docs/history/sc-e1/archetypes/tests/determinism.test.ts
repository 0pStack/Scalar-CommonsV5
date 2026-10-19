/**
 * Determinism: the same seed always produces the same extrinsic stream, and
 * different seeds diverge. This is the foundation the reproducibility
 * requirement (§10) rests on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Prng, deriveSeed } from '../prng.ts';
import { runOne, digestSequence, type RunSpec } from '../runner.ts';

const RUN: RunSpec = {
  id: 'RUN-A',
  seeds: [1, 2, 3],
  eras: 8,
  settlement: { maxBackoff: 8 },
  cohorts: [
    { archetype: 'A-1', count: 2, params: { stakeCmn: 5000, escrowsPerEra: 2 } },
    { archetype: 'A-2', count: 2, params: { stakeCmn: 10000 } },
  ],
};

test('PRNG is deterministic for a fixed seed', () => {
  const a = new Prng(42);
  const b = new Prng(42);
  for (let i = 0; i < 100; i += 1) assert.equal(a.next(), b.next());
});

test('PRNG diverges for different seeds', () => {
  const a = new Prng(1).next();
  const b = new Prng(2).next();
  assert.notEqual(a, b);
});

test('deriveSeed is stable and order-sensitive', () => {
  assert.equal(deriveSeed(1, 'A-3', 0, 5), deriveSeed(1, 'A-3', 0, 5));
  assert.notEqual(deriveSeed(1, 'a', 'b'), deriveSeed(1, 'ab'));
  assert.notEqual(deriveSeed(1, 'A-3', 0), deriveSeed(2, 'A-3', 0));
});

test('same (run, seed) yields byte-identical ledgers', async () => {
  const first = await runOne(RUN, 1);
  const second = await runOne(RUN, 1);
  assert.deepEqual(first.records, second.records);
  assert.equal(first.digest, second.digest);
  assert.equal(digestSequence(first.records), digestSequence(second.records));
});

test('different seeds diverge', async () => {
  const s1 = await runOne(RUN, 1);
  const s2 = await runOne(RUN, 2);
  assert.notEqual(s1.digest, s2.digest);
  // Same shape (same population/eras), different content.
  assert.equal(s1.records.length, s2.records.length);
});

test('settlement count equals era count (one settle_era per era)', async () => {
  const r = await runOne(RUN, 1);
  assert.equal(r.settlements.length, RUN.eras);
});
