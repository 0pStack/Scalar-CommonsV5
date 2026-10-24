/**
 * A bounded cache of decoded blocks, keyed by block hash.
 *
 * A block named by its hash is immutable, so a cached decode is exactly what a
 * fresh one would return: caching it trades no correctness for the node read
 * and the decode every reload of a block or extrinsic page would otherwise
 * cost. Only hashes are keys. A block number can be re-orged onto a different
 * block before finality, so number-to-hash resolution always asks the node.
 *
 * The cache holds the in-flight promise, so concurrent requests for one block
 * share a single load. A load that fails is dropped rather than remembered: a
 * dropped socket is a reason to ask again, not an answer.
 */

export interface BlockCache<T> {
  /** The cached value for `hash`, or the result of `load()`, which is then cached. */
  get(hash: string, load: () => Promise<T>): Promise<T>;
}

/** How many decoded blocks the explorer keeps; the bound is what keeps memory flat under a crawler. */
export const BLOCK_CACHE_SIZE = 256;

export function createBlockCache<T>(limit: number): BlockCache<T> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`block cache bound must be a positive integer, not ${limit}`);
  }
  // A Map iterates in insertion order, so re-inserting on every hit keeps the
  // least recently used entry first.
  const entries = new Map<string, Promise<T>>();

  return {
    get(hash: string, load: () => Promise<T>): Promise<T> {
      const cached = entries.get(hash);
      if (cached !== undefined) {
        entries.delete(hash);
        entries.set(hash, cached);
        return cached;
      }
      const loading = load();
      entries.set(hash, loading);
      loading.catch(() => {
        if (entries.get(hash) === loading) {
          entries.delete(hash);
        }
      });
      if (entries.size > limit) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) {
          entries.delete(oldest);
        }
      }
      return loading;
    },
  };
}
