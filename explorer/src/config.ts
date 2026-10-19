/**
 * Reading configuration out of the environment.
 *
 * The rule here is that a misconfigured process must fail at startup, loudly,
 * rather than run. `Number('nope')` is `NaN`, and `NaN` propagates silently
 * through comparisons, arithmetic and `Array.from` — so a typo in one variable
 * ends up as a page that renders successfully with nothing on it. An explorer's
 * whole value is that what it shows is what the chain said, and a plausible
 * empty view is the one failure it cannot afford.
 */

/**
 * Reads an integer environment variable, or throws.
 *
 * `Number.isInteger` is the check, not `Number()` plus a clamp: `Math.max(1,
 * NaN)` is `NaN`, so clamping does not catch a bad value, it launders it.
 */
export function readIntEnv(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) {
    return fallback;
  }
  // `Number('')` is 0, so a variable set to nothing would otherwise read as a
  // deliberate zero rather than as the mistake it is.
  const value = raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number between ${min} and ${max}, not ${JSON.stringify(raw)}`);
  }
  return value;
}
