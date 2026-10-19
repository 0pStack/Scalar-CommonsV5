// Re-checks the committed chain-facts.json against a live node.
//
// The build reads facts from a file, which is what keeps it offline and
// reproducible — and also what lets the file go stale. This script closes that
// gap: it reconnects and compares every fact the page can quote against the
// node's current metadata. A mismatch is reported and exits non-zero; it is a
// finding, not something to paper over by regenerating blindly.
//
// Dynamic chain state (block height, agent count, issuance, live auto-params) is
// reported as drift rather than failure — it is a snapshot on the page and is
// labelled as one. Metadata is what must match.
//
// Usage:  npm run verify:chain [-- ws://127.0.0.1:9944]
import { readFileSync } from 'node:fs';
import { connect, readChainFacts, DEFAULT_RPC } from './fetch-chain-facts.mjs';

const committed = JSON.parse(readFileSync(new URL('../chain-facts.json', import.meta.url), 'utf8'));
const endpoint = process.argv[2] ?? committed.provenance.rpc ?? DEFAULT_RPC;

const api = await connect(endpoint);
const live = await readChainFacts(api);
await api.disconnect();

const mismatches = [];
const drift = [];

const compare = (label, expected, actual, sink) => {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    sink.push(`${label}: committed ${JSON.stringify(expected)} != live ${JSON.stringify(actual)}`);
  }
};

// Runtime identity: the page prints these, so they must be exact.
for (const key of ['specName', 'specVersion', 'metadataVersion', 'genesisHash', 'chain', 'ss58Format']) {
  compare(`provenance.${key}`, committed.provenance[key], live.provenance[key], mismatches);
}
for (const key of Object.keys(committed.token)) {
  compare(`token.${key}`, committed.token[key], live.token[key], mismatches);
}

// Metadata constants: every figure quoted on the page comes from here.
for (const [pallet, consts] of Object.entries(committed.constants)) {
  if (!live.constants[pallet]) {
    mismatches.push(`constants.${pallet}: pallet is gone from live metadata`);
    continue;
  }
  for (const [name, value] of Object.entries(consts)) {
    compare(`constants.${pallet}.${name}`, value, live.constants[pallet][name], mismatches);
  }
}

// Pallet indices are append-only in this runtime, and the page cites extrinsics
// by name, so both the index and the call set have to still hold.
for (const pallet of committed.pallets) {
  const livePallet = live.pallets.find((p) => p.name === pallet.name);
  if (!livePallet) {
    mismatches.push(`pallets.${pallet.name}: absent from live metadata`);
    continue;
  }
  compare(`pallets.${pallet.name}.index`, pallet.index, livePallet.index, mismatches);
  for (const call of pallet.calls) {
    if (!livePallet.calls.includes(call)) mismatches.push(`pallets.${pallet.name}.${call}: extrinsic no longer exists`);
  }
}

for (const key of Object.keys(committed.state)) {
  compare(`state.${key}`, committed.state[key], live.state[key], drift);
}

console.log(`verified chain-facts.json against ${endpoint} at block #${live.provenance.readAtBlock}`);
if (drift.length > 0) {
  console.log(`\nsnapshot drift (expected — chain state moves; re-run fetch:chain-facts to refresh):`);
  for (const line of drift) console.log(`  - ${line}`);
}
if (mismatches.length > 0) {
  console.error(`\n${mismatches.length} metadata mismatch(es) — the page would state something untrue:`);
  for (const line of mismatches) console.error(`  - ${line}`);
  process.exitCode = 1;
} else {
  console.log('\nall metadata facts on the page still match the live runtime.');
}
