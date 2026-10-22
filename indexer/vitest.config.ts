import { defineConfig } from 'vitest/config';
import { coverageConfig } from '../vitest.coverage.mts';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: coverageConfig([
      'src/api.ts',
      'src/chain.ts',
      'src/chainState.ts',
      'src/config.ts',
      'src/index.ts',
      'src/indexer.ts',
      'src/ingest.ts',
    ]),
  },
});