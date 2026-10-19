/**
 * Emergent permissionless settlement (protocol §5 settlement rule, §7 P7).
 *
 * Settlement must arise from participant incentive alone: exactly one
 * `emissions.settleEra` per era, signed by a rotating set of ordinary
 * participants (no de-facto privileged settler), with backoff bounded by the
 * configured cap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runOne, type RunSpec } from '../runner.ts';
import { isPrivilegedSigner } from '../privileged.ts';

const RUN: RunSpec = {
  id: 'RUN-F',
  seeds: [1],
  eras: 40,
  settlement: { maxBackoff: 8 },
  cohorts: [
    { archetype: 'A-1', count: 2, params: { stakeCmn: 5000, escrowsPerEra: 2 } },
    { archetype: 'A-2', count: 2, params: { stakeCmn: 10000 } },
  ],
};

test('exactly one settle_era per era', async () => {
  const r = await runOne(RUN, 1);
  const settleCalls = r.records.filter((x) => x.method === 'emissions.settleEra');
  assert.equal(settleCalls.length, RUN.eras);
  assert.equal(r.settlements.length, RUN.eras);
});

test('settlers are ordinary population accounts, never privileged', async () => {
  const r = await runOne(RUN, 1);
  const population = new Set(
    r.records.filter((x) => x.method === 'agents.register').map((x) => x.signer),
  );
  for (const s of r.settlements) {
    assert.ok(population.has(s.settler), `settler ${s.settler} not in population`);
    assert.ok(!isPrivilegedSigner(s.settler));
  }
});

test('backoff stays within the configured cap', async () => {
  const r = await runOne(RUN, 1);
  for (const s of r.settlements) {
    assert.ok(s.backoff >= 0 && s.backoff <= RUN.settlement!.maxBackoff);
  }
});

test('settlement rotates — no single account settles everything', async () => {
  const r = await runOne(RUN, 1);
  const settlers = new Set(r.settlements.map((s) => s.settler));
  assert.ok(settlers.size > 1, 'a single de-facto settler would be a liveness risk');
});
