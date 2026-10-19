/**
 * Turning a finalized block into index rows.
 *
 * The chain speaks SCALE; the REST surface speaks JSON. This module is the only
 * place that translation happens, and it holds one rule above all others:
 * integers wider than 32 bits leave as decimal strings. Stakes (10^16 plancks),
 * era emissions (10^18) and the supply cap (10^23) are all past
 * `Number.MAX_SAFE_INTEGER`, and a rounded balance in an economic API is worse
 * than no balance at all.
 */

import type { ApiPromise } from '@polkadot/api';
import type { Codec } from '@polkadot/types-codec/types';

import { accountsFromArgs, extrinsicId, eventId, type DecodedArg } from './decode.ts';
import type { EventRow, ExtrinsicRow, IndexedBlock } from './store.ts';

/** Widths at or below this are safe as JSON numbers; wider ones become strings. */
const SAFE_INTEGER_BITS = 32;

/**
 * Converts a decoded chain value into a plain JSON value.
 *
 * Deliberately not `toJSON()`: polkadot-js renders wide integers as hex, which
 * is a lossless but hostile shape for an API consumer, and renders `AccountId`
 * as hex rather than SS58.
 */
export function plain(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  const codec = value as Codec & Record<string, any>;

  const rawType = typeof codec.toRawType === 'function' ? String(codec.toRawType()) : '';

  // `Option<T>` is recognised by its type, never by `isNone`. polkadot-js sets
  // `isNone` on any enum whose selected variant carries no payload, so trusting
  // that flag turns `paysFee: "Yes"` — and every other simple enum on the
  // chain — into `null`.
  if (rawType.startsWith('Option<')) {
    return codec.isNone === true ? null : plain(codec.unwrap());
  }

  // Addresses are emitted SS58-encoded — the form every other tool on this
  // chain (wallets, the faucet, chain specs) uses. Anchored, so a
  // `Vec<AccountId32>` is recursed into rather than stringified whole.
  if (/^AccountId/.test(rawType) && typeof codec.toString === 'function') {
    return codec.toString();
  }

  // Byte arrays — hashes, proofs, deliverable digests — as hex.
  if (codec instanceof Uint8Array) {
    return typeof codec.toHex === 'function' ? codec.toHex() : `0x${Buffer.from(codec).toString('hex')}`;
  }

  if (Array.isArray(codec)) {
    return codec.map(plain);
  }

  if (typeof codec.toBigInt === 'function') {
    const big = codec.toBigInt() as bigint;
    const bits = typeof codec.bitLength === 'function' ? Number(codec.bitLength()) : 128;
    return bits > SAFE_INTEGER_BITS ? big.toString() : Number(big);
  }

  if (typeof codec.isTrue === 'boolean' || typeof codec.isFalse === 'boolean') {
    return codec.isTrue === true;
  }

  // Structs are Maps in polkadot-js; recurse so nested balances follow the
  // same string rule as top-level ones.
  if (codec instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of codec.entries()) {
      out[String(key)] = plain(entry);
    }
    return out;
  }

  // Enums expose the selected variant and its payload.
  if (typeof codec.type === 'string' && 'value' in codec && typeof codec.toJSON === 'function') {
    const payload = plain(codec.value);
    return payload === null || (typeof payload === 'object' && Object.keys(payload as object).length === 0)
      ? codec.type
      : { type: codec.type, value: payload };
  }

  return typeof codec.toJSON === 'function' ? codec.toJSON() : String(codec);
}

/** The phase of a block an event was emitted in. */
function phaseName(phase: Codec & Record<string, any>): string {
  if (phase.isApplyExtrinsic === true) return 'ApplyExtrinsic';
  if (phase.isFinalization === true) return 'Finalization';
  if (phase.isInitialization === true) return 'Initialization';
  return phase.type ?? 'Unknown';
}

/**
 * Reads one block from the node and shapes it for the index.
 *
 * State is read at the block's own hash (`api.at`), not at the head: decoding a
 * historical block against current metadata is how an indexer starts reporting
 * fiction after a runtime upgrade.
 */
export async function fetchIndexedBlock(api: ApiPromise, blockNumber: number): Promise<IndexedBlock> {
  const blockHash = await api.rpc.chain.getBlockHash(blockNumber);
  if (blockHash.isEmpty) {
    throw new Error(`node has no block at height ${blockNumber}`);
  }

  const [signedBlock, apiAt] = await Promise.all([api.rpc.chain.getBlock(blockHash), api.at(blockHash)]);
  const systemEvents = apiAt.query.system?.events;
  if (systemEvents === undefined) {
    throw new Error('runtime does not expose system.events; cannot index this block');
  }
  const eventRecords = await systemEvents();
  const header = signedBlock.block.header;

  const extrinsics: ExtrinsicRow[] = signedBlock.block.extrinsics.map((extrinsic, index) => {
    const { method, section } = extrinsic.method;
    const argMeta = extrinsic.method.meta.args;
    const args: Record<string, unknown> = {};
    extrinsic.method.args.forEach((arg, argIndex) => {
      const name = argMeta[argIndex]?.name.toString() ?? `arg${argIndex}`;
      args[name] = plain(arg);
    });

    return {
      id: extrinsicId(blockNumber, index),
      blockNumber,
      index,
      hash: extrinsic.hash.toHex(),
      section,
      method,
      signer: extrinsic.isSigned ? extrinsic.signer.toString() : null,
      nonce: extrinsic.isSigned ? extrinsic.nonce.toNumber() : null,
      tipPlancks: extrinsic.isSigned ? extrinsic.tip.toBigInt().toString() : null,
      // Filled in from the block's own events below: an extrinsic that was
      // included is not necessarily an extrinsic that succeeded.
      success: null,
      args,
    };
  });

  const events: EventRow[] = [];
  (eventRecords as unknown as any[]).forEach((record, index) => {
    const { event, phase } = record;
    const fields = event.meta.fields;
    const decodedArgs: DecodedArg[] = event.data.map((datum: Codec, argIndex: number) => ({
      name: fields[argIndex]?.name?.isSome ? fields[argIndex].name.unwrap().toString() : `arg${argIndex}`,
      type: typeof datum.toRawType === 'function' ? datum.toRawType() : '',
      value: plain(datum),
    }));

    const data: Record<string, unknown> = {};
    for (const arg of decodedArgs) {
      data[arg.name] = arg.value;
    }

    let linkedExtrinsicId: string | null = null;
    if (phase.isApplyExtrinsic) {
      const appliedTo = phase.asApplyExtrinsic.toNumber();
      linkedExtrinsicId = extrinsicId(blockNumber, appliedTo);
      const target = extrinsics[appliedTo];
      if (target) {
        if (event.section === 'system' && event.method === 'ExtrinsicSuccess') {
          target.success = true;
        } else if (event.section === 'system' && event.method === 'ExtrinsicFailed') {
          target.success = false;
        }
      }
    }

    events.push({
      id: eventId(blockNumber, index),
      blockNumber,
      index,
      section: event.section,
      method: event.method,
      phase: phaseName(phase),
      extrinsicId: linkedExtrinsicId,
      data,
      accounts: accountsFromArgs(decodedArgs),
    });
  });

  // The block's own clock, from the `timestamp.set` inherent every block carries.
  const timestampExtrinsic = signedBlock.block.extrinsics.find(
    (extrinsic) => extrinsic.method.section === 'timestamp' && extrinsic.method.method === 'set',
  );
  const timestampMs = timestampExtrinsic
    ? Number((timestampExtrinsic.method.args[0] as unknown as { toBigInt(): bigint }).toBigInt())
    : null;

  return {
    block: {
      number: blockNumber,
      hash: blockHash.toHex(),
      parentHash: header.parentHash.toHex(),
      stateRoot: header.stateRoot.toHex(),
      extrinsicsRoot: header.extrinsicsRoot.toHex(),
      timestampMs,
      extrinsicCount: extrinsics.length,
      eventCount: events.length,
    },
    extrinsics,
    events,
  };
}
