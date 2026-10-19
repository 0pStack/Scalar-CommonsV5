import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.ts', '**/*.test.mjs'],
    exclude: ['**/node_modules/**'],
    // The live suites wait on real block production and finality (6 s blocks),
    // so timeouts are block-time generous: the indexer suite needed the most.
    testTimeout: 240_000,
    hookTimeout: 240_000,
    // Every live suite signs with genesis dev accounts and owns their nonce
    // streams. Parallel files would race those nonces into spurious
    // "Invalid Transaction" failures, so files run one at a time.
    fileParallelism: false,
  },
});
