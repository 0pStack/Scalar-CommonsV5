/**
 * Minimal structured logger used by the submit layer.
 *
 * The SDK never swallows a retry silently — every retry is emitted through this
 * logger with the attempt number and the underlying error (see {@link ./retry}).
 * Consumers can inject their own logger (pino, winston, a test spy, …) as long
 * as it satisfies this interface.
 */
export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Default logger: writes to the console, prefixing every line with `[scalar-sdk]`. */
export const consoleLogger: Logger = {
  info: (message, meta) => console.info(`[scalar-sdk] ${message}`, meta ?? ''),
  warn: (message, meta) => console.warn(`[scalar-sdk] ${message}`, meta ?? ''),
  error: (message, meta) => console.error(`[scalar-sdk] ${message}`, meta ?? ''),
};

/** Extract a human-readable message from any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
