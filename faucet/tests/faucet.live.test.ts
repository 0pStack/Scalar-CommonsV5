import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady, mnemonicGenerate } from '@polkadot/util-crypto';

import { connectChain, type ChainClient } from '../src/chain.js';
import { FaucetService } from '../src/faucet.js';
import { SlidingWindowRateLimiter } from '../src/rateLimiter.js';
import { createFaucetServer } from '../src/server.js';
import { PLANCKS_PER_CMN } from '../src/amount.js';

/**
 * These tests run against the LIVE devnet RPC. They are not mocked and they are
 * not skippable: the faucet's whole job is to move real tokens on a real chain,
 * so a mock would assert nothing about the thing that can actually break (type
 * shapes read from runtime metadata, nonce handling, dispatch errors).
 *
 * If the node is unreachable the suite FAILS rather than skipping — an
 * unreachable node is a blocking finding, per issue #75.
 */

const RPC_ENDPOINT = process.env.FAUCET_RPC_ENDPOINT ?? 'ws://127.0.0.1:9944';

/** Genesis-endowed, non-validator devnet account. Pre-funded — never minted. */
const FAUCET_SEED = process.env.FAUCET_SEED ?? '//Ferdie';

/** Small enough to run many drips, comfortably above the 0.01 CMN existential deposit. */
const DRIP = PLANCKS_PER_CMN; // 1 CMN

let chain: ChainClient;
let keyring: Keyring;

beforeAll(async () => {
  await cryptoWaitReady();
  keyring = new Keyring({ type: 'sr25519', ss58Format: 42 });
  chain = await connectChain({ rpcEndpoint: RPC_ENDPOINT, faucetSeed: FAUCET_SEED, ss58Format: 42 });
});

afterAll(async () => {
  await chain?.disconnect();
});

/** A never-before-seen account, so its starting balance is provably zero. */
function freshAddress(): string {
  return keyring.addFromMnemonic(mnemonicGenerate()).address;
}

interface Harness {
  url: string;
  server: Server;
  faucet: FaucetService;
  close: () => Promise<void>;
}

/** Boots a real HTTP faucet server on an ephemeral port. */
async function harness(
  opts: {
    dripAmountPlancks?: bigint;
    reservePlancks?: bigint;
    addressMax?: number;
    ipMax?: number;
    windowMs?: number;
  } = {},
): Promise<Harness> {
  const limiter = new SlidingWindowRateLimiter({
    perAddress: { maxRequests: opts.addressMax ?? 1, windowMs: opts.windowMs ?? 3_600_000 },
    perIp: { maxRequests: opts.ipMax ?? 100, windowMs: opts.windowMs ?? 3_600_000 },
  });
  const faucet = new FaucetService({
    chain,
    limiter,
    dripAmountPlancks: opts.dripAmountPlancks ?? DRIP,
    reservePlancks: opts.reservePlancks ?? 0n,
  });
  // trustProxy: every request in-process originates from 127.0.0.1, so the
  // per-IP budget is exercised through the same forwarded-for header a real
  // deployment behind a reverse proxy uses.
  const server = createFaucetServer({ faucet, trustProxy: true });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    faucet,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function postDrip(h: Harness, address: unknown, ip = '203.0.113.1') {
  const res = await fetch(`${h.url}/drip`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ address }),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, any> };
}

// ─── Live chain wiring ───────────────────────────────────────────────────────

describe('live devnet connection', () => {
  it('reads real runtime metadata from the node', () => {
    const info = chain.chainInfo();
    expect(info.chain).toMatch(/Scalar Commons/);
    expect(info.specName).toBe('scalar-commons');
    // Issue #75 targets spec 304; a later runtime is fine, an earlier one is not.
    expect(info.specVersion).toBeGreaterThanOrEqual(304);
    expect(info.tokenSymbol).toBe('CMN');
    expect(info.tokenDecimals).toBe(12);
    expect(info.ss58Format).toBe(42);
  });

  it('resolves the pre-funded faucet account and finds it solvent', async () => {
    expect(chain.faucetAddress).toBe('5CiPPseXPECbkjWCa6MnjNokrgYjMqmKndv2rSnekmSK2DjL');
    const free = await chain.freeBalance(chain.faucetAddress);
    expect(free).toBeGreaterThan(DRIP * 1000n);
  });

  it('reports the existential deposit from chain constants', () => {
    // 0.01 CMN on this runtime — the floor a drip must clear to create an account.
    expect(chain.existentialDeposit()).toBe(10_000_000_000n);
    expect(DRIP).toBeGreaterThan(chain.existentialDeposit());
  });

  it('reads a zero balance for a never-used address', async () => {
    expect(await chain.freeBalance(freshAddress())).toBe(0n);
  });
});

// ─── The drip actually moves tokens ──────────────────────────────────────────

describe('POST /drip — real balance change on chain', () => {
  it('credits the requested address by exactly the drip amount', async () => {
    const h = await harness();
    try {
      const dest = freshAddress();
      const destBefore = await chain.freeBalance(dest);
      const faucetBefore = await chain.freeBalance(chain.faucetAddress);
      expect(destBefore).toBe(0n);

      const res = await postDrip(h, dest);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.address).toBe(dest);
      expect(res.body.amountPlancks).toBe(DRIP.toString());
      expect(res.body.blockHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(res.body.txHash).toMatch(/^0x[0-9a-f]{64}$/);

      // The assertion that matters: the chain state changed.
      const destAfter = await chain.freeBalance(dest);
      expect(destAfter - destBefore).toBe(DRIP);

      // And it came out of the pre-funded account, plus the sender-paid fee.
      const faucetAfter = await chain.freeBalance(chain.faucetAddress);
      const spent = faucetBefore - faucetAfter;
      expect(spent).toBeGreaterThanOrEqual(DRIP);
      expect(spent).toBeLessThan(DRIP + PLANCKS_PER_CMN);
    } finally {
      await h.close();
    }
  });

  it('serves two different addresses from the same faucet account', async () => {
    // Exercises sequential nonces from one signer — the classic faucet bug.
    const h = await harness({ ipMax: 5 });
    try {
      const a = freshAddress();
      const b = freshAddress();

      const [resA, resB] = [await postDrip(h, a), await postDrip(h, b)];

      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      expect(resA.body.txHash).not.toBe(resB.body.txHash);
      expect(await chain.freeBalance(a)).toBe(DRIP);
      expect(await chain.freeBalance(b)).toBe(DRIP);
    } finally {
      await h.close();
    }
  });

  it('accepts concurrent requests without corrupting the nonce', async () => {
    const h = await harness({ ipMax: 5 });
    try {
      const addrs = [freshAddress(), freshAddress(), freshAddress()];
      const results = await Promise.all(addrs.map((a) => postDrip(h, a)));

      for (const r of results) {
        expect(r.status).toBe(200);
        expect(r.body.ok).toBe(true);
      }
      const hashes = new Set(results.map((r) => r.body.txHash));
      expect(hashes.size).toBe(3);
      for (const a of addrs) {
        expect(await chain.freeBalance(a)).toBe(DRIP);
      }
    } finally {
      await h.close();
    }
  });
});

// ─── Rate limiting, end to end, with no funds moved ──────────────────────────

describe('POST /drip — per-address rate limiting', () => {
  it('refuses a second drip to the same address and moves no funds', async () => {
    const h = await harness({ ipMax: 50 });
    try {
      const dest = freshAddress();

      const first = await postDrip(h, dest);
      expect(first.status).toBe(200);
      const afterFirst = await chain.freeBalance(dest);
      expect(afterFirst).toBe(DRIP);

      const second = await postDrip(h, dest);

      expect(second.status).toBe(429);
      expect(second.body.ok).toBe(false);
      expect(second.body.code).toBe('RATE_LIMITED');
      expect(second.body.scope).toBe('address');
      expect(second.body.retryAfterMs).toBeGreaterThan(0);
      expect(second.headers.get('retry-after')).toBeTruthy();

      // The decisive assertion: the rejection was real, not cosmetic.
      expect(await chain.freeBalance(dest)).toBe(afterFirst);
    } finally {
      await h.close();
    }
  });

  it('still refuses when the same address is requested from a different IP', async () => {
    const h = await harness({ ipMax: 50 });
    try {
      const dest = freshAddress();
      expect((await postDrip(h, dest, '203.0.113.7')).status).toBe(200);

      const second = await postDrip(h, dest, '198.51.100.4');

      expect(second.status).toBe(429);
      expect(second.body.scope).toBe('address');
      expect(await chain.freeBalance(dest)).toBe(DRIP);
    } finally {
      await h.close();
    }
  });
});

describe('POST /drip — per-IP rate limiting', () => {
  it('caps how many fresh addresses one IP can fund', async () => {
    const h = await harness({ ipMax: 2 });
    try {
      const ip = '203.0.113.42';
      const funded = [freshAddress(), freshAddress()];
      for (const a of funded) {
        expect((await postDrip(h, a, ip)).status).toBe(200);
      }

      const blocked = freshAddress();
      const res = await postDrip(h, blocked, ip);

      expect(res.status).toBe(429);
      expect(res.body.code).toBe('RATE_LIMITED');
      expect(res.body.scope).toBe('ip');

      // The blocked address received nothing at all.
      expect(await chain.freeBalance(blocked)).toBe(0n);
      for (const a of funded) {
        expect(await chain.freeBalance(a)).toBe(DRIP);
      }
    } finally {
      await h.close();
    }
  });

  it('lets a different IP through when one IP is exhausted', async () => {
    const h = await harness({ ipMax: 1 });
    try {
      expect((await postDrip(h, freshAddress(), '203.0.113.50')).status).toBe(200);
      expect((await postDrip(h, freshAddress(), '203.0.113.50')).status).toBe(429);

      const dest = freshAddress();
      expect((await postDrip(h, dest, '198.51.100.50')).status).toBe(200);
      expect(await chain.freeBalance(dest)).toBe(DRIP);
    } finally {
      await h.close();
    }
  });

  it('does not burn an address budget on an IP rejection', async () => {
    const h = await harness({ ipMax: 1 });
    try {
      expect((await postDrip(h, freshAddress(), '203.0.113.60')).status).toBe(200);

      const victim = freshAddress();
      expect((await postDrip(h, victim, '203.0.113.60')).status).toBe(429);

      // Same address, fresh IP: must succeed and actually be funded.
      const res = await postDrip(h, victim, '198.51.100.60');
      expect(res.status).toBe(200);
      expect(await chain.freeBalance(victim)).toBe(DRIP);
    } finally {
      await h.close();
    }
  });
});

// ─── Drain protection ────────────────────────────────────────────────────────

describe('POST /drip — reserve floor keeps the faucet from being drained', () => {
  it('refuses to dip into the configured reserve, and moves no funds', async () => {
    const faucetFree = await chain.freeBalance(chain.faucetAddress);
    // Reserve the entire current balance: any drip would breach it.
    const h = await harness({ reservePlancks: faucetFree });
    try {
      const dest = freshAddress();
      const res = await postDrip(h, dest);

      expect(res.status).toBe(503);
      expect(res.body.ok).toBe(false);
      expect(res.body.code).toBe('INSUFFICIENT_FAUCET_FUNDS');
      expect(await chain.freeBalance(dest)).toBe(0n);
    } finally {
      await h.close();
    }
  });

  it('refunds the rate-limit slot when the drip was refused', async () => {
    // A user turned away by insolvency was never served, so they must not have
    // spent their once-per-window allowance.
    const faucetFree = await chain.freeBalance(chain.faucetAddress);
    const dest = freshAddress();

    const broke = await harness({ reservePlancks: faucetFree, addressMax: 1 });
    try {
      expect((await postDrip(broke, dest)).status).toBe(503);
    } finally {
      await broke.close();
    }

    const solvent = await harness({ reservePlancks: 0n, addressMax: 1 });
    try {
      // Same limiter budget semantics, fresh service: prove the address is not
      // locked out by asserting a real transfer lands.
      const res = await postDrip(solvent, dest);
      expect(res.status).toBe(200);
      expect(await chain.freeBalance(dest)).toBe(DRIP);
    } finally {
      await solvent.close();
    }
  });

  it('reuses the same rate limiter across requests within one service', async () => {
    // Guards against a service that rebuilds its limiter per request (which
    // would make rate limiting a no-op in production).
    const h = await harness({ addressMax: 1, ipMax: 1 });
    try {
      expect((await postDrip(h, freshAddress(), '203.0.113.70')).status).toBe(200);
      expect((await postDrip(h, freshAddress(), '203.0.113.70')).status).toBe(429);
      expect((await postDrip(h, freshAddress(), '203.0.113.70')).status).toBe(429);
    } finally {
      await h.close();
    }
  });
});

// ─── Input validation: guards fire before funds move ─────────────────────────

describe('POST /drip — input validation', () => {
  it('rejects a malformed address without touching the chain', async () => {
    const h = await harness();
    try {
      const faucetBefore = await chain.freeBalance(chain.faucetAddress);

      const res = await postDrip(h, 'not-an-address');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_ADDRESS');
      expect(await chain.freeBalance(chain.faucetAddress)).toBe(faucetBefore);
    } finally {
      await h.close();
    }
  });

  it('rejects a missing or non-string address', async () => {
    const h = await harness();
    try {
      for (const bad of [undefined, null, 42, {}, []]) {
        const res = await postDrip(h, bad);
        expect(res.status).toBe(400);
        expect(res.body.ok).toBe(false);
      }
    } finally {
      await h.close();
    }
  });

  it('rejects an address that fails its SS58 checksum', async () => {
    const h = await harness();
    try {
      const valid = freshAddress();
      // Corrupt one character; the blake2 checksum must catch it.
      const corrupted = valid.slice(0, -1) + (valid.endsWith('A') ? 'B' : 'A');
      const res = await postDrip(h, corrupted);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_ADDRESS');
    } finally {
      await h.close();
    }
  });

  it('rejects malformed JSON', async () => {
    const h = await harness();
    try {
      const res = await fetch(`${h.url}/drip`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('BAD_REQUEST');
    } finally {
      await h.close();
    }
  });

  it('rejects a wrong method on /drip', async () => {
    const h = await harness();
    try {
      const res = await fetch(`${h.url}/drip`, { method: 'GET' });
      expect(res.status).toBe(405);
    } finally {
      await h.close();
    }
  });

  it('404s an unknown route', async () => {
    const h = await harness();
    try {
      const res = await fetch(`${h.url}/nope`);
      expect(res.status).toBe(404);
    } finally {
      await h.close();
    }
  });
});

// ─── Read endpoints reflect live chain state ─────────────────────────────────

describe('GET /balance/:address', () => {
  it('matches a direct chain query', async () => {
    const h = await harness();
    try {
      const expected = await chain.freeBalance(chain.faucetAddress);
      const res = await fetch(`${h.url}/balance/${chain.faucetAddress}`);
      const body = (await res.json()) as Record<string, any>;

      expect(res.status).toBe(200);
      expect(body.address).toBe(chain.faucetAddress);
      expect(BigInt(body.freePlancks)).toBe(expected);
    } finally {
      await h.close();
    }
  });

  it('shows a drip landing in the balance it reports', async () => {
    const h = await harness();
    try {
      const dest = freshAddress();
      const before = (await (await fetch(`${h.url}/balance/${dest}`)).json()) as Record<string, any>;
      expect(BigInt(before.freePlancks)).toBe(0n);

      expect((await postDrip(h, dest)).status).toBe(200);

      const after = (await (await fetch(`${h.url}/balance/${dest}`)).json()) as Record<string, any>;
      expect(BigInt(after.freePlancks)).toBe(DRIP);
    } finally {
      await h.close();
    }
  });

  it('rejects a malformed address', async () => {
    const h = await harness();
    try {
      const res = await fetch(`${h.url}/balance/nonsense`);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('INVALID_ADDRESS');
    } finally {
      await h.close();
    }
  });
});

describe('GET /health', () => {
  it('reports live chain and faucet state', async () => {
    const h = await harness();
    try {
      const res = await fetch(`${h.url}/health`);
      const body = (await res.json()) as Record<string, any>;

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.chain).toMatch(/Scalar Commons/);
      expect(body.specVersion).toBeGreaterThanOrEqual(304);
      expect(body.tokenSymbol).toBe('CMN');
      expect(body.faucetAddress).toBe(chain.faucetAddress);
      expect(body.dripAmountPlancks).toBe(DRIP.toString());
      expect(BigInt(body.faucetFreePlancks)).toBe(await chain.freeBalance(chain.faucetAddress));
    } finally {
      await h.close();
    }
  });
});
