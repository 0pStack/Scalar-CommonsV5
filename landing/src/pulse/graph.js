// /pulse — the plate. Every registered agent is a point in a force layout
// (force-graph on a 2D canvas, d3-force underneath), every open agreement is
// a thread from its buyer to its provider, and every light that moves is one
// real on-chain event, handed in by main.js with its kind already decided by
// model.js. Nothing here reaches for the network or the clock on its own: the
// page's context supplies the colours, the motion policy and the time; the
// feed supplies the events.
//
// Why the layout is driven the way it is: force-graph reheats its simulation
// to alpha 1 on every graphData() call, and this page changes its data every
// time a thread or a point joins or leaves — several times a block when the
// chain is busy. A full reheat each time would throw the whole constellation
// about with every event. So the library's own forces are removed and one
// force of this module's runs the same charge, link and centre forces at a
// heat the module controls: 1 on load, settled to a floor within three
// seconds (a gsap tween, so a slow machine settles in the same three
// seconds), nudged a little when the data changes, never thrown back to 1.
// At the floor the layout drifts: the forces still act faintly and a
// sub-pixel wander keeps the plate from freezing in place. The simulation's
// own alpha is only a clock. Dragging a point warms the layout to DRAG_HEAT
// so its neighbours react, and it cools again when the point is let go.
//
// Why the points are sprites, painted in one pass rather than through the
// library's per-node callback: at 2,000 points the cost is rasterization,
// not JavaScript. Measured in headless Chromium (software Skia, 1920×1080),
// a halo and a disc as two anti-aliased arcs per point cost ~10 ms a frame,
// one path holding every disc ~20 ms (its bounds are the whole plate), and
// one bitmap blit per point at an integer device position ~6 ms. So each
// point is a sprite — the same plain halo, disc and operator ring, painted
// once per radius bucket and state with ordinary arcs, no gradient, no blur
// — blitted where the point is; a point too large for a sprite (zoomed far
// in) is drawn as arcs. Points off the plate are skipped. Nothing is
// allocated per point per frame. Threads at rest are the library's own
// bundled strokes; only a thread mid-animation (drawing in, flashing,
// pulsing, dissolving) is painted here. The many-body force, the other
// measurable cost at 2,000 points, runs every tick while the layout is warm
// and every second or fourth tick at the drift floor, scaled to match.
//
// Honesty: a thread or a light appears only when main.js reports an event,
// and lives exactly the lifetime model.js gives its kind; past EFFECT_CAP the
// oldest expire first (model.expire). A settlement, dispute or resolution of
// an agreement the index never listed (it enumerates only part of the open
// set) is still shown: the thread is made for the moment and goes with the
// event. Under prefers-reduced-motion nothing moves: the layout is computed
// to rest synchronously, threads appear and go at once, and no effect is
// ever created.
//
// Device pixel ratio: force-graph has no option for it. It reads
// window.devicePixelRatio when it sizes its canvases and again on every
// frame when it resets the transform, so the only lever is the property
// itself: capDevicePixelRatio() redefines it on the window as the lesser of
// the native ratio and DPR_MAX before the graph is built. A 1920×1080 plate
// at ratio 3 is nine times the pixels of ratio 1; at 2 it is four, and still
// sharp.

import ForceGraph from 'force-graph';
import { gsap } from 'gsap';
import { forceCenter, forceLink, forceManyBody } from 'd3-force';
import { shortAddress } from '../observatory/format.js';
import { isOperatorRun, mixColour, parseColour } from '../observatory/instruments/agent-field.js';
import { EFFECT_CAP, EVENTS, HOUR_MS, agreementKey, expire, nodeValue } from './model.js';

/** The page never paints at more than twice the CSS pixel density. */
export const DPR_MAX = 2;
/** Graph units of radius per square root of a point's `val` (model.nodeValue). */
export const NODE_REL_SIZE = 4;
/** A point is never smaller than this on screen, however far out the plate is zoomed. */
const MIN_RADIUS_PX = 1.5;
const HALO_RATIO = 2.4;
const HALO_ALPHA = 0.14;
/** What everything outside a followed agent's neighbourhood fades to. */
export const DIM_ALPHA = 0.15;
/** The layout warms up for this long on load, then drifts. */
export const WARMUP_MS = 3000;
/** Synchronous ticks before the first paint, so the plate never shows the seed spiral. */
const WARMUP_TICKS = 90;
/**
 * Under reduced motion the layout is computed to rest synchronously: this
 * many ticks on first data (the same energy as the live warm-up), and after
 * a change this many at STATIC_SETTLE_HEAT, enough for a new thread to pull.
 */
const STATIC_TICKS = 300;
const STATIC_SETTLE_TICKS = 40;
const STATIC_SETTLE_HEAT = 0.25;
/** The heat the layout drifts at once settled; 0 would freeze it. */
const FLOOR_HEAT = 0.004;
/** The nudge when a point or thread joins or leaves — a local settle, not a reheat. */
const EVENT_HEAT = 0.08;
const DRAG_HEAT = 0.3;
const SETTLE_S = 1.2;
/** Sub-pixel wander per tick at the floor, so the plate breathes rather than freezes. */
const WANDER = 0.012;
const CHARGE = -40;
const LINK_DISTANCE = 40;
/** A message with no thread to travel crosses in a short arc. */
export const ARC_MS = 500;
/** A settling thread flashes for this fraction of its lifetime, then dissolves. */
const FLASH_PART = 0.2;
/** A resolving thread returns to the accent over this fraction of its lifetime, then dissolves. */
const RETURN_PART = 0.3;
/** How many particles a settlement throws from the provider's point. */
export const BURST_COUNT = 12;
const BURST_PX = 28;
const SPARK_PX = 18;
const SPARK_SEGMENT_PX = 8;
const PULSE_PX = 16;
const PARTICLE_PX = 4;
const TAU = Math.PI * 2;
const GOLDEN_ANGLE = 2.399963;
/** Point sprites come in buckets of half a CSS pixel of radius; above this halo radius (CSS px) a point is drawn as arcs. */
const SPRITE_STEP = 2;
const SPRITE_MAX_HALO_PX = 64;
/** Message particles cross their thread in this many ticks — the message lifetime at 60 ticks a second. */
const MESSAGE_TICKS = 72;
const FRAME_RING = 1024;

/** Each light's lifetime, from the one table the page animates from. */
const LIFETIME_MS = Object.fromEntries(EVENTS.map((row) => [row.kind, row.lifetimeMs]));

// ── pure helpers (tested) ────────────────────────────────────────────────────

/** The id at either end of a link, whether the layout has resolved it to a node yet or not. */
export function endId(end) {
  return end !== null && typeof end === 'object' ? end.id : end;
}

/**
 * The agent's name as the page says it: the index's name when it reports
 * one, else the shortened address, the way the observatory shortens it.
 */
function nameOf(address, given) {
  return typeof given === 'string' && given.length > 0 ? given : shortAddress(address);
}

/**
 * A point from a /v1/agents item. `names` (Map<address, name>) wins over the
 * item's own `name` so a later agents read can rename a point in place. Size
 * is model.nodeValue of the agent's activity: `activityLastHour` when the
 * caller counted one, else the agent's open escrows now — the index's one
 * figure of present activity; live events add to it (see `touch`).
 */
export function nodeOf(agent, names) {
  const address = agent.address;
  const given = names?.get?.(address) ?? agent.name;
  const base = Number(agent.activityLastHour ?? agent.activeEscrowCount ?? 0);
  const node = {
    id: address,
    name: nameOf(address, given),
    operator: isOperatorRun(given),
    val: 1,
    completed: Number(agent.completedAgreements ?? 0),
    disputed: false,
    alpha: 1,
    base: Number.isFinite(base) ? base : 0,
    hits: [],
    r: 0,
  };
  sizeNode(node, 0);
  return node;
}

/** A thread from a /v1/escrows item: buyer → provider, keyed as the chain keys the agreement. */
export function linkOf(escrow) {
  const status = escrow.status === 'Disputed' || escrow.status === 'Delivered' ? escrow.status : 'Created';
  return {
    id: agreementKey(escrow.buyer, escrow.provider, escrow.seq),
    source: escrow.buyer,
    target: escrow.provider,
    seq: escrow.seq,
    status,
    alpha: 1,
    origin: 'index',
    effect: null,
  };
}

/** The agent and everyone it has a thread with — the set that stays bright when it is followed. */
export function neighbourhood(links, address) {
  const set = new Set([address]);
  for (const link of links) {
    const a = endId(link.source);
    const b = endId(link.target);
    if (a === address) set.add(b);
    else if (b === address) set.add(a);
  }
  return set;
}

/**
 * The parties of an agreement key (`buyer>provider#seq`, model.agreementKey)
 * — SS58 addresses carry neither `>` nor `#`, so the split is exact. Null for
 * anything that is not such a key.
 */
export function partiesOfKey(key) {
  if (typeof key !== 'string') return null;
  const hash = key.lastIndexOf('#');
  const arrow = key.indexOf('>');
  if (arrow <= 0 || hash <= arrow + 1 || hash === key.length - 1) return null;
  return { buyer: key.slice(0, arrow), provider: key.slice(arrow + 1, hash), seq: key.slice(hash + 1) };
}

/**
 * The particles of one settlement burst: `n` of them around the circle, each
 * with a little jitter in angle, speed and size from a small deterministic
 * generator seeded by the caller — the same event bursts the same way in a
 * test as on the plate. Allocated once per event, never per frame.
 */
export function burstParticles(n, seed = 1) {
  let state = (Number(seed) >>> 0) || 1;
  const next = () => {
    // Park–Miller minimal standard: enough spread for twelve sparks, no Math.random.
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
  const particles = [];
  for (let i = 0; i < n; i += 1) {
    const angle = ((i + (next() - 0.5) * 0.6) / n) * TAU;
    particles.push({ angle, speed: 0.6 + next() * 0.4, size: 0.5 + next() * 0.5 });
  }
  return particles;
}

/**
 * Caps `win.devicePixelRatio` at `max`, redefining it on the window (see the
 * header for why the property itself). Idempotent; returns the ratio the
 * page will paint at.
 */
export function capDevicePixelRatio(win = window, max = DPR_MAX) {
  const current = Object.getOwnPropertyDescriptor(win, 'devicePixelRatio');
  if (current?.get?.pulseCapped === max) return win.devicePixelRatio;
  const native = current?.get ? current.get.bind(win) : () => (Number.isFinite(current?.value) ? current.value : 1);
  const get = () => Math.min(max, native() || 1);
  get.pulseCapped = max;
  Object.defineProperty(win, 'devicePixelRatio', { get, configurable: true, enumerable: true });
  return win.devicePixelRatio;
}

/** `rgba()` of a theme colour at an alpha, built once per palette, never per frame. */
export function rgba(colour, alpha) {
  const c = parseColour(colour);
  if (!c) throw new Error(`not a colour: "${colour}"`);
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
}

/** A point's radius in graph units from its `val`; `liveHits` are the live events it was party to. */
function sizeNode(node, liveHits) {
  node.val = nodeValue(node.base + liveHits);
  node.r = Math.sqrt(node.val) * NODE_REL_SIZE;
}

// ── the plate ────────────────────────────────────────────────────────────────

/**
 * The colours of the plate from the page's theme tokens, as ready strings:
 * one set of thread colours at rest, one bright for a followed agent's
 * threads, one dim for everything else while following; and the ramp a
 * resolving thread walks from amber back to the accent.
 */
function buildPalette(theme) {
  const token = (name) => {
    const value = theme.color(name);
    if (!parseColour(value)) throw new Error(`theme token --${name} is not a colour: "${value}"`);
    return value;
  };
  const accent = token('live');
  const settled = token('settled');
  // The page's own token: green for a payment that settled. The observatory's
  // `--settled` is the grey of a thread at rest, which no light should wear.
  const paid = token('paid');
  const amber = token('disputed');
  const dim = token('text-dim');
  const ramp = [];
  for (let i = 0; i <= 8; i += 1) ramp.push(mixColour(amber, accent, i / 8));
  return {
    accent,
    amber,
    settled,
    paid,
    halo: rgba(accent, HALO_ALPHA),
    haloDisputed: rgba(amber, HALO_ALPHA),
    ring: rgba(dim, 0.9),
    link: { Created: rgba(dim, 0.4), Delivered: rgba(settled, 0.5), Disputed: rgba(amber, 0.85) },
    linkBright: { Created: rgba(accent, 0.9), Delivered: rgba(settled, 0.9), Disputed: amber },
    linkDim: { Created: rgba(dim, 0.08), Delivered: rgba(settled, 0.08), Disputed: rgba(amber, 0.15) },
    ramp,
  };
}

/**
 * Mounts the plate into `host` (force-graph empties it). `ctx` is the page
 * context (theme, motion, now, bus); `onHover(node, {x, y} | null)` and
 * `onSelect(node | null)` are the page's. Returns the handle the contract
 * names.
 */
export function createGraph(host, { ctx, onHover = () => {}, onSelect = () => {} }) {
  let reduced = Boolean(ctx.motion?.reduced?.());
  const now = () => ctx.now();
  capDevicePixelRatio();
  let palette = buildPalette(ctx.theme);

  const nodes = new Map(); // id → the one point object for that agent, reused across reads
  const links = new Map(); // id → the one thread object for that agreement
  const data = { nodes: [], links: [] }; // what the layout holds; rebuilt by flush()
  let effects = [];
  let followed = null;
  let hood = null;
  let hovered = null;
  let dirty = false;
  let warmed = false;
  let warming = false;
  let touched = false; // the viewer zoomed or panned — do not fit the plate over them
  let destroyed = false;
  let seq = 0; // deterministic angles for sparks and placements
  const frames = new Float64Array(FRAME_RING);
  let frameAt = 0;

  // ── the layout's own force ────────────────────────────────────────────────
  // `heat` drives the live layout; under reduced motion the synchronous run
  // follows a tick budget instead: `peak` falling to 0 over `budget` ticks.
  const sim = { heat: 0, tick: 0, budget: STATIC_TICKS, peak: 1 };
  let fitted = false;
  const charge = forceManyBody().strength(CHARGE).theta(0.9).distanceMax(400);
  const spring = forceLink()
    .id((d) => d.id)
    .distance(LINK_DISTANCE);
  const centre = forceCenter(0, 0).strength(0.03);
  let simNodes = [];
  let wanderT = 0;
  const layout = () => {
    let heat = sim.heat;
    if (reduced) {
      // Tick-scheduled, since the whole run is synchronous: peak → 0 over the budget.
      const left = 1 - sim.tick / sim.budget;
      heat = left > 0 ? sim.peak * left : 0;
    }
    sim.tick += 1;
    if (heat > 0) {
      // The many-body force is the layout's one real cost; cooled, it runs
      // every second or fourth tick with its impulse scaled to match.
      const every = heat >= 0.1 ? 1 : heat >= 0.02 ? 2 : 4;
      if (sim.tick % every === 0) charge(heat * every);
      spring(heat);
      centre();
    }
    if (!reduced) {
      wanderT += 0.02;
      for (let i = 0; i < simNodes.length; i += 1) {
        const n = simNodes[i];
        n.vx += WANDER * Math.sin(wanderT + i * GOLDEN_ANGLE);
        n.vy += WANDER * Math.cos(wanderT * 0.8 + i * 1.7);
      }
    }
  };
  layout.initialize = (ns, random) => {
    simNodes = ns;
    sim.tick = 0;
    charge.initialize(ns, random);
    centre.initialize(ns, random);
    spring.initialize(ns, random);
    // Only threads whose both ends are among these points: the library's
    // update runs on a debounce, so what it holds can trail what flush() built.
    const ids = new Set();
    for (let i = 0; i < ns.length; i += 1) ids.add(ns[i].id);
    spring.links(data.links.filter((link) => ids.has(endId(link.source)) && ids.has(endId(link.target))));
  };

  /** Cools the layout to the floor over `seconds`; never interrupts the warm-up. */
  const settle = (seconds) => {
    if (reduced || warming) return;
    gsap.killTweensOf(sim);
    gsap.to(sim, { heat: FLOOR_HEAT, duration: seconds, ease: 'power2.out' });
  };
  const nudge = () => {
    if (reduced || !warmed || warming) return;
    sim.heat = Math.max(sim.heat, EVENT_HEAT);
    settle(SETTLE_S);
  };

  // ── effects ───────────────────────────────────────────────────────────────
  const finish = (effect) => {
    if (effect.tween) {
      effect.tween.kill();
      effect.tween = null;
    }
    effect.end?.();
    const i = effects.indexOf(effect);
    if (i >= 0) effects.splice(i, 1);
  };
  /** Drops what has lived its lifetime and, past the cap, the oldest; each dropped effect ends as if complete. */
  const prune = () => {
    const kept = expire(effects, now(), EFFECT_CAP);
    if (kept.length === effects.length) return;
    let j = 0;
    for (const effect of effects) {
      if (kept[j] === effect) {
        j += 1;
      } else {
        if (effect.tween) {
          effect.tween.kill();
          effect.tween = null;
        }
        effect.end?.();
      }
    }
    effects = kept;
  };
  const addEffect = (effect, lifetimeMs, tween = {}) => {
    effect.t = 0;
    effect.until = now() + lifetimeMs;
    effect.tween =
      tween === null
        ? null
        : gsap.to(effect, { t: 1, duration: lifetimeMs / 1000, ease: 'power2.out', ...tween, onComplete: () => finish(effect) });
    effects.push(effect);
    if (effects.length > EFFECT_CAP) prune();
    return effect;
  };

  // ── the library ───────────────────────────────────────────────────────────
  const touches = (link) => endId(link.source) === followed || endId(link.target) === followed;
  const linkColor = (link) => {
    const set = hood === null ? palette.link : touches(link) ? palette.linkBright : palette.linkDim;
    return set[link.status] ?? set.Created;
  };
  const linkWidth = (link) => (hood !== null && touches(link) ? 1.6 : link.status === 'Disputed' ? 1.4 : 1);
  const radiusAt = (node, k) => (node.r > MIN_RADIUS_PX / k ? node.r : MIN_RADIUS_PX / k);

  const graph = new ForceGraph(host)
    .width(Math.max(1, host.clientWidth))
    .height(Math.max(1, host.clientHeight))
    .nodeId('id')
    .nodeVal('val')
    .nodeRelSize(NODE_REL_SIZE)
    .nodeLabel(() => null)
    .linkLabel(() => null)
    .nodeCanvasObjectMode(() => 'replace')
    // The per-node callback is a no-op by design: the points are painted in
    // one batched pass from onRenderFramePost (see the header).
    .nodeCanvasObject(() => {})
    .nodePointerAreaPaint((node, color, c, k) => {
      // A generous target, so a finger finds a point as easily as a pointer does.
      const r = Math.max(radiusAt(node, k) * HALO_RATIO, 8 / k);
      c.fillStyle = color;
      c.beginPath();
      c.arc(node.x, node.y, r, 0, TAU);
      c.fill();
    })
    .linkColor(linkColor)
    .linkWidth(linkWidth)
    .linkCanvasObjectMode((link) => (link.effect ? 'replace' : undefined))
    .linkCanvasObject((link, c, k) => paintLink(link, c, k))
    .linkDirectionalParticleSpeed(1 / MESSAGE_TICKS)
    .linkDirectionalParticleWidth(PARTICLE_PX)
    .linkDirectionalParticleColor(() => palette.accent)
    .enableNodeDrag(true)
    .enableZoomInteraction(true)
    .enablePanInteraction(true)
    .autoPauseRedraw(true)
    .d3AlphaMin(0)
    .warmupTicks(0)
    .cooldownTicks(reduced ? 0 : Infinity)
    .cooldownTime(Infinity)
    .d3Force('charge', null)
    .d3Force('center', null)
    .d3Force('link', null)
    .d3Force('pulse', layout)
    .onNodeHover((node) => {
      hovered = node ?? null;
      onHover(hovered, hovered ? graph.graph2ScreenCoords(hovered.x, hovered.y) : null);
    })
    .onNodeClick((node) => onSelect(node))
    .onBackgroundClick(() => onSelect(null))
    .onNodeDrag(() => {
      if (!reduced) sim.heat = Math.max(sim.heat, DRAG_HEAT);
    })
    .onNodeDragEnd(() => settle(SETTLE_S))
    .onEngineStop(() => {
      // Static mode: the layout was computed to rest in the update; fit it once.
      if (reduced && !fitted && data.nodes.length) {
        fitted = true;
        graph.zoomToFit(0, 48);
      }
    })
    .onRenderFramePre(() => {
      flush();
      if (effects.length) {
        const at = now();
        let stale = false;
        for (let i = 0; i < effects.length; i += 1) {
          const effect = effects[i];
          if (effect.until <= at) stale = true;
          // The library's data update drops every single-hop particle; a
          // message still crossing is put back where it was.
          if (effect.kind === 'message') {
            const photons = effect.link.__photons ?? (effect.link.__photons = []);
            if (!photons.includes(effect.photon)) photons.push(effect.photon);
          }
        }
        if (stale) prune();
      }
    })
    .onRenderFramePost((c, k) => {
      paintNodes(c, k);
      paintEffects(c, k);
      frames[frameAt % FRAME_RING] = performance.now();
      frameAt += 1;
    });

  /** The static-mode poke: Kapsule runs a prop's onChange on every set, and a style prop's marks the plate for one repaint. */
  const redraw = () => graph.linkWidth(linkWidth);

  /**
   * Hands the layout the current points and threads, once per frame at most,
   * keeping every object that stayed. The library applies the data on a
   * one-millisecond debounce, so the warm-up ticks it should run are set
   * here and left standing until the next flush sets its own; calls within
   * that millisecond coalesce, and the latest data wins.
   */
  function flush() {
    if (!dirty) return;
    dirty = false;
    data.nodes = [...nodes.values()];
    data.links = [];
    for (const link of links.values()) {
      const a = nodes.get(endId(link.source));
      const b = nodes.get(endId(link.target));
      if (!a || !b) continue;
      // Resolved here, not left to the layout: a message sent in the same
      // block as its agreement then rides the thread rather than an arc.
      link.source = a;
      link.target = b;
      data.links.push(link);
    }
    const first = !warmed;
    if (first) {
      warmed = true;
      warming = !reduced;
      sim.heat = reduced ? 0 : 1; // static mode follows its tick budget, not the heat
    }
    if (reduced) {
      sim.budget = first ? STATIC_TICKS : STATIC_SETTLE_TICKS;
      sim.peak = first ? 1 : STATIC_SETTLE_HEAT;
      graph.warmupTicks(sim.budget);
    } else {
      graph.warmupTicks(first ? WARMUP_TICKS : 0);
    }
    graph.graphData({ nodes: data.nodes, links: data.links });
    if (first && !reduced) {
      gsap.to(sim, {
        heat: FLOOR_HEAT,
        duration: WARMUP_MS / 1000,
        ease: 'power2.out',
        onComplete: () => {
          warming = false;
          if (!touched && !destroyed) graph.zoomToFit(400, 48);
        },
      });
    }
  }
  const commit = () => {
    dirty = true;
    if (reduced) redraw();
  };

  // ── painting ──────────────────────────────────────────────────────────────
  const dimmed = (node) => hood !== null && !hood.has(node.id);

  /** Point sprites by radius bucket and state (bit 0: in dispute, bit 1: operator-run), at the plate's device pixel ratio. */
  const sprites = new Map();
  let spriteDpr = 0;
  const spriteKey = (bucket, node) => bucket * 4 + (node.disputed ? 1 : 0) + (node.operator ? 2 : 0);
  /** Paints one sprite with the same arcs a point is made of: halo, disc, ring. Once per bucket and state, never per frame. */
  function makeSprite(bucket, node, dpr) {
    const r = bucket / SPRITE_STEP;
    const halo = r * HALO_RATIO;
    const ring = r + 2;
    const extent = (node.operator ? Math.max(halo, ring + 1) : halo) + 1;
    const size = 2 * Math.ceil(extent * dpr) + 2;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const s = canvas.getContext('2d');
    const half = size / 2;
    s.fillStyle = node.disputed ? palette.haloDisputed : palette.halo;
    s.beginPath();
    s.arc(half, half, halo * dpr, 0, TAU);
    s.fill();
    s.fillStyle = palette.accent;
    s.beginPath();
    s.arc(half, half, r * dpr, 0, TAU);
    s.fill();
    if (node.operator) {
      s.strokeStyle = palette.ring;
      s.lineWidth = dpr;
      s.beginPath();
      s.arc(half, half, ring * dpr, 0, TAU);
      s.stroke();
    }
    return { image: canvas, half };
  }

  /** The device-space frame the points are blitted in, read once per frame (one small matrix), never per point. */
  const frame = { scale: 1, ox: 0, oy: 0, dpr: 1, w: 0, h: 0 };

  /** One point at its device position: a sprite blit, or arcs when it is too large for one. */
  function blit(c, n, k) {
    const dx = Math.round(n.x * frame.scale + frame.ox);
    const dy = Math.round(n.y * frame.scale + frame.oy);
    const r = radiusAt(n, k) * k; // CSS px
    const halo = r * HALO_RATIO;
    const reach = (halo + 3) * frame.dpr;
    if (dx < -reach || dy < -reach || dx > frame.w + reach || dy > frame.h + reach) return;
    if (halo <= SPRITE_MAX_HALO_PX) {
      const bucket = Math.round(r * SPRITE_STEP);
      const key = spriteKey(bucket, n);
      let sprite = sprites.get(key);
      if (!sprite) {
        sprite = makeSprite(bucket, n, frame.dpr);
        sprites.set(key, sprite);
      }
      c.drawImage(sprite.image, dx - sprite.half, dy - sprite.half);
      return;
    }
    const dpr = frame.dpr;
    c.fillStyle = n.disputed ? palette.haloDisputed : palette.halo;
    c.beginPath();
    c.arc(dx, dy, halo * dpr, 0, TAU);
    c.fill();
    c.fillStyle = palette.accent;
    c.beginPath();
    c.arc(dx, dy, r * dpr, 0, TAU);
    c.fill();
    if (n.operator) {
      c.strokeStyle = palette.ring;
      c.lineWidth = dpr;
      c.beginPath();
      c.arc(dx, dy, (r + 2) * dpr, 0, TAU);
      c.stroke();
    }
  }

  /** All the points: the bright ones, then (while following) the dim ones, then the few fading in at their own alpha. */
  function paintNodes(c, k) {
    const ns = data.nodes;
    const count = ns.length;
    const m = c.getTransform();
    const dpr = window.devicePixelRatio;
    if (dpr !== spriteDpr) {
      sprites.clear();
      spriteDpr = dpr;
    }
    frame.scale = m.a;
    frame.ox = m.e;
    frame.oy = m.f;
    frame.dpr = dpr;
    frame.w = c.canvas.width;
    frame.h = c.canvas.height;
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    for (let pass = 0; pass < 2; pass += 1) {
      const wantDim = pass === 1;
      if (wantDim && hood === null) break;
      c.globalAlpha = wantDim ? DIM_ALPHA : 1;
      for (let i = 0; i < count; i += 1) {
        const n = ns[i];
        if (n.alpha < 1 || n.x === undefined || dimmed(n) !== wantDim) continue;
        blit(c, n, k);
      }
    }
    for (let i = 0; i < count; i += 1) {
      const n = ns[i];
      if (n.alpha >= 1 || n.x === undefined) continue;
      c.globalAlpha = n.alpha * (dimmed(n) ? DIM_ALPHA : 1);
      blit(c, n, k);
    }
    c.globalAlpha = 1;
    c.restore();
  }

  /** A thread mid-animation; threads at rest are the library's bundled strokes. */
  function paintLink(link, c, k) {
    const effect = link.effect;
    const s = link.source;
    const t = link.target;
    if (!effect || typeof s !== 'object' || typeof t !== 'object' || s.x === undefined || t.x === undefined) return;
    const p = effect.t;
    let colour = linkColor(link);
    let alpha = 1;
    let width = 1;
    let x2 = t.x;
    let y2 = t.y;
    switch (effect.kind) {
      case 'agreement': // drawn in along its length
        x2 = s.x + (t.x - s.x) * p;
        y2 = s.y + (t.y - s.y) * p;
        break;
      case 'settled': // a green flash, then a dissolve
        colour = palette.paid;
        if (p < FLASH_PART) width = 1 + 2 * (1 - p / FLASH_PART);
        else alpha = 1 - (p - FLASH_PART) / (1 - FLASH_PART);
        break;
      case 'dispute': // amber, with a wider pulse that fades over the lifetime
        colour = palette.amber;
        width = 1.4;
        break;
      case 'resolved': // back from amber to the accent, then a dissolve
        if (p < RETURN_PART) colour = palette.ramp[Math.round((p / RETURN_PART) * 8)];
        else {
          colour = palette.ramp[8];
          alpha = 1 - (p - RETURN_PART) / (1 - RETURN_PART);
        }
        break;
      default:
        break;
    }
    if (hood !== null && !touches(link)) alpha *= DIM_ALPHA;
    c.globalAlpha = alpha;
    c.strokeStyle = colour;
    c.lineWidth = width / k;
    c.beginPath();
    c.moveTo(s.x, s.y);
    c.lineTo(x2, y2);
    c.stroke();
    if (effect.kind === 'dispute') {
      c.globalAlpha = alpha * (1 - p) * 0.6;
      c.lineWidth = (1 + 3 * (1 - p)) / k;
      c.stroke();
    }
    c.globalAlpha = 1;
  }

  /** A particle from a to b along a quadratic curve bent by `bend`, with a short tail; `p` is its progress. */
  function paintParticle(c, k, a, b, p, bend) {
    if (a.x === undefined || b.x === undefined) return;
    const mx = (a.x + b.x) / 2 - (b.y - a.y) * bend;
    const my = (a.y + b.y) / 2 + (b.x - a.x) * bend;
    const q = p < 0.12 ? 0 : p - 0.12;
    const u = 1 - p;
    const v = 1 - q;
    const hx = u * u * a.x + 2 * u * p * mx + p * p * b.x;
    const hy = u * u * a.y + 2 * u * p * my + p * p * b.y;
    const tx = v * v * a.x + 2 * v * q * mx + q * q * b.x;
    const ty = v * v * a.y + 2 * v * q * my + q * q * b.y;
    c.globalAlpha = p > 0.85 ? (1 - p) / 0.15 : 1;
    c.strokeStyle = palette.accent;
    c.lineWidth = 1 / k;
    c.beginPath();
    c.moveTo(tx, ty);
    c.lineTo(hx, hy);
    c.stroke();
    c.fillStyle = palette.accent;
    c.beginPath();
    c.arc(hx, hy, PARTICLE_PX / 2 / k, 0, TAU);
    c.fill();
  }

  /** The lights that are not threads: arcs, rides, bursts, pulses and sparks, each by its `t`. */
  function paintEffects(c, k) {
    const inv = 1 / k;
    for (let i = 0; i < effects.length; i += 1) {
      const e = effects[i];
      const p = e.t;
      switch (e.kind) {
        case 'arc': // a message with no thread
          paintParticle(c, k, e.a, e.b, p, 0.25);
          break;
        case 'ride': // a message running its thread against the thread's direction
          paintParticle(c, k, e.a, e.b, p, 0);
          break;
        case 'settled': {
          // the burst from the provider's point
          const n = e.node;
          if (n.x === undefined) break;
          const particles = e.particles;
          const reach = BURST_PX * inv;
          c.globalAlpha = 1 - p;
          c.fillStyle = palette.paid;
          c.beginPath();
          for (let j = 0; j < particles.length; j += 1) {
            const q = particles[j];
            const d = n.r + q.speed * reach * p;
            const x = n.x + Math.cos(q.angle) * d;
            const y = n.y + Math.sin(q.angle) * d;
            const r = q.size * 2.2 * inv * (1 - p) + 0.01;
            c.moveTo(x + r, y);
            c.arc(x, y, r, 0, TAU);
          }
          c.fill();
          break;
        }
        case 'dispute': {
          // an amber ring growing from each party
          c.globalAlpha = 1 - p;
          c.strokeStyle = palette.amber;
          c.lineWidth = 1.5 * inv;
          c.beginPath();
          for (let j = 0; j < 2; j += 1) {
            const n = j === 0 ? e.a : e.b;
            if (n.x === undefined) continue;
            const r = radiusAt(n, k) + p * PULSE_PX * inv;
            c.moveTo(n.x + r, n.y);
            c.arc(n.x, n.y, r, 0, TAU);
          }
          c.stroke();
          break;
        }
        case 'oracle': {
          // a short spark leaving the point
          const n = e.node;
          if (n.x === undefined) break;
          const from = radiusAt(n, k) + p * SPARK_PX * inv;
          const to = from + SPARK_SEGMENT_PX * inv;
          const cos = Math.cos(e.angle);
          const sin = Math.sin(e.angle);
          c.globalAlpha = 1 - p * p;
          c.strokeStyle = palette.accent;
          c.lineWidth = 1.5 * inv;
          c.beginPath();
          c.moveTo(n.x + cos * from, n.y + sin * from);
          c.lineTo(n.x + cos * to, n.y + sin * to);
          c.stroke();
          break;
        }
        default:
          break;
      }
    }
    c.globalAlpha = 1;
  }

  // ── points and threads ────────────────────────────────────────────────────
  /** Counts a live event against a point and resizes it. */
  const touch = (node) => {
    const at = now();
    const hits = node.hits;
    hits.push(at);
    while (hits.length && hits[0] < at - HOUR_MS) hits.shift();
    sizeNode(node, hits.length);
  };
  /** A point is in dispute while any of its threads is. */
  const refreshDisputed = () => {
    const disputed = new Set();
    for (const link of links.values()) {
      if (link.status !== 'Disputed') continue;
      disputed.add(endId(link.source));
      disputed.add(endId(link.target));
    }
    for (const node of nodes.values()) node.disputed = disputed.has(node.id);
  };
  const removeLink = (link) => {
    link.effect = null;
    if (links.get(link.id) === link) links.delete(link.id);
    refreshDisputed();
    commit();
    nudge();
  };
  /**
   * The thread for a key, making one for the moment when the index never
   * listed the agreement but both parties are on the plate — the parties
   * the caller names (`{ source, target }`, the event's own), else those in
   * the key; null when a party is not on the plate (nothing to draw to).
   */
  const threadFor = (key, status, hint) => {
    const known = links.get(key);
    if (known) return known;
    const fromKey = partiesOfKey(key);
    const buyer = hint?.source ?? fromKey?.buyer;
    const provider = hint?.target ?? fromKey?.provider;
    if (!buyer || !provider || !nodes.has(buyer) || !nodes.has(provider)) return null;
    const link = linkOf({ buyer, provider, seq: fromKey?.seq ?? '', status });
    link.id = key;
    link.origin = 'live';
    links.set(key, link);
    commit();
    return link;
  };
  const placeNear = (node) => {
    // A new point joins inside the constellation, not at the edge of the
    // layout's seed spiral: at the centroid, a little way out.
    const ns = data.nodes;
    let cx = 0;
    let cy = 0;
    let count = 0;
    for (let i = 0; i < ns.length; i += 1) {
      if (ns[i].x === undefined) continue;
      cx += ns[i].x;
      cy += ns[i].y;
      count += 1;
    }
    if (count) {
      cx /= count;
      cy /= count;
    }
    const angle = seq * GOLDEN_ANGLE;
    seq += 1;
    node.x = cx + Math.cos(angle) * 24;
    node.y = cy + Math.sin(angle) * 24;
  };

  const resize = () => {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    if (graph.width() !== w) graph.width(w);
    if (graph.height() !== h) graph.height(h);
  };
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  observer?.observe(host);
  const onDblClick = () => {
    if (!hovered) handle.zoomToFit();
  };
  const onTouched = () => {
    touched = true;
  };
  host.addEventListener('dblclick', onDblClick);
  host.addEventListener('wheel', onTouched, { passive: true });
  host.addEventListener('pointerdown', onTouched, { passive: true });
  const offTheme =
    ctx.bus?.on?.('theme', () => {
      palette = buildPalette(ctx.theme);
      sprites.clear();
      redraw();
    }) ?? null;

  const handle = {
    /** Replaces the point set from a /v1/agents read, keeping every point that stays (and its place). */
    setAgents(items, { names } = {}) {
      const seen = new Set();
      let changed = false;
      for (const agent of items) {
        const id = agent.address;
        if (typeof id !== 'string') continue;
        seen.add(id);
        const fresh = nodeOf(agent, names);
        const node = nodes.get(id);
        if (node) {
          node.name = fresh.name;
          node.operator = fresh.operator;
          node.completed = fresh.completed;
          node.base = fresh.base;
          sizeNode(node, node.hits.length);
        } else {
          nodes.set(id, fresh);
          changed = true;
        }
      }
      for (const [id, node] of nodes) {
        if (seen.has(id)) {
          node.live = false; // the index lists it now
        } else if (!node.live) {
          // A point that joined live (AgentRegistered) stays until the index lists it: the event was real.
          nodes.delete(id);
          changed = true;
        }
      }
      refreshDisputed();
      commit();
      if (changed) nudge();
      flush();
    },

    /** Replaces the index's threads from a /v1/escrows read; threads seen live stay until they settle or resolve. */
    setLinks(items) {
      const seen = new Set();
      for (const escrow of items) {
        const fresh = linkOf(escrow);
        seen.add(fresh.id);
        const link = links.get(fresh.id);
        if (link) {
          if (!link.effect && link.status !== fresh.status) link.status = fresh.status;
          link.origin = 'index';
        } else {
          links.set(fresh.id, fresh);
        }
      }
      for (const [id, link] of links) {
        if (link.origin === 'index' && !seen.has(id) && !link.effect) links.delete(id);
      }
      refreshDisputed();
      commit();
      nudge();
    },

    /** AgreementCreated: the thread is drawn in from buyer to provider over `drawMs`. */
    addLink(link, { drawMs = LIFETIME_MS.agreement } = {}) {
      const id = link.id ?? agreementKey(endId(link.source), endId(link.target), link.seq);
      if (links.has(id)) return links.get(id);
      const thread = linkOf({ buyer: endId(link.source), provider: endId(link.target), seq: link.seq, status: link.status });
      thread.id = id;
      thread.origin = 'live';
      links.set(id, thread);
      const a = nodes.get(endId(thread.source));
      const b = nodes.get(endId(thread.target));
      if (a) touch(a);
      if (b) touch(b);
      if (!reduced && a && b) {
        thread.effect = addEffect({ kind: 'agreement', link: thread, end: () => (thread.effect = null) }, drawMs, { ease: 'power1.out' });
      }
      commit();
      nudge();
      return thread;
    },

    /** DeliveryConfirmed: the thread flashes green, the provider's point bursts, the thread dissolves and goes. `parties` ({ source, target }) names them when the index never listed the thread. */
    settleLink(key, parties) {
      const link = threadFor(key, 'Delivered', parties);
      if (!link) return false;
      link.status = 'Delivered';
      const provider = nodes.get(endId(link.target));
      const buyer = nodes.get(endId(link.source));
      if (provider) {
        provider.completed += 1;
        touch(provider);
      }
      if (buyer) touch(buyer);
      if (reduced || !provider) {
        removeLink(link);
        return true;
      }
      if (link.effect) finish(link.effect);
      seq += 1;
      link.effect = addEffect(
        { kind: 'settled', link, node: provider, particles: burstParticles(BURST_COUNT, seq), end: () => removeLink(link) },
        LIFETIME_MS.settled,
        { ease: 'power2.out' },
      );
      return true;
    },

    /** DisputeOpened: an amber pulse on both parties and the thread; the thread stays amber. `parties` as for settleLink. */
    disputeLink(key, parties) {
      const link = threadFor(key, 'Disputed', parties);
      if (!link) return false;
      link.status = 'Disputed';
      const a = nodes.get(endId(link.source));
      const b = nodes.get(endId(link.target));
      if (a) {
        a.disputed = true;
        touch(a);
      }
      if (b) {
        b.disputed = true;
        touch(b);
      }
      commit();
      if (reduced || !a || !b) return true;
      if (link.effect) finish(link.effect);
      link.effect = addEffect({ kind: 'dispute', link, a, b, end: () => (link.effect = null) }, LIFETIME_MS.dispute, { ease: 'power2.out' });
      return true;
    },

    /** DisputeResolved: the thread returns to the accent and dissolves, then goes. `parties` as for settleLink. */
    resolveLink(key, parties) {
      const link = threadFor(key, 'Disputed', parties);
      if (!link) return false;
      const a = nodes.get(endId(link.source));
      const b = nodes.get(endId(link.target));
      if (a) touch(a);
      if (b) touch(b);
      if (reduced) {
        removeLink(link);
        return true;
      }
      if (link.effect) finish(link.effect);
      link.effect = addEffect({ kind: 'resolved', link, end: () => removeLink(link) }, LIFETIME_MS.resolved, { ease: 'none' });
      return true;
    },

    /**
     * MessageSent: a particle along the agreement's thread — the library's
     * own single-hop particle when the message runs the thread's way (buyer →
     * provider), a particle of this module's when it runs back, since the
     * library's only run forward — or a short arc when the message has no
     * thread.
     */
    message(from, to, key = null) {
      const a = nodes.get(from);
      const b = nodes.get(to);
      if (a) touch(a);
      if (b) touch(b);
      if (reduced || !a || !b) return false;
      const link = key ? links.get(key) : null;
      if (link && typeof link.source !== 'object') flush();
      const going = link && link.effect && (link.effect.kind === 'settled' || link.effect.kind === 'resolved');
      if (link && !going && typeof link.source === 'object') {
        if (endId(link.source) !== from) {
          addEffect({ kind: 'ride', a, b }, LIFETIME_MS.message, { ease: 'none' });
          return true;
        }
        graph.emitParticle(link);
        const photon = link.__photons[link.__photons.length - 1];
        addEffect(
          {
            kind: 'message',
            link,
            photon,
            end: () => {
              const i = link.__photons ? link.__photons.indexOf(photon) : -1;
              if (i >= 0) link.__photons.splice(i, 1);
            },
          },
          LIFETIME_MS.message,
          null,
        );
        return true;
      }
      addEffect({ kind: 'arc', a, b }, ARC_MS, { ease: 'power1.inOut' });
      return true;
    },

    /** An oracle answer: a short spark leaves the answering agent's point. */
    spark(address) {
      const node = nodes.get(address);
      if (!node) return false;
      touch(node);
      if (reduced) return false;
      const angle = seq * GOLDEN_ANGLE;
      seq += 1;
      addEffect({ kind: 'oracle', node, angle }, LIFETIME_MS.oracle, { ease: 'power1.out' });
      return true;
    },

    /** AgentRegistered: the point joins and fades in over 600 ms. */
    registered(address, node = {}) {
      const known = nodes.get(address);
      if (known) return known;
      const fresh = nodeOf({ address, name: node.name, activeEscrowCount: 0, completedAgreements: node.completed ?? 0 }, null);
      if (typeof node.operator === 'boolean') fresh.operator = node.operator;
      placeNear(fresh);
      fresh.live = true;
      nodes.set(address, fresh);
      if (!reduced) {
        fresh.alpha = 0;
        const effect = {
          kind: 'registered',
          node: fresh,
          end: () => {
            fresh.alpha = 1;
          },
        };
        addEffect(effect, LIFETIME_MS.registered, {
          ease: 'power1.out',
          onUpdate: () => {
            fresh.alpha = effect.t;
          },
        });
      }
      commit();
      nudge();
      return fresh;
    },

    /** Brightens an agent's threads and neighbours and dims the rest; null releases. */
    follow(address) {
      flush();
      if (address && nodes.has(address)) {
        followed = address;
        hood = neighbourhood(data.links, address);
      } else {
        followed = null;
        hood = null;
      }
      redraw();
    },

    zoomToFit() {
      flush();
      graph.zoomToFit(reduced ? 0 : 400, 48);
    },

    /**
     * Switches the plate between live and static (prefers-reduced-motion
     * changing while the page is open): static ends every light at once,
     * cools the layout and stops the engine; live warms the layout a little
     * and lets it drift again.
     */
    setStatic(flag) {
      const next = Boolean(flag);
      if (next === reduced) return;
      reduced = next;
      gsap.killTweensOf(sim);
      warming = false;
      if (reduced) {
        while (effects.length) finish(effects[0]);
        sim.heat = 0;
        graph.cooldownTicks(0);
        commit();
      } else {
        graph.cooldownTicks(Infinity).warmupTicks(0);
        sim.heat = EVENT_HEAT;
        graph.d3ReheatSimulation(); // only to start the engine: this module's force ignores the library's alpha
        settle(SETTLE_S);
      }
    },

    pause() {
      graph.pauseAnimation();
      gsap.globalTimeline.pause();
    },

    resume() {
      gsap.globalTimeline.resume();
      graph.resumeAnimation();
    },

    destroy() {
      destroyed = true;
      gsap.killTweensOf(sim);
      for (const effect of effects) effect.tween?.kill();
      effects = [];
      observer?.disconnect();
      host.removeEventListener('dblclick', onDblClick);
      host.removeEventListener('wheel', onTouched);
      host.removeEventListener('pointerdown', onTouched);
      offTheme?.();
      // The destructor's own (debounced) empty update must find no threads of ours.
      nodes.clear();
      links.clear();
      data.nodes = [];
      data.links = [];
      sprites.clear();
      graph._destructor();
    },

    /** Live effects on screen now. */
    effectCount() {
      return effects.length;
    },

    /** Frames painted in the last second. */
    fps() {
      const since = performance.now() - 1000;
      let count = 0;
      for (let i = 0; i < FRAME_RING; i += 1) if (frames[i] > since) count += 1;
      return count;
    },

    /** The followed agent, for the page's own state. */
    following: () => followed,
    /** The layout's heat now, for the harness. */
    heat: () => sim.heat,
    /** Points and threads on the plate now, for the harness. */
    counts: () => ({ nodes: nodes.size, links: links.size, shown: data.links.length }),
  };
  return handle;
}
