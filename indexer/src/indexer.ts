/**
 * The follower loop: finalized blocks in, index rows out.
 *
 * Only *finalized* blocks are indexed. Indexing best blocks would let the API
 * report an escrow agreement or an era settlement that a re-org later erased —
 * for a chain whose whole purpose is coordination between agents that act on
 * what they read, "probably happened" is not good enough.
 */

import type { ApiPromise } from '@polkadot/api';
import type { VoidFn } from '@polkadot/api/types';

import { fetchIndexedBlock } from './ingest.ts';
import type { IndexerStore } from './store.ts';

export interface ChainIndexerOptions {
  /** Finalized blocks to backfill at startup. */
  readonly backfillDepth: number;
  /** Where progress and ingestion failures are reported. */
  readonly logger?: Pick<Console, 'log' | 'error'>;
}

export class ChainIndexer {
  private unsubscribe: VoidFn | null = null;
  private queue: Promise<void> = Promise.resolve();
  private waiters: { height: number; resolve: () => void; fail: (error: Error) => void }[] = [];
  private readonly logger: Pick<Console, 'log' | 'error'>;
  private running = false;

  private readonly api: ApiPromise;
  private readonly store: IndexerStore;
  private readonly options: ChainIndexerOptions;

  constructor(api: ApiPromise, store: IndexerStore, options: ChainIndexerOptions) {
    this.api = api;
    this.store = store;
    this.options = options;
    this.logger = options.logger ?? console;
  }

  /** Highest block indexed so far, or null before the first one lands. */
  get syncedHeight(): number | null {
    return this.store.latestBlockNumber();
  }

  /** How many blocks the index currently holds. */
  get indexedBlocks(): number {
    return this.store.blockCount();
  }

  /**
   * Backfills the recent window, then follows finalized heads.
   *
   * Backfill runs before the subscription is armed so the API never starts
   * serving a window with a hole in the middle of it.
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;

    const finalizedHash = await this.api.rpc.chain.getFinalizedHead();
    const finalizedHeader = await this.api.rpc.chain.getHeader(finalizedHash);
    const head = finalizedHeader.number.toNumber();
    const from = Math.max(0, head - this.options.backfillDepth + 1);

    if (this.options.backfillDepth > 0) {
      const missing = this.store.missingBlocks(from, head);
      for (const blockNumber of missing) {
        await this.indexBlock(blockNumber);
      }
      this.logger.log(`indexer: backfilled ${missing.length} block(s) up to #${head}`);
    }

    this.unsubscribe = await this.api.rpc.chain.subscribeFinalizedHeads((header) => {
      const height = header.number.toNumber();
      // Serialise ingestion: finalized heads can arrive faster than a block is
      // read back, and two concurrent writers would interleave transactions.
      this.queue = this.queue.then(() => this.catchUpTo(height)).catch((error) => {
        this.logger.error(`indexer: failed to index up to #${height}: ${String(error)}`);
      });
    });
  }

  /** Stops following. Safe to call when never started. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    await this.queue.catch(() => undefined);
    // Pending waiters are failed, not resolved. Resolving them would report
    // "the index reached block N" for a block the follower stopped short of,
    // and a test awaiting that block would pass on a shut-down indexer.
    for (const waiter of this.waiters.splice(0)) {
      waiter.fail(new Error(`indexer stopped before reaching block #${waiter.height}`));
    }
  }

  /**
   * Resolves once the index has reached `height`.
   *
   * Exposed because "wait for the chain to catch up" is the only honest way to
   * observe an asynchronous follower — the alternative, sleeping a guessed
   * interval, turns a slow block into a false failure.
   */
  waitForBlock(height: number, timeoutMs = 120_000): Promise<void> {
    const current = this.syncedHeight;
    if (current !== null && current >= height) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const onReached = () => {
        clearTimeout(timer);
        resolve();
      };
      const onFailed = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.resolve !== onReached);
        onFailed(
          new Error(
            `indexer did not reach block #${height} within ${timeoutMs}ms (at #${this.syncedHeight ?? 'none'})`,
          ),
        );
      }, timeoutMs);

      this.waiters.push({ height, resolve: onReached, fail: onFailed });
    });
  }

  /** Indexes every block from just after the last indexed one up to `height`. */
  private async catchUpTo(height: number): Promise<void> {
    const latest = this.store.latestBlockNumber();
    const from = latest === null ? height : Math.min(latest + 1, height);
    for (let blockNumber = from; blockNumber <= height; blockNumber += 1) {
      if (!this.store.hasBlock(blockNumber)) {
        await this.indexBlock(blockNumber);
      }
    }
  }

  private async indexBlock(blockNumber: number): Promise<void> {
    const indexed = await fetchIndexedBlock(this.api, blockNumber);
    this.store.saveBlock(indexed);
    this.releaseWaiters(blockNumber);
  }

  private releaseWaiters(height: number): void {
    const reached = this.waiters.filter((waiter) => waiter.height <= height);
    if (reached.length === 0) {
      return;
    }
    this.waiters = this.waiters.filter((waiter) => waiter.height > height);
    for (const waiter of reached) {
      waiter.resolve();
    }
  }
}
