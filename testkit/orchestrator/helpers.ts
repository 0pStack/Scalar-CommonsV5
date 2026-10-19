import { ApiPromise, WsProvider, Keyring } from "@polkadot/api";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import type { KeyringPair } from "@polkadot/keyring/types";
import type { EventRecord } from "@polkadot/types/interfaces";

export const WS = process.env.SCALAR_WS ?? "ws://127.0.0.1:9955";

export async function connect(): Promise<ApiPromise> {
  return ApiPromise.create({ provider: new WsProvider(WS, 1000, {}, 5000) });
}

/** Dev accounts, derived from the well-known dev URIs only (no secrets). */
export function devAccounts(): Record<string, KeyringPair> {
  const k = new Keyring({ type: "sr25519" });
  const out: Record<string, KeyringPair> = {};
  for (const n of ["Alice", "Bob", "Charlie"]) out[n] = k.addFromUri(`//${n}`);
  // Dave/Eve are unendowed on dev-real; this one is funded by Alice in before().
  out.Juror = k.addFromUri("//TestkitJuror");
  return out;
}

/** Sign, send, wait for inclusion; returns the block's events for this extrinsic. */
export function send(tx: SubmittableExtrinsic<"promise">, who: KeyringPair): Promise<EventRecord[]> {
  return new Promise((resolve, reject) => {
    tx.signAndSend(who, { nonce: -1 }, (res) => {
      if (res.dispatchError) return reject(new Error(res.dispatchError.toString()));
      if (res.status.isInBlock) resolve(res.events);
    }).catch(reject);
  });
}

export const hasEvent = (evs: EventRecord[], section: string, method: string) =>
  evs.some((e) => e.event.section === section && e.event.method === method);

/**
 * Advance the chain by at least `n` blocks. dev-real seals on demand (no blocks
 * without transactions), so this sends `n` remarks; on a timed chain each simply
 * lands in the next block. Waiting on new heads would hang under instant seal.
 */
export async function waitBlocks(api: ApiPromise, n: number, who: KeyringPair): Promise<void> {
  for (let i = 0; i < n; i++) await send(api.tx.system.remark("testkit:advance"), who);
}

/**
 * Like `send`, but a failed dispatch resolves with the decoded error
 * ("section.Name") instead of rejecting, so tests can assert on it.
 */
export function trySend(
  api: ApiPromise,
  tx: SubmittableExtrinsic<"promise">,
  who: KeyringPair,
): Promise<{ events: EventRecord[]; error?: string }> {
  return new Promise((resolve, reject) => {
    tx.signAndSend(who, { nonce: -1 }, (res) => {
      if (!res.status.isInBlock) return;
      if (res.dispatchError) {
        const d = res.dispatchError;
        const error = d.isModule
          ? (({ section, name }) => `${section}.${name}`)(api.registry.findMetaError(d.asModule))
          : d.toString();
        return resolve({ events: res.events, error });
      }
      resolve({ events: res.events });
    }).catch(reject);
  });
}

export const findEvent = (evs: EventRecord[], section: string, method: string) =>
  evs.find((e) => e.event.section === section && e.event.method === method)?.event;
