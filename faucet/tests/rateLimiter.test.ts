import { describe, it, expect } from 'vitest';

import { SlidingWindowRateLimiter } from '../src/rateLimiter.js';

/**
 * Rate limiting is the faucet's only defence against being drained: the funds
 * come from a real pre-funded devnet account with a finite balance, so an
 * unlimited dispenser is an empty dispenser. These tests pin the two independent
 * budgets (per address, per IP) and — most importantly — that a rejection in one
 * scope does not silently consume budget in the other.
 *
 * The clock is injected so the window behaviour is asserted deterministically
 * rather than by sleeping.
 */

/** A controllable clock standing in for `Date.now`. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function limiter(
  opts: { addressMax?: number; addressWindowMs?: number; ipMax?: number; ipWindowMs?: number } = {},
) {
  const clock = fakeClock();
  const rl = new SlidingWindowRateLimiter({
    perAddress: { maxRequests: opts.addressMax ?? 1, windowMs: opts.addressWindowMs ?? 60_000 },
    perIp: { maxRequests: opts.ipMax ?? 3, windowMs: opts.ipWindowMs ?? 60_000 },
    now: clock.now,
  });
  return { rl, clock };
}

describe('SlidingWindowRateLimiter — per-address budget', () => {
  it('allows the first request for an address', () => {
    const { rl } = limiter();
    const d = rl.tryAcquire('addrA', '10.0.0.1');
    expect(d.allowed).toBe(true);
    expect(d.scope).toBeUndefined();
  });

  it('rejects a second request for the same address inside the window', () => {
    const { rl } = limiter({ addressWindowMs: 60_000 });
    expect(rl.tryAcquire('addrA', '10.0.0.1').allowed).toBe(true);

    const d = rl.tryAcquire('addrA', '10.0.0.1');
    expect(d.allowed).toBe(false);
    expect(d.scope).toBe('address');
    expect(d.retryAfterMs).toBe(60_000);
  });

  it('reports a shrinking retryAfterMs as the window elapses', () => {
    const { rl, clock } = limiter({ addressWindowMs: 60_000 });
    rl.tryAcquire('addrA', '10.0.0.1');

    clock.advance(20_000);
    const first = rl.tryAcquire('addrA', '10.0.0.1');
    clock.advance(30_000);
    const second = rl.tryAcquire('addrA', '10.0.0.1');

    expect(first.allowed).toBe(false);
    expect(second.allowed).toBe(false);
    expect(first.retryAfterMs).toBe(40_000);
    expect(second.retryAfterMs).toBe(10_000);
    expect(second.retryAfterMs!).toBeLessThan(first.retryAfterMs!);
  });

  it('allows the address again once its window has fully elapsed', () => {
    const { rl, clock } = limiter({ addressWindowMs: 60_000 });
    rl.tryAcquire('addrA', '10.0.0.1');
    expect(rl.tryAcquire('addrA', '10.0.0.1').allowed).toBe(false);

    clock.advance(60_000);
    expect(rl.tryAcquire('addrA', '10.0.0.1').allowed).toBe(true);
  });

  it('does not let one address consume another address budget', () => {
    const { rl } = limiter({ addressMax: 1, ipMax: 10 });
    expect(rl.tryAcquire('addrA', '10.0.0.1').allowed).toBe(true);
    expect(rl.tryAcquire('addrB', '10.0.0.2').allowed).toBe(true);
    expect(rl.tryAcquire('addrA', '10.0.0.1').allowed).toBe(false);
  });

  it('honours a per-address budget larger than one', () => {
    const { rl } = limiter({ addressMax: 3, ipMax: 100 });
    expect(rl.tryAcquire('addrA', '10.0.0.1').allowed).toBe(true);
    expect(rl.tryAcquire('addrA', '10.0.0.1').allowed).toBe(true);
    expect(rl.tryAcquire('addrA', '10.0.0.1').allowed).toBe(true);

    const d = rl.tryAcquire('addrA', '10.0.0.1');
    expect(d.allowed).toBe(false);
    expect(d.scope).toBe('address');
  });
});

describe('SlidingWindowRateLimiter — per-IP budget', () => {
  it('stops one IP farming many fresh addresses', () => {
    const { rl } = limiter({ addressMax: 1, ipMax: 3 });
    expect(rl.tryAcquire('addr1', '10.0.0.9').allowed).toBe(true);
    expect(rl.tryAcquire('addr2', '10.0.0.9').allowed).toBe(true);
    expect(rl.tryAcquire('addr3', '10.0.0.9').allowed).toBe(true);

    const d = rl.tryAcquire('addr4', '10.0.0.9');
    expect(d.allowed).toBe(false);
    expect(d.scope).toBe('ip');
    expect(d.retryAfterMs).toBe(60_000);
  });

  it('does not let one IP consume another IP budget', () => {
    const { rl } = limiter({ addressMax: 1, ipMax: 1 });
    expect(rl.tryAcquire('addr1', '10.0.0.1').allowed).toBe(true);
    expect(rl.tryAcquire('addr2', '10.0.0.1').allowed).toBe(false);
    expect(rl.tryAcquire('addr3', '10.0.0.2').allowed).toBe(true);
  });

  it('allows the IP again once its window has fully elapsed', () => {
    const { rl, clock } = limiter({ addressMax: 1, ipMax: 2, ipWindowMs: 30_000 });
    rl.tryAcquire('addr1', '10.0.0.9');
    rl.tryAcquire('addr2', '10.0.0.9');
    expect(rl.tryAcquire('addr3', '10.0.0.9').allowed).toBe(false);

    clock.advance(30_000);
    expect(rl.tryAcquire('addr3', '10.0.0.9').allowed).toBe(true);
  });

  it('slides rather than resetting in fixed buckets', () => {
    // Two requests at t and t+20s with a 30s window: at t+30s only the first has
    // aged out, so exactly one slot is free — a fixed-bucket limiter would
    // wrongly free both.
    const { rl, clock } = limiter({ addressMax: 5, ipMax: 2, ipWindowMs: 30_000 });
    rl.tryAcquire('addr1', '10.0.0.9');
    clock.advance(20_000);
    rl.tryAcquire('addr2', '10.0.0.9');

    clock.advance(10_000); // t+30s
    expect(rl.tryAcquire('addr3', '10.0.0.9').allowed).toBe(true);
    expect(rl.tryAcquire('addr4', '10.0.0.9').allowed).toBe(false);
  });
});

describe('SlidingWindowRateLimiter — scope isolation on rejection', () => {
  it('does not consume address budget when the IP budget rejects', () => {
    // addr4 is turned away because its IP is exhausted. That must not burn
    // addr4's own once-per-window allowance: otherwise an attacker could lock a
    // victim's address out of the faucet just by spending their own IP budget.
    const { rl, clock } = limiter({ addressMax: 1, ipMax: 2, ipWindowMs: 60_000 });
    rl.tryAcquire('addr1', '10.0.0.9');
    rl.tryAcquire('addr2', '10.0.0.9');

    const rejected = rl.tryAcquire('addr4', '10.0.0.9');
    expect(rejected.allowed).toBe(false);
    expect(rejected.scope).toBe('ip');

    // Same address, different (fresh) IP — must be allowed immediately.
    expect(rl.tryAcquire('addr4', '10.0.0.10').allowed).toBe(true);
    clock.advance(60_000);
    // ...and the earlier rejection left no residue on the IP bucket either.
    expect(rl.tryAcquire('addr5', '10.0.0.9').allowed).toBe(true);
  });

  it('does not consume IP budget when the address budget rejects', () => {
    const { rl } = limiter({ addressMax: 1, ipMax: 3 });
    rl.tryAcquire('addrA', '10.0.0.9');

    const rejected = rl.tryAcquire('addrA', '10.0.0.9');
    expect(rejected.allowed).toBe(false);
    expect(rejected.scope).toBe('address');

    // The IP spent exactly one slot (the successful one), so two remain.
    expect(rl.tryAcquire('addrB', '10.0.0.9').allowed).toBe(true);
    expect(rl.tryAcquire('addrC', '10.0.0.9').allowed).toBe(true);
    expect(rl.tryAcquire('addrD', '10.0.0.9').allowed).toBe(false);
  });
});

describe('SlidingWindowRateLimiter — release refunds a reserved slot', () => {
  it('restores both budgets when a reserved drip never happened', () => {
    // The service reserves the slot before submitting, so a transfer that is
    // refused (insolvency, node error) must hand the slot back — the user was
    // never served, so they must not be billed for it.
    const { rl } = limiter({ addressMax: 1, ipMax: 1 });
    expect(rl.tryAcquire('addrA', '10.0.0.1').allowed).toBe(true);
    expect(rl.tryAcquire('addrA', '10.0.0.1').allowed).toBe(false);

    rl.release('addrA', '10.0.0.1');

    expect(rl.tryAcquire('addrA', '10.0.0.1').allowed).toBe(true);
  });

  it('refunds only one slot per release', () => {
    const { rl } = limiter({ addressMax: 3, ipMax: 3 });
    rl.tryAcquire('addrA', '10.0.0.1');
    rl.tryAcquire('addrA', '10.0.0.1');
    rl.tryAcquire('addrA', '10.0.0.1');
    expect(rl.tryAcquire('addrA', '10.0.0.1').allowed).toBe(false);

    rl.release('addrA', '10.0.0.1');
    expect(rl.tryAcquire('addrA', '10.0.0.1').allowed).toBe(true);
    expect(rl.tryAcquire('addrA', '10.0.0.1').allowed).toBe(false);
  });

  it('is a no-op when there is nothing to refund', () => {
    const { rl } = limiter({ addressMax: 1, ipMax: 1 });
    rl.release('addrA', '10.0.0.1');
    expect(rl.tryAcquire('addrA', '10.0.0.1').allowed).toBe(true);
    expect(rl.tryAcquire('addrA', '10.0.0.1').allowed).toBe(false);
  });
});

describe('SlidingWindowRateLimiter — bounded memory', () => {
  it('drops buckets whose entries have all aged out', () => {
    // A public endpoint keyed by attacker-controlled strings is an unbounded map
    // unless expired keys are reclaimed.
    const { rl, clock } = limiter({ addressMax: 1, ipMax: 1000, addressWindowMs: 60_000 });
    for (let i = 0; i < 50; i += 1) {
      rl.tryAcquire(`addr${i}`, '10.0.0.1');
    }
    expect(rl.size()).toBeGreaterThanOrEqual(50);

    clock.advance(60_000);
    rl.prune();
    expect(rl.size()).toBe(0);
  });

  it('keeps buckets that are still inside their window', () => {
    const { rl, clock } = limiter({ addressMax: 1, ipMax: 1000, addressWindowMs: 60_000 });
    rl.tryAcquire('addrA', '10.0.0.1');

    clock.advance(30_000);
    rl.prune();

    expect(rl.size()).toBeGreaterThan(0);
    expect(rl.tryAcquire('addrA', '10.0.0.1').allowed).toBe(false);
  });
});

describe('SlidingWindowRateLimiter — configuration validation', () => {
  it('rejects a non-positive budget', () => {
    expect(
      () =>
        new SlidingWindowRateLimiter({
          perAddress: { maxRequests: 0, windowMs: 1000 },
          perIp: { maxRequests: 1, windowMs: 1000 },
        }),
    ).toThrow(/maxRequests/);
  });

  it('rejects a non-positive window', () => {
    expect(
      () =>
        new SlidingWindowRateLimiter({
          perAddress: { maxRequests: 1, windowMs: 1000 },
          perIp: { maxRequests: 1, windowMs: 0 },
        }),
    ).toThrow(/windowMs/);
  });
});
