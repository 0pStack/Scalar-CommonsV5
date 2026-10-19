import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { ACTIVITY_PAGE_SIZE, IndexerResponseError, createIndexerClient, toActivityView } from '../src/activity.js';
import type { ExplorerChain } from '../src/chain.js';
import { renderActivity } from '../src/render.js';
import { activityPath, parseRoute } from '../src/routes.js';
import { createExplorerServer } from '../src/server.js';
import type { ActivityView, ChainInfo } from '../src/types.js';

/**
 * The agent-activity page, end to end within the explorer, against a stand-in
 * indexer.
 *
 * The explorer reads activity from the indexer's `/v1/activity`, because a feed
 * over history is exactly what the explorer's no-database, bounded-reads design
 * cannot compute from a node per request. What is under test here is the
 * explorer's half: the route, the shaping of what the indexer answered (loudly
 * refusing anything it does not recognise), and the page. The indexer's half is
 * covered against a live node in `indexer/tests/live.test.ts`.
 */

const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const BOB = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

const CHAIN: ChainInfo = {
  chain: 'Scalar Commons Local Testnet',
  specName: 'scalar-commons',
  specVersion: 307,
  tokenSymbol: 'CMN',
  tokenDecimals: 12,
  ss58Format: 42,
  genesisHash: `0x${'ff'.repeat(32)}`,
};

/** Field types as the runtime metadata names them, for the events these tests use. */
const FIELD_TYPES: Record<string, Record<string, string>> = {
  'escrow.AgreementCreated': { buyer: 'T::AccountId', provider: 'T::AccountId', seq: 'u32', amount: 'BalanceOf<T>' },
  'agents.HeartbeatSent': { who: 'T::AccountId' },
};
const fieldTypes = (section: string, method: string) => {
  const types = FIELD_TYPES[`${section}.${method}`];
  return types === undefined ? null : new Map(Object.entries(types));
};

const FEED = {
  total: 2,
  limit: ACTIVITY_PAGE_SIZE,
  offset: 0,
  agent: null,
  kind: null,
  historyFrom: 100,
  items: [
    {
      id: '120-4',
      blockNumber: 120,
      index: 4,
      extrinsicId: '120-2',
      timestampMs: 1_787_086_860_000,
      kind: 'agreement',
      section: 'escrow',
      method: 'AgreementCreated',
      agents: [ALICE, BOB],
      data: { buyer: ALICE, provider: BOB, seq: 3, amount: '12500000000000' },
    },
    {
      id: '118-1',
      blockNumber: 118,
      index: 1,
      extrinsicId: null,
      timestampMs: null,
      kind: 'heartbeat',
      section: 'agents',
      method: 'HeartbeatSent',
      agents: [ALICE],
      data: { who: `<script>alert(1)</script>` },
    },
  ],
};

describe('activity routes', () => {
  it('routes the feed, with and without an agent filter', () => {
    expect(parseRoute('/activity')).toEqual({ kind: 'activity', agent: null, offset: 0 });
    expect(parseRoute(`/activity?agent=${ALICE}`)).toEqual({ kind: 'activity', agent: ALICE, offset: 0 });
    expect(parseRoute(`/activity?agent=${ALICE}&offset=50`)).toEqual({ kind: 'activity', agent: ALICE, offset: 50 });
    // The filter form submits an empty field when cleared; that means "everyone".
    expect(parseRoute('/activity?agent=')).toEqual({ kind: 'activity', agent: null, offset: 0 });
    expect(parseRoute('/activity?agent=%20' + ALICE + '%20')).toEqual({ kind: 'activity', agent: ALICE, offset: 0 });
  });

  it('refuses a filter that is not an address, rather than showing an empty feed', () => {
    expect(parseRoute('/activity?agent=nonsense')).toEqual({
      kind: 'badRequest',
      message: 'not a valid SS58 account address: nonsense',
    });
    expect(parseRoute('/activity?offset=-1').kind).toBe('badRequest');
    expect(parseRoute('/activity?offset=1.5').kind).toBe('badRequest');
  });

  it('round-trips through the path builder', () => {
    expect(parseRoute(activityPath())).toEqual({ kind: 'activity', agent: null, offset: 0 });
    expect(parseRoute(activityPath(ALICE, 25))).toEqual({ kind: 'activity', agent: ALICE, offset: 25 });
  });
});

describe('toActivityView', () => {
  it('keeps the indexer order and types each field from runtime metadata', () => {
    const view = toActivityView(FEED, fieldTypes, { agent: null, offset: 0 });
    expect(view.entries.map((entry) => entry.id)).toEqual(['120-4', '118-1']);
    const [created] = view.entries;
    expect(created?.fields).toEqual([
      { name: 'buyer', value: ALICE, kind: 'account' },
      { name: 'provider', value: BOB, kind: 'account' },
      { name: 'seq', value: '3', kind: 'plain' },
      { name: 'amount', value: '12500000000000', kind: 'balance' },
    ]);
    expect(created?.timestampMs).toBe(1_787_086_860_000n);
    expect(view.total).toBe(2);
    expect(view.historyFrom).toBe(100);
  });

  it('falls back to plain text for an event the runtime metadata does not describe', () => {
    const view = toActivityView(
      { ...FEED, items: [{ ...FEED.items[0]!, section: 'messaging', method: 'MessageSent', kind: 'message', data: { note: 'hi' } }] },
      fieldTypes,
      { agent: null, offset: 0 },
    );
    expect(view.entries[0]?.fields).toEqual([{ name: 'note', value: 'hi', kind: 'plain' }]);
  });

  it('refuses an answer that is not the activity feed', () => {
    expect(() => toActivityView({ error: 'nope' }, fieldTypes, { agent: null, offset: 0 })).toThrow(IndexerResponseError);
    expect(() =>
      toActivityView({ ...FEED, items: [{ ...FEED.items[0]!, blockNumber: 'x' }] }, fieldTypes, { agent: null, offset: 0 }),
    ).toThrow(IndexerResponseError);
  });
});

describe('renderActivity', () => {
  const view: ActivityView = toActivityView(FEED, fieldTypes, { agent: null, offset: 0 });
  const html = renderActivity(view, CHAIN);

  it('lists activity newest first, linking block, extrinsic and agents', () => {
    expect(html.indexOf('120-4')).toBeLessThan(html.indexOf('118-1'));
    expect(html).toContain('href="/block/120"');
    expect(html).toContain('href="/extrinsic/120/2"');
    expect(html).toContain(`href="/activity?agent=${ALICE}"`);
    expect(html).toContain(`href="/account/${ALICE}"`);
    expect(html).toContain('escrow.AgreementCreated');
  });

  it('prints balances in tokens, never raw plancks', () => {
    expect(html).toContain('12.5 CMN');
    expect(html).not.toContain('12500000000000');
  });

  it('escapes chain-supplied values', () => {
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('refreshes itself while showing the newest page, and offers a filter form', () => {
    expect(html).toMatch(/<meta http-equiv="refresh" content="\d+">/);
    expect(html).toMatch(/<form[^>]*method="get"[^>]*action="\/activity"/);
    expect(html).toContain('name="agent"');
  });

  it('does not refresh an older page out from under the reader', () => {
    const older = renderActivity({ ...view, offset: 50 }, CHAIN);
    expect(older).not.toContain('http-equiv="refresh"');
  });

  it('says whose activity it is showing and how far back history reaches', () => {
    const filtered = renderActivity({ ...view, agent: ALICE }, CHAIN);
    expect(filtered).toContain(ALICE);
    expect(filtered).toContain('href="/activity"');
    expect(html).toContain('block 100');
  });

  it('says so when there is no activity, rather than rendering an empty table', () => {
    const empty = renderActivity({ ...view, total: 0, entries: [] }, CHAIN);
    expect(empty).toContain('No agent activity');
  });

  it('links to older activity only when there is more', () => {
    expect(html).not.toContain('Older');
    const more = renderActivity({ ...view, total: 120 }, CHAIN);
    expect(more).toContain(`href="/activity?offset=${ACTIVITY_PAGE_SIZE}"`);
  });
});

describe('the /activity page over HTTP', () => {
  let indexer: Server;
  let explorer: Server;
  let base: string;
  const seen: string[] = [];

  /** Only what the activity page touches; every other view would be a test bug. */
  const chain = {
    chainInfo: () => CHAIN,
    eventFieldTypes: fieldTypes,
  } as unknown as ExplorerChain;

  beforeAll(async () => {
    indexer = createServer((request, response) => {
      seen.push(request.url ?? '');
      if (request.url?.includes('fail')) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'node unreachable' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(FEED));
    });
    await new Promise<void>((resolve) => indexer.listen(0, '127.0.0.1', resolve));
    const indexerUrl = `http://127.0.0.1:${(indexer.address() as AddressInfo).port}`;

    explorer = createExplorerServer({ chain, activity: createIndexerClient({ baseUrl: indexerUrl }), onError: () => {} });
    await new Promise<void>((resolve) => explorer.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(explorer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => explorer.close(() => resolve()));
    await new Promise<void>((resolve) => indexer.close(() => resolve()));
  });

  it('asks the indexer for the newest page, filtered by the agent', async () => {
    const response = await fetch(`${base}/activity?agent=${ALICE}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('escrow.AgreementCreated');
    expect(seen.at(-1)).toBe(`/v1/activity?limit=${ACTIVITY_PAGE_SIZE}&offset=0&agent=${ALICE}`);
  });

  it('reports an indexer failure as 502, not as an empty feed', async () => {
    const failing = createExplorerServer({
      chain,
      activity: createIndexerClient({ baseUrl: `http://127.0.0.1:${(indexer.address() as AddressInfo).port}/fail` }),
      onError: () => {},
    });
    await new Promise<void>((resolve) => failing.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(failing.address() as AddressInfo).port}/activity`);
      expect(response.status).toBe(502);
      expect(await response.text()).toContain('node unreachable');
    } finally {
      await new Promise<void>((resolve) => failing.close(() => resolve()));
    }
  });

  it('reports an unreachable indexer as 502', async () => {
    const orphan = createExplorerServer({
      chain,
      activity: createIndexerClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2_000 }),
      onError: () => {},
    });
    await new Promise<void>((resolve) => orphan.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(orphan.address() as AddressInfo).port}/activity`);
      expect(response.status).toBe(502);
      expect(await response.text()).toContain('indexer');
    } finally {
      await new Promise<void>((resolve) => orphan.close(() => resolve()));
    }
  });

  it('400s a bad agent filter without asking the indexer', async () => {
    const before = seen.length;
    const response = await fetch(`${base}/activity?agent=nonsense`);
    expect(response.status).toBe(400);
    expect(seen.length).toBe(before);
  });
});

describe('renderActivity provenance', () => {
  it('names the indexer as its source, not the node alone', () => {
    const html = renderActivity(toActivityView(FEED, fieldTypes, { agent: null, offset: 0 }), CHAIN);
    expect(html).toContain('Activity read from the indexer');
    expect(html).not.toContain('Read directly from the node');
  });
});
