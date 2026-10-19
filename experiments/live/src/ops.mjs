/**
 * The chain operations every archetype is built out of.
 *
 * Each one submits a real extrinsic and reports what the chain did with it.
 * Nothing here simulates, retries silently, or works around a refusal — a
 * refusal is the measurement.
 */

import { submit, hash32, head, waitForBlock } from './chain.mjs';
import { recordExtrinsic, recordFailure } from './ledger.mjs';

/** Register `who` as an agent with `stake`, then heartbeat. */
export async function registerAgent(api, ledger, who, stakePlancks, log) {
  const r = await submit(api, api.tx.agents.register(stakePlancks), who);
  recordExtrinsic(ledger);
  if (!r.ok) {
    recordFailure(ledger, 'register', r.error);
    log(`    register ${short(who.address)} REFUSED: ${r.error}`);
    return false;
  }
  log(`    register ${short(who.address)} ok`);
  // The weight formula gates the floor share on heartbeat_multiplier >= 90, so
  // an agent that never heartbeats earns nothing from the floor no matter how
  // much volume it books. Every archetype heartbeats; the differences between
  // them must come from strategy, not from one forgetting to check in.
  const h = await submit(api, api.tx.agents.heartbeat(), who);
  recordExtrinsic(ledger);
  if (!h.ok) {
    recordFailure(ledger, 'heartbeat', h.error);
    log(`    heartbeat ${short(who.address)} REFUSED: ${h.error}`);
  }
  return true;
}

export function short(addr) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * One complete escrow: buyer creates, provider delivers, buyer confirms.
 *
 * Volume is credited to the PROVIDER on confirm_delivery, along with a buyer
 * diversity mark. The 10-block wait is not politeness — `record_delivery`
 * enforces `now >= created_at + MinDeliveryBlocks`, so it is the chain's own
 * floor on how fast a ring can cycle, and any wash strategy has to pay it in
 * wall-clock time.
 */
export async function escrowRoundTrip(api, ledger, buyer, provider, amountPlancks, tag, log) {
  const now = await head(api);
  const minDelivery = api.consts.escrow.minDeliveryBlocks.toNumber();
  const deliverBy = now + Math.max(minDelivery * 4, 200);

  const seq = (await api.query.escrow.nextSeq(buyer.address, provider.address)).toNumber();

  const c = await submit(
    api,
    api.tx.escrow.createAgreement(provider.address, amountPlancks, hash32(`${tag}:deliverable`), deliverBy, null),
    buyer,
  );
  recordExtrinsic(ledger);
  if (!c.ok) {
    recordFailure(ledger, 'createAgreement', c.error);
    log(`    escrow ${tag} create REFUSED: ${c.error}`);
    return false;
  }
  const createdAt = await head(api);

  // The chain will not accept a delivery before this block. Waiting is part of
  // the strategy's real cost.
  await waitForBlock(api, createdAt + minDelivery + 1);

  const d = await submit(
    api,
    api.tx.escrow.recordDelivery(buyer.address, seq, hash32(`${tag}:delivery`)),
    provider,
  );
  recordExtrinsic(ledger);
  if (!d.ok) {
    recordFailure(ledger, 'recordDelivery', d.error);
    log(`    escrow ${tag} deliver REFUSED: ${d.error}`);
    return false;
  }

  const f = await submit(api, api.tx.escrow.confirmDelivery(provider.address, seq), buyer);
  recordExtrinsic(ledger);
  if (!f.ok) {
    recordFailure(ledger, 'confirmDelivery', f.error);
    log(`    escrow ${tag} confirm REFUSED: ${f.error}`);
    return false;
  }
  log(`    escrow ${tag} settled (seq ${seq})`);
  return true;
}

/** Claim emissions; a NothingToClaim refusal is an expected, informative outcome. */
export async function claimEmissions(api, ledger, who, log) {
  const r = await submit(api, api.tx.emissions.claim(), who);
  recordExtrinsic(ledger);
  if (!r.ok) {
    recordFailure(ledger, 'claim', r.error);
    log(`    claim ${short(who.address)}: ${r.error}`);
    return false;
  }
  const paid = r.events.some((e) => e === 'emissions.RewardClaimed');
  log(`    claim ${short(who.address)}: ${paid ? 'RewardClaimed' : 'no reward event'}`);
  return paid;
}
