import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import type { SubmittableExtrinsic } from '@polkadot/api/types';
import type { EventRecord } from '@polkadot/types/interfaces';
import { cryptoWaitReady, randomAsU8a } from '@polkadot/util-crypto';

export const WS = process.env.SCALAR_WS ?? 'ws://127.0.0.1:9955';
const CMN = 10n ** 12n;
export const cmn = (n: number | bigint): bigint => BigInt(n) * CMN;

export async function connect(): Promise<ApiPromise> {
  return ApiPromise.create({ provider: new WsProvider(WS, 1000) });
}

/** Fresh, unfunded keypair so concurrent runs never share state. */
export async function freshPair(): Promise<KeyringPair> {
  await cryptoWaitReady();
  const kr = new Keyring({ type: 'sr25519' });
  return kr.addFromSeed(randomAsU8a(32));
}

export async function devAlice(): Promise<KeyringPair> {
  await cryptoWaitReady();
  return new Keyring({ type: 'sr25519' }).addFromUri('//Alice');
}

export interface Outcome {
  events: EventRecord[];
  blockNumber: number;
}

const POOL_CONTENTION = /1014|1013|1012|Priority is too low|Stale|Future/;

/**
 * Sign and send, retrying a few times when the tx pool rejects a nonce collision. The dev
 * node is shared (//Alice funds every test run), so two submitters can race on a nonce.
 * Dispatch errors (pallet rejections) are never retried.
 */
export async function send(
  api: ApiPromise,
  tx: SubmittableExtrinsic<'promise'>,
  signer: KeyringPair,
): Promise<Outcome> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await sendOnce(api, tx, signer);
    } catch (e) {
      if (attempt >= 4 || !POOL_CONTENTION.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

function sendOnce(
  api: ApiPromise,
  tx: SubmittableExtrinsic<'promise'>,
  signer: KeyringPair,
): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    let unsub: (() => void) | undefined;
    tx.signAndSend(signer, { nonce: -1 }, async (res) => {
      if (res.dispatchError) {
        const d = res.dispatchError;
        const msg = d.isModule
          ? (() => {
              const m = api.registry.findMetaError(d.asModule);
              return `${m.section}.${m.name}`;
            })()
          : d.toString();
        unsub?.();
        return reject(new Error(msg));
      }
      if (res.status.isInBlock) {
        unsub?.();
        const hdr = await api.rpc.chain.getHeader(res.status.asInBlock);
        resolve({ events: [...res.events], blockNumber: hdr.number.toNumber() });
      }
    })
      .then((u) => (unsub = u))
      .catch(reject);
  });
}

export const findEvent = (o: Outcome, section: string, method: string) =>
  o.events.find((r) => r.event.section === section && r.event.method === method);

export async function fund(api: ApiPromise, to: KeyringPair, amount: bigint): Promise<void> {
  const alice = await devAlice();
  await send(api, api.tx.balances.transferKeepAlive(to.address, amount), alice);
}

export async function waitForBlock(api: ApiPromise, target: number): Promise<void> {
  while ((await api.rpc.chain.getHeader()).number.toNumber() < target) {
    await new Promise((r) => setTimeout(r, 500));
  }
}
