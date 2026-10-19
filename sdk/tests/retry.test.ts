import { describe, it, expect, vi } from 'vitest';

import { withRetry } from '../src/retry.js';
import type { Logger } from '../src/logger.js';

function spyLogger(): Logger & { calls: { level: string; message: string; meta?: Record<string, unknown> }[] } {
  const calls: { level: string; message: string; meta?: Record<string, unknown> }[] = [];
  return {
    calls,
    info: (message, meta) => calls.push({ level: 'info', message, meta }),
    warn: (message, meta) => calls.push({ level: 'warn', message, meta }),
    error: (message, meta) => calls.push({ level: 'error', message, meta }),
  };
}

describe('withRetry — no silent retries', () => {
  it('does not log when the first attempt succeeds', async () => {
    const logger = spyLogger();
    const result = await withRetry(async () => 'ok', 'op', { logger, retryDelayMs: 0 });
    expect(result).toBe('ok');
    expect(logger.calls).toHaveLength(0);
  });

  it('logs every retry with the attempt number and error, then succeeds', async () => {
    const logger = spyLogger();
    let attempts = 0;
    const result = await withRetry(
      async (attempt) => {
        attempts = attempt;
        if (attempt < 3) throw new Error(`boom-${attempt}`);
        return 'recovered';
      },
      'flaky-op',
      { logger, maxRetries: 3, retryDelayMs: 0 },
    );

    expect(result).toBe('recovered');
    expect(attempts).toBe(3);

    // Two failed attempts => two warn lines. No silent retries.
    const warns = logger.calls.filter((c) => c.level === 'warn');
    expect(warns).toHaveLength(2);
    expect(warns[0]?.message).toContain('attempt 1/4');
    expect(warns[0]?.meta?.error).toBe('boom-1');
    expect(warns[1]?.message).toContain('attempt 2/4');
    expect(warns[1]?.meta?.error).toBe('boom-2');
    expect(logger.calls.some((c) => c.level === 'error')).toBe(false);
  });

  it('logs an error and rethrows after exhausting all attempts', async () => {
    const logger = spyLogger();
    await expect(
      withRetry(
        async (attempt) => {
          throw new Error(`fail-${attempt}`);
        },
        'doomed-op',
        { logger, maxRetries: 2, retryDelayMs: 0 },
      ),
    ).rejects.toThrow('fail-3');

    const warns = logger.calls.filter((c) => c.level === 'warn');
    const errors = logger.calls.filter((c) => c.level === 'error');
    expect(warns).toHaveLength(2); // attempts 1 and 2 retried
    expect(errors).toHaveLength(1); // attempt 3 gave up
    expect(errors[0]?.message).toContain('attempt 3/3');
    expect(errors[0]?.meta?.error).toBe('fail-3');
  });

  it('respects maxRetries = 0 (single attempt, no retry log)', async () => {
    const logger = spyLogger();
    const fn = vi.fn(async () => {
      throw new Error('once');
    });
    await expect(withRetry(fn, 'no-retry', { logger, maxRetries: 0, retryDelayMs: 0 })).rejects.toThrow(
      'once',
    );
    expect(fn).toHaveBeenCalledTimes(1);
    expect(logger.calls.filter((c) => c.level === 'warn')).toHaveLength(0);
    expect(logger.calls.filter((c) => c.level === 'error')).toHaveLength(1);
  });
});
