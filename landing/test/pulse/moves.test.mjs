// Every runtime event the page lights drives the move the issue asks for, and
// the hour's events size the points.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENTS, kindOf, partiesOf, agreementKey } from '../../src/pulse/model.js';
import { activityOf, moveOf } from '../../src/pulse/moves.js';
import { field } from '../../src/observatory/data.js';

const A = '5CdCULdBrDXrsm43KPaiUWJSG9WTBHHW5s8kJVz5U89bLiuq';
const B = '5Dt87gd2vXhAumh2P3cBbNDkTbnb983cWn6uhkTZrDp1BPXW';
const DATA = {
  'escrow.AgreementCreated': { buyer: A, provider: B, seq: 4, amount: '20000000000000' },
  'messages.MessageSent': { from: B, to: A, kind: 'DeliveryNotice', agreement: [B, 4], payload_hash: '0x', payload_len: 1, nonce: '1' },
  'escrow.DeliveryConfirmed': { buyer: A, provider: B, seq: 4, amount: '20000000000000' },
  'escrow.DisputeOpened': { buyer: A, provider: B, seq: 4, request_id: '0x' },
  'escrow.DisputeResolved': { buyer: A, provider: B, seq: 4, provider_wins: false },
  'oracle.OracleResponseSubmitted': { id: '0x', agent: A },
  'oracle.BatchResponseSubmitted': { agent: A, accepted: 3, skipped: 0 },
  'agents.AgentRegistered': { who: B, stake: '1', fee: '1' },
};
const live = (row) => {
  const event = { id: '1-1', blockNumber: 1, index: 1, section: row.section, method: row.method, extrinsicId: '1-0', data: DATA[`${row.section}.${row.method}`] };
  return { event, row: kindOf(event), parties: partiesOf(event), at: 0 };
};
const KEY = agreementKey(A, B, 4);

test('each event the page lights drives exactly the graph move the issue names, with the right parties and thread', () => {
  const names = new Map([[B, 'swarm-0007']]);
  const moves = Object.fromEntries(EVENTS.map((row) => [`${row.section}.${row.method}`, moveOf(live(row), { names, field })]));
  assert.deepEqual(moves['escrow.AgreementCreated'], {
    call: 'addLink',
    args: [{ id: KEY, source: A, target: B, seq: 4, status: 'Created' }, { drawMs: 400 }],
  });
  assert.deepEqual(moves['messages.MessageSent'], { call: 'message', args: [B, A, KEY] }, 'a reply rides the same thread, back from the provider');
  assert.deepEqual(moves['escrow.DeliveryConfirmed'], { call: 'settleLink', args: [KEY] });
  assert.deepEqual(moves['escrow.DisputeOpened'], { call: 'disputeLink', args: [KEY] });
  assert.deepEqual(moves['escrow.DisputeResolved'], { call: 'resolveLink', args: [KEY] });
  assert.deepEqual(moves['oracle.OracleResponseSubmitted'], { call: 'spark', args: [A] });
  assert.deepEqual(moves['oracle.BatchResponseSubmitted'], { call: 'spark', args: [A] });
  assert.deepEqual(moves['agents.AgentRegistered'], {
    call: 'registered',
    args: [B, { id: B, name: 'swarm-0007', operator: true, val: 1, completed: 0, disputed: false }],
  });
  // A message about nothing in particular has no thread: the graph draws its arc.
  const plain = live(EVENTS[1]);
  plain.event.data = { ...plain.event.data, agreement: null };
  assert.deepEqual(moveOf(plain, { field }), { call: 'message', args: [B, A, null] });
  // An agent with no name joins without the operator ring.
  assert.equal(moveOf(live(EVENTS[7]), { field }).args[1].operator, false);
});

test('activity in the last hour counts each agent once per event it was party to, on either end', () => {
  const events = [
    { parties: { from: A, to: B } },
    { parties: { from: B, to: A } },
    { parties: { from: A, to: null } },
    { parties: { from: 'x', to: undefined } },
  ];
  const counts = activityOf(events);
  assert.equal(counts.get(A), 3);
  assert.equal(counts.get(B), 2);
  assert.equal(counts.get('x'), 1);
  assert.equal(counts.has('undefined'), false);
  assert.equal(activityOf([]).size, 0);
});
