import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, test } from 'vitest';
import {
  aggregatePhase13CoverageShards,
  buildPhase13ShardCoverageReportPaths,
} from '../../../scripts/aggregate-phase1-3-coverage-shards.mjs';
import {
  PHASE13_COVERAGE_SHARD_COUNT,
  parseOptionalPhase13CoverageShard,
  phase13CoverageReportsDirectory,
} from '../../../scripts/phase13-coverage-shard.mjs';
import {
  listPhase13CoverageTestFiles,
  selectPhase13CoverageShard,
} from '../../../scripts/phase13-coverage-test-files.mjs';
import { mergePhase13CoverageReports } from '../../../scripts/merge-phase1-3-coverage.mjs';

const backendRoot = resolve(import.meta.dirname, '../../..');
const mergeFixtureRoot = resolve(backendRoot, 'tests/fixtures/phase1-3-coverage-merge');
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'known-phase13-shards-'));
  temporaryRoots.push(root);
  return root;
}

function provisionEightReports(root: string) {
  const paths = buildPhase13ShardCoverageReportPaths(root);
  for (const path of paths.unitFinalPaths) {
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(join(mergeFixtureRoot, 'unit-coverage-final.json'), path);
  }
  for (const path of paths.integrationFinalPaths) {
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(join(mergeFixtureRoot, 'integration-coverage-final.json'), path);
  }
  return paths;
}

function aggregateOptions(root: string) {
  return {
    backendRoot: root,
    baselinePath: resolve(backendRoot, 'tests/fixtures/phase1-3-coverage-baseline/module-minimums.json'),
    grandfatheredFilesPath: resolve(
      backendRoot,
      'tests/fixtures/phase1-3-coverage-baseline/grandfathered-files.json',
    ),
    gatedFiles: [
      'src/transport/product-command-mapping.ts',
      'src/infrastructure/sync/postgres/sync-pull-postgres.ts',
      'src/transport/auth/origin-csrf.ts',
    ],
    outputSummaryPath: resolve(root, 'coverage/phase1-3/merged/coverage-summary.json'),
    outputGatedReportPath: resolve(root, 'coverage/phase1-3/merged/gated-files.json'),
    enforceBaseline: false,
  } as const;
}

describe('Phase 1-3 coverage shard collection and aggregation', () => {
  test('strict optional shard parser keeps no-argument compatibility and canonicalizes N/M', () => {
    assert.equal(parseOptionalPhase13CoverageShard([]), undefined);
    assert.deepEqual(parseOptionalPhase13CoverageShard(['1/4']), { index: 1, count: 4, value: '1/4' });
    assert.deepEqual(parseOptionalPhase13CoverageShard(['4/4']), { index: 4, count: 4, value: '4/4' });
    for (const arguments_ of [
      ['0/4'], ['5/4'], ['01/4'], ['1/04'], ['1'], ['1/0'], ['1/65'], ['1/4', '2/4'],
    ]) {
      assert.throws(() => parseOptionalPhase13CoverageShard(arguments_), /Phase 1-3 coverage/u);
    }
  });

  test('sharded reports use eight unique paths while full local collection keeps legacy directories', () => {
    assert.equal(phase13CoverageReportsDirectory('unit', undefined), './coverage/phase1-3/unit');
    assert.equal(
      phase13CoverageReportsDirectory('integration', ''),
      './coverage/phase1-3/integration',
    );
    assert.equal(
      phase13CoverageReportsDirectory('unit', '2/4'),
      './coverage/phase1-3/shards/shard-2-of-4/unit',
    );
    assert.equal(
      phase13CoverageReportsDirectory('integration', '2/4'),
      './coverage/phase1-3/shards/shard-2-of-4/integration',
    );
    const paths = buildPhase13ShardCoverageReportPaths(backendRoot);
    assert.equal(paths.unitFinalPaths.length, PHASE13_COVERAGE_SHARD_COUNT);
    assert.equal(paths.integrationFinalPaths.length, PHASE13_COVERAGE_SHARD_COUNT);
    assert.equal(new Set([...paths.unitFinalPaths, ...paths.integrationFinalPaths]).size, 8);
  });

  test('coverage file lists partition into four complete non-overlapping shards', () => {
    for (const suite of ['unit', 'integration'] as const) {
      const files = listPhase13CoverageTestFiles(backendRoot, suite);
      const shards = Array.from({ length: PHASE13_COVERAGE_SHARD_COUNT }, (_, offset) => (
        selectPhase13CoverageShard(files, backendRoot, {
          index: offset + 1,
          count: PHASE13_COVERAGE_SHARD_COUNT,
          value: `${offset + 1}/${PHASE13_COVERAGE_SHARD_COUNT}`,
        })
      ));
      const flattened = shards.flat();
      assert.deepEqual([...flattened].sort(), [...files].sort(), `${suite} shard union must equal full list`);
      assert.equal(new Set(flattened).size, files.length, `${suite} files must appear in exactly one shard`);
      assert.ok(shards.every((shard) => shard.length > 0), `${suite} shards must be non-empty`);
    }
  });

  test('collectors select explicit shard files and isolate report directories', () => {
    for (const scriptName of ['run-phase13-unit-coverage.mjs', 'run-phase13-integration-coverage.mjs']) {
      const source = readFileSync(resolve(backendRoot, 'scripts', scriptName), 'utf8');
      assert.match(source, /parseOptionalPhase13CoverageShard\(process\.argv\.slice\(2\)\)/u);
      assert.match(source, /PHASE13_COVERAGE_SHARD/u);
      assert.match(source, /selectPhase13CoverageShard/u);
      assert.match(source, /\.\.\.files/u);
      assert.match(source, /process\.exit\(result\.status/u);
    }
    const config = readFileSync(resolve(backendRoot, 'vitest.coverage.config.ts'), 'utf8');
    assert.match(config, /phase13CoverageReportsDirectory/u);
    assert.match(config, /process\.env\.PHASE13_COVERAGE_SHARD/u);
  });

  test('aggregator requires exactly four unit plus four integration reports and publishes one merged gate', () => {
    const root = temporaryRoot();
    provisionEightReports(root);
    const result = aggregatePhase13CoverageShards(aggregateOptions(root));
    assert.equal(result.gatedFiles.length, 3);
    assert.ok(result.gatedFiles.every((entry) => entry.lines.total > 0));
    assert.equal(JSON.parse(readFileSync(result.outputGatedReportPath, 'utf8')).gatedFileCount, 3);
    assert.throws(
      () => aggregatePhase13CoverageShards({
        ...aggregateOptions(root),
        unitFinalPaths: ['one.json'],
        integrationFinalPaths: ['two.json'],
      }),
      /requires exactly 4 unit and 4 integration/u,
    );
  });

  test('aggregation fails closed on a missing or duplicate shard report', () => {
    const root = temporaryRoot();
    const paths = provisionEightReports(root);
    unlinkSync(paths.unitFinalPaths[3]!);
    assert.throws(
      () => aggregatePhase13CoverageShards(aggregateOptions(root)),
      /Missing Unit coverage report/u,
    );
    copyFileSync(join(mergeFixtureRoot, 'unit-coverage-final.json'), paths.unitFinalPaths[3]!);
    assert.throws(
      () => aggregatePhase13CoverageShards({
        ...aggregateOptions(root),
        unitFinalPaths: [
          paths.unitFinalPaths[0]!,
          paths.unitFinalPaths[0]!,
          paths.unitFinalPaths[2]!,
          paths.unitFinalPaths[3]!,
        ],
        integrationFinalPaths: paths.integrationFinalPaths,
      }),
      /Duplicate Phase 1-3 coverage report path/u,
    );
  });

  test('aggregated merge rejects an outside source root and incomplete gated inventory', () => {
    const root = temporaryRoot();
    const paths = provisionEightReports(root);
    const invalid = JSON.parse(readFileSync(paths.integrationFinalPaths[0]!, 'utf8')) as Record<string, unknown>;
    invalid['/repo/outside/generated.ts'] = {
      path: '/repo/outside/generated.ts',
      statementMap: { '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } } },
      fnMap: {}, branchMap: {}, s: { '0': 1 }, f: {}, b: {},
    };
    writeFileSync(paths.integrationFinalPaths[0]!, `${JSON.stringify(invalid)}\n`, 'utf8');
    assert.throws(
      () => aggregatePhase13CoverageShards(aggregateOptions(root)),
      /unexpected source root/u,
    );

    copyFileSync(join(mergeFixtureRoot, 'integration-coverage-final.json'), paths.integrationFinalPaths[0]!);
    assert.throws(
      () => mergePhase13CoverageReports({
        ...aggregateOptions(root),
        unitFinalPaths: paths.unitFinalPaths,
        integrationFinalPaths: paths.integrationFinalPaths,
        gatedFiles: [...aggregateOptions(root).gatedFiles, 'src/modules/sync/missing.ts'],
      }),
      /Incomplete gated file set/u,
    );
  });
});
