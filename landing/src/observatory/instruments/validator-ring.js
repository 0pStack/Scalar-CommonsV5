// 04 · Validator ring. The active validator set as points on a hairline
// ring, chords between them, and the two things a public node can honestly
// say about each validator: which one sealed each block as it arrived, and
// whether its finality vote was seen in the rounds sampled while this page
// was open. The health of the one node the page reads from sits beside it,
// because that is the only node whose peer count and sync state the public
// RPC reports.
//
// Data: `Session.Validators`, `Session.QueuedKeys` and `Babe.Authorities`
// read raw off the node every minute and decoded here (../scale.js); the
// block author is decoded from each header's BABE pre-digest as it arrives
// (the hero emits `head` on the page bus; on its own, in the harness, the
// ring subscribes itself); `grandpa_roundState` every 6 s for the finality
// vote sample; `system_health` every 30 s for the node.
//
// Motion: when a block is sealed the "sealing now" mark — the accent fill,
// a ring and the words — moves to the validator that sealed it and a halo
// expands and fades once, so the ring is seen to rotate block by block; a
// new vote tick fades in once when a sample adds it. Nothing moves between
// data changes. Points are labelled "Validator 1" to "Validator n"; the
// address is a tooltip on the point and a link in the list.

import { decodeValidators, decodeQueuedKeys, decodeBabeAuthorities, bytesToHex, babePreDigestOf } from '../scale.js';
import { encodeSs58 } from '../ss58.js';

const SET_INTERVAL_MS = 60_000;
const HEALTH_INTERVAL_MS = 30_000;
const GRANDPA_INTERVAL_MS = 6_000;
const HALO_MS = 700;
const TICK_FADE_MS = 200;
/** Rounds a validator's vote ticks need before they are drawn: the list carries the count from the first. */
export const MIN_SAMPLES = 3;
/** How many of the most recent sampled rounds a point carries as ticks; the list carries the whole count. */
export const VOTE_TICKS = 12;
/** Above this many validators the ring draws only neighbouring chords; every pair would be a disc. */
export const ALL_CHORDS_UP_TO = 12;
export const SS58_FORMAT = 42;

/** The SVG's coordinate space: a 320-unit square; the ring scales to its box. */
export const SIZE = 320;
export const CENTRE = SIZE / 2;
export const RADIUS = 96;
export const POINT_R = 7;
export const LATEST_R = 10; // the 1 px circle that marks the point that sealed the latest block
export const VOTE_TICK_IN = 12; // the vote ticks sit in this band around each point
export const VOTE_TICK_OUT = 16;
export const TICK_FROM = RADIUS + 19; // hairline from outside the vote band to the label
export const TICK_TO = RADIUS + 25;
export const LABEL_R = RADIUS + 31;
/** Horizontal room added to the viewBox when the side labels carry an address. */
export const LABEL_PAD = 24;
/** Rendered text sizes, in CSS px, held constant whatever the ring's scale (see the CSS). */
export const INDEX_PX = 12;
export const ADDR_PX = 11;
const CHAR_EM = 0.6; // a mono advance width, in em (JetBrains Mono: 600 of 1000 units)
const ASCENT = 0.75;
const DESCENT = 0.25;
/** The ring label of a validator queued for the next session; the list carries the full phrase. */
export const QUEUED_LABEL = 'queued';
/** The ring label of a validator: its position, in words. */
export const ringLabelText = (index) => `Validator ${index + 1}`;
/** The words that travel with the sealing mark. */
export const SEALING_LABEL = 'sealing now';

// ── pure helpers (unit-tested) ────────────────────────────────────────────────

const fix = (n) => Number(n.toFixed(3));

/** A point at `angle` radians (0 at three o'clock, clockwise positive in SVG). */
export function pointAt(angle, r, cx = CENTRE, cy = CENTRE) {
  return { x: fix(cx + r * Math.cos(angle)), y: fix(cy + r * Math.sin(angle)) };
}

/** `count` positions evenly spaced around the ring, the first at twelve o'clock, clockwise. */
export function ringPositions(count, r = RADIUS, cx = CENTRE, cy = CENTRE) {
  const out = [];
  for (let k = 0; k < count; k += 1) {
    const angle = -Math.PI / 2 + (count > 0 ? (k / count) * 2 * Math.PI : 0);
    out.push({ index: k, angle, ...pointAt(angle, r, cx, cy) });
  }
  return out;
}

/**
 * Which pairs of the first `count` points are joined by a chord: every pair
 * up to ALL_CHORDS_UP_TO points (n(n−1)/2 of them), neighbours only above.
 */
export function chordPairs(count) {
  const pairs = [];
  if (count < 2) return pairs;
  if (count <= ALL_CHORDS_UP_TO) {
    for (let i = 0; i < count; i += 1) for (let j = i + 1; j < count; j += 1) pairs.push([i, j]);
    return pairs;
  }
  for (let i = 0; i < count; i += 1) pairs.push([i, (i + 1) % count]);
  return pairs;
}

/** Where a label sits relative to its point: text-anchor by side of the ring. */
export function labelAnchor(angle) {
  const c = Math.cos(angle);
  if (c > 0.2) return 'start';
  if (c < -0.2) return 'end';
  return 'middle';
}

/**
 * Where a point's label goes and the box it occupies, in SVG units. The
 * block is pushed away from the point on every side: above the tick at the
 * top (address over index), below it at the bottom, beside it elsewhere. Text
 * is drawn at a constant rendered size, so its size in units is the rendered
 * size divided by `scale` (rendered px per unit).
 */
export function labelPlacement(angle, { scale = 1, showAddress = false, indexDigits = 1, addrChars = 9 } = {}) {
  const at = pointAt(angle, LABEL_R);
  const s = Math.sin(angle);
  const anchor = labelAnchor(angle);
  const fi = INDEX_PX / scale;
  const fa = ADDR_PX / scale;
  const gap = fix(fa * 1.25);
  let indexY;
  let addrY;
  if (s < -0.6) {
    indexY = at.y - 2;
    addrY = indexY - gap;
  } else if (s > 0.6) {
    indexY = at.y + fi * ASCENT;
    addrY = indexY + gap;
  } else {
    indexY = at.y + fi * 0.35;
    addrY = indexY + gap;
  }
  indexY = fix(indexY);
  addrY = fix(addrY);
  const width = Math.max(indexDigits * CHAR_EM * fi, showAddress ? addrChars * CHAR_EM * fa : 0);
  const x0 = anchor === 'start' ? at.x : anchor === 'end' ? at.x - width : at.x - width / 2;
  const tops = [indexY - fi * ASCENT];
  const bottoms = [indexY + fi * DESCENT];
  if (showAddress) {
    tops.push(addrY - fa * ASCENT);
    bottoms.push(addrY + fa * DESCENT);
  }
  return {
    x: at.x,
    anchor,
    indexY,
    addrY,
    box: { x0: fix(x0), y0: fix(Math.min(...tops)), x1: fix(x0 + width), y1: fix(Math.max(...bottoms)) },
  };
}

/**
 * The viewBox and text scale for a ring of `labels` (one `{ indexDigits,
 * addrChars }` per point) in a host `hostWidth` px wide. Addresses are shown
 * only when `wide` and when every label then stays inside a viewBox widened
 * by LABEL_PAD on each side; otherwise the ring is compact (index only, no
 * padding) so no label ever leaves the plate.
 */
export function ringLayout(labels, hostWidth, wide = true) {
  const compact = { compact: true, viewBox: [0, 0, SIZE, SIZE], scale: hostWidth / SIZE };
  if (!wide || !(hostWidth > 0) || labels.length === 0) return compact;
  const width = SIZE + 2 * LABEL_PAD;
  const scale = hostWidth / width;
  const positions = ringPositions(labels.length);
  const fits = positions.every((p, k) => {
    const { box } = labelPlacement(p.angle, { scale, showAddress: true, ...labels[k] });
    return box.x0 >= -LABEL_PAD && box.x1 <= SIZE + LABEL_PAD && box.y0 >= 0 && box.y1 <= SIZE;
  });
  return fits ? { compact: false, viewBox: [-LABEL_PAD, 0, width, SIZE], scale } : compact;
}

/**
 * The vote ticks around a point: one short radial hairline per sampled round,
 * the oldest at the point's twelve o'clock, clockwise, `VOTE_TICKS` to a full
 * turn. `recent` is the newest-last list of `{ seen }` for that validator.
 */
export function voteTicks(recent, cx, cy) {
  const shown = recent.slice(-VOTE_TICKS);
  return shown.map((round, k) => {
    const angle = -Math.PI / 2 + (k / VOTE_TICKS) * 2 * Math.PI;
    const a = pointAt(angle, VOTE_TICK_IN, cx, cy);
    const b = pointAt(angle, VOTE_TICK_OUT, cx, cy);
    return { x1: a.x, y1: a.y, x2: b.x, y2: b.y, seen: Boolean(round.seen) };
  });
}

/**
 * The validator set as the ring shows it, from the three decoded storage
 * values. `validators` is Session.Validators (stash keys), `queued` is
 * Session.QueuedKeys, `babe` is Babe.Authorities. Any of the last two may be
 * null when its read failed: the set is still drawn, and authorship or votes
 * are then reported as unmappable rather than guessed.
 */
export function buildSet({ validators, queued = null, babe = null }) {
  const keysByStash = new Map();
  for (const entry of queued ?? []) {
    keysByStash.set(bytesToHex(entry.stash), {
      babeHex: bytesToHex(entry.babe),
      grandpaAddress: encodeSs58(entry.grandpa, SS58_FORMAT),
    });
  }
  const active = validators.map((key, index) => {
    const stashHex = bytesToHex(key);
    const keys = keysByStash.get(stashHex) ?? null;
    return {
      index,
      stashHex,
      address: encodeSs58(key, SS58_FORMAT),
      babeHex: keys?.babeHex ?? null,
      grandpaAddress: keys?.grandpaAddress ?? null,
      queued: false,
    };
  });
  const activeHex = new Set(active.map((v) => v.stashHex));
  const joining = [];
  for (const entry of queued ?? []) {
    const stashHex = bytesToHex(entry.stash);
    if (activeHex.has(stashHex) || joining.some((v) => v.stashHex === stashHex)) continue;
    joining.push({
      index: active.length + joining.length,
      stashHex,
      address: encodeSs58(entry.stash, SS58_FORMAT),
      babeHex: bytesToHex(entry.babe),
      grandpaAddress: encodeSs58(entry.grandpa, SS58_FORMAT),
      queued: true,
    });
  }
  // BABE authority index → stash, through the babe key each stash queued.
  const stashByBabe = new Map([...active, ...joining].map((v) => [v.babeHex, v.stashHex]));
  const authorities = (babe ?? []).map((entry) => stashByBabe.get(bytesToHex(entry.key)) ?? null);
  return { active, queued: joining, authorities };
}

/**
 * The stash (hex) that sealed a block, from the BABE authority index in its
 * pre-digest; null when the index is beyond the authority list or its key is
 * not in the queued session keys.
 */
export function stashForAuthority(authorityIndex, authorities) {
  if (!Number.isInteger(authorityIndex) || authorityIndex < 0 || authorityIndex >= authorities.length) return null;
  return authorities[authorityIndex] ?? null;
}

/** Why an authority index could not be attributed, in the list's words. `keys` is 'ok', 'pending' (not read yet) or 'failed'. */
export function unmappedReason(authorityIndex, authorities, keys) {
  if (keys === 'pending') return 'sealed before the session keys were read';
  if (keys !== 'ok') return 'session keys unavailable';
  if (!Number.isInteger(authorityIndex) || authorityIndex < 0 || authorityIndex >= authorities.length) {
    return 'beyond the authority list';
  }
  return 'not in queued keys';
}

/**
 * The finality-vote sample. Each `grandpa_roundState` read names the round in
 * progress and, for each of its two vote stages (prevote and precommit), how
 * much voting weight has arrived and which voters are still missing. A sample
 * is evidence about a validator only when a stage had reached the finality
 * threshold: then a voter still missing was absent from a stage that
 * completed without it, rather than merely sampled too early. Rounds turn over
 * faster than the sample (about one a second against one read every 6 s) and
 * round numbers restart at every change of the voter set, so a round is keyed
 * by set id and round number, counted once however often it is sampled, and
 * the result is a sample, never a percentage of all rounds.
 */
export class VoteSampler {
  constructor() {
    this.rounds = new Map(); // `${setId}:${round}` → { ids: Set (in the set at the time), seen: Set }
  }

  /**
   * Records one sample; returns true when it counted as evidence. `prevotes`
   * and `precommits` are `{ currentWeight, missing }` for the round; `ids`
   * are the grandpa addresses of the active validators (null for one whose
   * key is unknown).
   */
  add({ setId, round, threshold, prevotes, precommits }, ids) {
    if (!Number.isInteger(setId)) throw new Error('setId is not an integer');
    if (!Number.isInteger(round)) throw new Error('round is not an integer');
    if (!Number.isInteger(threshold) || threshold < 1) throw new Error('thresholdWeight is not a positive integer');
    for (const stage of [prevotes, precommits]) {
      if (!Number.isInteger(stage?.currentWeight)) throw new Error('currentWeight is not an integer');
      if (!Array.isArray(stage?.missing)) throw new Error('missing is not a list');
    }
    // Only a stage that reached the threshold says anything about who was absent.
    const stages = [prevotes, precommits].filter((stage) => stage.currentWeight >= threshold);
    if (stages.length === 0) return false;
    // A sample taken before any validator's grandpa key is known can be
    // attributed to nobody, so it is not a sampled round.
    if (!ids.some((id) => id !== null && id !== undefined)) return false;
    const key = `${setId}:${round}`;
    let entry = this.rounds.get(key);
    if (!entry) {
      entry = { ids: new Set(), seen: new Set() };
      this.rounds.set(key, entry);
    }
    const absent = stages.map((stage) => new Set(stage.missing.map(String)));
    for (const id of ids) {
      if (id === null || id === undefined) continue;
      entry.ids.add(id);
      if (absent.some((set) => !set.has(id))) entry.seen.add(id);
    }
    return true;
  }

  roundsSampled() {
    return this.rounds.size;
  }

  /** `{ seen, sampled }` for one grandpa address: rounds it was seen voting in, of rounds sampled while it was in the set. */
  countsFor(id) {
    let seen = 0;
    let sampled = 0;
    for (const entry of this.rounds.values()) {
      if (!entry.ids.has(id)) continue;
      sampled += 1;
      if (entry.seen.has(id)) seen += 1;
    }
    return { seen, sampled };
  }

  /** The rounds sampled while `id` was in the set, oldest first, each `{ key, seen }`; the last `limit` of them. */
  recentFor(id, limit = VOTE_TICKS) {
    const out = [];
    for (const [key, entry] of this.rounds) {
      if (entry.ids.has(id)) out.push({ key, seen: entry.seen.has(id) });
    }
    return out.slice(-limit);
  }
}

/** "seen sealing 3 blocks · last #820,715", or the honest nothing. Counts are floors: only what arrived while the page was open. */
export function sealedPhrase(sealed, formatInteger) {
  if (!sealed || sealed.count === 0) return 'not seen sealing a block';
  return `seen sealing ${formatInteger(sealed.count)} block${sealed.count === 1 ? '' : 's'} · last #${formatInteger(sealed.last)}`;
}

/** "finality votes seen in 4 of 5 rounds sampled". */
export function votesPhrase(counts, formatInteger) {
  if (!counts || counts.sampled === 0) return 'no finality round sampled yet';
  return `finality votes seen in ${formatInteger(counts.seen)} of ${formatInteger(counts.sampled)} round${counts.sampled === 1 ? '' : 's'} sampled`;
}

/** The one-sentence summary the ring's aria-label carries. */
export function ariaSummary({ active, queued, lastAuthor }) {
  const n = active;
  const parts = [`${n} validator${n === 1 ? '' : 's'} in the active set`];
  if (lastAuthor !== null && lastAuthor !== undefined) parts.push(`validator ${lastAuthor} sealed the latest block`);
  if (queued > 0) parts.push(`${queued} joining next session`);
  return parts.join('; ');
}

/** Identity of a head: height plus state root when the header carries one, so a fork at one height is a new head. */
export function headKey(number, header) {
  return typeof header?.stateRoot === 'string' ? `${number}:${header.stateRoot}` : String(number);
}

// ── the instrument ────────────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, className = '') {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (className) node.setAttribute('class', className);
  return node;
}

function html(name, className = '', text = '') {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function headerNumber(header) {
  const n = header?.number;
  if (typeof n === 'string' && /^0x[0-9a-f]+$/i.test(n)) return parseInt(n, 16);
  if (typeof n === 'number') return n;
  throw new Error('header has no block number');
}

export function init(root, ctx) {
  const svg = root.querySelector('svg.ring');
  const host = root.querySelector('.ring-host') ?? svg.parentElement;
  const list = root.querySelector('.validator-list');
  const note = root.querySelector('.ring-note');
  const targets = {
    validators: ctx.reading('validators', root),
    health: ctx.reading('nodeHealth', root),
  };
  const { formatInteger, shortAddress, utcTime } = ctx.format;

  if (note) {
    note.textContent =
      'Authorship is decoded from each block’s BABE pre-digest as it arrives. Finality (GRANDPA) votes are sampled from grandpa_roundState every 6 s and are a sample, not a count of every round: a round is counted only when a sample caught its votes past the finality threshold, so a validator missing from it was absent from a round that completed without it. Both counts cover only what arrived while this page was open and visible — blocks sealed while this tab was hidden or the live stream was down are not counted, so they are floors. A validator’s own peer count and sync state are not exposed by a public RPC, so they are not shown.';
  }

  // The key to the marks on the ring: with the section's notes when the page
  // folds them (the ring itself says "sealing now" beside the lit point),
  // otherwise in mono under the ring.
  const key = html('p', 'ring-key');
  key.textContent = `lit point, “${SEALING_LABEL}”: sealed the latest block · ticks around a point: the last ${VOTE_TICKS} finality rounds sampled, lit where that validator’s vote was seen · dashed point: joining next session · point at a validator for its address`;
  if (note?.closest('details')) note.before(key);
  else host.after(key);

  // Said once above the list rather than on every row.
  const listHead = html('p', 'ring-list-head eyebrow', 'Since you opened this page');
  list?.before(listHead);

  // A status line for the parts of the picture that have no reading slot of
  // their own: the session keys, the authority list and the vote sample.
  const status = html('p', 'instrument-note ring-status');
  status.hidden = true;
  list?.after(status);

  // ── model ──
  const records = { validators: null, queued: null, babe: null };
  let set = null; // buildSet() output, or null while the validator set is unknown
  let setKey = ''; // signature of the drawn set, to rebuild only on change
  const sealed = new Map(); // stashHex → { count, last }
  const unmapped = new Map(); // authorityIndex → { count, last, reason }
  const sampler = new VoteSampler();
  let grandpaRecord = null;
  let grandpaReads = 0; // reads since the page opened, evidence or not
  let headNote = null; // the latest head that could not be read or attributed
  let lastAuthorHex = null; // stash of the validator that sealed the latest mapped block
  let lastAuthor = null; // its 1-based position, or null
  let lastHead = null;
  let lastHeadNumber = null;
  const nodes = new Map(); // stashHex → { validator, g, point, halo, latest, votes, label, li, meta, ticksKey, cancel }
  let unmappedLi = new Map(); // authorityIndex → { li, meta, label }
  let sealingText = null; // the "sealing now" words, moved to the point that sealed the latest block
  let cancelHalo = () => {};
  let hostWidth = host.clientWidth || SIZE;
  const wideQuery = window.matchMedia ? window.matchMedia('(min-width: 64rem)') : null;
  let layout = ringLayout([], hostWidth, Boolean(wideQuery?.matches));

  // ── layout ──
  function applyLayout() {
    const all = set ? [...set.active, ...set.queued] : [];
    const labels = all.map((v) => ({
      indexDigits: ringLabelText(v.index).length,
      addrChars: v.queued ? QUEUED_LABEL.length : shortAddress(v.address).length,
    }));
    // The address is a tooltip now, not a label, so the ring is always compact.
    layout = ringLayout(labels, hostWidth, false);
    svg.setAttribute('viewBox', layout.viewBox.join(' '));
    svg.style.setProperty('--ring-scale', String(fix(layout.scale)));
    svg.classList.toggle('is-compact', layout.compact);
    for (const node of nodes.values()) placeLabel(node);
  }

  function placeLabel(node) {
    const { validator, label, num, addr, angle } = node;
    const placed = labelPlacement(angle, {
      scale: layout.scale,
      showAddress: validator.queued,
      indexDigits: ringLabelText(validator.index).length,
      addrChars: QUEUED_LABEL.length,
    });
    label.setAttribute('x', placed.x);
    label.setAttribute('text-anchor', placed.anchor);
    num.setAttribute('x', placed.x);
    num.setAttribute('y', placed.indexY);
    addr.setAttribute('x', placed.x);
    addr.setAttribute('y', placed.addrY);
  }

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      const width = host.clientWidth;
      if (width > 0 && width !== hostWidth) {
        hostWidth = width;
        applyLayout();
      }
    }).observe(host);
  }
  wideQuery?.addEventListener('change', applyLayout);

  // ── drawing ──
  function drawUnavailable(reason) {
    nodes.clear();
    setKey = '';
    svg.replaceChildren();
    svg.dataset.state = 'unavailable';
    svg.append(el('circle', { cx: CENTRE, cy: CENTRE, r: RADIUS }, 'ring-track'));
    const centre = el('text', { x: CENTRE, y: CENTRE + 18 }, 'ring-centre');
    centre.textContent = '—';
    const caption = el('text', { x: CENTRE, y: CENTRE + 42 }, 'ring-caption');
    caption.textContent = 'ACTIVE VALIDATORS';
    svg.append(centre, caption);
    svg.setAttribute('aria-label', `The active validator set is unavailable: ${reason}`);
    applyLayout();
    if (list) {
      list.replaceChildren();
      const li = html('li', 'v-unavailable');
      li.append(html('span', 'v-index', '—'), html('span', 'v-meta', `unavailable — ${reason}`));
      list.append(li);
    }
  }

  function buildRing() {
    const all = [...set.active, ...set.queued];
    const positions = ringPositions(all.length);
    nodes.clear();
    svg.replaceChildren();
    svg.dataset.state = 'live';
    svg.append(el('circle', { cx: CENTRE, cy: CENTRE, r: RADIUS }, 'ring-track'));

    const chords = el('g', {}, 'ring-chords');
    for (const [i, j] of chordPairs(set.active.length)) {
      const a = positions[i];
      const b = positions[j];
      chords.append(el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y }, 'ring-chord'));
    }
    svg.append(chords);

    const centre = el('text', { x: CENTRE, y: CENTRE + 18 }, 'ring-centre');
    centre.textContent = formatInteger(set.active.length);
    const caption = el('text', { x: CENTRE, y: CENTRE + 42 }, 'ring-caption');
    caption.textContent = 'ACTIVE VALIDATORS';
    svg.append(centre, caption);

    const points = el('g', {}, 'ring-points');
    for (const validator of all) {
      const p = positions[validator.index];
      const authoring = !validator.queued && validator.stashHex === lastAuthorHex;
      const g = el('g', { 'data-index': validator.index + 1 }, `ring-node${validator.queued ? ' is-queued' : ''}${authoring ? ' is-authoring' : ''}`);
      const halo = el('circle', { cx: p.x, cy: p.y, r: POINT_R, opacity: 0 }, 'ring-halo');
      const votes = el('g', {}, 'ring-votes');
      const latest = el('circle', { cx: p.x, cy: p.y, r: LATEST_R }, 'ring-latest');
      const point = el('circle', { cx: p.x, cy: p.y, r: POINT_R }, `ring-point${validator.queued ? ' is-queued' : ''}${authoring ? ' is-authoring' : ''}`);
      const from = pointAt(p.angle, TICK_FROM);
      const to = pointAt(p.angle, TICK_TO);
      const tick = el('line', { x1: from.x, y1: from.y, x2: to.x, y2: to.y }, 'ring-tick');
      const label = el('text', {}, 'ring-label');
      const num = el('tspan', {}, 'ring-label-index');
      num.textContent = ringLabelText(validator.index);
      const addr = el('tspan', {}, 'ring-label-addr');
      addr.textContent = validator.queued ? QUEUED_LABEL : '';
      label.append(num, addr);
      // The address as a tooltip on the point, and in the accessible name.
      const title = el('title');
      title.textContent = `${ringLabelText(validator.index)} · ${validator.address}${validator.queued ? ' · joining next session' : ''}`;
      g.append(title, halo, votes, latest, point, tick, label);
      g.setAttribute('tabindex', '-1');
      points.append(g);
      nodes.set(validator.stashHex, {
        validator,
        angle: p.angle,
        cx: p.x,
        cy: p.y,
        g,
        point,
        halo,
        latest,
        votes,
        label,
        num,
        addr,
        ticksKey: '',
        cancel: () => {},
      });
    }
    svg.append(points);
    sealingText = el('text', { 'text-anchor': 'middle' }, 'ring-sealing');
    sealingText.textContent = SEALING_LABEL;
    sealingText.setAttribute('opacity', '0');
    svg.append(sealingText);
    applyLayout();
    buildList(all);
    drawVotes();
    updateAria();
    if (lastAuthorHex && nodes.has(lastAuthorHex)) placeSealing(nodes.get(lastAuthorHex));
  }

  /** Moves the "sealing now" words beside the point that sealed the latest block, outside the vote band. */
  function placeSealing(node) {
    if (!sealingText) return;
    const at = pointAt(node.angle, RADIUS - 30);
    sealingText.setAttribute('x', at.x);
    sealingText.setAttribute('y', at.y + 4);
    sealingText.setAttribute('opacity', '1');
  }

  function buildList(all) {
    if (!list) return;
    list.replaceChildren();
    unmappedLi = new Map();
    for (const validator of all) {
      const li = html('li', validator.queued ? 'is-queued' : '');
      li.append(html('span', 'v-index', ringLabelText(validator.index)));
      const addr = html('span', 'v-addr');
      const a = html('a', 'mono', shortAddress(validator.address));
      a.href = `${ctx.EXPLORER_ORIGIN}/account/${validator.address}`;
      a.append(html('span', 'visually-hidden', ` (full address ${validator.address}, on the explorer)`));
      addr.append(a);
      if (validator.queued) addr.append(' ', html('span', 'v-mark', 'joining next session'));
      const meta = html('span', 'v-meta');
      li.append(addr, meta);
      list.append(li);
      const node = nodes.get(validator.stashHex);
      if (node) {
        node.li = li;
        node.meta = meta;
      }
    }
    for (const index of unmapped.keys()) appendUnmapped(index);
    drawMeta();
  }

  function appendUnmapped(index) {
    if (!list) return;
    const li = html('li', 'is-unmapped');
    li.append(html('span', 'v-index', '?'));
    const label = html('span', 'v-addr mono');
    const meta = html('span', 'v-meta');
    li.append(label, meta);
    list.append(li);
    unmappedLi.set(index, { li, meta, label });
  }

  function drawMeta() {
    const failed = grandpaRecord && !grandpaRecord.ok ? ' · latest finality sample failed' : '';
    for (const node of nodes.values()) {
      if (!node.meta) continue;
      const { validator } = node;
      if (validator.queued) {
        node.meta.textContent = 'queued for the next session — not yet sealing blocks or voting';
        continue;
      }
      const seal = sealedPhrase(sealed.get(validator.stashHex), formatInteger);
      const votes = validator.grandpaAddress
        ? votesPhrase(sampler.countsFor(validator.grandpaAddress), formatInteger)
        : 'finality key not in the queued session keys, so votes cannot be attributed';
      const latest = validator.stashHex === lastAuthorHex ? ' · sealed the latest block' : '';
      node.meta.textContent = `${seal}${latest} · ${votes}${failed}`;
    }
    for (const [index, { meta, label }] of unmappedLi) {
      const entry = unmapped.get(index);
      label.textContent = `authority #${formatInteger(index)} (${entry.reason})`;
      meta.textContent = sealedPhrase(entry, formatInteger);
    }
  }

  function drawVotes() {
    for (const node of nodes.values()) {
      const { validator } = node;
      if (validator.queued || !validator.grandpaAddress) continue;
      const counts = sampler.countsFor(validator.grandpaAddress);
      const recent = counts.sampled >= MIN_SAMPLES ? sampler.recentFor(validator.grandpaAddress) : [];
      const ticksKey = recent.map((r) => `${r.key}${r.seen ? '+' : '-'}`).join(',');
      if (ticksKey === node.ticksKey) continue;
      const before = node.ticksKey ? node.ticksKey.split(',').length : 0;
      node.ticksKey = ticksKey;
      node.cancel();
      node.votes.replaceChildren();
      const fresh = [];
      voteTicks(recent, node.cx, node.cy).forEach((t, k) => {
        const line = el('line', { x1: t.x1, y1: t.y1, x2: t.x2, y2: t.y2 }, `ring-vote-tick${t.seen ? ' is-seen' : ''}`);
        node.votes.append(line);
        if (k >= before) fresh.push(line);
      });
      // A newly sampled round fades in once.
      if (fresh.length > 0) {
        node.cancel = ctx.motion.tween(TICK_FADE_MS, (t) => {
          for (const line of fresh) line.setAttribute('opacity', String(t));
        });
      }
    }
  }

  function updateAria() {
    if (!set) return;
    svg.setAttribute('aria-label', ariaSummary({ active: set.active.length, queued: set.queued.length, lastAuthor }));
  }

  /** Marks `node` as the point that sealed the latest block, with one halo beat. The mark stays until the next mapped head. */
  function light(node) {
    cancelHalo();
    for (const other of nodes.values()) {
      other.g.classList.remove('is-authoring');
      other.point.classList.remove('is-authoring');
      other.halo.setAttribute('opacity', '0');
      other.halo.setAttribute('r', String(POINT_R));
    }
    node.g.classList.add('is-authoring');
    node.point.classList.add('is-authoring');
    placeSealing(node);
    if (ctx.motion.reduced()) return;
    cancelHalo = ctx.motion.tween(
      HALO_MS,
      (t) => {
        node.halo.setAttribute('r', String(POINT_R + 22 * t));
        node.halo.setAttribute('opacity', String(0.9 * (1 - t)));
      },
      {
        done: () => {
          node.halo.setAttribute('opacity', '0');
          node.halo.setAttribute('r', String(POINT_R));
        },
      },
    );
  }

  // ── status line ──
  function statusLine(parts) {
    const line = html('span', 'ring-status-line');
    for (const part of parts) line.append(part);
    return line;
  }

  function drawStatus() {
    const lines = [];
    if (records.queued && !records.queued.ok) {
      lines.push(statusLine([`Session keys unavailable (${records.queued.label}): ${records.queued.error} — blocks cannot be attributed to a validator.`]));
    } else if (records.queued?.ok && set) {
      const joining = set.queued.length
        ? `${formatInteger(set.queued.length)} more joining next session`
        : 'none queued to join';
      lines.push(statusLine([`${records.queued.label} · ${utcTime(records.queued.at)} · ${joining}.`]));
    }
    if (records.babe && !records.babe.ok) {
      lines.push(statusLine([`Authority list unavailable (${records.babe.label}): ${records.babe.error} — blocks cannot be attributed to a validator.`]));
    }
    if (grandpaRecord) {
      if (grandpaRecord.ok) {
        try {
          const round = ctx.field(grandpaRecord.data, 'result.best.round');
          const total = ctx.field(grandpaRecord.data, 'result.best.totalWeight');
          const threshold = ctx.field(grandpaRecord.data, 'result.best.thresholdWeight');
          const num = (n) => ctx.readout.rawLink(grandpaRecord, html('span', '', formatInteger(n)));
          const counted = sampler.roundsSampled();
          lines.push(
            statusLine([
              `${grandpaRecord.label} · ${utcTime(grandpaRecord.at)} · finality round `,
              num(round),
              ' · ',
              num(threshold),
              ' of ',
              num(total),
              ` votes make a block final · ${formatInteger(counted)} round${counted === 1 ? '' : 's'} counted from ${formatInteger(grandpaReads)} read${grandpaReads === 1 ? '' : 's'} since you opened this page.`,
            ]),
          );
        } catch (error) {
          lines.push(statusLine([`Finality sample could not be read (${grandpaRecord.label}): ${error.message}`]));
        }
      } else {
        lines.push(statusLine([`Finality sample unavailable (${grandpaRecord.label}): ${grandpaRecord.error}`]));
      }
    }
    if (headNote) lines.push(statusLine([headNote]));
    status.replaceChildren(...lines);
    status.hidden = lines.length === 0;
  }

  // ── data ──
  function rebuild() {
    const record = records.validators;
    if (!record) return;
    let failure = null;
    const ok = ctx.readout.apply(targets.validators, record, (data) => {
      try {
        const validators = decodeValidators(ctx.field(data, 'result'));
        let queued = null;
        let babe = null;
        if (records.queued?.ok) {
          try {
            queued = decodeQueuedKeys(ctx.field(records.queued.data, 'result'));
          } catch (error) {
            records.queued = { ...records.queued, ok: false, error: error.message };
          }
        }
        if (records.babe?.ok) {
          try {
            babe = decodeBabeAuthorities(ctx.field(records.babe.data, 'result'));
          } catch (error) {
            records.babe = { ...records.babe, ok: false, error: error.message };
          }
        }
        set = buildSet({ validators, queued, babe });
        ctx.readout.showValue(targets.validators, record, { value: set.active.length, motion: ctx.motion });
        const signature = [...set.active, ...set.queued].map((v) => `${v.stashHex}:${v.queued ? 'q' : 'a'}:${v.grandpaAddress ?? ''}`).join('|');
        if (signature !== setKey) {
          setKey = signature;
          buildRing();
        }
        reattribute();
      } catch (error) {
        failure = error.message;
        throw error;
      }
    });
    if (!ok) {
      set = null;
      drawUnavailable(record.error ?? failure ?? 'the validator set could not be decoded');
    }
    drawStatus();
  }

  /**
   * Blocks that arrived before the session keys were read carry an authority
   * index nobody could be matched to yet. Once the keys are in, the index is
   * matched the same way a fresh head would be and the count moves to that
   * validator's row; nothing is guessed, the mapping is simply late.
   */
  function reattribute() {
    let changed = false;
    for (const [index, entry] of [...unmapped]) {
      const stashHex = stashForAuthority(index, set.authorities);
      const node = stashHex ? nodes.get(stashHex) : null;
      if (!node) continue;
      const own = sealed.get(stashHex) ?? { count: 0, last: null };
      own.count += entry.count;
      own.last = Math.max(own.last ?? 0, entry.last);
      sealed.set(stashHex, own);
      unmapped.delete(index);
      unmappedLi.get(index)?.li.remove();
      unmappedLi.delete(index);
      if (entry.last === lastHeadNumber && lastAuthorHex === null) {
        lastAuthorHex = stashHex;
        lastAuthor = node.validator.index + 1;
        node.g.classList.add('is-authoring');
        node.point.classList.add('is-authoring');
        placeSealing(node);
      }
      changed = true;
    }
    if (changed) {
      drawMeta();
      updateAria();
    }
  }

  function onGrandpa(record) {
    grandpaRecord = record;
    grandpaReads += 1;
    if (record.ok && set) {
      try {
        const sample = {
          setId: ctx.field(record.data, 'result.setId'),
          round: ctx.field(record.data, 'result.best.round'),
          threshold: ctx.field(record.data, 'result.best.thresholdWeight'),
          prevotes: {
            currentWeight: ctx.field(record.data, 'result.best.prevotes.currentWeight'),
            missing: ctx.field(record.data, 'result.best.prevotes.missing'),
          },
          precommits: {
            currentWeight: ctx.field(record.data, 'result.best.precommits.currentWeight'),
            missing: ctx.field(record.data, 'result.best.precommits.missing'),
          },
        };
        sampler.add(sample, set.active.map((v) => v.grandpaAddress));
      } catch (error) {
        grandpaRecord = { ...record, ok: false, error: error.message };
      }
    }
    drawVotes();
    drawMeta();
    drawStatus();
  }

  function onHealth(record) {
    ctx.readout.apply(targets.health, record, (data) => {
      const peers = ctx.field(data, 'result.peers');
      const syncing = ctx.field(data, 'result.isSyncing');
      ctx.readout.showValue(targets.health, record, {
        value: peers,
        unit: peers === 1 ? ' peer' : ' peers',
        extra: syncing === true ? 'catching up' : 'synced',
        motion: ctx.motion,
      });
    });
  }

  function onHead({ number, header, author, forked }) {
    if (!set) return;
    const id = headKey(number, header);
    if (!forked && id === lastHead) return;
    lastHead = id;
    lastHeadNumber = number;
    if (!author) return; // no BABE pre-digest on this header: nothing to attribute
    if (author.error) {
      headNote = `Block #${formatInteger(number)}: its author could not be decoded — ${author.error}`;
      drawStatus();
      return;
    }
    const stashHex = stashForAuthority(author.authorityIndex, set.authorities);
    const node = stashHex ? nodes.get(stashHex) : null;
    if (!node) {
      const keys = !records.queued || !records.babe ? 'pending' : records.queued.ok && records.babe.ok ? 'ok' : 'failed';
      const reason = unmappedReason(author.authorityIndex, set.authorities, keys);
      const entry = unmapped.get(author.authorityIndex) ?? { count: 0, last: null, reason };
      entry.count += 1;
      entry.last = number;
      entry.reason = reason;
      unmapped.set(author.authorityIndex, entry);
      if (!unmappedLi.has(author.authorityIndex)) appendUnmapped(author.authorityIndex);
      lastAuthor = null;
      lastAuthorHex = null;
      for (const other of nodes.values()) {
        other.g.classList.remove('is-authoring');
        other.point.classList.remove('is-authoring');
      }
      sealingText?.setAttribute('opacity', '0');
      drawMeta();
      updateAria();
      return;
    }
    const entry = sealed.get(stashHex) ?? { count: 0, last: null };
    entry.count += 1;
    entry.last = number;
    sealed.set(stashHex, entry);
    lastAuthor = node.validator.index + 1;
    lastAuthorHex = stashHex;
    light(node);
    drawMeta();
    updateAria();
  }

  ctx.watch('validators', (record) => { records.validators = record; rebuild(); }, SET_INTERVAL_MS);
  ctx.watch('queuedKeys', (record) => { records.queued = record; rebuild(); }, SET_INTERVAL_MS);
  ctx.watch('babeAuthorities', (record) => { records.babe = record; rebuild(); }, SET_INTERVAL_MS);
  ctx.watch('health', onHealth, HEALTH_INTERVAL_MS);
  ctx.watch('grandpa', onGrandpa, GRANDPA_INTERVAL_MS);

  ctx.bus.on('head', onHead);
  // On its own (the harness), with no hero to emit `head`, the ring listens to
  // new heads itself and decodes the author the same way the hero does.
  if (!root.ownerDocument.querySelector('[data-instrument="pulse"]')) {
    ctx.subscribe('newHeads', (record) => {
      const header = record.data;
      let number;
      try {
        number = headerNumber(header);
      } catch (error) {
        headNote = `A new head could not be read: ${error.message}`;
        drawStatus();
        return;
      }
      let author = null;
      try {
        author = babePreDigestOf(header);
      } catch (error) {
        author = { error: error.message };
      }
      onHead({ record, number, header, author, forked: false });
    });
  }
}
