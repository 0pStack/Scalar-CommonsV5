import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The integration suite talks to the live devnet and waits for real blocks
    // to be produced, so timeouts are block-time generous rather than snappy.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // The live-chain suite shares one funded faucet account (Ferdie) and one
    // nonce stream. Running files in parallel would race the nonce and produce
    // spurious "Invalid Transaction" failures, so keep execution serial.
    fileParallelism: false,
  },
});
