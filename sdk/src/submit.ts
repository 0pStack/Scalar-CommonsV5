import type { ApiPromise } from '@polkadot/api';
import type { SubmittableExtrinsic } from '@polkadot/api/types';
import type { ISubmittableResult } from '@polkadot/types/types';
import type { AddressOrPair } from '@polkadot/api/types';

import { DispatchFailure } from './errors.js';
import { withRetry, type RetryOptions } from './retry.js';

/** Result of a successfully included extrinsic. */
export interface SubmitResult {
  /** Hash of the extrinsic. */
  txHash: string;
  /** Hash of the block the extrinsic was included in. */
  blockHash: string;
  /** 1-based number of the attempt that finally succeeded (>1 means retries happened). */
  attempts: number;
}

/**
 * Sign and send a single extrinsic, resolving once it is included in a block.
 *
 * Rejects (rather than silently resolving) when the runtime returns a dispatch
 * error — the error is decoded to `pallet.Error` form so the retry layer and the
 * caller both see a meaningful message.
 */
function signAndSendOnce(
  api: ApiPromise,
  tx: SubmittableExtrinsic<'promise'>,
  signer: AddressOrPair,
): Promise<{ txHash: string; blockHash: string }> {
  return new Promise((resolve, reject) => {
    let unsub: (() => void) | undefined;
    const cleanup = () => {
      if (unsub) unsub();
    };

    tx.signAndSend(signer, (result: ISubmittableResult) => {
      const { status, dispatchError, txHash } = result;

      if (dispatchError) {
        let failure: DispatchFailure;
        if (dispatchError.isModule) {
          const decoded = api.registry.findMetaError(dispatchError.asModule);
          failure = new DispatchFailure(decoded.section, decoded.name, decoded.docs.join(' ').trim());
        } else {
          // Non-module errors (BadOrigin, token/arithmetic errors) render as e.g. "BadOrigin".
          failure = new DispatchFailure('system', dispatchError.type, '');
        }
        cleanup();
        reject(failure);
        return;
      }

      if (status.isInBlock) {
        cleanup();
        resolve({ txHash: txHash.toHex(), blockHash: status.asInBlock.toHex() });
      } else if (status.isInvalid || status.isDropped || status.isUsurped) {
        cleanup();
        reject(new Error(`transaction not included: status=${status.type}`));
      }
    }).then(
      (u) => {
        unsub = u;
      },
      (err) => reject(err),
    );
  });
}

/**
 * Submit an extrinsic with the no-silent-retry policy (see {@link withRetry}).
 * Returns the block/tx hashes and how many attempts it took.
 */
export async function submitAndWatch(
  api: ApiPromise,
  tx: SubmittableExtrinsic<'promise'>,
  signer: AddressOrPair,
  label: string,
  options: RetryOptions = {},
): Promise<SubmitResult> {
  let attempts = 0;
  const { txHash, blockHash } = await withRetry(
    async (attempt) => {
      attempts = attempt;
      return signAndSendOnce(api, tx, signer);
    },
    `submit(${label})`,
    options,
  );
  return { txHash, blockHash, attempts };
}
