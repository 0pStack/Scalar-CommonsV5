/**
 * No privileged keys, no privileged calls (protocol §5, §12 RUN-F void rule,
 * CLAUDE.md first-principle #3). Across the entire manifest, every recorded
 * extrinsic must be signed by a regular participant and route through a normal
 * origin. RUN-F (the liveness soak) is checked explicitly since a single
 * privileged call there voids the run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadManifest, defaultManifestPath, runManifest, runOne } from '../runner.ts';
import { isPrivilegedMethod, isPrivilegedSigner } from '../privileged.ts';

/** The complete set of extrinsics the archetypes are allowed to emit. */
const ALLOWED_METHODS = new Set([
  'agents.register',
  'agents.addStake',
  'agents.heartbeat',
  'escrow.createAgreement',
  'escrow.recordDelivery',
  'escrow.confirmDelivery',
  'oracle.submitResponse',
  'convictionVoting.vote',
  'emissions.settleEra',
  'emissions.claim',
]);

test('no extrinsic in the manifest uses a privileged signer or call', async () => {
  const results = await runManifest(loadManifest(defaultManifestPath()));
  for (const result of results) {
    for (const rec of result.records) {
      assert.ok(
        !isPrivilegedSigner(rec.signer),
        `${result.runId}#${result.seed} privileged signer: ${rec.signer}`,
      );
      assert.ok(
        !isPrivilegedMethod(rec.method),
        `${result.runId}#${result.seed} privileged method: ${rec.method}`,
      );
      assert.ok(
        ALLOWED_METHODS.has(rec.method),
        `${result.runId}#${result.seed} unexpected method: ${rec.method}`,
      );
    }
  }
});

test('RUN-F liveness soak contains zero privileged triggers', async () => {
  const m = loadManifest(defaultManifestPath());
  const runF = m.runs.find((r) => r.id === 'RUN-F');
  assert.ok(runF);
  for (const seed of runF.seeds) {
    const r = await runOne(runF, seed);
    const settleCalls = r.records.filter((x) => x.method === 'emissions.settleEra');
    assert.equal(settleCalls.length, runF.eras, 'exactly one settle per era');
    for (const call of settleCalls) {
      assert.ok(!isPrivilegedSigner(call.signer));
    }
  }
});
