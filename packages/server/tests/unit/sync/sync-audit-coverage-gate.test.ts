import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { parse } from 'yaml';
import { inspectSyncAuditCoverage } from '../../../scripts/check-sync-audit-coverage.mjs';
import { SYNC_AUDIT_OWNERS, SYNC_AUDIT_UNIT_TESTS, SYNC_AUDIT_POSTGRES_TESTS,
  SYNC_AUDIT_METRICS } from '../../../scripts/sync-audit-coverage-scope.mjs';
import current from '../../../vitest.sync-audit-coverage.config.js';
import legacy from '../../../vitest.coverage.config.js';
import focused from '../../../vitest.focused-coverage.config.js';
import phase45 from '../../../vitest.phase4-5-coverage.config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

// Deliberately synthetic inputs test rejection rules, never coverage evidence.
function fixture() {
  const metric = { total: 100, covered: 80, skipped: 0, pct: 80 };
  const summary = Object.fromEntries(SYNC_AUDIT_OWNERS.map(owner => [resolve(root, owner.path),
    Object.fromEntries(SYNC_AUDIT_METRICS.map(name => [name, { ...metric }]))]));
  const coverage = Object.fromEntries(SYNC_AUDIT_OWNERS.map(owner => [resolve(root, owner.path),
    { s: { 0: 1 }, b: { 0: [1, 0] }, f: { 0: 1 } }]));
  const baseline = { schemaVersion: 1, measuredAtCommit: 'f'.repeat(40),
    measurementRun: 'https://github.com/synthetic/fixture/actions/runs/1',
    minimums: Object.fromEntries(SYNC_AUDIT_OWNERS.filter(owner => owner.kind === 'transaction')
      .map(owner => [owner.path, Object.fromEntries(SYNC_AUDIT_METRICS.map(metric => [metric, 80]))])) };
  const testResults = { success: true, testResults: [...SYNC_AUDIT_UNIT_TESTS, ...SYNC_AUDIT_POSTGRES_TESTS]
    .map(file => ({ name: resolve(root, file), status: 'passed', assertionResults: [{ status: 'passed' }] })) };
  return { root, summary, coverage, baseline, testResults };
}

test('four metrics per owner pass only with complete unit and PostgreSQL execution evidence', () => {
  const result = inspectSyncAuditCoverage(fixture());
  assert.deepEqual(result.errors, []);
  assert.equal(result.passed, true);
  assert.equal(result.passedUnitFiles, SYNC_AUDIT_UNIT_TESTS.length);
  assert.equal(result.passedPostgresFiles, 4);
});

test.each(SYNC_AUDIT_METRICS)('a below-floor %s metric fails even when the other metrics pass', metric => {
  const input = fixture(), owner = SYNC_AUDIT_OWNERS[0]!;
  input.summary[resolve(root, owner.path)]![metric] = { total: 100, covered: 79, skipped: 0, pct: 79 };
  const result = inspectSyncAuditCoverage(input);
  assert.equal(result.passed, false);
  assert.ok(result.errors.some(error => error.includes(`${metric} 79% is below 80%`)));
});

test('a removed owner, absent final report, and absent metric all fail closed', () => {
  const input = fixture(), path = resolve(root, SYNC_AUDIT_OWNERS[0]!.path);
  assert.equal(inspectSyncAuditCoverage({ ...input, owners: SYNC_AUDIT_OWNERS.slice(1) }).passed, false);
  delete input.coverage[path];
  assert.ok(inspectSyncAuditCoverage(input).errors.some(error => error.includes('Missing V8 coverage report')));
  const missingMetric = fixture();
  delete missingMetric.summary[path]!.branches;
  assert.ok(inspectSyncAuditCoverage(missingMetric).errors.some(error => error.includes('invalid branches coverage')));
});

test('unmeasured, zero and missing transaction floors cannot produce a passing gate', () => {
  const input = fixture(), owner = SYNC_AUDIT_OWNERS.find(owner => owner.kind === 'transaction')!;
  input.baseline.measuredAtCommit = '';
  assert.ok(inspectSyncAuditCoverage(input).errors.some(error => error.includes('baseline is unmeasured')));
  input.baseline.minimums[owner.path]!.branches = 0;
  assert.ok(inspectSyncAuditCoverage(input).errors.some(error => error.includes('non-zero branches floor')));
  delete input.baseline.minimums[owner.path];
  assert.ok(inspectSyncAuditCoverage(input).errors.some(error => error.includes('every current transaction owner')));
});

test.each(['absent', 'pending', 'failed', 'empty'] as const)('a %s PostgreSQL suite cannot be replaced by unit coverage', mode => {
  const input = fixture(), path = resolve(root, SYNC_AUDIT_POSTGRES_TESTS[0]!);
  const pg = input.testResults.testResults.find(result => result.name === path)!;
  if (mode === 'absent') input.testResults.testResults = input.testResults.testResults.filter(result => result !== pg);
  else if (mode === 'empty') pg.assertionResults = [];
  else pg.assertionResults[0]!.status = mode;
  const result = inspectSyncAuditCoverage(input);
  assert.equal(result.passed, false);
  assert.equal(result.passedPostgresFiles, 3);
  assert.ok(result.errors.some(error => error.includes('did not fully execute and pass')));
});

test('public legacy coverage configurations load the explicit current scope without missing phase imports', () => {
  for (const config of [legacy, focused, phase45]) assert.equal(config, current);
  assert.deepEqual(current.test?.include, [...SYNC_AUDIT_UNIT_TESTS, ...SYNC_AUDIT_POSTGRES_TESTS]);
  assert.equal(current.test?.maxWorkers, 1);
});

test('CI executes real PG collection, always checks/uploads evidence, and requires this gate without replacing the six shards', () => {
  const workflow = parse(readFileSync(resolve(root, '../../.github/workflows/colp-ci.yml'), 'utf8'));
  const job = workflow.jobs['server-sync-audit-coverage'];
  assert.ok(job.steps.some((step: { run?: string }) => step.run === 'npm run test:coverage:sync-audit'));
  assert.ok(job.steps.some((step: { run?: string; if?: string }) => step.run === 'npm run check:coverage:sync-audit'
    && step.if === 'always()'));
  assert.ok(job.steps.some((step: { uses?: string; if?: string }) => step.uses?.startsWith('actions/upload-artifact@')
    && step.if === 'always()'));
  assert.ok(workflow.jobs['ci-gate'].needs.includes('server-sync-audit-coverage'));
  assert.deepEqual(workflow.jobs['server-integration'].strategy.matrix.shard, [1, 2, 3, 4, 5, 6]);
  const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts;
  assert.match(scripts['test:coverage:sync-audit'], /with-postgres\.mjs --isolated-owner/);
  assert.match(scripts['test:focused-coverage'], /check:coverage:sync-audit/);
});
