/**
 * Connection to the node this indexer follows.
 *
 * Type shapes are taken from the runtime metadata the node serves, never
 * hand-written here: the pallets this indexer reads (`agents`, `escrow`,
 * `emissions`) are chain-specific, and a hard-coded shape would decode into
 * plausible-looking nonsense the first time the runtime changed.
 */

import { ApiPromise, WsProvider } from '@polkadot/api';

/** Raised when the configured node cannot be reached. */
export class ChainUnreachableError extends Error {
  constructor(rpcUrl: string, cause: string) {
    super(`cannot reach node at ${rpcUrl}: ${cause}`);
    this.name = 'ChainUnreachableError';
  }
}

export interface ChainConnection {
  readonly api: ApiPromise;
  /** SS58 prefix the chain identifies itself with, used for every address we emit. */
  readonly ss58Format: number;
  readonly tokenSymbol: string;
  readonly tokenDecimals: number;
  disconnect(): Promise<void>;
}

/**
 * Connects and reads the chain's own properties.
 *
 * Fails fast rather than retrying forever: an indexer that cannot reach its
 * node has nothing truthful to serve, and a silent reconnect loop behind a
 * running API would answer requests from a stale index as though it were live.
 */
export async function connectChain(rpcUrl: string, timeoutMs = 30_000): Promise<ChainConnection> {
  const provider = new WsProvider(rpcUrl, 1_000);

  let api: ApiPromise;
  try {
    api = await withTimeout(
      ApiPromise.create({ provider, noInitWarn: true, throwOnConnect: true }),
      timeoutMs,
      rpcUrl,
    );
  } catch (error) {
    await provider.disconnect().catch(() => undefined);
    if (error instanceof ChainUnreachableError) {
      throw error;
    }
    throw new ChainUnreachableError(rpcUrl, error instanceof Error ? error.message : String(error));
  }

  const properties = api.registry.getChainProperties();
  const ss58Format = properties?.ss58Format.unwrapOr(undefined)?.toNumber() ?? 42;
  const tokenSymbol = properties?.tokenSymbol.unwrapOr(undefined)?.[0]?.toString() ?? 'UNIT';
  const tokenDecimals = properties?.tokenDecimals.unwrapOr(undefined)?.[0]?.toNumber() ?? 12;

  return {
    api,
    ss58Format,
    tokenSymbol,
    tokenDecimals,
    disconnect: () => api.disconnect(),
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, rpcUrl: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ChainUnreachableError(rpcUrl, `no response within ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
