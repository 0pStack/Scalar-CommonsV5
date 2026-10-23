/**
 * faucet/tests/faucet.test.ts — the drip decision against a fake chain.
 *
 * F11 (#20): the per-address and per-IP budgets bound one requester; the total
 * budget bounds the faucet. When the total is spent the faucet pauses — with a
 * refusal callers can tell apart from "you already had one" — and says so once
 * in the journal, the operator's only alert channel today.
 *
 * No node, no signing key: the chain is a stand-in whose balance and transfers
 * the tests control. The limiter is the real one with an injected clock.
 */

import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { encodeAddress } from '@polkadot/util-crypto';

import type { ChainClient, ChainInfo, TransferReceipt } from '../src/chain.js';
import { FaucetService, type FaucetStatus } from '../src/faucet.js';
import { MemoryStore, SlidingWindowRateLimiter } from '../src/rateLimiter.js';
import { createFaucetServer } from '../src/server.js';
import { CMN_DECIMALS, PLANCKS_PER_CMN, SS58_PREFIX } from '@scalar-commons/sdk';

const CMN = PLANCKS_PER_CMN;
const DRIP = 1_500n * CMN;
const RESERVE = 1_000n * CMN;
const ED = CMN / 100n;
const HOUR = 60 * 60_000;

// Well-known dev addresses: valid SS58 for prefix 42, nothing more.
const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const BOB = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const CHARLIE = '5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y';

const INFO: ChainInfo = {
  chain: 'Fake Testnet',
  specName: 'scalar-commons',
  specVersion: 309,
  tokenSymbol: 'CMN',
  tokenDecimals: CMN_DECIMALS,
  ss58Format: SS58_PREFIX,
};

/** A chain whose faucet balance is whatever the test says, minus what it paid out. */
function fakeChain(initialFree: bigint) {
  let free = initialFree;
  const transfers: string[] = [];
  const chain: ChainClient = {
    faucetAddress: '5CiPPseXPECbkjWCa6MnjNokrgYjMqmKndv2rSnekmSK2DjL',
    chainInfo: () => INFO,
    existentialDeposit: () => ED,
    freeBalance: async () => free,
    transfer: async (dest: string, amount: bigint): Promise<TransferReceipt> => {
      transfers.push(dest);
      free -= amount;
      return { blockHash: '0xb1', txHash: `0xt${transfers.length}` };
    },
    disconnect: async () => undefined,
  };
  return {
    chain,
    transfers,
    topUp: (amount: bigint) => {
      free += amount;
    },
  };
}

function setup(opts: { hourly?: number; daily?: number; free?: bigint; store?: MemoryStore } = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const warnings: string[] = [];
  const errors: string[] = [];
  const fake = fakeChain(opts.free ?? 1_000_000n * CMN);
  const limiter = new SlidingWindowRateLimiter({
    perAddress: { maxRequests: 1, windowMs: HOUR },
    perIp: { maxRequests: 5, windowMs: HOUR },
    global: [
      { maxRequests: opts.hourly ?? 20, windowMs: HOUR },
      { maxRequests: opts.daily ?? 50, windowMs: 24 * HOUR },
    ],
    store: opts.store ?? new MemoryStore(),
    now: clock.now,
  });
  const logger = {
    warn: (message: string) => warnings.push(message),
    error: (message: string) => errors.push(message),
  };
  const faucet = new FaucetService({
    chain: fake.chain,
    limiter,
    dripAmountPlancks: DRIP,
    reservePlancks: RESERVE,
    logger,
  });
  return { faucet, limiter, clock, warnings, errors, logger, ...fake };
}

describe('FaucetService — total budget (F11, #20)', () => {
  it('pauses with FAUCET_PAUSED once the hourly budget is spent', async () => {
    const { faucet } = setup({ hourly: 2 });
    expect((await faucet.drip(ALICE, '10.0.0.1')).ok).toBe(true);
    expect((await faucet.drip(BOB, '10.0.0.2')).ok).toBe(true);

    const paused = await faucet.drip(CHARLIE, '10.0.0.3');
    expect(paused).toMatchObject({
      ok: false,
      code: 'FAUCET_PAUSED',
      scope: 'global',
      retryAfterMs: HOUR,
    });
  });

  it('alerts once, on the drip that spends the budget, not on every refusal after it', async () => {
    const { faucet, warnings } = setup({ hourly: 1 });
    await faucet.drip(ALICE, '10.0.0.1');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/ALERT/);

    await faucet.drip(BOB, '10.0.0.2');
    await faucet.drip(CHARLIE, '10.0.0.3');
    expect(warnings).toHaveLength(1);
  });

  it('alerts again for the next pause, after the budget has had room', async () => {
    const { faucet, clock, warnings } = setup({ hourly: 1 });
    await faucet.drip(ALICE, '10.0.0.1');
    clock.advance(HOUR);
    await faucet.drip(BOB, '10.0.0.2');
    expect(warnings).toHaveLength(2);
  });

  it('alerts when a restart comes back to a budget that is already spent', async () => {
    // The first drip after a restart can be refused before any grant fills the cap.
    const { faucet, limiter, warnings, logger } = setup({ hourly: 1 });
    await faucet.drip(ALICE, '10.0.0.1');
    warnings.length = 0;

    const restarted = new FaucetService({
      chain: fakeChain(1_000_000n * CMN).chain,
      limiter,
      dripAmountPlancks: DRIP,
      reservePlancks: RESERVE,
      logger,
    });
    expect((await restarted.drip(BOB, '10.0.0.2')).ok).toBe(false);
    expect(warnings).toHaveLength(1);
  });

  it('reports the budget and whether it is paused', async () => {
    const { faucet } = setup({ hourly: 1, daily: 3 });
    expect((await faucet.status()).paused).toBe(false);

    await faucet.drip(ALICE, '10.0.0.1');
    const status = await faucet.status();
    expect(status.paused).toBe(true);
    expect(status.budget).toEqual([
      { maxRequests: 1, windowMs: HOUR, used: 1 },
      { maxRequests: 3, windowMs: 24 * HOUR, used: 1 },
    ]);
  });
});

describe('FaucetService — refunds through the reservation', () => {
  it('hands the slot back when the faucet cannot afford the drip', async () => {
    const { faucet, topUp, transfers } = setup({ free: RESERVE + ED + DRIP - 1n });
    expect(await faucet.drip(ALICE, '10.0.0.1')).toMatchObject({
      ok: false,
      code: 'INSUFFICIENT_FAUCET_FUNDS',
    });
    expect(transfers).toHaveLength(0);

    topUp(1n);
    expect((await faucet.drip(ALICE, '10.0.0.1')).ok).toBe(true);
  });

  it('does not alert for a grant that is refunded, and gives the global slot back', async () => {
    const { faucet, topUp, warnings } = setup({ hourly: 1, free: RESERVE + ED + DRIP - 1n });
    await faucet.drip(ALICE, '10.0.0.1');
    expect(warnings).toHaveLength(0);

    topUp(1n);
    expect((await faucet.drip(BOB, '10.0.0.2')).ok).toBe(true);
    expect(warnings).toHaveLength(1);
  });
});

describe('FaucetService — only 32-byte account addresses (#72)', () => {
  // decodeAddress also accepts hex and 1/2/4/8/33-byte payloads. Those reach the
  // chain as account indices (a fee burnt for nothing) or throw while the
  // transfer is built — either way a reserve-and-refund cycle anyone can repeat.
  const shapes = {
    hex: '0x' + 'ab'.repeat(32),
    oneByte: encodeAddress(new Uint8Array([1]), 42),
    thirtyThree: encodeAddress(new Uint8Array(33).fill(7), 42),
  };

  for (const [name, address] of Object.entries(shapes)) {
    it(`refuses a ${name} address before reserving anything`, async () => {
      const { faucet, transfers } = setup({ hourly: 1 });
      expect(await faucet.drip(address, '10.0.0.1')).toMatchObject({
        ok: false,
        code: 'INVALID_ADDRESS',
      });
      expect(transfers).toHaveLength(0);
      // Nothing was reserved, so the one-drip hourly budget is still whole.
      expect((await faucet.drip(ALICE, '10.0.0.1')).ok).toBe(true);
    });
  }
});

describe('FaucetService — a rate-limit store that cannot be written', () => {
  it('refuses with a generic 503 code and logs the cause, instead of a raw 500', async () => {
    const store = new MemoryStore();
    const { faucet, errors, transfers } = setup({ store });
    store.save = () => {
      throw new Error("ENOSPC: no space left on device, open '/home/dev/.local/state/x.tmp'");
    };

    const result = await faucet.drip(ALICE, '10.0.0.1');
    expect(result).toMatchObject({ ok: false, code: 'LIMITS_UNAVAILABLE' });
    expect(JSON.stringify(result)).not.toMatch(/home\/dev|ENOSPC/);
    expect(errors.join('\n')).toMatch(/ENOSPC/);
    expect(transfers).toHaveLength(0);
  });
});

/** The HTTP mapping, against a service stand-in whose answers the test fixes. */
async function request(service: Partial<FaucetService>, path: string, init?: RequestInit) {
  const server = createFaucetServer({ faucet: service as FaucetService });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
    return {
      status: res.status,
      retryAfter: res.headers.get('retry-after'),
      body: (await res.json()) as Record<string, unknown>,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('HTTP — a paused faucet (F11, #20)', () => {
  it('answers 503 with Retry-After, not the 429 of a per-requester limit', async () => {
    const res = await request(
      {
        drip: async () => ({
          ok: false,
          code: 'FAUCET_PAUSED',
          error: 'paused',
          scope: 'global',
          retryAfterMs: 90_000,
        }),
      },
      '/drip',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: ALICE }),
      },
    );
    expect(res.status).toBe(503);
    expect(res.retryAfter).toBe('90');
    expect(res.body).toMatchObject({ ok: false, code: 'FAUCET_PAUSED' });
  });

  it('shows the budget on /health', async () => {
    const status: FaucetStatus = {
      ...INFO,
      faucetAddress: ALICE,
      faucetFreePlancks: 5n * CMN,
      dripAmountPlancks: DRIP,
      reservePlancks: RESERVE,
      paused: true,
      budget: [{ maxRequests: 20, windowMs: HOUR, used: 20 }],
    };
    const res = await request({ status: async () => status }, '/health');
    expect(res.body).toMatchObject({
      paused: true,
      budget: [{ maxRequests: 20, windowMs: HOUR, used: 20 }],
    });
  });
});
