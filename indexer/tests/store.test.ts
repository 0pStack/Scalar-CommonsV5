import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { IndexerStore, type IndexedBlock } from '../src/store.ts';

/**
 * The store is the indexer's memory of the chain. Two invariants are load-bearing:
 *
 *  - Writing a block twice must not double-count. The indexer backfills and
 *    subscribes at the same time, so the same finalized block genuinely does
 *    arrive twice on a normal startup.
 *  - Balance-shaped values round-trip as exact decimal strings. SQLite INTEGER
 *    is 64-bit; a `u128` planck amount does not fit and must never be coerced.
 */

const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const BOB = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

function sampleBlock(number: number, overrides: Partial<IndexedBlock> = {}): IndexedBlock {
  const hash = `0x${number.toString(16).padStart(64, '0')}`;
  return {
    block: {
      number,
      hash,
      parentHash: `0x${(number - 1).toString(16).padStart(64, '0')}`,
      stateRoot: `0x${'a'.repeat(64)}`,
      extrinsicsRoot: `0x${'b'.repeat(64)}`,
      timestampMs: 1_787_000_000_000 + number * 6_000,
      extrinsicCount: 1,
      eventCount: 1,
    },
    extrinsics: [
      {
        id: `${number}-0`,
        blockNumber: number,
        index: 0,
        hash: `0x${'c'.repeat(64)}`,
        section: 'agents',
        method: 'heartbeat',
        signer: ALICE,
        nonce: 0,
        tipPlancks: '0',
        success: true,
        args: {},
      },
    ],
    events: [
      {
        id: `${number}-0`,
        blockNumber: number,
        index: 0,
        section: 'agents',
        method: 'HeartbeatSent',
        phase: 'ApplyExtrinsic',
        extrinsicId: `${number}-0`,
        data: { who: ALICE },
        accounts: [ALICE],
      },
    ],
    ...overrides,
  };
}

describe('IndexerStore', () => {
  let store: IndexerStore;

  beforeEach(() => {
    store = IndexerStore.open(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('starts empty', () => {
    expect(store.latestBlockNumber()).toBeNull();
    expect(store.earliestBlockNumber()).toBeNull();
    expect(store.listBlocks({ limit: 10, offset: 0 })).toEqual({ total: 0, items: [] });
  });

  it('reports how far back its history actually reaches', () => {
    // The window an endpoint can honestly claim to cover is the oldest block
    // held, not the startup backfill depth: the indexer keeps accumulating for
    // as long as it runs, so history reaches further back than the window it
    // started with.
    for (const n of [100, 101, 102]) store.saveBlock(sampleBlock(n));
    expect(store.earliestBlockNumber()).toBe(100);
    expect(store.latestBlockNumber()).toBe(102);
  });

  it('persists a block with its extrinsics and events', () => {
    store.saveBlock(sampleBlock(100));

    expect(store.latestBlockNumber()).toBe(100);
    expect(store.hasBlock(100)).toBe(true);

    const blocks = store.listBlocks({ limit: 10, offset: 0 });
    expect(blocks.total).toBe(1);
    expect(blocks.items[0]?.number).toBe(100);

    expect(store.getExtrinsic('100-0')?.method).toBe('heartbeat');
    expect(store.getEvent('100-0')?.method).toBe('HeartbeatSent');
  });

  it('is idempotent — re-indexing a block does not duplicate rows', () => {
    store.saveBlock(sampleBlock(100));
    store.saveBlock(sampleBlock(100));

    expect(store.listBlocks({ limit: 10, offset: 0 }).total).toBe(1);
    expect(store.listExtrinsics({ limit: 10, offset: 0 }).total).toBe(1);
    expect(store.listEvents({ limit: 10, offset: 0 }).total).toBe(1);
    // The account seen twice in the same block is still one account, and its
    // activity counters reflect distinct rows rather than repeated writes.
    const account = store.getAccount(ALICE);
    expect(account?.eventCount).toBe(1);
    expect(account?.extrinsicCount).toBe(1);
  });

  it('returns blocks newest first and pages through them', () => {
    for (const n of [100, 101, 102]) store.saveBlock(sampleBlock(n));

    const firstPage = store.listBlocks({ limit: 2, offset: 0 });
    expect(firstPage.total).toBe(3);
    expect(firstPage.items.map((b) => b.number)).toEqual([102, 101]);

    const secondPage = store.listBlocks({ limit: 2, offset: 2 });
    expect(secondPage.items.map((b) => b.number)).toEqual([100]);
  });

  it('looks a block up by hash as well as by number', () => {
    store.saveBlock(sampleBlock(100));
    const byNumber = store.getBlock('100');
    const byHash = store.getBlock(`0x${(100).toString(16).padStart(64, '0')}`);
    expect(byHash).toEqual(byNumber);
    expect(store.getBlock('999')).toBeNull();
  });

  it('filters extrinsics by signer, block and call', () => {
    store.saveBlock(sampleBlock(100));
    const other = sampleBlock(101);
    other.extrinsics[0]!.signer = BOB;
    other.extrinsics[0]!.section = 'balances';
    other.extrinsics[0]!.method = 'transferKeepAlive';
    store.saveBlock(other);

    expect(store.listExtrinsics({ limit: 10, offset: 0, signer: ALICE }).total).toBe(1);
    expect(store.listExtrinsics({ limit: 10, offset: 0, signer: BOB }).items[0]?.method).toBe('transferKeepAlive');
    expect(store.listExtrinsics({ limit: 10, offset: 0, blockNumber: 101 }).total).toBe(1);
    expect(store.listExtrinsics({ limit: 10, offset: 0, section: 'agents' }).total).toBe(1);
  });

  it('filters events by section, method, block, extrinsic and account', () => {
    store.saveBlock(sampleBlock(100));
    const other = sampleBlock(101);
    other.events[0]!.section = 'escrow';
    other.events[0]!.method = 'AgreementCreated';
    other.events[0]!.accounts = [ALICE, BOB];
    store.saveBlock(other);

    expect(store.listEvents({ limit: 10, offset: 0, section: 'escrow' }).total).toBe(1);
    expect(store.listEvents({ limit: 10, offset: 0, method: 'HeartbeatSent' }).total).toBe(1);
    expect(store.listEvents({ limit: 10, offset: 0, blockNumber: 100 }).total).toBe(1);
    expect(store.listEvents({ limit: 10, offset: 0, extrinsicId: '101-0' }).total).toBe(1);
    expect(store.listEvents({ limit: 10, offset: 0, account: BOB }).total).toBe(1);
    expect(store.listEvents({ limit: 10, offset: 0, account: ALICE }).total).toBe(2);
  });

  it('tracks account first/last seen across blocks', () => {
    store.saveBlock(sampleBlock(100));
    store.saveBlock(sampleBlock(105));

    const account = store.getAccount(ALICE);
    expect(account?.firstSeenBlock).toBe(100);
    expect(account?.lastSeenBlock).toBe(105);
    expect(account?.eventCount).toBe(2);
    expect(store.listAccounts({ limit: 10, offset: 0 }).total).toBe(1);
  });

  it('round-trips u128 planck values without precision loss', () => {
    const block = sampleBlock(100);
    // 100B CMN supply cap in plancks — far beyond both 2^53 and SQLite's INTEGER.
    const huge = (100_000_000_000n * 10n ** 12n).toString();
    block.extrinsics[0]!.tipPlancks = huge;
    block.events[0]!.data = { amount: huge };
    store.saveBlock(block);

    const extrinsic = store.getExtrinsic('100-0');
    expect(extrinsic?.tipPlancks).toBe(huge);
    expect(BigInt(extrinsic!.tipPlancks!)).toBe(100_000_000_000n * 10n ** 12n);
    expect((store.getEvent('100-0')?.data as { amount: string }).amount).toBe(huge);
  });

  it('reports gaps so the indexer knows what still needs backfilling', () => {
    store.saveBlock(sampleBlock(100));
    store.saveBlock(sampleBlock(102));
    expect(store.missingBlocks(100, 103)).toEqual([101, 103]);
    expect(store.missingBlocks(100, 102)).toEqual([101]);
  });
});
