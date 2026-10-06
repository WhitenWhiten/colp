/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ignorePatterns: ['reports/**'],
  mutate: [
    // Keep extracted implementation and composition decisions in the local gate.
    'src/server/publication-conditional-get.ts',
    'src/server/publication-snapshot-cursor.ts',
    'src/server/publication-directory-cursor.ts',
    'src/server/publication-cache-policy.ts',
    'src/server/publication-vary.ts',
    'src/server/publication-snapshot-delivery-policy.ts',
    'src/server/publication-snapshot-delivery-policy-core.ts',
    'src/server/publication-public-projection.ts',
  ],
  testFiles: ['tests/**/*.test.ts'],
  testRunner: 'vitest',
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress', 'html', 'json'],
  thresholds: { high: 95, low: 90, break: 85 },
  concurrency: '50%',
  timeoutFactor: 2,
  timeoutMS: 10_000,
  dryRunTimeoutMinutes: 5,
  incremental: false,
  htmlReporter: { fileName: 'reports/mutation/publication/index.html' },
  jsonReporter: { fileName: 'reports/mutation/publication/mutation.json' },
  vitest: { configFile: 'vitest.mutation.config.ts' },
};
