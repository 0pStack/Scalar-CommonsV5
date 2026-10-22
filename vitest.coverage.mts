export function coverageConfig(exclude: string[] = []) {
  return {
    provider: 'v8' as const,
    reporter: ['text', 'json-summary'] as const,
    include: ['src/**/*.ts'],
    // Live RPC adapters and process entrypoints are exercised by e2e/devnet suites.
    // The CI threshold covers the deterministic code that can run offline.
    exclude: ['src/**/*.d.ts', ...exclude],
    thresholds: {
      lines: 80,
      statements: 80,
    },
  };
}