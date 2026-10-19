// Unit tests for the network graph's pure model (the agent panel's detail
// view): edge keying and diffing, point synthesis for parties that have left,
// the radius scale, the label and fade thresholds, the bundle offsets for
// parallel agreements, the choice of the most active agents and the clusters.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUNDLE_CAP,
  BUNDLE_MAX_BAND,
  BUNDLE_MIN_SPACING,
  BUNDLE_SPACING,
  FADE_ISOLATED_ABOVE,
  GHOST_RADIUS,
  GRAPH_MAX_NODES,
  ISOLATED_ALPHA,
  LABEL_MAX_CHARS,
  LABEL_MAX_NODES,
  activityOf,
  buildEdges,
  bundleLayout,
  clusterAnchors,
  clusters,
  diffEdges,
  edgeKey,
  forceScale,
  labelPolicy,
  labelText,
  linesAt,
  nodeRadius,
  overlaps,
  pairKey,
  parallelOffset,
  rectTouchesCircle,
  seedAngle,
  stateOf,
  summaryText,
  synthesizeNodes,
  topAgents,
} from '../../src/observatory/instruments/constellation.js';

const A = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const B = '5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y';
const C = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const D = '5GEEaf5HcdzeUDEH8t1naW6nP55sfSJWVxf5JCGJMQaEFQfd';

const open = (buyer, provider, seq, status = 'Created', createdAtBlock = 100) => ({
  buyer,
  provider,
  seq,
  status,
  amountPlancks: '10000000000000',
  createdAtBlock,
});
const settled = (buyer, provider, seq, blockNumber = 50) => ({
  buyer,
  provider,
  seq,
  amountPlancks: '10000000000000',
  blockNumber,
});
const agent = (address, stakePlancks = '10000000000000000') => ({
  address,
  stakePlancks,
  completedAgreements: 1,
  activeEscrowCount: 0,
  name: null,
  leaving: false,
});

test('edge keys are the on-chain identity: buyer, provider and running number', () => {
  assert.equal(edgeKey(A, B, 0), `${A}/${B}/0`);
  assert.notEqual(edgeKey(A, B, 0), edgeKey(B, A, 0), 'direction matters to the key');
  assert.equal(pairKey(A, B), pairKey(B, A), 'but both directions share one bundle');
});

test('Created and Delivered are open lines; Disputed is its own state', () => {
  assert.equal(stateOf('Created'), 'open');
  assert.equal(stateOf('Delivered'), 'open');
  assert.equal(stateOf('Disputed'), 'disputed');
});

test('buildEdges keeps every open line, adds settled ones once, and skips a settled key still open', () => {
  const { edges, settledShown } = buildEdges(
    [open(A, B, 0), open(A, B, 1, 'Disputed'), open(C, D, 0, 'Delivered')],
    [settled(A, B, 0), settled(B, C, 3), settled(B, C, 3), settled(D, A, 7)],
  );
  assert.equal(edges.size, 5);
  assert.equal(settledShown, 2, 'one settled line duplicated a key, one was still open');
  assert.equal(edges.get(edgeKey(A, B, 0)).state, 'open', 'the open agreement wins over a same-key settled event');
  assert.equal(edges.get(edgeKey(A, B, 1)).state, 'disputed');
  assert.equal(edges.get(edgeKey(C, D, 0)).state, 'open');
  assert.equal(edges.get(edgeKey(B, C, 3)).state, 'settled');
  assert.equal(edges.get(edgeKey(B, C, 3)).block, 50, 'a settled line carries the block it was confirmed in');
  assert.equal(edges.get(edgeKey(D, A, 7)).state, 'settled');
});

test('diffEdges reports what is new, what is gone and what became a dispute', () => {
  const before = buildEdges([open(A, B, 0), open(A, B, 1), open(C, D, 0)], [settled(B, C, 3)]).edges;
  const after = buildEdges([open(A, B, 1, 'Disputed'), open(C, D, 0), open(D, A, 9)], [settled(B, C, 3), settled(A, B, 0)]).edges;
  const diff = diffEdges(before, after);
  assert.deepEqual(
    diff.added.map((e) => e.key),
    [edgeKey(D, A, 9)],
    'A/B/0 moved from open to settled under the same key, so it is a change, not an arrival',
  );
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.disputed.map((e) => e.key), [edgeKey(A, B, 1)]);

  const gone = diffEdges(after, buildEdges([open(C, D, 0)], []).edges);
  assert.deepEqual(
    gone.removed.map((e) => e.key).sort(),
    [edgeKey(A, B, 0), edgeKey(A, B, 1), edgeKey(B, C, 3), edgeKey(D, A, 9)].sort(),
  );
  assert.deepEqual(gone.added, []);
  assert.deepEqual(gone.disputed, []);
});

test('a line already disputed does not pulse again', () => {
  const before = buildEdges([open(A, B, 1, 'Disputed')], []).edges;
  const after = buildEdges([open(A, B, 1, 'Disputed')], []).edges;
  assert.deepEqual(diffEdges(before, after).disputed, []);
});

test('synthesizeNodes adds a hollow point for a party not in the agent list, and counts degree', () => {
  const { edges } = buildEdges([open(A, B, 0), open(A, C, 0)], [settled(D, A, 2)]);
  const nodes = synthesizeNodes([agent(A), agent(B), agent(C)], edges);
  assert.equal(nodes.size, 4);
  assert.equal(nodes.get(A).ghost, false);
  assert.equal(nodes.get(A).degree, 3);
  assert.equal(nodes.get(B).degree, 1);
  assert.equal(nodes.get(D).ghost, true);
  assert.equal(nodes.get(D).reason, 'no longer registered');
  assert.equal(nodes.get(D).degree, 1);
  assert.equal(nodes.get(A).stakePlancks, '10000000000000000', 'agent fields ride along');
});

test('when the agent list was cut short, an absent party is not called "no longer registered"', () => {
  const { edges } = buildEdges([open(A, D, 0)], []);
  const nodes = synthesizeNodes([agent(A)], edges, { listComplete: false });
  assert.equal(nodes.get(D).ghost, true);
  assert.match(nodes.get(D).reason, /cut short/);
  assert.doesNotMatch(nodes.get(D).reason, /no longer registered/);
});

test('an agent with no lines is a lone point of degree zero', () => {
  const nodes = synthesizeNodes([agent(A), agent(B)], new Map());
  assert.equal(nodes.get(A).degree, 0);
  assert.equal(nodes.get(B).degree, 0);
});

test('nodeRadius grows with the square root of activity, between 3 and 12 px, and scales with crowding', () => {
  assert.equal(nodeRadius(100, 100), 12);
  assert.equal(nodeRadius(25, 100), 3 + 9 * 0.5, 'a quarter of the activity is half the radius step');
  assert.equal(nodeRadius(0, 100), 3);
  assert.equal(nodeRadius(100, 0), 12, 'with no scale to speak of every point is full size');
  assert.equal(nodeRadius(200, 100), 12, 'never beyond the range');
  assert.equal(nodeRadius(100, 100, 0.5), 6);
  assert.ok(GHOST_RADIUS < nodeRadius(0, 1), 'a party that has left is drawn smaller than any agent');
  // Activity is the chain's completed-as-provider counter plus the lines drawn to the agent now.
  assert.equal(activityOf({ completedAgreements: 182 }, 3), 185);
  assert.equal(activityOf({ completedAgreements: 0 }, 0), 0);
  assert.equal(activityOf({}, 2), 2, 'a missing counter counts as none, never NaN');
});

test('labels are never drawn on the plate; above 60 of the graph’s 120 points, radii shrink and lone points fade', () => {
  // Address labels are never drawn on the plate: they show on hover or tap, and in the list.
  assert.deepEqual(labelPolicy(34), { labels: false, radiusFactor: 1, isolatedAlpha: 1 });
  assert.deepEqual(labelPolicy(LABEL_MAX_NODES), { labels: false, radiusFactor: 1, isolatedAlpha: 1 });
  assert.deepEqual(labelPolicy(LABEL_MAX_NODES + 1), { labels: false, radiusFactor: 0.6, isolatedAlpha: ISOLATED_ALPHA });
  assert.deepEqual(labelPolicy(120), { labels: false, radiusFactor: 0.6, isolatedAlpha: ISOLATED_ALPHA }, 'the graph’s most crowded plate');
  assert.equal(FADE_ISOLATED_ABOVE, LABEL_MAX_NODES);
});

test('parallel agreements fan out symmetrically and never wider than a band', () => {
  assert.equal(parallelOffset(0, 1), 0);
  assert.deepEqual([parallelOffset(0, 2), parallelOffset(1, 2)], [-3.5, 3.5]);
  assert.deepEqual([parallelOffset(0, 3), parallelOffset(1, 3), parallelOffset(2, 3)], [-7, 0, 7]);
  for (const n of [5, 8, 12, 20, 60]) {
    const offsets = Array.from({ length: n }, (_, i) => parallelOffset(i, n));
    assert.ok(Math.abs(offsets[0] + offsets[n - 1]) < 1e-9, `symmetric for ${n}`);
    const band = offsets[n - 1] - offsets[0];
    const spacing = offsets[1] - offsets[0];
    assert.ok(band <= Math.max(BUNDLE_MAX_BAND, BUNDLE_MIN_SPACING * (n - 1)) + 1e-9, `the band is bounded for ${n}`);
    assert.ok(spacing >= BUNDLE_MIN_SPACING - 1e-9 && spacing <= BUNDLE_SPACING + 1e-9, `lines stay apart but no wider than a small bundle for ${n}`);
  }
  assert.equal(parallelOffset(5, 6) - parallelOffset(4, 6), BUNDLE_SPACING, 'six lines still get the full spacing');
  assert.equal(parallelOffset(19, 20) - parallelOffset(18, 20), BUNDLE_MIN_SPACING, 'twenty close up to the minimum');
});

test('the screen-reader summary reads as a sentence and says what it is', () => {
  assert.equal(
    summaryText({ agents: 34, open: 36, disputed: 2, settled: 40 }),
    'Network graph: 34 agents, 36 open agreements, 2 disputed, 40 recently settled.',
  );
  assert.equal(
    summaryText({ agents: 1, open: 1, disputed: 0, settled: 0 }),
    'Network graph: 1 agent, 1 open agreement, 0 disputed, 0 recently settled.',
  );
});

test('the summary carries the floor when the agent list was cut short', () => {
  assert.equal(
    summaryText({ agents: 512, agentsFloor: true, open: 36, disputed: 2, settled: 40 }),
    'Network graph: at least 512 agents, 36 open agreements, 2 disputed, 40 recently settled.',
  );
});

test('the summary never turns an unread or unreadable source into a zero', () => {
  assert.equal(
    summaryText({ agents: 34, open: null, disputed: 0, settled: 40 }),
    'Network graph: 34 agents, open agreements unavailable, 40 recently settled.',
  );
  assert.equal(
    summaryText({ agents: 34, open: undefined, disputed: 0, settled: undefined }),
    'Network graph: 34 agents, open agreements not yet read, recently settled agreements not yet read.',
  );
  assert.equal(
    summaryText({ agents: 34, open: 36, disputed: 2, settled: null }),
    'Network graph: 34 agents, 36 open agreements, 2 disputed, recently settled agreements unavailable.',
  );
  assert.doesNotMatch(summaryText({ agents: 34, open: null, disputed: 0, settled: null }), /\b0 /);
});

test('linesAt counts an account’s lines from the line map: all, open only, or drawn only', () => {
  const { edges } = buildEdges(
    [open(A, B, 0), open(A, B, 1, 'Disputed'), open(C, A, 0)],
    [settled(A, B, 5), settled(B, C, 3)],
  );
  assert.equal(linesAt(edges, A), 4);
  assert.equal(linesAt(edges, A, { open: true }), 3, 'a buyer’s open lines count — the chain’s counter would say 0');
  assert.equal(linesAt(edges, B, { open: true }), 2);
  assert.equal(linesAt(edges, C, { open: true }), 1);
  assert.equal(linesAt(edges, D, { open: true }), 0);
  edges.get(edgeKey(A, B, 5)).hidden = true;
  assert.equal(linesAt(edges, A, { drawnOnly: true }), 3, 'a line hidden behind a bundle count is not "drawn"');
  assert.equal(linesAt(edges, A), 4, 'but it is still a line');
});

test('labelText prefers a name, cuts a long one with an ellipsis, and falls back to the short address', () => {
  assert.equal(labelText(null, A), '5FHn…94ty');
  assert.equal(labelText('', A), '5FHn…94ty');
  assert.equal(labelText('operator', A), 'operator');
  const long = 'operator-reference-agent-with-a-long-name';
  const cut = labelText(long, A);
  assert.equal(cut.length, LABEL_MAX_CHARS);
  assert.ok(cut.endsWith('…'));
  assert.equal(cut, `${long.slice(0, LABEL_MAX_CHARS - 1)}…`);
  assert.equal(labelText('x'.repeat(LABEL_MAX_CHARS), A), 'x'.repeat(LABEL_MAX_CHARS), 'exactly the limit is kept whole');
});

test('label placement geometry: rectangles overlap, and a rectangle on a point is caught', () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  assert.ok(overlaps(a, { x: 9, y: 9, w: 5, h: 5 }));
  assert.ok(!overlaps(a, { x: 10, y: 0, w: 5, h: 5 }), 'touching edges do not overlap');
  assert.ok(!overlaps(a, { x: 0, y: 11, w: 5, h: 5 }));
  assert.ok(rectTouchesCircle({ x: 10, y: -6, w: 40, h: 12 }, 12, 0, 4), 'a label starting inside a point');
  assert.ok(!rectTouchesCircle({ x: 10, y: -6, w: 40, h: 12 }, 0, 0, 4), 'a label beside its own point');
  assert.ok(rectTouchesCircle({ x: 0, y: 0, w: 10, h: 10 }, 12, 5, 3), 'a point clipping a corner');
  assert.ok(!rectTouchesCircle({ x: 0, y: 0, w: 10, h: 10 }, 14, 5, 3));
});

test('a new point lands at a stable angle for its address', () => {
  assert.equal(seedAngle(A), seedAngle(A));
  assert.notEqual(seedAngle(A), seedAngle(B));
  for (const address of [A, B, C, D]) {
    assert.ok(seedAngle(address) >= 0 && seedAngle(address) < Math.PI * 2);
  }
});

test('bundleLayout draws at most the cap per state, disputes first, and labels the rest with a count', () => {
  const lines = [
    ...Array.from({ length: 9 }, (_, i) => ({ key: `s${i}`, state: 'settled', block: 100 - i })),
    { key: 'o1', state: 'open', block: 200 },
    { key: 'd1', state: 'disputed', block: 300 },
  ];
  const { drawn, hidden, labels } = bundleLayout(lines);
  assert.equal(drawn.length, 1 + 1 + BUNDLE_CAP);
  assert.equal(hidden.length, 9 - BUNDLE_CAP);
  assert.equal(drawn[0].key, 'd1', 'the dispute is never the one hidden');
  assert.equal(drawn[1].key, 'o1');
  assert.deepEqual(drawn.slice(2).map((l) => l.block), [92, 93, 94, 95, 96, 97], 'oldest settled first');
  assert.deepEqual(labels, [{ state: 'settled', count: 9, text: '×9 settled' }]);
  assert.deepEqual(bundleLayout([{ key: 'o1', state: 'open', block: 1 }]).labels, [], 'no label under the cap');
});

test('forceScale shrinks the layout for a phone plate and never below 0.4', () => {
  assert.equal(forceScale(952, 595), 1);
  assert.ok(forceScale(358, 268) < 0.5 && forceScale(358, 268) >= 0.4);
  assert.equal(forceScale(10, 10), 0.4);
});

test('the graph shows only the 120 most active agents, and only the lines between two of them', () => {
  assert.equal(GRAPH_MAX_NODES, 120);
  const agents = Array.from({ length: 2_000 }, (_, i) => ({ address: `5A${String(i).padStart(5, '0')}`, completedAgreements: i % 300 }));
  // Agent 0 has no completed agreements but many open lines: lines count as activity too.
  const opens = Array.from({ length: 400 }, (_, i) => open(agents[0].address, agents[1 + (i % 3)].address, i));
  const { edges } = buildEdges(opens, [settled(agents[5].address, agents[6].address, 1)]);
  const top = topAgents(agents, edges);
  assert.equal(top.agents.length, 120);
  assert.equal(top.of, 2_000);
  assert.ok(top.agents.some((a) => a.address === agents[0].address), 'four hundred open lines put an idle-by-counter agent in');
  for (const edge of top.edges.values()) {
    const kept = new Set(top.agents.map((a) => a.address));
    assert.ok(kept.has(edge.buyer) && kept.has(edge.provider), 'no line to a point not drawn');
  }
  assert.equal(topAgents(agents.slice(0, 40), new Map()).agents.length, 40, 'a small network is shown whole');
  // Stable: the same input chooses the same agents.
  assert.deepEqual(topAgents(agents, edges).agents.map((a) => a.address), top.agents.map((a) => a.address));
});

test('clusters are the connected groups, largest first, with lone points together last; each has a place on the plate', () => {
  const { edges } = buildEdges([open(A, B, 0), open(B, C, 0)], []);
  const ids = [A, B, C, D, 'E'];
  const groups = clusters(ids, edges);
  assert.equal(groups.index.get(A), 0);
  assert.equal(groups.index.get(C), 0);
  assert.equal(groups.index.get(D), 1, 'a point with no line joins the lone group');
  assert.equal(groups.index.get('E'), 1);
  assert.equal(groups.count, 2);
  assert.equal(groups.alone, true);
  const anchors = clusterAnchors(groups.count, 600, 400, { alone: groups.alone });
  assert.equal(anchors.length, 2);
  assert.deepEqual(anchors[0], { x: 300, y: 200 }, 'the largest cluster in the middle');
  assert.ok(anchors[1].ring > 0, 'lone points on an outer ring');
  for (const a of clusterAnchors(6, 600, 400)) assert.ok(a.x > 0 && a.x < 600 && a.y > 0 && a.y < 400, 'every place is on the plate');
});

test('the graph polls with the agent field’s page caps, so one read serves both', async () => {
  const field = await import('../../src/observatory/instruments/agent-field.js');
  const graph = await import('../../src/observatory/instruments/constellation.js');
  assert.equal(graph.AGENT_PAGES, field.AGENT_PAGES);
  assert.equal(graph.ESCROW_PAGES, field.ESCROW_PAGES);
});

test('the summary groups thousands when given the page’s formatter', () => {
  const fmt = (v) => v.toLocaleString('en-US');
  assert.equal(
    summaryText({ agents: 120, of: 2000, open: 1500, disputed: 12, settled: 40 }, fmt),
    'Network graph: the 120 most active of 2,000 agents, 1,500 open agreements, 12 disputed, 40 recently settled.',
  );
});
