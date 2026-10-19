// 08 · Verify it yourself. The one live figure here is the genesis hash,
// read once from the node; everything else in the section is a fixed address
// or a command.
export function init(root, ctx) {
  const target = ctx.reading('genesis', root);
  if (!target) return;
  ctx.fetch(ctx.SOURCES.genesis).then((record) => {
    ctx.readout.apply(target, record, (data) => {
      const hash = ctx.field(data, 'result');
      if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error('genesis hash is not a 32-byte hash');
      ctx.readout.showValue(target, record, { value: hash });
      const dd = target.querySelector('dd');
      if (dd && !dd.querySelector('.copy')) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'copy';
        button.dataset.copy = hash;
        button.setAttribute('aria-label', 'Copy genesis hash');
        button.textContent = 'Copy';
        dd.querySelector('.reading-value').after(' ', button);
      }
    });
  });
}
