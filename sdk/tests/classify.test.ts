import { describe, it, expect, vi } from 'vitest';

import { withRetry } from '../src/retry.js';
import { DispatchFailure, isDeterministicFailure } from '../src/errors.js';
import type { Logger } from '../src/logger.js';

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** #160: a dispatch error is decided by the runtime; resubmitting only burns another fee. */
describe('isDeterministicFailure — #160 classification', () => {
  const deterministic: [string, string][] = [
    ['escrow', 'MinDeliveryBlocksNotElapsed'],
    ['system', 'BadOrigin'],
    ['balances', 'InsufficientBalance'],
    ['agents', 'InsufficientStake'],
    ['escrow', 'InsufficientFunds'],
  ];
  it.each(deterministic)('%s.%s is deterministic', (section, name) => {
    expect(isDeterministicFailure(new DispatchFailure(section, name, 'docs'))).toBe(true);
  });

  it('leaves other dispatch errors retryable (unchanged behaviour)', () => {
    expect(isDeterministicFailure(new DispatchFailure('agents', 'NotRegistered', ''))).toBe(false);
  });

  it('treats transport and pool errors as retryable', () => {
    expect(isDeterministicFailure(new Error('transaction not included: status=Dropped'))).toBe(false);
    expect(isDeterministicFailure(new Error('WebSocket is not connected'))).toBe(false);
    expect(isDeterministicFailure('boom')).toBe(false);
  });
});

describe('withRetry — deterministic dispatch errors are not retried (#160)', () => {
  for (const [section, name] of [
    ['escrow', 'MinDeliveryBlocksNotElapsed'],
    ['system', 'BadOrigin'],
    ['balances', 'InsufficientBalance'],
  ]) {
    it(`${section}.${name}: one attempt, rethrown as-is`, async () => {
      const err = new DispatchFailure(section!, name!, '');
      const fn = vi.fn(async () => {
        throw err;
      });
      await expect(withRetry(fn, 'tx', { logger: silent, maxRetries: 3, retryDelayMs: 0 })).rejects.toBe(err);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  }

  it('logs the give-up at error and never logs a retry', async () => {
    const calls: string[] = [];
    const logger: Logger = {
      info: () => {},
      warn: () => calls.push('warn'),
      error: () => calls.push('error'),
    };
    await expect(
      withRetry(
        async () => {
          throw new DispatchFailure('system', 'BadOrigin', '');
        },
        'tx',
        { logger, retryDelayMs: 0 },
      ),
    ).rejects.toThrow('system.BadOrigin');
    expect(calls).toEqual(['error']);
  });

  it('still retries transient errors', async () => {
    const fn = vi.fn(async (attempt: number) => {
      if (attempt < 3) throw new Error('transaction not included: status=Dropped');
      return 'ok';
    });
    await expect(withRetry(fn, 'tx', { logger: silent, retryDelayMs: 0 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
