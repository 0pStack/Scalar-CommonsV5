/**
 * Live-node client for the faucet.
 *
 * Everything here reads its type shapes from the runtime metadata the node
 * serves — nothing about the balances pallet is hand-written. The faucet spends
 * from an ordinary pre-funded devnet account via `balances.transferKeepAlive`;
 * there is deliberately **no mint path**. All minting on this chain flows
 * through the emissions pallet, and a faucet that could mint would be a hole in
 * the supply cap.
 */

import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { cryptoWaitReady } from '@polkadot/util-crypto';

/** Static facts about the connected chain, read from metadata at connect time. */
export interface ChainInfo {
  readonly chain: string;
  readonly specName: string;
  readonly specVersion: number;
  readonly tokenSymbol: string;
  readonly tokenDecimals: number;
  readonly ss58Format: number;
}

/** Where a transfer landed on chain. */
export interface TransferReceipt {
  readonly blockHash: string;
  readonly txHash: string;
}

export interface ChainClient {
  /** SS58 address of the pre-funded account the faucet spends from. */
  readonly faucetAddress: string;
  chainInfo(): ChainInfo;
  /** Minimum balance for an account to exist, from `balances.existentialDeposit`. */
  existentialDeposit(): bigint;
  /** Free (spendable) balance in plancks. */
  freeBalance(address: string): Promise<bigint>;
  /** Signs and submits a transfer from the faucet account, resolving on inclusion. */
  transfer(dest: string, amountPlancks: bigint): Promise<TransferReceipt>;
  disconnect(): Promise<void>;
}

export interface ConnectOptions {
  readonly rpcEndpoint: string;
  /** Seed/URI of the pre-funded devnet account (e.g. `//Ferdie`). */
  readonly faucetSeed: string;
  readonly ss58Format?: number;
}

/**
 * Pulls a required item out of the runtime metadata.
 *
 * polkadot-js types pallet lookups as possibly-undefined because the metadata is
 * only known at runtime. Resolving them through this guard turns "the connected
 * runtime is missing something the faucet needs" into a startup failure with a
 * specific message, instead of a `TypeError` on the first request.
 */
function fromMetadata<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

/** Raised when the node refuses or fails the transfer. */
export class TransferFailedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'TransferFailedError';
  }
}

/**
 * Connects to the node and resolves the faucet signer.
 *
 * Rejects loudly if the endpoint is unreachable: a faucet that starts up without
 * a chain behind it would answer requests it cannot honour.
 */
export async function connectChain(options: ConnectOptions): Promise<ChainClient> {
  await cryptoWaitReady();

  const provider = new WsProvider(options.rpcEndpoint);
  let api: ApiPromise;
  try {
    api = await ApiPromise.create({ provider, noInitWarn: true, throwOnConnect: true });
  } catch (error) {
    await provider.disconnect().catch(() => undefined);
    throw new Error(
      `cannot reach the node at ${options.rpcEndpoint}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const ss58Format = options.ss58Format ?? api.registry.chainSS58 ?? 42;
  const keyring = new Keyring({ type: 'sr25519', ss58Format });
  const signer: KeyringPair = keyring.addFromUri(options.faucetSeed);

  const info: ChainInfo = {
    chain: (await api.rpc.system.chain()).toString(),
    specName: api.runtimeVersion.specName.toString(),
    specVersion: api.runtimeVersion.specVersion.toNumber(),
    tokenSymbol: api.registry.chainTokens[0] ?? 'CMN',
    tokenDecimals: api.registry.chainDecimals[0] ?? 12,
    ss58Format,
  };

  // Resolve everything the faucet needs out of the live metadata up front, and
  // fail startup if the connected runtime does not expose it. This is what makes
  // "read real metadata, do not guess type shapes" enforceable rather than
  // aspirational: a runtime without these items is a runtime this faucet cannot
  // serve, and finding that out at boot beats finding out mid-request.
  const transferKeepAlive = fromMetadata(
    api.tx.balances?.transferKeepAlive,
    `runtime at ${options.rpcEndpoint} exposes no balances.transferKeepAlive call`,
  );
  const queryAccount = fromMetadata(
    api.query.system?.account,
    `runtime at ${options.rpcEndpoint} exposes no system.account storage`,
  );
  const existentialDepositConst = fromMetadata(
    api.consts.balances?.existentialDeposit,
    `runtime at ${options.rpcEndpoint} exposes no balances.existentialDeposit constant`,
  );

  const existentialDeposit = (existentialDepositConst as unknown as {
    toBigInt(): bigint;
  }).toBigInt();

  // One signer means one nonce stream. Submissions are chained onto this promise
  // so only one transfer is in flight at a time: concurrent requests would
  // otherwise read the same next-nonce and one of the two would be dropped as a
  // duplicate. Serialising costs a block of latency under load and is the reason
  // the faucet never reports success for a transfer that was silently discarded.
  let queue: Promise<unknown> = Promise.resolve();

  async function submitTransfer(dest: string, amountPlancks: bigint): Promise<TransferReceipt> {
    const nonce = await api.rpc.system.accountNextIndex(signer.address);
    return new Promise<TransferReceipt>((resolve, reject) => {
      let unsub: (() => void) | undefined;
      const settle = (fn: () => void) => {
        if (unsub) {
          unsub();
          unsub = undefined;
        }
        fn();
      };

      // transferKeepAlive, not transferAllowDeath: a drip must never be able to
      // reap the faucet account itself.
      transferKeepAlive(dest, amountPlancks)
        .signAndSend(signer, { nonce }, ({ status, dispatchError, txHash }) => {
          if (dispatchError) {
            let reason = dispatchError.toString();
            if (dispatchError.isModule) {
              // Decode the pallet error against live metadata for a real message.
              const meta = api.registry.findMetaError(dispatchError.asModule);
              reason = `${meta.section}.${meta.name}: ${meta.docs.join(' ').trim()}`;
            }
            settle(() => reject(new TransferFailedError(reason)));
            return;
          }
          if (status.isInvalid || status.isDropped || status.isUsurped) {
            settle(() => reject(new TransferFailedError(`transaction ${status.type.toLowerCase()}`)));
            return;
          }
          if (status.isInBlock) {
            settle(() =>
              resolve({ blockHash: status.asInBlock.toHex(), txHash: txHash.toHex() }),
            );
          }
        })
        .then((u) => {
          unsub = u;
        })
        .catch((error: unknown) => {
          reject(
            new TransferFailedError(error instanceof Error ? error.message : String(error)),
          );
        });
    });
  }

  return {
    faucetAddress: signer.address,

    chainInfo: () => info,

    existentialDeposit: () => existentialDeposit,

    async freeBalance(address: string): Promise<bigint> {
      const account = await queryAccount(address);
      return (account as unknown as { data: { free: { toBigInt(): bigint } } }).data.free.toBigInt();
    },

    transfer(dest: string, amountPlancks: bigint): Promise<TransferReceipt> {
      // Chain onto the queue regardless of whether the previous submission
      // succeeded, so one failure does not wedge the faucet permanently.
      const result = queue.then(
        () => submitTransfer(dest, amountPlancks),
        () => submitTransfer(dest, amountPlancks),
      );
      queue = result.catch(() => undefined);
      return result;
    },

    async disconnect(): Promise<void> {
      await api.disconnect();
    },
  };
}
