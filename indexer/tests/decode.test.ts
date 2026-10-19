import { describe, it, expect } from 'vitest';

import { extrinsicId, eventId, accountsFromArgs, jsonSafe, type DecodedArg } from '../src/decode.ts';

/**
 * These helpers sit between SCALE-decoded chain data and the REST surface.
 * Two properties matter and are pinned here:
 *
 *  - IDs are stable and sortable, because they are the primary keys clients
 *    page through and the join key between an extrinsic and its events.
 *  - `u128` balances survive the trip. A single agent stake (10_000 CMN =
 *    10^16 plancks) already exceeds `Number.MAX_SAFE_INTEGER`, so any float in
 *    the serialisation path silently corrupts the economic numbers this API
 *    exists to report.
 */

describe('identifiers', () => {
  it('composes block-scoped ids that sort in chain order', () => {
    expect(extrinsicId(7, 2)).toBe('7-2');
    expect(eventId(7, 2)).toBe('7-2');
  });

  it('rejects negative or fractional coordinates', () => {
    expect(() => extrinsicId(-1, 0)).toThrow();
    expect(() => eventId(1, 1.5)).toThrow();
  });
});

describe('accountsFromArgs', () => {
  const alice = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
  const bob = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

  it('picks up a plain AccountId32 argument', () => {
    const args: DecodedArg[] = [
      { name: 'who', type: 'AccountId32', value: alice },
      { name: 'stake', type: 'u128', value: '10000000000000000' },
    ];
    expect(accountsFromArgs(args)).toEqual([alice]);
  });

  it('picks up every account in a multi-account event', () => {
    // escrow.AgreementCreated { buyer, provider, seq, amount }
    const args: DecodedArg[] = [
      { name: 'buyer', type: 'AccountId32', value: alice },
      { name: 'provider', type: 'AccountId32', value: bob },
      { name: 'seq', type: 'u32', value: 0 },
      { name: 'amount', type: 'u128', value: '10000000000000' },
    ];
    expect(accountsFromArgs(args)).toEqual([alice, bob]);
  });

  it('descends into collections of accounts', () => {
    const args: DecodedArg[] = [{ name: 'agents', type: 'Vec<AccountId32>', value: [alice, bob] }];
    expect(accountsFromArgs(args)).toEqual([alice, bob]);
  });

  it('de-duplicates repeats within one event', () => {
    const args: DecodedArg[] = [
      { name: 'from', type: 'AccountId32', value: alice },
      { name: 'to', type: 'AccountId32', value: alice },
    ];
    expect(accountsFromArgs(args)).toEqual([alice]);
  });

  it('follows an optional account', () => {
    const args: DecodedArg[] = [{ name: 'maybe', type: 'Option<AccountId32>', value: alice }];
    expect(accountsFromArgs(args)).toEqual([alice]);
  });

  it('follows a bounded collection of accounts', () => {
    const args: DecodedArg[] = [
      { name: 'members', type: 'BoundedVec<AccountId32,S>', value: [alice, bob] },
    ];
    expect(accountsFromArgs(args)).toEqual([alice, bob]);
  });

  it('does not harvest the hash out of a tuple that also carries an account', () => {
    // A composite type is not an account type. Walking into one indexes the
    // 32-byte question hash beside the address as though it were an account,
    // which is exactly what pollutes `/v1/events?account=`. Only a leaf typed
    // `AccountId*` — or a homogeneous collection of them — is followed.
    const args: DecodedArg[] = [
      { name: 'pair', type: '(AccountId32,H256)', value: [alice, `0x${'ab'.repeat(32)}`] },
    ];
    expect(accountsFromArgs(args)).toEqual([]);
  });

  it('does not harvest the hash out of a struct that also carries an account', () => {
    const args: DecodedArg[] = [
      {
        name: 'request',
        type: '{"asker":"AccountId32","questionHash":"H256"}',
        value: { asker: alice, questionHash: `0x${'cd'.repeat(32)}` },
      },
    ];
    expect(accountsFromArgs(args)).toEqual([]);
  });

  it('ignores hashes and numbers that are not accounts', () => {
    // oracle.OracleRequestFinalised { id, winning_hash, respondents_paid }
    const args: DecodedArg[] = [
      { name: 'id', type: '[u8;32]', value: '0xdeadbeef' },
      { name: 'winning_hash', type: '[u8;32]', value: '0xfeedface' },
      { name: 'respondents_paid', type: 'u32', value: 3 },
    ];
    expect(accountsFromArgs(args)).toEqual([]);
  });
});

describe('jsonSafe', () => {
  it('renders u128-scale integers as strings without loss', () => {
    // 100B CMN supply cap in plancks — the largest number this chain can express.
    const cap = 100_000_000_000n * 10n ** 12n;
    expect(jsonSafe(cap)).toBe('100000000000000000000000');
    expect(BigInt(jsonSafe(cap) as string)).toBe(cap);
  });

  it('converts bigints nested in structures', () => {
    const out = jsonSafe({ amount: 10n ** 16n, inner: [1n, { deep: 2n }] });
    expect(out).toEqual({ amount: '10000000000000000', inner: ['1', { deep: '2' }] });
    expect(JSON.stringify(out)).toContain('"10000000000000000"');
  });

  it('leaves plain JSON values untouched', () => {
    expect(jsonSafe({ a: 1, b: 'x', c: null, d: true })).toEqual({ a: 1, b: 'x', c: null, d: true });
  });
});
