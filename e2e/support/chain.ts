import { ApiPromise, WsProvider } from '@polkadot/api';
import type { SubmittableExtrinsic } from '@polkadot/api/types';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import type { EventRecord } from '@polkadot/types/interfaces';
import type { ISubmittableResult } from '@polkadot/types/types';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { SS58_PREFIX } from '@scalar-commons/sdk';
import type { TestContext } from 'vitest';

export const DEFAULT_RPC_ENDPOINT = 'ws://127.0.0.1:9955';
export const E2E_ALLOW_SKIP = /^(1|true|yes)$/i.test(process.env.E2E_ALLOW_SKIP ?? '');
const CONNECT_TIMEOUT_MS = 10_000;
const SUBMIT_TIMEOUT_MS = 60_000;
const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${description} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function connectChain(
  endpoint = process.env.SCALAR_WS ?? DEFAULT_RPC_ENDPOINT,
  timeoutMs = CONNECT_TIMEOUT_MS,
): Promise<ApiPromise> {
  const provider = new WsProvider(endpoint, false);
  try {
    await withDeadline(
      Promise.resolve(provider.connect()).then(() => provider.isReady),
      timeoutMs,
      `connection to ${endpoint}`,
    );
    return await withDeadline(
      ApiPromise.create({ provider, noInitWarn: true, throwOnConnect: true }),
      timeoutMs,
      `API initialization for ${endpoint}`,
    );
  } catch (error) {
    await provider.disconnect().catch(() => undefined);
    throw new Error(`cannot reach the node at ${endpoint}: ${text(error)}`, { cause: error });
  }
}

export async function connectLiveSuite(
  suite: string,
  endpoint = process.env.SCALAR_WS ?? DEFAULT_RPC_ENDPOINT,
): Promise<ApiPromise | undefined> {
  try {
    return await connectChain(endpoint);
  } catch (error) {
    if (!E2E_ALLOW_SKIP) throw error;
    console.warn(`[e2e] ${suite} skipped: ${text(error)}`);
    return undefined;
  }
}

export function skipOrFail(ctx: TestContext, reason: string): never {
  if (!E2E_ALLOW_SKIP) {
    throw new Error(`${reason}. Set E2E_ALLOW_SKIP=1 only when that skip is intentional.`);
  }
  ctx.skip(reason);
  throw new Error('unreachable after ctx.skip');
}

export async function devKeyring(ss58Format = SS58_PREFIX): Promise<Keyring> {
  await cryptoWaitReady();
  return new Keyring({ type: 'sr25519', ss58Format });
}

export async function devAccounts(
  names: readonly string[] = ['Alice', 'Bob', 'Charlie', 'Dave', 'Eve', 'Ferdie'],
  ss58Format = SS58_PREFIX,
): Promise<Record<string, KeyringPair>> {
  const keyring = await devKeyring(ss58Format);
  return Object.fromEntries(names.map((name) => [name, keyring.addFromUri(`//${name}`)]));
}

export interface SubmitOutcome {
  events: EventRecord[];
  blockHash: string;
  blockNumber: number;
  error?: string;
  result: ISubmittableResult;
}

export interface SubmitOptions {
  timeoutMs?: number;
  waitFor?: 'inBlock' | 'finalized';
  resolveDispatchError?: boolean;
  nonce?: number | bigint | 'auto';
}

function dispatchError(api: ApiPromise, result: ISubmittableResult): string | undefined {
  const error = result.dispatchError;
  if (!error) return undefined;
  if (!error.isModule) return error.toString();
  const decoded = api.registry.findMetaError(error.asModule);
  return `${decoded.section}.${decoded.name}`;
}

export function submit(
  api: ApiPromise,
  tx: SubmittableExtrinsic<'promise'>,
  signer: KeyringPair,
  options: SubmitOptions = {},
): Promise<SubmitOutcome> {
  const timeoutMs = options.timeoutMs ?? SUBMIT_TIMEOUT_MS;
  const waitFor = options.waitFor ?? 'inBlock';
  const nonce = options.nonce === undefined || options.nonce === 'auto' ? -1 : options.nonce;
  return new Promise((resolve, reject) => {
    let stop: (() => void) | undefined;
    let cleanupPending = false;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      if (stop) stop();
      else cleanupPending = true;
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const timer = setTimeout(
      () =>
        fail(new Error(`${tx.method.section}.${tx.method.method} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const onResult = async (result: ISubmittableResult) => {
      try {
        if (settled) return;
        if (
          result.status.isInvalid ||
          result.status.isDropped ||
          result.status.isUsurped ||
          result.status.isFinalityTimeout
        ) {
          fail(new Error(`extrinsic not included: ${result.status.type}`));
          return;
        }
        const included =
          waitFor === 'finalized' ? result.status.isFinalized : result.status.isInBlock;
        if (!included) return;
        const blockHash =
          waitFor === 'finalized'
            ? result.status.asFinalized.toHex()
            : result.status.asInBlock.toHex();
        const error = dispatchError(api, result);
        if (error && !options.resolveDispatchError) {
          fail(new Error(error));
          return;
        }
        const header = await api.rpc.chain.getHeader(blockHash);
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          events: [...result.events],
          blockHash,
          blockNumber: header.number.toNumber(),
          error,
          result,
        });
      } catch (error) {
        fail(error);
      }
    };
    tx.signAndSend(signer, { nonce }, onResult)
      .then((unsubscribe) => {
        stop = unsubscribe;
        if (cleanupPending) unsubscribe();
      })
      .catch(fail);
  });
}

const POOL_CONTENTION = /1012|1013|1014|priority is too low|stale|future|usurped|nonce/i;

export async function submitWithRetry(
  api: ApiPromise,
  tx: SubmittableExtrinsic<'promise'>,
  signer: KeyringPair,
  options: SubmitOptions & { attempts?: number; retryDelayMs?: number } = {},
): Promise<SubmitOutcome> {
  const attempts = options.attempts ?? 4;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await submit(api, tx, signer, options);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !POOL_CONTENTION.test(text(error))) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, (options.retryDelayMs ?? 1_000) * attempt),
      );
    }
  }
  throw lastError;
}

export const hasEvent = (events: EventRecord[], section: string, method: string): boolean =>
  events.some((record) => record.event.section === section && record.event.method === method);

export const findEvent = (events: EventRecord[], section: string, method: string) =>
  events.find((record) => record.event.section === section && record.event.method === method)
    ?.event;

export async function waitForBlock(api: ApiPromise, target: number, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let current: number | undefined;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `chain did not reach block ${target} within ${timeoutMs}ms (head ${current ?? 'unknown'})`,
      );
    }
    current = (
      await withDeadline(
        api.rpc.chain.getHeader(),
        remaining,
        `reading chain head while waiting for block ${target}`,
      )
    ).number.toNumber();
    if (current >= target) return;
    const sleepMs = Math.min(500, deadline - Date.now());
    if (sleepMs <= 0) {
      throw new Error(
        `chain did not reach block ${target} within ${timeoutMs}ms (head ${current})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
}

export async function advanceBlocks(api: ApiPromise, count: number, signer: KeyringPair) {
  const remark = api.tx.system?.remark;
  if (!remark) throw new Error('the connected runtime exposes no system.remark call');
  for (let index = 0; index < count; index += 1) {
    await submit(api, remark('e2e:advance'), signer);
  }
}
