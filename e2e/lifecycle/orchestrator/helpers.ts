import type { ApiPromise } from '@polkadot/api';
import type { SubmittableExtrinsic } from '@polkadot/api/types';
import type { KeyringPair } from '@polkadot/keyring/types';
import type { EventRecord } from '@polkadot/types/interfaces';
import {
  advanceBlocks,
  connectChain,
  devAccounts,
  findEvent,
  hasEvent,
  submit,
} from '../../support/chain.js';

export const WS = process.env.SCALAR_WS ?? 'ws://127.0.0.1:9955';
export const connect = () => connectChain(WS);
export { devAccounts, findEvent, hasEvent };

export async function send(
  api: ApiPromise,
  tx: SubmittableExtrinsic<'promise'>,
  who: KeyringPair,
): Promise<EventRecord[]> {
  return (await submit(api, tx, who)).events;
}

export async function trySend(
  api: ApiPromise,
  tx: SubmittableExtrinsic<'promise'>,
  who: KeyringPair,
): Promise<{ events: EventRecord[]; error?: string }> {
  const outcome = await submit(api, tx, who, { resolveDispatchError: true });
  return { events: outcome.events, error: outcome.error };
}

export const waitBlocks = advanceBlocks;
