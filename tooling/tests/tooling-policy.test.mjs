import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const vitestWorkspaces = ['sdk', 'agent', 'faucet', 'indexer', 'explorer', 'e2e'];

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8'));
}

test('every workspace uses one exact Vitest version', () => {
  const versions = vitestWorkspaces.map((workspace) => {
    const manifest = readJson(`${workspace}/package.json`);
    return manifest.devDependencies.vitest;
  });

  assert.equal(
    new Set(versions).size,
    1,
    `expected one Vitest version, found ${[...new Set(versions)].join(', ')}`,
  );
});

test('offline suites keep Vitest default timeouts and parallelism', () => {
  for (const workspace of ['faucet', 'indexer', 'explorer']) {
    const config = readFileSync(join(root, workspace, 'vitest.config.ts'), 'utf8');
    assert.doesNotMatch(
      config,
      /testTimeout|hookTimeout|fileParallelism/,
      `${workspace} still has live-suite settings`,
    );
  }
});
