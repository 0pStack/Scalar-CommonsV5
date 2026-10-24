import { describe, expect, it, vi } from 'vitest';
import type { ApiPromise } from '@polkadot/api';
import type { SubmittableExtrinsic } from '@polkadot/api/types';
import type { ISubmittableResult } from '@polkadot/types/types';

import {
  SubmitStatusError,
  SubmitTransportError,
  TimeoutError,
  submitAndWatch,
} from '../src/index.js';

type StatusName =
  | 'Ready'
  | 'InBlock'
  | 'Dropped'
  | 'Invalid'
  | 'Usurped'
  | 'Retracted'
  | 'FinalityTimeout';

const txHash = '0x' + '11'.repeat(32);
const blockHash = '0x' + '22'.repeat(32);

function result(type: StatusName): ISubmittableResult {
  return {
    status: {
      type,
      isInBlock: type === 'InBlock',
      isDropped: type === 'Dropped',
      isInvalid: type === 'Invalid',
      isUsurped: type === 'Usurped',
      isRetracted: type === 'Retracted',
      isFinalityTimeout: type === 'FinalityTimeout',
      asInBlock: { toHex: () => blockHash },
    },
    dispatchError: undefined,
    txHash: { toHex: () => txHash },
  } as unknown as ISubmittableResult;
}

function mockApi(included = false, inclusionFailed = false) {
  const getHeader = vi.fn(async () => ({ number: { toNumber: () => 10 } }));
  const getBlockHash = vi.fn(async (height: number) => ({
    toHex: () => '0x' + height.toString(16).padStart(64, '0'),
  }));
  const getBlock = vi.fn(async () => ({
    block: {
      extrinsics: included ? [{ hash: { toHex: () => txHash } }] : [],
    },
  }));
  const dispatchError = {
    isModule: true,
    asModule: {},
    type: 'Module',
  };
  const eventsAt = vi.fn(async () =>
    inclusionFailed
      ? [
          {
            phase: { isApplyExtrinsic: true, asApplyExtrinsic: { toNumber: () => 0 } },
            event: {
              section: 'system',
              method: 'ExtrinsicFailed',
              data: [dispatchError],
            },
          },
        ]
      : [],
  );
  const api = {
    registry: {
      findMetaError: vi.fn(() => ({ section: 'test', name: 'Failure', docs: [] })),
    },
    rpc: { chain: { getHeader, getBlockHash, getBlock } },
    query: { system: { events: { at: eventsAt } } },
  } as unknown as ApiPromise;
  return { api, getHeader, getBlockHash, getBlock, eventsAt };
}

function mockTx(
  run: (attempt: number, callback: (value: ISubmittableResult) => void) => Promise<() => void>,
) {
  let attempt = 0;
  const signAndSend = vi.fn((_signer: unknown, callback: (value: ISubmittableResult) => void) => {
    attempt += 1;
    return run(attempt, callback);
  });
  return {
    tx: { signAndSend } as unknown as SubmittableExtrinsic<'promise'>,
    signAndSend,
  };
}

describe('submitAndWatch safety boundary', () => {
  it('times out a silent subscription with a typed error and unsubscribes', async () => {
    const unsubscribe = vi.fn();
    const { api } = mockApi();
    const { tx } = mockTx(async () => unsubscribe);

    await expect(
      submitAndWatch(api, tx, 'signer' as never, 'silent', {
        maxRetries: 0,
        submitTimeoutMs: 10,
      }),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it.each(['Retracted', 'FinalityTimeout'] as const)(
    'rejects %s as a typed non-retryable status',
    async (status) => {
      const unsubscribe = vi.fn();
      const { api } = mockApi();
      const { tx, signAndSend } = mockTx(async (_attempt, callback) => {
        callback(result(status));
        return unsubscribe;
      });

      await expect(
        submitAndWatch(api, tx, 'signer' as never, status, {
          maxRetries: 3,
          retryDelayMs: 0,
        }),
      ).rejects.toMatchObject({
        name: 'SubmitStatusError',
        status,
        retryable: false,
      } satisfies Partial<SubmitStatusError>);
      expect(signAndSend).toHaveBeenCalledOnce();
      expect(unsubscribe).toHaveBeenCalledOnce();
    },
  );

  it.each(['Dropped', 'Invalid', 'Usurped'] as const)(
    'checks the chain before retrying %s',
    async (status) => {
      const unsubscribe = vi.fn();
      const { api, getBlock } = mockApi();
      const { tx, signAndSend } = mockTx(async (attempt, callback) => {
        callback(result(attempt === 1 ? status : 'InBlock'));
        return unsubscribe;
      });

      await expect(
        submitAndWatch(api, tx, 'signer' as never, status, {
          maxRetries: 1,
          retryDelayMs: 0,
        }),
      ).resolves.toMatchObject({ txHash, blockHash, attempts: 2 });
      expect(getBlock).toHaveBeenCalled();
      expect(signAndSend).toHaveBeenCalledTimes(2);
    },
  );

  it('returns success instead of resubmitting when the transaction hash is already on chain', async () => {
    const unsubscribe = vi.fn();
    const { api } = mockApi(true);
    const { tx, signAndSend } = mockTx(async (_attempt, callback) => {
      callback(result('Dropped'));
      return unsubscribe;
    });

    await expect(
      submitAndWatch(api, tx, 'signer' as never, 'already-included', {
        maxRetries: 1,
        retryDelayMs: 0,
      }),
    ).resolves.toMatchObject({ txHash, attempts: 1 });
    expect(signAndSend).toHaveBeenCalledOnce();
  });

  it('rejects an included transaction whose system event reports ExtrinsicFailed', async () => {
    const unsubscribe = vi.fn();
    const { api, eventsAt } = mockApi(true, true);
    const { tx, signAndSend } = mockTx(async (_attempt, callback) => {
      callback(result('Dropped'));
      return unsubscribe;
    });

    await expect(
      submitAndWatch(api, tx, 'signer' as never, 'included-failure', {
        maxRetries: 2,
        retryDelayMs: 0,
      }),
    ).rejects.toMatchObject({
      name: 'DispatchFailure',
      section: 'test',
      errorName: 'Failure',
    });
    expect(eventsAt).toHaveBeenCalledOnce();
    expect(signAndSend).toHaveBeenCalledOnce();
  });

  it('checks a known hash before retrying a transport failure', async () => {
    const unsubscribe = vi.fn();
    const { api, getBlock } = mockApi();
    const { tx, signAndSend } = mockTx(async (attempt, callback) => {
      if (attempt === 1) {
        callback(result('Ready'));
        throw Object.assign(new Error('WebSocket is not connected'), { code: 'ECONNRESET' });
      }
      callback(result('InBlock'));
      return unsubscribe;
    });

    await expect(
      submitAndWatch(api, tx, 'signer' as never, 'transport', {
        maxRetries: 1,
        retryDelayMs: 0,
      }),
    ).resolves.toMatchObject({ attempts: 2 });
    expect(getBlock).toHaveBeenCalled();
    expect(signAndSend).toHaveBeenCalledTimes(2);
  });

  it('does not retry an ambiguous transport failure without a transaction hash', async () => {
    const { api } = mockApi();
    const { tx, signAndSend } = mockTx(async () => {
      throw Object.assign(new Error('WebSocket is not connected'), { code: 'ECONNRESET' });
    });

    await expect(
      submitAndWatch(api, tx, 'signer' as never, 'ambiguous', {
        maxRetries: 3,
        retryDelayMs: 0,
      }),
    ).rejects.toBeInstanceOf(SubmitTransportError);
    expect(signAndSend).toHaveBeenCalledOnce();
  });

  it('rejects an asynchronous callback error immediately instead of timing out', async () => {
    const { api } = mockApi();
    const decodeError = new Error('metadata decode failed');
    vi.mocked(api.registry.findMetaError).mockImplementation(() => {
      throw decodeError;
    });
    const dispatchError = { isModule: true, asModule: {}, type: 'Module' };
    const unsubscribe: () => void = vi.fn();
    const { tx, signAndSend } = mockTx(async (_attempt, callback) => {
      queueMicrotask(() => callback({ ...result('InBlock'), dispatchError } as never));
      return unsubscribe;
    });

    await expect(
      submitAndWatch(api, tx, 'signer' as never, 'decode-failure', {
        maxRetries: 0,
        submitTimeoutMs: 100,
      }),
    ).rejects.toBe(decodeError);
    expect(signAndSend).toHaveBeenCalledOnce();
  });
});
