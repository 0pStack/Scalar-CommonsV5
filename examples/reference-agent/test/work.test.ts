import { describe, expect, it } from 'vitest';
import { selectWork, selectToConfirm, type AgreementView } from '../src/work.js';

const ME = '5Me';
const agr = (over: Partial<AgreementView> = {}): AgreementView => ({
  buyer: '5Buyer',
  provider: ME,
  seq: 0,
  amount: 10n * 10n ** 12n,
  deliverableHash: '0x' + '11'.repeat(32),
  deliverBy: 1_000,
  createdAt: 100,
  status: 'Created',
  deliveryProof: null,
  capabilityId: null,
  ...over,
});
const opts = { me: ME, now: 200, minDeliveryBlocks: 10, capabilities: [7], acceptUncategorised: true };

describe('selectWork', () => {
  it('picks a Created agreement addressed to me once MinDeliveryBlocks has elapsed', () => {
    const { deliver, skipped } = selectWork([agr()], opts);
    expect(deliver).toHaveLength(1);
    expect(skipped).toHaveLength(0);
  });

  it('ignores agreements addressed to someone else without reporting them', () => {
    const { deliver, skipped } = selectWork([agr({ provider: '5Other' })], opts);
    expect(deliver).toHaveLength(0);
    expect(skipped).toHaveLength(0);
  });

  it('waits, rather than submitting, until MinDeliveryBlocks has elapsed', () => {
    // Submitting early fails with escrow.MinDeliveryBlocksNotElapsed and costs a fee (#160).
    const { deliver, skipped } = selectWork([agr({ createdAt: 195 })], opts);
    expect(deliver).toHaveLength(0);
    expect(skipped[0]?.reason).toMatch(/MinDeliveryBlocks/);
  });

  it('does not try to deliver past the deadline', () => {
    const { deliver, skipped } = selectWork([agr({ deliverBy: 150 })], opts);
    expect(deliver).toHaveLength(0);
    expect(skipped[0]?.reason).toMatch(/deadline/);
  });

  it('only accepts capability-tagged work it has published', () => {
    expect(selectWork([agr({ capabilityId: 7 })], opts).deliver).toHaveLength(1);
    const other = selectWork([agr({ capabilityId: 8 })], opts);
    expect(other.deliver).toHaveLength(0);
    expect(other.skipped[0]?.reason).toMatch(/capability 8/);
  });

  it('honours acceptUncategorised=false for agreements with no capability', () => {
    const r = selectWork([agr()], { ...opts, acceptUncategorised: false });
    expect(r.deliver).toHaveLength(0);
    expect(r.skipped[0]?.reason).toMatch(/uncategorised/);
  });

  it('never re-delivers Delivered or Disputed agreements', () => {
    expect(selectWork([agr({ status: 'Delivered' }), agr({ status: 'Disputed' })], opts).deliver).toHaveLength(0);
  });
});

describe('selectToConfirm', () => {
  it('returns Delivered agreements where I am the buyer', () => {
    const mine = agr({ buyer: ME, provider: '5P', status: 'Delivered', deliveryProof: '0x' + '22'.repeat(32) });
    expect(selectToConfirm([mine, agr({ status: 'Delivered' }), agr({ buyer: ME, provider: '5P' })], ME)).toEqual([mine]);
  });
});
