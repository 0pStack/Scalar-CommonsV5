import { defineConfig } from 'vitest/config';

// `vitest run --mode integration` (`npm run test:integration`) sets RUN_INTEGRATION=1 here
// rather than in the npm script, so the opt-in live suites run the same under cmd,
// PowerShell and POSIX shells.
export default defineConfig(({ mode }) => ({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      thresholds: { lines: 80, statements: 80 },
    },
    env: mode === 'integration' ? { RUN_INTEGRATION: '1' } : {},
    // The optional RUN_INTEGRATION suite can wait on a live node.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
}));
