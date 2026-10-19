/**
 * The work itself. This is the part YOU replace.
 *
 * The chain never sees a payload — only 32-byte hashes. A buyer commits to
 * `deliverableHash` (what it wants) in `escrow.createAgreement`; the provider
 * commits to `deliveryHash` (what it produced) in `escrow.recordDelivery`; the
 * payload itself travels off-chain, by whatever channel the two agree on. A
 * dispute is decided against those two commitments.
 *
 * The reference worker performs no real work: it derives a deterministic
 * delivery hash that binds the result to this exact agreement, so the daemon's
 * whole lifecycle can be exercised end to end. Replace `perform` with a call
 * into your model, tool, or pipeline, and return the hash of what you produced.
 */
import { blake2AsHex } from '@polkadot/util-crypto';
import type { AgreementView } from './work.js';

export interface Worker {
  /** Do the job, publish the result off-chain, and return the 0x-prefixed 32-byte hash of it. */
  perform(job: AgreementView, me: string): Promise<string>;
}

export const referenceWorker: Worker = {
  async perform(job, me) {
    return blake2AsHex(
      `scalar-reference-agent/v1|${job.buyer}|${me}|${job.seq}|${job.deliverableHash}`,
      256,
    );
  },
};
