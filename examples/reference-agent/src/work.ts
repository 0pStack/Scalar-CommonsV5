/**
 * Pure selection logic: which escrow agreements should this agent act on?
 *
 * Kept free of any chain I/O so it can be tested exhaustively. Every rule
 * here mirrors a runtime guard in pallets/escrow/src/lib.rs — the point is to
 * never submit an extrinsic the runtime will reject, because a rejected
 * extrinsic still pays its fee.
 */

export type AgreementStatus = 'Created' | 'Delivered' | 'Disputed';

/** An `escrow.agreements(buyer, provider)` entry, flattened with its two keys. */
export interface AgreementView {
  buyer: string;
  provider: string;
  seq: number;
  amount: bigint;
  deliverableHash: string;
  deliverBy: number;
  createdAt: number;
  status: AgreementStatus;
  deliveryProof: string | null;
  capabilityId: number | null;
}

export interface SelectOptions {
  me: string;
  now: number;
  /** `escrow.minDeliveryBlocks` read from the chain's constants. */
  minDeliveryBlocks: number;
  capabilities: number[];
  acceptUncategorised: boolean;
}

export interface Skipped {
  agreement: AgreementView;
  reason: string;
}

/**
 * Agreements addressed to `me` that can be delivered at block `now`.
 *
 * Skipped agreements are returned with a reason so the daemon can log them
 * once; agreements addressed to other providers are not our business and are
 * dropped silently.
 */
export function selectWork(all: AgreementView[], o: SelectOptions): { deliver: AgreementView[]; skipped: Skipped[] } {
  const deliver: AgreementView[] = [];
  const skipped: Skipped[] = [];
  for (const a of all) {
    if (a.provider !== o.me) continue;
    if (a.status !== 'Created') continue;
    // escrow::record_delivery: ensure!(now <= a.deliver_by, DeadlinePassed)
    if (o.now > a.deliverBy) {
      skipped.push({ agreement: a, reason: `deadline #${a.deliverBy} passed; the buyer can claimRefund` });
      continue;
    }
    // escrow::record_delivery: ensure!(now >= created_at + MinDeliveryBlocks, MinDeliveryBlocksNotElapsed)
    if (o.now < a.createdAt + o.minDeliveryBlocks) {
      skipped.push({ agreement: a, reason: `MinDeliveryBlocks not elapsed until #${a.createdAt + o.minDeliveryBlocks}` });
      continue;
    }
    if (a.capabilityId === null) {
      if (!o.acceptUncategorised) {
        skipped.push({ agreement: a, reason: 'uncategorised agreement and ACCEPT_UNCATEGORISED=false' });
        continue;
      }
    } else if (!o.capabilities.includes(a.capabilityId)) {
      skipped.push({ agreement: a, reason: `capability ${a.capabilityId} is not one this agent publishes` });
      continue;
    }
    deliver.push(a);
  }
  return { deliver, skipped };
}

/** Agreements where `me` is the buyer and the provider has recorded a delivery. */
export function selectToConfirm(all: AgreementView[], me: string): AgreementView[] {
  return all.filter((a) => a.buyer === me && a.status === 'Delivered');
}
