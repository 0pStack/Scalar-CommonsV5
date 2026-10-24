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
 * Retry only recognized transport failures or pre-dispatch pool statuses (#29).
 *
 * polkadot-js WsProvider emits plain Errors, so recognize its specific connection
 * and request-timeout messages (including an RPC method prefix), plus Node socket
 * codes. Pool messages are constructed by our submission boundary. Fail closed
 * for unknown errors; never infer retryability from a runtime variant's name.
 */
export function isRetryableFailure(err: unknown): boolean {
  if (!(err instanceof Error) || isDeterministicFailure(err) || err.name === 'DispatchFailure') {
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
