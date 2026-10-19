/**
 * faucet/tests/rootIndex.test.ts — `GET /` is a URL handed to humans, so it
 * must answer.
 *
 * WHY THIS TEST EXISTS
 *
 * `https://faucet.scalarnet.io` is pasted into chats and issue comments. On
 * launch day it greeted every one of those readers with
 * `404 {"ok":false,"code":"NOT_FOUND","error":"no route for GET /"}` — the
 * server only knew `/drip`, `/health` and `/balance/*`. PUBLIC-LAUNCH.md §5
 * finding F-2, issue #156.
 *
 * Both halves are pinned here: the **200**, because a 404 is what monitors and
 * humans read as "this host is broken", and the **pointer to `/health`**,
 * because a 200 that says nothing useful is no better an answer.
 *
 * Drives the real server over loopback against a FaucetService stand-in that
 * throws on touch. No chain, no signing key: the root index must keep answering
 * while the node is unreachable, which is precisely when someone pastes the URL
 * to ask whether the faucet is up.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createFaucetServer } from '../src/server.ts';
import type { FaucetService } from '../src/faucet.ts';

/** Fails on any property access — the root index may read nothing. */
const chainless = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`the root index must not use the faucet service; it reached for "${String(property)}"`);
    },
  },
) as unknown as FaucetService;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createFaucetServer({ faucet: chainless });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('GET /', () => {
  it('answers 200, not 404', async () => {
    expect((await fetch(`${baseUrl}/`)).status).toBe(200);
  });

  it('names /health as the entry point, on one line', async () => {
    const text = await (await fetch(`${baseUrl}/`)).text();
    // Read by curl in a terminal at least as often as by a client.
    expect(text).not.toContain('\n');
    expect(text).toContain('/health');
    expect(JSON.parse(text).health).toBe('/health');
  });

  it('points at the two routes a caller actually wants next', async () => {
    const body = (await (await fetch(`${baseUrl}/`)).json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.drip).toBe('POST /drip');
    expect(body.balance).toBe('/balance/:address');
  });

  it('still 404s a path no route claims', async () => {
    // The fix is a route, not a catch-all: `/favicon.ico` must stay a 404.
    const response = await fetch(`${baseUrl}/not-a-real-route`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code?: string }).code).toBe('NOT_FOUND');
  });
});
