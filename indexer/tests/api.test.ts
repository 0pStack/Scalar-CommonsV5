import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApiServer, matchRoute, settledEraFromEvent, ROUTES, type ApiDependencies } from '../src/api.ts';

/**
 * Routing and era-event shaping, tested without a chain.
 *
 * Both are reachable by an anonymous request, and both have a failure mode that
 * is worse than an error: routing can be handed bytes the URL spec does not
 * define, and an `EraSettled` event whose fields cannot be found must never be
 * reported as an era that emitted nothing. A supply-capped chain publishing
 * "0 CMN emitted" reads as a fact, not as a decode miss.
 */

describe('matchRoute', () => {
  it('fills path parameters, decoding percent-escapes', () => {
    const matched = matchRoute('/v1/blocks/0x00ff');
    expect(matched?.route.name).toBe('blocks.get');
    expect(matched?.params.id).toBe('0x00ff');

    const escaped = matchRoute('/v1/accounts/a%20b');
    expect(escaped?.params.address).toBe('a b');
  });

  it('returns null for a path no route claims', () => {
    expect(matchRoute('/v1/not-a-real-endpoint')).toBeNull();
  });

  it('raises a 400 rather than a raw URIError on malformed percent-encoding', () => {
    // `decodeURIComponent('%')` throws URIError. Anonymous callers control this
    // byte, so it has to arrive as a client error and never as a fault.
    let caught: unknown;
    try {
      matchRoute('/v1/blocks/%');
    } catch (error) {
      caught = error;
    }
    expect(caught, 'a malformed escape must be rejected, not decoded').toBeDefined();
    expect((caught as { status?: number }).status).toBe(400);
    expect(caught).not.toBeInstanceOf(URIError);
  });

  it('rejects malformed escapes in every parameterised route', () => {
    for (const path of ['/v1/accounts/%', '/v1/agents/%E0%A4%A/events', '/v1/escrows/%/x/1']) {
      expect(() => matchRoute(path), path).toThrow();
      let status: number | undefined;
      try {
        matchRoute(path);
      } catch (error) {
        status = (error as { status?: number }).status;
      }
      expect(status, path).toBe(400);
    }
  });
});

describe('settledEraFromEvent', () => {
  const settled = { blockNumber: 4_242, data: { era: 7, total_emission: '10000000000000000000', total_weight: '900' } };

  it('reports the totals the pallet itself recorded', () => {
    expect(settledEraFromEvent(settled)).toEqual({
      era: 7,
      settled: true,
      totalEmissionPlancks: '10000000000000000000',
      totalWeight: '900',
      settledAtBlock: 4_242,
    });
  });

  // spec 306 adds emissions.EmissionCappedByVolume alongside EraSettled, and both can be
  // emitted from the same settle_era extrinsic. /v1/eras rebuilds settled eras by
  // selecting section+method, so the risk worth pinning is that a sibling event in the same
  // block leaks into that reconstruction — or that its differently-shaped payload reaches
  // settledEraFromEvent at all.
  it('is not confused by the spec-306 sibling events emitted from the same settle_era', () => {
    const capped = {
      blockNumber: 4_242,
      data: {
        era: 7,
        uncapped: '110000000000000000000',
        qualifying_volume: '60000000000000',
        alpha_bps: 10_000,
      },
    };
    // It carries no total_emission/total_weight, so if it ever reached this shaper it must
    // throw rather than report an era that emitted nothing.
    expect(() => settledEraFromEvent(capped)).toThrow();
    // And the real EraSettled from the same block still shapes correctly.
    expect(settledEraFromEvent(settled).era).toBe(7);
  });

  it('accepts the camelCase spelling metadata may hand back', () => {
    const camel = { blockNumber: 9, data: { era: 1, totalEmission: '5', totalWeight: '2' } };
    expect(settledEraFromEvent(camel).totalEmissionPlancks).toBe('5');
    expect(settledEraFromEvent(camel).totalWeight).toBe('2');
  });

  it('throws rather than reporting a settled era as having emitted zero', () => {
    // What an unnamed field looks like once ingested: `arg1`, not `total_emission`.
    const unnamed = { blockNumber: 9, data: { era: 3, arg1: '10', arg2: '4' } };
    expect(() => settledEraFromEvent(unnamed)).toThrow(/total_emission/);

    const allUnnamed = { blockNumber: 9, data: { arg0: 3, arg1: '10', arg2: '4' } };
    expect(() => settledEraFromEvent(allUnnamed)).toThrow(/EraSettled/);

    const partial = { blockNumber: 9, data: { era: 3, total_emission: '10' } };
    expect(() => settledEraFromEvent(partial)).toThrow(/total_weight/);

    const noEra = { blockNumber: 9, data: { total_emission: '10', total_weight: '4' } };
    expect(() => settledEraFromEvent(noEra)).toThrow(/era/);
  });
});

/**
 * The root index.
 *
 * `/` used to 404 with the endpoint list attached (`api.scalarnet.io/` →
 * `{"error":"no such endpoint: /","endpoints":[...]}`, PUBLIC-LAUNCH.md §5
 * F-2). The bytes were nearly right; the status code told every monitor and
 * every human that the host was broken. These cases pin both halves — the 200
 * and the pointer — and pin them against a dependency object that throws on
 * touch, because `/` has to answer while the node is unreachable.
 */
describe('GET /', () => {
  /**
   * Dependencies that fail on ANY property access.
   *
   * A pointer to the entry point is not chain state. If the root handler ever
   * reaches for `store`, `api`, `chain`, `indexer` or `config`, this throws and
   * the case fails — rather than passing here and 503-ing in production the
   * next time alice restarts.
   */
  const chainless = new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`the root index must read no dependencies; it reached for "${String(property)}"`);
      },
    },
  ) as ApiDependencies;

  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createApiServer(chainless);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('answers 200, not 404', async () => {
    // The status code comes first on purpose: the old 404 body already
    // contained "/v1/status" inside its endpoint list, so a body-only check is
    // a false green.
    expect((await fetch(`${baseUrl}/`)).status).toBe(200);
  });

  it('names /v1/status as the entry point', async () => {
    const response = await fetch(`${baseUrl}/`);
    const text = await response.text();
    // One line: this is read by curl in a terminal as often as by a client.
    expect(text).not.toContain('\n');
    expect(text).toContain('/v1/status');
    expect(JSON.parse(text).status).toBe('/v1/status');
  });

  it('carries the same endpoint list the 404 already offered', async () => {
    const body = (await (await fetch(`${baseUrl}/`)).json()) as { endpoints?: string[] };
    expect(body.endpoints).toEqual(ROUTES.map((route) => route.path));
  });

  it('does not enter the versioned surface to do it', () => {
    // `/` is unversioned by construction. Adding it to ROUTES would answer the
    // gate too, and would silently renumber the v1 contract: `/v1/status`
    // reports `api.endpoints = ROUTES.length`, and the live suite requires
    // exactly 25, all `/v1/`-prefixed.
    expect(matchRoute('/')).toBeNull();
    expect(ROUTES).toHaveLength(25);
  });
});
