import { describe, it, expect } from 'vitest';

import { createBlockCache } from '../src/cache.js';

/**
 * The decoded-block cache.
 *
 * A block named by its hash never changes, so decoding it once and serving the
 * result again is exact — and it is what stops a reload of a busy block page
 * from costing the node a full block read and the explorer a full decode.
 */

const hash = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;

describe('createBlockCache', () => {
  it('loads a block once and serves the decoded result again', async () => {
    const cache = createBlockCache<string>(4);
    let loads = 0;
    const load = async (): Promise<string> => {
      loads += 1;
      return 'decoded';
    };
    expect(await cache.get(hash(1), load)).toBe('decoded');
    expect(await cache.get(hash(1), load)).toBe('decoded');
    expect(loads).toBe(1);
  });

  it('shares one load between concurrent requests for the same block', async () => {
    const cache = createBlockCache<number>(4);
    let loads = 0;
    const load = async (): Promise<number> => {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 7;
    };
    expect(await Promise.all([cache.get(hash(1), load), cache.get(hash(1), load)])).toEqual([7, 7]);
    expect(loads).toBe(1);
  });

  it('keeps distinct blocks apart', async () => {
    const cache = createBlockCache<string>(4);
    expect(await cache.get(hash(1), async () => 'one')).toBe('one');
    expect(await cache.get(hash(2), async () => 'two')).toBe('two');
  });

  it('evicts the least recently used block beyond its bound', async () => {
    const cache = createBlockCache<string>(2);
    const loaded: string[] = [];
    const load = (name: string) => async (): Promise<string> => {
      loaded.push(name);
      return name;
    };
    await cache.get(hash(1), load('1'));
    await cache.get(hash(2), load('2'));
    await cache.get(hash(1), load('1')); // 1 is now the most recent
    await cache.get(hash(3), load('3')); // evicts 2
    await cache.get(hash(1), load('1'));
    await cache.get(hash(2), load('2'));
    expect(loaded).toEqual(['1', '2', '3', '2']);
  });

  it('does not cache a failed load, so a node hiccup is retried rather than remembered', async () => {
    const cache = createBlockCache<string>(4);
    await expect(
      cache.get(hash(1), async () => {
        throw new Error('socket dropped');
      }),
    ).rejects.toThrow('socket dropped');
    expect(await cache.get(hash(1), async () => 'decoded')).toBe('decoded');
  });

  it('rejects a bound that could not hold a single block', () => {
    expect(() => createBlockCache(0)).toThrow();
  });
});
