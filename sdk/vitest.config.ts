import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      thresholds: { lines: 80, statements: 80 },
    },
    // The optional RUN_INTEGRATION suite can wait on a live node.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
