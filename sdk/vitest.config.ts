import { defineConfig } from 'vitest/config';
import { coverageConfig } from '../vitest.coverage.mts';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: coverageConfig(),
    // The optional RUN_INTEGRATION suite can wait on a live node.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});