// 06 · Upgrade rail. The rail and its rows are rendered at build time from
// runtime-history.json (a checked-in record). This instrument adds the live
// parts: the runtime version in force, the block the last upgrade took effect
// at, and a per-row confirmation that the recorded block really carries a
// `system.CodeUpdated` event — linked to that event in the API and to the
// extrinsic that applied it in the explorer.

const UPGRADES_INTERVAL_MS = 60_000;
const STATUS_INTERVAL_MS = 6_000;

export function init(root, ctx) {
  const specTarget = ctx.reading('specVersion', root);
  const lastTarget = ctx.reading('lastUpgrade', root);
  const confirms = [...root.querySelectorAll('[data-confirm-block]')];
  const markers = [...root.querySelectorAll('.rail-marker[data-block]')];

  let lastSpec = null;
  ctx.watch(
    'status',
    (record) => {
      ctx.readout.apply(specTarget, record, (data) => {
        const spec = ctx.field(data, 'chain.specVersion');
        ctx.readout.showValue(specTarget, record, { value: spec, motion: ctx.motion });
        for (const marker of root.querySelectorAll('.rail-marker')) {
          marker.classList.toggle('is-current', Number(marker.dataset.spec) === spec);
        }
        if (spec !== lastSpec) {
          lastSpec = spec;
          ctx.refresh('upgrades'); // a new runtime: re-read the upgrade block now
        }
      });
    },
    STATUS_INTERVAL_MS,
  );

  ctx.watch(
    'upgrades',
    (record) => {
      const ok = ctx.readout.apply(lastTarget, record, (data) => {
        const items = ctx.field(data, 'items');
        const newest = ctx.field(data, 'items.0.blockNumber');
        ctx.readout.showValue(lastTarget, record, { value: newest, prefix: '#', motion: ctx.motion });
        const byBlock = new Map(items.map((item) => [item.blockNumber, item]));
        for (const node of confirms) {
          const block = Number(node.dataset.confirmBlock);
          const event = byBlock.get(block);
          node.replaceChildren();
          if (event) {
            const api = document.createElement('a');
            api.href = `${ctx.API_ORIGIN}/v1/events/${encodeURIComponent(event.id)}`;
            api.target = '_blank';
            api.rel = 'noopener';
            api.textContent = 'confirmed on chain';
            node.append(api);
            if (event.extrinsicId) {
              const [blockNumber, index] = String(event.extrinsicId).split('-');
              const explorer = document.createElement('a');
              explorer.href = `${ctx.EXPLORER_ORIGIN}/extrinsic/${blockNumber}/${index}`;
              explorer.target = '_blank';
              explorer.rel = 'noopener';
              explorer.textContent = 'the extrinsic that applied it';
              node.append(' · ', explorer);
            }
            node.dataset.state = 'confirmed';
          } else {
            node.textContent = 'no upgrade event at this block in the index';
            node.dataset.state = 'missing';
          }
          node.title = `${record.label} · ${ctx.format.utcTime(record.at)}`;
        }
        for (const marker of markers) {
          marker.dataset.confirmed = byBlock.has(Number(marker.dataset.block)) ? 'true' : 'false';
        }
      });
      if (!ok) {
        for (const node of confirms) {
          node.textContent = 'could not be checked';
          node.dataset.state = 'error';
          node.title = `${record.label} · ${record.error}`;
        }
      }
    },
    UPGRADES_INTERVAL_MS,
  );
}
