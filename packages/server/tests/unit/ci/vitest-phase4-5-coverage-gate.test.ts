import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import { parse } from 'yaml';
import { SYSTEM_INCLUDE } from '../../../vitest.workspace-projects.js';
import {
  PHASE_4_5_COVERAGE_INCLUDE,
  PHASE_4_5_COVERAGE_SURFACES,
  assertPhase45CoverageInventoryComplete,
  assertPhase45OwnsPhase13ProductExclusions,
  phase45SurfaceForSourcePath,
} from '../../../vitest.phase4-5-coverage-scope.js';
import {
  PHASE_4_5_INTEGRATION_COVERAGE_EXCLUDE,
  PHASE_4_5_INTEGRATION_COVERAGE_TEST_INCLUDE,
  PHASE_4_5_UNIT_COVERAGE_EXCLUDE,
  PHASE_4_5_UNIT_COVERAGE_TEST_INCLUDE,
} from '../../../vitest.phase4-5-coverage.config.js';
import {
  PHASE_4_5_BASELINE_MARGIN_PERCENTAGE_POINTS,
  PHASE_4_5_COVERAGE_METRICS,
  PHASE_4_5_CRITICAL_FILE_MINIMUMS,
  PHASE_4_5_NEW_FILE_MINIMUMS,
  buildPhase45CoverageBaseline,
  enforcePhase45CoverageRatchet,
} from '../../../scripts/phase4-5-coverage-ratchet.mjs';

const backendRoot = resolve(import.meta.dirname, '../../..');
const repositoryRoot = resolve(backendRoot, '..');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function metric(percentage: number) {
  return {
    total: 100,
    covered: percentage,
    skipped: 0,
    pct: percentage,
  };
}

function entry(
  surface: (typeof PHASE_4_5_COVERAGE_SURFACES)[number],
  path: string,
  percentage = 100,
) {
  return {
    surface,
    path,
    lines: metric(percentage),
    branches: metric(percentage),
    functions: metric(percentage),
    statements: metric(percentage),
  };
}

describe('Phase 4/5 product-surface coverage gate', () => {
  test('dynamic inventory assigns every executable source to exactly one product surface', () => {
    assert.doesNotThrow(() => assertPhase45CoverageInventoryComplete(backendRoot));
    assert.doesNotThrow(() => assertPhase45OwnsPhase13ProductExclusions(backendRoot));
    assert.ok(PHASE_4_5_COVERAGE_INCLUDE.length >= 190);
    for (const surface of PHASE_4_5_COVERAGE_SURFACES) {
      assert.ok(
        PHASE_4_5_COVERAGE_INCLUDE.some(
          (path) => phase45SurfaceForSourcePath(path) === surface,
        ),
        `${surface} must own executable source files`,
      );
    }
    assert.equal(phase45SurfaceForSourcePath('src/modules/attachments/future.ts'), 'attachments');
    assert.equal(phase45SurfaceForSourcePath('src/modules/mcp/future.ts'), 'mcp');
    assert.equal(phase45SurfaceForSourcePath('src/modules/notifications/future.ts'), 'notifications');
    assert.equal(phase45SurfaceForSourcePath('src/modules/social/future.ts'), 'social');
  });

  test('collectors discover behavior tests by stable domain globs', () => {
    assert.deepEqual(PHASE_4_5_UNIT_COVERAGE_TEST_INCLUDE, [
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
    assert.ok(PHASE_4_5_INTEGRATION_COVERAGE_TEST_INCLUDE.includes(
      'tests/integration/phase4a/**/*.integration.test.ts',
    ));
    assert.ok(PHASE_4_5_INTEGRATION_COVERAGE_TEST_INCLUDE.includes(
      'tests/integration/postgres/**/*mcp*.integration.test.ts',
    ));
    assert.ok(SYSTEM_INCLUDE.every(
      (path) => PHASE_4_5_UNIT_COVERAGE_EXCLUDE.includes(path),
    ), 'coverage collection must preserve the dedicated system lane');
    assert.deepEqual(PHASE_4_5_INTEGRATION_COVERAGE_EXCLUDE, [
      'tests/integration/**/*capacity*.integration.test.ts',
      'tests/integration/**/*continuation*.integration.test.ts',
      'tests/integration/**/*migration*.integration.test.ts',
      'tests/integration/**/*-plan-postgres.integration.test.ts',
      'tests/integration/**/*process*.integration.test.ts',
    ]);
    assert.equal(
      [...PHASE_4_5_UNIT_COVERAGE_TEST_INCLUDE, ...PHASE_4_5_INTEGRATION_COVERAGE_TEST_INCLUDE]
        .some((pattern) => /:\d+|#L\d+/u.test(pattern)),
      false,
      'coverage ownership must not pin source line numbers',
    );
  });

  test('reviewed baseline records measured values, two-point floors, and new-file quality floors', () => {
    const baseline = readJson(resolve(
      backendRoot,
      'tests/fixtures/phase4-5-coverage-baseline/surface-minimums.json',
    )) as {
      schemaVersion: number;
      strategy: string;
      sourceRoot: string;
      calibration: { marginPercentagePoints: number };
      newFileMinimums: Record<string, number>;
      fileOverrides: Record<string, Record<string, number>>;
      surfaces: Record<string, {
        measured: Record<string, number>;
        minimums: Record<string, number>;
      }>;
    };
    assert.equal(baseline.schemaVersion, 1);
    assert.equal(baseline.strategy, 'per-surface-counter-ratchet');
    assert.equal(baseline.sourceRoot, 'src');
    assert.equal(
      baseline.calibration.marginPercentagePoints,
      PHASE_4_5_BASELINE_MARGIN_PERCENTAGE_POINTS,
    );
    assert.deepEqual(baseline.newFileMinimums, PHASE_4_5_NEW_FILE_MINIMUMS);
    assert.deepEqual(baseline.fileOverrides, PHASE_4_5_CRITICAL_FILE_MINIMUMS);
    const inventory = new Set(PHASE_4_5_COVERAGE_INCLUDE);
    for (const [path, minimums] of Object.entries(baseline.fileOverrides)) {
      assert.ok(inventory.has(path), `${path} critical floor must remain in the inventory`);
      for (const metricName of PHASE_4_5_COVERAGE_METRICS) {
        assert.ok(
          (minimums[metricName] ?? 0) > 0,
          `${path}.${metricName} critical floor must be positive`,
        );
      }
    }
    assert.deepEqual(Object.keys(baseline.surfaces).sort(), [...PHASE_4_5_COVERAGE_SURFACES]);
    for (const surface of PHASE_4_5_COVERAGE_SURFACES) {
      for (const metricName of PHASE_4_5_COVERAGE_METRICS) {
        const measured = baseline.surfaces[surface]?.measured[metricName];
        const minimum = baseline.surfaces[surface]?.minimums[metricName];
        assert.equal(typeof measured, 'number', `${surface}.${metricName}.measured`);
        assert.equal(typeof minimum, 'number', `${surface}.${metricName}.minimums`);
        assert.ok(
          Math.abs((measured ?? 0) - (minimum ?? 0) - 2) < 0.011,
          `${surface}.${metricName} floor must be its measured value minus two points`,
        );
      }
    }

    const grandfathered = readJson(resolve(
      backendRoot,
      'tests/fixtures/phase4-5-coverage-baseline/grandfathered-files.json',
    )) as { files: readonly string[] };
    assert.ok(grandfathered.files.length > 0);
    for (const path of grandfathered.files) {
      assert.ok(inventory.has(path), `${path} is grandfathered but no longer in the inventory`);
    }
  });

  test('ratchet rejects aggregate regression and applies stronger floors to future files', () => {
    const current = PHASE_4_5_COVERAGE_SURFACES.map((surface) => (
      entry(surface, `src/${surface}/current.ts`)
    ));
    const baseline = buildPhase45CoverageBaseline(current);
    assert.doesNotThrow(() => enforcePhase45CoverageRatchet(
      current,
      baseline,
      current.map(({ path }) => path),
    ));

    const aggregateRegression = current.map((value) => ({ ...value }));
    aggregateRegression[0] = entry('attachments', current[0]!.path, 97);
    assert.throws(
      () => enforcePhase45CoverageRatchet(
        aggregateRegression,
        baseline,
        current.map(({ path }) => path),
      ),
      /Surface attachments lines coverage 97\.00% is below baseline 98%/u,
    );

    const permissiveSurfaceBaseline = structuredClone(baseline);
    for (const surface of PHASE_4_5_COVERAGE_SURFACES) {
      for (const metricName of PHASE_4_5_COVERAGE_METRICS) {
        permissiveSurfaceBaseline.surfaces[surface]!.minimums[metricName] = 0;
      }
    }
    const newFile = entry('attachments', 'src/modules/attachments/future.ts', 39);
    assert.throws(
      () => enforcePhase45CoverageRatchet(
        [...current, newFile],
        permissiveSurfaceBaseline,
        current.map(({ path }) => path),
      ),
      /future\.ts lines coverage 39\.00% is below new-file minimum 40%/u,
    );

    const criticalPath = 'src/modules/mcp/change-plan-service.ts';
    const critical = entry('mcp', criticalPath, 100);
    const criticalBaseline = buildPhase45CoverageBaseline([
      entry('attachments', 'src/attachments/current.ts'),
      critical,
      entry('notifications', 'src/notifications/current.ts'),
      entry('social', 'src/social/current.ts'),
    ]);
    for (const surface of PHASE_4_5_COVERAGE_SURFACES) {
      for (const metricName of PHASE_4_5_COVERAGE_METRICS) {
        criticalBaseline.surfaces[surface]!.minimums[metricName] = 0;
      }
    }
    assert.throws(
      () => enforcePhase45CoverageRatchet(
        [{ ...critical, lines: metric(75) }],
        criticalBaseline,
        [criticalPath],
      ),
      /change-plan-service\.ts lines coverage 75\.00% is below critical-file minimum 76%/u,
    );
  });

  test('package scripts and CI own the measured gate on pull requests', () => {
    const packageJson = readJson(resolve(backendRoot, 'package.json')) as {
      scripts: Record<string, string>;
    };
    assert.match(
      packageJson.scripts['test:phase4-5:coverage:inner'] ?? '',
      /coverage:unit:inner.*coverage:integration:inner.*coverage:merge:inner/u,
    );
    assert.match(
      packageJson.scripts['test:phase4-5:coverage:baseline'] ?? '',
      /--accept-current/u,
    );

    const workflow = parse(readFileSync(
      resolve(repositoryRoot, '.github/workflows/known-backend-ci.yml'),
      'utf8',
    )) as {
      jobs?: Record<string, {
        if?: string;
        steps?: readonly { run?: string }[];
        needs?: readonly string[];
      }>;
    };
    const coverageJob = workflow.jobs?.['phase4-5-coverage'];
    assert.ok(coverageJob, 'CI must own the Phase 4/5 coverage ratchet');
    assert.doesNotMatch(coverageJob.if ?? '', /pull_request/u);
    assert.ok(
      coverageJob.steps?.some((step) => step.run === 'npm run test:phase4-5:coverage'),
      'CI job must execute the enforcing command, not measurement mode',
    );
    assert.ok(workflow.jobs?.['ci-gate']?.needs?.includes('phase4-5-coverage'));
  });
});
