import { decodeAddress } from '@polkadot/util-crypto';
import { describe, it, expect } from 'vitest';

import { collectAccounts } from '../src/accounts.js';
import { ALICE, BOB, registry } from './registry.js';
import { SS58_PREFIX } from '@scalar-commons/sdk';

/**
 * Recognising accounts structurally.
 *
 * An account is whatever the registry decoded as an `AccountId`, asked through
 * `toRawType()` rather than by class identity: a second installed copy of
 * `@polkadot/types` has its own `GenericAccountId` class, and `instanceof`
 * against the wrong one is false for every account — an empty accounts list
 * instead of an error.
 */

describe('collectAccounts', () => {
  it('finds an AccountId decoded from metadata', () => {
    expect(collectAccounts([registry.createType('AccountId32', ALICE)], SS58_PREFIX)).toEqual([
      ALICE,
    ]);
  });

  it('finds the account inside a MultiAddress::Id', () => {
    const address = registry.createType('MultiAddress', { Id: BOB });
    expect(collectAccounts([address], SS58_PREFIX)).toEqual([BOB]);
  });

  it('does not take a 32-byte hash for an account', () => {
    const hash = registry.createType('H256', decodeAddress(ALICE));
    expect(collectAccounts([hash], SS58_PREFIX)).toEqual([]);
  });

  it('finds an AccountId from another copy of @polkadot/types', () => {
    // What a duplicate install hands over: the same raw type and bytes, but a
    // class that is not this copy's GenericAccountId.
    const bytes = decodeAddress(ALICE);
    const foreign = Object.assign(new Uint8Array(bytes), {
      toRawType: () => 'AccountId',
      toU8a: () => bytes,
    });
    expect(collectAccounts([foreign], SS58_PREFIX)).toEqual([ALICE]);
  });
});
