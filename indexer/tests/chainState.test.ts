import { describe, it, expect } from 'vitest';

import { compareByStakeDescending, toAgreement } from '../src/chainState.ts';

/**
 * The two rules in `chainState` a live chain cannot pin down: what happens when
 * the runtime reports an agreement status this build has never heard of, and
 * whether the agent ordering is an ordering at all.
 *
 * A new `AgreementStatus` variant is a runtime change, so no devnet can produce
 * one today — but the day one does, the indexer must say so. Counting it into a
 * status split it was never seeded with yields `undefined + 1 = NaN`, which
 * `JSON.stringify` renders as `null`, and the agreement simply disappears from
 * the split with no error anywhere. For a package whose contract is that every
 * answer comes from the chain, a silent miscount is the wrong failure mode.
 *
 * Ordering is the harder one to catch live: the devnet's agents all hold
 * identical stake, so even an inconsistent comparator happens to come back in a
 * plausible order. The defect is in the function, so that is where it is caught.
 *
 * The rest of `chainState` is covered end-to-end in `live.test.ts` against a
 * real node — nothing here stands in for chain data.
 */

const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const BOB = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

/** A decoded `Agreement` as polkadot-js hands it over, with `status` swapped. */
function rawAgreement(statusVariant: string): Record<string, any> {
  const none = { isSome: false, unwrap: () => undefined };
  return {
    seq: '3',
    amount: '10000000000000',
    deliverableHash: { toHex: () => `0x${'11'.repeat(32)}` },
    deliverBy: '2000',
    createdAt: '1000',
    status: { type: statusVariant },
    deliveryProof: none,
    capabilityId: none,
    disputeOpenedAt: none,
    disputeRequestId: none,
  };
}

describe('toAgreement', () => {
  it('decodes the statuses this runtime defines', () => {
    for (const status of ['Created', 'Delivered', 'Disputed'] as const) {
      expect(toAgreement(ALICE, BOB, rawAgreement(status)).status).toBe(status);
    }
  });

  it('keeps the amount as an exact decimal string', () => {
    expect(toAgreement(ALICE, BOB, rawAgreement('Created')).amountPlancks).toBe('10000000000000');
  });

  it('throws on a status variant it does not know', () => {
    expect(() => toAgreement(ALICE, BOB, rawAgreement('Refunded'))).toThrow(/Refunded/);
    expect(() => toAgreement(ALICE, BOB, rawAgreement('Refunded'))).toThrow(/escrow/i);
  });
});

describe('compareByStakeDescending', () => {
  const agent = (address: string, stakePlancks: string) => ({ address, stakePlancks });

  it('puts the larger stake first', () => {
    expect(compareByStakeDescending(agent(ALICE, '1'), agent(BOB, '2'))).toBeGreaterThan(0);
    expect(compareByStakeDescending(agent(ALICE, '2'), agent(BOB, '1'))).toBeLessThan(0);
  });

  it('is consistent for equal stakes', () => {
    // A comparator that answers -1 both ways round is not an ordering: it says
    // `a` before `b` and `b` before `a`, so the list can come back differently
    // from one identical request to the next. Genesis agents all hold the same
    // stake, so this is the ordinary case, not the edge one.
    const a = agent(ALICE, '10000000000000000');
    const b = agent(BOB, '10000000000000000');
    expect(compareByStakeDescending(a, b)).toBe(-compareByStakeDescending(b, a));
    expect(compareByStakeDescending(a, a)).toBe(0);
  });

  it('compares stakes past Number.MAX_SAFE_INTEGER exactly', () => {
    const big = agent(ALICE, '10000000000000000000000001');
    const bigger = agent(BOB, '10000000000000000000000002');
    expect(compareByStakeDescending(big, bigger)).toBeGreaterThan(0);
  });
});
