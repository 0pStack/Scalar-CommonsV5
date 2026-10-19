// Readouts: the figure, its provenance line, and the link to the raw bytes.
//
// A reading is an element carrying `data-reading`, with a `.reading-value`
// slot and a `.reading-prov` slot inside it. Three states are possible and
// they are mutually exclusive: a value, "unavailable" with a reason, or "—"
// with a reason (a figure that cannot exist yet). None of them ever leaves a
// previous value standing.

import { formatInteger, utcTime } from './format.js';

/** Object URLs for raw responses, so a figure can link to the bytes it came from. */
const snapshots = new WeakMap();

export function snapshotUrl(record) {
  if (!record || record.raw === null || record.raw === undefined) return null;
  const existing = snapshots.get(record);
  if (existing) return existing;
  const url = URL.createObjectURL(new Blob([record.raw], { type: 'application/json' }));
  snapshots.set(record, url);
  return url;
}

/** Wraps `content` in a link to the record's raw bytes, opening in a new tab. */
export function rawLink(record, content, { className = 'num' } = {}) {
  const url = snapshotUrl(record);
  if (!url) return content;
  const a = document.createElement('a');
  a.className = className;
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  const hint = document.createElement('span');
  hint.className = 'visually-hidden';
  hint.textContent = ' (raw response, opens in a new tab)';
  a.append(content, hint);
  return a;
}

/** Fills the provenance line: endpoint (linked when it can be re-opened) · time · extra. */
export function provenance(target, record, extra = '') {
  const prov = target.querySelector('.reading-prov');
  if (!prov) return;
  prov.replaceChildren();
  if (record.link) {
    const a = document.createElement('a');
    a.href = record.link;
    a.target = '_blank';
    a.rel = 'noopener';
    a.append(...wrappableLabel(record.label));
    prov.append(a);
  } else {
    prov.append(...wrappableLabel(record.label));
  }
  prov.append(` · ${utcTime(record.at)}${extra ? ` · ${extra}` : ''}`);
}

/**
 * An endpoint label as text nodes with a break opportunity after each `?`
 * and `&`, so a long query wraps at its parameters rather than mid-word.
 */
export function wrappableLabel(label) {
  const parts = [];
  let start = 0;
  for (let i = 0; i < label.length; i += 1) {
    if (label[i] === '?' || label[i] === '&') {
      parts.push(document.createTextNode(label.slice(start, i + 1)), document.createElement('wbr'));
      start = i + 1;
    }
  }
  parts.push(document.createTextNode(label.slice(start)));
  return parts;
}

/**
 * Sets a figure's text. The display face (Source Serif 4) has real tabular
 * lining figures, switched on by the stylesheet (`font-variant-numeric:
 * tabular-nums lining-nums`), so a figure that counts up moves nothing beside
 * it without any per-digit markup, and a screen reader reads it once, whole.
 */
export function setFigure(node, text) {
  node.replaceChildren(document.createTextNode(String(text)));
}

/** Counts from the previous integer to the new one over 200 ms, if motion is allowed. */
function tick(digits, from, to, motion) {
  if (!motion || motion.reduced() || document.hidden || !(to > from) || to - from > 100_000) {
    setFigure(digits, formatInteger(to));
    return;
  }
  motion.tween(200, (t) => {
    setFigure(digits, formatInteger(Math.round(from + (to - from) * t)));
  });
}

/**
 * Shows a figure. `value` is a number (ticked when it rises) or a string.
 * `prefix` and `unit` sit around the figure; `sub` is a second line under it;
 * `extra` is appended to the provenance line. `record` is the response the
 * figure was read from. `live: false` marks a historical figure, which takes
 * no glow. When nothing visible changed, only the provenance line is
 * refreshed, so a polite live region is not re-announced every poll.
 */
export function showValue(target, record, { value, prefix = '', unit = '', sub = '', extra = '', motion = null, live = true }) {
  if (!target) return;
  const slot = target.querySelector('.reading-value');
  const shown = `${prefix}\u0000${value}\u0000${unit}\u0000${sub}`;
  if (slot.dataset.shown === shown && slot.querySelector('a.num, .digits')) {
    // Same figure: relink the raw bytes to the new record and refresh provenance.
    const link = slot.querySelector('a.num');
    const url = snapshotUrl(record);
    if (link && url) link.href = url;
    provenance(target, record, extra);
    return;
  }
  slot.dataset.shown = shown;
  const before = slot.dataset.number;
  slot.classList.remove('is-loading', 'is-error', 'is-absent');
  slot.classList.toggle('is-live', live);

  const digits = document.createElement('span');
  digits.className = 'digits';
  const figure = document.createDocumentFragment();
  if (prefix) figure.append(prefix);
  figure.append(digits);
  slot.replaceChildren(rawLink(record, figure));
  if (unit) {
    const u = document.createElement('span');
    u.className = 'unit';
    u.textContent = unit;
    slot.append(u);
  }
  if (sub) {
    // A second line under the figure, in the reading's own voice: a derived
    // quantity that belongs with the figure rather than with its provenance.
    const s = document.createElement('span');
    s.className = 'sub';
    s.textContent = sub;
    slot.append(s);
  }

  if (typeof value === 'number') {
    const previous = before === undefined ? NaN : Number(before);
    if (Number.isFinite(previous)) tick(digits, previous, value, motion);
    else setFigure(digits, formatInteger(value));
    slot.dataset.number = String(value);
  } else {
    digits.textContent = value;
    delete slot.dataset.number;
  }
  provenance(target, record, extra);
}

/** Replaces a figure with the reason it could not be read. Never keeps the old value. */
export function showError(target, record, reason = record?.error ?? 'unavailable') {
  if (!target) return;
  const slot = target.querySelector('.reading-value');
  slot.classList.remove('is-loading', 'is-absent', 'is-live');
  slot.classList.add('is-error');
  delete slot.dataset.number;
  delete slot.dataset.shown;
  const word = document.createElement('span');
  word.className = 'unavailable';
  word.textContent = 'unavailable';
  slot.replaceChildren(record?.raw ? rawLink(record, word) : word);
  const why = document.createElement('span');
  why.className = 'error';
  why.textContent = reason;
  slot.append(why);
  if (record) provenance(target, record, 'failed');
}

/** A reading with no figure to show yet, for a stated reason. */
export function showAbsent(target, record, reason) {
  if (!target) return;
  const slot = target.querySelector('.reading-value');
  slot.classList.remove('is-loading', 'is-error', 'is-live');
  slot.classList.add('is-absent');
  delete slot.dataset.number;
  delete slot.dataset.shown;
  const dash = document.createElement('span');
  dash.className = 'digits';
  dash.textContent = '—';
  const why = document.createElement('span');
  why.className = 'error';
  why.textContent = reason;
  slot.replaceChildren(dash, why);
  if (record) provenance(target, record);
}

/**
 * Runs `render` against a record, turning any missing field into an honest
 * failure on every reading the source feeds. Returns true on success.
 */
export function apply(targets, record, render) {
  const list = Array.isArray(targets) ? targets : [targets];
  if (!record || !record.ok) {
    for (const target of list) showError(target, record);
    return false;
  }
  try {
    render(record.data, record);
    return true;
  } catch (error) {
    for (const target of list) showError(target, record, error.message);
    return false;
  }
}

/** Copy controls: a `button.copy[data-copy]` copies its value and confirms. */
export function bindCopyButtons(root, announce) {
  root.addEventListener('click', async (event) => {
    const button = event.target.closest?.('button.copy');
    if (!button) return;
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = 'Copied';
      announce?.('Copied to clipboard');
    } catch {
      button.textContent = 'Select and copy';
      announce?.('Copy failed; select the text to copy it');
    }
    setTimeout(() => {
      button.textContent = 'Copy';
    }, 2000);
  });
  for (const button of root.querySelectorAll('button.copy')) button.hidden = false;
}
