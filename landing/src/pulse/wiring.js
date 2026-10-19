// The pure parts of the page's wiring, kept apart from main.js so they can be
// tested without a window: an agent's role from the open agreements, and the
// banner's words for each state of the feed.

/** What an agent does, from the open agreements: provider if it provides in any, buyer if it buys, else agent. */
export function roleOf(address, links) {
  let buys = false;
  for (const link of links) {
    if (link.provider === address) return 'provider';
    if (link.buyer === address) buys = true;
  }
  return buys ? 'buyer' : 'agent';
}

/**
 * The banner's words for a feed state; empty when the feed is live. An index
 * that has fallen behind the live window is as unavailable as a feed that
 * failed: nothing on the plate can be called current, so the banner says
 * "unavailable" for both and gives the reason.
 */
export function bannerText({ state, reason, head, indexed }, formatInteger = String) {
  if (state === 'unavailable') return `live feed unavailable — ${reason ?? 'no source answered'}`;
  if (state === 'stale') {
    const behind = Number.isFinite(head) && Number.isFinite(indexed) ? head - indexed : null;
    return behind === null
      ? `live feed unavailable — ${reason ?? 'the index is behind the chain'}`
      : `live feed unavailable — the index is ${formatInteger(behind)} blocks behind the chain`;
  }
  return '';
}

/** Whether a feed state means the figures and the ticker must say "unavailable" rather than stand. */
export function feedDown(state) {
  return state === 'unavailable' || state === 'stale';
}
