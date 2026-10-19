import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The live suite indexes real finalized blocks and submits real extrinsics,
    // so it waits on block production (6s blocks, ~2 blocks to finality) rather
    // than on anything this process controls.
    testTimeout: 240_000,
    hookTimeout: 240_000,
    // The live suite drives one chain and one nonce stream per dev account.
    // Parallel files would race those nonces into spurious "Invalid Transaction"
    // failures, so keep execution serial.
    fileParallelism: false,
  },
});
