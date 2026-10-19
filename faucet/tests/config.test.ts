/**
 * The default drip has to fund the flow the faucet exists for, with room to spare.
 *
 * Issue #162: at 1 100 CMN one drip cleared agent registration (minStake 1 000 +
 * baseRegistrationFee 50 + ED 0.01 = 1 050.01 CMN) by 49.99 CMN. A 100 CMN demo
 * transfer before registering left the tester 0.0001 CMN short of minStake, and
 * the per-address window then stranded them for an hour.
 */

import { describe, expect, it } from 'vitest';
import { configFromEnv } from '../src/config.js';

const CMN = 1_000_000_000_000n;

/** minStake 1 000 + baseRegistrationFee 50 + existentialDeposit 0.01, from the live chain. */
const REGISTRATION_FLOOR = 1_050n * CMN + CMN / 100n;

/** The 100 CMN demo transfer that stranded the tester in #162. */
const DEMO_TRANSFER = 100n * CMN;

describe('configFromEnv — default drip (#162)', () => {
  it('covers one registration plus an ordinary 100 CMN experiment', () => {
    const { dripAmountPlancks } = configFromEnv({});
    expect(dripAmountPlancks).toBeGreaterThanOrEqual(REGISTRATION_FLOOR + DEMO_TRANSFER);
  });

  it('is 1 500 CMN, leaving ~450 CMN of slack after registering', () => {
    expect(configFromEnv({}).dripAmountPlancks).toBe(1_500n * CMN);
  });

  it('still yields to FAUCET_DRIP_CMN', () => {
    expect(configFromEnv({ FAUCET_DRIP_CMN: '1100' }).dripAmountPlancks).toBe(1_100n * CMN);
  });

  it('keeps the worst case per IP bounded: 5 drips/hour is 7 500 CMN', () => {
    const c = configFromEnv({});
    expect(c.dripAmountPlancks * BigInt(c.perIp.maxRequests)).toBe(7_500n * CMN);
    expect(c.perAddress.windowMs).toBe(60 * 60_000);
  });
});
