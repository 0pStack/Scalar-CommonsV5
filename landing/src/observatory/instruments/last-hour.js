// Activity in the last hour, the row under the first screen's figures: oracle
// answers, agreements settled, disputes opened and slashes, each counted from
// the finalized-block event index over the index's newest hour — the 600
// blocks (the runtime's HOURS at six seconds a block) up to the newest block
// the index has synced (see hour.js). Each list is read newest first and only
// as far back as that hour's first block, every 30 seconds; a count the page
// cap stopped short of the hour is shown as a floor ("≥"), a failed read as
// "unavailable" — never the last number. When the index is an hour or more
// behind the chain, the row says so in a sentence under its title.
//
// Messages sent (spec 309 and later) are messages.MessageSent, one per signed
// message the chain accepted.
//
// Oracle answers are the two ways an agent answers a request, singly
// (oracle.OracleResponseSubmitted) and in a batch (BatchResponseSubmitted);
// a batch is one event and is counted once. Agreements settled are
// escrow.DeliveryConfirmed: the buyer confirmed delivery and the payment was
// released. Disputes opened are escrow.DisputeOpened; slashes are
// agents.SlashExecuted. Each name is checked against the runtime's own
// metadata (chain-events.json) by the tests.

import { countSince } from '../data.js';
import { hourTracker, lagNote } from '../hour.js';

export const INTERVAL_MS = 30_000;
/** 10 × 200 events an hour per kind before a count becomes a floor. */
export const HOUR_PAGES = 10;

/** Each figure, the reading it fills, and the event lists it counts. */
export const FIGURES = [
  { key: 'hourOracle', sources: ['oracleAnswers', 'oracleBatches'], what: 'oracle answers' },
  { key: 'hourSettled', sources: ['deliveriesConfirmed'], what: 'agreements settled' },
  { key: 'hourDisputes', sources: ['disputesOpened'], what: 'disputes opened' },
  { key: 'hourSlashes', sources: ['slashes'], what: 'slashes' },
  // 309: messages.MessageSent. Hidden below spec 309 by the `data-min-spec`
  // gate rather than counted as zero — "no messages" and "this chain cannot
  // carry messages" are different statements and the page must not conflate
  // them.
  { key: 'hourMessages', sources: ['messagesSent'], what: 'messages sent' },
];

/**
 * One figure from its records: the events at or after each record's `since`
 * block, summed, a floor when any read stopped before the hour's start; or
 * the first failure. Pure; tested.
 */
export function hourCount(records) {
  let count = 0;
  let floor = false;
  for (const record of records) {
    if (!record?.ok) return { ok: false, error: record?.error ?? 'not read' };
    const since = countSince(record.items, record.since);
    count += since.count;
    if (!record.reachedStart && !since.reachedStart) floor = true;
  }
  return { ok: true, count, floor };
}

export function init(root, ctx) {
  const { formatInteger } = ctx.format;
  const note = root.querySelector('.hour-note');
  const hour = hourTracker(ctx);
  const targets = FIGURES.map((figure) => ctx.reading(figure.key, root)).filter(Boolean);
  let started = false;

  function start() {
    for (const figure of FIGURES) {
      const target = ctx.reading(figure.key, root);
      if (!target) continue;
      const records = new Map();
      const show = () => {
        if (records.size < figure.sources.length) return;
        const list = figure.sources.map((name) => records.get(name));
        const result = hourCount(list);
        if (!result.ok) {
          ctx.readout.showError(target, list.find((r) => !r.ok) ?? list[0], result.error);
          return;
        }
        const first = list[0];
        const also = list.slice(1).map((r) => r.label).join(', ');
        const h = hour.get();
        ctx.readout.showValue(target, first, {
          value: result.count,
          prefix: result.floor ? '≥ ' : '',
          extra:
            `${figure.what} in blocks #${formatInteger(first.since)}–#${formatInteger(h?.to ?? first.since)}, the index’s newest hour` +
            `${also ? ` · also ${also}` : ''}${result.floor ? ' · more than this page reads' : ''}`,
          motion: ctx.motion,
        });
      };
      for (const name of figure.sources) {
        ctx.watchSince(
          name,
          () => hour.get()?.since ?? null,
          (record) => {
            records.set(name, record);
            show();
          },
          INTERVAL_MS,
          { maxPages: HOUR_PAGES },
        );
      }
    }
  }

  hour.onChange(({ hour: h, record, error }) => {
    if (note) {
      const text = h ? lagNote(h, formatInteger) : '';
      note.textContent = text;
      note.hidden = !text;
    }
    if (!h) {
      // Without the index's position there is no hour to count over: say why, on every figure.
      for (const target of targets) ctx.readout.showError(target, record, error ?? 'the index’s position could not be read');
      return;
    }
    if (!started) {
      started = true;
      start();
    }
  });
  return { hour: () => hour.get() };
}
