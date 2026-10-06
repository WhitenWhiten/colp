import { syncCoreCoverageFiles } from './scripts/lib/sync-critical-manifest.mjs';
import { defineConfig } from 'vitest/config';

/**
 * Independent Sync Core-used (Tier A) coverage gate (U-3).
 *
 * `coverage.include` must stay aligned with the Tier A rows in
 * `docs/TESTING.md` → "Sync Core-used coverage manifest". Do not add Tier B/C
 * paths to inflate numbers. Thresholds are the U-3 acceptance floor
 * (lines 95 / branches 90) after measured Tier A met the target.
 */
export default defineConfig({
  test: {
    include: [
      'tests/sync/**/*.test.ts',
      'tests/property/core-state-properties.test.ts',
      'tests/integration/reference-host-guard-composition.test.ts',
    ],
    pool: 'threads',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage/sync-core',
      include: [...syncCoreCoverageFiles],
      thresholds: {
        branches: 90,
        functions: 98,
        lines: 95,
        statements: 90,
      },
    },
  },
});
