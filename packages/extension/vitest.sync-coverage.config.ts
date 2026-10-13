import { defineConfig } from 'vitest/config';

import { SYNC_CORE_COVERAGE_FILES } from './scripts/check-sync-coverage-ratchet.mjs';

/**
 * Per-file Sync coverage gate (SYNC-Q-021).
 *
 * The per-file baseline uses Vitest 4's AST-based V8 remapping. Pull and
 * new-file branch floors remain 80% across the coverage-provider migration.
 *
 * `coverage.include` is the Sync core list only. Pass/fail is the shrinking
 * per-file ratchet in `scripts/check-sync-coverage-ratchet.mjs`, not a global
 * average threshold that could hide a hollow file.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/sync-compaction-benchmark.test.ts'],
    pool: 'threads',
    // IndexedDB scaling fixtures run with V8 instrumentation on CI's small runners.
    maxWorkers: 2,
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage/sync',
      include: [...SYNC_CORE_COVERAGE_FILES],
      thresholds: { branches: 80 },
    },
  },
});
