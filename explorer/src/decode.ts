/**
 * Decoding a block's contents into the explorer's view models.
 *
 * Pure functions over already-fetched codecs: the extrinsics of a block, its
 * event records, and the registry the runtime metadata built. Nothing here
 * talks to a node, which is what lets the decode and outcome logic be tested
 * offline against static metadata rather than only against a live chain.
 */

import type { ApiPromise } from '@polkadot/api';
import type { Codec, Registry } from '@polkadot/types-codec/types';
import type { DispatchError, EventRecord, Extrinsic } from '@polkadot/types/interfaces';

import { collectAccounts } from './accounts.js';
import type { BlockRef } from './routes.js';
import type { EventView, ExtrinsicArg, Outcome } from './types.js';

/** Asked for a block the chain does not have (yet, or ever). */
export class BlockNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockNotFoundError';
  }
}

/** The two block-resolution RPCs, so resolution can be exercised without a node. */
export type BlockResolverRpc = Pick<ApiPromise['rpc']['chain'], 'getBlockHash' | 'getHeader'>;

/** Renders a decoded value the way a reader wants it: plain when it is plain, JSON when it is structured. */
function humanValue(value: Codec): string {
  const human = value.toHuman();
  return typeof human === 'string' ? human : JSON.stringify(human);
}

/** Reads a numeric codec as a bigint without going through `number` (balances exceed 2^53). */
export function toBigInt(value: Codec | undefined | null): bigint | null {
  if (value === undefined || value === null) {
    return null;
  }
  const maybe = value as { toBigInt?: () => bigint };
  return typeof maybe.toBigInt === 'function' ? maybe.toBigInt() : BigInt(value.toString());
}

/** One extrinsic, fully decoded — the block, extrinsic and account views are all projections of this. */
export interface DecodedExtrinsic {
  readonly index: number;
  readonly section: string;
  readonly method: string;
  readonly hash: string;
  readonly isSigned: boolean;
  readonly signer: string | null;
  readonly nonce: number | null;
  readonly tip: bigint | null;
  readonly lengthBytes: number;
  readonly args: readonly ExtrinsicArg[];
  readonly events: readonly EventView[];
  readonly outcome: Outcome;
  readonly accounts: readonly string[];
}

/** Turns a URL block reference into the (number, hash) pair everything else works from. */
export async function resolveBlock(
  rpc: BlockResolverRpc,
  ref: BlockRef,
): Promise<{ number: number; hash: string }> {
  if (ref.kind === 'number') {
    const hash = await rpc.getBlockHash(ref.number);
    // A block the chain has not authored yet answers with the zero hash
    // rather than an error, so this check is what turns "the future" into 404.
    if (hash.isEmpty) {
      throw new BlockNotFoundError(`block ${ref.number} not found on this chain`);
    }
    return { number: ref.number, hash: hash.toHex() };
  }
  try {
    const header = await rpc.getHeader(ref.hash);
    return { number: header.number.toNumber(), hash: header.hash.toHex() };
  } catch (error) {
    throw new BlockNotFoundError(
      `block ${ref.hash} not found on this chain (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
}

/** Reads the dispatch outcome of one extrinsic out of the block's event records. */
export function outcomeOf(registry: Registry, records: readonly EventRecord[]): Outcome {
  for (const record of records) {
    if (record.event.section !== 'system') {
      continue;
    }
    if (record.event.method === 'ExtrinsicSuccess') {
      return { kind: 'success' };
    }
    if (record.event.method === 'ExtrinsicFailed') {
      // The first field of the event is the `DispatchError` the runtime
      // returned; it is decoded from metadata like everything else here.
      const dispatchError = record.event.data[0] as DispatchError | undefined;
      if (dispatchError === undefined) {
        return { kind: 'failed', reason: 'ExtrinsicFailed carried no error' };
      }
      if (dispatchError.isModule) {
        // Module errors are indices into metadata; resolving them through the
        // registry is what turns "Module { index: 26, error: [3,0,0,0] }" into
        // "agents.NotRegistered" without hard-coding a single error name here.
        const meta = registry.findMetaError(dispatchError.asModule);
        return { kind: 'failed', reason: `${meta.section}.${meta.name}` };
      }
      return { kind: 'failed', reason: dispatchError.type };
    }
  }
  return { kind: 'unknown' };
}

/** Names each event field from metadata, falling back to its position for unnamed tuple variants. */
export function eventView(record: EventRecord, index: number): EventView {
  const fieldsMeta = record.event.meta.fields;
  const fields = record.event.data.map((value, position) => {
    const name = fieldsMeta[position]?.name;
    return {
      name: name !== undefined && name.isSome ? name.unwrap().toString() : String(position),
      value: humanValue(value),
    };
  });
  return {
    index,
    section: record.event.section,
    method: record.event.method,
    fields,
  };
}

/** An event record together with the position the node gave it in the block's event list. */
interface PositionedRecord {
  readonly position: number;
  readonly record: EventRecord;
}

/**
 * Groups a block's event records by the extrinsic that emitted them, in one pass.
 *
 * Each record keeps the position it holds in the block's event list, so the
 * rendered event number is the node's own index. Filtering the whole list once
 * per extrinsic instead would be O(extrinsics × events), and every block page
 * pays that cost. Initialization and finalization events belong to no
 * extrinsic and are left out.
 */
export function groupEventsByExtrinsic(
  records: readonly EventRecord[],
): ReadonlyMap<number, readonly PositionedRecord[]> {
  const groups = new Map<number, PositionedRecord[]>();
  records.forEach((record, position) => {
    const phase = record.phase;
    if (!phase.isApplyExtrinsic) {
      return;
    }
    const index = phase.asApplyExtrinsic.toNumber();
    const group = groups.get(index);
    if (group === undefined) {
      groups.set(index, [{ position, record }]);
    } else {
      group.push({ position, record });
    }
  });
  return groups;
}

/** Decodes every extrinsic of a block with its arguments, events, outcome and the accounts it touched. */
export function decodeExtrinsics(
  registry: Registry,
  extrinsics: readonly Extrinsic[],
  records: readonly EventRecord[],
  ss58Format: number,
): DecodedExtrinsic[] {
  const byExtrinsic = groupEventsByExtrinsic(records);
  return extrinsics.map((extrinsic, index): DecodedExtrinsic => {
    const mine = byExtrinsic.get(index) ?? [];

    const argsMeta = extrinsic.method.meta.args;
    const args = extrinsic.method.args.map((value, position): ExtrinsicArg => {
      const meta = argsMeta[position];
      const typeName = meta?.typeName;
      return {
        name: meta ? meta.name.toString() : String(position),
        type:
          typeName !== undefined && typeName.isSome
            ? typeName.unwrap().toString()
            : (meta?.type.toString() ?? value.toRawType()),
        value: humanValue(value),
      };
    });

    // The signer is an `Address` (a MultiAddress on this runtime), so it is
    // resolved through the same codec walk as everything else rather than by
    // assuming which variant it is.
    const signer = extrinsic.isSigned
      ? (collectAccounts([extrinsic.signer], ss58Format)[0] ?? null)
      : null;

    const accounts = collectAccounts(
      [
        ...(extrinsic.isSigned ? [extrinsic.signer] : []),
        ...extrinsic.method.args,
        ...mine.flatMap(({ record }) => Array.from(record.event.data)),
      ],
      ss58Format,
    );

    return {
      index,
      section: extrinsic.method.section,
      method: extrinsic.method.method,
      hash: extrinsic.hash.toHex(),
      isSigned: extrinsic.isSigned,
      signer,
      nonce: extrinsic.isSigned ? extrinsic.nonce.toNumber() : null,
      tip: extrinsic.isSigned ? extrinsic.tip.toBigInt() : null,
      lengthBytes: extrinsic.encodedLength,
      args,
      events: mine.map(({ position, record }) => eventView(record, position)),
      outcome: outcomeOf(
        registry,
        mine.map(({ record }) => record),
      ),
      accounts,
    };
  });
}
