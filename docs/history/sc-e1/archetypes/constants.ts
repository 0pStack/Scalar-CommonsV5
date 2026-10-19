/**
 * Economic constants for the SC-E1 archetype runners.
 *
 * Values mirror protocol §4 ("System under test — economic constants"). They are
 * transcribed from build-session history and are *inputs to verification* (P0-1),
 * not authority. The runners use them only to size stakes and escrow volumes so
 * that the synthetic population lands on the right side of the economic gates
 * (MinQualifyingVol, completion/base fees). They are NOT re-implementing any
 * pallet logic — the real economics run on-chain via the SDK.
 *
 * All balances are plancks (`bigint`); 1 CMN = 10^12 plancks.
 */

/** 1 CMN = 10^12 plancks (protocol §4, token unit). */
export const PLANCKS_PER_CMN = 1_000_000_000_000n;

/** Coerce a whole-CMN quantity to plancks. */
export function cmn(n: number | bigint): bigint {
  return BigInt(n) * PLANCKS_PER_CMN;
}

/** Absolute supply cap, in CMN (protocol §4; invariant M8). */
export const SUPPLY_CAP_CMN = 100_000_000_000n;

/** Genesis mint, in CMN. */
export const GENESIS_MINT_CMN = 18_000_000_000n;

/** BASE_TX_FEE — 10 CMN, fully burned. The sybil-cost floor (protocol §4). */
export const BASE_TX_FEE = cmn(10);

/** AgreementCompletionFee — 100 CMN. The wash-trade cost floor (protocol §4). */
export const AGREEMENT_COMPLETION_FEE = cmn(100);

/** MinQualifyingVol — 50 CMN era escrow volume. Floor-emission qualification gate. */
export const MIN_QUALIFYING_VOL = cmn(50);

/** VelocityBonusBps cap — +30% capital-velocity multiplier ceiling. */
export const VELOCITY_BONUS_BPS_CAP = 3_000; // 3000 bps = +30%

/** Basis-point denominator. */
export const BPS = 10_000;

/** Genesis validator stake, in CMN (baseline earner reference). */
export const GENESIS_STAKE = cmn(10_000);

/** MaxStake — 1,000,000 CMN (protocol §4). */
export const MAX_STAKE = cmn(1_000_000);

/** Minimum stake a sybil sub-account posts — kept small on purpose (§5 A-3). */
export const SYBIL_MIN_STAKE = cmn(1);

/**
 * Nominal blocks per era, used only to size the escrow `deliverBy` deadline arg
 * to a plausible future block. Not an economic parameter — the real era length
 * comes from the fast-era chain spec (P0-2). Kept here so the recorded arg is
 * deterministic and roughly realistic.
 */
export const NOMINAL_BLOCKS_PER_ERA = 100n;
