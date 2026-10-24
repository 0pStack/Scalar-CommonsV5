const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * True only for an exact loopback hostname, as `new URL(…).hostname` reports it
 * (IPv6 keeps its brackets). Compare parsed hostnames, never URL prefixes: a
 * prefix check would accept `localhost.evil.example`.
 */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname);
}

/**
 * Reject literal addresses that route to the local host or a non-public network.
 * `URL.hostname` normalizes unusual IPv4 forms before this function sees them.
 */
export function isPrivateNetworkHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  if (isLoopbackHostname(normalized) || normalized.endsWith('.localhost')) return true;

  const ipv6 =
    normalized.startsWith('[') && normalized.endsWith(']') ? normalized.slice(1, -1) : normalized;
  if (ipv6.includes(':')) {
    return (
      ipv6 === '::' ||
      ipv6 === '::1' ||
      ipv6.startsWith('fc') ||
      ipv6.startsWith('fd') ||
      /^fe[89ab]/.test(ipv6) ||
      ipv6.startsWith('::ffff:')
    );
  }

  const parts = normalized.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}
