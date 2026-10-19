/**
 * Plancks <-> CMN, and the signed-net formatting the report depends on.
 *
 * Every balance on chain is an integer number of plancks and stays a BigInt for
 * the whole pipeline. Money is converted to a decimal string exactly once, at
 * the point of printing. A `Number` anywhere upstream silently loses precision
 * above 2^53 plancks — that is only ~9007 CMN, well inside the range these
 * archetypes move — and the loss would land in the profitability figure the
 * whole experiment exists to produce.
 */

export const PLANCKS_PER_CMN = 1_000_000_000_000n;

/** CMN (number or string) -> plancks. Exact for up to 12 decimal places. */
export function cmnToPlancks(cmn) {
  const s = typeof cmn === 'string' ? cmn.trim() : String(cmn);
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`not a decimal amount: ${cmn}`);
  const neg = s.startsWith('-');
  const [whole, frac = ''] = (neg ? s.slice(1) : s).split('.');
  if (frac.length > 12) throw new Error(`more than 12 decimal places: ${cmn}`);
  const p = BigInt(whole) * PLANCKS_PER_CMN + BigInt((frac + '000000000000').slice(0, 12));
  return neg ? -p : p;
}

/** Plancks -> a fixed-precision CMN string. Never scientific notation. */
export function plancksToCmn(plancks, dp = 4) {
  const neg = plancks < 0n;
  const abs = neg ? -plancks : plancks;
  const whole = abs / PLANCKS_PER_CMN;
  const frac = (abs % PLANCKS_PER_CMN).toString().padStart(12, '0').slice(0, dp);
  const body = dp > 0 ? `${whole}.${frac}` : `${whole}`;
  return neg ? `-${body}` : body;
}

/**
 * Plancks -> a CMN string that ALWAYS carries a sign.
 *
 * The report's whole point is whether an archetype came out ahead, so "+12.5"
 * and "-12.5" must be distinguishable at a glance and "0" must not read as a
 * silent win. `signedCmn(0n)` is "+0.0000", which is correct: breaking even is
 * not losing.
 */
export function signedCmn(plancks, dp = 4) {
  const s = plancksToCmn(plancks, dp);
  return s.startsWith('-') ? s : `+${s}`;
}
