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

/** Local devnet opt-in; the drip tests below are about amounts, not the signer. */
const DEV = { FAUCET_ALLOW_DEV_SEED: 'true' };

// Any phrase but the published DEV_PHRASE; config does not validate the mnemonic itself.
const REAL_SEED = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const DEV_PHRASE = 'bottom drive obey lake curtain smoke basket hold race lonely fit walk';

describe('configFromEnv — default drip (#162)', () => {
  it('covers one registration plus an ordinary 100 CMN experiment', () => {
    const { dripAmountPlancks } = configFromEnv(DEV);
    expect(dripAmountPlancks).toBeGreaterThanOrEqual(REGISTRATION_FLOOR + DEMO_TRANSFER);
  });

  it('is 1 500 CMN, leaving ~450 CMN of slack after registering', () => {
    expect(configFromEnv(DEV).dripAmountPlancks).toBe(1_500n * CMN);
  });

  it('still yields to FAUCET_DRIP_CMN', () => {
    expect(configFromEnv({ ...DEV, FAUCET_DRIP_CMN: '1100' }).dripAmountPlancks).toBe(1_100n * CMN);
  });

  it('keeps the worst case per IP bounded: 5 drips/hour is 7 500 CMN', () => {
    const c = configFromEnv(DEV);
    expect(c.dripAmountPlancks * BigInt(c.perIp.maxRequests)).toBe(7_500n * CMN);
    expect(c.perAddress.windowMs).toBe(60 * 60_000);
  });
});

describe('configFromEnv — signing seed (I-6, #123)', () => {
  it('refuses to boot without FAUCET_SEED', () => {
    expect(() => configFromEnv({})).toThrow(/FAUCET_SEED is required/);
  });

  it('refuses a dev URI such as //Ferdie unless explicitly allowed', () => {
    expect(() => configFromEnv({ FAUCET_SEED: '//Ferdie' })).toThrow(/published dev seed/);
    expect(() => configFromEnv({ FAUCET_SEED: '//Alice//stash' })).toThrow(/published dev seed/);
  });

  it('refuses the published dev phrase, bare or derived, unless explicitly allowed', () => {
    expect(() => configFromEnv({ FAUCET_SEED: DEV_PHRASE })).toThrow(/published dev seed/);
    expect(() => configFromEnv({ FAUCET_SEED: `${DEV_PHRASE}//Alice` })).toThrow(/published dev seed/);
    expect(configFromEnv({ ...DEV, FAUCET_SEED: DEV_PHRASE }).faucetSeed).toBe(DEV_PHRASE);
  });

  it('never echoes the seed, which can carry a ///password', () => {
    expect(() => configFromEnv({ FAUCET_SEED: '//Ferdie///hunter2' })).toThrow(/^(?![\s\S]*hunter2)/);
  });

  it('treats an explicit opt-out and a padded dev URI the same as no opt-in', () => {
    expect(() => configFromEnv({ FAUCET_SEED: '//Ferdie', FAUCET_ALLOW_DEV_SEED: 'false' })).toThrow(/published dev seed/);
    expect(() => configFromEnv({ FAUCET_SEED: '  //Ferdie ' })).toThrow(/published dev seed/);
    expect(() => configFromEnv({ FAUCET_SEED: '   ' })).toThrow(/FAUCET_SEED is required/);
  });

  it('accepts a real seed without the opt-in', () => {
    expect(configFromEnv({ FAUCET_SEED: REAL_SEED }).faucetSeed).toBe(REAL_SEED);
  });

  it('falls back to //Ferdie only when FAUCET_ALLOW_DEV_SEED is set', () => {
    expect(configFromEnv(DEV).faucetSeed).toBe('//Ferdie');
    expect(configFromEnv({ ...DEV, FAUCET_SEED: '//Bob' }).faucetSeed).toBe('//Bob');
  });

  it('rejects a malformed FAUCET_ALLOW_DEV_SEED rather than guessing', () => {
    expect(() => configFromEnv({ FAUCET_ALLOW_DEV_SEED: 'yes' })).toThrow(/FAUCET_ALLOW_DEV_SEED/);
  });
});
