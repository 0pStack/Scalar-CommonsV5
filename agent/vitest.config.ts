import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/chain.ts', 'src/keygen.ts', 'src/main.ts', 'src/onboard.ts'],
      thresholds: { lines: 80, statements: 80 },
    },
  },
});
