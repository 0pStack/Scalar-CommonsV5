// The agent field, the first screen's panel beside the hero's figures: one
// small cell per registered agent on a tidy grid (above BUCKET_THRESHOLD
// agents, one cell per bucket of agents), coloured by what the agent is doing
// now — idle in grey, working (party to an open agreement) in the active
// colour, in dispute in the dispute colour, slashed in the last hour in red.
// Operator-run agents, the ones whose on-chain name carries the `swarm-`
// prefix, carry a thin ring so they are never mistaken for external agents.
// It is a grid of dots on one canvas, not a simulation: drawing 2,000 agents
// is a few hundred arcs, redrawn only when something changes.
//
// Data: /v1/agents (live chain state, read whole up to the indexer's scan
// cap), /v1/escrows (the open agreements: who is working, who is in dispute),
// agents.SlashExecuted events since the block of one hour ago, and
// /v1/escrows/stats for the hero's "Agreements open". The hero's "Agents
// registered" is the agent list's own total; "Operator-run" counts the rows
// whose name starts with `swarm-`, out of the same total.
//
// Motion: on the first read the cells fade in once, in grid order, over a
// second; afterwards a newly registered agent's cell fades in and a cell
// whose state changed blends to its new colour over 400 ms. Nothing loops;
// under prefers-reduced-motion every change is drawn at once.
//
// The "Network graph" switch shows the detail view: the relationship graph of
// the most active agents. Its module (and d3-force) is fetched only when the
// switch is first turned on.

import { countSince } from '../data.js';
import { hourTracker } from '../hour.js';

/**
 * One cell per agent up to this many; above it, one cell per bucket of agents.
 * The public network carries about 200 operator-run agents, so this is
 * headroom: the public field draws one cell per agent.
 */
export const BUCKET_THRESHOLD = 800;
export const OPERATOR_PREFIX = 'swarm-';
/** The hour the slashed cells count over is the event index's newest (hour.js). */
export { BLOCKS_PER_HOUR } from '../hour.js';
export const LIST_PAGE = 50;
/** The network graph's own bundle, served beside observatory.js and fetched on first use. */
export const GRAPH_BUNDLE = 'observatory-graph.js';
/** The four states, least urgent first. */
export const STATES = ['idle', 'working', 'disputed', 'slashed'];
export const STATE_COLOUR = { idle: 'idle', working: 'active', disputed: 'disputed', slashed: 'slash' };
export const STATE_WORD = { idle: 'idle', working: 'working', disputed: 'in dispute', slashed: 'slashed in the last hour' };

const AGENTS_INTERVAL_MS = 60_000;
const ESCROWS_INTERVAL_MS = 30_000;
const SLASHES_INTERVAL_MS = 30_000;
const STATS_INTERVAL_MS = 30_000;
/**
 * 10 × the indexer's page size: up to 2,000 agents. The public network carries
 * about 200 operator-run agents, so this is headroom; the indexer's live scan
 * stops at 512 today.
 */
export const AGENT_PAGES = 10;
export const ESCROW_PAGES = 5;
const MAX_PITCH = 36; // px: a handful of agents is still a tidy block, not a few huge dots
const PLATE_PAD = 8; // px between the grid and the frame
const FILL_MS = 1_000;
const CHANGE_MS = 400;

// ── the pure model (tested) ──────────────────────────────────────────────────

/** An agent is operator-run when its on-chain name starts with `swarm-`; an agent with no name is not. */
export function isOperatorRun(name) {
  return typeof name === 'string' && name.startsWith(OPERATOR_PREFIX);
}

/** Who is party to an open agreement, and who to a disputed one, from the open-agreement list. */
export function partiesOf(open) {
  const working = new Set();
  const disputed = new Set();
  for (const a of open) {
    working.add(a.buyer);
    working.add(a.provider);
    if (a.status === 'Disputed') {
      disputed.add(a.buyer);
      disputed.add(a.provider);
    }
  }
  return { working, disputed };
}

/**
 * One agent's state now, most urgent first: slashed in the last hour, in
 * dispute, working (party to an open agreement, on either side, or holding
 * one as provider by the chain's own counter), or idle.
 */
export function agentState(agent, { working, disputed, slashed }) {
  if (slashed.has(agent.address)) return 'slashed';
  if (disputed.has(agent.address)) return 'disputed';
  if (agent.activeEscrowCount > 0 || working.has(agent.address)) return 'working';
  return 'idle';
}

/**
 * The order cells are laid out in: external agents first, then operator-run
 * ones, each in order of registration (then address, for a stable tie). A
 * newcomer lands at the end of its group, and buckets never mix the two
 * groups except at the one seam.
 */
export function orderAgents(agents) {
  const key = (a) => [isOperatorRun(a.name) ? 1 : 0, a.registeredAtBlock];
  return [...agents].sort((a, b) => {
    const [ga, ra] = key(a);
    const [gb, rb] = key(b);
    return ga - gb || ra - rb || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  });
}

/**
 * The colours of a run of buckets, in order. A dispute or a slash in a bucket
 * always shows (slash first): they are rare, and they are what a reader looks
 * for. Otherwise a bucket is working or idle so that, across the field, the
 * share of working cells matches the share of working agents: a running
 * carry adds each bucket's working fraction, and a bucket that holds at least
 * one working agent turns working once the carry reaches a half. So a cell is
 * never coloured by a state none of its agents is in, and the field neither
 * inflates activity (any-working) nor hides it (majority). Pure; tested.
 */
export function bucketStates(countsList) {
  let carry = 0;
  return countsList.map((counts) => {
    if (counts.slashed > 0) return 'slashed';
    if (counts.disputed > 0) return 'disputed';
    const n = counts.idle + counts.working;
    carry += n ? counts.working / n : 0;
    if (counts.working > 0 && carry >= 0.5) {
      carry -= 1;
      return 'working';
    }
    return 'idle';
  });
}

/**
 * The cells: one per agent up to `threshold` agents, otherwise one per bucket
 * of `size` consecutive agents (size = ⌈n / threshold⌉). A bucket's colour
 * comes from bucketStates; it is ringed only when every agent in it is
 * operator-run, and its counts say exactly how many are in each state.
 */
export function cellsFor(ordered, stateOf, threshold = BUCKET_THRESHOLD) {
  const size = ordered.length <= threshold ? 1 : Math.ceil(ordered.length / threshold);
  const cells = [];
  for (let from = 0; from < ordered.length; from += size) {
    const agents = ordered.slice(from, from + size);
    const counts = { idle: 0, working: 0, disputed: 0, slashed: 0 };
    let operator = 0;
    for (const agent of agents) {
      counts[stateOf(agent)] += 1;
      if (isOperatorRun(agent.name)) operator += 1;
    }
    cells.push({
      key: size === 1 ? agents[0].address : `bucket:${from}`,
      from,
      to: from + agents.length - 1,
      agents,
      counts,
      operator,
      state: null, // set below, for the run as a whole
      ring: operator === agents.length,
    });
  }
  const states = size === 1 ? cells.map((c) => STATES.reduce((best, st) => (c.counts[st] ? st : best), 'idle')) : bucketStates(cells.map((c) => c.counts));
  cells.forEach((cell, i) => {
    cell.state = states[i];
  });
  return { size, cells };
}

/**
 * A tidy grid for `count` cells in a plate: the column count whose square
 * pitch is largest while every cell fits, the pitch capped at `maxPitch` and
 * whole pixels, the block centred. Pure arithmetic, so 2,000 agents cost
 * nothing to place.
 */
export function gridLayout(count, width, height, { maxPitch = MAX_PITCH } = {}) {
  if (count <= 0 || width <= 0 || height <= 0) return { count: 0, cols: 0, rows: 0, pitch: 0, x0: 0, y0: 0 };
  const guess = Math.max(1, Math.min(count, Math.ceil(Math.sqrt((count * width) / height))));
  let best = { cols: guess, pitch: 0 };
  for (let cols = Math.max(1, guess - 4); cols <= Math.min(count, guess + 4); cols += 1) {
    const pitch = Math.min(width / cols, height / Math.ceil(count / cols));
    if (pitch > best.pitch) best = { cols, pitch };
  }
  const cols = best.cols;
  const rows = Math.ceil(count / cols);
  const pitch = Math.max(1, Math.floor(Math.min(maxPitch, best.pitch)));
  return {
    count,
    cols,
    rows,
    pitch,
    x0: Math.round((width - cols * pitch) / 2),
    y0: Math.round((height - rows * pitch) / 2),
  };
}

/** The centre of the i-th cell. */
export function cellCentre(layout, i) {
  return {
    x: layout.x0 + ((i % layout.cols) + 0.5) * layout.pitch,
    y: layout.y0 + (Math.floor(i / layout.cols) + 0.5) * layout.pitch,
  };
}

/** The cell under a point (its whole square counts), or -1. */
export function cellAt(layout, x, y) {
  if (!layout.count) return -1;
  const col = Math.floor((x - layout.x0) / layout.pitch);
  const row = Math.floor((y - layout.y0) / layout.pitch);
  if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) return -1;
  const i = row * layout.cols + col;
  return i < layout.count ? i : -1;
}

/** The dot inside its square, and the operator ring around it; both stay inside the square. */
export const dotRadius = (pitch) => Math.max(1.5, pitch * 0.3);
export const ringRadius = (pitch) => dotRadius(pitch) + Math.max(1.5, pitch * 0.1);

/** The panel's one live line. */
export function liveLine({ agents, active, disputed, floor = false }, formatInteger = String) {
  const n = `${floor ? '≥ ' : ''}${formatInteger(agents)} ${agents === 1 ? 'agent' : 'agents'}`;
  const parts = [n];
  parts.push(active === null ? 'activity unavailable' : `${formatInteger(active)} active now`);
  parts.push(disputed === null ? 'disputes unavailable' : `${formatInteger(disputed)} in dispute`);
  return parts.join(' · ');
}

/** How many listed agents are active now (party to an open agreement) and how many are in dispute. */
export function tally(agents, { working, disputed }) {
  let active = 0;
  let inDispute = 0;
  for (const agent of agents) {
    if (agent.activeEscrowCount > 0 || working.has(agent.address) || disputed.has(agent.address)) active += 1;
    if (disputed.has(agent.address)) inDispute += 1;
  }
  return { active, disputed: inDispute };
}

/** The agents an SlashExecuted list names at or after `since` (newest first). */
export function slashedSince(items, since, field) {
  const { count } = countSince(items, since);
  return new Set(items.slice(0, count).map((item) => field(item, 'data.who')));
}

/** The footnote: what one cell is, and anything the read could not cover. */
export function footnote({ size, truncated, scanLimit, listed, total }, formatInteger = String) {
  const unit =
    size === 1
      ? 'One cell per agent'
      : `One cell per ${formatInteger(size)} agents; working cells are in the same share as working agents, and any dispute or slash shows`;
  const order = 'External agents come first, then operator-run, each in order of registration';
  const cut = truncated
    ? `; the indexer's live scan stops at ${formatInteger(scanLimit)} agents, so ${formatInteger(listed)} are drawn`
    : listed < total
      ? `; ${formatInteger(listed)} of ${formatInteger(total)} read`
      : '';
  return `${unit}. ${order}${cut}.`;
}

/** Parses '#rgb', '#rrggbb' or 'rgb(r, g, b)' to [r, g, b], or null. */
export function parseColour(text) {
  const s = String(text).trim();
  let m = s.match(/^#([0-9a-f]{3})$/i);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16));
  m = s.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = s.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** A colour part way from `a` to `b`; `b` itself when either cannot be read. */
export function mixColour(a, b, t) {
  const ca = parseColour(a);
  const cb = parseColour(b);
  if (!ca || !cb || t >= 1) return b;
  const c = ca.map((v, i) => Math.round(v + (cb[i] - v) * Math.max(0, t)));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

// ── the instrument ───────────────────────────────────────────────────────────

export function init(root, ctx) {
  const panel = root.querySelector('.hero-panel');
  const canvas = root.querySelector('.field-canvas');
  const tip = root.querySelector('.field-tip');
  const live = root.querySelector('.field-live');
  const foot = root.querySelector('.field-foot');
  const list = root.querySelector('.agent-list');
  const pager = root.querySelector('.list-pager');
  const toggle = root.querySelector('.graph-toggle');
  const targets = {
    agents: ctx.reading('agents', root),
    operator: ctx.reading('operatorRun', root),
    active: ctx.reading('activeAgreements', root),
  };
  const { formatCmn, formatInteger, shortAddress } = ctx.format;
  const colour = (name) => ctx.theme.color(name);

  // ── source state ──
  let agentsList = null;
  let agentsTotal = 0;
  let agentsComplete = true;
  let agentsTruncated = false;
  let scanLimit = 0;
  let openList = null;
  let slashedSet = new Set();
  const failures = { agents: null, open: null, slashes: null };

  // ── field state ──
  let model = { size: 1, cells: [] };
  let parties = { working: new Set(), disputed: new Set() };
  const shown = new Map(); // cell key -> { state, from, mix, alpha }
  let filled = false; // the first fill has run
  let layout = gridLayout(0, 0, 0);
  let hovered = -1;
  let lastPointerType = 'mouse';
  let tapped = -1;
  let page = 0;
  let ordered = [];

  const box = ctx.fitCanvas(canvas, () => draw());

  const stateOf = (agent) => agentState(agent, { ...parties, slashed: slashedSet });

  function rebuild() {
    if (agentsList === null) {
      model = { size: 1, cells: [] };
      render();
      return;
    }
    parties = failures.open || openList === null ? { working: new Set(), disputed: new Set() } : partiesOf(openList);
    ordered = orderAgents(agentsList);
    const next = cellsFor(ordered, stateOf);
    // Cells that are new fade in; cells whose state changed blend to the new colour.
    const fresh = [];
    const changed = [];
    const keys = new Set();
    for (const cell of next.cells) {
      keys.add(cell.key);
      const before = shown.get(cell.key);
      if (!before) {
        const entry = { state: cell.state, from: cell.state, mix: 1, alpha: filled ? 0 : 1 };
        shown.set(cell.key, entry);
        if (filled) fresh.push(entry);
      } else if (before.state !== cell.state) {
        before.from = before.state;
        before.state = cell.state;
        before.mix = 0;
        changed.push(before);
      }
    }
    for (const key of [...shown.keys()]) if (!keys.has(key)) shown.delete(key);
    model = next;
    if (!filled && next.cells.length) {
      filled = true;
      // The first read fills the field once, in grid order.
      const all = next.cells.map((c) => shown.get(c.key));
      for (const e of all) e.alpha = 0;
      ctx.motion.tween(FILL_MS, (t) => {
        all.forEach((e, i) => {
          const start = (i / all.length) * 0.6;
          e.alpha = Math.min(1, Math.max(0, (t - start) / 0.4));
        });
        draw();
      });
    }
    if (fresh.length) {
      ctx.motion.tween(CHANGE_MS, (t) => {
        for (const e of fresh) e.alpha = t;
        draw();
      });
    }
    if (changed.length) {
      ctx.motion.tween(CHANGE_MS, (t) => {
        for (const e of changed) e.mix = t;
        draw();
      });
    }
    render();
  }

  function render() {
    draw();
    describe();
    renderLive();
    renderFoot();
    renderList();
    if (hovered >= 0) {
      if (hovered < model.cells.length) showTip(hovered);
      else setHovered(-1);
    }
  }

  // ── drawing ──
  function drawEmpty(g, width, height, lines) {
    g.font = `400 14px ${ctx.theme.font('sans')}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = colour('text-dim');
    lines.forEach((line, i) => g.fillText(line, width / 2, height / 2 + (i - (lines.length - 1) / 2) * 18));
  }

  function draw() {
    const { context: g, width, height } = box();
    g.clearRect(0, 0, width, height);
    if (failures.agents) {
      layout = gridLayout(0, 0, 0);
      drawEmpty(g, width, height, ['agents unavailable', failures.agents]);
      return;
    }
    if (agentsList === null) {
      layout = gridLayout(0, 0, 0);
      drawEmpty(g, width, height, ['reading the agent list…']);
      return;
    }
    if (!model.cells.length) {
      layout = gridLayout(0, 0, 0);
      drawEmpty(g, width, height, ['no agents registered']);
      return;
    }
    const inner = gridLayout(model.cells.length, width - 2 * PLATE_PAD, height - 2 * PLATE_PAD);
    layout = { ...inner, x0: inner.x0 + PLATE_PAD, y0: inner.y0 + PLATE_PAD };
    const r = dotRadius(layout.pitch);
    const ring = ringRadius(layout.pitch);
    const inks = Object.fromEntries(STATES.map((s) => [s, colour(STATE_COLOUR[s])]));
    const ringInk = colour('text-dim');
    model.cells.forEach((cell, i) => {
      const e = shown.get(cell.key);
      const { x, y } = cellCentre(layout, i);
      g.globalAlpha = e?.alpha ?? 1;
      g.fillStyle = e && e.mix < 1 ? mixColour(inks[e.from], inks[cell.state], e.mix) : inks[cell.state];
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
      if (cell.ring) {
        // Subtle: a hairline at half strength, enough to tell an operator-run cell from an external one.
        g.globalAlpha = (e?.alpha ?? 1) * 0.55;
        g.strokeStyle = ringInk;
        g.lineWidth = 1;
        g.beginPath();
        g.arc(x, y, ring, 0, Math.PI * 2);
        g.stroke();
      }
    });
    g.globalAlpha = 1;
    // The pointed-at cell: a hairline square in the text colour (an interaction state, not a reading).
    if (hovered >= 0 && hovered < model.cells.length) {
      const { x, y } = cellCentre(layout, hovered);
      const half = layout.pitch / 2 - 0.5;
      g.strokeStyle = colour('text');
      g.lineWidth = 1;
      g.strokeRect(Math.round(x - half) + 0.5, Math.round(y - half) + 0.5, Math.round(half * 2) - 1, Math.round(half * 2) - 1);
      positionTip();
    }
  }

  // ── words ──
  function counts() {
    const floor = agentsTruncated || !agentsComplete;
    if (agentsList === null) return null;
    const t = failures.open || openList === null ? { active: null, disputed: null } : tally(agentsList, parties);
    return { agents: agentsTotal, floor, ...t };
  }

  function renderLive() {
    if (!live) return;
    if (failures.agents) live.textContent = `agents unavailable — ${failures.agents}`;
    else if (agentsList === null) live.textContent = 'reading the agent list…';
    else live.textContent = liveLine(counts(), formatInteger);
  }

  function renderFoot() {
    if (!foot) return;
    if (agentsList === null || failures.agents) {
      foot.textContent = 'One cell per agent. External agents come first, then operator-run, each in order of registration.';
      return;
    }
    let text = footnote({ size: model.size, truncated: agentsTruncated, scanLimit, listed: agentsList.length, total: agentsTotal }, formatInteger);
    if (failures.open) text += ` Open agreements could not be read: ${failures.open}.`;
    if (failures.slashes) text += ` Slashes could not be read: ${failures.slashes}.`;
    foot.textContent = text;
  }

  function describe() {
    const c = counts();
    let label;
    if (failures.agents) label = `Agent activity: agents unavailable — ${failures.agents}.`;
    else if (!c) label = 'Agent activity: reading the agent list.';
    else {
      const n = (s) => formatInteger(model.cells.reduce((sum, cell) => sum + cell.counts[s], 0));
      label =
        `Agent activity, one ${model.size === 1 ? 'cell per agent' : `cell per ${model.size} agents`}: ${liveLine(c, formatInteger)}; ` +
        `${n('idle')} idle, ${n('working')} working, ${n('disputed')} in dispute, ${n('slashed')} slashed in the last hour.`;
    }
    canvas.setAttribute('aria-label', label);
  }

  function explorerLink(address) {
    const a = document.createElement('a');
    a.href = `${ctx.EXPLORER_ORIGIN}/activity?agent=${encodeURIComponent(address)}`;
    a.target = '_blank';
    a.rel = 'noopener';
    return a;
  }

  const nameOf = (agent) => (agent.name ? `${agent.name} · ${shortAddress(agent.address)}` : shortAddress(agent.address));
  const providerText = (agent) =>
    `as provider: ${formatInteger(agent.activeEscrowCount)} open · ${formatInteger(agent.completedAgreements)} completed`;

  function renderList() {
    if (!list) return;
    list.replaceChildren();
    const status = pager?.querySelector('.pager-status');
    const [prev, next] = pager ? pager.querySelectorAll('button') : [];
    if (failures.agents || agentsList === null) {
      const li = document.createElement('li');
      li.className = 'dim';
      li.textContent = failures.agents ? `unavailable — ${failures.agents}` : 'reading the agent list…';
      list.append(li);
      if (pager) pager.hidden = true;
      return;
    }
    const pages = Math.max(1, Math.ceil(ordered.length / LIST_PAGE));
    page = Math.min(page, pages - 1);
    const from = page * LIST_PAGE;
    for (const agent of ordered.slice(from, from + LIST_PAGE)) {
      const li = document.createElement('li');
      const a = explorerLink(agent.address);
      a.textContent = nameOf(agent);
      li.append(
        a,
        ` · ${STATE_WORD[stateOf(agent)]} · ${formatCmn(agent.stakePlancks)} CMN · ${providerText(agent)}` +
          `${isOperatorRun(agent.name) ? ' · operator-run' : ''}${agent.leaving ? ' · leaving' : ''}`,
      );
      list.append(li);
    }
    if (pager) {
      pager.hidden = pages <= 1;
      if (status) {
        status.textContent = `${formatInteger(from + 1)}–${formatInteger(Math.min(ordered.length, from + LIST_PAGE))} of ${formatInteger(ordered.length)}`;
      }
      if (prev) prev.disabled = page === 0;
      if (next) next.disabled = page >= pages - 1;
    }
  }

  pager?.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    page += button.dataset.step === 'next' ? 1 : -1;
    renderList();
  });

  // ── pointer ──
  function tipLines(i) {
    const cell = model.cells[i];
    const lines = [];
    const touch = lastPointerType === 'touch';
    if (model.size === 1) {
      const agent = cell.agents[0];
      const open = openList === null || failures.open ? null : openList.filter((a) => a.buyer === agent.address || a.provider === agent.address).length;
      lines.push([nameOf(agent), true]);
      lines.push([STATE_WORD[cell.state], false]);
      if (isOperatorRun(agent.name)) lines.push(['operator-run (swarm- prefix)', false]);
      lines.push([open === null ? 'open agreements unavailable' : `${formatInteger(open)} open ${open === 1 ? 'agreement' : 'agreements'}, either side`, false]);
      lines.push([providerText(agent), false]);
      lines.push([touch ? 'tap again to open in the explorer' : 'click to open in the explorer', false]);
    } else {
      lines.push([`Agents ${formatInteger(cell.from + 1)}–${formatInteger(cell.to + 1)} of ${formatInteger(ordered.length)}`, true]);
      const parts = STATES.filter((s) => cell.counts[s] > 0).map((s) => `${formatInteger(cell.counts[s])} ${STATE_WORD[s]}`);
      lines.push([parts.join(' · '), false]);
      lines.push([`${formatInteger(cell.operator)} of ${formatInteger(cell.agents.length)} operator-run`, false]);
      const first = cell.agents[0];
      const last = cell.agents[cell.agents.length - 1];
      lines.push([`registered blocks ${formatInteger(first.registeredAtBlock)}–${formatInteger(last.registeredAtBlock)}`, false]);
      lines.push(['each agent is in the list below', false]);
    }
    return lines;
  }

  function showTip(i) {
    if (!tip) return;
    tip.replaceChildren();
    for (const [text, strong] of tipLines(i)) {
      const span = document.createElement(strong ? 'strong' : 'span');
      span.textContent = text;
      tip.append(span);
    }
    tip.hidden = false;
    positionTip();
  }

  function positionTip() {
    if (!tip || tip.hidden || hovered < 0) return;
    const { width, height } = box();
    const { x, y } = cellCentre(layout, hovered);
    const half = layout.pitch / 2;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = x + half + 8;
    let top = y - th / 2;
    if (left + tw > width - 4) left = x - half - 8 - tw;
    if (left < 4) {
      left = x - tw / 2;
      top = y + half + 8;
      if (top + th > height - 4) top = y - half - 8 - th;
    }
    tip.style.left = `${Math.round(Math.max(4, Math.min(width - tw - 4, left)))}px`;
    tip.style.top = `${Math.round(Math.max(4, Math.min(height - th - 4, top)))}px`;
  }

  function setHovered(i) {
    if (i === hovered) return;
    hovered = i;
    canvas.style.cursor = i >= 0 && model.size === 1 ? 'pointer' : '';
    if (i >= 0) showTip(i);
    else {
      if (tip) tip.hidden = true;
      tapped = -1;
    }
    draw();
  }

  const pointer = (event) => {
    const rect = canvas.getBoundingClientRect();
    return cellAt(layout, event.clientX - rect.left, event.clientY - rect.top);
  };
  canvas.addEventListener('pointerdown', (event) => {
    lastPointerType = event.pointerType || 'mouse';
  });
  canvas.addEventListener('pointermove', (event) => setHovered(pointer(event)));
  canvas.addEventListener('pointerleave', (event) => {
    if (event.pointerType !== 'touch') setHovered(-1);
  });
  canvas.addEventListener('click', (event) => {
    const i = pointer(event);
    if (i < 0) {
      setHovered(-1);
      return;
    }
    if (lastPointerType === 'touch' && tapped !== i) {
      // First tap shows; a second tap on the same cell opens.
      tapped = i;
      hovered = -1;
      setHovered(i);
      return;
    }
    if (model.size === 1) {
      window.open(`${ctx.EXPLORER_ORIGIN}/activity?agent=${encodeURIComponent(model.cells[i].agents[0].address)}`, '_blank', 'noopener');
    }
  });

  ctx.bus.on('theme', () => draw());

  // ── the network graph, fetched on first use ──
  let graph = null;
  toggle?.addEventListener('click', async () => {
    const on = toggle.getAttribute('aria-checked') !== 'true';
    toggle.setAttribute('aria-checked', on ? 'true' : 'false');
    panel?.toggleAttribute('data-graph', on);
    setHovered(-1);
    if (on && !graph) {
      try {
        // A separate bundle beside observatory.js (see scripts/build.mjs), by URL so the bundler leaves it out.
        const module = await import(new URL(GRAPH_BUNDLE, import.meta.url).href);
        graph = module.init(panel, ctx) ?? true;
      } catch (error) {
        console.error(error);
        const note = panel?.querySelector('.graph-note');
        if (note) note.textContent = `The network graph could not be loaded: ${error.message}`;
      }
    }
    if (!on) draw();
  });

  // ── data ──
  ctx.watchAll(
    'agents',
    (record) => {
      let failed = null;
      const ok = ctx.readout.apply([targets.agents, targets.operator], record, (data) => {
        try {
          agentsTruncated = ctx.field(data, 'truncated');
          scanLimit = ctx.field(data, 'scanLimit');
          const total = ctx.field(data, 'total');
          const rows = record.items.map((item) => ({
            address: ctx.field(item, 'address'),
            stakePlancks: ctx.field(item, 'stakePlancks'),
            registeredAtBlock: ctx.field(item, 'registeredAtBlock'),
            completedAgreements: ctx.field(item, 'completedAgreements'),
            activeEscrowCount: ctx.field(item, 'activeEscrowCount'),
            // Both are documented as nullable: null is "none", not a missing field.
            name: item.metadata === null ? null : ctx.field(item, 'metadata.name'),
            leaving: item.unstakeAtBlock === null ? false : Number.isFinite(ctx.field(item, 'unstakeAtBlock')),
          }));
          agentsComplete = record.complete;
          agentsList = rows;
          agentsTotal = total;
          failures.agents = null;
          const floor = agentsTruncated || !record.complete;
          ctx.readout.showValue(targets.agents, record, {
            value: total,
            prefix: floor ? '≥ ' : '',
            extra: agentsTruncated ? 'live scan cut short at the indexer’s cap' : `${formatInteger(rows.length)} listed`,
            motion: ctx.motion,
          });
          const operator = rows.filter((row) => isOperatorRun(row.name)).length;
          ctx.readout.showValue(targets.operator, record, {
            value: operator,
            prefix: floor ? '≥ ' : '',
            unit: ` of ${floor ? '≥ ' : ''}${formatInteger(total)}`,
            extra: `agents whose metadata.name starts with “${OPERATOR_PREFIX}”${floor ? ', among the agents listed' : ''}`,
            motion: ctx.motion,
          });
        } catch (error) {
          failed = error.message;
          throw error;
        }
      });
      if (!ok) {
        agentsList = null;
        failures.agents = record.ok ? failed ?? 'a field was missing from the response' : record.error;
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
      } else {
        try {
          openList = record.items.map((item) => ({
            buyer: ctx.field(item, 'buyer'),
            provider: ctx.field(item, 'provider'),
            status: ctx.field(item, 'status'),
          }));
          failures.open = null;
        } catch (error) {
          openList = null;
          failures.open = error.message;
        }
      }
      rebuild();
    },
    ESCROWS_INTERVAL_MS,
    { maxPages: ESCROW_PAGES },
  );

  // Slashed in the last hour: the event index's newest hour, the same blocks
  // the hour row counts (hour.js), read once the index's position is known.
  const hour = hourTracker(ctx);
  let slashWatch = false;
  hour.onChange(({ hour: h }) => {
    if (!h || slashWatch) return;
    slashWatch = true;
    ctx.watchSince(
      'slashes',
      () => hour.get()?.since ?? null,
      (record) => {
        if (!record.ok) {
          slashedSet = new Set();
          failures.slashes = record.error;
        } else {
          try {
            slashedSet = slashedSince(record.items, record.since, ctx.field);
            failures.slashes = null;
          } catch (error) {
            slashedSet = new Set();
            failures.slashes = error.message;
          }
        }
        rebuild();
      },
      SLASHES_INTERVAL_MS,
    );
  });

  ctx.watch(
    'escrowStats',
    (record) => {
      ctx.readout.apply(targets.active, record, (data) => {
        const truncated = ctx.field(data, 'scanTruncated');
        ctx.readout.showValue(targets.active, record, {
          value: ctx.field(data, 'activeAgreementCount'),
          prefix: truncated ? '≥ ' : '',
          extra: truncated ? 'live scan cut short at the indexer’s cap' : 'live chain state',
          motion: ctx.motion,
        });
      });
    },
    STATS_INTERVAL_MS,
  );

  render();
  return { cells: () => model.cells, layout: () => layout };
}
