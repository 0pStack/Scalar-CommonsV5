import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  ACTIVITY_KINDS,
  ACTIVITY_SOURCES,
  activityItem,
  classifyActivity,
  parseActivityKind,
  sourcesFor,
} from '../src/activity.ts';
import { matchRoute, ROUTES } from '../src/api.ts';
import { IndexerStore, type EventRow, type IndexedBlock } from '../src/store.ts';

/**
 * The agent-activity feed, tested without a chain.
 *
 * Two properties carry the feature. Classification must be exact — a feed that
 * called `emissions.EraSettled` "agreement" activity, or dropped a slash, would
 * misreport what an agent did. And the feed must come out of the index newest
 * first, across blocks and within one, so "live" means the top row is the most
 * recent thing that happened.
 */

const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const BOB = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const CHARLIE = '5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y';

describe('classifyActivity', () => {
  it('classifies each requested activity family', () => {
    expect(classifyActivity('agents', 'AgentRegistered')).toBe('registration');
    expect(classifyActivity('agents', 'HeartbeatSent')).toBe('heartbeat');
    // All eight agreement endings, including the four from E18/E2 (#180).
    // The classifier is an allow-list, so a missing method is SILENT — the rows
    // just never appear — which is why each one is named here rather than
    // spot-checked.
    for (const method of ['AgreementCreated', 'DeliveryRecorded', 'DeliveryConfirmed', 'RefundClaimed', 'DeadlineExtended',
                          'AgreementAccepted', 'AgreementRejected', 'PendingCancelled', 'AgreementExpired']) {
      expect(classifyActivity('escrow', method), method).toBe('agreement');
    }
    expect(classifyActivity('escrow', 'DisputeOpened')).toBe('dispute');
    expect(classifyActivity('escrow', 'DisputeResolved')).toBe('dispute');
    expect(classifyActivity('oracle', 'OracleResponseSubmitted')).toBe('oracle_vote');
    expect(classifyActivity('oracle', 'BatchResponseSubmitted')).toBe('oracle_vote');
    expect(classifyActivity('agents', 'SlashExecuted')).toBe('slash');
    expect(classifyActivity('agents', 'SlashAppealed')).toBe('slash');
    expect(classifyActivity('agents', 'SlashAppealWithdrawn')).toBe('slash');
  });

  it('takes every event of a messaging pallet as a message', () => {
    // `messages` is the section that actually shipped, in runtime 309 (#242).
    // Asserted first, and by its real event name.
    //
    // The two names below it were written before the pallet existed and are
    // guesses. A test that asserts only guesses is green whatever the runtime
    // does — which is how the feed came to report zero messages against a chain
    // that had them, with nothing failing anywhere.
    expect(classifyActivity('messages', 'MessageSent')).toBe('message');
    expect(classifyActivity('messaging', 'MessageSent')).toBe('message');
    expect(classifyActivity('agentMessaging', 'Anything')).toBe('message');
  });

  it('leaves everything else out of the feed', () => {
    expect(classifyActivity('emissions', 'EraSettled')).toBeNull();
    expect(classifyActivity('balances', 'Transfer')).toBeNull();
    expect(classifyActivity('system', 'ExtrinsicSuccess')).toBeNull();
    // Same method name, wrong pallet: must not match on method alone.
    expect(classifyActivity('orchestrator', 'AgentRegistered')).toBeNull();
    expect(classifyActivity('oracle', 'OracleRequestCreated')).toBeNull();
  });

  it('gives every source a kind the API accepts, and no kind without a source', () => {
    const sourceKinds = new Set(ACTIVITY_SOURCES.map((source) => source.kind));
    expect([...sourceKinds].sort()).toEqual([...ACTIVITY_KINDS].sort());
  });
});

describe('parseActivityKind', () => {
  it('accepts a known kind and absent input', () => {
    expect(parseActivityKind('slash')).toBe('slash');
    expect(parseActivityKind(undefined)).toBeUndefined();
  });

  it('rejects an unknown kind instead of answering an empty feed', () => {
    expect(() => parseActivityKind('slashes')).toThrow(/kind/);
  });

  it('narrows the sources to one kind', () => {
    expect(sourcesFor('dispute').map((source) => source.method)).toEqual(['DisputeOpened', 'DisputeResolved']);
    expect(sourcesFor(undefined)).toEqual(ACTIVITY_SOURCES);
  });
});

describe('activityItem', () => {
  it('names the kind and the agents involved, and carries the block time', () => {
    const event: EventRow & { timestampMs: number | null } = {
      id: '10-3',
      blockNumber: 10,
      index: 3,
      section: 'escrow',
      method: 'AgreementCreated',
      phase: 'ApplyExtrinsic',
      extrinsicId: '10-2',
      data: { buyer: ALICE, provider: BOB, seq: 0, amount: '10000000000000' },
      accounts: [ALICE, BOB],
      timestampMs: 1_787_000_060_000,
    };
    expect(activityItem(event)).toEqual({
      id: '10-3',
      blockNumber: 10,
      index: 3,
      extrinsicId: '10-2',
      timestampMs: 1_787_000_060_000,
      kind: 'agreement',
      section: 'escrow',
      method: 'AgreementCreated',
      agents: [ALICE, BOB],
      data: { buyer: ALICE, provider: BOB, seq: 0, amount: '10000000000000' },
    });
  });

  it('refuses an event that is not activity rather than mislabelling it', () => {
    const event = {
      id: '1-0', blockNumber: 1, index: 0, section: 'balances', method: 'Transfer', phase: 'ApplyExtrinsic',
      extrinsicId: null, data: {}, accounts: [], timestampMs: null,
    };
    expect(() => activityItem(event)).toThrow(/balances\.Transfer/);
  });
});

/** One block holding the given events, in the order given. */
function blockOf(number: number, events: Omit<EventRow, 'id' | 'blockNumber' | 'index' | 'phase' | 'extrinsicId'>[]): IndexedBlock {
  return {
    block: {
      number,
      hash: `0x${number.toString(16).padStart(64, '0')}`,
      parentHash: `0x${(number - 1).toString(16).padStart(64, '0')}`,
      stateRoot: `0x${'a'.repeat(64)}`,
      extrinsicsRoot: `0x${'b'.repeat(64)}`,
      timestampMs: 1_787_000_000_000 + number * 6_000,
      extrinsicCount: 0,
      eventCount: events.length,
    },
    extrinsics: [],
    events: events.map((event, index) => ({
      ...event,
      id: `${number}-${index}`,
      blockNumber: number,
      index,
      phase: 'ApplyExtrinsic',
      extrinsicId: null,
    })),
  };
}

describe('IndexerStore.listActivity', () => {
  let store: IndexerStore;

  beforeEach(() => {
    store = IndexerStore.open(':memory:');
    store.saveBlock(
      blockOf(1, [
        { section: 'agents', method: 'AgentRegistered', data: { who: ALICE }, accounts: [ALICE] },
        { section: 'balances', method: 'Transfer', data: { from: ALICE, to: BOB }, accounts: [ALICE, BOB] },
      ]),
    );
    store.saveBlock(
      blockOf(2, [
        { section: 'agents', method: 'HeartbeatSent', data: { who: ALICE }, accounts: [ALICE] },
        { section: 'escrow', method: 'AgreementCreated', data: { buyer: ALICE, provider: BOB }, accounts: [ALICE, BOB] },
        { section: 'emissions', method: 'EraSettled', data: { era: 1 }, accounts: [] },
        { section: 'messaging', method: 'MessageSent', data: { from: CHARLIE, to: BOB }, accounts: [CHARLIE, BOB] },
      ]),
    );
    store.saveBlock(
      blockOf(3, [
        { section: 'escrow', method: 'DisputeOpened', data: { buyer: ALICE, provider: BOB }, accounts: [ALICE, BOB] },
        { section: 'oracle', method: 'OracleResponseSubmitted', data: { agent: CHARLIE }, accounts: [CHARLIE] },
        { section: 'agents', method: 'SlashExecuted', data: { who: BOB }, accounts: [BOB] },
      ]),
    );
  });

  afterEach(() => {
    store.close();
  });

  const ids = (result: { items: { id: string }[] }) => result.items.map((item) => item.id);

  it('returns only activity events, newest first across and within blocks', () => {
    const result = store.listActivity({ limit: 25, offset: 0, sources: ACTIVITY_SOURCES });
    expect(result.total).toBe(7);
    expect(ids(result)).toEqual(['3-2', '3-1', '3-0', '2-3', '2-1', '2-0', '1-0']);
  });

  it('carries the block timestamp on each row', () => {
    const [newest] = store.listActivity({ limit: 1, offset: 0, sources: ACTIVITY_SOURCES }).items;
    expect(newest?.timestampMs).toBe(1_787_000_000_000 + 3 * 6_000);
  });

  it('filters by agent on either side of an event', () => {
    const bob = store.listActivity({ limit: 25, offset: 0, sources: ACTIVITY_SOURCES, account: BOB });
    expect(ids(bob)).toEqual(['3-2', '3-0', '2-3', '2-1']);
    expect(bob.total).toBe(4);
  });

  it('filters by kind', () => {
    const disputes = store.listActivity({ limit: 25, offset: 0, sources: sourcesFor('dispute') });
    expect(ids(disputes)).toEqual(['3-0']);
    const messages = store.listActivity({ limit: 25, offset: 0, sources: sourcesFor('message'), account: CHARLIE });
    expect(ids(messages)).toEqual(['2-3']);
  });

  it('pages without dropping or repeating a row', () => {
    const first = store.listActivity({ limit: 4, offset: 0, sources: ACTIVITY_SOURCES });
    const second = store.listActivity({ limit: 4, offset: 4, sources: ACTIVITY_SOURCES });
    expect([...ids(first), ...ids(second)]).toEqual(['3-2', '3-1', '3-0', '2-3', '2-1', '2-0', '1-0']);
    expect(second.total).toBe(7);
  });
});

describe('/v1/activity route', () => {
  it('is declared and routable', () => {
    expect(matchRoute('/v1/activity')?.route.name).toBe('activity.list');
    expect(ROUTES.filter((route) => route.path === '/v1/activity')).toHaveLength(1);
  });
});
