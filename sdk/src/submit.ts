import type { ApiPromise } from '@polkadot/api';
import type { AddressOrPair, SubmittableExtrinsic } from '@polkadot/api/types';
import type { EventRecord } from '@polkadot/types/interfaces/system';
import type { ISubmittableResult } from '@polkadot/types/types';

import {
  DispatchFailure,
  isRetryableFailure,
  SubmitStatusError,
  SubmitTransportError,
  TimeoutError,
} from './errors.js';
import { withRetry, type RetryOptions } from './retry.js';
import { requirePositiveFinite, withTimeout } from './timeout.js';

const DEFAULT_SUBMIT_TIMEOUT_MS = 60_000;

/** Options for a bounded, observable transaction submission. */
export interface SubmitOptions extends RetryOptions {
  /** Maximum time for one submission attempt. Defaults to 60 seconds. */
  submitTimeoutMs?: number;
}

/** Result of a successfully included extrinsic. */
export interface SubmitResult {
  /** Hash of the extrinsic. */
  txHash: string;
  /** Hash of the block the extrinsic was included in. */
  blockHash: string;
  /** 1-based number of the attempt that finally succeeded (>1 means retries happened). */
  attempts: number;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
type DispatchError = NonNullable<ISubmittableResult['dispatchError']>;

function decodeDispatchFailure(api: ApiPromise, dispatchError: DispatchError): DispatchFailure {
  if (dispatchError.isModule) {
    const decoded = api.registry.findMetaError(dispatchError.asModule);
    return new DispatchFailure(decoded.section, decoded.name, decoded.docs.join(' ').trim());
  }
  return new DispatchFailure('system', dispatchError.type, '');
}

async function findTransaction(
  api: ApiPromise,
  txHash: string,
  fromBlock: number,
): Promise<{ blockHash: string; dispatchError?: DispatchError } | null> {
  const current = (await api.rpc.chain.getHeader()).number.toNumber();
  for (let height = fromBlock; height <= current; height += 1) {
    const hash = await api.rpc.chain.getBlockHash(height);
    const signed = await api.rpc.chain.getBlock(hash);
    const index = signed.block.extrinsics.findIndex(
      (extrinsic) => extrinsic.hash.toHex() === txHash,
    );
    if (index < 0) continue;

    const records = (await api.query.system!.events!.at(hash)) as unknown as EventRecord[];
    const failed = records.find(
      ({ event, phase }) =>
        phase.isApplyExtrinsic &&
        phase.asApplyExtrinsic.toNumber() === index &&
        event.section === 'system' &&
        event.method === 'ExtrinsicFailed',
    );
    return {
      blockHash: hash.toHex(),
      dispatchError: failed?.event.data[0] as DispatchError | undefined,
    };
  }
  return null;
}

/**
 * Sign and send a single extrinsic, resolving once it is included in a block.
 *
 * A retryable pool/transport failure is rejected only after the observed
 * transaction hash has been checked across the blocks produced since submission
 * began. A hash already on chain resolves as success instead of being submitted
 * twice. Ambiguous failures without a hash never retry.
 */
function signAndSendOnce(
  api: ApiPromise,
  tx: SubmittableExtrinsic<'promise'>,
  signer: AddressOrPair,
  fromBlock: number,
  timeoutMs: number,
): Promise<{ txHash: string; blockHash: string }> {
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    let cleanupPending = false;
    let settled = false;
    let checking = false;
    let observedTxHash: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (unsubscribe) {
        const stop = unsubscribe;
        unsubscribe = undefined;
        stop();
      } else {
        cleanupPending = true;
      }
    };
    const succeed = (value: { txHash: string; blockHash: string }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const checkBeforeRetry = async (
      buildError: (retryable: boolean) => SubmitStatusError | SubmitTransportError,
    ) => {
      if (settled || checking) return;
      checking = true;
      cleanup();
      if (!observedTxHash) {
        fail(buildError(false));
        return;
      }
      try {
        const inclusion = await withTimeout(
          findTransaction(api, observedTxHash, fromBlock),
          timeoutMs,
          `checking transaction ${observedTxHash} on chain`,
        );
        if (inclusion?.dispatchError) {
          fail(decodeDispatchFailure(api, inclusion.dispatchError));
        } else if (inclusion) {
          succeed({ txHash: observedTxHash, blockHash: inclusion.blockHash });
        } else {
          fail(buildError(true));
        }
      } catch (cause) {
        fail(
          new SubmitTransportError(
            `could not verify transaction ${observedTxHash} on chain: ${messageOf(cause)}`,
            observedTxHash,
            false,
            { cause },
          ),
        );
      }
    };

    timer = setTimeout(
      () => fail(new TimeoutError('transaction submission', timeoutMs)),
      timeoutMs,
    );

    tx.signAndSend(signer, (result: ISubmittableResult) => {
      if (settled || checking) return;
      try {
        const { status, dispatchError, txHash } = result;
        observedTxHash = txHash?.toHex() ?? observedTxHash;

        if (dispatchError) {
          fail(decodeDispatchFailure(api, dispatchError));
          return;
        }

        if (status.isInBlock) {
          succeed({
            txHash: observedTxHash ?? txHash.toHex(),
            blockHash: status.asInBlock.toHex(),
          });
        } else if (status.isInvalid || status.isDropped || status.isUsurped) {
          void checkBeforeRetry(
            (retryable) => new SubmitStatusError(status.type, observedTxHash, retryable),
          );
        } else if (status.isRetracted || status.isFinalityTimeout) {
          fail(new SubmitStatusError(status.type, observedTxHash, false));
        }
      } catch (cause) {
        fail(cause);
      }
    }).then(
      (stop) => {
        if (cleanupPending || settled || checking) stop();
        else unsubscribe = stop;
      },
      (cause) => {
        if (settled || checking) return;
        const candidate = isRetryableFailure(cause);
        const build = (retryable: boolean) =>
          new SubmitTransportError(messageOf(cause), observedTxHash, candidate && retryable, {
            cause,
          });
        if (candidate) void checkBeforeRetry(build);
        else fail(build(false));
      },
    );
  });
}

/**
 * Submit an extrinsic with bounded attempts and no silent retry.
 *
 * Every retryable failure is checked against the chain first; timeout,
 * retraction, finality timeout, dispatch and ambiguous transport failures stop
 * immediately.
 */
export async function submitAndWatch(
  api: ApiPromise,
  tx: SubmittableExtrinsic<'promise'>,
  signer: AddressOrPair,
  label: string,
  options: SubmitOptions = {},
): Promise<SubmitResult> {
  const submitTimeoutMs = options.submitTimeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS;
  requirePositiveFinite(submitTimeoutMs, 'submitTimeoutMs');
  const startHeader = await withTimeout(
    api.rpc.chain.getHeader(),
    submitTimeoutMs,
    'reading the pre-submit chain head',
  );
  const fromBlock = startHeader.number.toNumber();
  let attempts = 0;
  const { txHash, blockHash } = await withRetry(
    async (attempt) => {
      attempts = attempt;
      return signAndSendOnce(api, tx, signer, fromBlock, submitTimeoutMs);
    },
    `submit(${label})`,
    options,
  );
  return { txHash, blockHash, attempts };
}
