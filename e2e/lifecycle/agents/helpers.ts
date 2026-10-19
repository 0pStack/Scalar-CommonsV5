import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import type { SubmittableExtrinsic } from '@polkadot/api/types';
import type { ISubmittableResult } from '@polkadot/types/types';

/** Node under test. Defaults to the lab dev-real node; override with SCALAR_WS. */
export const SCALAR_WS = process.env.SCALAR_WS ?? 'ws://127.0.0.1:9955';

export async function connect(): Promise<ApiPromise> {
  return ApiPromise.create({ provider: new WsProvider(SCALAR_WS), noInitWarn: true });
}

/** True when a node answers at SCALAR_WS within `ms`. Lets suites skip, not fail, when no node is up. */
export async function nodeIsUp(ms = 4000): Promise<boolean> {
  const provider = new WsProvider(SCALAR_WS, 500);
  try {
    await Promise.race([
      provider.isReady,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    await provider.disconnect().catch(() => undefined);
  }
}

export const keyring = new Keyring({ type: 'sr25519', ss58Format: 42 });

/** The funded dev account used only to endow throwaway test accounts. */
export const alice = () => keyring.addFromUri('//Alice');

/**
 * A throwaway account unique to this run, so re-running against a persistent dev chain never
 * collides with an earlier run's registrations.
 */
export function freshAccount(tag: string): KeyringPair {
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return keyring.addFromUri(`//testkit/${run}/${tag}`);
}

export interface Outcome {
  ok: boolean;
  /** `section.method` of every event in the block that belongs to this extrinsic. */
  events: { section: string; method: string; data: Record<string, string> }[];
  /** `Section.Error` name when the extrinsic failed, else undefined. */
  error?: string;
  blockHash: string;
}

/** Sign, send, wait for inclusion, and decode the events + dispatch error of this extrinsic. */
export function send(
  api: ApiPromise,
  tx: SubmittableExtrinsic<'promise'>,
  signer: KeyringPair,
): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    let unsub: (() => void) | undefined;
    tx.signAndSend(signer, { nonce: -1 }, (result: ISubmittableResult) => {
      if (result.dispatchError) {
        let error = result.dispatchError.toString();
        if (result.dispatchError.isModule) {
          const d = api.registry.findMetaError(result.dispatchError.asModule);
          error = `${d.section}.${d.name}`;
        }
        unsub?.();
        resolve({ ok: false, error, events: decode(result), blockHash: result.status.asInBlock.toHex() });
      } else if (result.status.isInvalid || result.status.isDropped || result.status.isUsurped) {
        unsub?.();
        reject(new Error(`extrinsic not included: ${result.status.type}`));
      } else if (result.status.isInBlock) {
        unsub?.();
        resolve({ ok: true, events: decode(result), blockHash: result.status.asInBlock.toHex() });
      }
    })
      .then((u) => (unsub = u))
      .catch(reject);
  });
}

function decode(result: ISubmittableResult): Outcome['events'] {
  return result.events.map(({ event }) => {
    const data: Record<string, string> = {};
    event.data.forEach((v, i) => {
      data[event.data.names?.[i] ?? String(i)] = v.toString();
    });
    return { section: event.section, method: event.method, data };
  });
}

/** Events of one pallet section from an outcome. */
export const eventsOf = (o: Outcome, section: string) => o.events.filter((e) => e.section === section);

/** Transfer `amount` plancks from Alice to `to`, and wait for inclusion. */
export async function fund(api: ApiPromise, to: KeyringPair, amount: bigint): Promise<void> {
  const o = await send(api, api.tx.balances.transferKeepAlive(to.address, amount), alice());
  if (!o.ok) throw new Error(`funding failed: ${o.error}`);
}
