import { describe, expect, it, vi } from 'vitest';
import type { ApiPromise } from '@polkadot/api';
import type { SubmittableExtrinsic } from '@polkadot/api/types';
import type { KeyringPair } from '@polkadot/keyring/types';
import type { ISubmittableResult } from '@polkadot/types/types';
import { skipOrFail, submit, waitForBlock, withDeadline } from './chain.js';

const signer = {} as KeyringPair;
const api = {
  rpc: {
    chain: {
      getHeader: vi.fn(async () => ({ number: { toNumber: () => 7 } })),
    },
  },
} as unknown as ApiPromise;

function includedResult(): ISubmittableResult {
  return {
    status: {
      isInvalid: false,
      isDropped: false,
      isUsurped: false,
      isRetracted: false,
      isFinalityTimeout: false,
      isFinalized: false,
      isInBlock: true,
      asInBlock: { toHex: () => '0x1234' },
      type: 'InBlock',
    },
    events: [],
  } as unknown as ISubmittableResult;
}
function retractedResult(): ISubmittableResult {
  return {
    status: {
      isInvalid: false,
      isDropped: false,
      isUsurped: false,
      isRetracted: true,
      isFinalityTimeout: false,
      isFinalized: false,
      isInBlock: false,
      type: 'Retracted',
    },
    events: [],
  } as unknown as ISubmittableResult;
}

describe('live-chain support', () => {
  it('withDeadline rejects work that does not settle', async () => {
    await expect(withDeadline(new Promise(() => undefined), 10, 'probe')).rejects.toThrow(
      'probe timed out after 10ms',
    );
  });

  it('submit resolves included transactions and unsubscribes even when the callback wins the race', async () => {
    const unsubscribe = vi.fn();
    const tx = {
      method: { section: 'system', method: 'remark' },
      signAndSend: vi.fn(async (_signer, _options, callback) => {
        callback(includedResult());
        return unsubscribe;
      }),
    } as unknown as SubmittableExtrinsic<'promise'>;

    const outcome = await submit(api, tx, signer, { timeoutMs: 100 });
    expect(outcome.blockHash).toBe('0x1234');
    expect(outcome.blockNumber).toBe(7);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('keeps watching after a temporary Retracted status', async () => {
    const unsubscribe = vi.fn();
    const tx = {
      method: { section: 'system', method: 'remark' },
      signAndSend: vi.fn(async (_signer, _options, callback) => {
        callback(retractedResult());
        callback(includedResult());
        return unsubscribe;
      }),
    } as unknown as SubmittableExtrinsic<'promise'>;

    await expect(submit(api, tx, signer, { timeoutMs: 100 })).resolves.toMatchObject({
      blockHash: '0x1234',
      blockNumber: 7,
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it('submit rejects on its deadline and unsubscribes', async () => {
    const unsubscribe = vi.fn();
    const tx = {
      method: { section: 'system', method: 'remark' },
      signAndSend: vi.fn(async () => unsubscribe),
    } as unknown as SubmittableExtrinsic<'promise'>;

    await expect(submit(api, tx, signer, { timeoutMs: 10 })).rejects.toThrow(
      'system.remark timed out after 10ms',
    );
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('submit rejects metadata decode failures and unsubscribes', async () => {
    const unsubscribe = vi.fn();
    const decodeApi = {
      ...api,
      registry: {
        findMetaError: vi.fn(() => {
          throw new Error('metadata decode failed');
        }),
      },
    } as unknown as ApiPromise;
    const result = {
      ...includedResult(),
      dispatchError: { isModule: true, asModule: {} },
    } as unknown as ISubmittableResult;
    const tx = {
      method: { section: 'system', method: 'remark' },
      signAndSend: vi.fn(async (_signer, _options, callback) => {
        callback(result);
        return unsubscribe;
      }),
    } as unknown as SubmittableExtrinsic<'promise'>;

    await expect(submit(decodeApi, tx, signer, { timeoutMs: 100 })).rejects.toThrow(
      'metadata decode failed',
    );
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('waitForBlock bounds a hanging header request', async () => {
    const hangingApi = {
      rpc: { chain: { getHeader: vi.fn(() => new Promise(() => undefined)) } },
    } as unknown as ApiPromise;

    await expect(waitForBlock(hangingApi, 10, 10)).rejects.toThrow(
      'reading chain head while waiting for block 10 timed out after',
    );
  });

  it('turns an unapproved skip into a failure', () => {
    const ctx = { skip: vi.fn() };
    expect(() => skipOrFail(ctx as never, 'missing capability')).toThrow(/Set E2E_ALLOW_SKIP=1/);
    expect(ctx.skip).not.toHaveBeenCalled();
  });
});
