// 02 · Economy — the two figures beside the era dial that are not the dial's
// own: the CMN paid to agents so far, and the agreements in dispute now.
//
// CMN issued to agents is the running total of what each era's settlement
// paid out, as the pallet reported it (`totalEmissionPlancks` of every
// settled era in /v1/eras, read whole and summed exactly in BigInt). It is
// derived, and its provenance line says so and says which eras it covers.
// It is never total issuance: /v1/emissions/supply counts the genesis
// endowment and validator rewards too, and the history strip beneath gives
// that figure as context, not as this one. The read is the same one the
// history strip makes (`erasAll`, the same page cap), so it is fetched once.
//
// Open disputes is `byStatus.Disputed` of /v1/escrows/stats — live chain
// state, the same read that gives the hero its count of open agreements. It
// is the one figure on the page drawn in amber, and only when it is not zero.

import { ERAS_ALL_PAGES, cumulativePlancks, emissionSeries } from './history.js';

const ERAS_INTERVAL_MS = 60_000;
const STATS_INTERVAL_MS = 30_000;

/**
 * The exact running total of agent payouts over the unbroken run of settled
 * eras ending at the newest, as `{ plancks, eras, first, last }`; null when
 * no era has settled. Throws on a missing field. Pure; tested.
 */
export function payoutTotal(items, field) {
  const series = emissionSeries(items, field, () => 0, Infinity);
  if (series.length === 0) return null;
  const totals = cumulativePlancks(series.map((e) => e.plancks));
  return { plancks: totals[totals.length - 1], eras: series.length, first: series[0].era, last: series[series.length - 1].era };
}

export function init(root, ctx) {
  const payouts = ctx.reading('agentPayouts', root);
  const disputes = ctx.reading('openDisputes', root);
  const { formatCmn, formatInteger } = ctx.format;

  if (payouts) {
    ctx.watchAll(
      'erasAll',
      (record) => {
        ctx.readout.apply(payouts, record, (data) => {
          const total = payoutTotal(record.items, ctx.field);
          const from = ctx.field(data, 'settledHistoryFrom');
          if (total === null) {
            ctx.readout.showAbsent(payouts, record, `no era has settled since block #${formatInteger(from)}, where this site’s record begins`);
            return;
          }
          const span = total.first === total.last ? `era ${formatInteger(total.first)}` : `eras ${formatInteger(total.first)}–${formatInteger(total.last)}`;
          ctx.readout.showValue(payouts, record, {
            value: formatCmn(total.plancks),
            unit: ' CMN',
            live: false,
            extra:
              `derived: sum of totalEmissionPlancks over ${formatInteger(total.eras)} settled era${total.eras === 1 ? '' : 's'}, ${span}` +
              (record.complete ? '' : ' · the index holds more eras than were read, so this is a floor'),
          });
        });
      },
      ERAS_INTERVAL_MS,
      { maxPages: ERAS_ALL_PAGES },
    );
  }

  if (disputes) {
    ctx.watch(
      'escrowStats',
      (record) => {
        ctx.readout.apply(disputes, record, (data) => {
          const truncated = ctx.field(data, 'scanTruncated');
          ctx.readout.showValue(disputes, record, {
            value: ctx.field(data, 'byStatus.Disputed'),
            prefix: truncated ? '≥ ' : '',
            extra: truncated ? 'live scan cut short at the indexer’s cap' : 'live chain state',
            motion: ctx.motion,
          });
        });
      },
      STATS_INTERVAL_MS,
    );
  }
}
