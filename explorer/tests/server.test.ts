import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import type { ActivitySource } from '../src/activity.js';
import type { ExplorerChain } from '../src/chain.js';
import { createExplorerServer } from '../src/server.js';
import type { ChainInfo } from '../src/types.js';
import { CMN_DECIMALS, SS58_PREFIX } from '@scalar-commons/sdk';

/**
 * The HTTP surface, against a stand-in chain.
 *
 * Requests go out through `node:http` rather than `fetch`, because `fetch`
 * normalises the path and would never send the malformed ones under test.
 */

const CHAIN: ChainInfo = {
  chain: 'Scalar Commons Local Testnet',
  specName: 'scalar-commons',
  specVersion: 304,
  tokenSymbol: 'CMN',
  tokenDecimals: CMN_DECIMALS,
  ss58Format: SS58_PREFIX,
  genesisHash: `0x${'ff'.repeat(32)}`,
};

/** Every chain call is counted, so a test can prove a request never reached the node. */
let chainCalls = 0;

const chain = {
  chainInfo: () => CHAIN,
  home: async () => {
    chainCalls += 1;
    return { chain: CHAIN, head: { number: 42, hash: `0x${'aa'.repeat(32)}` } };
  },
  block: async () => {
    chainCalls += 1;
    throw new Error('WebSocket is not connected');
  },
} as unknown as ExplorerChain;

const activity: ActivitySource = {
  activity: async () => {
    throw new Error('the activity page is not under test here');
  },
};

interface Answer {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

let server: Server;
let port: number;

function send(method: string, path: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, method, path }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () =>
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
      );
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

beforeAll(async () => {
  server = createExplorerServer({ chain, activity, onError: () => {} });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('status codes', () => {
  it('answers a URL that does not parse with 400, not with a node failure', async () => {
    const answer = await send('GET', '//[');
    expect(answer.status).toBe(400);
    expect(answer.body).not.toContain('the node did not answer');
  });

  it('answers a node failure with 502', async () => {
    const answer = await send('GET', '/block/1');
    expect(answer.status).toBe(502);
    expect(answer.body).toContain('the node did not answer');
  });
});

describe('content security policy', () => {
  // Every value on these pages came off a public chain. Escaping is the first
  // line; the policy is what keeps one escaping slip from becoming script.
  const POLICY =
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

  it.each([
    ['a page', '/', 200],
    ['a bad request', '/block/nope', 400],
    ['a missing page', '/nope', 404],
    ['a node failure', '/block/1', 502],
  ])('is sent with %s', async (_label, path, status) => {
    const answer = await send('GET', path);
    expect(answer.status).toBe(status);
    expect(answer.headers['content-security-policy']).toBe(POLICY);
  });
});

describe('methods', () => {
  it('serves HEAD with the headers and no body', async () => {
    const answer = await send('HEAD', '/');
    expect(answer.status).toBe(200);
    expect(answer.body).toBe('');
  });

  it.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])(
    'refuses %s with 405 before asking the node',
    async (method) => {
      const before = chainCalls;
      const answer = await send(method, '/');
      expect(answer.status).toBe(405);
      expect(answer.headers.allow).toBe('GET, HEAD');
      expect(answer.headers['content-security-policy']).toBeDefined();
      expect(chainCalls).toBe(before);
    },
  );
});
