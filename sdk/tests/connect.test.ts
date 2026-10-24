import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  providerConnect: vi.fn(),
  providerDisconnect: vi.fn(),
  providerReady: Promise.resolve(),
  apiCreate: vi.fn(),
  providers: [] as unknown[],
}));

vi.mock('@polkadot/api', () => {
  const WsProvider = vi.fn(function (this: unknown, endpoint: string, autoConnect: boolean) {
    const provider = {
      endpoint,
      autoConnect,
      connect: mocked.providerConnect,
      disconnect: mocked.providerDisconnect,
      isReady: mocked.providerReady,
    };
    mocked.providers.push(provider);
    return provider;
  });
  return {
    WsProvider,
    ApiPromise: { create: mocked.apiCreate },
  };
});

import { ApiPromise, WsProvider } from '@polkadot/api';
import { ScalarCommonsClient, TimeoutError } from '../src/index.js';

describe('ScalarCommonsClient.connect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.providers.length = 0;
    mocked.providerReady = Promise.resolve();
    mocked.providerConnect.mockResolvedValue(undefined);
    mocked.providerDisconnect.mockResolvedValue(undefined);
    mocked.apiCreate.mockResolvedValue({ isReady: Promise.resolve(), disconnect: vi.fn() });
  });

  it('connects explicitly and enables throwOnConnect', async () => {
    const client = await ScalarCommonsClient.connect('ws://node.test', { connectTimeoutMs: 100 });

    expect(WsProvider).toHaveBeenCalledWith('ws://node.test', false);
    expect(mocked.providerConnect).toHaveBeenCalledOnce();
    expect(ApiPromise.create).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: mocked.providers[0],
        throwOnConnect: true,
      }),
    );
    expect(client).toBeInstanceOf(ScalarCommonsClient);
  });

  it('rejects a hanging provider with TimeoutError and disconnects it', async () => {
    mocked.providerConnect.mockReturnValue(new Promise(() => undefined));

    await expect(
      ScalarCommonsClient.connect('ws://silent.test', { connectTimeoutMs: 10 }),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(mocked.providerDisconnect).toHaveBeenCalledOnce();
    expect(mocked.apiCreate).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid connectTimeoutMs=%s before opening a socket',
    async (connectTimeoutMs) => {
      await expect(
        ScalarCommonsClient.connect('ws://node.test', { connectTimeoutMs }),
      ).rejects.toBeInstanceOf(RangeError);
      expect(WsProvider).not.toHaveBeenCalled();
    },
  );
});
