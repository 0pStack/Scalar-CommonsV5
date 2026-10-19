import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Chain interactions can be slow when an integration node is present.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
