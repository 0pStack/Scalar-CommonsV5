/**
 * Per-archetype behavioural contracts (protocol §5, workbook tab 02). Each test
 * runs an isolated cohort and asserts the defining behaviour of that archetype.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runOne, type RunSpec } from '../runner.ts';
import { MIN_QUALIFYING_VOL } from '../constants.ts';

function run(cohorts: RunSpec['cohorts'], eras = 6): Promise<ReturnType<typeof runOne>> {
  return runOne({ id: 'RUN-T', seeds: [1], eras, settlement: { maxBackoff: 8 }, cohorts }, 1);
}

const methodsOf = (records: { signer: string; method: string }[], prefix: string): Set<string> =>
  new Set(records.filter((r) => r.signer.startsWith(prefix)).map((r) => r.method));

test('A-1 HONEST-WORKER runs the full escrow lifecycle + oracle + governance', async () => {
  const r = await run([{ archetype: 'A-1', count: 2, params: { escrowsPerEra: 2 } }]);
  const m = methodsOf(r.records, 'A-1');
  for (const expected of [
    'agents.register',
    'agents.heartbeat',
    'escrow.createAgreement',
    'escrow.recordDelivery',
    'escrow.confirmDelivery',
    'oracle.submitResponse',
    'convictionVoting.vote',
    'emissions.claim',
  ]) {
    assert.ok(m.has(expected), `A-1 missing ${expected}`);
  }
});

test('A-2 PASSIVE-STAKER never does escrow, oracle, or governance work', async () => {
  const r = await run([{ archetype: 'A-2', count: 2, params: { stakeCmn: 10000 } }]);
  const m = methodsOf(r.records, 'A-2');
  for (const forbidden of [
    'escrow.createAgreement',
    'escrow.recordDelivery',
    'escrow.confirmDelivery',
    'oracle.submitResponse',
    'convictionVoting.vote',
  ]) {
    assert.ok(!m.has(forbidden), `A-2 must not emit ${forbidden}`);
  }
  // It does register, heartbeat, claim.
  assert.ok(m.has('agents.register') && m.has('agents.heartbeat') && m.has('emissions.claim'));
});

test('A-3 SYBIL-FARM spins up many min-stake accounts and does no escrow', async () => {
  const r = await run([{ archetype: 'A-3', count: 15, params: {} }], 3);
  const accounts = new Set(
    r.records.filter((x) => x.signer.startsWith('A-3')).map((x) => x.signer),
  );
  assert.equal(accounts.size, 15);
  const m = methodsOf(r.records, 'A-3');
  assert.ok(!m.has('escrow.createAgreement'), 'sybils do no real volume');
  assert.ok(m.has('agents.register') && m.has('agents.heartbeat'));
});

test('A-4 WASH-TRADER uses exactly two accounts and clears MinQualifyingVol/era', async () => {
  const r = await run([{ archetype: 'A-4', count: 2, params: {} }], 5);
  const accounts = new Set(
    r.records.filter((x) => x.signer.startsWith('A-4')).map((x) => x.signer),
  );
  assert.equal(accounts.size, 2, 'self-link guard forces a two-account structure');

  // Per-era self-escrow volume must reach MinQualifyingVol.
  const byEra = new Map<number, bigint>();
  for (const rec of r.records) {
    if (rec.signer.startsWith('A-4') && rec.method === 'escrow.createAgreement') {
      const amount = BigInt(rec.args[1] as string);
      byEra.set(rec.era, (byEra.get(rec.era) ?? 0n) + amount);
    }
  }
  assert.ok(byEra.size > 0);
  for (const [era, vol] of byEra) {
    assert.ok(vol >= MIN_QUALIFYING_VOL, `era ${era} volume ${vol} < MinQualifyingVol`);
  }

  // Both directions present: each account is a buyer at least once.
  const buyers = new Set(
    r.records
      .filter((x) => x.signer.startsWith('A-4') && x.method === 'escrow.createAgreement')
      .map((x) => x.signer),
  );
  assert.equal(buyers.size, 2, 'wash cycle must run both directions');
});

test('A-5 ORACLE-COLLUDER submits identical coordinated answers per era', async () => {
  const r = await run([{ archetype: 'A-5', count: 4, params: {} }], 5);
  const accounts = new Set(
    r.records.filter((x) => x.signer.startsWith('A-5')).map((x) => x.signer),
  );
  assert.equal(accounts.size, 4);

  // Group oracle answers by era; all colluders must submit the same answer hash.
  const answersByEra = new Map<number, Set<string>>();
  for (const rec of r.records) {
    if (rec.signer.startsWith('A-5') && rec.method === 'oracle.submitResponse') {
      const answer = rec.args[1] as string; // (requestId, answerHash, capability)
      const set = answersByEra.get(rec.era) ?? new Set<string>();
      set.add(answer);
      answersByEra.set(rec.era, set);
    }
  }
  assert.ok(answersByEra.size > 0);
  for (const [era, answers] of answersByEra) {
    assert.equal(answers.size, 1, `era ${era}: colluders disagreed (not coordinated)`);
  }
});
