import { describe, it, expect } from 'vitest';

import { TypeRegistry } from '@polkadot/types';

import { plain } from '../src/ingest.ts';

/**
 * `plain` is the whole translation from SCALE-decoded chain values to the JSON
 * the API serves, so its rules are pinned against real codecs built from the
 * same type registry the node's metadata drives.
 *
 * Two rules matter most:
 *  - Wide integers leave as decimal strings. Stakes, emissions and the supply
 *    cap all exceed `Number.MAX_SAFE_INTEGER`.
 *  - An enum is not an `Option`. polkadot-js reports `isNone === true` for a
 *    plain enum variant whose payload is `Null`, so treating that flag as
 *    "absent" silently erases real data — `paysFee: "Yes"` became `null`.
 */

const registry = new TypeRegistry();
const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

describe('plain — integers', () => {
  it('renders u128 as an exact decimal string', () => {
    const stake = registry.createType('u128', '10000000000000000');
    expect(plain(stake)).toBe('10000000000000000');

    const cap = registry.createType('u128', (100_000_000_000n * 10n ** 12n).toString());
    expect(plain(cap)).toBe('100000000000000000000000');
    expect(BigInt(plain(cap) as string)).toBe(100_000_000_000n * 10n ** 12n);
  });

  it('renders u64 as a string too, since it can exceed 2^53', () => {
    expect(plain(registry.createType('u64', '18446744073709551615'))).toBe('18446744073709551615');
  });

  it('keeps narrow integers as numbers', () => {
    expect(plain(registry.createType('u32', 7))).toBe(7);
    expect(plain(registry.createType('u32', 218_399))).toBe(218_399);
  });
});

describe('plain — enums and options', () => {
  it('keeps a plain enum variant, which reports isNone as true', () => {
    // `FrameSupportDispatchPays` is exactly this shape, and it appears on every
    // ExtrinsicSuccess event the indexer ingests.
    const paysFee = registry.createType('{"_enum":["Yes","No"]}', 0);
    expect(paysFee.isNone).toBe(true); // the trap this test exists for
    expect(plain(paysFee)).toBe('Yes');

    const dispatchClass = registry.createType('{"_enum":["Normal","Operational","Mandatory"]}', 2);
    expect(plain(dispatchClass)).toBe('Mandatory');
  });

  it('unwraps a real Option', () => {
    expect(plain(registry.createType('Option<u32>', 7))).toBe(7);
    expect(plain(registry.createType('Option<u128>', '10000000000000'))).toBe('10000000000000');
  });

  it('renders an absent Option as null', () => {
    expect(plain(registry.createType('Option<u128>', null))).toBeNull();
    expect(plain(registry.createType('Option<AccountId32>', null))).toBeNull();
  });
});

describe('plain — addresses, hashes and structures', () => {
  it('renders an account as SS58, not hex', () => {
    expect(plain(registry.createType('AccountId32', ALICE))).toBe(ALICE);
  });

  it('renders a fixed byte array as hex', () => {
    const hash = registry.createType('[u8;32]', `0x${'11'.repeat(32)}`);
    expect(plain(hash)).toBe(`0x${'11'.repeat(32)}`);
  });

  it('recurses into a struct so nested balances keep the string rule', () => {
    const struct = registry.createType('{"amount":"u128","seq":"u32"}', {
      amount: '10000000000000',
      seq: 3,
    });
    expect(plain(struct)).toEqual({ amount: '10000000000000', seq: 3 });
  });

  it('recurses into a vector of accounts', () => {
    const vec = registry.createType('Vec<AccountId32>', [ALICE]);
    expect(plain(vec)).toEqual([ALICE]);
  });

  it('renders booleans as booleans', () => {
    expect(plain(registry.createType('bool', true))).toBe(true);
    expect(plain(registry.createType('bool', false))).toBe(false);
  });
});
