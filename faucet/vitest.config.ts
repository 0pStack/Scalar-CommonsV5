import { defineConfig } from 'vitest/config';
import { coverageConfig } from '../vitest.coverage.mts';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: coverageConfig(['src/chain.ts', 'src/index.ts']),
  },
});