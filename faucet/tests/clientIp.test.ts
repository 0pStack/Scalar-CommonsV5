/**
 * faucet/tests/clientIp.test.ts — the per-IP limit must key on a hop the caller
 * cannot choose.
 *
 * WHY THIS TEST EXISTS
 *
 * X-Forwarded-For is client-supplied. Whatever a caller sends arrives intact;
 * a trusted proxy only APPENDS the peer it actually saw. `clientIp()` used to
 * read the LEFT-most entry, which is therefore fully attacker-controlled: with
 * nginx's stock appending variable, `X-Forwarded-For: 1.2.3.4` becomes
 * "1.2.3.4, <real ip>", and the faucet handed the attacker a fresh rate-limit
 * bucket for every forged value. Four forged headers all returned 200 in the
 * audit's testing. docs/history/TESTNETAUDIT.md §6 I-6, issue #123.
 *
 * The fix reads the RIGHT-most entry — the one our own proxy appended, the only
 * one a remote caller cannot choose. The vhost additionally overwrites the
 * header so the list is one entry long, but these cases deliberately cover the
 * appending shape too: a config change elsewhere must not silently re-open a
 * rate-limit bypass.
 *
 * Drives the real clientIp() against a minimal IncomingMessage stand-in. No
 * chain, no network, no HTTP server.
 */

import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { clientIp, createFaucetServer, ipBucket } from '../src/server.ts';
import type { FaucetService } from '../src/faucet.ts';

const PEER = '198.51.100.7';

/**
 * The two fields clientIp() reads, and nothing else.
 *
 * `remoteAddress` is an explicit object property rather than a defaulted
 * parameter: a default of `PEER` would swallow an explicitly-passed `undefined`
 * and quietly turn the no-peer case into the has-peer case, which is exactly
 * the assertion that case exists to make.
 */
function req(xff?: string | string[], opts: { remoteAddress?: string } = { remoteAddress: PEER }): IncomingMessage {
  return {
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
    socket: { remoteAddress: opts.remoteAddress },
  } as unknown as IncomingMessage;
}

describe('clientIp: the rate-limit key must not be attacker-chosen', () => {
  it('takes the RIGHT-most hop, not the forged left-most one', () => {
    // Exactly what nginx's appending variable produces when a caller forges a value.
    expect(clientIp(req('1.2.3.4, 203.0.113.9'), true)).toBe('203.0.113.9');
  });

  it('gives every forged prefix the SAME bucket', () => {
    // The bypass in one assertion: four different forged values, one real peer.
    const seen = ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4'].map((f) =>
      clientIp(req(`${f}, 203.0.113.9`), true),
    );
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toBe('203.0.113.9');
  });

  it('is not fooled by a forged value that itself contains commas', () => {
    expect(clientIp(req('1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.9'), true)).toBe('203.0.113.9');
  });

  it('handles the overwriting vhost, where the list is one entry', () => {
    expect(clientIp(req('203.0.113.9'), true)).toBe('203.0.113.9');
  });

  it('tolerates whitespace and empty entries without picking a blank key', () => {
    expect(clientIp(req('  1.2.3.4 ,  , 203.0.113.9  '), true)).toBe('203.0.113.9');
  });

  it('falls back to the socket peer when the header is only separators', () => {
    expect(clientIp(req(' , , '), true)).toBe(PEER);
  });

  it('ignores the header entirely when trustProxy is false', () => {
    expect(clientIp(req('1.2.3.4, 203.0.113.9'), false)).toBe(PEER);
  });

  it('falls back to the socket peer when the header is absent', () => {
    expect(clientIp(req(undefined), true)).toBe(PEER);
  });

  it('never returns an empty string, even with no peer and no header', () => {
    expect(clientIp(req(undefined, {}), true)).toBe('unknown');
  });
});

/**
 * F11 (#20): one IPv6 subscriber is usually handed a whole /64, so keying the
 * per-IP budget on the full address gives them 2^64 fresh buckets. The budget
 * has to be spent against the /64 instead.
 */
describe('ipBucket: one IPv6 subscriber is one bucket (F11, #20)', () => {
  it('leaves IPv4 untouched', () => {
    expect(ipBucket('203.0.113.9')).toBe('203.0.113.9');
  });

  it('puts two addresses from the same /64 in one bucket', () => {
    expect(ipBucket('2001:db8:1:2::1')).toBe(ipBucket('2001:db8:1:2:ffff:ffff:ffff:fffe'));
  });

  it('separates different /64s', () => {
    expect(ipBucket('2001:db8:1:2::1')).not.toBe(ipBucket('2001:db8:1:3::1'));
  });

  it('treats compressed and expanded spellings of the same prefix alike', () => {
    expect(ipBucket('2001:db8::1')).toBe(ipBucket('2001:0DB8:0000:0000:0000:0000:0000:0002'));
  });

  it('names the bucket by its /64 prefix', () => {
    expect(ipBucket('2001:db8:a:b:1:2:3:4')).toBe('2001:db8:a:b::/64');
    expect(ipBucket('2001:db8::1')).toBe('2001:db8::/64');
  });

  it('maps an IPv4-mapped IPv6 address back to its IPv4 address', () => {
    expect(ipBucket('::ffff:203.0.113.9')).toBe('203.0.113.9');
  });

  it('ignores a zone index', () => {
    expect(ipBucket('fe80::1%eth0')).toBe('fe80::/64');
  });

  it('groups by the /64 wherever the zero run falls', () => {
    expect(ipBucket('2001:db8:1::5')).toBe(ipBucket('2001:DB8:1:0:5::'));
    expect(ipBucket('2001:db8:1::5')).not.toBe(ipBucket('2001:db8:2::5'));
  });

  it('passes through anything it cannot parse, so it is still a key', () => {
    expect(ipBucket('unknown')).toBe('unknown');
    expect(ipBucket('2001:db8::zz')).toBe('2001:db8::zz');
    expect(ipBucket('')).toBe('');
  });
});

describe('POST /drip spends the per-IP budget against the /64 (F11, #20)', () => {
  it('hands the faucet the same key for two addresses from one /64', async () => {
    const seen: string[] = [];
    const recorder = {
      drip: async (_address: unknown, ip: string) => {
        seen.push(ip);
        return { ok: false, code: 'RATE_LIMITED', error: 'recorded' } as const;
      },
    } as unknown as FaucetService;

    const server = createFaucetServer({ faucet: recorder, trustProxy: true });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      for (const ip of ['2001:db8:1:2::1', '2001:db8:1:2::2']) {
        await fetch(`http://127.0.0.1:${port}/drip`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
          body: JSON.stringify({ address: 'any' }),
        });
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(seen).toEqual(['2001:db8:1:2::/64', '2001:db8:1:2::/64']);
  });
});
