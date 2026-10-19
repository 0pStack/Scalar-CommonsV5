import { describe, it, expect } from 'vitest';

import { CMN_DECIMALS, PLANCKS_PER_CMN, SS58_PREFIX } from '../src/index.js';

describe('chain constants — the one definition every package imports', () => {
  it('CMN has 12 decimals (chain properties tokenDecimals)', () => {
    expect(CMN_DECIMALS).toBe(12);
  });

  it('PLANCKS_PER_CMN is 10^CMN_DECIMALS, as an exact bigint', () => {
    expect(PLANCKS_PER_CMN).toBe(1_000_000_000_000n);
    expect(PLANCKS_PER_CMN).toBe(10n ** BigInt(CMN_DECIMALS));
  });

  it('SS58_PREFIX is the runtime SS58Prefix (42, generic Substrate)', () => {
    expect(SS58_PREFIX).toBe(42);
  });
});
