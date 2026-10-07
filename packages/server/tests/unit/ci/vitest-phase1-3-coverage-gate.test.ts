import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  PHASE_1_3_COVERAGE_INCLUDE,
  PHASE_1_3_COVERAGE_SOURCE_ROOT,
  PHASE_1_3_FOCUSED_COVERAGE_SIGNAL_FILES,
  buildPhase13CoverageModuleKeys,
  toPhase13CoverageIncludeGlobs,
} from '../../../vitest.phase1-3-coverage-scope.js';
import {
  INTEGRATION_ONLY_COVERAGE_PROBE_FILE,
  enforceBaselineRatchet,
  mergePhase13CoverageReports,
} from '../../../scripts/merge-phase1-3-coverage.mjs';
import { PHASE_1_3_MEASURED_FILE_COVERAGE_OVERRIDES } from '../../support/phase1-3-coverage-floor-fixtures.js';

const backendRoot = resolve(import.meta.dirname, '../../..');
const mergeFixtureRoot = resolve(backendRoot, 'tests/fixtures/phase1-3-coverage-merge');
const baselinePath = resolve(backendRoot, 'tests/fixtures/phase1-3-coverage-baseline/module-minimums.json');

function readConfigSource(name: string): string {
  return readFileSync(resolve(backendRoot, name), 'utf8');
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assertValidExpiry(expires: string, label: string): void {
  const parsed = new Date(`${expires}T00:00:00.000Z`);
  assert.ok(
    !Number.isNaN(parsed.getTime()) && /^\d{4}-\d{2}-\d{2}$/u.test(expires),
    `${label} expires must be a valid YYYY-MM-DD date, got ${expires}`,
  );
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  assert.ok(
    parsed.getTime() >= todayUtc,
    `${label} expires ${expires} (today is ${new Date(todayUtc).toISOString().slice(0, 10)}); ` +
      'renew the dated review or raise the floor from a measured coverage report',
  );
}

describe('Phase 1-3 coverage gate contract', () => {
  test('full and focused coverage configs import the shared scope instead of hardcoding six files', () => {
    for (const configName of ['vitest.coverage.config.ts', 'vitest.focused-coverage.config.ts']) {
      const source = readConfigSource(configName);
      assert.match(source, /vitest\.phase1-3-coverage-scope/, `${configName} must import the shared scope`);
      assert.match(source, /toPhase13CoverageIncludeGlobs/u, `${configName} must use shared include globs`);
      assert.doesNotMatch(
        source,
        /coverage:\s*\{[\s\S]*include:\s*\[[\s\S]*product-command-receipt\.ts[\s\S]*product-command-mapping\.ts[\s\S]*\]\s*,[\s\S]*thresholds/u,
        `${configName} must not keep the legacy six-file hardcoded include block`,
      );
    }

    assert.ok(toPhase13CoverageIncludeGlobs().length > PHASE_1_3_FOCUSED_COVERAGE_SIGNAL_FILES.length);
    assert.ok(PHASE_1_3_COVERAGE_INCLUDE.length > 6);
  });

  test('focused coverage config is documented as a fast signal, not full-repo coverage', () => {
    const source = readConfigSource('vitest.focused-coverage.config.ts');
    assert.match(source, /fast signal/i, 'focused config must describe itself as a fast signal');
    assert.match(source, /not full/i, 'focused config must explicitly disclaim full-repo coverage');
    assert.match(source, /PHASE_1_3_FOCUSED_COVERAGE_SIGNAL_FILES/u, 'focused thresholds must gate only the signal file set');
  });

  test('baseline ratchet fixture covers every module key, focused signals and measured file floors', () => {
    const baseline = readJson(baselinePath) as {
      schemaVersion: number;
      strategy: string;
      sourceRoot: string;
      modules: Record<string, Record<string, number>>;
      fileMinimums: Record<string, number>;
      newFileMinimums: Record<string, number>;
      fileMinimumsRationale: string;
      recalibration: {
        measuredAt: string;
        runtime: string;
        command: string;
        gatedFileCount: number;
        marginPercentagePoints: number;
        rationale: string;
        adjustedMetrics: Record<string, Record<string, { measured: number; minimum: number }>>;
      };
      fileOverrides: Record<string, Record<string, number>>;
      deferredFloorReviews: {
        issue: string;
        expires: string;
        modules: Record<string, string>;
        fileOverrides: Record<string, string>;
      };
    };

    assert.equal(baseline.schemaVersion, 1);
    assert.equal(baseline.strategy, 'per-module-counter-ratchet');
    assert.equal(baseline.sourceRoot, PHASE_1_3_COVERAGE_SOURCE_ROOT);
    assert.deepEqual(baseline.fileMinimums, {
      lines: 1, branches: 0, functions: 0, statements: 1,
    });
    assert.deepEqual(baseline.newFileMinimums, {
      lines: 40, branches: 15, functions: 25, statements: 40,
    });
    assert.match(
      baseline.fileMinimumsRationale,
      /tripwire/i,
      'fileMinimumsRationale must name the 1/0 default as a tripwire',
    );
    assert.match(
      baseline.fileMinimumsRationale,
      /not a quality bar/i,
      'fileMinimumsRationale must disclaim the floors as a quality bar',
    );
    assert.match(
      baseline.fileMinimumsRationale,
      /40\/15\/25\/40/,
      'fileMinimumsRationale must name the focused-style new-file floors',
    );
    assert.match(
      baseline.fileMinimumsRationale,
      /Phase 4\/5/,
      'fileMinimumsRationale must record the BT-07 Phase 4/5 exclusion',
    );

    const expectedModules = buildPhase13CoverageModuleKeys();
    assert.deepEqual(Object.keys(baseline.modules).sort(), [...expectedModules]);
    for (const moduleKey of expectedModules) {
      for (const metric of ['lines', 'branches', 'functions', 'statements'] as const) {
        assert.equal(typeof baseline.modules[moduleKey]?.[metric], 'number', `${moduleKey}.${metric}`);
      }
    }
    assert.equal(baseline.recalibration.measuredAt, '2026-09-01');
    assert.equal(baseline.recalibration.command, 'npm run test:unit:coverage');
    // This is the historical measurement, not today's dynamic inventory.
    // New leaves are independently gated by newFileMinimums below.
    assert.equal(baseline.recalibration.gatedFileCount, 630);
    assert.ok(PHASE_1_3_COVERAGE_INCLUDE.length >= baseline.recalibration.gatedFileCount);
    assert.equal(baseline.recalibration.marginPercentagePoints, 2);
    assert.match(baseline.recalibration.runtime, /PostgreSQL 16\.4/u);
    assert.match(baseline.recalibration.rationale, /40\/15\/25\/40/u);
    for (const promotedModule of [
      'src/infrastructure/cache',
      'src/infrastructure/config',
      'src/infrastructure/http',
      'src/infrastructure/ledger-archive',
      'src/infrastructure/rate-limit',
      'src/infrastructure/seed',
    ]) {
      assert.ok(
        baseline.recalibration.adjustedMetrics[promotedModule],
        `${promotedModule} must retain its measured promotion evidence`,
      );
    }
    for (const [moduleKey, metrics] of Object.entries(baseline.recalibration.adjustedMetrics)) {
      for (const [metric, calibration] of Object.entries(metrics)) {
        assert.equal(
          baseline.modules[moduleKey]?.[metric],
          calibration.minimum,
          `${moduleKey}.${metric} must equal its recorded measured floor`,
        );
        const cushion = calibration.measured - calibration.minimum;
        assert.ok(cushion >= 1.99 && cushion <= 2.51, `${moduleKey}.${metric} cushion ${cushion}`);
      }
    }

    const expectedOverrideKeys = [
      ...PHASE_1_3_FOCUSED_COVERAGE_SIGNAL_FILES,
      ...Object.keys(PHASE_1_3_MEASURED_FILE_COVERAGE_OVERRIDES),
    ].sort();
    assert.deepEqual(Object.keys(baseline.fileOverrides).sort(), expectedOverrideKeys);

    const includeSet = new Set(PHASE_1_3_COVERAGE_INCLUDE);
    for (const path of Object.keys(PHASE_1_3_MEASURED_FILE_COVERAGE_OVERRIDES)) {
      assert.ok(
        includeSet.has(path),
        `${path} must stay in the coverage include set; measured floors must not be achieved by excluding files`,
      );
    }

    for (const [path, minimums] of Object.entries(PHASE_1_3_MEASURED_FILE_COVERAGE_OVERRIDES)) {
      const override = baseline.fileOverrides[path];
      assert.deepEqual(override, minimums, `${path} must keep its measured per-file floor`);
      for (const metric of ['lines', 'branches', 'functions', 'statements'] as const) {
        assert.ok(
          (override?.[metric] ?? 0) > baseline.newFileMinimums[metric],
          `${path} ${metric} floor must exceed the generic new-file minimum`,
        );
      }
    }
    const grandfathered = new Set((readJson(resolve(
      backendRoot,
      'tests/fixtures/phase1-3-coverage-baseline/grandfathered-files.json',
    )) as { files: readonly string[] }).files);
    for (const path of Object.keys(PHASE_1_3_MEASURED_FILE_COVERAGE_OVERRIDES)) {
      assert.equal(
        grandfathered.has(path),
        false,
        `${path} has measured floors and must not retain the BT-07 grandfathered tripwire`,
      );
    }

    assert.equal(
      baseline.deferredFloorReviews.issue,
      'docs/audits/known-backend/2026-08-20/tests-quality-audit.md#T-04',
    );
    assertValidExpiry(baseline.deferredFloorReviews.expires, 'deferredFloorReviews');
    const trackingDoc = baseline.deferredFloorReviews.issue.split('#')[0]!;
    assert.ok(
      existsSync(resolve(backendRoot, '..', trackingDoc)),
      `deferredFloorReviews tracking document ${trackingDoc} must exist`,
    );
    assert.deepEqual(
      Object.keys(baseline.deferredFloorReviews.fileOverrides).sort(),
      [],
      'graduated measured overrides must not remain deferred',
    );
    assert.deepEqual(
      Object.keys(baseline.deferredFloorReviews.modules).sort(),
      [],
      'the publisher module review is closed by the recorded 596-file recalibration',
    );
  });

  test('new inventory files use focused-style floors; grandfathered files keep the 1/0 tripwire', () => {
    const snapshot = readJson(resolve(backendRoot, 'tests/fixtures/phase1-3-coverage-baseline/grandfathered-files.json')) as {
      files: readonly string[];
    };
    // Frozen BT-07 snapshot must stay a subset of include. Equality would force
    // every new Phase 1–3 file onto the 1/0/0/1 tripwire instead of 40/15/25/40.
    const includeSet = new Set(PHASE_1_3_COVERAGE_INCLUDE);
    const addedLeaf = 'src/infrastructure/async/abort-and-settle.ts';
    assert.ok(includeSet.has(addedLeaf), 'abort settlement must remain instrumented');
    assert.equal(snapshot.files.includes(addedLeaf), false, 'new code must retain new-file floors');
    assert.ok(snapshot.files.length > 0, 'grandfathered snapshot must stay non-empty');
    for (const file of snapshot.files) {
      assert.ok(
        includeSet.has(file),
        `${file} is grandfathered but is no longer in the Phase 1-3 include set`,
      );
    }

    const metric = (total: number, covered: number) => ({
      total, covered, skipped: 0, pct: total === 0 ? 100 : covered / total * 100,
    });
    const baseline = {
      modules: { 'src/modules/sync': { lines: 1, branches: 0, functions: 0, statements: 1 } },
      fileMinimums: { lines: 1, branches: 0, functions: 0, statements: 1 },
      newFileMinimums: { lines: 40, branches: 15, functions: 25, statements: 40 },
      grandfatheredFiles: ['src/modules/sync/legacy.ts'],
    };

    assert.doesNotThrow(() => enforceBaselineRatchet([
      {
        path: 'src/modules/sync/legacy.ts', module: 'src/modules/sync',
        lines: metric(100, 1), branches: metric(10, 0),
        functions: metric(4, 0), statements: metric(100, 1),
      },
    ], baseline));

    assert.throws(
      () => enforceBaselineRatchet([
        {
          path: 'src/modules/sync/new-surface.ts', module: 'src/modules/sync',
          lines: metric(100, 1), branches: metric(10, 0),
          functions: metric(4, 0), statements: metric(100, 1),
        },
      ], baseline),
      /File src\/modules\/sync\/new-surface\.ts lines coverage 1\.00% is below baseline 40%/u,
    );
  });

  test('merge script fails when either report is missing, source roots differ, or gated files are incomplete', () => {
    const baseline = baselinePath;
    const unitFinal = join(mergeFixtureRoot, 'unit-coverage-final.json');
    const integrationFinal = join(mergeFixtureRoot, 'integration-coverage-final.json');
    const unitSummary = join(mergeFixtureRoot, 'unit-coverage-summary.json');
    const integrationSummary = join(mergeFixtureRoot, 'integration-coverage-summary.json');

    assert.throws(
      () => mergePhase13CoverageReports({
        backendRoot,
        baselinePath: baseline,
        unitFinalPath: join(mergeFixtureRoot, 'missing-unit-final.json'),
        integrationFinalPath: integrationFinal,
        unitSummaryPath: unitSummary,
        integrationSummaryPath: integrationSummary,
        gatedFiles: PHASE_1_3_COVERAGE_INCLUDE,
        sourceRoot: PHASE_1_3_COVERAGE_SOURCE_ROOT,
        outputSummaryPath: join(mergeFixtureRoot, 'should-not-write-summary.json'),
        outputGatedReportPath: join(mergeFixtureRoot, 'should-not-write-gated.json'),
      }),
      /unit coverage report/i,
    );

    assert.throws(
      () => mergePhase13CoverageReports({
        backendRoot,
        baselinePath: baseline,
        unitFinalPath: unitFinal,
        integrationFinalPath: join(mergeFixtureRoot, 'missing-integration-final.json'),
        unitSummaryPath: unitSummary,
        integrationSummaryPath: integrationSummary,
        gatedFiles: PHASE_1_3_COVERAGE_INCLUDE,
        sourceRoot: PHASE_1_3_COVERAGE_SOURCE_ROOT,
        outputSummaryPath: join(mergeFixtureRoot, 'should-not-write-summary.json'),
        outputGatedReportPath: join(mergeFixtureRoot, 'should-not-write-gated.json'),
      }),
      /integration coverage report/i,
    );

    const mismatchedRootFinal = join(mergeFixtureRoot, 'integration-coverage-final.json');
    const mismatchedUnitFinal = {
      'C:\\repo\\etc\\outside-root.ts': {
        path: 'C:\\repo\\etc\\outside-root.ts',
        statementMap: { '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } } },
        fnMap: {},
        branchMap: {},
        s: { '0': 1 },
        f: {},
        b: {},
      },
      ...readJson(unitFinal) as Record<string, unknown>,
    };
    const mismatchedUnitFinalPath = join(mergeFixtureRoot, 'mismatched-root-unit-final.json');
    writeTemporaryJson(mismatchedUnitFinalPath, mismatchedUnitFinal);

    assert.throws(
      () => mergePhase13CoverageReports({
        backendRoot,
        baselinePath: baseline,
        unitFinalPath: mismatchedUnitFinalPath,
        integrationFinalPath: integrationFinal,
        unitSummaryPath: unitSummary,
        integrationSummaryPath: integrationSummary,
        gatedFiles: PHASE_1_3_COVERAGE_INCLUDE,
        sourceRoot: PHASE_1_3_COVERAGE_SOURCE_ROOT,
        outputSummaryPath: join(mergeFixtureRoot, 'should-not-write-summary.json'),
        outputGatedReportPath: join(mergeFixtureRoot, 'should-not-write-gated.json'),
      }),
      /source root/i,
    );

    assert.throws(
      () => mergePhase13CoverageReports({
        backendRoot,
        baselinePath: baseline,
        unitFinalPath: unitFinal,
        integrationFinalPath: integrationFinal,
        unitSummaryPath: unitSummary,
        integrationSummaryPath: integrationSummary,
        gatedFiles: [
          'src/transport/product-command-mapping.ts',
          'src/infrastructure/sync/postgres/sync-pull-postgres.ts',
          'src/modules/sync/application/sync-center.ts',
        ],
        sourceRoot: PHASE_1_3_COVERAGE_SOURCE_ROOT,
        outputSummaryPath: join(mergeFixtureRoot, 'should-not-write-summary.json'),
        outputGatedReportPath: join(mergeFixtureRoot, 'should-not-write-gated.json'),
      }),
      /incomplete gated file set/i,
    );
  });

  test('removing integration-only coverage lowers the probed module coverage (merge sensitivity)', () => {
    const baseline = baselinePath;
    const unitFinal = join(mergeFixtureRoot, 'unit-coverage-final.json');
    const integrationFinal = join(mergeFixtureRoot, 'integration-coverage-final.json');
    const unitSummary = join(mergeFixtureRoot, 'unit-coverage-summary.json');
    const integrationSummary = join(mergeFixtureRoot, 'integration-coverage-summary.json');
    const gatedFiles = [
      'src/transport/product-command-mapping.ts',
      INTEGRATION_ONLY_COVERAGE_PROBE_FILE,
    ];

    const mergedOutput = join(mergeFixtureRoot, 'merged-with-integration-summary.json');
    const mergedGated = join(mergeFixtureRoot, 'merged-with-integration-gated.json');
    const mergedWithoutIntegrationOutput = join(mergeFixtureRoot, 'merged-without-integration-summary.json');
    const mergedWithoutIntegrationGated = join(mergeFixtureRoot, 'merged-without-integration-gated.json');

    const withIntegration = mergePhase13CoverageReports({
      backendRoot,
      baselinePath: baseline,
      unitFinalPath: unitFinal,
      integrationFinalPath: integrationFinal,
      unitSummaryPath: unitSummary,
      integrationSummaryPath: integrationSummary,
      gatedFiles,
      sourceRoot: PHASE_1_3_COVERAGE_SOURCE_ROOT,
      outputSummaryPath: mergedOutput,
      outputGatedReportPath: mergedGated,
      enforceBaseline: false,
    });

    const withoutIntegration = mergePhase13CoverageReports({
      backendRoot,
      baselinePath: baseline,
      unitFinalPath: unitFinal,
      integrationFinalPath: join(mergeFixtureRoot, 'empty-integration-final.json'),
      unitSummaryPath: unitSummary,
      integrationSummaryPath: join(mergeFixtureRoot, 'empty-integration-summary.json'),
      gatedFiles,
      sourceRoot: PHASE_1_3_COVERAGE_SOURCE_ROOT,
      outputSummaryPath: mergedWithoutIntegrationOutput,
      outputGatedReportPath: mergedWithoutIntegrationGated,
      enforceBaseline: false,
    });

    const withIntegrationPct = withIntegration.gatedFiles.find(
      (entry) => entry.path === INTEGRATION_ONLY_COVERAGE_PROBE_FILE,
    )?.lines.pct;
    const withoutIntegrationPct = withoutIntegration.gatedFiles.find(
      (entry) => entry.path === INTEGRATION_ONLY_COVERAGE_PROBE_FILE,
    )?.lines.pct;

    assert.equal(typeof withIntegrationPct, 'number');
    assert.equal(typeof withoutIntegrationPct, 'number');
    assert.ok(
      (withIntegrationPct ?? 0) > (withoutIntegrationPct ?? 0),
      'integration-only probe file must lose coverage when integration report is empty',
    );
    assert.equal(withoutIntegrationPct, 0);
  });

  test('published gated report lists every gated file instead of hiding zero-coverage modules behind totals', () => {
    const result = mergePhase13CoverageReports({
      backendRoot,
      baselinePath: baselinePath,
      unitFinalPath: join(mergeFixtureRoot, 'unit-coverage-final.json'),
      integrationFinalPath: join(mergeFixtureRoot, 'integration-coverage-final.json'),
      unitSummaryPath: join(mergeFixtureRoot, 'unit-coverage-summary.json'),
      integrationSummaryPath: join(mergeFixtureRoot, 'integration-coverage-summary.json'),
      gatedFiles: [
        'src/transport/product-command-mapping.ts',
        INTEGRATION_ONLY_COVERAGE_PROBE_FILE,
        'src/transport/auth/origin-csrf.ts',
      ],
      sourceRoot: PHASE_1_3_COVERAGE_SOURCE_ROOT,
      outputSummaryPath: join(mergeFixtureRoot, 'visibility-summary.json'),
      outputGatedReportPath: join(mergeFixtureRoot, 'visibility-gated.json'),
      enforceBaseline: false,
    });

    assert.equal(result.gatedFiles.length, 3);
    assert.ok(result.gatedFiles.some((entry) => entry.path === 'src/transport/auth/origin-csrf.ts' && entry.lines.pct === 0));
    assert.ok(result.gatedFiles.some((entry) => entry.path === INTEGRATION_ONLY_COVERAGE_PROBE_FILE && (entry.lines.pct ?? 0) > 0));
    assert.ok(result.summary.total.lines.pct > 0);
    assert.notEqual(result.summary.total.lines.pct, 0);
  });

  test('module ratchet weights coverage by counters and rejects a large zero-coverage file', () => {
    const metric = (total: number, covered: number) => ({
      total, covered, skipped: 0, pct: total === 0 ? 100 : covered / total * 100,
    });
    const entries = [
      {
        path: 'src/modules/sync/application/large.ts', module: 'src/modules/sync',
        lines: metric(1_000, 0), branches: metric(1_000, 0),
        functions: metric(1_000, 0), statements: metric(1_000, 0),
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        path: `src/modules/sync/application/small-${index}.ts`, module: 'src/modules/sync',
        lines: metric(1, 1), branches: metric(1, 1),
        functions: metric(1, 1), statements: metric(1, 1),
      })),
    ];

    assert.throws(
      () => enforceBaselineRatchet(entries, {
        modules: { 'src/modules/sync': { lines: 50, branches: 50, functions: 50, statements: 50 } },
        fileMinimums: { lines: 1, branches: 0, functions: 0, statements: 1 },
      }),
      /Module src\/modules\/sync lines coverage 0\.99%|File .*large\.ts lines coverage 0\.00%/u,
    );
  });

  test('measured Sync adapter floor rejects a large adapter degrading to a single covered line', () => {
    const metric = (total: number, covered: number) => ({
      total, covered, skipped: 0, pct: total === 0 ? 100 : covered / total * 100,
    });
    const entries = [
      {
        path: 'src/infrastructure/sync/postgres/sync-pull-postgres.ts', module: 'src/infrastructure/sync',
        lines: metric(1_200, 1), branches: metric(1_200, 1),
        functions: metric(120, 1), statements: metric(1_200, 1),
      },
      ...Array.from({ length: 20 }, (_, index) => ({
        path: `src/infrastructure/sync/well-covered-${index}.ts`, module: 'src/infrastructure/sync',
        lines: metric(1, 1), branches: metric(1, 1),
        functions: metric(1, 1), statements: metric(1, 1),
      })),
    ];

    assert.throws(
      () => enforceBaselineRatchet(entries, readJson(baselinePath) as {
        modules: Record<string, Record<string, number>>;
        fileMinimums: Record<string, number>;
        fileOverrides: Record<string, Record<string, number>>;
      }),
      /File src\/infrastructure\/sync\/postgres\/sync-pull-postgres\.ts lines coverage 0\.08% is below baseline 89\.39%/u,
    );
  });

  test('coverage collect scripts propagate Vitest exit codes and do not swallow failures', () => {
    for (const scriptName of ['run-phase13-unit-coverage.mjs', 'run-phase13-integration-coverage.mjs']) {
      const source = readConfigSource(`scripts/${scriptName}`);
      assert.doesNotMatch(source, /dangerouslyIgnoreUnhandledErrors/u, `${scriptName} must not ignore unhandled errors`);
      assert.doesNotMatch(
        source,
        /existsSync[\s\S]*process\.exit\(0\)/u,
        `${scriptName} must not exit 0 when coverage JSON exists`,
      );
      assert.match(source, /process\.exit\(result\.status/u, `${scriptName} must propagate Vitest status`);
    }

    const coverageConfig = readConfigSource('vitest.coverage.config.ts');
    const coverageFiles = readConfigSource('scripts/phase13-coverage-test-files.mjs');
    assert.match(coverageConfig, /reportOnFailure:\s*true/u, 'coverage config must retain failure artifacts');
    assert.match(coverageConfig, /hookTimeout:\s*120_000/u, 'coverage collect must keep receipt-length hookTimeout');
    assert.match(
      coverageConfig,
      /testTimeout:\s*coverageSuite === 'integration' \? 15_000 : 60_000/u,
      'unit coverage collect matches focused-coverage testTimeout because it carries product-command-receipt',
    );
    for (const docPinningExclude of [
      'tests/unit/**/*-static.test.ts',
      'tests/unit/ci/**/*.test.ts',
    ]) {
      assert.ok(
        coverageFiles.includes(`'${docPinningExclude}'`),
        `unit coverage collect must exclude doc-pinning ${docPinningExclude}`,
      );
    }
    for (const phase5OnlyPattern of [
      'feed/feed-',
      'follow/follow-',
      'notifications/notification-',
      'sync/outbox-continuation',
      'phase5/phase5-',
      'social/social-',
    ]) {
      assert.ok(
        coverageFiles.includes(`tests/unit/${phase5OnlyPattern}`),
        `unit coverage collect must exclude Phase 5-only ${phase5OnlyPattern} suites`,
      );
    }
  });
});

function writeTemporaryJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
