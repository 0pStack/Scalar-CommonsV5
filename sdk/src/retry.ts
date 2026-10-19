import { isDeterministicFailure } from './errors.js';
import { consoleLogger, errorMessage, type Logger } from './logger.js';

/** Options controlling the no-silent-retry wrapper. */
export interface RetryOptions {
  /**
   * Number of *retries* after the first attempt. `0` disables retrying.
   * Total attempts = `maxRetries + 1`. Defaults to `3`.
   */
  maxRetries?: number;
  /** Base delay (ms) between attempts; grows linearly with the attempt number. Defaults to `1000`. */
  retryDelayMs?: number;
  /** Logger for retry/failure notices. Defaults to {@link consoleLogger}. */
  logger?: Logger;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying on failure up to `maxRetries` times.
 *
 * First principle of this SDK: **no silent retries.** Every retry is logged at
 * `warn` with the attempt number and the error that triggered it; the final
 * give-up is logged at `error`. Callers therefore always have a paper trail of
 * how many times an operation was attempted and why.
 *
 * @param fn    Operation to run. Receives the 1-based attempt number.
 * @param label Human name for the operation, used in log lines.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  label: string,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const logger = options.logger ?? consoleLogger;
  const totalAttempts = maxRetries + 1;

  let lastError: unknown;
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      // #160: a dispatch error would recur and cost another fee — give up at once.
      if (isDeterministicFailure(err)) {
        logger.error(`${label} failed on attempt ${attempt}/${totalAttempts}; deterministic error, not retrying`, {
          attempt,
          totalAttempts,
          error: errorMessage(err),
        });
        throw err;
      }
      if (attempt < totalAttempts) {
        // NOT silent: surface the failed attempt and that we are retrying.
        logger.warn(`${label} failed on attempt ${attempt}/${totalAttempts}; retrying`, {
          attempt,
          totalAttempts,
          error: errorMessage(err),
        });
        await sleep(retryDelayMs * attempt);
      } else {
        logger.error(`${label} failed on attempt ${attempt}/${totalAttempts}; giving up`, {
          attempt,
          totalAttempts,
          error: errorMessage(err),
        });
      }
    }
  }
  throw lastError;
}
