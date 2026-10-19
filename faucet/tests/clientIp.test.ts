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
 * audit's testing. TESTNETAUDIT.md §6 I-6, issue #123.
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
import { clientIp } from '../src/server.ts';

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
