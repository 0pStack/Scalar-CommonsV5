// Messaging, spec 309 and later. Two jobs, and the second is the important one.
//
// 1. The running total of signed messages the chain has accepted
//    (`messages.MessageSent`), next to the hour figure that `last-hour.js`
//    draws from the same read.
//
// 2. THE SPEC GATE. Anything marked `data-min-spec="N"` is hidden until the
//    chain reports a `specVersion` of at least N, and hidden again if it ever
//    reports less — which is what a rollback looks like from here.
//
// Why a gate rather than a zero: below 309 the `messages` pallet does not
// exist, so `/v1/events?section=messages` describes a thing the chain cannot
// do. Showing "0" there would be a claim about messaging activity on a chain
// that has no messaging, and the observatory's whole contract is that a figure
// is either true or says it is unavailable. Hiding is the honest third option.
//
// The gate is generic on purpose: it keys off the attribute, not off messaging,
// so the next version-fenced figure needs no new instrument.

const STATUS_INTERVAL_MS = 6_000;
const TOTAL_INTERVAL_MS = 30_000;

/** Elements fenced behind a runtime version. */
export function gatedElements(root) {
  return [...root.querySelectorAll('[data-min-spec]')];
}

/**
 * Should an element be shown at this spec? Pure; tested.
 *
 * An unreadable spec (`null`) hides the element. That is deliberate: if we
 * cannot tell which runtime is in force we cannot claim its figures are
 * meaningful, and a stale "shown" state would outlive the knowledge that
 * justified it.
 */
export function shouldShow(minSpec, spec) {
  if (!Number.isFinite(spec)) return false;
  if (!Number.isFinite(minSpec)) return true;
  return spec >= minSpec;
}

export function init(root, ctx) {
  const { formatInteger } = ctx.format;
  const gated = gatedElements(root);
  const totalTarget = ctx.reading('messagesSent', root);

  // Hidden until the chain says otherwise, so a page that never manages to
  // read the spec does not flash figures it cannot stand behind.
  for (const el of gated) el.hidden = true;

  let shown = null;

  ctx.watch(
    'status',
    (record) => {
      // `apply` is not used here: the gate must act on a FAILED read too
      // (hide), where `apply` would leave the previous state in place.
      const spec = record?.ok ? ctx.field(record.data, 'chain.specVersion') : null;
      const specNum = Number(spec);
      let any = false;
      for (const el of gated) {
        const min = Number(el.dataset.minSpec);
        const show = shouldShow(min, specNum);
        el.hidden = !show;
        if (show) any = true;
      }
      if (any !== shown) {
        shown = any;
        // Only ask the indexer for messages once the runtime can have them.
        if (any) ctx.refresh('messagesSent');
      }
    },
    STATUS_INTERVAL_MS,
  );

  if (totalTarget) {
    ctx.watch(
      'messagesSent',
      (record) => {
        ctx.readout.apply(totalTarget, record, (data) => {
          const total = ctx.field(data, 'total');
          ctx.readout.showValue(totalTarget, record, {
            value: Number.isFinite(Number(total)) ? formatInteger(Number(total)) : null,
            motion: ctx.motion,
          });
        });
      },
      TOTAL_INTERVAL_MS,
    );
  }
}
