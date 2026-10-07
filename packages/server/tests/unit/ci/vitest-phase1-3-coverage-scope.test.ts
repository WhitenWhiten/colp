import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  PHASE_1_3_COVERAGE_EXCLUSIONS,
  PHASE_1_3_COVERAGE_INCLUDE,
  PHASE_1_3_OUT_OF_SCOPE_PATH_PATTERNS,
  assertPhase13CoverageInventoryComplete,
  buildPhase13CoverageInventory,
  classifyPhase13CoverageSource,
  enumeratePhase13ProductionSourceFiles,
  isPhase13ProductionSourcePath,
  resolvePhase13CoverageClassification,
} from '../../../vitest.phase1-3-coverage-scope.js';

const backendRoot = resolve(import.meta.dirname, '../../..');
const fixtureRoot = resolve(backendRoot, 'tests/fixtures/phase1-3-coverage-scope');

function readFixture(name: string): string {
  return readFileSync(join(fixtureRoot, name), 'utf8');
}

function exclusionPaths(): Set<string> {
  return new Set(PHASE_1_3_COVERAGE_EXCLUSIONS.map((entry) => entry.path));
}

describe('Phase 1-3 coverage scope inventory contract', () => {
  test('exports a non-empty include list and structured exclusions with reasons', () => {
    assert.ok(PHASE_1_3_COVERAGE_INCLUDE.length > 0, 'include inventory must not be empty');
    assert.ok(PHASE_1_3_COVERAGE_EXCLUSIONS.length > 0, 'exclusion inventory must not be empty');

    for (const exclusion of PHASE_1_3_COVERAGE_EXCLUSIONS) {
      assert.match(exclusion.path, /^src\//, `exclusion path must be repo-relative: ${exclusion.path}`);
      assert.ok(exclusion.reason.trim().length > 0, `exclusion must carry a reason: ${exclusion.path}`);
      assert.ok(
        ['barrel', 'type-only', 'bootstrap-entrypoint', 'generated', 'migration-down'].includes(exclusion.kind),
        `unexpected exclusion kind for ${exclusion.path}`,
      );
    }
    assert.equal(
      PHASE_1_3_COVERAGE_EXCLUSIONS.find(
        (entry) => entry.path === 'src/infrastructure/database/migrate.ts',
      )?.kind,
      'bootstrap-entrypoint',
    );
    assert.equal(
      PHASE_1_3_COVERAGE_EXCLUSIONS.find(
        (entry) => entry.path === 'src/modules/publisher/application/admit-publisher-mutation.ts',
      )?.kind,
      'barrel',
    );
  });

  test('keeps Phase 4/5 social, notifications, MCP, and attachments outside the inventory universe', () => {
    const outOfScopeSamples = [
      'src/modules/social/application/feed-query.ts',
      'src/modules/notifications/application/notification-inbox-query.ts',
      'src/infrastructure/social/feed-worker-postgres.ts',
      'src/infrastructure/notifications/repository-postgres.ts',
      'src/transport/product/feed-routes.ts',
      'src/transport/product/follow-routes.ts',
      'src/transport/product/notification-routes.ts',
      'src/infrastructure/outbox/social-collection-change.ts',
      'src/modules/commands/application/social-identity.ts',
      'src/modules/mcp/operations.ts',
      'src/modules/attachments/delivery-policy.ts',
    ];

    for (const sample of outOfScopeSamples) {
      assert.ok(
        PHASE_1_3_OUT_OF_SCOPE_PATH_PATTERNS.some((pattern) => pattern.test(sample)),
        `expected out-of-scope pattern for ${sample}`,
      );
      assert.equal(isPhase13ProductionSourcePath(sample), false, `${sample} must stay outside the universe`);
    }
  });

  test('classifies every current Phase 1-3 production source file exactly once', () => {
    const discovered = enumeratePhase13ProductionSourceFiles(backendRoot);
    const includeSet = new Set(PHASE_1_3_COVERAGE_INCLUDE);
    const excluded = exclusionPaths();

    assert.ok(discovered.length > 0, 'discovered production inventory must not be empty');

    const overlap = PHASE_1_3_COVERAGE_INCLUDE.filter((path) => excluded.has(path));
    assert.deepEqual(overlap, [], 'include and exclusion inventories must not overlap');

    const missing: string[] = [];
    const duplicate: string[] = [];
    const unclassified: string[] = [];

    for (const path of discovered) {
      const inInclude = includeSet.has(path);
      const inExclude = excluded.has(path);
      if (!inInclude && !inExclude) unclassified.push(path);
      if (inInclude && inExclude) duplicate.push(path);
      if (!inInclude && !inExclude) missing.push(path);
    }

    assert.deepEqual(unclassified, [], `unclassified production files: ${unclassified.join(', ')}`);
    assert.deepEqual(duplicate, [], `files present in both include and exclusion: ${duplicate.join(', ')}`);

    const includeOnlyInExport = PHASE_1_3_COVERAGE_INCLUDE.filter((path) => !discovered.includes(path));
    const excludeOnlyInExport = [...excluded].filter((path) => !discovered.includes(path));
    assert.deepEqual(includeOnlyInExport, [], `stale include entries: ${includeOnlyInExport.join(', ')}`);
    assert.deepEqual(excludeOnlyInExport, [], `stale exclusion entries: ${excludeOnlyInExport.join(', ')}`);

    const classified = new Set([
      ...PHASE_1_3_COVERAGE_INCLUDE,
      ...PHASE_1_3_COVERAGE_EXCLUSIONS.map((entry) => entry.path),
    ]);
    assert.equal(classified.size, discovered.length, 'every discovered file must map to exactly one inventory bucket');
  });

  test('routes fixture sources through the same classification rules', () => {
    const ordinaryPath = 'src/modules/collections/application/phase1-3-coverage-scope-ordinary-fixture.ts';
    const typeOnlyPath = 'src/modules/search/application/phase1-3-coverage-scope-type-only-fixture.ts';
    const generatedPath = 'src/infrastructure/colp/phase1-3-coverage-scope-generated-fixture.ts';

    assert.equal(
      resolvePhase13CoverageClassification(ordinaryPath, readFixture('ordinary-source.ts')),
      'include',
    );
    assert.equal(
      classifyPhase13CoverageSource(typeOnlyPath, readFixture('type-only-source.ts')).kind,
      'type-only',
    );
    assert.equal(
      classifyPhase13CoverageSource(generatedPath, readFixture('generated-source.ts')).kind,
      'generated',
    );
  });

  test('uses source classification while building the executable inventory', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'known-phase13-coverage-'));
    try {
      const fixtureDirectory = join(temporaryRoot, 'src/modules/collections/application');
      mkdirSync(fixtureDirectory, { recursive: true });
      writeFileSync(join(fixtureDirectory, 'ordinary.ts'), readFixture('ordinary-source.ts'), 'utf8');
      writeFileSync(join(fixtureDirectory, 'types.ts'), readFixture('type-only-source.ts'), 'utf8');
      writeFileSync(join(fixtureDirectory, 'generated.ts'), readFixture('generated-source.ts'), 'utf8');

      const inventory = buildPhase13CoverageInventory(temporaryRoot);
      assert.deepEqual(inventory.include, ['src/modules/collections/application/ordinary.ts']);
      assert.deepEqual(
        inventory.exclusions.map((entry) => [entry.path, entry.kind]),
        [
          ['src/modules/collections/application/generated.ts', 'generated'],
          ['src/modules/collections/application/types.ts', 'type-only'],
        ],
      );
      assert.doesNotThrow(() => assertPhase13CoverageInventoryComplete(temporaryRoot));
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test('does not treat inventory size as a substitute for complete classification', () => {
    const discovered = enumeratePhase13ProductionSourceFiles(backendRoot);
    const inventorySize = PHASE_1_3_COVERAGE_INCLUDE.length + PHASE_1_3_COVERAGE_EXCLUSIONS.length;
    assert.equal(inventorySize, discovered.length);
    assert.notEqual(PHASE_1_3_COVERAGE_INCLUDE.length, 6, 'include inventory must not mirror the legacy six-file gate');
  });
});
