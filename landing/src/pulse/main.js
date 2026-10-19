// Boot for /pulse: one shared context (the observatory's — one socket, one
// poller, one motion policy), the live feed, the constellation, the strip and
// the ticker, wired together here and nowhere else. This is the only module
// on the page allowed a timer: one tick a second, stopped while the tab is
// hidden, that keeps the ticker's ages and the strip's minute-and-hour
// figures current. Everything that reaches the network goes through the
// context, which pauses it all when the tab is hidden; the graph is paused
// with it, so a background tab draws nothing and asks for nothing.

import { createContext } from '../observatory/context.js';
import { createFeed } from './feed.js';
import { createGraph } from './graph.js';
import { LIVE_WINDOW_BLOCKS, TICKER_MAX, displayName } from './model.js';
import { activityOf, moveOf } from './moves.js';
import { bannerText, roleOf } from './wiring.js';
import * as strip from './strip.js';
import * as ticker from './ticker.js';

const TICK_MS = 1_000;

/** Whether this browser can draw a 2D canvas at all; without one the page lists the agents instead. */
function canvasAvailable(doc) {
  try {
    return Boolean(doc.createElement('canvas').getContext('2d'));
  } catch (error) {
    console.error(error);
    return false;
  }
}

function boot() {
  const ctx = createContext();
  ctx.start();
  const { formatInteger } = ctx.format;

  const root = document.querySelector('.pulse');
  const host = document.getElementById('graph');
  const bar = document.querySelector('.pulse-bar');
  const barState = bar?.querySelector('.sb-state');
  const banner = root.querySelector('.pulse-banner');
  const tip = root.querySelector('.pulse-tip');
  const fallback = root.querySelector('.pulse-fallback');
  const fallbackList = fallback?.querySelector('.agent-list');
  const fullscreenButton = bar?.querySelector('.pulse-fullscreen');

  const feed = createFeed(ctx);
  const figures = strip.init(root.querySelector('.pulse-strip'), ctx, feed);
  const lines = ticker.init(root.querySelector('.ticker'), ctx, feed);
  let links = []; // the open agreements as the index lists them, for roles and the tooltip
  let agents = []; // the agents as the index lists them
  let activity = new Map(); // address → events in the last hour, from the hour's read
  let graph = null;
  let announcedFirst = false;

  const nameOf = (address) => displayName(address, feed.names());

  // ── the tooltip ──
  function showTip(node, point) {
    if (!tip) return;
    if (!node) {
      tip.hidden = true;
      return;
    }
    const parts = [nameOf(node.id), roleOf(node.id, links), `${formatInteger(node.completed ?? 0)} completed`];
    if (node.disputed) parts.push('in dispute');
    tip.textContent = parts.join(' · ');
    tip.hidden = false;
    const box = host.getBoundingClientRect();
    const x = Math.min(Math.max(8, point.x + 12), Math.max(8, box.width - tip.offsetWidth - 8));
    const y = Math.min(Math.max(8, point.y + 12), Math.max(8, box.height - tip.offsetHeight - 8));
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  // ── following one agent ──
  function follow(node) {
    const address = node?.id ?? null;
    graph?.follow(address);
    lines.filter(address);
    if (address) ctx.announce(`Following ${nameOf(address)}. Click the background to show every agent again.`);
  }

  // ── the feed's state, in the bar and the banner ──
  function showStatus(status) {
    const text = bannerText(status, formatInteger);
    if (banner) {
      banner.textContent = text;
      banner.hidden = text === '';
    }
    const word = { live: 'Live', stale: 'Unavailable', unavailable: 'Unavailable', connecting: 'Connecting' }[status.state] ?? 'Connecting';
    if (barState) barState.textContent = word;
    bar?.setAttribute('data-state', status.state === 'live' ? 'network-normal' : status.state);
    if (text) ctx.announce(text);
  }

  // ── the canvas, or the list ──
  if (canvasAvailable(document)) {
    graph = createGraph(host, { ctx, onHover: showTip, onSelect: follow });
    host.addEventListener('pointerleave', () => showTip(null));
  } else if (fallback) {
    fallback.hidden = false;
  }

  /** The plate's points: the index's agents, each sized by its last hour (the hour's read, then live events). */
  function showAgents() {
    if (!graph) return;
    graph.setAgents(
      agents.map((agent) => ({ ...agent, activityLastHour: activity.get(agent.address) ?? 0 })),
      { names: feed.names() },
    );
  }

  function renderFallback(record, items) {
    if (!fallbackList) return;
    fallbackList.replaceChildren();
    if (!record.ok) {
      const li = document.createElement('li');
      li.textContent = `unavailable: ${record.error}`;
      fallbackList.append(li);
      return;
    }
    for (const agent of items) {
      const li = document.createElement('li');
      li.textContent = `${nameOf(agent.address)} · ${roleOf(agent.address, links)} · ${formatInteger(agent.completedAgreements ?? 0)} completed`;
      fallbackList.append(li);
    }
  }

  feed.on('agents', ({ record, items }) => {
    if (!record.ok) {
      if (!graph) renderFallback(record, []);
      return;
    }
    agents = items;
    if (graph) showAgents();
    else renderFallback(record, items);
  });
  feed.on('links', ({ record, items }) => {
    if (!record.ok) return;
    links = items;
    graph?.setLinks(items);
  });
  // The index's last hour: the points' sizes, and the ticker's first lines —
  // the live window's record, with true ages, so the first screen is not blank
  // between bursts. Those lines are history, read with provenance; they never
  // animate.
  let tickerSeeded = false;
  feed.on('hour', ({ events, error }) => {
    if (error) return;
    activity = activityOf(events);
    showAgents();
    const head = feed.head();
    if (tickerSeeded || head === null) return;
    tickerSeeded = true;
    const recent = events.filter(({ event }) => head - event.blockNumber <= LIVE_WINDOW_BLOCKS).slice(-TICKER_MAX);
    for (const item of recent) lines.push(item);
  });
  feed.on('event', (live) => {
    if (graph) {
      const { call, args } = moveOf(live, { names: feed.names(), field: ctx.field });
      graph[call](...args);
    }
    lines.push(live);
    if (!announcedFirst) {
      announcedFirst = true;
      ctx.announce('The first live event has arrived; the ticker reads them out.');
    }
  });
  feed.on('status', showStatus);

  // ── the tab, the keys, the buttons ──
  ctx.bus.on('visibility', ({ hidden }) => {
    if (hidden) graph?.pause();
    else graph?.resume();
  });
  lines.onRelease(() => graph?.follow(null));
  ctx.motion.onChange((reduced) => graph?.setStatic(reduced));

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.().catch((error) => console.error(error));
    else document.documentElement.requestFullscreen?.().catch((error) => console.error(error));
  }
  document.addEventListener('fullscreenchange', () => {
    fullscreenButton?.setAttribute('aria-pressed', String(Boolean(document.fullscreenElement)));
  });
  fullscreenButton?.addEventListener('click', toggleFullscreen);
  document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (/^(input|textarea|select)$/i.test(event.target?.tagName ?? '')) return;
    if (event.key === 'f' || event.key === 'F') {
      event.preventDefault();
      toggleFullscreen();
    } else if (event.key === 'Escape') {
      follow(null);
    }
  });

  // The one timer on the page: ages and the minute-and-hour figures move with the clock, not only with events.
  setInterval(() => {
    if (document.hidden) return;
    figures.tick();
    lines.tick();
  }, TICK_MS);

  feed.start();
}

if (typeof document !== 'undefined' && document.querySelector('.pulse')) boot();
