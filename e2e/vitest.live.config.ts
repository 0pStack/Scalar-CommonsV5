import { defineConfig, mergeConfig } from 'vitest/config';
import { MinimumExecutedReporter } from './support/minimum-executed-reporter.js';
import base from './vitest.config.js';

export default mergeConfig(
  base,
  defineConfig({
    test: {
      reporters: ['default', new MinimumExecutedReporter()],
      setupFiles: ['./support/live-guard.ts'],
    },
  }),
);
