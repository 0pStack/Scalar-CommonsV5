/**
 * Chain constants shared by every package that talks to Scalar Commons.
 *
 * Defined once here and imported everywhere else, so a package can never drift
 * to a different scale or prefix than the chain uses.
 */

/** Decimal places of CMN, per the chain properties (`tokenDecimals`). */
export const CMN_DECIMALS = 12;

/** 1 CMN = 10^12 plancks. */
export const PLANCKS_PER_CMN = 1_000_000_000_000n;

/**
 * SS58 address prefix: the runtime's `SS58Prefix` and the chain spec's
 * `ss58Format`, currently the generic Substrate 42.
 */
export const SS58_PREFIX = 42;
