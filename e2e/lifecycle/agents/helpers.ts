import type { ApiPromise } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import type { SubmittableExtrinsic } from '@polkadot/api/types';
import { SS58_PREFIX } from '@scalar-commons/sdk';
import { connectChain, submit } from '../../support/chain.js';

export const SCALAR_WS = process.env.SCALAR_WS ?? 'ws://127.0.0.1:9955';
export const connect = () => connectChain(SCALAR_WS);
export const keyring = new Keyring({ type: 'sr25519', ss58Format: SS58_PREFIX });
export const alice = () => keyring.addFromUri('//Alice');

export function freshAccount(tag: string): KeyringPair {
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return keyring.addFromUri(`//testkit/${run}/${tag}`);
}

export interface Outcome {
  ok: boolean;
  events: { section: string; method: string; data: Record<string, string> }[];
  error?: string;
  blockHash: string;
}

export async function send(
  api: ApiPromise,
  tx: SubmittableExtrinsic<'promise'>,
  signer: KeyringPair,
): Promise<Outcome> {
  const outcome = await submit(api, tx, signer, { resolveDispatchError: true });
  return {
    ok: outcome.error === undefined,
    error: outcome.error,
    blockHash: outcome.blockHash,
    events: outcome.events.map(({ event }) => {
      const data: Record<string, string> = {};
      event.data.forEach((value, index) => {
        data[event.data.names?.[index] ?? String(index)] = value.toString();
      });
      return { section: event.section, method: event.method, data };
    }),
  };
}

export const eventsOf = (outcome: Outcome, section: string) =>
  outcome.events.filter((event) => event.section === section);

export async function fund(api: ApiPromise, to: KeyringPair, amount: bigint): Promise<void> {
  const outcome = await send(api, api.tx.balances.transferKeepAlive(to.address, amount), alice());
  if (!outcome.ok) throw new Error(`funding failed: ${outcome.error}`);
}
