/**
 * The default drip has to fund the flow the faucet exists for, with room to spare.
 *
 * Issue #162: at 1 100 CMN one drip cleared agent registration (minStake 1 000 +
 * baseRegistrationFee 50 + ED 0.01 = 1 050.01 CMN) by 49.99 CMN. A 100 CMN demo
 * transfer before registering left the tester 0.0001 CMN short of minStake, and
 * the per-address window then stranded them for an hour.
 */

import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

  it('refuses a soft-path dev URI such as /Alice unless explicitly allowed', () => {
    expect(() => configFromEnv({ FAUCET_SEED: '/Alice' })).toThrow(/published dev seed/);
    expect(() => configFromEnv({ FAUCET_SEED: '/Alice//stash' })).toThrow(/published dev seed/);
    expect(configFromEnv({ ...DEV, FAUCET_SEED: '/Alice' }).faucetSeed).toBe('/Alice');
    expect(configFromEnv({ ...DEV, FAUCET_SEED: '/Alice//stash' }).faucetSeed).toBe(
      '/Alice//stash',
    );
  });

  it('names every dev-seed form in the refusal', () => {
    expect(() => configFromEnv({ FAUCET_SEED: '//Ferdie' })).toThrow(
      '(/Name, //Name or the dev phrase)',
    );
  });

  it('refuses the published dev phrase, bare or derived, unless explicitly allowed', () => {
    expect(() => configFromEnv({ FAUCET_SEED: DEV_PHRASE })).toThrow(/published dev seed/);
    expect(() => configFromEnv({ FAUCET_SEED: `${DEV_PHRASE}//Alice` })).toThrow(
      /published dev seed/,
    );
    expect(configFromEnv({ ...DEV, FAUCET_SEED: DEV_PHRASE }).faucetSeed).toBe(DEV_PHRASE);
  });

  it('never echoes the seed, which can carry a ///password', () => {
    expect(() => configFromEnv({ FAUCET_SEED: '//Ferdie///hunter2' })).toThrow(
      /^(?![\s\S]*hunter2)/,
    );
  });

  it('treats an explicit opt-out and a padded dev URI the same as no opt-in', () => {
    expect(() =>
      configFromEnv({ FAUCET_SEED: '//Ferdie', FAUCET_ALLOW_DEV_SEED: 'false' }),
    ).toThrow(/published dev seed/);
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

/**
 * F11 (#20): the per-address and per-IP budgets bound one requester; only a total
 * budget bounds the faucet. The defaults are the issue's: 20 drips an hour and
 * 50 a day, so the worst case is one day's budget however many IPs ask.
 */
describe('configFromEnv — total budget, timeouts and state (F11, #20)', () => {
  const HOUR = 60 * 60_000;

  it('caps the faucet at 20 drips an hour and 50 a day by default', () => {
    expect(configFromEnv(DEV).global).toEqual([
      { maxRequests: 20, windowMs: HOUR },
      { maxRequests: 50, windowMs: 24 * HOUR },
    ]);
  });

  it('keeps the worst case per day bounded: 50 drips is 75 000 CMN', () => {
    const c = configFromEnv(DEV);
    const daily = c.global.find((rule) => rule.windowMs === 24 * HOUR);
    expect(c.dripAmountPlancks * BigInt(daily?.maxRequests ?? 0)).toBe(75_000n * CMN);
  });

  it('yields to FAUCET_GLOBAL_HOURLY_MAX and FAUCET_GLOBAL_DAILY_MAX', () => {
    const c = configFromEnv({
      ...DEV,
      FAUCET_GLOBAL_HOURLY_MAX: '3',
      FAUCET_GLOBAL_DAILY_MAX: '7',
    });
    expect(c.global.map((rule) => rule.maxRequests)).toEqual([3, 7]);
  });

  it('refuses a zero total budget rather than switching the cap off', () => {
    expect(() => configFromEnv({ ...DEV, FAUCET_GLOBAL_HOURLY_MAX: '0' })).toThrow(
      /FAUCET_GLOBAL_HOURLY_MAX/,
    );
    expect(() => configFromEnv({ ...DEV, FAUCET_GLOBAL_DAILY_MAX: '0' })).toThrow(
      /FAUCET_GLOBAL_DAILY_MAX/,
    );
  });

  it('refuses a daily budget smaller than the hourly one', () => {
    expect(() =>
      configFromEnv({ ...DEV, FAUCET_GLOBAL_HOURLY_MAX: '30', FAUCET_GLOBAL_DAILY_MAX: '20' }),
    ).toThrow(/FAUCET_GLOBAL_DAILY_MAX/);
  });
});

/**
 * Agents abort a drip request after 60 s (agent/src/onboard.ts) and nginx gives
 * up on the faucet at 60 s, so waiting for the lock, for inclusion and for
 * finality must together finish well inside that.
 */
describe('configFromEnv — the drip deadline (F11, #20)', () => {
  it('waits 10 s for its turn, 18 s for inclusion and 24 s for finality by default', () => {
    const c = configFromEnv(DEV);
    expect([c.lockWaitMs, c.inclusionTimeoutMs, c.finalityTimeoutMs]).toEqual([
      10_000, 18_000, 24_000,
    ]);
  });

  it('yields to the timeout overrides', () => {
    const c = configFromEnv({
      ...DEV,
      FAUCET_LOCK_WAIT_SECONDS: '5',
      FAUCET_INCLUSION_TIMEOUT_SECONDS: '20',
      FAUCET_FINALITY_TIMEOUT_SECONDS: '30',
    });
    expect([c.lockWaitMs, c.inclusionTimeoutMs, c.finalityTimeoutMs]).toEqual([
      5_000, 20_000, 30_000,
    ]);
  });

  it('refuses a zero timeout', () => {
    expect(() => configFromEnv({ ...DEV, FAUCET_FINALITY_TIMEOUT_SECONDS: '0' })).toThrow(
      /FAUCET_FINALITY_TIMEOUT_SECONDS/,
    );
    expect(() => configFromEnv({ ...DEV, FAUCET_LOCK_WAIT_SECONDS: '0' })).toThrow(
      /FAUCET_LOCK_WAIT_SECONDS/,
    );
  });

  it('refuses timeouts that add up to the 60 s callers wait', () => {
    expect(() =>
      configFromEnv({
        ...DEV,
        FAUCET_LOCK_WAIT_SECONDS: '10',
        FAUCET_INCLUSION_TIMEOUT_SECONDS: '25',
        FAUCET_FINALITY_TIMEOUT_SECONDS: '25',
      }),
    ).toThrow(/60 s/);
  });
});

describe('configFromEnv — where the limits are kept (F11, #20)', () => {
  it('keeps them in a state file under the user state directory by default', () => {
    expect(configFromEnv(DEV).stateFile).toBe(
      join(homedir(), '.local', 'state', 'scalar-commons', 'faucet-limits.json'),
    );
  });

  it('yields to FAUCET_STATE_FILE', () => {
    expect(
      configFromEnv({ ...DEV, FAUCET_STATE_FILE: '/var/lib/faucet/limits.json' }).stateFile,
    ).toBe('/var/lib/faucet/limits.json');
  });

  it('refuses a relative FAUCET_STATE_FILE, which would follow the working directory', () => {
    expect(() => configFromEnv({ ...DEV, FAUCET_STATE_FILE: 'limits.json' })).toThrow(
      /FAUCET_STATE_FILE/,
    );
  });
});
