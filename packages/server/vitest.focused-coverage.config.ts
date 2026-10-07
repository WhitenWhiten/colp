/**
 * Focused coverage is a fast signal for transport/command regressions.
 * It is not full-repo coverage and not the Phase 1-3 coverage gate — use `npm run test:unit:coverage` for that.
 */
import { defineConfig } from 'vitest/config';
import {
  PHASE_1_3_FOCUSED_COVERAGE_SIGNAL_FILES,
  toPhase13CoverageIncludeGlobs,
} from './vitest.phase1-3-coverage-scope.js';

const focusedSignalThresholds = Object.fromEntries(
  PHASE_1_3_FOCUSED_COVERAGE_SIGNAL_FILES.map((file) => [
    file,
    {
      branches: 80,
      functions: 85,
      lines: 85,
      statements: 85,
    },
  ]),
);

export default defineConfig({
  test: {
    fileParallelism: false,
    // Receipt integration runs the full migration chain in beforeAll.
    hookTimeout: 120_000,
    testTimeout: 60_000,
    include: [
      'tests/unit/**/*http.test.ts',
      'tests/unit/auth/browser-auth-transport.test.ts',
      // FIX-L-003 Cookie parse-error 400s live here, not in *http.test.ts.
      'tests/unit/auth/session-cookie.test.ts',
      'tests/unit/collections/collection-route-helpers.test.ts',
      'tests/unit/product/product-command-mapping.test.ts',
      'tests/unit/product/product-command-receipt.test.ts',
      'tests/unit/product/product-transport-boundary.test.ts',
      'tests/integration/product/product-command-receipt.integration.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary'],
      reportsDirectory: './coverage/phase1-3/focused',
      include: [...toPhase13CoverageIncludeGlobs()],
      thresholds: {
        perFile: true,
        ...focusedSignalThresholds,
      },
    },
  },
});
