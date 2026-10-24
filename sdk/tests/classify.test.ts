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

  it('stops every dispatch error, including state-dependent and future variants (#29)', () => {
    expect(isDeterministicFailure(new DispatchFailure('agents', 'NotRegistered', ''))).toBe(true);
    expect(isDeterministicFailure(new DispatchFailure('newPallet', 'FutureGuard', ''))).toBe(true);
  });

  it('treats transport and pool errors as retryable', () => {
    expect(isDeterministicFailure(new Error('transaction not included: status=Dropped'))).toBe(
      false,
    );
    expect(isDeterministicFailure(new Error('WebSocket is not connected'))).toBe(false);
    expect(isDeterministicFailure('boom')).toBe(false);
  });
});

describe('withRetry — deterministic dispatch errors are not retried (#160)', () => {
  for (const [section, name] of [
    ['escrow', 'MinDeliveryBlocksNotElapsed'],
    ['system', 'BadOrigin'],
    ['balances', 'InsufficientBalance'],
    ['agents', 'NotRegistered'],
    ['escrow', 'ProviderLacksCapability'],
    ['orchestrator', 'SeqOverflow'],
    ['newPallet', 'FutureGuard'],
    ['system', 'Token'],
    ['system', 'Arithmetic'],
  ]) {
    it(`${section}.${name}: one attempt, rethrown as-is`, async () => {
      const err = new DispatchFailure(section!, name!, '');
      const fn = vi.fn(async () => {
        throw err;
      });
      await expect(
        withRetry(fn, 'tx', { logger: silent, maxRetries: 3, retryDelayMs: 0 }),
      ).rejects.toBe(err);
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

/** #29: only recognizable transport and pool failures may cause resubmission. */
describe('withRetry — transient failures only', () => {
  it.each([
    new Error('application validation failed'),
    new TypeError('cannot encode this argument'),
    new Error('transaction not included: status=Ready'),
    Object.assign(new Error('WebSocket is not connected'), {
      name: 'DispatchFailure',
      code: 'ECONNRESET',
    }),
    'untyped failure',
    { message: 'WebSocket is not connected' },
    null,
  ])('stops an unknown failure after one attempt: %s', async (err) => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(withRetry(fn, 'tx', { logger, retryDelayMs: 0 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it.each([
    new Error('WebSocket is not connected'),
    new Error('author_submitAndWatchExtrinsic: WebSocket is not connected'),
    new Error('disconnected from ws://localhost:9944: 1006:: Abnormal Closure'),
    new Error('No response received from RPC endpoint in 60s'),
    Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
    ...['Dropped', 'Invalid', 'Usurped'].map(
      (status) => new Error(`transaction not included: status=${status}`),
    ),
  ])('retries a recognizable transient failure: %s', async (err) => {
    const fn = vi.fn(async (attempt: number) => {
      if (attempt === 1) throw err;
      return 'included';
    });
    await expect(withRetry(fn, 'tx', { logger: silent, retryDelayMs: 0 })).resolves.toBe(
      'included',
    );
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not let transport-like dispatch docs override the dispatch boundary', async () => {
    const err = new DispatchFailure('future', 'NewError', 'WebSocket is not connected');
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(withRetry(fn, 'tx', { logger: silent, retryDelayMs: 0 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
