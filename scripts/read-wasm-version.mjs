#!/usr/bin/env node
/**
 * scripts/read-wasm-version.mjs — read the spec_version out of a runtime blob.
 *
 *   node scripts/read-wasm-version.mjs <runtime.compact.wasm> [--expect 305]
 *
 * Reads the `runtime_version` custom section from the wasm itself, NOT from
 * runtime/src/lib.rs. That distinction is the whole point: a stale build
 * directory or a copied-from-the-wrong-place blob has the old version embedded
 * while the source says the new one, and the only place that discrepancy is
 * visible is the blob.
 *
 * With --expect, exits non-zero unless the embedded version matches, so it can
 * be used as an abort condition in an upgrade runbook.
 *
 * Accepts either the uncompressed `*.compact.wasm` or the
 * `*.compact.compressed.wasm` that actually gets submitted — the latter is the
 * same module behind Substrate's 8-byte marker plus a zstd stream, which this
 * unwraps. Reading the compressed one matters for a rollback check: the blob
 * pulled out of on-chain `:code` is compressed, and confirming ITS version is
 * how you know the rollback artefact is what you think it is.
 */

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const CANDIDATES = ['../sdk/package.json', '../indexer/package.json'];
function loadPolkadot(pkg) {
  let lastErr;
  for (const c of CANDIDATES) {
    try {
      const req = createRequire(pathResolve(HERE, c));
      return import(pathToFileURL(req.resolve(pkg)).href);
    } catch (e) { lastErr = e; }
  }
  throw new Error(`cannot resolve ${pkg} from sdk/ or indexer/ node_modules (${lastErr && lastErr.message})`);
}
const { TypeRegistry } = await loadPolkadot('@polkadot/types');

const argv = process.argv.slice(2);
let file = null, expect = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--expect') expect = Number(argv[++i]);
  else if (argv[i].startsWith('-')) { console.error(`unrecognised flag: ${argv[i]}`); process.exit(2); }
  else file = argv[i];
}
if (!file) { console.error('usage: node scripts/read-wasm-version.mjs <runtime.compact.wasm> [--expect N]'); process.exit(2); }
if (!existsSync(file)) { console.error(`FATAL: ${file} not found`); process.exit(1); }

const buf = readFileSync(file);

// Substrate's compressed blobs carry this 8-byte marker before the zstd stream.
const ZSTD_PREFIX = Buffer.from([0x52, 0xbc, 0x53, 0x76, 0x46, 0xdb, 0x8e, 0x05]);
let wasmBuf = buf;
let compressed = false;
if (buf.subarray(0, 8).equals(ZSTD_PREFIX)) {
  compressed = true;
  try {
    wasmBuf = zstdDecompressSync(buf.subarray(8));
  } catch (e) {
    console.error('FATAL: blob carries the Substrate zstd marker but did not decompress: ' + e.message);
    process.exit(1);
  }
}
const buf2 = wasmBuf;
if (!(buf2[0] === 0x00 && buf2[1] === 0x61 && buf2[2] === 0x73 && buf2[3] === 0x6d)) {
  console.error(`FATAL: ${file} is not a wasm module (bad magic number)`);
  process.exit(1);
}

// --- minimal wasm section walk --------------------------------------------
// Sections are (id: u8, size: uleb128, payload). A custom section has id 0 and
// its payload begins with a uleb128-length name. Only custom sections are of
// interest, so everything else is skipped by size.
function uleb(b, o) {
  let r = 0, s = 0, n = 0;
  for (;;) { const x = b[o + n]; r |= (x & 0x7f) << s; n++; if (!(x & 0x80)) break; s += 7; }
  return [r, n];
}

let off = 8; // past magic + version
let section = null;
while (off < buf2.length) {
  const id = buf2[off]; off += 1;
  const [size, n] = uleb(buf2, off); off += n;
  const end = off + size;
  if (id === 0) {
    const [nameLen, nn] = uleb(buf2, off);
    const name = buf2.subarray(off + nn, off + nn + nameLen).toString('utf8');
    if (name === 'runtime_version') { section = buf2.subarray(off + nn + nameLen, end); break; }
  }
  off = end;
}

if (!section) {
  console.error('FATAL: no `runtime_version` custom section in this blob.');
  console.error('The blob may have been stripped, or it is not a Substrate runtime.');
  process.exit(1);
}

const registry = new TypeRegistry();
const ver = registry.createType('RuntimeVersion', section);
const specVersion = ver.specVersion.toNumber();

console.log('  file            : ' + file);
console.log('  form            : ' + (compressed ? 'zstd-compressed (unwrapped to read)' : 'uncompressed'));
console.log('  spec_name       : ' + ver.specName.toString());
console.log('  impl_name       : ' + ver.implName.toString());
console.log('  spec_version    : ' + specVersion);
console.log('  impl_version    : ' + ver.implVersion.toNumber());
console.log('  transaction_ver : ' + ver.transactionVersion.toNumber());
console.log('  apis            : ' + ver.apis.length + ' entries');

if (expect !== null) {
  if (specVersion !== expect) {
    console.error(`\nFAILED: embedded spec_version is ${specVersion}, expected ${expect}.`);
    process.exit(1);
  }
  console.log(`\n  OK — embedded spec_version is ${expect}.`);
}
