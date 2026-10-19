/**
 * The money maths, offline.
 *
 * Everything downstream is a report about whether an attack pays, so a sign
 * error or a precision loss here would not produce a wrong number — it would
 * produce a wrong LAUNCH DECISION. ENDGOAL §3.4: "If wash trading still pays,
 * the project does not launch."
 */
import { describe, expect, it } from 'vitest';
import { cmnToPlancks, plancksToCmn, signedCmn, PLANCKS_PER_CMN } from '../src/units.mjs';

describe('cmnToPlancks', () => {
  it('converts whole CMN exactly', () => {
    expect(cmnToPlancks(1)).toBe(PLANCKS_PER_CMN);
    expect(cmnToPlancks(1000)).toBe(1_000_000_000_000_000n);
  });
  it('converts fractional CMN to the last planck', () => {
    expect(cmnToPlancks('0.000000000001')).toBe(1n);
    expect(cmnToPlancks('1050.01')).toBe(1_050_010_000_000_000n);
  });
  it('handles negatives, which a net figure can be', () => {
    expect(cmnToPlancks('-1050.01')).toBe(-1_050_010_000_000_000n);
  });
  it('refuses more precision than a planck', () => {
    expect(() => cmnToPlancks('0.0000000000001')).toThrow(/decimal places/);
  });
  it('refuses junk rather than coercing it to zero', () => {
    for (const bad of ['', 'abc', '1e12', '1.2.3', ' ']) expect(() => cmnToPlancks(bad)).toThrow();
  });
});

describe('plancksToCmn', () => {
  it('never uses scientific notation, however large', () => {
    // 5 000 000 CMN is a normal faucet balance and is far above 2^53 plancks.
    const s = plancksToCmn(5_000_000n * PLANCKS_PER_CMN, 4);
    expect(s).toBe('5000000.0000');
    expect(s).not.toMatch(/e/i);
  });
  it('truncates rather than rounding, so a cost is never understated', () => {
    expect(plancksToCmn(1_999_999_999_999n, 2)).toBe('1.99');
  });
  it('keeps the sign', () => {
    expect(plancksToCmn(-PLANCKS_PER_CMN, 2)).toBe('-1.00');
  });
});

describe('signedCmn', () => {
  it('always carries a sign, because the sign IS the finding', () => {
    expect(signedCmn(PLANCKS_PER_CMN)).toBe('+1.0000');
    expect(signedCmn(-PLANCKS_PER_CMN)).toBe('-1.0000');
  });
  it('renders break-even as +0, not as a loss', () => {
    expect(signedCmn(0n)).toBe('+0.0000');
  });
  it('survives a full round trip at scale', () => {
    const p = cmnToPlancks('123456.789012');
    expect(cmnToPlancks(plancksToCmn(p, 6))).toBe(p);
  });
});
