import { defineConfig } from 'vitest/config';

/**
 * Independent Publisher coverage gate.
 *
 * Thresholds are the current non-regression floor (not the Core/Security
 * 90/95 target). Keep them identical to docs/TESTING.md Baseline gates and
 * tests/publisher/publisher-quality-gates-contract.test.ts. Do not fold
 * `src/publisher` into the default `vitest.config.ts` coverage include.
 */
export default defineConfig({
  test: {
    include: [
      'tests/publisher/**/*.test.ts',
      'tests/schema/publish-0005-deletion-receipt-contract.test.ts',
    ],
    pool: 'threads',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage/publisher',
      include: ['src/publisher/**/*.ts'],
      thresholds: {
        branches: 88,
        functions: 99,
        lines: 90,
        statements: 88,
      },
    },
  },
});
