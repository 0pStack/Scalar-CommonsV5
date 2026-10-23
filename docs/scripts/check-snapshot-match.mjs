#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const committedPath = resolve(HERE, '..', '.chain', 'snapshot.json');
const candidatePath = process.env.SNAPSHOT_CANDIDATE;

if (!candidatePath) {
  console.error('✗ SNAPSHOT_CANDIDATE must point at a generated snapshot');
  process.exit(1);
}

const committed = JSON.parse(readFileSync(committedPath, 'utf8'));
const candidate = JSON.parse(readFileSync(resolve(candidatePath), 'utf8'));
const runtimeSurface = ({
  chain,
  runtime,
  properties,
  pallets,
  consts,
  extrinsics,
  storage,
  runtimeApis,
  rpcMethods,
}) => ({
  chain,
  runtime,
  properties,
  pallets,
  consts,
  extrinsics,
  storage,
  runtimeApis,
  rpcMethods,
});

const expected = runtimeSurface(committed);
const actual = runtimeSurface(candidate);
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  const changed = Object.keys(expected).filter(
    (key) => JSON.stringify(actual[key]) !== JSON.stringify(expected[key]),
  );
  console.error(
    `✗ committed docs snapshot differs from the ci-full runtime surface: ${changed.join(', ')}`,
  );
  console.error('  Regenerate it with `npm run snapshot:chain -w docs` using this runtime.');
  process.exit(1);
}

console.log(
  `✓ committed docs snapshot matches ${candidate.runtime.specName} spec ${candidate.runtime.specVersion}`,
);
