import { describe, it, expect } from 'vitest';

import { parseCmnToPlancks, formatPlancksAsCmn, CMN_DECIMALS, PLANCKS_PER_CMN } from '../src/amount.js';

/**
 * CMN amounts are configured by operators in whole tokens but every chain-facing
 * value is an integer number of plancks (1 CMN = 10^12 plancks). Floating point
 * cannot represent a planck-exact CMN amount, so the conversion is done on
 * strings and `bigint` — these tests pin that there is no float in the path.
 */

describe('planck conversion constants', () => {
  it('matches the chain token definition', () => {
    expect(CMN_DECIMALS).toBe(12);
    expect(PLANCKS_PER_CMN).toBe(1_000_000_000_000n);
  });
});

describe('parseCmnToPlancks', () => {
  it('converts whole tokens', () => {
    expect(parseCmnToPlancks('1')).toBe(1_000_000_000_000n);
    expect(parseCmnToPlancks('5')).toBe(5_000_000_000_000n);
    expect(parseCmnToPlancks('0')).toBe(0n);
  });

  it('converts fractional tokens exactly', () => {
    expect(parseCmnToPlancks('0.5')).toBe(500_000_000_000n);
    expect(parseCmnToPlancks('0.01')).toBe(10_000_000_000n);
    expect(parseCmnToPlancks('1.000000000001')).toBe(1_000_000_000_001n);
  });

  it('pads a short fraction rather than truncating it', () => {
    expect(parseCmnToPlancks('0.1')).toBe(100_000_000_000n);
    expect(parseCmnToPlancks('2.25')).toBe(2_250_000_000_000n);
  });

  it('keeps precision that a double would lose', () => {
    // 9007199 CMN + 254740993000 plancks. The exact planck total is far past
    // Number.MAX_SAFE_INTEGER (2^53-1 ≈ 9.007e15), so a float path would round
    // the low digits away and silently mis-fund the drip.
    const plancks = parseCmnToPlancks('9007199.254740993');
    expect(plancks).toBe(9_007_199_254_740_993_000n);
    expect(plancks).toBe(9_007_199n * PLANCKS_PER_CMN + 254_740_993_000n);
    expect(plancks > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    // The float round-trip is lossy; the bigint one is not.
    expect(BigInt(Number(plancks))).not.toBe(plancks);
  });

  it('accepts surrounding whitespace and an explicit plus', () => {
    expect(parseCmnToPlancks('  3  ')).toBe(3_000_000_000_000n);
    expect(parseCmnToPlancks('+3')).toBe(3_000_000_000_000n);
  });

  it('rejects more precision than a planck', () => {
    expect(() => parseCmnToPlancks('1.0000000000001')).toThrow(/precision/i);
  });

  it('rejects negative and malformed amounts', () => {
    expect(() => parseCmnToPlancks('-1')).toThrow();
    expect(() => parseCmnToPlancks('')).toThrow();
    expect(() => parseCmnToPlancks('abc')).toThrow();
    expect(() => parseCmnToPlancks('1.2.3')).toThrow();
    expect(() => parseCmnToPlancks('1e3')).toThrow();
    expect(() => parseCmnToPlancks('NaN')).toThrow();
    expect(() => parseCmnToPlancks('Infinity')).toThrow();
  });
});

describe('formatPlancksAsCmn', () => {
  it('renders whole tokens without a fraction', () => {
    expect(formatPlancksAsCmn(1_000_000_000_000n)).toBe('1');
    expect(formatPlancksAsCmn(0n)).toBe('0');
  });

  it('renders fractions without trailing zeros', () => {
    expect(formatPlancksAsCmn(500_000_000_000n)).toBe('0.5');
    expect(formatPlancksAsCmn(10_000_000_000n)).toBe('0.01');
    expect(formatPlancksAsCmn(1_000_000_000_001n)).toBe('1.000000000001');
  });

  it('round-trips with parseCmnToPlancks', () => {
    for (const s of ['0', '1', '0.5', '0.01', '2.25', '1.000000000001', '1000000']) {
      expect(formatPlancksAsCmn(parseCmnToPlancks(s))).toBe(s);
    }
  });
});
