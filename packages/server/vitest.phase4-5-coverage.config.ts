import { defineConfig } from 'vitest/config';
import {
  BROWSER_INCLUDE,
  EVIDENCE_INCLUDE,
  REDIS_INCLUDE,
  UNIT_EXCLUDE,
} from './vitest.workspace-projects.js';
import { toPhase45CoverageIncludeGlobs } from './vitest.phase4-5-coverage-scope.js';

const coverageSuite = process.env.PHASE45_COVERAGE_SUITE === 'integration'
  ? 'integration'
  : 'unit';

export const PHASE_4_5_UNIT_COVERAGE_TEST_INCLUDE = Object.freeze([
  'tests/unit/attachments/**/*.test.ts',
  'tests/unit/community/**/*.test.ts',
  'tests/unit/feed/**/*.test.ts',
  'tests/unit/follow/**/*.test.ts',
  'tests/unit/mcp/**/*.test.ts',
  'tests/unit/notifications/**/*.test.ts',
  'tests/unit/phase4a/**/*.test.ts',
  'tests/unit/phase4b/**/*.test.ts',
  'tests/unit/social/**/*.test.ts',
]);

export const PHASE_4_5_INTEGRATION_COVERAGE_TEST_INCLUDE = Object.freeze([
  'tests/integration/community/**/*.integration.test.ts',
  'tests/integration/feed/**/*.integration.test.ts',
  'tests/integration/follow/**/*.integration.test.ts',
  'tests/integration/notifications/**/*.integration.test.ts',
  'tests/integration/phase4a/**/*.integration.test.ts',
  'tests/integration/phase4b/**/*.integration.test.ts',
  'tests/integration/postgres/**/*mcp*.integration.test.ts',
  'tests/integration/social/**/*.integration.test.ts',
]);

/** Preserve the workspace's browser/evidence/static/system lane ownership. */
export const PHASE_4_5_UNIT_COVERAGE_EXCLUDE = Object.freeze([...UNIT_EXCLUDE]);

/**
 * Dedicated acceptance/performance owners. These exercise migration topology,
 * multi-process recovery, or large cardinalities rather than adding executable
 * product-source coverage; keeping them out prevents the coverage signal from
 * inheriting five-minute timing budgets.
 */
export const PHASE_4_5_INTEGRATION_COVERAGE_EXCLUDE = Object.freeze([
  'tests/integration/**/*capacity*.integration.test.ts',
  'tests/integration/**/*continuation*.integration.test.ts',
  'tests/integration/**/*migration*.integration.test.ts',
  'tests/integration/**/*-plan-postgres.integration.test.ts',
  'tests/integration/**/*process*.integration.test.ts',
]);

export default defineConfig({
  test: {
    fileParallelism: coverageSuite === 'unit',
    maxWorkers: coverageSuite === 'unit' ? 4 : 1,
    hookTimeout: 120_000,
    testTimeout: 60_000,
    include: coverageSuite === 'integration'
      ? [...PHASE_4_5_INTEGRATION_COVERAGE_TEST_INCLUDE]
      : [...PHASE_4_5_UNIT_COVERAGE_TEST_INCLUDE],
    exclude: coverageSuite === 'integration'
      ? [
          ...BROWSER_INCLUDE,
          ...EVIDENCE_INCLUDE,
          ...REDIS_INCLUDE,
          ...PHASE_4_5_INTEGRATION_COVERAGE_EXCLUDE,
        ]
      : [...PHASE_4_5_UNIT_COVERAGE_EXCLUDE],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary'],
      reportOnFailure: true,
      reportsDirectory: coverageSuite === 'integration'
        ? './coverage/phase4-5/integration'
        : './coverage/phase4-5/unit',
      include: [...toPhase45CoverageIncludeGlobs()],
    },
  },
});
