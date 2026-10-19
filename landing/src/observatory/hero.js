// The first screen's block height: the first of its figures. The others —
// agents registered, operator-run and agreements open — are the agent
// field's readings, since the agent field (framed beside them) makes those
// reads; the last hour's row is last-hour.js's.
// Nothing here fetches on its own schedule: the height is the chain pulse's
// head, carried on the page bus with its record, live (`head`) or polled
// (`poll`), and shown with that record like any other reading. A failed read
// replaces the figure with "unavailable" and its reason; nothing is kept.

export function init(root, ctx) {
  if (!root) return null;
  const height = ctx.reading('heroHeight', root);
  const onNumber = ({ record, number }) => {
    if (!height) return;
    if (!record?.ok) {
      ctx.readout.showError(height, record);
      return;
    }
    if (Number.isFinite(number)) ctx.readout.showValue(height, record, { value: number, motion: ctx.motion });
  };
  ctx.bus.on('head', onNumber);
  ctx.bus.on('poll', onNumber);
  return { height };
}
