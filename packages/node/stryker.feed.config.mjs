/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  plugins: ['@stryker-mutator/vitest-runner'],
  ignorePatterns: ['reports/**'],
  mutate: ['src/feed/**/*.ts'],
  testFiles: [
    'tests/feed/**/*.test.ts',
    'tests/property/publication-properties.test.ts',
  ],
  testRunner: 'vitest',
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress', 'html', 'json'],
  thresholds: { high: 80, low: 65, break: 65 },
  concurrency: '100%',
  timeoutFactor: 2,
  timeoutMS: 10_000,
  dryRunTimeoutMinutes: 5,
  incremental: true,
  incrementalFile: 'reports/stryker-feed-incremental.json',
  htmlReporter: { fileName: 'reports/mutation/feed/index.html' },
  jsonReporter: { fileName: 'reports/mutation/feed/mutation.json' },
  vitest: { configFile: 'vitest.mutation.config.ts' },
};
