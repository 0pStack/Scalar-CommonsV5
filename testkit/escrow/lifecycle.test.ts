// Escrow lifecycle against a live node (default dev-real). Asserts on chain events and
// storage/balances read back from the ledger, not on the submit call succeeding.
import { afterAll, beforeAll, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import type { ApiPromise } from '@polkadot/api';
import type { KeyringPair } from '@polkadot/keyring/types';
import { cmn, connect, findEvent, freshPair, fund, send, waitForBlock } from './helpers';

const HASH = '0x' + '11'.repeat(32);
const PROOF = '0x' + '22'.repeat(32);

describe('escrow lifecycle', () => {
  let api: ApiPromise;
  let buyer: KeyringPair;
  let provider: KeyringPair;

  const free = async (a: KeyringPair) =>
    ((await api.query.system.account(a.address)) as any).data.free.toBigInt() as bigint;
  const reserved = async (a: KeyringPair) =>
    ((await api.query.system.account(a.address)) as any).data.reserved.toBigInt() as bigint;
  const agreements = async () =>
    (await api.query.escrow.agreements(buyer.address, provider.address)) as any;

  beforeAll(async () => {
    api = await connect();
    buyer = await freshPair();
    provider = await freshPair();
    // Registration needs MinStake + fee; 20_000 CMN each covers it with headroom.
    for (const p of [buyer, provider]) await fund(api, p, cmn(20_000));
    const minStake = (api.consts.agents.minStake as any).toBigInt() as bigint;
    for (const p of [buyer, provider]) await send(api, api.tx.agents.register(minStake), p);
  });
  afterAll(async () => {
    await api.disconnect();
  });

  it('rejects a self-deal and leaves no agreement or reserve (E19)', async () => {
    const before = await reserved(buyer);
    const now = (await api.rpc.chain.getHeader()).number.toNumber();
    await assert.rejects(
      send(api, api.tx.escrow.createAgreement(buyer.address, cmn(10), HASH, now + 100, null), buyer),
      /escrow\.SelfDeal/,
    );
    assert.equal((await api.query.escrow.agreements(buyer.address, buyer.address) as any).length, 0);
    assert.equal(await reserved(buyer), before);
  });

  it('refuses early delivery, then create → deliver → confirm settles the ledger', async () => {
    const amount = cmn(500);
    const now = (await api.rpc.chain.getHeader()).number.toNumber();
    const minDelivery = (api.consts.escrow.minDeliveryBlocks as any).toNumber() as number;
    const reservedBefore = await reserved(buyer);
    const providerFreeBefore = await free(provider);

    const created = await send(
      api,
      api.tx.escrow.createAgreement(provider.address, amount, HASH, now + minDelivery + 200, null),
      buyer,
    );
    assert.ok(findEvent(created, 'escrow', 'AgreementCreated'), 'AgreementCreated emitted');
    assert.equal(await reserved(buyer), reservedBefore + amount);
    const list = await agreements();
    assert.equal(list.length, 1);
    const seq = list[0].seq.toNumber();
    const createdAt = list[0].createdAt.toNumber();

    // E18 (runtime 309): the provider must consent before it can deliver.
    //
    // PROBED, not assumed, because this testkit runs against several runtimes —
    // the rehearsal gate points it at a node built from the PR under review,
    // while other runs target 307, where this call does not exist. Probing is
    // the same pattern `agent/` uses.
    //
    // It sits BEFORE the MinDeliveryBlocks assertion on purpose. `record_delivery`
    // checks consent before timing (DESIGN-E18-E2 §4.2, "consent before
    // eligibility"), so without an accept first the next assertion gets
    // `escrow.NotAccepted` instead of `escrow.MinDeliveryBlocksNotElapsed` —
    // which is exactly how this test failed the rehearsal gate on PR #233.
    if (api.tx.escrow.acceptAgreement) {
      const accepted = await send(api, api.tx.escrow.acceptAgreement(buyer.address, seq), provider);
      assert.ok(findEvent(accepted, 'escrow', 'AgreementAccepted'), 'AgreementAccepted emitted');
    }

    // MinDeliveryBlocks: delivery in the creation block window is refused with the pallet error.
    if (created.blockNumber < createdAt + minDelivery) {
      await assert.rejects(
        send(api, api.tx.escrow.recordDelivery(buyer.address, seq, PROOF), provider),
        /escrow\.MinDeliveryBlocksNotElapsed/,
      );
    }
    await waitForBlock(api, createdAt + minDelivery);

    const delivered = await send(api, api.tx.escrow.recordDelivery(buyer.address, seq, PROOF), provider);
    assert.ok(findEvent(delivered, 'escrow', 'DeliveryRecorded'));
    assert.equal((await agreements())[0].status.toString(), 'Delivered');

    const confirmed = await send(api, api.tx.escrow.confirmDelivery(provider.address, seq), buyer);
    assert.ok(findEvent(confirmed, 'escrow', 'DeliveryConfirmed'));
    assert.equal((await agreements()).length, 0);
    assert.equal(await reserved(buyer), reservedBefore);

    // Provider receives the amount minus the 25 bps completion fee, which the pallet routes to
    // Treasury (E6). `CompletionFeeProvider` is not a metadata constant, so 25 bps is fixed here.
    // The provider also paid the recordDelivery tx fee; that is far smaller than the 0.5 CMN slack,
    // while the fee itself (1.25 CMN on 500 CMN) is larger, so a missing fee would fail the upper bound.
    const net = amount - (amount * 25n) / 10_000n;
    const gained = (await free(provider)) - providerFreeBefore;
    assert.ok(gained <= net, `provider gained ${gained}, expected at most ${net}`);
    assert.ok(gained >= net - cmn(1) / 2n, `provider gained ${gained}, expected about ${net}`);
  }, 240_000); // waits on real block production (MinDeliveryBlocks)
});
