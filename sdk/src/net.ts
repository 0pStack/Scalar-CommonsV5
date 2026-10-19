const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * True only for an exact loopback hostname, as `new URL(…).hostname` reports it
 * (IPv6 keeps its brackets). Compare parsed hostnames, never URL prefixes: a
 * prefix check would accept `localhost.evil.example`.
 */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname);
}
