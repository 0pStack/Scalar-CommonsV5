/**
 * Presentation helpers.
 *
 * All of these are pure and total: they take values already decoded off chain
 * and turn them into strings. Nothing here reaches the network, so the rules
 * they encode (never print a raw planck count to a human, never trust a chain
 * string as markup) are unit-testable without a node.
 */

/**
 * Renders a planck amount in whole tokens.
 *
 * Balances are `u128` plancks; printing them raw is unreadable and printing them
 * through floating point is wrong (a genesis-scale balance exceeds 2^53). So the
 * split is done on the integer string: `decimals` comes from the chain's own
 * token properties rather than a constant, because a runtime is free to change
 * it and a hard-coded 12 would silently misprice every page.
 */
export function formatBalance(plancks: bigint, decimals: number, symbol: string): string {
  const negative = plancks < 0n;
  const magnitude = negative ? -plancks : plancks;
  const divisor = 10n ** BigInt(decimals);
  const whole = magnitude / divisor;
  const fraction = magnitude % divisor;

  const groupedWhole = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fractionText = fraction === 0n ? '' : `.${fraction.toString().padStart(decimals, '0').replace(/0+$/, '')}`;

  return `${negative ? '-' : ''}${groupedWhole}${fractionText} ${symbol}`;
}

/**
 * Elides the middle of a hash for use in dense lists.
 *
 * Only ever cosmetic: every elided hash on a page is also a link carrying the
 * full value, so nothing that identifies a block or extrinsic is lost.
 */
export function shortHash(hash: string, keep = 8): string {
  const body = hash.startsWith('0x') ? hash.slice(2) : hash;
  const prefix = hash.startsWith('0x') ? '0x' : '';
  if (body.length <= keep * 2) {
    return hash;
  }
  return `${prefix}${body.slice(0, keep)}…${body.slice(-keep)}`;
}

/**
 * Escapes a string for interpolation into HTML.
 *
 * Every value on an explorer page originates on chain, and chain data is
 * attacker-controlled by construction: anyone can submit a `system.remark` full
 * of markup for the price of a fee. So escaping is applied at the renderer, to
 * everything, rather than being decided value by value.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The widest instant a JS `Date` can hold, in milliseconds either side of the
 * epoch. `toISOString()` throws `RangeError` beyond it, and the timestamp
 * pallet's value is a `u64` the runtime chose — so the range has to be checked
 * rather than assumed. A field the explorer cannot read is one unreadable
 * field; an uncaught RangeError would be a 502 for the whole page.
 */
const MAX_DATE_MS = 8_640_000_000_000_000n;

/** Renders the timestamp pallet's millisecond value as ISO-8601, or says why it cannot. */
export function formatTimestamp(timestampMs: bigint | null): string {
  if (timestampMs === null) {
    return 'unknown';
  }
  if (timestampMs > MAX_DATE_MS || timestampMs < -MAX_DATE_MS) {
    return `out of range (${timestampMs} ms)`;
  }
  return new Date(Number(timestampMs)).toISOString();
}
