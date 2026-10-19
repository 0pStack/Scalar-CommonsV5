// What the plate does for each event: the one table from an event's kind to
// the graph's move, kept apart from main.js so the test can hold every row of
// model.EVENTS to the move the issue asks for — an agreement drawn in over
// 400 ms, a message particle, a settlement, a dispute, a resolution, a spark,
// a fade-in — without a window or a canvas.

import { agreementKeyOf, nodeValue } from './model.js';
import { isOperatorRun } from '../observatory/instruments/agent-field.js';

/**
 * The graph call for a live event: `{ call, args }`, where `call` is a method
 * of the graph handle and `args` its arguments. `names` is the feed's
 * address → name map, for a newly registered agent's label and ring.
 */
export function moveOf({ event, row, parties }, { names = new Map(), field = (o, k) => o[k] } = {}) {
  const key = agreementKeyOf(event);
  switch (row.kind) {
    case 'agreement':
      return {
        call: 'addLink',
        args: [{ id: key, source: parties.from, target: parties.to, seq: field(event.data, 'seq'), status: 'Created' }, { drawMs: row.lifetimeMs }],
      };
    case 'message':
      return { call: 'message', args: [parties.from, parties.to, key] };
    case 'settled':
      return { call: 'settleLink', args: [key] };
    case 'dispute':
      return { call: 'disputeLink', args: [key] };
    case 'resolved':
      return { call: 'resolveLink', args: [key] };
    case 'oracle':
      return { call: 'spark', args: [parties.from] };
    default: {
      const name = names.get(parties.from);
      return { call: 'registered', args: [parties.from, { id: parties.from, name, operator: isOperatorRun(name), val: nodeValue(0), completed: 0, disputed: false }] };
    }
  }
}

/**
 * Each agent's activity in the last hour, from the hour's events: one per
 * event it was party to, on either end. The plate sizes its points by this.
 */
export function activityOf(events) {
  const counts = new Map();
  for (const { parties } of events) {
    for (const address of [parties?.from, parties?.to]) {
      if (typeof address === 'string') counts.set(address, (counts.get(address) ?? 0) + 1);
    }
  }
  return counts;
}
