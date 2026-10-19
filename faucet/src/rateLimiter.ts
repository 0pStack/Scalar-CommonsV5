/**
 * Sliding-window rate limiting — the faucet's drain protection.
 *
 * The faucet spends from a finite, pre-funded devnet account. Without a budget
 * per requester it is not a faucet, it is a withdrawal. Two independent budgets
 * are enforced:
 *
 *   - **per address** — stops one account being topped up in a loop;
 *   - **per IP** — stops one requester farming an unlimited supply of *fresh*
 *     addresses, which a per-address budget alone cannot see.
 *
 * A sliding window (timestamp log) is used rather than fixed buckets because
 * fixed buckets let a requester spend two full budgets back-to-back across a
 * bucket boundary.
 */

/** One budget: at most `maxRequests` grants per rolling `windowMs`. */
export interface RateLimitRule {
  readonly maxRequests: number;
  readonly windowMs: number;
}

/** Which budget refused a request. */
export type RateLimitScope = 'address' | 'ip';

export interface RateLimiterOptions {
  readonly perAddress: RateLimitRule;
  readonly perIp: RateLimitRule;
  /** Injectable clock; defaults to `Date.now`. Tests drive it deterministically. */
  readonly now?: () => number;
}

/** Outcome of an acquisition attempt. */
export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Set only when `allowed` is false: the budget that refused. */
  readonly scope?: RateLimitScope;
  /** Set only when `allowed` is false: ms until the oldest entry ages out. */
  readonly retryAfterMs?: number;
}

function assertRule(name: string, rule: RateLimitRule): void {
  if (!Number.isInteger(rule.maxRequests) || rule.maxRequests < 1) {
    throw new Error(`${name}.maxRequests must be a positive integer, got ${rule.maxRequests}`);
  }
  if (!Number.isFinite(rule.windowMs) || rule.windowMs <= 0) {
    throw new Error(`${name}.windowMs must be a positive number, got ${rule.windowMs}`);
  }
}

export class SlidingWindowRateLimiter {
  private readonly perAddress: RateLimitRule;
  private readonly perIp: RateLimitRule;
  private readonly now: () => number;

  /** Grant timestamps per key, kept newest-last. Keys are scope-prefixed. */
  private readonly log = new Map<string, number[]>();

  constructor(options: RateLimiterOptions) {
    assertRule('perAddress', options.perAddress);
    assertRule('perIp', options.perIp);
    this.perAddress = options.perAddress;
    this.perIp = options.perIp;
    this.now = options.now ?? Date.now;
  }

  /**
   * Reserves one grant against both budgets, atomically.
   *
   * Both budgets are *checked* before either is *recorded*. Anything else lets a
   * request rejected by the IP budget still consume the address budget — which
   * an attacker could use to lock a victim's address out of the faucet by
   * burning only their own IP quota.
   *
   * The reservation is synchronous and happens before any transfer is submitted,
   * so two concurrent requests cannot both pass the same budget check. Call
   * {@link release} if the reserved drip does not go through.
   */
  tryAcquire(address: string, ip: string): RateLimitDecision {
    const now = this.now();
    const addressKey = `address:${address}`;
    const ipKey = `ip:${ip}`;

    const addressEntries = this.freshEntries(addressKey, now, this.perAddress.windowMs);
    const ipEntries = this.freshEntries(ipKey, now, this.perIp.windowMs);

    // ─ Check both budgets first; record nothing yet. ─
    if (addressEntries.length >= this.perAddress.maxRequests) {
      return {
        allowed: false,
        scope: 'address',
        retryAfterMs: this.retryAfterMs(addressEntries, now, this.perAddress.windowMs),
      };
    }
    if (ipEntries.length >= this.perIp.maxRequests) {
      return {
        allowed: false,
        scope: 'ip',
        retryAfterMs: this.retryAfterMs(ipEntries, now, this.perIp.windowMs),
      };
    }

    // ─ Both budgets have room: commit to both. ─
    addressEntries.push(now);
    ipEntries.push(now);
    this.log.set(addressKey, addressEntries);
    this.log.set(ipKey, ipEntries);
    return { allowed: true };
  }

  /**
   * Hands back the most recent grant for this address/IP pair.
   *
   * Used when a reserved drip never reached the chain (faucet insolvent, node
   * rejected the extrinsic). The requester was not served, so they must not be
   * billed for it.
   */
  release(address: string, ip: string): void {
    this.dropNewest(`address:${address}`);
    this.dropNewest(`ip:${ip}`);
  }

  /**
   * Drops keys whose grants have all aged out.
   *
   * The map is keyed by caller-supplied strings, so without reclamation a public
   * endpoint is an unbounded allocation for anyone who wants one.
   */
  prune(): void {
    const now = this.now();
    for (const [key, entries] of this.log) {
      const windowMs = key.startsWith('address:') ? this.perAddress.windowMs : this.perIp.windowMs;
      const fresh = entries.filter((t) => now - t < windowMs);
      if (fresh.length === 0) {
        this.log.delete(key);
      } else {
        this.log.set(key, fresh);
      }
    }
  }

  /** Number of tracked keys. Exposed so tests can assert memory is reclaimed. */
  size(): number {
    return this.log.size;
  }

  /** Entries for `key` that are still inside the window, oldest first. */
  private freshEntries(key: string, now: number, windowMs: number): number[] {
    const entries = this.log.get(key) ?? [];
    return entries.filter((t) => now - t < windowMs);
  }

  /** ms until the oldest in-window entry expires and frees a slot. */
  private retryAfterMs(entries: number[], now: number, windowMs: number): number {
    const oldest = entries[0];
    if (oldest === undefined) {
      return 0;
    }
    return Math.max(0, oldest + windowMs - now);
  }

  private dropNewest(key: string): void {
    const entries = this.log.get(key);
    if (!entries || entries.length === 0) {
      return;
    }
    entries.pop();
    if (entries.length === 0) {
      this.log.delete(key);
    } else {
      this.log.set(key, entries);
    }
  }
}
