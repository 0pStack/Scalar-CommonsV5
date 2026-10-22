import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      // Live RPC adapters and process entrypoints are exercised by e2e/devnet suites.
      exclude: ['src/**/*.d.ts', 'src/accounts.ts', 'src/chain.ts', 'src/index.ts'],
      thresholds: { lines: 80, statements: 80 },
    },
  },
});
