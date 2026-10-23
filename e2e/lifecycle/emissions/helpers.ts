import type { ApiPromise } from '@polkadot/api';
import type { KeyringPair } from '@polkadot/keyring/types';
import type { Codec, ISubmittableResult } from '@polkadot/types/types';
import { connectChain, devKeyring, submitWithRetry } from '../../support/chain.js';

export const WS = process.env.SCALAR_WS ?? 'ws://127.0.0.1:9955';
export const big = (codec: Codec): bigint => BigInt(codec.toString().replace(/,/g, ''));
export const connect = () => connectChain(WS);
export const keyring = () => devKeyring();

export interface Outcome {
  error: string | null;
  events: string[];
  result: ISubmittableResult;
}

export async function freshAccount(tag: string): Promise<KeyringPair> {
  const kr = await keyring();
  return kr.addFromUri(`//emissions-testkit/${tag}/${Date.now()}/${Math.random()}`);
}

export async function send(
  api: ApiPromise,
  tx: ReturnType<ApiPromise['tx']['system']['remark']>,
  signer: KeyringPair,
): Promise<Outcome> {
  const outcome = await submitWithRetry(api, tx, signer, {
    attempts: 6,
    retryDelayMs: 1_500,
    resolveDispatchError: true,
  });
  return {
    error: outcome.error ?? null,
    events: outcome.events.map(({ event }) => `${event.section}.${event.method}`),
    result: outcome.result,
  };
}
