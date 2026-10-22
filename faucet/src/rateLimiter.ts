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
 *
 * Neither budget bounds the faucet itself: enough distinct IPs drain it at a
 * full per-IP budget each. Optional **global** budgets (F11, #20) cap the total
 * across every requester, and an optional store keeps every grant across a
 * restart, which would otherwise reset all budgets at once.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** One budget: at most `maxRequests` grants per rolling `windowMs`. */
export interface RateLimitRule {
  readonly maxRequests: number;
  readonly windowMs: number;
}

/** Which budget refused a request. */
export type RateLimitScope = 'address' | 'ip' | 'global';

export interface RateLimiterOptions {
  readonly perAddress: RateLimitRule;
  readonly perIp: RateLimitRule;
  /** Total budgets across every requester, checked together with the others. */
  readonly global?: readonly RateLimitRule[];
  /** Keeps grants across restarts; without one they live in memory only. */
  readonly store?: RateLimitStore;
  /** Injectable clock; defaults to `Date.now`. Tests drive it deterministically. */
  readonly now?: () => number;
}

/** One granted slot: the exact entries {@link SlidingWindowRateLimiter.release} removes. */
export interface Reservation {
  readonly at: number;
  readonly keys: readonly string[];
}

/** Outcome of an acquisition attempt. */
export type RateLimitDecision =
  | {
      readonly allowed: true;
      readonly reservation: Reservation;
      readonly scope?: undefined;
      readonly retryAfterMs?: undefined;
    }
  | {
      readonly allowed: false;
      /** The budget that refused; with several, the one that frees up last. */
      readonly scope: RateLimitScope;
      /** ms until every refusing budget has a free slot again. */
      readonly retryAfterMs: number;
      readonly reservation?: undefined;
    };

/** How much of one global budget is spent. */
export interface GlobalUsage {
  readonly maxRequests: number;
  readonly windowMs: number;
  readonly used: number;
}

/**
 * Persistence for grant timestamps, keyed exactly as the limiter keys them.
 *
 * `save` must be atomic and durable, and must throw when it cannot be: the
 * limiter undoes a change whose save threw, so a save that fails silently would
 * let memory run ahead of what a restart restores.
 */
export interface RateLimitStore {
  load(): Map<string, number[]>;
  save(log: ReadonlyMap<string, readonly number[]>): void;
}

function copyLog(log: ReadonlyMap<string, readonly number[]>): Map<string, number[]> {
  return new Map([...log].map(([key, entries]) => [key, [...entries]]));
}

/** A store that lasts as long as the process; for tests and local runs. */
export class MemoryStore implements RateLimitStore {
  private data = new Map<string, number[]>();

  load(): Map<string, number[]> {
    return copyLog(this.data);
  }

  save(log: ReadonlyMap<string, readonly number[]>): void {
    this.data = copyLog(log);
  }
}

const SNAPSHOT_VERSION = 1;

/**
 * Keeps grants in one JSON file, rewritten on every change: written to a temp
 * file, fsynced, then renamed over the old one, so a crash mid-write leaves the
 * previous snapshot rather than half of a new one.
 *
 * A missing file is a first start. Any other unreadable file stops startup,
 * because starting empty would silently reset every budget — the hole a store
 * exists to close. Deleting the file is the deliberate way to reset.
 */
export class JsonFileStore implements RateLimitStore {
  constructor(private readonly path: string) {}

  load(): Map<string, number[]> {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new Map();
      }
      throw error;
    }
    const entries = parseSnapshot(text);
    if (entries === undefined) {
      throw new Error(
        `rate-limit state file ${this.path} is not a valid snapshot; delete it to reset the limits`,
      );
    }
    return entries;
  }

  save(log: ReadonlyMap<string, readonly number[]>): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The file names who asked and when, so only its owner may read it.
    const temp = `${this.path}.${process.pid}.tmp`;
    try {
      // Remove whatever sits at the temp name, then create it exclusively: a
      // planted symlink is replaced rather than written through, and a planted
      // file cannot hand its looser mode to the snapshot.
      rmSync(temp, { force: true });
      const fd = openSync(temp, 'wx', 0o600);
      try {
        // writeFileSync loops until every byte is written; a single writeSync may not.
        writeFileSync(
          fd,
          JSON.stringify({ version: SNAPSHOT_VERSION, entries: Object.fromEntries(log) }),
        );
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.path);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
    syncDirectory(dir);
  }
}

/** Makes a rename durable. Windows cannot open a directory for this, and needs no help. */
function syncDirectory(dir: string): void {
  if (process.platform === 'win32') {
    return;
  }
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function parseSnapshot(text: string): Map<string, number[]> | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }
  const { version, entries } = data as { version?: unknown; entries?: unknown };
  if (
    version !== SNAPSHOT_VERSION ||
    typeof entries !== 'object' ||
    entries === null ||
    Array.isArray(entries)
  ) {
    return undefined;
  }
  const log = new Map<string, number[]>();
  for (const [key, value] of Object.entries(entries)) {
    if (!Array.isArray(value) || !value.every((t) => typeof t === 'number' && Number.isFinite(t))) {
      return undefined;
    }
    log.set(key, value as number[]);
  }
  return log;
}

function assertRule(name: string, rule: RateLimitRule): void {
  if (!Number.isInteger(rule.maxRequests) || rule.maxRequests < 1) {
    throw new Error(`${name}.maxRequests must be a positive integer, got ${rule.maxRequests}`);
  }
  if (!Number.isFinite(rule.windowMs) || rule.windowMs <= 0) {
    throw new Error(`${name}.windowMs must be a positive number, got ${rule.windowMs}`);
  }
}

/** Every global budget counts the same grants, so they share one log. */
const GLOBAL_KEY = 'global';

interface Check {
  readonly key: string;
  readonly scope: RateLimitScope;
  readonly rule: RateLimitRule;
}

export class SlidingWindowRateLimiter {
  private readonly perAddress: RateLimitRule;
  private readonly perIp: RateLimitRule;
  private readonly global: readonly RateLimitRule[];
  private readonly store: RateLimitStore | undefined;
  private readonly now: () => number;

  /** Grant timestamps per key, kept oldest-first. Keys are scope-prefixed. */
  private readonly log: Map<string, number[]>;

  /**
   * Reservations issued and not yet handed back. Only these can be released, so
   * a second release, a copy or a hand-built reservation refunds nothing — and
   * two grants in the same millisecond, which share a timestamp, cannot refund
   * each other's entry.
   */
  private readonly outstanding = new WeakSet<Reservation>();

  constructor(options: RateLimiterOptions) {
    assertRule('perAddress', options.perAddress);
    assertRule('perIp', options.perIp);
    const global = options.global ?? [];
    global.forEach((rule, i) => {
      assertRule(`global[${i}]`, rule);
    });
    this.perAddress = options.perAddress;
    this.perIp = options.perIp;
    this.global = global;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.log = this.loadLog();
  }

  /**
   * Reserves one grant against every budget, atomically.
   *
   * All budgets are *checked* before any is *recorded*. Anything else lets a
   * request rejected by the IP budget still consume the address budget — which
   * an attacker could use to lock a victim's address out of the faucet by
   * burning only their own IP quota.
   *
   * The reservation is synchronous, and with a store it is durable before this
   * returns, so a crash after the transfer is broadcast cannot forget the grant.
   * A store that cannot be written leaves nothing recorded and throws.
   * Call {@link release} with the returned reservation if the drip does not
   * go through.
   */
  tryAcquire(address: string, ip: string): RateLimitDecision {
    const now = this.now();
    const checks: Check[] = [
      { key: `address:${address}`, scope: 'address', rule: this.perAddress },
      { key: `ip:${ip}`, scope: 'ip', rule: this.perIp },
      ...this.global.map((rule) => ({ key: GLOBAL_KEY, scope: 'global' as const, rule })),
    ];

    // ─ Check every budget first; record nothing yet. ─
    const refusals = checks.flatMap((check) => {
      const entries = this.freshEntries(check.key, now, check.rule.windowMs);
      return entries.length >= check.rule.maxRequests
        ? [{ scope: check.scope, retryAfterMs: this.retryAfterMs(entries, now, check.rule) }]
        : [];
    });
    if (refusals.length > 0) {
      const latest = refusals.reduce((a, b) => (b.retryAfterMs > a.retryAfterMs ? b : a));
      return { allowed: false, scope: latest.scope, retryAfterMs: latest.retryAfterMs };
    }

    // ─ Every budget has room: commit to all of them, durably. ─
    const keys = [...new Set(checks.map((check) => check.key))];
    this.commit(keys.map((key) => [key, [...(this.log.get(key) ?? []), now]]));
    const reservation: Reservation = { at: now, keys };
    this.outstanding.add(reservation);
    return { allowed: true, reservation };
  }

  /**
   * Hands back exactly the grant `reservation` recorded.
   *
   * Used when a reserved drip never reached the chain (faucet insolvent, node
   * rejected the extrinsic). The requester was not served, so they must not be
   * billed for it. Releasing the same reservation twice refunds once.
   */
  release(reservation: Reservation): void {
    if (!this.outstanding.has(reservation)) {
      return;
    }
    // Entries with the same timestamp expire together, so removing any one of
    // them refunds exactly this grant's share of each window.
    const changes: Array<[string, number[]]> = [];
    for (const key of reservation.keys) {
      const entries = this.log.get(key) ?? [];
      const index = entries.indexOf(reservation.at);
      if (index >= 0) {
        changes.push([key, entries.filter((_, i) => i !== index)]);
      }
    }
    // In memory only: a refund spends no budget, so persisting it would let anyone
    // buy a disk sync per request for free. Unsaved, it only errs toward a longer
    // wait after a restart; the next grant or prune saves it anyway.
    this.apply(changes);
    this.outstanding.delete(reservation);
  }

  /**
   * Drops grants that have aged out, and keys left with none.
   *
   * The map is keyed by caller-supplied strings, so without reclamation a public
   * endpoint is an unbounded allocation for anyone who wants one.
   */
  prune(): void {
    const now = this.now();
    const changes: Array<[string, number[]]> = [];
    for (const [key, entries] of this.log) {
      const windowMs = this.windowFor(key);
      const fresh = windowMs === undefined ? [] : entries.filter((t) => now - t < windowMs);
      if (fresh.length !== entries.length) {
        changes.push([key, fresh]);
      }
    }
    if (changes.length > 0) {
      this.commit(changes);
    }
  }

  /** How much of each global budget is spent, in configuration order. */
  usage(): GlobalUsage[] {
    const now = this.now();
    return this.global.map((rule) => ({
      maxRequests: rule.maxRequests,
      windowMs: rule.windowMs,
      used: this.freshEntries(GLOBAL_KEY, now, rule.windowMs).length,
    }));
  }

  /** Number of tracked keys. Exposed so tests can assert memory is reclaimed. */
  size(): number {
    return this.log.size;
  }

  /**
   * Applies `changes`, then persists. If the store cannot be written, every
   * change is undone and the error rethrown, so memory never runs ahead of what
   * a restart would restore.
   */
  private commit(changes: ReadonlyArray<readonly [string, number[]]>): void {
    const previous = changes.map(([key]) => [key, this.log.get(key)] as const);
    this.apply(changes);
    try {
      this.store?.save(this.log);
    } catch (error) {
      this.apply(previous);
      throw error;
    }
  }

  /** Sets each key to its entries; an empty or absent list deletes the key. */
  private apply(changes: ReadonlyArray<readonly [string, number[] | undefined]>): void {
    for (const [key, entries] of changes) {
      if (entries === undefined || entries.length === 0) {
        this.log.delete(key);
      } else {
        this.log.set(key, entries);
      }
    }
  }

  /** Entries for `key` that are still inside the window, oldest first. */
  private freshEntries(key: string, now: number, windowMs: number): number[] {
    const entries = this.log.get(key) ?? [];
    return entries.filter((t) => now - t < windowMs);
  }

  /**
   * ms until enough entries expire to free a slot. That is the oldest one only
   * when the bucket is exactly full; with more entries than the budget allows
   * (limits tightened across a restart) it is the one `maxRequests` from the end.
   */
  private retryAfterMs(entries: number[], now: number, rule: RateLimitRule): number {
    const blocking = entries[entries.length - rule.maxRequests];
    if (blocking === undefined) {
      return 0;
    }
    return Math.max(0, blocking + rule.windowMs - now);
  }

  /** How long a key's entries matter, or undefined for a key this configuration no longer uses. */
  private windowFor(key: string): number | undefined {
    if (key.startsWith('address:')) return this.perAddress.windowMs;
    if (key.startsWith('ip:')) return this.perIp.windowMs;
    if (key === GLOBAL_KEY && this.global.length > 0) {
      return Math.max(...this.global.map((rule) => rule.windowMs));
    }
    return undefined;
  }

  /** Grants from the store that are still inside a window this configuration uses. */
  private loadLog(): Map<string, number[]> {
    const now = this.now();
    const log = new Map<string, number[]>();
    for (const [key, entries] of this.store?.load() ?? []) {
      const windowMs = this.windowFor(key);
      if (windowMs === undefined) continue;
      // A grant dated in the future (the clock jumped back) counts as made now,
      // so it cannot lock a requester out for longer than one window.
      const fresh = entries
        .map((t) => Math.min(t, now))
        .filter((t) => now - t < windowMs)
        .sort((a, b) => a - b);
      if (fresh.length > 0) {
        log.set(key, fresh);
      }
    }
    return log;
  }
}
