// 02 · Economy — the era dial. A circular gauge of the era in progress: the arc fills from
// twelve o'clock as blocks are produced, and when it meets the settlement mark
// the era is due — rewards are computed from the work actually done, and
// anyone may trigger the settlement.
//
// Data: `/v1/eras/current` every 6 s for the position of the era (its number,
// start block, length, blocks elapsed and remaining, and whether settlement is
// due), and `/v1/eras?limit=14` every minute for the most recent settled era
// and what its settlement issued. The block time used to turn "blocks
// remaining" into minutes is the chain's nominal 6 s until the hero has
// observed real block times, after which the observed figure is used and the
// provenance line says so.
//
// Motion: on each update the arc tweens from its previous fraction to the new
// one over 200 ms. Nothing else moves.
//
// The readings sit in aria-live regions, so a figure is re-rendered only when
// what it shows has changed; an unchanged figure has just its provenance line
// (endpoint and time) refreshed on each poll.

const ERA_INTERVAL_MS = 6_000;
const ERAS_INTERVAL_MS = 60_000;
/** The chain's target block time (`SLOT_DURATION` in runtime/src/lib.rs), until one is observed. */
export const NOMINAL_BLOCK_MS = 6_000;
/** An observed block time is re-rendered only when it moves by this much. */
export const CADENCE_STEP_MS = 50;
/** The SVG's coordinate space: a 320-unit square; the dial scales to its box. */
export const SIZE = 320;
export const CENTRE = SIZE / 2;
export const RADIUS = 136;
export const GRADUATIONS = 60; // hairline marks around the track; every fifth is longer

// ── pure helpers (unit-tested) ────────────────────────────────────────────────

/**
 * How much of the era has passed, clamped to [0, 1]; the indexer does not
 * clamp `blocksElapsed` once the era is due. Refuses input it cannot place on
 * the dial rather than defaulting to an empty arc.
 */
export function progressFraction(blocksElapsed, durationBlocks) {
  if (!Number.isFinite(blocksElapsed)) throw new TypeError('blocksElapsed is not a number');
  if (!(Number.isFinite(durationBlocks) && durationBlocks > 0)) throw new RangeError('durationBlocks is not positive');
  return Math.min(1, Math.max(0, blocksElapsed / durationBlocks));
}

/** The block at which settlement opens. */
export function settlementBlock(startBlock, durationBlocks) {
  return startBlock + durationBlocks;
}

/** Seconds until settlement, from blocks remaining and a block time in milliseconds. */
export function countdownSeconds(blocksRemaining, blockMs = NOMINAL_BLOCK_MS) {
  return (Math.max(0, blocksRemaining) * blockMs) / 1000;
}

/** The provenance phrase for the block time in use. */
export function blockTimeLabel(observedMs) {
  if (!(observedMs > 0)) return `at ${NOMINAL_BLOCK_MS / 1000} s per block`;
  return `at the observed ${(observedMs / 1000).toFixed(1)} s per block`;
}

/**
 * The countdown as a short figure and its hedge: `formatDuration` says
 * "about 32 min"; the figure shown is "32 min" and the provenance line
 * carries the "about", so the value fits on one line at the reading size.
 */
export function countdownFigure(seconds, format) {
  return format.formatDuration(seconds).replace(/^about /, '');
}

/** Start and end angles in radians of the progress arc, from twelve o'clock, clockwise. */
export function arcAngles(fraction) {
  const f = Math.min(1, Math.max(0, fraction));
  return { start: -Math.PI / 2, end: -Math.PI / 2 + f * 2 * Math.PI, sweep: f * 2 * Math.PI };
}

/** A point on the circle at `angle` radians (0 at three o'clock, clockwise positive in SVG). */
export function pointAt(angle, r = RADIUS, cx = CENTRE, cy = CENTRE) {
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

const fix = (n) => Number(n.toFixed(3));

/**
 * The SVG path of the progress arc for a fraction of the era, from twelve
 * o'clock clockwise. A full circle is two half-arcs, since one arc command
 * cannot start and end on the same point.
 */
export function arcPath(fraction, r = RADIUS, cx = CENTRE, cy = CENTRE) {
  const { start, end, sweep } = arcAngles(fraction);
  if (sweep <= 0) return '';
  const a = pointAt(start, r, cx, cy);
  if (sweep >= 2 * Math.PI - 1e-9) {
    const b = pointAt(start + Math.PI, r, cx, cy);
    return `M ${fix(a.x)} ${fix(a.y)} A ${r} ${r} 0 1 1 ${fix(b.x)} ${fix(b.y)} A ${r} ${r} 0 1 1 ${fix(a.x)} ${fix(a.y)}`;
  }
  const b = pointAt(end, r, cx, cy);
  const large = sweep > Math.PI ? 1 : 0;
  return `M ${fix(a.x)} ${fix(a.y)} A ${r} ${r} 0 ${large} 1 ${fix(b.x)} ${fix(b.y)}`;
}

/** The geometry of one graduation mark on the track: index k of `count`. */
export function graduation(k, count = GRADUATIONS, r = RADIUS, cx = CENTRE, cy = CENTRE) {
  const angle = -Math.PI / 2 + (k / count) * 2 * Math.PI;
  const major = k % 5 === 0;
  const inner = r - (major ? 10 : 5);
  const from = pointAt(angle, inner, cx, cy);
  const to = pointAt(angle, r - 1, cx, cy);
  return { x1: fix(from.x), y1: fix(from.y), x2: fix(to.x), y2: fix(to.y), major };
}

/** A whole number of blocks (or an era number), as the indexer emits them: a non-negative integer. */
function countField(data, field, name) {
  const value = field(data, name);
  if (!(Number.isInteger(value) && value >= 0)) throw new TypeError(`response has a non-numeric ${name}`);
  return value;
}

/**
 * Everything the dial shows, from one `/v1/eras/current` response and the
 * block time in use. Throws on a missing key (via `field`) and on a field of
 * the wrong type, so a decode mismatch becomes an unavailable reading rather
 * than a wrong dial: a string "3600" or a zero-length era never draws.
 */
export function dialState(data, field, blockMs = NOMINAL_BLOCK_MS) {
  const era = countField(data, field, 'era');
  const startBlock = countField(data, field, 'startBlock');
  const durationBlocks = countField(data, field, 'durationBlocks');
  if (durationBlocks === 0) throw new RangeError('response has a zero durationBlocks');
  const blocksElapsed = countField(data, field, 'blocksElapsed');
  const blocksRemaining = countField(data, field, 'blocksRemaining');
  const due = field(data, 'dueForSettlement');
  if (typeof due !== 'boolean') throw new TypeError('response has a non-boolean dueForSettlement');
  const fraction = due ? 1 : progressFraction(blocksElapsed, durationBlocks);
  return {
    era,
    startBlock,
    durationBlocks,
    blocksElapsed,
    blocksRemaining,
    due,
    fraction,
    // Floored, and 100 only once settlement is due: "100 %" while blocks remain would be a lie.
    percent: due ? 100 : Math.min(99, Math.floor(fraction * 100)),
    settlesAt: settlementBlock(startBlock, durationBlocks),
    /** Blocks produced beyond the era's length while settlement waits; 0 while running. */
    pastDue: Math.max(0, blocksElapsed - durationBlocks),
    seconds: due ? 0 : countdownSeconds(blocksRemaining, blockMs),
  };
}

/** The one-sentence summary the dial's aria-label carries. */
export function ariaSummary(state, format) {
  const era = format.formatInteger(state.era);
  const at = format.formatInteger(state.settlesAt);
  if (state.due) {
    return `Era ${era}, complete, settlement due since block ${at}, which anyone may trigger`;
  }
  return `Era ${era}, ${state.percent} % complete, settles at block ${at}, ${format.formatDuration(state.seconds)} from now`;
}

/**
 * The blocks-elapsed phrase, as the chain reported it: "352 of 3,600 blocks",
 * and once due "3,612 of 3,600 blocks · 12 blocks past due". Never clamped.
 */
export function elapsedPhrase(state, format) {
  const base = `${format.formatInteger(state.blocksElapsed)} of ${format.formatInteger(state.durationBlocks)} blocks`;
  if (!state.due) return base;
  return `${base} · ${format.formatInteger(state.pastDue)} block${state.pastDue === 1 ? '' : 's'} past due`;
}

/** The most recent settled era in a `/v1/eras` page, or null when the index holds none. */
export function latestSettled(items, field) {
  for (const item of items) {
    if (field(item, 'settled') === true) return item;
  }
  return null;
}

/**
 * Why a settlement issued nothing, when the response says so: a total weight
 * of zero means no agent earned a share that era (the emissions pallet's
 * activity and minimum-volume gates), so the zero is the rule's outcome, not
 * a fault. Null when there is nothing to add.
 */
export function zeroEmissionNote(emissionPlancks, totalWeight) {
  if (BigInt(emissionPlancks) !== 0n) return null;
  if (BigInt(totalWeight) !== 0n) return null;
  return 'nothing issued: no agent did enough verified work that era to earn a share';
}

// ── the instrument ────────────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, className = '') {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (className) node.setAttribute('class', className);
  return node;
}

function text(className, y, content = '') {
  const node = el('text', { x: CENTRE, y }, className);
  node.textContent = content;
  return node;
}

/** Builds the dial's SVG once; the parts that change are returned by name. */
function buildDial(dial) {
  const svg = el('svg', { viewBox: `0 0 ${SIZE} ${SIZE}`, 'aria-hidden': 'true', focusable: 'false' });

  // Graduations: sixty hairline marks inside the track, one longer every fifth.
  const marks = el('g', {}, 'dial-marks');
  for (let k = 0; k < GRADUATIONS; k += 1) {
    const { x1, y1, x2, y2, major } = graduation(k);
    marks.append(el('line', { x1, y1, x2, y2 }, major ? 'dial-mark dial-mark-major' : 'dial-mark'));
  }
  svg.append(marks);

  svg.append(el('circle', { cx: CENTRE, cy: CENTRE, r: RADIUS }, 'dial-track'));
  const arc = el('path', { d: '' }, 'dial-arc');
  svg.append(arc);

  // The settlement mark at twelve o'clock, crossing the track: a fixed
  // reference on the face, drawn as a hairline in every state.
  const top = pointAt(-Math.PI / 2);
  svg.append(el('line', { x1: top.x, y1: top.y - 12, x2: top.x, y2: top.y + 14 }, 'dial-tick'));

  const percent = text('dial-caption dial-percent', 86);
  const era = text('dial-era', 178);
  const caption = text('dial-caption dial-word', 206, 'ERA');
  const settles = text('dial-caption dial-settles', 246);
  svg.append(percent, era, caption, settles);
  dial.replaceChildren(svg);
  return { arc, percent, era, caption, settles };
}

export function init(root, ctx) {
  const dial = root.querySelector('[data-role="dial"]');
  const targets = {
    era: ctx.reading('era', root),
    settlement: ctx.reading('eraSettlement', root),
    countdown: ctx.reading('eraCountdown', root),
    lastSettled: ctx.reading('lastSettled', root),
  };
  const parts = dial ? buildDial(dial) : null;
  const { formatInteger, formatCmn } = ctx.format;

  let observedMs = null; // block time from the hero, as last received
  let renderedMs = null; // block time the countdown was last rendered with
  let eraRecord = null; // the last /v1/eras/current record
  let eraState = null; // that record decoded, or null when it could not be
  let fraction = null; // the arc as currently drawn; null when no arc is drawn
  let drawnEra = null; // a new era resets the arc rather than unwinding it
  let cancelTween = () => {};
  // What each live reading currently shows, so an unchanged figure is not re-announced.
  const shown = { era: null, settlement: null, countdown: null };

  const blockMs = () => observedMs ?? NOMINAL_BLOCK_MS;

  // ── drawing ──
  function setArc(f) {
    fraction = f;
    parts.arc.setAttribute('d', arcPath(f));
  }

  /** No arc and no remembered fraction, so the next good record snaps rather than sweeping in. */
  function clearArc() {
    fraction = null;
    parts.arc.setAttribute('d', '');
  }

  function moveArc(to, era) {
    cancelTween();
    const reset = drawnEra !== null && era !== drawnEra;
    drawnEra = era;
    if (fraction === null || fraction === to || reset) {
      setArc(to);
      return;
    }
    const from = fraction;
    cancelTween = ctx.motion.tween(200, (t) => setArc(from + (to - from) * t));
  }

  function drawState(state) {
    if (!parts) return;
    dial.dataset.state = state.due ? 'due' : 'running';
    parts.era.textContent = formatInteger(state.era);
    parts.caption.replaceChildren();
    if (state.due) {
      parts.percent.textContent = 'era complete';
      parts.settles.textContent = `due since #${formatInteger(state.settlesAt)}`;
      const line1 = el('tspan', { x: CENTRE, dy: 0 });
      line1.textContent = 'awaiting settlement —';
      const line2 = el('tspan', { x: CENTRE, dy: 15 });
      line2.textContent = 'anyone may trigger it';
      parts.caption.append(line1, line2);
    } else {
      parts.percent.textContent = `${state.percent} % complete`;
      parts.settles.textContent = `settles at #${formatInteger(state.settlesAt)}`;
      parts.caption.textContent = 'ERA';
    }
    dial.setAttribute('aria-label', ariaSummary(state, ctx.format));
    moveArc(state.fraction, state.era);
  }

  function drawUnavailable(reason) {
    if (!parts) return;
    cancelTween();
    dial.dataset.state = 'unavailable';
    drawnEra = null;
    clearArc();
    parts.percent.textContent = '';
    parts.era.textContent = '—';
    parts.caption.textContent = 'ERA';
    parts.settles.textContent = 'unavailable';
    dial.setAttribute('aria-label', `Era progress unavailable: ${reason}`);
  }

  // ── readouts ──

  /**
   * Shows a figure only when it differs from what the reading already shows;
   * otherwise refreshes just the provenance line. `key` identifies the visible
   * figure; the readings are aria-live, so a re-render is an announcement.
   */
  function showIfChanged(name, record, key, figure) {
    // The dial itself carries the era and its settlement block; a page may
    // show only some of the readings, and a reading it does not carry is skipped.
    if (!targets[name]) return;
    if (shown[name] === key) {
      ctx.readout.provenance(targets[name], record, figure.extra);
      return;
    }
    shown[name] = key;
    ctx.readout.showValue(targets[name], record, figure);
  }

  function showCountdown(state, record) {
    if (state.due) {
      showIfChanged('countdown', record, 'now', {
        value: 'now',
        extra: 'settlement is due — anyone may trigger it',
      });
      return;
    }
    const value = countdownFigure(state.seconds, ctx.format);
    const left = `${formatInteger(state.blocksRemaining)} block${state.blocksRemaining === 1 ? '' : 's'} left`;
    showIfChanged('countdown', record, value, {
      value,
      extra: `estimate — ${left}, ${blockTimeLabel(renderedMs)}`,
    });
  }

  function showReadings(state, record) {
    showIfChanged('era', record, String(state.era), { value: state.era, motion: ctx.motion });
    showIfChanged('settlement', record, String(state.settlesAt), {
      value: state.settlesAt,
      prefix: '#',
      motion: ctx.motion,
      extra: `era began at block #${formatInteger(state.startBlock)} · ${elapsedPhrase(state, ctx.format)}`,
    });
    showCountdown(state, record);
  }

  function onEra(record) {
    eraRecord = record;
    eraState = null;
    renderedMs = observedMs;
    // Decoded first, so a failure's reason reaches the dial's aria-label as
    // well as the readings; `apply` re-throws it into "unavailable" on each.
    let failure = null;
    if (record?.ok) {
      try {
        eraState = dialState(record.data, ctx.field, blockMs());
      } catch (error) {
        failure = error.message;
      }
    }
    const ok = ctx.readout.apply([targets.era, targets.settlement, targets.countdown].filter(Boolean), record, () => {
      if (failure) throw new Error(failure);
      showReadings(eraState, record);
      drawState(eraState);
    });
    if (!ok) {
      shown.era = shown.settlement = shown.countdown = null;
      drawUnavailable(failure ?? record?.error ?? 'the reading could not be decoded');
    }
  }

  function onEras(record) {
    ctx.readout.apply(targets.lastSettled, record, (data) => {
      const items = ctx.field(data, 'items');
      const settled = latestSettled(items, ctx.field);
      if (!settled) {
        const from = ctx.field(data, 'settledHistoryFrom');
        ctx.readout.showAbsent(
          targets.lastSettled,
          record,
          `no settled era in the index, which begins at block #${formatInteger(from)}`,
        );
        return;
      }
      const era = ctx.field(settled, 'era');
      const emission = ctx.field(settled, 'totalEmissionPlancks');
      const weight = ctx.field(settled, 'totalWeight');
      const at = ctx.field(settled, 'settledAtBlock');
      const why = zeroEmissionNote(emission, weight);
      ctx.readout.showValue(targets.lastSettled, record, {
        value: formatCmn(emission),
        unit: ' CMN',
        extra: `era ${formatInteger(era)} · settled at block #${formatInteger(at)}${why ? ` · ${why}` : ''}`,
      });
    });
  }

  // The hero's observed block time refines the countdown. The last era record
  // is re-read with it, but only when it has moved by a step since the
  // countdown was last rendered, so the live region is not re-announced for
  // drift the reader could not see.
  ctx.bus.on('cadence', ({ intervalMs }) => {
    if (!(intervalMs > 0)) return;
    observedMs = intervalMs;
    if (!eraState || !eraRecord?.ok) return; // nothing decoded to re-render; onEra has said why
    if (renderedMs !== null && Math.abs(intervalMs - renderedMs) < CADENCE_STEP_MS) return;
    renderedMs = intervalMs;
    try {
      eraState = dialState(eraRecord.data, ctx.field, intervalMs);
      showCountdown(eraState, eraRecord);
      dial?.setAttribute('aria-label', ariaSummary(eraState, ctx.format));
    } catch (error) {
      eraState = null;
      ctx.readout.showError(targets.countdown, eraRecord, error.message);
      drawUnavailable(error.message);
    }
  });

  if (parts) {
    dial.dataset.state = 'waiting';
    dial.setAttribute('aria-label', 'Era progress: waiting for the first reading');
    parts.era.textContent = '';
    parts.settles.textContent = 'waiting for the first reading';
    clearArc();
  }

  ctx.watch('era', onEra, ERA_INTERVAL_MS);
  if (targets.lastSettled) ctx.watch('eras', onEras, ERAS_INTERVAL_MS);
}
