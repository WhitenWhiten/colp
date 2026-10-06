/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  plugins: ['@stryker-mutator/vitest-runner'],
  ignorePatterns: ['reports/**'],
  ignoreStatic: true,
  mutator: {
    // Error labels are diagnostic text, not part of the Publisher protocol contract.
    excludedMutations: ['StringLiteral'],
  },
  mutate: [
    // Complete semantic modules keep mutation ownership stable across edits.
    'src/publisher/index.ts',
    'src/publisher/media-type.ts',
    'src/publisher/deletion-receipt.ts',
    'src/publisher/node-move.ts',
    'src/server/node-write-guard.ts',
    'src/shared/plain-structured-data.ts',
    'src/shared/dense-array-keys.ts',
  ],
  testFiles: ['tests/**/*.test.ts'],
  testRunner: 'vitest',
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress', 'html', 'json'],
  thresholds: { high: 90, low: 85, break: 80 },
  concurrency: '50%',
  timeoutFactor: 2,
  timeoutMS: 10_000,
  dryRunTimeoutMinutes: 5,
  incremental: false,
  htmlReporter: { fileName: 'reports/mutation/publisher/index.html' },
  jsonReporter: { fileName: 'reports/mutation/publisher/mutation.json' },
  vitest: { configFile: 'vitest.mutation.config.ts' },
};
