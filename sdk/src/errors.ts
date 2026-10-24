/**
 * A dispatch error returned by the runtime after an extrinsic reached a block.
 *
 * Inclusion already charged a fee. Surface the failure to the caller instead of
 * paying again automatically, even if later chain state could change the result.
 */
export class DispatchFailure extends Error {
  constructor(
    /** Pallet name (`system` for non-module errors such as `BadOrigin`). */
    readonly section: string,
    /** Runtime error variant, including variants unknown to this SDK version. */
    readonly errorName: string,
    docs: string,
  ) {
    super(`${section}.${errorName}${docs ? `: ${docs}` : ''}`);
    this.name = 'DispatchFailure';
  }
}

/** Base class for failures produced by the SDK submission boundary. */
export class SubmitError extends Error {
  readonly cause: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'SubmitError';
    this.cause = options?.cause;
  }
}

/** A terminal or retryable status reported by the transaction pool. */
export class SubmitStatusError extends SubmitError {
  constructor(
    readonly status: string,
    readonly txHash: string | undefined,
    readonly retryable: boolean,
  ) {
    super(`transaction not included: status=${status}`);
    this.name = 'SubmitStatusError';
  }
}

/** A transport failure while submitting or watching an extrinsic. */
export class SubmitTransportError extends SubmitError {
  constructor(
    message: string,
    readonly txHash: string | undefined,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SubmitTransportError';
  }
}

/** A bounded SDK operation exceeded its configured deadline. */
export class TimeoutError extends SubmitError {
  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Compatibility predicate: every dispatch failure stops automatic retries (#29).
 *
 * The historical name describes the retry policy, not whether future chain state
 * can change the result. Keep this export for existing SDK consumers.
 */
export function isDeterministicFailure(err: unknown): boolean {
  return err instanceof DispatchFailure;
}

/** Node transport codes; an arbitrary application error is not a retry signal. */
const TRANSPORT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/**
 * Retry only failures whose pre-dispatch status is known (#29, #74).
 *
 * Typed submission failures carry the decision made at the submission boundary.
 * Raw transport errors remain supported for callers using `withRetry` directly.
 */
export function isRetryableFailure(err: unknown): boolean {
  if (err instanceof SubmitStatusError || err instanceof SubmitTransportError) {
    return err.retryable;
  }
  if (
    !(err instanceof Error) ||
    err instanceof TimeoutError ||
    isDeterministicFailure(err) ||
    err.name === 'DispatchFailure'
  ) {
    return false;
  }
  const code = 'code' in err ? err.code : undefined;
  if (typeof code === 'string' && TRANSPORT_CODES.has(code)) return true;

  return (
    /^transaction not included: status=(Dropped|Invalid|Usurped)$/.test(err.message) ||
    /(?:^|: )WebSocket is not connected$/.test(err.message) ||
    /(?:^|: )disconnected from wss?:\/\/\S+: \d+::(?: .*)?$/.test(err.message) ||
    /(?:^|: )No response received from RPC endpoint in \d+(?:\.\d+)?s$/.test(err.message)
  );
}
