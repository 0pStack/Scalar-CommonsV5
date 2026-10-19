/**
 * Net accounting.
 *
 * net = (free + claimable) - funded, summed over the archetype's accounts.
 * The cases below pin the two properties that make that number trustworthy:
 * bonded stake counts as a cost until it comes back, and a refused extrinsic is
 * recorded rather than swallowed.
 */
import { describe, expect, it } from 'vitest';
import { newLedger, recordFunding, recordExtrinsic, recordFailure, note, settle } from '../src/ledger.mjs';
import { cmnToPlancks } from '../src/units.mjs';

const CMN = cmnToPlancks;

describe('ledger', () => {
  it('nets to zero when nothing was spent', () => {
    const l = recordFunding(newLedger('x'), 'addr1', CMN(3000));
    const r = settle(l, [{ spendablePlancks: CMN(3000) }]);
    expect(r.netPlancks).toBe(0n);
  });

  it('reports a loss when fees were paid', () => {
    const l = recordFunding(newLedger('x'), 'addr1', CMN(3000));
    const r = settle(l, [{ spendablePlancks: CMN('2949.99') }]);
    expect(r.netPlancks).toBe(CMN('-50.01'));
  });

  it('counts bonded stake as a COST — this is the one that matters', () => {
    // 3000 funded, 1000 LOCKED in stake, 50 registration fee.
    //
    // pallet-agents locks stake with set_lock rather than reserving it, so the
    // chain reports free = 2950 and frozen = 1000 — measured on a live wash
    // account: free 2949.6995, frozen 1000.0000, reserved 0.0000. The caller
    // must pass SPENDABLE (free - frozen). Feeding this `free` reports the
    // strategy at -50 instead of -1050 and makes ring farming look nearly free,
    // which is what the first version of this runner actually did.
    const l = recordFunding(newLedger('x'), 'addr1', CMN(3000));
    const r = settle(l, [{ spendablePlancks: CMN(1950), frozenPlancks: CMN(1000) }]);
    expect(r.netPlancks).toBe(CMN(-1050));
    expect(r.frozenPlancks).toBe(CMN(1000));
  });

  it('reports escrow-reserved funds separately, neither credited nor charged twice', () => {
    const l = recordFunding(newLedger('x'), 'addr1', CMN(3000));
    const r = settle(l, [{ spendablePlancks: CMN(1900), frozenPlancks: CMN(1000), reservedPlancks: CMN(50) }]);
    expect(r.reservedPlancks).toBe(CMN(50));
    expect(r.netPlancks).toBe(CMN(-1100));
  });

  it('credits claimable emissions that have not been withdrawn yet', () => {
    const l = recordFunding(newLedger('x'), 'addr1', CMN(3000));
    const r = settle(l, [{ spendablePlancks: CMN(1950), claimablePlancks: CMN(2000) }]);
    expect(r.netPlancks).toBe(CMN(950));
  });

  it('sums across every account the archetype controls', () => {
    let l = newLedger('ring');
    for (const a of ['a', 'b', 'c']) l = recordFunding(l, a, CMN(3000));
    expect(l.fundedPlancks).toBe(CMN(9000));
    const r = settle(l, [{ spendablePlancks: CMN(1000) }, { spendablePlancks: CMN(1000) }, { spendablePlancks: CMN(1000) }]);
    expect(r.netPlancks).toBe(CMN(-6000));
  });

  it('keeps refusals as data instead of swallowing them', () => {
    const l = recordFailure(newLedger('x'), 'confirmDelivery', 'escrow.NotAgent');
    expect(l.failures).toEqual([{ step: 'confirmDelivery', message: 'escrow.NotAgent' }]);
  });

  it('counts extrinsics and notes', () => {
    let l = newLedger('x');
    recordExtrinsic(l); recordExtrinsic(l); note(l, 'hello');
    expect(l.extrinsics).toBe(2);
    expect(l.notes).toEqual(['hello']);
  });
});
