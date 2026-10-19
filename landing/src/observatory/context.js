// The context every instrument is given. One socket, one poller, one theme
// reader, one motion policy — instruments never reach for the network or the
// clock on their own.

import {
  Emitter,
  RpcSocket,
  Scheduler,
  SOURCES,
  API_ORIGIN,
  EXPLORER_ORIGIN,
  RPC_URL,
  fetchHttp,
  fetchAllPages,
  field,
  countSince,
  pageOf,
} from './data.js';
import * as readout from './readout.js';
import * as format from './format.js';
import { createMotion } from './motion.js';

const THEME_NAMES = [
  'bg',
  'surface',
  'grid',
  'text',
  'text-dim',
  'border',
  'live',
  'settled',
  'active',
  'disputed',
  'slashed',
  'slash',
  'idle',
  'paid',
  'font-mono',
  'font-serif',
  'font-sans',
];

function createTheme(win, bus) {
  const cache = new Map();
  const read = () => {
    const style = win.getComputedStyle(win.document.documentElement);
    for (const name of THEME_NAMES) cache.set(name, style.getPropertyValue(`--${name}`).trim());
  };
  read();
  const scheme = win.matchMedia?.('(prefers-color-scheme: dark)');
  scheme?.addEventListener('change', () => {
    read();
    bus.emit('theme', { dark: scheme.matches });
  });
  return {
    color: (name) => cache.get(name) ?? '',
    font: (name) => cache.get(`font-${name}`) ?? 'monospace',
    isDark: () => Boolean(scheme?.matches),
    refresh: read,
  };
}

/**
 * Sizes a canvas to its CSS box at device resolution. Returns the 2D context
 * scaled to CSS pixels, and re-fits on resize (calling `onResize`).
 */
function fitCanvas(canvas, onResize) {
  const fit = () => {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(canvas.clientWidth));
    const height = Math.max(1, Math.round(canvas.clientHeight));
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }
    const context = canvas.getContext('2d');
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { context, width, height, dpr };
  };
  let box = fit();
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      const next = fit();
      if (next.width !== box.width || next.height !== box.height) {
        box = next;
        onResize?.(box);
      }
    }).observe(canvas);
  }
  return () => box;
}

/** Parses an embedded `<script type="application/json">` by id. */
function embedded(doc, id) {
  const node = doc.getElementById(id);
  if (!node) return null;
  try {
    return JSON.parse(node.textContent);
  } catch {
    return null;
  }
}

export function createContext({ win = window, doc = document } = {}) {
  const bus = new Emitter();
  const socket = new RpcSocket(RPC_URL);
  const scheduler = new Scheduler((source) => (source.kind === 'rpc' ? socket.call(source) : fetchHttp(source)));
  // The same, for list endpoints read whole: the fetcher walks every page.
  const pagedScheduler = new Scheduler((source) => fetchAllPages(source, { maxPages: source.maxPages ?? 5 }));
  const motion = createMotion(win);
  const theme = createTheme(win, bus);
  const status = doc.querySelector('.sr-status');

  socket.on('state', (state) => bus.emit('socket', state));

  const ctx = {
    SOURCES,
    API_ORIGIN,
    EXPLORER_ORIGIN,
    RPC_URL,
    bus,
    socket,
    motion,
    theme,
    readout,
    format,
    field,
    countSince,
    pageOf,
    history: embedded(doc, 'runtime-history'),
    posture: embedded(doc, 'security-posture'),
    fitCanvas,
    now: () => Date.now(),

    /** One fetch of an HTTP or RPC source, as a provenance record. */
    fetch: (source, path) => (source.kind === 'rpc' ? socket.call(source) : fetchHttp(source, path)),
    /** Every page of a list endpoint. */
    fetchAll: (source, options) => fetchAllPages(source, options),
    /** Polls a source on an interval, shared with every other watcher of it. */
    watch: (name, handler, intervalMs) => scheduler.watch(name, SOURCES[name], handler, intervalMs),
    /**
     * Polls a list source whole (every page, up to `maxPages`) on an interval,
     * shared with every other watcher of it. The record carries `items`,
     * `total` and `complete`; `complete: false` means the page cap cut the
     * list short and a count from it is a floor.
     */
    watchAll: (name, handler, intervalMs, { maxPages = 5 } = {}) =>
      pagedScheduler.watch(`${name}:${maxPages}`, { ...SOURCES[name], maxPages }, handler, intervalMs),
    /**
     * Polls a newest-first event list back to a moving block: `since()` is
     * read at each fetch (the block of one hour ago, say), and paging stops
     * once a page reaches below it. The record carries `since` and
     * `reachedStart` (see fetchAllPages).
     */
    watchSince: (name, since, handler, intervalMs, { maxPages = 10 } = {}) =>
      pagedScheduler.watch(`${name}:since:${maxPages}`, { ...SOURCES[name], maxPages, stopBelow: since }, handler, intervalMs),
    /** Re-fetches a watched source ahead of schedule. */
    refresh: (name) => scheduler.refresh(name),
    /** The latest record a watched source produced, if any. */
    latest: (name) => scheduler.latest(name),
    /** Subscribes to a pushed source; the handler gets one record per notification. */
    subscribe: (name, handler) => socket.subscribe(SOURCES[name], handler),

    /** Polite screen-reader announcement. */
    announce(text) {
      if (status) status.textContent = text;
    },

    /** The reading element for a key, within an optional root. */
    reading: (key, root = doc) => root.querySelector(`[data-reading="${key}"]`),

    start() {
      doc.addEventListener('visibilitychange', () => {
        if (doc.hidden) {
          scheduler.pause();
          pagedScheduler.pause();
          socket.pause();
          bus.emit('visibility', { hidden: true });
        } else {
          socket.resume();
          scheduler.resume();
          pagedScheduler.resume();
          bus.emit('visibility', { hidden: false });
        }
      });
      readout.bindCopyButtons(doc, ctx.announce);
    },
  };
  return ctx;
}
