import type { ApiPromise } from '@polkadot/api';
import type { KeyringPair } from '@polkadot/keyring/types';
import type { SubmittableExtrinsic } from '@polkadot/api/types';
import type { EventRecord } from '@polkadot/types/interfaces';
import { randomAsU8a } from '@polkadot/util-crypto';
import { PLANCKS_PER_CMN } from '@scalar-commons/sdk';
import {
  connectChain,
  devKeyring,
  submitWithRetry,
  waitForBlock as waitUntilBlock,
} from '../../support/chain.js';

export const WS = process.env.SCALAR_WS ?? 'ws://127.0.0.1:9955';
export const cmn = (value: number | bigint): bigint => BigInt(value) * PLANCKS_PER_CMN;
export const connect = () => connectChain(WS);

export async function freshPair(): Promise<KeyringPair> {
  return (await devKeyring()).addFromSeed(randomAsU8a(32));
}

export async function devAlice(): Promise<KeyringPair> {
  return (await devKeyring()).addFromUri('//Alice');
}

export interface Outcome {
  events: EventRecord[];
  blockNumber: number;
}

export async function send(
  api: ApiPromise,
  tx: SubmittableExtrinsic<'promise'>,
  signer: KeyringPair,
): Promise<Outcome> {
  const outcome = await submitWithRetry(api, tx, signer, { attempts: 4, retryDelayMs: 3_000 });
  return { events: outcome.events, blockNumber: outcome.blockNumber };
}

export const findEvent = (outcome: Outcome, section: string, method: string) =>
  outcome.events.find(
    (record) => record.event.section === section && record.event.method === method,
  );

export async function fund(api: ApiPromise, to: KeyringPair, amount: bigint): Promise<void> {
  await send(api, api.tx.balances.transferKeepAlive(to.address, amount), await devAlice());
}

export const waitForBlock = waitUntilBlock;
