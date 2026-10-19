import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The live suite talks to the devnet RPC and waits for real blocks to be
    // authored (and for one real transfer to be included), so timeouts are
    // block-time generous rather than snappy.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // The live suite signs with a single devnet account and therefore owns one
    // nonce stream. Parallel files would race that nonce and produce spurious
    // "Invalid Transaction" failures, so keep execution serial.
    fileParallelism: false,
  },
});
