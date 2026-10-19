// The network graph, the agent panel's detail view behind its "Network
// graph" switch: the relationships between the most active agents. It is
// fetched only when the switch is first turned on (with d3-force), so the
// first screen never pays for it.
//
// The GRAPH_MAX_NODES most active agents are points — activity is the
// agreements an agent has completed as provider plus the lines drawn to it
// now — sized by that activity; every agreement between two of them is a
// line: open ones in the active colour, disputed ones heavier in the dispute
// colour, recently settled ones dashed in the settled colour. Agents that
// trade with each other are pulled into their own cluster. Nothing is written
// on the plate: an agent's name and address show on hover or tap, and where
// more than BUNDLE_CAP lines of one kind join two agents, the count is in the
// list beside the plate, never floating over the lines.
//
// Data: the same /v1/agents and /v1/escrows reads as the agent field (shared,
// not repeated), and the most recent escrow.DeliveryConfirmed events from the
// finalized-block index for the settled lines.
//
// Motion: the force layout settles once when the graph first appears, as a
// bounded run (d3-force stops itself as alpha decays), and is reheated gently
// when points or lines join or leave. A new line draws itself in over 400 ms,
// a line whose status became disputed pulses once, a line that has gone fades
// out over 400 ms. Nothing loops; under prefers-reduced-motion every layout is
// computed synchronously to rest and drawn once.

import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force';

// The same intervals and page caps as the agent field (agent-field.js), so
// the reads are shared, not repeated. They are restated here rather than
// imported: an import would pull the agent field into a chunk of its own and
// cost the first screen a second script. A test holds the two equal.
export const AGENT_PAGES = 10;
export const ESCROW_PAGES = 5;
const AGENTS_INTERVAL_MS = 60_000;
const ESCROWS_INTERVAL_MS = 30_000;
const SETTLED_INTERVAL_MS = 60_000;
const SETTLED_PAGES = 2; // the most recent two pages of settled agreements

/** The graph shows this many of the most active agents, never more. */
export const GRAPH_MAX_NODES = 120;
const CLUSTER_PULL = 0.08; // how strongly a point is drawn to its cluster's place

/** Above this many points (of the graph's 120 at most) the points shrink; labels are never drawn on the plate (they show on hover or tap). */
export const LABEL_MAX_NODES = 60;
/** Above this many points, the ones with no line are faded back. */
export const FADE_ISOLATED_ABOVE = 60;
export const ISOLATED_ALPHA = 0.35;
/** A plate label never runs longer than this; the full name lives in the tooltip and the list. */
export const LABEL_MAX_CHARS = 18;

const HIT_RADIUS = 14; // px around a point that counts as pointing at it
/** Beyond this many lines of one state between the same two agents, the rest is a count. */
export const BUNDLE_CAP = 6;
const STATE_ORDER = { disputed: 0, open: 1, settled: 2 };
const MAX_SYNC_TICKS = 600; // a synchronous layout (reduced motion) never runs longer than this
const REHEAT_ALPHA = 0.3;
const LINK_DISTANCE = 70;
const CHARGE = -90;
const DRAW_IN_MS = 400;
const PULSE_MS = 600;
const FADE_MS = 400;
const FIRST_LAYOUT_GRACE_MS = 1_500; // how long the first layout waits for the line sources
const CROWDED_LINE_ALPHA = 0.55; // settled lines step back only when the plate is crowded

// ── pure model ───────────────────────────────────────────────────────────────

/** An agreement's identity on chain: buyer, provider and their running number. */
export const edgeKey = (buyer, provider, seq) => `${buyer}/${provider}/${seq}`;

/** Both directions between two accounts share one bundle of lines. */
export const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Created and Delivered are both "open — payment held"; Disputed is its own state. */
export const stateOf = (status) => (status === 'Disputed' ? 'disputed' : 'open');

/**
 * The lines to draw: every open agreement, then every settled one that is
 * not still open under the same key (deduplicated — the index can carry one
 * DeliveryConfirmed per agreement, but never trust that). Insertion order is
 * kept so the drawing order is stable.
 */
export function buildEdges(open, settled) {
  const edges = new Map();
  for (const a of open) {
    const key = edgeKey(a.buyer, a.provider, a.seq);
    edges.set(key, {
      key,
      buyer: a.buyer,
      provider: a.provider,
      seq: a.seq,
      state: stateOf(a.status),
      amountPlancks: a.amountPlancks,
      block: a.createdAtBlock,
    });
  }
  let settledShown = 0;
  for (const s of settled) {
    const key = edgeKey(s.buyer, s.provider, s.seq);
    if (edges.has(key)) continue;
    edges.set(key, {
      key,
      buyer: s.buyer,
      provider: s.provider,
      seq: s.seq,
      state: 'settled',
      amountPlancks: s.amountPlancks,
      block: s.blockNumber,
    });
    settledShown += 1;
  }
  return { edges, settledShown };
}

/**
 * What changed between two edge maps: lines to draw in, lines to fade out,
 * and lines whose status just became a dispute.
 */
export function diffEdges(previous, next) {
  const added = [];
  const removed = [];
  const disputed = [];
  for (const [key, edge] of next) {
    const before = previous.get(key);
    if (!before) added.push(edge);
    else if (before.state !== 'disputed' && edge.state === 'disputed') disputed.push(edge);
  }
  for (const [key, edge] of previous) {
    if (!next.has(key)) removed.push(edge);
  }
  return { added, removed, disputed };
}

/**
 * The points: one per registered agent, plus a hollow one for any party to a
 * line that the agent list does not contain. When the list is known to be
 * whole, such a party has left; when the list was cut short, it may simply
 * be beyond the cut, and the point says that instead.
 */
export function synthesizeNodes(agents, edges, { listComplete = true } = {}) {
  const nodes = new Map();
  for (const agent of agents) {
    nodes.set(agent.address, { id: agent.address, ...agent, ghost: false, degree: 0 });
  }
  const absent = listComplete ? 'no longer registered' : 'not among the agents listed — the list was cut short';
  for (const edge of edges.values()) {
    for (const address of [edge.buyer, edge.provider]) {
      if (!nodes.has(address)) nodes.set(address, { id: address, address, ghost: true, reason: absent, degree: 0 });
    }
  }
  for (const edge of edges.values()) {
    nodes.get(edge.buyer).degree += 1;
    nodes.get(edge.provider).degree += 1;
  }
  return nodes;
}

/**
 * How many lines touch one account, counted from the line map: all of them,
 * only the open ones (open or disputed), or only the ones actually drawn
 * (a bundle beyond its cap hides the rest behind a count).
 */
export function linesAt(edges, id, { open = false, drawnOnly = false } = {}) {
  let n = 0;
  for (const edge of edges.values()) {
    if (edge.buyer !== id && edge.provider !== id) continue;
    if (open && edge.state === 'settled') continue;
    if (drawnOnly && edge.hidden) continue;
    n += 1;
  }
  return n;
}

/**
 * Point radius by the square root of activity: area is proportional to the
 * agreements an agent has taken part in, which is how the eye reads "twice
 * as busy". Range 3–12 px, times the crowding factor; an agent with no
 * activity at all is the smallest point, never invisible.
 */
export function nodeRadius(activity, maxActivity, factor = 1) {
  const share = maxActivity > 0 ? Math.sqrt(Math.max(0, activity) / maxActivity) : 1;
  return (3 + 9 * Math.min(1, share)) * factor;
}

/** An agent's activity: the agreements it has completed as provider, plus the lines drawn to it now. */
export function activityOf(agent, degree = 0) {
  const completed = Number(agent?.completedAgreements);
  const lines = Number(degree);
  return (Number.isFinite(completed) ? completed : 0) + (Number.isFinite(lines) ? Math.max(0, lines) : 0);
}

/** Smaller than any registered agent's point (which starts at 3 px). */
export const GHOST_RADIUS = 2.5;

/**
 * How much to shrink the points and how far to fade lone ones. `labels` is
 * always false: address labels are not drawn on the plate; they show on
 * hover or tap and in the list. (Kept in the policy so a plate that wants
 * them back changes one line.)
 */
export function labelPolicy(nodeCount) {
  const labels = false;
  const radiusFactor = nodeCount <= LABEL_MAX_NODES ? 1 : 0.6;
  const isolatedAlpha = nodeCount > FADE_ISOLATED_ABOVE ? ISOLATED_ALPHA : 1;
  return { labels, radiusFactor, isolatedAlpha };
}

/**
 * The text beside a point: the agent's own name when it gave one, cut to
 * LABEL_MAX_CHARS with an ellipsis so a long name cannot sweep across its
 * neighbours; otherwise the short address.
 */
export function labelText(name, address, max = LABEL_MAX_CHARS) {
  if (name) return name.length > max ? `${name.slice(0, max - 1)}…` : name;
  const s = String(address);
  return s.length <= 12 ? s : `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/** Axis-aligned rectangles {x, y, w, h}: do they overlap? */
export function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Does a rectangle touch a circle? (Closest-point test.) */
export function rectTouchesCircle(rect, cx, cy, r) {
  const nx = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const ny = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  return (nx - cx) ** 2 + (ny - cy) ** 2 < r * r;
}

/**
 * Several agreements between the same two agents are drawn as a bundle of
 * arcs; this is the sideways offset of the i-th of n, symmetric about the
 * straight line, in px.
 */
export const BUNDLE_SPACING = 7; // px between lines of a small bundle
export const BUNDLE_MAX_BAND = 36; // px the whole bundle may span before lines close up
export const BUNDLE_MIN_SPACING = 2; // px; closer than this they read as one band anyway
export function parallelOffset(index, count) {
  if (count <= 1) return 0;
  const spacing = Math.max(BUNDLE_MIN_SPACING, Math.min(BUNDLE_SPACING, BUNDLE_MAX_BAND / (count - 1)));
  return (index - (count - 1) / 2) * spacing;
}

/**
 * The lines between one pair of agents: which are drawn, in what order, and
 * what the count labels say for the ones beyond the cap. Disputed lines come
 * first so they are never the ones hidden; within a state, the oldest first.
 */
export function bundleLayout(lines, cap = BUNDLE_CAP) {
  const byState = new Map();
  for (const line of lines) {
    if (!byState.has(line.state)) byState.set(line.state, []);
    byState.get(line.state).push(line);
  }
  const drawn = [];
  const hidden = [];
  const labels = [];
  for (const state of Object.keys(STATE_ORDER)) {
    const group = (byState.get(state) ?? []).sort((a, b) => a.block - b.block);
    drawn.push(...group.slice(0, cap));
    const rest = group.slice(cap);
    hidden.push(...rest);
    if (rest.length) labels.push({ state, count: group.length, text: `×${group.length} ${state}` });
  }
  return { drawn, hidden, labels };
}

/** Force tuning for the plate's size: a phone's plate needs shorter, gentler forces. */
export function forceScale(width, height) {
  return Math.max(0.4, Math.min(1, Math.min(width, height) / 560));
}

/**
 * The agents the graph shows: the `max` most active by activityOf (completed
 * agreements as provider plus the lines to them now), ties broken by address
 * so the choice is stable; and only the lines between two of them. Pure; tested.
 */
export function topAgents(agents, edges, max = GRAPH_MAX_NODES) {
  const degree = new Map();
  for (const edge of edges.values()) {
    degree.set(edge.buyer, (degree.get(edge.buyer) ?? 0) + 1);
    degree.set(edge.provider, (degree.get(edge.provider) ?? 0) + 1);
  }
  const ranked = [...agents].sort(
    (a, b) => activityOf(b, degree.get(b.address) ?? 0) - activityOf(a, degree.get(a.address) ?? 0) || (a.address < b.address ? -1 : 1),
  );
  const top = ranked.slice(0, max);
  const keep = new Set(top.map((a) => a.address));
  const lines = new Map([...edges].filter(([, e]) => keep.has(e.buyer) && keep.has(e.provider)));
  return { agents: top, edges: lines, of: agents.length };
}

/**
 * Clusters: the connected groups of points, largest first, as a map from
 * point to group index. Points with no line share the last group. Pure; tested.
 */
export function clusters(ids, edges) {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id) => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    parent.set(id, root);
    return root;
  };
  for (const edge of edges.values()) {
    if (!parent.has(edge.buyer) || !parent.has(edge.provider)) continue;
    const a = find(edge.buyer);
    const b = find(edge.provider);
    if (a !== b) parent.set(a, b);
  }
  const groups = new Map();
  for (const id of ids) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(id);
  }
  const linked = [...groups.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1));
  const alone = [...groups.values()].filter((g) => g.length === 1).flat();
  const index = new Map();
  linked.forEach((group, i) => group.forEach((id) => index.set(id, i)));
  for (const id of alone) index.set(id, linked.length);
  return { index, count: linked.length + (alone.length ? 1 : 0), alone: alone.length > 0 };
}

/**
 * Where each cluster sits on the plate: the largest in the middle, the rest
 * around it on a ring, and the points with no line on an outer ring. Pure; tested.
 */
export function clusterAnchors(count, width, height, { alone = false } = {}) {
  const cx = width / 2;
  const cy = height / 2;
  const anchors = [];
  const linked = alone ? count - 1 : count;
  const r = Math.min(width, height) * 0.3;
  for (let i = 0; i < linked; i += 1) {
    if (i === 0) anchors.push({ x: cx, y: cy });
    else {
      const a = ((i - 1) / Math.max(1, linked - 1)) * Math.PI * 2 - Math.PI / 2;
      anchors.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r * 0.8 });
    }
  }
  if (alone) anchors.push({ x: cx, y: cy, ring: Math.min(width, height) * 0.36 });
  return anchors;
}

/**
 * The one-sentence summary the canvas carries for screen readers. A count
 * that cannot be given is said so: `null` is a source that could not be read,
 * `undefined` one not read yet. The agent count is a floor when the list was
 * cut short.
 */
export function summaryText({ agents, of = agents, agentsFloor = false, open, disputed, settled }, fmt = String) {
  const n = (v, one, many) => `${fmt(v)} ${v === 1 ? one : many}`;
  const parts = [
    of > agents
      ? `the ${fmt(agents)} most active of ${agentsFloor ? 'at least ' : ''}${n(of, 'agent', 'agents')}`
      : `${agentsFloor ? 'at least ' : ''}${n(agents, 'agent', 'agents')}`,
  ];
  if (open === null) parts.push('open agreements unavailable');
  else if (open === undefined) parts.push('open agreements not yet read');
  else parts.push(n(open, 'open agreement', 'open agreements'), `${fmt(disputed)} disputed`);
  if (settled === null) parts.push('recently settled agreements unavailable');
  else if (settled === undefined) parts.push('recently settled agreements not yet read');
  else parts.push(`${fmt(settled)} recently settled`);
  return `Network graph: ${parts.join(', ')}.`;
}

/** A deterministic angle from an address, so a new point lands in a stable place. */
export function seedAngle(address) {
  let h = 0;
  for (let i = 0; i < address.length; i += 1) h = (h * 31 + address.charCodeAt(i)) >>> 0;
  return (h % 3600) / 3600 * Math.PI * 2;
}

// ── the instrument ───────────────────────────────────────────────────────────

export function init(root, ctx) {
  const canvas = root.querySelector('.constellation-canvas');
  const tip = root.querySelector('.constellation-tip');
  const bundles = root.querySelector('.graph-bundles');
  const note = root.querySelector('.graph-note');
  const { formatCmn, formatInteger, shortAddress } = ctx.format;
  const colour = (name) => ctx.theme.color(name);

  // ── source state ──
  let agentsList = null; // plain agent rows, or null while unread / unreadable
  let agentsShownOf = 0; // how many agents the most active were chosen from
  let agentsComplete = true;
  let agentsTruncated = false;
  let openList = null;
  let settledList = null;
  const failures = { agents: null, open: null, settled: null };
  const seen = { open: false, settled: false }; // a line source has reported at least once

  // ── graph state ──
  const nodes = new Map(); // address -> point (persistent objects: d3 mutates x/y)
  const edges = new Map(); // key -> line (persistent objects)
  let fading = []; // lines on their way out
  let settledShown = 0;
  let maxActivity = 0;
  let laidOut = false; // the first layout has run
  let graceTimer = null; // the first layout's wait for the line sources
  let graceElapsed = false;
  let hovered = null;
  let lastPointerType = 'mouse';
  let tapped = null;
  let bundleLabels = []; // { a, b, text } for capped bundles: listed beside the plate
  let anchors = []; // where each cluster sits

  const box = ctx.fitCanvas(canvas, onResize);

  const simulation = forceSimulation([])
    .force('link', forceLink([]).distance(LINK_DISTANCE))
    .force('charge', forceManyBody().strength(CHARGE))
    .force('center', forceCenter(0, 0))
    .force('collide', forceCollide((d) => d.r + 4))
    .force('x', forceX(0).strength(CLUSTER_PULL))
    .force('y', forceY(0).strength(CLUSTER_PULL))
    .stop();
  simulation.on('tick', () => {
    clampToPlate();
    draw();
  });
  aimForces();

  /** The whole canvas: nothing is drawn along its foot. */
  function plate() {
    const { width, height } = box();
    return { width, height: Math.max(1, height) };
  }

  /** A point's cluster place; a point with no line sits on the outer ring, at its own angle. */
  function anchorOf(node) {
    const a = anchors[node.cluster ?? 0] ?? { x: plate().width / 2, y: plate().height / 2 };
    if (!a.ring) return a;
    const angle = seedAngle(node.id);
    return { x: a.x + Math.cos(angle) * a.ring, y: a.y + Math.sin(angle) * a.ring * 0.8 };
  }

  function aimForces() {
    const { width, height } = plate();
    const s = forceScale(width, height);
    simulation.force('center').x(width / 2).y(height / 2).strength(0.05);
    simulation.force('x').x((d) => anchorOf(d).x).strength(CLUSTER_PULL / s);
    simulation.force('y').y((d) => anchorOf(d).y).strength(CLUSTER_PULL / s);
    simulation.force('link').distance(LINK_DISTANCE * s);
    simulation.force('charge').strength(CHARGE * s);
    simulation.force('collide').radius((d) => d.r + 4 * s);
  }

  function clampToPlate() {
    const { width, height } = plate();
    for (const node of nodes.values()) {
      const m = node.r + 6;
      node.x = Math.max(m, Math.min(width - m, node.x));
      node.y = Math.max(m, Math.min(height - m, node.y));
    }
  }

  function onResize(next) {
    // A resize is not a data change: positions scale with the plate, nothing reheats.
    const prev = lastBox;
    lastBox = next;
    if (prev && prev.width > 0 && prev.height > 0) {
      for (const node of nodes.values()) {
        node.x = (node.x / prev.width) * next.width;
        node.y = (node.y / prev.height) * next.height;
      }
    }
    const groupsNow = clusters([...nodes.keys()], edges);
    anchors = clusterAnchors(groupsNow.count, plate().width, plate().height, { alone: groupsNow.alone });
    aimForces();
    if (laidOut) computeRadii();
    draw();
  }
  let lastBox = box();

  // ── model ──
  function policy() {
    return labelPolicy(nodes.size);
  }

  function computeRadii() {
    const { radiusFactor } = policy();
    for (const node of nodes.values()) {
      node.r = node.ghost ? GHOST_RADIUS * radiusFactor : nodeRadius(node.activity, maxActivity, radiusFactor);
    }
  }

  function placeNew(node) {
    const { width, height } = plate();
    const neighbour = [...edges.values()]
      .map((e) => (e.buyer === node.id ? nodes.get(e.provider) : e.provider === node.id ? nodes.get(e.buyer) : null))
      .find((n) => n && Number.isFinite(n.x));
    const angle = seedAngle(node.id);
    if (neighbour) {
      node.x = neighbour.x + Math.cos(angle) * 24;
      node.y = neighbour.y + Math.sin(angle) * 24;
    } else {
      const spread = Math.min(width, height) * 0.3;
      node.x = width / 2 + Math.cos(angle) * spread * (0.3 + 0.7 * ((node.id.length * 7 + node.id.charCodeAt(0)) % 10) / 10);
      node.y = height / 2 + Math.sin(angle) * spread * (0.3 + 0.7 * ((node.id.length * 3 + node.id.charCodeAt(1)) % 10) / 10);
    }
  }

  const listComplete = () => agentsComplete && !agentsTruncated;
  const linesReported = () => (openList !== null || Boolean(failures.open)) && (settledList !== null || Boolean(failures.settled));

  function rebuild() {
    // Nothing is built on the strength of an unread agent list: until it
    // arrives, no party can be called "no longer registered".
    if (agentsList === null && !failures.agents) {
      describe();
      renderList();
      renderNote();
      draw();
      return;
    }
    const open = failures.open ? [] : openList ?? [];
    const settled = failures.settled ? [] : settledList ?? [];
    const all = failures.agents ? { edges: new Map(), settledShown: 0 } : buildEdges(open, settled);
    // Only the most active agents, and only the lines between two of them.
    const chosen = topAgents(failures.agents ? [] : agentsList, all.edges, GRAPH_MAX_NODES);
    const built = { edges: chosen.edges };
    agentsShownOf = chosen.of;
    settledShown = [...built.edges.values()].filter((e) => e.state === 'settled').length;
    const nextNodes = synthesizeNodes(chosen.agents, built.edges, { listComplete: listComplete() });
    const groups = clusters([...nextNodes.keys()], built.edges);
    for (const [id, node] of nextNodes) node.cluster = groups.index.get(id) ?? 0;
    anchors = clusterAnchors(groups.count, plate().width, plate().height, { alone: groups.alone });

    // Points: keep the objects d3 already positions; add and drop the rest.
    let nodesAdded = 0;
    let nodesRemoved = 0;
    for (const [id, data] of nextNodes) {
      const existing = nodes.get(id);
      if (existing) Object.assign(existing, data);
      else {
        nodes.set(id, { ...data, x: NaN, y: NaN, vx: 0, vy: 0, r: 3 });
        nodesAdded += 1;
      }
    }
    for (const id of [...nodes.keys()]) {
      if (!nextNodes.has(id)) {
        nodes.delete(id);
        nodesRemoved += 1;
      }
    }
    maxActivity = 0;
    // `degree` was counted by synthesizeNodes from the line map just built,
    // so the sizes and the lines drawn come from the same poll.
    for (const node of nodes.values()) {
      if (node.ghost) continue;
      node.activity = activityOf(node, node.degree);
      if (node.activity > maxActivity) maxActivity = node.activity;
    }
    computeRadii();
    aimForces(); // the key strip's height and the collide radii follow the data
    for (const node of nodes.values()) if (!Number.isFinite(node.x)) placeNew(node);

    // Lines: diff, keep persisting objects, animate the changes. A line from
    // a source reporting for the first time is drawn whole, not drawn in.
    const firstLines = (openList !== null && !seen.open) || (settledList !== null && !seen.settled);
    const diff = diffEdges(edges, built.edges);
    for (const [key, data] of built.edges) {
      const existing = edges.get(key);
      if (existing) Object.assign(existing, data, { source: nodes.get(data.buyer), target: nodes.get(data.provider) });
      else {
        const fresh = seen[data.state === 'settled' ? 'settled' : 'open'] && laidOut;
        edges.set(key, {
          ...data,
          source: nodes.get(data.buyer),
          target: nodes.get(data.provider),
          progress: fresh ? 0 : 1,
          alpha: 1,
          pulse: 0,
        });
      }
    }
    const leaving = [];
    for (const key of [...edges.keys()]) {
      if (!built.edges.has(key)) {
        leaving.push(edges.get(key));
        edges.delete(key);
      }
    }
    seen.open = seen.open || openList !== null;
    seen.settled = seen.settled || settledList !== null;
    assignBundles();

    simulation.nodes([...nodes.values()]);
    simulation.force('link').links([...edges.values()]);

    // Layout. The first one waits for the line sources (or a short grace),
    // so points are placed with their lines; a line source arriving late
    // re-settles fully; later joins and departures reheat gently.
    const structural = nodesAdded > 0 || nodesRemoved > 0 || diff.added.length > 0 || diff.removed.length > 0;
    if (!laidOut) {
      if (nodes.size > 0 && (linesReported() || graceElapsed)) {
        clearGrace();
        laidOut = true;
        settle(1);
      } else if (nodes.size > 0 && !graceTimer) {
        graceTimer = setTimeout(() => {
          graceTimer = null;
          graceElapsed = true;
          rebuild();
        }, FIRST_LAYOUT_GRACE_MS);
      }
    } else if (structural) {
      settle(firstLines ? 1 : REHEAT_ALPHA);
    }

    const arriving = [...edges.values()].filter((e) => e.progress === 0);
    if (arriving.length) {
      ctx.motion.tween(DRAW_IN_MS, (t) => {
        for (const e of arriving) e.progress = t;
        draw();
      });
    }
    const pulsing = diff.disputed.map((d) => edges.get(d.key)).filter(Boolean);
    if (pulsing.length) {
      ctx.motion.tween(PULSE_MS, (t) => {
        for (const e of pulsing) e.pulse = 1 - t;
        draw();
      });
    }
    if (leaving.length) {
      fading = fading.concat(leaving);
      ctx.motion.tween(FADE_MS, (t) => {
        for (const e of leaving) e.alpha = 1 - t;
        draw();
      }, { done: () => { fading = fading.filter((e) => !leaving.includes(e)); draw(); } });
    }

    // The pointed-at agent: gone with the data, or refreshed with it.
    if (hovered && !nodes.has(hovered.id)) setHovered(null);
    else if (hovered) showTip(hovered);

    if (!arriving.length && !pulsing.length && !leaving.length) draw();

    describe();
    renderList();
    renderNote();
  }

  function clearGrace() {
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = null;
  }

  /** Orders the lines of each pair so parallel agreements fan out as arcs. */
  function assignBundles() {
    const groups = new Map();
    for (const edge of edges.values()) {
      const k = pairKey(edge.buyer, edge.provider);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(edge);
    }
    bundleLabels = [];
    for (const group of groups.values()) {
      const { drawn, hidden, labels } = bundleLayout(group);
      const sign = (edge) => (edge.buyer < edge.provider ? 1 : -1); // arcs bend the same way whichever account buys
      drawn.forEach((edge, i) => {
        edge.hidden = false;
        edge.offset = parallelOffset(i, drawn.length) * sign(edge);
      });
      for (const edge of hidden) {
        edge.hidden = true;
        edge.offset = 0;
      }
      if (labels.length) {
        const first = drawn[0];
        bundleLabels.push({
          a: nodes.get(first.buyer < first.provider ? first.buyer : first.provider),
          b: nodes.get(first.buyer < first.provider ? first.provider : first.buyer),
          total: group.length,
          text: labels.map((l) => l.text).join(' · '),
        });
      }
    }
  }

  /**
   * Runs the layout from `alpha`: its own bounded timer (d3 stops it when
   * alpha decays past alphaMin), or synchronously to rest under reduced
   * motion or in a hidden tab, so nothing is left to animate later.
   */
  function settle(alpha) {
    simulation.alpha(Math.max(alpha, simulation.alpha()));
    if (ctx.motion.reduced() || document.hidden) {
      simulation.stop();
      let ticks = 0;
      while (simulation.alpha() > simulation.alphaMin() && ticks < MAX_SYNC_TICKS) {
        simulation.tick();
        ticks += 1;
      }
      simulation.alpha(0);
      clampToPlate();
      draw();
      return;
    }
    simulation.restart();
  }

  ctx.bus.on('visibility', ({ hidden }) => {
    if (hidden) simulation.stop();
    else if (simulation.alpha() > simulation.alphaMin()) settle(simulation.alpha());
  });
  ctx.bus.on('theme', () => draw());

  // ── drawing ──
  function edgeColour(edge) {
    return colour(edge.state === 'disputed' ? 'disputed' : edge.state === 'settled' ? 'settled' : 'active');
  }

  function edgePath(g, edge, progress) {
    const { source: a, target: b, offset = 0 } = edge;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    // A quadratic curve passes at half its control offset, so double it.
    const cx = (a.x + b.x) / 2 + nx * offset * 2;
    const cy = (a.y + b.y) / 2 + ny * offset * 2;
    g.beginPath();
    g.moveTo(a.x, a.y);
    if (progress >= 1) {
      g.quadraticCurveTo(cx, cy, b.x, b.y);
      return;
    }
    // De Casteljau: the sub-curve from the buyer up to `progress`.
    const t = progress;
    const c1x = a.x + (cx - a.x) * t;
    const c1y = a.y + (cy - a.y) * t;
    const m2x = cx + (b.x - cx) * t;
    const m2y = cy + (b.y - cy) * t;
    const px = c1x + (m2x - c1x) * t;
    const py = c1y + (m2y - c1y) * t;
    g.quadraticCurveTo(c1x, c1y, px, py);
  }

  function drawEdge(g, edge, isolatedAlpha, crowded) {
    if (!edge.source || !edge.target || edge.hidden) return;
    const state = edge.state;
    g.strokeStyle = edgeColour(edge);
    let alpha = edge.alpha;
    let width = 1;
    if (state === 'settled') {
      // Full colour: the hierarchy settled < open < disputed is carried by
      // the dash, the width and the colour; the plate steps settled lines
      // back only when it is crowded.
      g.setLineDash([4, 3]);
      if (crowded) alpha *= CROWDED_LINE_ALPHA;
    } else if (state === 'disputed') {
      g.setLineDash([]);
      width = 2 + 3 * edge.pulse;
    } else {
      g.setLineDash([]);
      alpha *= 0.9;
    }
    if (isolatedAlpha < 1 && (edge.source.degree <= 1 || edge.target.degree <= 1)) alpha *= 0.7;
    g.globalAlpha = Math.max(0, alpha);
    g.lineWidth = width;
    edgePath(g, edge, edge.progress);
    g.stroke();
    if (state === 'disputed' && edge.pulse > 0) {
      g.globalAlpha = 0.35 * edge.pulse;
      g.lineWidth = width + 6 * edge.pulse;
      g.stroke();
    }
    g.setLineDash([]);
    g.globalAlpha = 1;
  }

  /** Text knocked out of the lines beneath it: a plate-coloured stroke, then the fill. */
  function knockout(g, text, x, y) {
    g.strokeStyle = colour('bg');
    g.lineWidth = 3;
    g.lineJoin = 'round';
    g.strokeText(text, x, y);
    g.fillText(text, x, y);
  }

  function drawEmpty(g, width, height, lines) {
    const font = ctx.theme.font('sans');
    g.font = `400 14px ${font}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = colour('text-dim');
    lines.forEach((line, i) => g.fillText(line, width / 2, height / 2 + (i - (lines.length - 1) / 2) * 16));
  }

  /** Every point except `except`: does the rectangle sit on one of them? */
  function rectOnAnyNode(rect, except) {
    for (const node of nodes.values()) {
      if (node !== except && rectTouchesCircle(rect, node.x, node.y, node.r + 1)) return true;
    }
    return false;
  }

  function draw() {
    const { context: g, width, height } = box();
    const area = plate();
    g.clearRect(0, 0, width, height);

    if (failures.agents) {
      drawEmpty(g, width, height, ['agents unavailable', failures.agents]);
      return;
    }
    if (!laidOut) {
      drawEmpty(g, width, height, [
        agentsList === null ? 'reading the agent list…' : nodes.size === 0 ? 'no agents registered' : 'reading the agreements…',
      ]);
      return;
    }

    const { labels, isolatedAlpha } = policy();
    const crowded = nodes.size > LABEL_MAX_NODES;
    const font = ctx.theme.font('sans');

    // Lines, back to front: gone, settled, open, disputed.
    for (const edge of fading) drawEdge(g, edge, isolatedAlpha, crowded);
    for (const state of ['settled', 'open', 'disputed']) {
      for (const edge of edges.values()) if (edge.state === state) drawEdge(g, edge, isolatedAlpha, crowded);
    }

    // Points.
    for (const node of nodes.values()) {
      const lone = node.degree === 0;
      g.globalAlpha = lone ? isolatedAlpha : 1;
      g.beginPath();
      g.arc(node.x, node.y, node.r, 0, Math.PI * 2);
      if (node.ghost) {
        g.strokeStyle = colour('text-dim');
        g.lineWidth = 1;
        g.stroke();
      } else {
        g.fillStyle = colour('text');
        if (node.leaving) g.globalAlpha *= 0.5;
        g.fill();
        g.strokeStyle = colour('bg');
        g.lineWidth = 1;
        g.stroke();
      }
      g.globalAlpha = 1;
    }

    // Nothing is written over the lines: bundle counts are in the list
    // beside the plate, and point labels yield to every point and label.
    const placed = [];

    // Point labels: the busiest and largest first; one that would sit on
    // another label or another point is left off (the point is still
    // reachable by pointer and in the list).
    if (labels) {
      g.font = `400 12px ${font}`;
      const ordered = [...nodes.values()].filter((n) => !n.ghost).sort((a, b) => b.degree - a.degree || b.r - a.r);
      for (const node of ordered) {
        const text = labelText(node.name, node.id);
        const w = g.measureText(text).width;
        // To the right of the point, or to its left when the right is taken.
        const sides = [
          { align: 'left', rect: { x: node.x + node.r + 4, y: node.y - 6, w, h: 12 } },
          { align: 'right', rect: { x: node.x - node.r - 4 - w, y: node.y - 6, w, h: 12 } },
        ];
        const side = sides.find(
          ({ rect }) =>
            rect.x >= 0 && rect.x + w <= area.width && !placed.some((p) => overlaps(rect, p)) && !rectOnAnyNode(rect, node),
        );
        if (!side) continue;
        placed.push(side.rect);
        g.textAlign = side.align;
        knockout(g, text, side.align === 'left' ? side.rect.x : side.rect.x + w, node.y);
      }
    }

    // The pointed-at agent: a hairline ring in the text colour (an
    // interaction state, not a live reading).
    if (hovered && nodes.has(hovered.id)) {
      g.strokeStyle = colour('text');
      g.lineWidth = 1;
      g.beginPath();
      g.arc(hovered.x, hovered.y, hovered.r + 4, 0, Math.PI * 2);
      g.stroke();
      positionTip();
    }
  }

  // ── accessibility, list, note ──
  function counts() {
    let open = 0;
    let disputed = 0;
    for (const edge of edges.values()) {
      if (edge.state === 'settled') continue;
      open += 1;
      if (edge.state === 'disputed') disputed += 1;
    }
    return {
      agents: [...nodes.values()].filter((n) => !n.ghost).length,
      of: agentsShownOf,
      agentsFloor: !listComplete(),
      open: failures.open ? null : openList === null ? undefined : open,
      disputed,
      settled: failures.settled ? null : settledList === null ? undefined : settledShown,
    };
  }

  function describe() {
    let label;
    if (failures.agents) label = `Network graph: agents unavailable — ${failures.agents}.`;
    else if (agentsList === null) label = 'Network graph: reading the agent list.';
    else label = summaryText(counts(), formatInteger);
    canvas.setAttribute('aria-label', label);
  }


  /** "9 open here" from the open-agreement list, or why it cannot be said. */
  function openHereText(id) {
    if (failures.open) return 'open lines unavailable';
    if (openList === null) return 'open lines not yet read';
    const n = linesAt(edges, id, { open: true });
    return `${formatInteger(n)} open here`;
  }

  /** The chain's own per-agent counters, which count the agent as provider only. */
  const providerText = (agent) =>
    `as provider: ${formatInteger(agent.activeEscrowCount)} open · ${formatInteger(agent.completedAgreements)} completed`;

  /** The counts that used to float over the lines: one row per pair with more than BUNDLE_CAP lines of a kind. */
  function renderList() {
    if (!bundles) return;
    bundles.replaceChildren();
    const rows = bundleLabels
      .filter(({ a, b }) => a && b)
      .sort((x, y) => y.total - x.total);
    bundles.hidden = rows.length === 0;
    for (const { a, b, text } of rows) {
      const li = document.createElement('li');
      const who = (n) => (n.name ? labelText(n.name, n.id) : shortAddress(n.id));
      const pair = document.createElement('span');
      pair.className = 'graph-pair';
      pair.textContent = `${who(a)} ↔ ${who(b)}`;
      const count = document.createElement('span');
      count.className = 'graph-count';
      count.textContent = text;
      li.append(pair, count);
      bundles.append(li);
    }
  }

  /** The graph's one footnote line: what is drawn, and anything that could not be read. */
  function renderNote() {
    if (!note) return;
    const parts = [];
    if (agentsList !== null && !failures.agents) {
      const shown = [...nodes.values()].filter((n) => !n.ghost).length;
      parts.push(
        agentsShownOf > shown
          ? `The ${formatInteger(shown)} most active of ${formatInteger(agentsShownOf)} agents, sized by activity`
          : `All ${formatInteger(shown)} agents, sized by activity`,
      );
      parts.push(
        settledShown === 1
          ? 'the dashed line is the most recently settled agreement'
          : `dashed lines are the ${formatInteger(settledShown)} most recently settled agreements`,
      );
      if (bundleLabels.length) parts.push(`more than ${BUNDLE_CAP} lines of a kind between two agents are counted in the list`);
    }
    if (failures.agents) parts.push(`agents could not be read: ${failures.agents}`);
    if (failures.open) parts.push(`open agreements could not be read: ${failures.open}`);
    if (failures.settled) parts.push(`settled agreements could not be read: ${failures.settled}`);
    if (!listComplete()) parts.push('the agent list was cut short at the indexer’s scan cap');
    note.textContent = parts.length ? `${parts.join(' · ')}.` : 'Reading the agent list…';
  }

  // ── pointer ──
  function pointerToPlate(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function tipText(node) {
    const lines = [];
    if (node.ghost) {
      const drawn = linesAt(edges, node.id, { drawnOnly: true });
      lines.push([shortAddress(node.id), true], [node.reason, false], [`${drawn} ${drawn === 1 ? 'line' : 'lines'} drawn`, false]);
    } else {
      lines.push([node.name ? `${node.name} · ${shortAddress(node.id)}` : shortAddress(node.id), true]);
      lines.push([node.id, false]);
      lines.push([`${formatCmn(node.stakePlancks)} CMN staked · activity ${formatInteger(node.activity ?? 0)}`, false]);
      lines.push([openHereText(node.id), false]);
      lines.push([providerText(node), false]);
      if (node.leaving) lines.push(['leaving — unstake requested', false]);
      lines.push([lastPointerType === 'touch' ? 'tap again to open in the explorer' : 'click to open in the explorer', false]);
    }
    return lines;
  }

  function showTip(node) {
    if (!tip) return;
    tip.replaceChildren();
    for (const [text, strong] of tipText(node)) {
      const span = document.createElement(strong ? 'strong' : 'span');
      span.textContent = text;
      tip.append(span);
    }
    tip.hidden = false;
    positionTip();
  }

  function positionTip() {
    if (!tip || tip.hidden || !hovered) return;
    const { width, height } = plate();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const right = hovered.x + hovered.r + 10;
    const leftSide = hovered.x - hovered.r - 10 - tw;
    let left;
    let top;
    if (right + tw <= width - 4) {
      left = right;
      top = hovered.y - th / 2;
    } else if (leftSide >= 4) {
      left = leftSide;
      top = hovered.y - th / 2;
    } else {
      // Neither side fits (a phone's plate): below the point, or above it.
      left = hovered.x - tw / 2;
      top = hovered.y + hovered.r + 10;
      if (top + th > height - 4) top = hovered.y - hovered.r - 10 - th;
    }
    left = Math.max(4, Math.min(width - tw - 4, left));
    top = Math.max(4, Math.min(height - th - 4, top));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  function hideTip() {
    if (tip) tip.hidden = true;
  }

  function setHovered(node) {
    if (node === hovered) return;
    hovered = node;
    canvas.style.cursor = node && !node.ghost ? 'pointer' : '';
    if (node) showTip(node);
    else {
      hideTip();
      tapped = null;
    }
    draw();
  }

  canvas.addEventListener('pointerdown', (event) => {
    lastPointerType = event.pointerType || 'mouse';
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!laidOut) return;
    const { x, y } = pointerToPlate(event);
    setHovered(simulation.find(x, y, HIT_RADIUS) ?? null);
  });
  // A touch pointer "leaves" right after every tap, before the click lands;
  // only a mouse or pen leaving the plate clears the pointed-at point.
  canvas.addEventListener('pointerleave', (event) => {
    if (event.pointerType !== 'touch') setHovered(null);
  });
  canvas.addEventListener('click', (event) => {
    if (!laidOut) return;
    const { x, y } = pointerToPlate(event);
    const node = simulation.find(x, y, HIT_RADIUS) ?? null;
    if (!node) {
      setHovered(null);
      return;
    }
    if (lastPointerType === 'touch' && tapped?.id !== node.id) {
      // First tap shows; a second tap on the same point opens.
      tapped = node;
      setHovered(node);
      showTip(node);
      return;
    }
    if (!node.ghost) {
      window.open(`${ctx.EXPLORER_ORIGIN}/activity?agent=${encodeURIComponent(node.id)}`, '_blank', 'noopener');
    }
  });

  // ── data ── (the same reads as the agent field: one fetch serves both)
  ctx.watchAll(
    'agents',
    (record) => {
      if (!record.ok) {
        agentsList = null;
        failures.agents = record.error;
        laidOut = false;
        clearGrace();
        rebuild();
        return;
      }
      try {
        agentsTruncated = ctx.field(record.data, 'truncated');
        agentsList = record.items.map((item) => ({
          address: ctx.field(item, 'address'),
          stakePlancks: ctx.field(item, 'stakePlancks'),
          completedAgreements: ctx.field(item, 'completedAgreements'),
          activeEscrowCount: ctx.field(item, 'activeEscrowCount'),
          // Both are documented as nullable: null is "none", not a missing field.
          name: item.metadata === null ? null : ctx.field(item, 'metadata.name'),
          leaving: item.unstakeAtBlock === null ? false : Number.isFinite(ctx.field(item, 'unstakeAtBlock')),
        }));
        agentsComplete = record.complete;
        failures.agents = null;
      } catch (error) {
        agentsList = null;
        failures.agents = error.message;
        laidOut = false;
        clearGrace();
      }
      rebuild();
    },
    AGENTS_INTERVAL_MS,
    { maxPages: AGENT_PAGES },
  );

  ctx.watchAll(
    'escrows',
    (record) => {
      if (!record.ok) {
        openList = null;
        failures.open = record.error;
        rebuild();
        return;
      }
      try {
        openList = record.items.map((item) => ({
          buyer: ctx.field(item, 'buyer'),
          provider: ctx.field(item, 'provider'),
          seq: ctx.field(item, 'seq'),
          status: ctx.field(item, 'status'),
          amountPlancks: ctx.field(item, 'amountPlancks'),
          createdAtBlock: ctx.field(item, 'createdAtBlock'),
        }));
        failures.open = null;
      } catch (error) {
        openList = null;
        failures.open = error.message;
      }
      rebuild();
    },
    ESCROWS_INTERVAL_MS,
    { maxPages: ESCROW_PAGES },
  );

  ctx.watchAll(
    'deliveriesConfirmed',
    (record) => {
      if (!record.ok) {
        settledList = null;
        failures.settled = record.error;
        rebuild();
        return;
      }
      try {
        settledList = record.items.map((item) => ({
          blockNumber: ctx.field(item, 'blockNumber'),
          buyer: ctx.field(item, 'data.buyer'),
          provider: ctx.field(item, 'data.provider'),
          seq: ctx.field(item, 'data.seq'),
          amountPlancks: ctx.field(item, 'data.amount'),
        }));
        failures.settled = null;
      } catch (error) {
        settledList = null;
        failures.settled = error.message;
      }
      rebuild();
    },
    SETTLED_INTERVAL_MS,
    { maxPages: SETTLED_PAGES },
  );

  describe();
  renderList();
  renderNote();
  draw();
  return { nodes: () => nodes };
}
