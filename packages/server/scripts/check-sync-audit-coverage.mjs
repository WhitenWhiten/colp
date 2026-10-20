import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SYNC_AUDIT_OWNERS, SYNC_AUDIT_UNIT_TESTS, SYNC_AUDIT_POSTGRES_TESTS,
  SYNC_AUDIT_METRICS, SYNC_AUDIT_REPORT_DIRECTORY } from './sync-audit-coverage-scope.mjs';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const relativePath = (path, root) => relative(root, isAbsolute(path) ? path : resolve(root, path)).replaceAll('\\', '/');
const keyedPaths = (report, root) => new Map(Object.entries(report ?? {})
  .filter(([path]) => path !== 'total').map(([path, value]) => [relativePath(path, root), value]));

/** Exported for failure-mode tests. Fixtures in those tests are not measurements. */
export function inspectSyncAuditCoverage({ summary, coverage, testResults, baseline, root = serverRoot,
  owners = SYNC_AUDIT_OWNERS, unitTests = SYNC_AUDIT_UNIT_TESTS, postgresTests = SYNC_AUDIT_POSTGRES_TESTS }) {
  const errors = [], measurements = {};
  if (owners.length !== 12 || owners.filter(owner => owner.kind === 'pure').length !== 3
    || owners.filter(owner => owner.kind === 'transaction').length !== 9
    || owners.filter(owner => owner.kind === 'transaction' && owner.minimum === 80).length !== 1
    || owners.some(owner => owner.minimum !== undefined && owner.minimum !== 80)
    || new Set(owners.map(owner => owner.path)).size !== owners.length) errors.push('Invalid twelve-owner audit scope');
  const summaries = keyedPaths(summary, root), covered = keyedPaths(coverage, root);
  const transactionPaths = owners.filter(owner => owner.kind === 'transaction' && owner.minimum === undefined)
    .map(owner => owner.path).sort();
  if (baseline?.schemaVersion !== 1 || JSON.stringify(Object.keys(baseline?.minimums ?? {}).sort()) !== JSON.stringify(transactionPaths)) {
    errors.push('Transaction baseline must name every current transaction owner using a measured ratchet exactly once');
  }
  if (!/^[0-9a-f]{40}$/u.test(baseline?.measuredAtCommit ?? '')
    || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+$/u.test(baseline?.measurementRun ?? '')) {
    errors.push('Transaction baseline is unmeasured: record the real passing unit+PG commit and CI run');
  }
  for (const owner of owners) {
    if (!existsSync(resolve(root, owner.path))) errors.push(`Missing source owner: ${owner.path}`);
    const metrics = summaries.get(owner.path), fileCoverage = covered.get(owner.path);
    if (!metrics || !fileCoverage || ['s', 'b', 'f'].some(metric => !fileCoverage[metric]
      || Object.keys(fileCoverage[metric]).length === 0)) {
      errors.push(`Missing V8 coverage report for owner: ${owner.path}`);
      continue;
    }
    measurements[owner.path] = {};
    for (const metric of SYNC_AUDIT_METRICS) {
      const value = metrics[metric];
      if (!value || !Number.isSafeInteger(value.total) || value.total < 1
        || !Number.isSafeInteger(value.covered) || value.covered < 0 || value.covered > value.total
        || !Number.isFinite(value.pct) || value.pct < 0 || value.pct > 100) {
        errors.push(`Missing or invalid ${metric} coverage: ${owner.path}`);
        continue;
      }
      measurements[owner.path][metric] = value.pct;
      const minimum = owner.kind === 'pure' || owner.minimum === 80 ? 80 : baseline?.minimums?.[owner.path]?.[metric];
      if (!Number.isFinite(minimum) || minimum <= 0 || minimum > 100) {
        errors.push(`Unmeasured or invalid non-zero ${metric} floor: ${owner.path}`);
      } else if (value.pct < minimum) errors.push(`${owner.path}: ${metric} ${value.pct}% is below ${minimum}%`);
    }
  }
  const reportedTests = new Map((testResults?.testResults ?? []).map(file => [relativePath(file.name, root), file]));
  const completed = file => {
    const result = reportedTests.get(file);
    return result?.status === 'passed' && Array.isArray(result.assertionResults)
      && result.assertionResults.length > 0 && result.assertionResults.every(assertion => assertion.status === 'passed');
  };
  if (unitTests.length === 0 || postgresTests.length !== 7) errors.push('Audit execution requires unit tests and all seven real PostgreSQL files');
  if (testResults?.success !== true) errors.push('The combined unit+PostgreSQL run did not pass');
  for (const file of [...unitTests, ...postgresTests]) {
    if (!existsSync(resolve(root, file))) errors.push(`Missing selected test file: ${file}`);
    if (!completed(file)) {
      errors.push(`Selected test file did not fully execute and pass: ${file}`);
    }
  }
  return { passed: errors.length === 0, errors, measurements,
    passedUnitFiles: unitTests.filter(completed).length,
    passedPostgresFiles: postgresTests.filter(completed).length };
}

export function checkSyncAuditCoverage(root = serverRoot) {
  const directory = resolve(root, SYNC_AUDIT_REPORT_DIRECTORY);
  const missing = [];
  const read = path => {
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { missing.push(`Cannot read report ${relative(root, path)}: ${error.message}`); return null; }
  };
  const summaryPath = resolve(directory, 'coverage-summary.json');
  const report = inspectSyncAuditCoverage({ root,
    summary: read(summaryPath), coverage: read(resolve(directory, 'coverage-final.json')),
    testResults: read(resolve(directory, 'test-results.json')),
    baseline: read(resolve(root, 'scripts/sync-audit-coverage-baseline.json')),
  });
  report.errors.unshift(...missing);
  report.passed = report.errors.length === 0;
  const evidence = { ...report, provider: 'v8', measuredAt: new Date().toISOString(),
    commit: process.env.GITHUB_SHA ?? null,
    run: process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY
      ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
    summarySha256: existsSync(summaryPath) ? createHash('sha256').update(readFileSync(summaryPath)).digest('hex') : null };
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'audit-measurement.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  for (const [path, metrics] of Object.entries(report.measurements)) {
    console.log(`${path}: ${SYNC_AUDIT_METRICS.map(metric => `${metric}=${metrics[metric] ?? 'MISSING'}%`).join(' ')}`);
  }
  for (const error of report.errors) console.error(`[sync-audit-coverage] ${error}`);
  return report.passed;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!checkSyncAuditCoverage()) process.exitCode = 1;
}
