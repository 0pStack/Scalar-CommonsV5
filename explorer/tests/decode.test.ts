import { describe, it, expect } from 'vitest';

import { decodeExtrinsics, eventView, outcomeOf } from '../src/decode.js';
import {
  ALICE,
  BOB,
  eventRecord,
  moduleError,
  registry,
  signedTransfer,
  success,
  transfer,
} from './registry.js';
import { SS58_PREFIX } from '@scalar-commons/sdk';

/**
 * The explorer's decode and outcome logic, against real metadata and no node.
 *
 * Every shape asserted here comes out of the metadata, so a regression in how
 * the explorer reads it — a field named by position instead of by name, a
 * module error left as raw indices — shows up without a chain to point at.
 */

describe('outcomeOf', () => {
  it('reads ExtrinsicSuccess as success', () => {
    expect(outcomeOf(registry, [success(0)])).toEqual({ kind: 'success' });
  });

  it('resolves a module error to its pallet and name through the metadata', () => {
    const failed = eventRecord({ ApplyExtrinsic: 0 }, 'System', 'ExtrinsicFailed', [
      moduleError('Balances', 'InsufficientBalance'),
      {},
    ]);
    expect(outcomeOf(registry, [failed])).toEqual({
      kind: 'failed',
      reason: 'balances.InsufficientBalance',
    });
  });

  it('names a non-module dispatch error by its variant', () => {
    const failed = eventRecord({ ApplyExtrinsic: 0 }, 'System', 'ExtrinsicFailed', [
      'BadOrigin',
      {},
    ]);
    expect(outcomeOf(registry, [failed])).toEqual({ kind: 'failed', reason: 'BadOrigin' });
  });

  it('ignores events from other pallets when looking for the outcome', () => {
    const transferred = eventRecord({ ApplyExtrinsic: 0 }, 'Balances', 'Transfer', [ALICE, BOB, 1]);
    expect(outcomeOf(registry, [transferred, success(0)])).toEqual({ kind: 'success' });
  });

  it('says the outcome is unknown, not success, when no system event was recorded', () => {
    expect(outcomeOf(registry, [])).toEqual({ kind: 'unknown' });
  });
});

describe('eventView', () => {
  it('names fields from the metadata and keeps the given event index', () => {
    const record = eventRecord({ ApplyExtrinsic: 0 }, 'Balances', 'Transfer', [ALICE, BOB, 1000]);
    expect(eventView(record, 7)).toEqual({
      index: 7,
      section: 'balances',
      method: 'Transfer',
      fields: [
        { name: 'from', value: ALICE },
        { name: 'to', value: BOB },
        { name: 'amount', value: '1,000' },
      ],
    });
  });

  it('falls back to the position for an unnamed tuple field', () => {
    const record = eventRecord({ ApplyExtrinsic: 0 }, 'ConvictionVoting', 'Undelegated', [ALICE]);
    expect(eventView(record, 0).fields).toEqual([{ name: '0', value: ALICE }]);
  });
});

describe('decodeExtrinsics', () => {
  const records = [
    eventRecord('Initialization', 'Balances', 'Transfer', [BOB, ALICE, 9]),
    success(0),
    eventRecord({ ApplyExtrinsic: 1 }, 'Balances', 'Transfer', [ALICE, BOB, 1000]),
    success(1),
    eventRecord('Finalization', 'Balances', 'Transfer', [BOB, ALICE, 9]),
  ];
  const [unsigned, signed] = decodeExtrinsics(
    registry,
    [transfer(5n), signedTransfer(1000n, 7, 3)],
    records,
    SS58_PREFIX,
  );

  it('decodes one entry per extrinsic, in block order', () => {
    expect(unsigned?.index).toBe(0);
    expect(signed?.index).toBe(1);
    expect(signed?.section).toBe('balances');
    expect(signed?.method).toBe('transferKeepAlive');
  });

  it('names and types call arguments from the metadata', () => {
    // polkadot-js sanitises the declared type names (`T::Balance` → `Balance`).
    expect(signed?.args.map(({ name, type }) => ({ name, type }))).toEqual([
      { name: 'dest', type: 'AccountIdLookupOf' },
      { name: 'value', type: 'Balance' },
    ]);
  });

  it('gives each extrinsic only its own events, numbered by their position in the block', () => {
    expect(unsigned?.events.map((event) => [event.index, event.method])).toEqual([
      [1, 'ExtrinsicSuccess'],
    ]);
    expect(signed?.events.map((event) => [event.index, event.method])).toEqual([
      [2, 'Transfer'],
      [3, 'ExtrinsicSuccess'],
    ]);
  });

  it('reads each extrinsic outcome from its own events', () => {
    expect(unsigned?.outcome).toEqual({ kind: 'success' });
    expect(signed?.outcome).toEqual({ kind: 'success' });
  });

  it('reports the signer, nonce and tip of a signed extrinsic and none for an unsigned one', () => {
    expect(signed).toMatchObject({ isSigned: true, signer: ALICE, nonce: 7, tip: 3n });
    expect(unsigned).toMatchObject({ isSigned: false, signer: null, nonce: null, tip: null });
  });

  it('lists the accounts touched, signer first and de-duplicated', () => {
    expect(signed?.accounts).toEqual([ALICE, BOB]);
    // The unsigned transfer names BOB; the hook-phase events naming ALICE are not its own.
    expect(unsigned?.accounts).toEqual([BOB]);
  });

  it('reads an extrinsic with no events as an unknown outcome', () => {
    const [lonely] = decodeExtrinsics(registry, [transfer(1n)], [], SS58_PREFIX);
    expect(lonely?.events).toEqual([]);
    expect(lonely?.outcome).toEqual({ kind: 'unknown' });
  });
});
