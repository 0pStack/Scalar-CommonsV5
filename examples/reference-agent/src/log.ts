/**
 * One JSON object per line on stdout, so journald (`journalctl -u scalar-agent -o cat`)
 * and any log shipper can parse it without a regex.
 */
import type { Logger } from '@scalar-commons/sdk';

export function log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }, (_k, v) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
  if (level === 'error') console.error(line);
  else console.log(line);
}

/** Adapts {@link log} to the SDK's Logger interface, so SDK retry notices land in the same stream. */
export const sdkLogger: Logger = {
  info: (m, meta) => log('info', m, { sdk: true, ...(meta as object) }),
  warn: (m, meta) => log('warn', m, { sdk: true, ...(meta as object) }),
  error: (m, meta) => log('error', m, { sdk: true, ...(meta as object) }),
};
