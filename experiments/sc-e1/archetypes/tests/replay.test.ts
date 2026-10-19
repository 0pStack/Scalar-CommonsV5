/**
 * Manifest replay identity — the acceptance criterion:
 * "replaying a manifest reproduces identical extrinsic sequences per seed."
 *
 * For every (run, seed) in the bundled manifest, executing twice must yield the
 * exact same serialised extrinsic sequence and digest. We also re-run the whole
 * manifest twice and compare the digest vectors.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadManifest,
  defaultManifestPath,
  runManifest,
  runOne,
  serializeSequence,
} from '../runner.ts';

test('bundled manifest parses and has the §6 run matrix', () => {
  const m = loadManifest(defaultManifestPath());
  const ids = m.runs.map((r) => r.id).sort();
  assert.deepEqual(ids, ['RUN-A', 'RUN-B', 'RUN-C', 'RUN-D', 'RUN-E', 'RUN-F']);
  for (const run of m.runs) {
    assert.ok(run.seeds.length >= 3, `${run.id} must have ≥ 3 seeds (§6)`);
    assert.ok(run.eras >= 1);
    assert.ok(run.cohorts.length >= 1);
  }
});

test('every (run, seed) replays to an identical sequence', async () => {
  const m = loadManifest(defaultManifestPath());
  for (const run of m.runs) {
    for (const seed of run.seeds) {
      const a = await runOne(run, seed);
      const b = await runOne(run, seed);
      assert.equal(
        serializeSequence(a.records),
        serializeSequence(b.records),
        `${run.id} seed=${seed} sequence drifted`,
      );
      assert.equal(a.digest, b.digest, `${run.id} seed=${seed} digest drifted`);
    }
  }
});

test('running the full manifest twice yields identical digest vectors', async () => {
  const m = loadManifest(defaultManifestPath());
  const first = (await runManifest(m)).map((r) => `${r.runId}#${r.seed}=${r.digest}`);
  const second = (await runManifest(m)).map((r) => `${r.runId}#${r.seed}=${r.digest}`);
  assert.deepEqual(first, second);
});

test('distinct seeds within a run produce distinct digests', async () => {
  const m = loadManifest(defaultManifestPath());
  const runA = m.runs.find((r) => r.id === 'RUN-A');
  assert.ok(runA);
  const digests = new Set<string>();
  for (const seed of runA.seeds) {
    digests.add((await runOne(runA, seed)).digest);
  }
  assert.equal(digests.size, runA.seeds.length);
});
