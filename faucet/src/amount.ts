/**
 * CMN ⇄ planck conversion.
 *
 * The chain accounts in plancks (integers); humans and operator config speak in
 * CMN. Every conversion here is string/`bigint` only. That is not fussiness:
 * a single drip of 9007199.254740993 CMN already exceeds `Number.MAX_SAFE_INTEGER`
 * in plancks, so a float in this path would silently round the low digits and
 * dispense the wrong amount.
 */

/** Decimal places of the native token, per chain properties (`tokenDecimals`). */
export const CMN_DECIMALS = 12;

/** 1 CMN = 10^12 plancks. */
export const PLANCKS_PER_CMN = 10n ** BigInt(CMN_DECIMALS);

/** Matches an unsigned decimal amount with an optional fractional part. */
const DECIMAL_RE = /^\+?(\d+)(?:\.(\d+))?$/;

/**
 * Parses a decimal CMN amount into plancks.
 *
 * Rejects anything more precise than one planck rather than truncating, because
 * silently dropping the operator's digits is how a faucet ends up dispensing an
 * amount nobody configured.
 *
 * @throws if the input is not a non-negative decimal, or carries sub-planck precision.
 */
export function parseCmnToPlancks(input: string): bigint {
  if (typeof input !== 'string') {
    throw new TypeError(`CMN amount must be a string, got ${typeof input}`);
  }
  const trimmed = input.trim();
  const match = DECIMAL_RE.exec(trimmed);
  if (!match) {
    throw new Error(`invalid CMN amount: ${JSON.stringify(input)}`);
  }
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  if (fraction.length > CMN_DECIMALS) {
    throw new Error(
      `CMN amount ${JSON.stringify(input)} exceeds planck precision (${CMN_DECIMALS} decimals)`,
    );
  }
  // Right-pad the fraction so it lands on the planck scale exactly.
  const padded = fraction.padEnd(CMN_DECIMALS, '0');
  return BigInt(whole) * PLANCKS_PER_CMN + BigInt(padded === '' ? '0' : padded);
}

/**
 * Renders plancks as a CMN decimal string with no trailing zeros — the inverse
 * of {@link parseCmnToPlancks} for display and log output.
 */
export function formatPlancksAsCmn(plancks: bigint): string {
  if (plancks < 0n) {
    throw new Error(`plancks must be non-negative, got ${plancks}`);
  }
  const whole = plancks / PLANCKS_PER_CMN;
  const remainder = plancks % PLANCKS_PER_CMN;
  if (remainder === 0n) {
    return whole.toString();
  }
  const fraction = remainder.toString().padStart(CMN_DECIMALS, '0').replace(/0+$/, '');
  return `${whole}.${fraction}`;
}
