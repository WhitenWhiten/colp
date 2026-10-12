import { defineConfig } from 'vitest/config';

import { SYNC_CORE_COVERAGE_FILES } from './scripts/check-sync-coverage-ratchet.mjs';

/**
 * Per-file Sync coverage gate (SYNC-Q-021).
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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage/sync',
      all: true,
      include: [...SYNC_CORE_COVERAGE_FILES],
      thresholds: { branches: 80 },
    },
  },
});
