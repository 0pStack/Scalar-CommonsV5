// Reads the event names every pallet declares from a running node's runtime
// metadata and writes them to chain-events.json, with the spec version,
// genesis hash and block they were read at. The observatory's tests check
// every event list it reads (`/v1/events?section=…&method=…`) against this
// file, so a page can never count an event the runtime does not emit.
//
// Plain JSON-RPC over HTTPS (state_getMetadata), decoded offline with
// @polkadot/types; no socket is held open.
//
//   npm run fetch:chain-events                    # from https://rpc.scalarnet.io
//   npm run fetch:chain-events -- https://…       # or another endpoint

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Metadata, TypeRegistry } from '@polkadot/types';

const endpoint = process.argv[2] ?? 'https://rpc.scalarnet.io';
const out = fileURLToPath(new URL('../chain-events.json', import.meta.url));

let id = 0;
async function rpc(method, params = []) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: (id += 1), jsonrpc: '2.0', method, params }),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const header = await rpc('chain_getHeader');
const at = await rpc('chain_getBlockHash', [header.number]);
const [hex, version, genesis] = await Promise.all([
  rpc('state_getMetadata', [at]),
  rpc('state_getRuntimeVersion', [at]),
  rpc('chain_getBlockHash', [0]),
]);

const registry = new TypeRegistry();
const metadata = new Metadata(registry, hex);
registry.setMetadata(metadata);

/** A pallet's section as polkadot-js (and so the indexer) names it: the pallet name with a lower-case first letter. */
const section = (name) => name.charAt(0).toLowerCase() + name.slice(1);

const pallets = {};
for (const pallet of metadata.asLatest.pallets) {
  if (pallet.events.isNone) continue;
  const type = registry.lookup.getSiType(pallet.events.unwrap().type);
  pallets[section(pallet.name.toString())] = type.def.asVariant.variants.map((v) => v.name.toString()).sort();
}

const record = {
  provenance: {
    endpoint,
    specName: version.specName,
    specVersion: version.specVersion,
    genesisHash: genesis,
    readAtBlock: parseInt(header.number, 16),
    readAtHash: at,
    readAt: new Date().toISOString(),
    metadataVersion: metadata.version,
  },
  pallets,
};
writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
console.log(
  `chain-events.json: ${Object.keys(pallets).length} pallets' events from ${version.specName} spec ${version.specVersion}, block #${record.provenance.readAtBlock}`,
);
