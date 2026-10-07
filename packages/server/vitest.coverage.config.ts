import { defineConfig } from 'vitest/config';
import { toPhase13CoverageIncludeGlobs } from './vitest.phase1-3-coverage-scope.js';
import { phase13CoverageReportsDirectory } from './scripts/phase13-coverage-shard.mjs';
import {
  PHASE13_INTEGRATION_COVERAGE_INCLUDE,
  PHASE13_UNIT_COVERAGE_INCLUDE,
  integrationExcludes,
  unitExcludes,
} from './scripts/phase13-coverage-test-files.mjs';

export { unitExcludes };

const coverageSuite = process.env.PHASE13_COVERAGE_SUITE === 'integration' ? 'integration' : 'unit';
const coverageReportsDirectory = phase13CoverageReportsDirectory(
  coverageSuite,
  process.env.PHASE13_COVERAGE_SHARD,
);

const sharedCoverageInclude = [...toPhase13CoverageIncludeGlobs()];

export default defineConfig({
  test: {
    fileParallelism: false,
    // Receipt integration (unit collect passenger) runs the full migration chain
    // in beforeAll; match focused-coverage so unit collect is not the 5s default.
    hookTimeout: 120_000,
    // V8 instrumentation plus the full migration chain can exceed Vitest's 5s
    // default. Integration collect stays at 15s; unit collect matches focused-
    // coverage because it includes product-command-receipt.integration.test.ts.
    testTimeout: coverageSuite === 'integration' ? 15_000 : 60_000,
    include: coverageSuite === 'integration'
      ? [...PHASE13_INTEGRATION_COVERAGE_INCLUDE]
      : [...PHASE13_UNIT_COVERAGE_INCLUDE],
    exclude: coverageSuite === 'integration' ? integrationExcludes : unitExcludes,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary'],
      reportOnFailure: true,
      reportsDirectory: coverageReportsDirectory,
      include: sharedCoverageInclude,
    },
  },
});
