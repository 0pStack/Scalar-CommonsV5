// 07 · Security posture. Rendered entirely at build time from
// landing/public/posture.json, and marked "record, not live" on the page.
// There is nothing to fetch, so the instrument only confirms that the section
// it was given is the record it expects.
export function init(root, ctx) {
  if (!ctx.posture || typeof ctx.posture !== 'object') {
    throw new Error('posture record missing from the page');
  }
  root.dataset.ready = 'true';
}
