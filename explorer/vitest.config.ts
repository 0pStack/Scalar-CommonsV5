import { defineConfig } from 'vitest/config';
import { coverageConfig } from '../vitest.coverage.mts';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: coverageConfig(['src/accounts.ts', 'src/chain.ts', 'src/index.ts']),
  },
});
