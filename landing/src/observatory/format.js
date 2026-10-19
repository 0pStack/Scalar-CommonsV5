// Formatting for readouts. Everything here is pure and is unit-tested.

const integers = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function formatInteger(value) {
  return integers.format(value);
}

/** "5 hours ago", from two epoch-millisecond instants. */
export function relativeTime(then, now) {
  const minutes = Math.floor((now - then) / 60_000);
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (minutes < 1) return 'less than a minute ago';
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return plural(hours, 'hour');
  return plural(Math.floor(hours / 24), 'day');
}

/** "about 1 h 42 min" / "about 40 s" from a number of seconds. */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `about ${s} s`;
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `about ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `about ${hours} h` : `about ${hours} h ${rest} min`;
}

/** "14:02:11 UTC" */
export function utcTime(date) {
  return `${date.toISOString().slice(11, 19)} UTC`;
}

/** "2026-09-29" */
export function utcDate(date) {
  return date.toISOString().slice(0, 10);
}

/** "5Ck2…XDEq" */
export function shortAddress(address) {
  const s = String(address);
  return s.length <= 12 ? s : `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/** "9b67d2f1…ae60ed2a" */
export function shortHash(hex) {
  const s = String(hex).replace(/^0x/, '');
  return s.length <= 16 ? s : `${s.slice(0, 8)}…${s.slice(-8)}`;
}

/**
 * Plancks → whole CMN with thousands separators, rounded down; never through a
 * float. Fractions are dropped because these readouts are magnitudes, not
 * balances a payment depends on.
 */
export function formatCmn(plancks, decimals = 12) {
  const value = BigInt(plancks);
  const scale = 10n ** BigInt(decimals);
  return integers.format(value / scale);
}

/** Plancks → a Number of CMN, for scales and charts only (precision is not the point there). */
export function cmnNumber(plancks, decimals = 12) {
  return Number(BigInt(plancks) / 10n ** BigInt(Math.max(0, decimals - 6))) / 1e6;
}
