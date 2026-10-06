import { syncMutationFiles } from './scripts/lib/sync-critical-manifest.mjs';

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  plugins: ['@stryker-mutator/vitest-runner'],
  ignorePatterns: ['reports/**'],
  mutate: [...syncMutationFiles],
  testFiles: [
    'tests/sync/**/*.test.ts',
    'tests/property/core-state-properties.test.ts',
    'tests/integration/reference-host-guard-composition.test.ts',
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
  incrementalFile: 'reports/stryker-sync-incremental.json',
  htmlReporter: { fileName: 'reports/mutation/sync/index.html' },
  jsonReporter: { fileName: 'reports/mutation/sync/mutation.json' },
  vitest: { configFile: 'vitest.mutation.config.ts' },
};
