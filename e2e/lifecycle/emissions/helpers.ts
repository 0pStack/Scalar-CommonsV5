import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import type { KeyringPair } from "@polkadot/keyring/types";
import type { Codec, ISubmittableResult } from "@polkadot/types/types";
import { cryptoWaitReady } from "@polkadot/util-crypto";

export const WS = process.env.SCALAR_WS ?? "ws://127.0.0.1:9955";

/** Decode a storage/const value to bigint. */
export const big = (c: Codec): bigint => BigInt(c.toString().replace(/,/g, ""));

export async function connect(): Promise<ApiPromise> {
  return ApiPromise.create({ provider: new WsProvider(WS) });
}

export async function keyring(): Promise<Keyring> {
  await cryptoWaitReady();
  return new Keyring({ type: "sr25519", ss58Format: 42 });
}

export interface Outcome {
  /** "Pallet.Error" if the extrinsic failed, else null. */
  error: string | null;
  /** "pallet.event" of every event the extrinsic deposited. */
  events: string[];
  result: ISubmittableResult;
}

/** Sign, send and wait for inclusion; decode the module error if there is one. */
async function sendOnce(
  api: ApiPromise,
  tx: ReturnType<ApiPromise["tx"]["system"]["remark"]>,
  signer: KeyringPair,
): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    tx.signAndSend(signer, { nonce: -1 }, (result) => {
      if (result.isError) return reject(new Error(`tx dropped (usurped): ${result.status.toString()}`));
      if (!result.isInBlock) return;
      let error: string | null = null;
      const events: string[] = [];
      for (const { event } of result.events) {
        events.push(`${event.section}.${event.method}`);
        if (api.events.system.ExtrinsicFailed.is(event)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const err = event.data[0] as any;
          if (err.isModule) {
            const m = api.registry.findMetaError(err.asModule);
            error = `${m.section}.${m.name}`;
          } else {
            error = err.toString();
          }
        }
      }
      resolve({ error, events, result });
    }).catch(reject);
  });
}

/** A throwaway dev-derived account, unique per run so runs do not share agent state. */
export async function freshAccount(tag: string): Promise<KeyringPair> {
  const kr = await keyring();
  return kr.addFromUri(`//emissions-testkit/${tag}/${Date.now()}/${Math.random()}`);
}

const RETRYABLE = /1012|1013|1014|Priority is too low|usurped|nonce/i;

/**
 * Sign, send and wait for inclusion. A shared dev node has other test sessions signing as
 * the same dev accounts, so a stale-nonce / same-priority pool rejection is retried with a
 * fresh nonce rather than failing the test for a reason unrelated to the pallet.
 */
export async function send(
  api: ApiPromise,
  tx: ReturnType<ApiPromise["tx"]["system"]["remark"]>,
  signer: KeyringPair,
): Promise<Outcome> {
  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await sendOnce(api, tx, signer);
    } catch (e) {
      last = e;
      if (!RETRYABLE.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw last;
}
