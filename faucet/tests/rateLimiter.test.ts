import { afterAll, describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonFileStore, MemoryStore, SlidingWindowRateLimiter } from '../src/rateLimiter.js';

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
    const granted = rl.tryAcquire('addrA', '10.0.0.1');
    expect(granted.allowed).toBe(true);
    expect(rl.tryAcquire('addrA', '10.0.0.1').allowed).toBe(false);

    rl.release(granted.reservation!);

    expect(rl.tryAcquire('addrA', '10.0.0.1').allowed).toBe(true);
  });

  it('refunds only one slot per release', () => {
    const { rl } = limiter({ addressMax: 3, ipMax: 3 });
    rl.tryAcquire('addrA', '10.0.0.1');
    rl.tryAcquire('addrA', '10.0.0.1');
    const third = rl.tryAcquire('addrA', '10.0.0.1');
    expect(rl.tryAcquire('addrA', '10.0.0.1').allowed).toBe(false);

    rl.release(third.reservation!);
    expect(rl.tryAcquire('addrA', '10.0.0.1').allowed).toBe(true);
    expect(rl.tryAcquire('addrA', '10.0.0.1').allowed).toBe(false);
  });

  it('refunds once when the same reservation is released twice', () => {
    const { rl } = limiter({ addressMax: 2, ipMax: 2 });
    const first = rl.tryAcquire('addrA', '10.0.0.1');
    rl.tryAcquire('addrA', '10.0.0.1');

    rl.release(first.reservation!);
    rl.release(first.reservation!);

    expect(rl.tryAcquire('addrA', '10.0.0.1').allowed).toBe(true);
    expect(rl.tryAcquire('addrA', '10.0.0.1').allowed).toBe(false);
  });

  it('releases exactly the reserved grant, not the newest one', () => {
    // Popping the newest entry would hand back B's later timestamp and leave A's
    // earlier one, shortening B's window: the slot would free up 20 s early.
    const { rl, clock } = limiter({ addressMax: 5, ipMax: 2, ipWindowMs: 60_000 });
    const a = rl.tryAcquire('addrA', '10.0.0.9');
    clock.advance(20_000);
    rl.tryAcquire('addrB', '10.0.0.9');
    rl.release(a.reservation!);

    clock.advance(41_000); // t = 61 s: A's entry would have expired, B's (t = 20 s) has not
    expect(rl.tryAcquire('addrC', '10.0.0.9').allowed).toBe(true);
    expect(rl.tryAcquire('addrD', '10.0.0.9').allowed).toBe(false);
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

  it('rejects a non-positive global budget', () => {
    expect(
      () =>
        new SlidingWindowRateLimiter({
          perAddress: { maxRequests: 1, windowMs: 1000 },
          perIp: { maxRequests: 1, windowMs: 1000 },
          global: [{ maxRequests: 0, windowMs: 1000 }],
        }),
    ).toThrow(/global\[0\]\.maxRequests/);
  });
});

/**
 * F11 (#20): per-address and per-IP budgets alone cannot bound what the faucet
 * spends — enough distinct IPs drain it at 5 drips each. A total budget per hour
 * and per day caps the loss no matter how many requesters there are, and the
 * limits must survive a restart, or `systemctl restart` resets every budget.
 */
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

function globalLimiter(
  opts: { hourly?: number; daily?: number; store?: MemoryStore; clock?: ReturnType<typeof fakeClock> } = {},
) {
  const clock = opts.clock ?? fakeClock();
  const store = opts.store ?? new MemoryStore();
  const rl = new SlidingWindowRateLimiter({
    perAddress: { maxRequests: 1, windowMs: HOUR },
    perIp: { maxRequests: 5, windowMs: HOUR },
    global: [
      { maxRequests: opts.hourly ?? 2, windowMs: HOUR },
      { maxRequests: opts.daily ?? 3, windowMs: DAY },
    ],
    store,
    now: clock.now,
  });
  return { rl, clock, store };
}

describe('SlidingWindowRateLimiter — global budget (F11, #20)', () => {
  it('caps the total across every address and IP', () => {
    const { rl } = globalLimiter({ hourly: 2 });
    expect(rl.tryAcquire('addr1', '10.0.0.1').allowed).toBe(true);
    expect(rl.tryAcquire('addr2', '10.0.0.2').allowed).toBe(true);

    const d = rl.tryAcquire('addr3', '10.0.0.3');
    expect(d.allowed).toBe(false);
    expect(d.scope).toBe('global');
    expect(d.retryAfterMs).toBe(HOUR);
  });

  it('charges no address or IP when the global budget refuses', () => {
    const clock = fakeClock();
    const rl = new SlidingWindowRateLimiter({
      perAddress: { maxRequests: 1, windowMs: DAY },
      perIp: { maxRequests: 1, windowMs: DAY },
      global: [{ maxRequests: 1, windowMs: HOUR }],
      now: clock.now,
    });
    rl.tryAcquire('addr1', '10.0.0.1');
    expect(rl.tryAcquire('addr2', '10.0.0.2').scope).toBe('global');

    clock.advance(HOUR);
    // Had the refusal charged addr2 or its IP, their one-per-day budgets would still be spent.
    expect(rl.tryAcquire('addr2', '10.0.0.2').allowed).toBe(true);
  });

  it('hands the global slot back on release', () => {
    const { rl } = globalLimiter({ hourly: 1 });
    const first = rl.tryAcquire('addr1', '10.0.0.1');
    expect(rl.tryAcquire('addr2', '10.0.0.2').scope).toBe('global');

    rl.release(first.reservation!);
    expect(rl.tryAcquire('addr2', '10.0.0.2').allowed).toBe(true);
  });

  it('reports the wait until every refusing budget has room', () => {
    // Both the hour and the day are spent; retrying when the hour frees up would
    // only be refused again by the day.
    const { rl } = globalLimiter({ hourly: 1, daily: 1 });
    rl.tryAcquire('addr1', '10.0.0.1');

    const d = rl.tryAcquire('addr2', '10.0.0.2');
    expect(d.scope).toBe('global');
    expect(d.retryAfterMs).toBe(DAY);
  });

  it('enforces the hourly and daily windows independently', () => {
    const { rl, clock } = globalLimiter({ hourly: 2, daily: 3 });
    expect(rl.tryAcquire('a1', '10.0.0.1').allowed).toBe(true);
    expect(rl.tryAcquire('a2', '10.0.0.2').allowed).toBe(true);
    expect(rl.tryAcquire('a3', '10.0.0.3').scope).toBe('global');

    clock.advance(HOUR);
    expect(rl.tryAcquire('a3', '10.0.0.3').allowed).toBe(true);

    clock.advance(HOUR);
    // The hour has room again, but the day is spent until the first grant is 24 h old.
    const d = rl.tryAcquire('a4', '10.0.0.4');
    expect(d.allowed).toBe(false);
    expect(d.scope).toBe('global');
    expect(d.retryAfterMs).toBe(DAY - 2 * HOUR);
  });

  it('keeps a daily grant through prune long after the address window has passed', () => {
    const { rl, clock } = globalLimiter({ hourly: 5, daily: 1 });
    rl.tryAcquire('a1', '10.0.0.1');

    clock.advance(2 * HOUR);
    rl.prune();
    expect(rl.tryAcquire('a2', '10.0.0.2').scope).toBe('global');
  });

  it('reports how much of each global window is used', () => {
    const { rl } = globalLimiter({ hourly: 2, daily: 3 });
    rl.tryAcquire('a1', '10.0.0.1');
    expect(rl.usage()).toEqual([
      { maxRequests: 2, windowMs: HOUR, used: 1 },
      { maxRequests: 3, windowMs: DAY, used: 1 },
    ]);
  });
});

describe('SlidingWindowRateLimiter — limits survive a restart (F11, #20)', () => {
  it('restores grants from the store, so a restart resets nobody', () => {
    const store = new MemoryStore();
    const clock = fakeClock();
    globalLimiter({ store, clock }).rl.tryAcquire('addrA', '10.0.0.1');

    const d = globalLimiter({ store, clock }).rl.tryAcquire('addrA', '10.0.0.1');
    expect(d.allowed).toBe(false);
    expect(d.scope).toBe('address');
  });

  it('refunds in memory only, so a refund never costs a disk write', () => {
    // Reserve-then-refund spends no budget; if it also wrote the store, anyone
    // could make the faucet fsync on every request for free. An unsaved refund
    // only errs toward a longer wait after a restart.
    const store = new MemoryStore();
    const clock = fakeClock();
    const first = globalLimiter({ store, clock }).rl;
    const granted = first.tryAcquire('addrA', '10.0.0.1');
    let saves = 0;
    const save = store.save.bind(store);
    store.save = (log) => {
      saves += 1;
      save(log);
    };
    first.release(granted.reservation!);

    expect(saves).toBe(0);
    expect(first.tryAcquire('addrA', '10.0.0.1').allowed).toBe(true);
  });

  it('records nothing and throws when the store cannot be written', () => {
    // A grant that is not on disk would be forgotten by a crash after the
    // transfer is broadcast, so an unwritable store refuses the drip outright.
    const store = new MemoryStore();
    const clock = fakeClock();
    const { rl } = globalLimiter({ store, clock });
    const save = store.save.bind(store);
    store.save = () => {
      throw new Error('disk full');
    };
    expect(() => rl.tryAcquire('addrA', '10.0.0.1')).toThrow(/disk full/);

    store.save = save;
    expect(rl.size()).toBe(0);
    expect(rl.tryAcquire('addrA', '10.0.0.1').allowed).toBe(true);
  });

  it('does not load grants that expired while the faucet was down', () => {
    const store = new MemoryStore();
    const clock = fakeClock();
    globalLimiter({ store, clock }).rl.tryAcquire('addrA', '10.0.0.1');

    clock.advance(DAY);
    expect(globalLimiter({ store, clock }).rl.size()).toBe(0);
  });

  it('waits for the right grant when limits were tightened across a restart', () => {
    // 15 grants, then the hourly cap drops to 5: a slot frees only once 11 have
    // aged out, not when the first one does.
    const store = new MemoryStore();
    const clock = fakeClock();
    const before = globalLimiter({ store, clock, hourly: 20, daily: 50 }).rl;
    for (let i = 0; i < 15; i += 1) {
      before.tryAcquire(`a${i}`, `10.0.0.${i}`);
      clock.advance(60_000);
    }
    const after = globalLimiter({ store, clock, hourly: 5, daily: 50 }).rl;
    const d = after.tryAcquire('late', '10.0.1.1');
    expect(d.scope).toBe('global');
    // Grant 11 (index 10) was made 5 min before now; it ages out in 55 min.
    expect(d.retryAfterMs).toBe(55 * 60_000);
  });

  it('treats a grant dated in the future as made now', () => {
    // A clock that jumped back must not lock a requester out for days.
    const store = new MemoryStore();
    const clock = fakeClock();
    store.save(new Map([['address:addrA', [clock.now() + 3 * DAY]]]));
    const d = globalLimiter({ store, clock }).rl.tryAcquire('addrA', '10.0.0.1');
    expect(d.allowed).toBe(false);
    expect(d.retryAfterMs).toBe(HOUR);
  });

  it('refunds only reservations it issued, so a copy or a forgery refunds nothing', () => {
    const { rl } = limiter({ addressMax: 1, ipMax: 5 });
    const granted = rl.tryAcquire('addrA', '10.0.0.1');
    rl.release({ ...granted.reservation! });
    rl.release({ at: granted.reservation!.at, keys: ['address:addrA'] });
    expect(rl.tryAcquire('addrA', '10.0.0.1').allowed).toBe(false);
  });

  it('drops keys this version does not use', () => {
    // An older snapshot kept one global:<windowMs> key per window.
    const store = new MemoryStore();
    const clock = fakeClock();
    store.save(new Map([['global:12345', [clock.now()]]]));

    expect(globalLimiter({ store, clock }).rl.size()).toBe(0);
  });
});

describe('JsonFileStore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'faucet-store-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('starts empty when the file does not exist yet', () => {
    expect(new JsonFileStore(join(dir, 'missing', 'limits.json')).load().size).toBe(0);
  });

  it('round-trips what it saves, creating the directory', () => {
    const path = join(dir, 'nested', 'limits.json');
    new JsonFileStore(path).save(
      new Map([
        ['address:a', [1, 2]],
        ['ip:10.0.0.1', [3]],
      ]),
    );
    expect([...new JsonFileStore(path).load()]).toEqual([
      ['address:a', [1, 2]],
      ['ip:10.0.0.1', [3]],
    ]);
  });

  it('refuses a corrupt file rather than silently resetting every limit', () => {
    const path = join(dir, 'corrupt.json');
    writeFileSync(path, '{ not json');
    expect(() => new JsonFileStore(path).load()).toThrow(/delete it to reset/);
  });

  it('refuses a file with the wrong shape', () => {
    const path = join(dir, 'shape.json');
    writeFileSync(path, JSON.stringify({ version: 1, entries: { 'address:a': ['x'] } }));
    expect(() => new JsonFileStore(path).load()).toThrow(/delete it to reset/);
  });

  it('refuses an empty file and a snapshot from another version', () => {
    const empty = join(dir, 'empty.json');
    writeFileSync(empty, '');
    expect(() => new JsonFileStore(empty).load()).toThrow(/delete it to reset/);

    const future = join(dir, 'future.json');
    writeFileSync(future, JSON.stringify({ version: 2, entries: {} }));
    expect(() => new JsonFileStore(future).load()).toThrow(/delete it to reset/);
  });

  it('keeps the previous snapshot and leaves no temp file when a save fails', () => {
    const path = join(dir, 'kept.json');
    new JsonFileStore(path).save(new Map([['address:a', [1]]]));
    // A directory where the snapshot should be makes the rename fail.
    const blocked = join(dir, 'blocked.json');
    mkdirSync(blocked);
    expect(() => new JsonFileStore(blocked).save(new Map([['address:b', [2]]]))).toThrow();
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect([...new JsonFileStore(path).load()]).toEqual([['address:a', [1]]]);
  });

  it.skipIf(process.platform === 'win32')('replaces a planted temp symlink instead of writing through it', () => {
    const path = join(dir, 'planted.json');
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'untouched');
    symlinkSync(victim, `${path}.${process.pid}.tmp`);

    new JsonFileStore(path).save(new Map([['address:a', [1]]]));
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
    expect([...new JsonFileStore(path).load()]).toEqual([['address:a', [1]]]);
  });

  it.skipIf(process.platform === 'win32')('writes a file only its owner can read', () => {
    const path = join(dir, 'mode.json');
    new JsonFileStore(path).save(new Map());
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
