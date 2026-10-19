// Unit tests for the agent field's pure model: the operator-run prefix, each
// agent's state, the cell order, buckets above the threshold, the grid, hit
// testing, the live line and the footnote; and the last-hour row's counting.
// The 2,000-agent case is exercised here, not only in screenshots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUCKET_THRESHOLD,
  OPERATOR_PREFIX,
  BLOCKS_PER_HOUR,
  isOperatorRun,
  partiesOf,
  agentState,
  orderAgents,
  cellsFor,
  bucketStates,
  gridLayout,
  cellCentre,
  cellAt,
  dotRadius,
  ringRadius,
  liveLine,
  tally,
  slashedSince,
  footnote,
  parseColour,
  mixColour,
} from '../../src/observatory/instruments/agent-field.js';
import { hourCount, FIGURES } from '../../src/observatory/instruments/last-hour.js';
import { indexHour, lagNote } from '../../src/observatory/hour.js';
import { field } from '../../src/observatory/data.js';

const agent = (i, extra = {}) => ({
  address: `5Agent${String(i).padStart(4, '0')}`,
  name: null,
  registeredAtBlock: i * 10,
  activeEscrowCount: 0,
  completedAgreements: 0,
  stakePlancks: '1',
  ...extra,
});

/** A 2,000-agent stress case (ten times the public network's ~200 operator-run agents): 1,980 swarm- agents, 20 external. */
function network(n = 2_000, external = 20) {
  return Array.from({ length: n }, (_, i) =>
    agent(i, { name: i < n - external ? `swarm-${String(i).padStart(4, '0')}` : `ext-${i}`, activeEscrowCount: i % 7 === 0 ? 1 : 0 }),
  );
}

test('operator-run is the swarm- prefix on the on-chain name, and nothing else', () => {
  assert.equal(OPERATOR_PREFIX, 'swarm-');
  assert.equal(isOperatorRun('swarm-0001'), true);
  assert.equal(isOperatorRun('Swarm-0001'), false, 'the prefix is exact');
  assert.equal(isOperatorRun('my-swarm-agent'), false, 'a prefix, not a substring');
  assert.equal(isOperatorRun(null), false, 'an agent with no name is not operator-run');
  assert.equal(isOperatorRun(undefined), false);
});

test('an agent is slashed, in dispute, working or idle, most urgent first', () => {
  const open = [
    { buyer: 'A', provider: 'B', status: 'Created' },
    { buyer: 'C', provider: 'D', status: 'Disputed' },
  ];
  const parties = partiesOf(open);
  const slashed = new Set(['D']);
  const s = (address, extra) => agentState({ address, activeEscrowCount: 0, ...extra }, { ...parties, slashed });
  assert.equal(s('A'), 'working', 'a buyer with an open agreement is working, though the chain counts providers only');
  assert.equal(s('B'), 'working');
  assert.equal(s('C'), 'disputed');
  assert.equal(s('D'), 'slashed', 'a slash outranks a dispute');
  assert.equal(s('E'), 'idle');
  assert.equal(s('F', { activeEscrowCount: 2 }), 'working', 'the chain’s own provider counter counts too');
  assert.deepEqual(tally([{ address: 'A', activeEscrowCount: 0 }, { address: 'C', activeEscrowCount: 0 }, { address: 'E', activeEscrowCount: 0 }], parties), {
    active: 2,
    disputed: 1,
  });
});

test('cells are external agents first, then operator-run, each by registration', () => {
  const ordered = orderAgents([
    agent(3, { name: 'swarm-b' }),
    agent(1, { name: 'external' }),
    agent(2, { name: 'swarm-a' }),
    agent(4),
  ]);
  assert.deepEqual(ordered.map((a) => a.registeredAtBlock), [10, 40, 20, 30]);
});

test('up to 800 agents each have a cell; above that, buckets keep exact counts, show any dispute or slash, and are working in the same share as their agents', () => {
  const states = (a) => (a.activeEscrowCount ? 'working' : 'idle');
  const small = cellsFor(orderAgents(network(800)), states);
  assert.equal(small.size, 1);
  assert.equal(small.cells.length, 800);
  assert.equal(small.cells[0].key, small.cells[0].agents[0].address);

  const big = cellsFor(orderAgents(network(2_000)), (a) => (a.registeredAtBlock === 10 ? 'disputed' : states(a)));
  assert.equal(BUCKET_THRESHOLD, 800);
  assert.equal(big.size, 3, '⌈2000 / 800⌉ agents per cell');
  assert.equal(big.cells.length, 667);
  assert.ok(big.cells.length <= BUCKET_THRESHOLD);
  const total = big.cells.reduce((n, c) => n + c.agents.length, 0);
  assert.equal(total, 2_000, 'every agent is in exactly one cell');
  // The 20 external agents come first and fill the first cells; they are not ringed.
  assert.equal(big.cells[0].ring, false);
  assert.equal(big.cells.at(-1).ring, true, 'a bucket of operator-run agents is ringed');
  // The seam bucket mixes the two groups and is not ringed: a ring means every agent in it is operator-run.
  const seam = big.cells.find((c) => c.operator > 0 && c.operator < c.agents.length);
  assert.ok(seam && seam.ring === false);
  const withDispute = big.cells.find((c) => c.counts.disputed > 0);
  assert.equal(withDispute.state, 'disputed');
  assert.equal(withDispute.counts.disputed, 1, 'the count is exact even when the colour is the dispute');
  // The share of working cells tracks the share of working agents, and a cell is never working without a working agent in it.
  const working = big.cells.filter((c) => c.state === 'working');
  for (const cell of working) assert.ok(cell.counts.working > 0);
  const agentsWorking = big.cells.reduce((n, c) => n + (c.counts.disputed || c.counts.slashed ? 0 : c.counts.working), 0);
  const plain = big.cells.filter((c) => !c.counts.disputed && !c.counts.slashed);
  const share = working.length / plain.length;
  const agentShare = agentsWorking / plain.reduce((n, c) => n + c.agents.length, 0);
  assert.ok(Math.abs(share - agentShare) < 0.02, `working cells ${share.toFixed(3)} vs working agents ${agentShare.toFixed(3)}`);
  const c = (working, idle = 3 - working) => ({ idle, working, disputed: 0, slashed: 0 });
  assert.deepEqual(bucketStates([c(3), c(0), c(3)]), ['working', 'idle', 'working'], 'whole buckets are what they are');
  assert.deepEqual(bucketStates([c(1), c(1), c(1)]), ['idle', 'working', 'idle'], 'one in three, one cell in three');
  assert.deepEqual(bucketStates([c(0), { idle: 2, working: 0, disputed: 1, slashed: 0 }, { idle: 0, working: 1, disputed: 1, slashed: 1 }]), ['idle', 'disputed', 'slashed']);
});

test('the grid fits every cell inside the plate, square, centred, capped for small networks', () => {
  for (const [count, w, h] of [[40, 700, 470], [800, 700, 470], [667, 310, 430], [2_000, 1_100, 600], [1, 300, 300]]) {
    const g = gridLayout(count, w, h);
    assert.ok(g.cols * g.rows >= count, `${count}: room for every cell`);
    assert.ok(g.x0 >= 0 && g.y0 >= 0, `${count}: inside the plate`);
    assert.ok(g.x0 + g.cols * g.pitch <= w && g.y0 + g.rows * g.pitch <= h, `${count}: inside the plate`);
    assert.ok(g.pitch <= 36, `${count}: capped`);
    assert.ok(Math.abs(w - (2 * g.x0 + g.cols * g.pitch)) <= 1 && Math.abs(h - (2 * g.y0 + g.rows * g.pitch)) <= 1, `${count}: centred`);
    // The ring stays inside the cell's square.
    assert.ok(ringRadius(g.pitch) + 0.5 <= g.pitch / 2 || g.pitch < 8, `${count}: the ring fits the cell`);
  }
  const forty = gridLayout(40, 700, 470);
  assert.equal(forty.pitch, 36, 'forty agents make a tidy block, not forty huge dots');
  const phone = gridLayout(667, 310, 430);
  assert.ok(phone.pitch >= 12, `2,000 agents bucketed on a phone still give ${phone.pitch} px cells`);
  assert.ok(dotRadius(phone.pitch) >= 3);
  assert.deepEqual(gridLayout(0, 100, 100).cols, 0);
});

test('a point finds its cell, and nothing outside the grid', () => {
  const g = gridLayout(10, 100, 50);
  for (let i = 0; i < 10; i += 1) {
    const { x, y } = cellCentre(g, i);
    assert.equal(cellAt(g, x, y), i);
  }
  assert.equal(cellAt(g, g.x0 - 1, g.y0 + 1), -1);
  const lastRowGap = cellCentre(g, g.cols * g.rows - 1);
  if (g.cols * g.rows > 10) assert.equal(cellAt(g, lastRowGap.x, lastRowGap.y), -1, 'an empty slot in the last row is not a cell');
});

test('the live line and the footnote say what is there, and what could not be read', () => {
  const fmt = (n) => n.toLocaleString('en-US');
  assert.equal(liveLine({ agents: 2000, active: 286, disputed: 3 }, fmt), '2,000 agents · 286 active now · 3 in dispute');
  assert.equal(liveLine({ agents: 1, active: 0, disputed: 0 }, fmt), '1 agent · 0 active now · 0 in dispute');
  assert.equal(liveLine({ agents: 512, active: null, disputed: null, floor: true }, fmt), '≥ 512 agents · activity unavailable · disputes unavailable');
  assert.match(footnote({ size: 1, truncated: false, scanLimit: 512, listed: 40, total: 40 }, fmt), /^One cell per agent\. External agents come first, then operator-run/);
  assert.match(footnote({ size: 3, truncated: false, scanLimit: 512, listed: 2000, total: 2000 }, fmt), /^One cell per 3 agents; working cells are in the same share as working agents, and any dispute or slash shows\. /);
  assert.match(footnote({ size: 1, truncated: true, scanLimit: 512, listed: 512, total: 512 }, fmt), /; the indexer's live scan stops at 512 agents, so 512 are drawn\.$/);
});

test('recently slashed is the SlashExecuted events since the block of one hour ago, by who', () => {
  assert.equal(BLOCKS_PER_HOUR, 600, 'the runtime’s HOURS at six-second blocks');
  const items = [
    { blockNumber: 1_000, data: { who: 'A' } },
    { blockNumber: 700, data: { who: 'B' } },
    { blockNumber: 399, data: { who: 'C' } },
  ];
  assert.deepEqual([...slashedSince(items, 400, field)], ['A', 'B']);
  assert.throws(() => slashedSince([{ blockNumber: 900, data: {} }], 400, field), /data\.who/);
});

test('a state change blends between the two inks, and an unreadable ink falls back to the new one', () => {
  assert.deepEqual(parseColour('#5fd0c2'), [95, 208, 194]);
  assert.deepEqual(parseColour('#fff'), [255, 255, 255]);
  assert.deepEqual(parseColour('rgb(1, 2, 3)'), [1, 2, 3]);
  assert.equal(mixColour('#000000', '#ffffff', 0.5), 'rgb(128, 128, 128)');
  assert.equal(mixColour('#000000', '#ffffff', 1), '#ffffff');
  assert.equal(mixColour('var(--x)', '#ffffff', 0.5), '#ffffff');
});

test('the last hour counts each kind back to its start, as a floor when the read stopped short, and fails honestly', () => {
  assert.deepEqual(FIGURES.map((f) => f.key), ['hourOracle', 'hourSettled', 'hourDisputes', 'hourSlashes', 'hourMessages']);
  const ok = (blocks, reachedStart = true) => ({ ok: true, since: 400, reachedStart, items: blocks.map((blockNumber) => ({ blockNumber })) });
  assert.deepEqual(hourCount([ok([900, 500, 300])]), { ok: true, count: 2, floor: false });
  // Single answers and batches add up.
  assert.deepEqual(hourCount([ok([900, 500, 300]), ok([450, 100])]), { ok: true, count: 3, floor: false });
  // The page cap stopped before block 400: a floor.
  assert.deepEqual(hourCount([ok([900, 800], false)]), { ok: true, count: 2, floor: true });
  // One failed read fails the figure: never a partial number.
  assert.deepEqual(hourCount([ok([900]), { ok: false, error: 'HTTP 502' }]), { ok: false, error: 'HTTP 502' });
});

test('the last hour is the index’s newest 600 blocks, not 600 blocks back from the chain head (the 0-settled bug)', () => {
  // Live on 2026-10-05: the chain at #905,401, the index synced to #894,730.
  const status = { chain: { bestBlock: 905_401, finalizedBlock: 905_399 }, indexer: { syncedHeight: 894_730 } };
  const hour = indexHour(status, field);
  assert.deepEqual(hour, { since: 894_130, to: 894_730, best: 905_401, behind: 10_671 });
  // DeliveryConfirmed events as the index holds them: one every ~4 blocks through its newest hour.
  const items = Array.from({ length: 160 }, (_, k) => ({ blockNumber: 894_720 - k * 4 }));
  const record = (since) => ({ ok: true, since, reachedStart: true, items });
  assert.equal(hourCount([record(905_401 - 600)]).count, 0, 'counted back from the chain head, the window starts past the index: 0');
  const fixed = hourCount([record(hour.since)]);
  assert.equal(fixed.count, items.filter((e) => e.blockNumber >= 894_130).length);
  assert.ok(fixed.count > 100, `${fixed.count} settled in the index’s newest hour`);
  // The page says so when the index is an hour or more behind.
  const fmt = (n) => n.toLocaleString('en-US');
  assert.equal(
    lagNote(hour, fmt),
    'Counted over the index’s newest hour, to block #894,730: the index is 10,671 blocks (about 17.8 h) behind the chain.',
  );
  assert.equal(lagNote({ to: 905_399, behind: 2 }, fmt), '', 'an index two blocks behind is not news');
  assert.throws(() => indexHour({ chain: { bestBlock: 1 } }, field), /indexer\.syncedHeight/);
});
