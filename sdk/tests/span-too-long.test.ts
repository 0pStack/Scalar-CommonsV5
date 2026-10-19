import { describe, it, expect, vi } from 'vitest';

import { withRetry } from '../src/retry.js';
import { DispatchFailure, isDeterministicFailure } from '../src/errors.js';
import type { Logger } from '../src/logger.js';

/** A logger that records every line, so "no silent retries" stays checkable. */
function spyLogger(): Logger & {
  calls: { level: string; message: string; meta?: Record<string, unknown> }[];
} {
  const calls: { level: string; message: string; meta?: Record<string, unknown> }[] = [];
  return {
    calls,
    info: (message, meta) => calls.push({ level: 'info', message, meta }),
    warn: (message, meta) => calls.push({ level: 'warn', message, meta }),
    error: (message, meta) => calls.push({ level: 'error', message, meta }),
  };
}

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * E21 (#198) replaced spec 306's silent deadline clamp with `escrow::SpanTooLong`.
 * It fires when `deliver_by` exceeds `MaxAgreementSpan`, a runtime constant, so the
 * verdict follows from the call arguments — attempt four fails exactly as attempt
 * one did, three fees later (#219, #225).
 */
describe('escrow.SpanTooLong is deterministic (#225)', () => {
  it('isDeterministicFailure is true for escrow.SpanTooLong', () => {
    const err = new DispatchFailure(
      'escrow',
      'SpanTooLong',
      'The requested deadline is further out than MaxAgreementSpan allows (E21).',
    );
    expect(isDeterministicFailure(err)).toBe(true);
  });

  it('withRetry attempts it exactly once and rethrows the original error', async () => {
    const err = new DispatchFailure('escrow', 'SpanTooLong', '');
    const fn = vi.fn(async () => {
      throw err;
    });

    await expect(
      withRetry(fn, 'createEscrow', { logger: silent, maxRetries: 3, retryDelayMs: 0 }),
    ).rejects.toBe(err);
    // maxRetries 3 would have meant four submissions, and four fees.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('logs the no-retry decision through the injected logger', async () => {
    const logger = spyLogger();
    await expect(
      withRetry(
        async () => {
          throw new DispatchFailure('escrow', 'SpanTooLong', 'deadline beyond MaxAgreementSpan');
        },
        'createEscrow',
        { logger, maxRetries: 3, retryDelayMs: 0 },
      ),
    ).rejects.toThrow('escrow.SpanTooLong');

    // Exactly one line, at error, naming the attempt and the reason. Never a retry warning.
    expect(logger.calls.filter((c) => c.level === 'warn')).toHaveLength(0);
    const errors = logger.calls.filter((c) => c.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('attempt 1/4');
    expect(errors[0]?.message).toContain('deterministic error, not retrying');
    expect(errors[0]?.meta).toMatchObject({ attempt: 1, totalAttempts: 4 });
    expect(errors[0]?.meta?.error).toContain('escrow.SpanTooLong');
  });
});

/**
 * The other guards promoted with #225: each is decided by the call arguments and a
 * runtime constant alone, so no amount of resubmission changes the verdict.
 */
describe('argument-only escrow guards are deterministic (#225)', () => {
  const deterministic: [string, string][] = [
    // buyer != provider — the signer and the `provider` argument, nothing else.
    ['escrow', 'SelfDeal'],
    // deliver_by > now + MinDeliveryBlocks — argument vs runtime constant.
    ['escrow', 'DeadlineTooEarly'],
    // amount >= MinAgreementAmount — argument vs runtime constant.
    ['escrow', 'AmountTooLow'],
  ];

  it.each(deterministic)('%s.%s is deterministic', (section, name) => {
    expect(isDeterministicFailure(new DispatchFailure(section, name, ''))).toBe(true);
  });

  it.each(deterministic)('%s.%s is submitted once, not four times', async (section, name) => {
    const err = new DispatchFailure(section, name, '');
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(withRetry(fn, 'tx', { logger: silent, retryDelayMs: 0 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

/**
 * The other side of the boundary. These clear between attempts — a registration or a
 * capability can land while the retry loop is still running — so classifying them
 * would turn a recoverable failure into a hard one. The allowlist exists for this.
 */
describe('state-dependent errors stay retryable (#225)', () => {
  const retryable: [string, string][] = [
    ['agents', 'NotRegistered'],
    ['escrow', 'BuyerNotAgent'],
    ['escrow', 'ProviderNotAgent'],
    ['escrow', 'ProviderLacksCapability'],
  ];

  it.each(retryable)('%s.%s is not deterministic', (section, name) => {
    expect(isDeterministicFailure(new DispatchFailure(section, name, ''))).toBe(false);
  });

  it('agents.NotRegistered still costs the full four attempts', async () => {
    const logger = spyLogger();
    const err = new DispatchFailure('agents', 'NotRegistered', '');
    const fn = vi.fn(async () => {
      throw err;
    });

    await expect(
      withRetry(fn, 'heartbeat', { logger, maxRetries: 3, retryDelayMs: 0 }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(4);
    // Three retries announced, then one give-up: unchanged by #225.
    expect(logger.calls.filter((c) => c.level === 'warn')).toHaveLength(3);
    expect(logger.calls.filter((c) => c.level === 'error')).toHaveLength(1);
  });
});
