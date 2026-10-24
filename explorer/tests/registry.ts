import { Metadata, TypeRegistry, expandMetadata } from '@polkadot/types';
import type { EventRecord, Extrinsic, RuntimeVersion } from '@polkadot/types/interfaces';
import { u8aConcat } from '@polkadot/util';
import staticSubstrate from '@polkadot/types-support/metadata/static-substrate';

/**
 * A metadata-backed registry with no node behind it.
 *
 * The static Substrate metadata polkadot-js ships stands in for the runtime's:
 * what is under test is the explorer reading shapes from metadata, so any real
 * metadata exercises it, and this one needs no running chain.
 */
export const registry = new TypeRegistry();
const metadata = new Metadata(registry, staticSubstrate);
registry.setMetadata(metadata);

export const tx = expandMetadata(registry, metadata).tx;

export const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
export const BOB = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

/** A pallet's event or error variant, looked up by name rather than by a hard-coded index. */
function variant(pallet: string, kind: 'events' | 'errors', name: string) {
  const found = metadata.asLatest.pallets.find((entry) => entry.name.eq(pallet));
  if (found === undefined || found[kind].isNone) {
    throw new Error(`static metadata has no ${pallet} ${kind}`);
  }
  const def = registry.lookup.getSiType(found[kind].unwrap().type).def.asVariant;
  const entry = def.variants.find((candidate) => candidate.name.eq(name));
  if (entry === undefined) {
    throw new Error(`static metadata has no ${pallet}.${name}`);
  }
  return { palletIndex: found.index.toNumber(), entry };
}

/** The `DispatchError::Module` value for a named pallet error. */
export function moduleError(pallet: string, name: string): { Module: object } {
  const { palletIndex, entry } = variant(pallet, 'errors', name);
  return {
    Module: { index: palletIndex, error: new Uint8Array([entry.index.toNumber(), 0, 0, 0]) },
  };
}

export type Phase = { ApplyExtrinsic: number } | 'Finalization' | 'Initialization';

/** One event record, encoded field by field against the metadata's own types. */
export function eventRecord(
  phase: Phase,
  pallet: string,
  name: string,
  values: readonly unknown[],
): EventRecord {
  const { palletIndex, entry } = variant(pallet, 'events', name);
  const data = entry.fields.map((field, position) =>
    registry.createTypeUnsafe(registry.createLookupType(field.type), [values[position]]).toU8a(),
  );
  const event = registry.createType(
    'Event',
    u8aConcat(new Uint8Array([palletIndex, entry.index.toNumber()]), ...data),
  );
  return registry.createType('EventRecord', { phase, event, topics: [] });
}

export const success = (index: number): EventRecord =>
  eventRecord({ ApplyExtrinsic: index }, 'System', 'ExtrinsicSuccess', [{}]);

/** An unsigned `balances.transferKeepAlive` to BOB. */
export function transfer(amount: bigint): Extrinsic {
  return registry.createType('Extrinsic', tx.balances!.transferKeepAlive!({ Id: BOB }, amount));
}

/** The same transfer, signed by ALICE with a fake signature: decoding never verifies it. */
export function signedTransfer(amount: bigint, nonce: number, tip: number): Extrinsic {
  const extrinsic = transfer(amount);
  extrinsic.signFake(ALICE, {
    nonce,
    tip,
    blockHash: `0x${'11'.repeat(32)}`,
    genesisHash: `0x${'22'.repeat(32)}`,
    runtimeVersion: registry.createType('RuntimeVersion', {
      specVersion: 1,
      transactionVersion: 1,
    }) as RuntimeVersion,
  });
  return extrinsic;
}
