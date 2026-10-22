import type { ScalarCommonsClient } from '@scalar-commons/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SUBMIT_TIMEOUT_MS, SdkChain } from '../src/chain.js';

const SIGNER = '5Signer';
const BUYER = '5Buyer';
const TX_HASH = '0x' + 'aa'.repeat(32);
const BLOCK_HASH = '0x' + 'bb'.repeat(32);

type StatusType = 'InBlock' | 'Dropped' | 'Invalid' | 'Usurped';

/** The slice of polkadot-js's ISubmittableResult that the submit paths read. */
function result(type: StatusType, dispatchError?: unknown) {
  return {
    status: {
      type,
      isInBlock: type === 'InBlock',
      isDropped: type === 'Dropped',
      isInvalid: type === 'Invalid',
      isUsurped: type === 'Usurped',
      asInBlock: { toHex: () => BLOCK_HASH },
    },
    dispatchError,
    txHash: { toHex: () => TX_HASH },
  };
}

/**
 * A submittable whose subscription delivers `update` once, after the
 * unsubscribe handle is returned (as polkadot-js does). `null` models a
 * subscription that never fires.
 */
function fakeTx(update: ReturnType<typeof result> | null) {
  const unsub = vi.fn();
  const signAndSend = vi.fn((_signer: unknown, cb: (r: unknown) => void) => {
    if (update) queueMicrotask(() => cb(update));
    return Promise.resolve(unsub);
  });
  return { signAndSend, unsub };
}

function chainWith(tx: ReturnType<typeof fakeTx>, { metadata = true } = {}) {
  const api = {
    tx: {
      escrow: { acceptAgreement: vi.fn(() => tx) },
      agents: metadata ? { updateMetadata: vi.fn(() => tx) } : {},
    },
    registry: {
      findMetaError: () => {
        throw new Error('test fakes only non-module dispatch errors');
      },
    },
  };
  return new SdkChain({ api } as unknown as ScalarCommonsClient, SIGNER);
}

// The two writes that build their own promise instead of going through the SDK client.
const WRITES = [
  ['setMetadata', (c: SdkChain) => c.setMetadata('operator-reference-agent')],
  ['acceptAgreement', (c: SdkChain) => c.acceptAgreement(BUYER, 7)],
] as const;

afterEach(() => {
  vi.useRealTimers();
});

describe.each(WRITES)('SdkChain.%s', (_name, write) => {
  // #57: these statuses are final, so the promise must reject, not wait for an
  // InBlock that will never come. The 1 s test timeout turns a hang into a failure.
  it.each(['Dropped', 'Invalid', 'Usurped'] as const)(
    'rejects when the transaction is %s, and sends it only once',
    async (type) => {
      const tx = fakeTx(result(type));
      await expect(write(chainWith(tx))).rejects.toThrow(`not included: status=${type}`);
      // No retries added here: resubmission policy belongs to #76.
      expect(tx.signAndSend).toHaveBeenCalledTimes(1);
    },
    1_000,
  );

  it(
    'rejects after SUBMIT_TIMEOUT_MS when the subscription never fires',
    async () => {
      vi.useFakeTimers();
      const tx = fakeTx(null);
      const p = write(chainWith(tx));
      let settled = false;
      p.then(
        () => (settled = true),
        () => (settled = true),
      );
      const rejected = expect(p).rejects.toThrow(/timed out/);

      await vi.advanceTimersByTimeAsync(SUBMIT_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(tx.signAndSend).toHaveBeenCalledTimes(1);
    },
    1_000,
  );

  it('resolves to the tx hash once InBlock', async () => {
    await expect(write(chainWith(fakeTx(result('InBlock'))))).resolves.toBe(TX_HASH);
  });

  it('rejects on a dispatch error', async () => {
    const badOrigin = { isModule: false, type: 'BadOrigin', toString: () => 'BadOrigin' };
    await expect(write(chainWith(fakeTx(result('InBlock', badOrigin))))).rejects.toThrow(/BadOrigin/);
  });
});

describe('SdkChain.setMetadata', () => {
  it('returns null without sending when the runtime has no agents.updateMetadata', async () => {
    const tx = fakeTx(result('InBlock'));
    await expect(chainWith(tx, { metadata: false }).setMetadata('x')).resolves.toBeNull();
    expect(tx.signAndSend).not.toHaveBeenCalled();
  });
});
