import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';
import {
  PHASE2B_ACCEPTANCE_FAIL_CLOSED,
  PHASE2B_ACCEPTANCE_FAIL_CLOSED_PREFIX,
  PHASE2B_ACCEPTANCE_FORBIDDEN_RUNNER_PATTERNS,
  PHASE2B_ACCEPTANCE_NPM_SCRIPTS,
  PHASE2B_ACCEPTANCE_SCHEMA_VERSION,
  PHASE2B_CORPUS_FILES,
  PHASE2B_DELEGATED_GATE_IDS,
  PHASE2B_GATE_IDS,
  PHASE2B_OWNED_INTEGRATION_SPECS,
  PHASE2B_PINNED_CORPUS_DIGEST,
  PHASE2B_PINNED_THRESHOLD_DIGEST,
  PHASE2B_PLAN_LOCATIONS,
  PHASE2B_REGRESSION_SPECS,
  PHASE2B_SEARCH_AUTHORIZATION_SPEC,
  PHASE2B_SEARCH_BROWSER_SPEC,
  PHASE2B_SEARCH_HTTP_SPEC,
  PHASE2B_THRESHOLD_FILES,
} from '../../../scripts/phase2b-acceptance-bindings.mjs';

const backendRoot = resolve(import.meta.dirname, '../../..');
const repositoryRoot = resolve(backendRoot, '..');

test('P2B-26 exposes one fail-closed Phase 2B acceptance command with every owned gate', () => {
  const packageJson = JSON.parse(readFileSync(resolve(backendRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const command = packageJson.scripts['evidence:phase2b-acceptance'];
  assert.equal(command, 'node scripts/with-postgres.mjs -- node scripts/phase2b-acceptance.mjs');
  const runner = readFileSync(resolve(backendRoot, 'scripts/phase2b-acceptance.mjs'), 'utf8');
  assert.match(runner, /from '\.\/phase2b-acceptance-bindings\.mjs'/u);
  assert.equal(PHASE2B_ACCEPTANCE_SCHEMA_VERSION, 'known.phase2b.acceptance.v1');
  assert.equal(PHASE2B_ACCEPTANCE_FAIL_CLOSED_PREFIX, 'FAIL-CLOSED');
  assert.deepEqual([...PHASE2B_THRESHOLD_FILES], [
    'search-postgres-thresholds.json', 'search-postgres-thresholds.schema.json',
  ]);
  assert.deepEqual([...PHASE2B_CORPUS_FILES], [
    'search-quality-corpus.v1.json', 'search-quality-corpus.schema.json',
  ]);
  assert.ok(PHASE2B_OWNED_INTEGRATION_SPECS.some((path) =>
    path.endsWith('search-postgres-baseline.integration.test.ts')));
  assert.ok(PHASE2B_OWNED_INTEGRATION_SPECS.some((path) =>
    path.endsWith('search-profile-annotation-plan.integration.test.ts')));
  assert.equal(PHASE2B_SEARCH_AUTHORIZATION_SPEC,
    'tests/integration/search/search-authorization-postgres.integration.test.ts');
  assert.ok(PHASE2B_OWNED_INTEGRATION_SPECS.includes(PHASE2B_SEARCH_AUTHORIZATION_SPEC));
  assert.equal(PHASE2B_SEARCH_HTTP_SPEC,
    'tests/integration/search/search-product-http-postgres.integration.test.ts');
  assert.equal(PHASE2B_SEARCH_BROWSER_SPEC, 'search-real-stack-acceptance.spec.ts');
  assert.deepEqual([...PHASE2B_PLAN_LOCATIONS], ['first', 'middle', 'final']);
  assert.deepEqual([...PHASE2B_GATE_IDS], [
    'migration', 'openapi', 'telemetry', 'search-postgres', 'search-http',
    'search-frontend', 'frontend-build', 'real-stack',
  ]);
  assert.deepEqual(Object.values(PHASE2B_REGRESSION_SPECS), [
    'public-profile-acceptance.spec.ts', 'annotation-acceptance.spec.ts',
    'relation-acceptance.spec.ts', 'saved-resource-acceptance.spec.ts',
    'reading-progress-acceptance.spec.ts',
  ]);
  assert.deepEqual([...PHASE2B_ACCEPTANCE_NPM_SCRIPTS], [
    'db:migration-smoke', 'openapi:ci', 'build', 'test:e2e:real-stack',
  ]);
  assert.equal(PHASE2B_ACCEPTANCE_FAIL_CLOSED.sourceTreeChanged,
    'source tree changed while Phase 2B acceptance was running');
  assert.equal(PHASE2B_ACCEPTANCE_FAIL_CLOSED.missingProbe, 'reported a missing or skipped probe');
  assert.equal(PHASE2B_ACCEPTANCE_FAIL_CLOSED.mockedProduct,
    'Search browser acceptance cannot substitute a mocked Product response');
  assert.equal(PHASE2B_ACCEPTANCE_FAIL_CLOSED.regressionNotExecuted,
    'regression spec was not executed by Playwright');
  for (const delegated of PHASE2B_DELEGATED_GATE_IDS) {
    assert.doesNotMatch(runner, new RegExp(`runGate\\('${delegated}'`, 'u'), delegated);
  }
  assert.match(runner, /code !== 0/u);
  assert.match(runner, /playwright-chromium/u);
  for (const pattern of PHASE2B_ACCEPTANCE_FORBIDDEN_RUNNER_PATTERNS) {
    assert.doesNotMatch(runner, pattern);
  }
});

test('P2B-26 runner rejects missing infrastructure before executing a gate', () => {
  const environment = { ...process.env };
  delete environment.DATABASE_URL;
  delete environment.KNOWN_TEST_DATABASE_URL;
  const result = spawnSync(process.execPath, [resolve(backendRoot, 'scripts/phase2b-acceptance.mjs')], {
    cwd: backendRoot, env: environment, encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0);
  assert.match(output, /FAIL-CLOSED.*DATABASE_URL/u);
  assert.doesNotMatch(output, /accepted|\bskip(?:ped)?\b/iu);
});

test('P2B-26 pinned contract digests equal the reviewed threshold and corpus bytes', () => {
  for (const [expected, files] of [
    [PHASE2B_PINNED_THRESHOLD_DIGEST, PHASE2B_THRESHOLD_FILES],
    [PHASE2B_PINNED_CORPUS_DIGEST, PHASE2B_CORPUS_FILES],
  ] as const) {
    const digest = createHash('sha256');
    for (const file of files) {
      const bytes = readFileSync(resolve(backendRoot, 'tests/fixtures/phase2b', file));
      // Pin digests are recorded from LF-normalized fixture bytes (git/CI); Windows CRLF checkouts must match.
      digest.update(bytes.toString('utf8').replace(/\r\n/g, '\n')).update('\0');
    }
    assert.equal(expected, digest.digest('hex'));
  }
});

test('P2B-26 artifact schema binds exact source, environment, migrations and every gate', () => {
  const schema = JSON.parse(readFileSync(resolve(backendRoot,
    'tests/fixtures/phase2b/phase2b-acceptance-artifact.schema.json'), 'utf8')) as Record<string, unknown>;
  const serialized = JSON.stringify(schema);
  for (const required of ['sourceRevision', 'sourceDigest', 'sourceFileCount', 'thresholdVersion', 'thresholdDigest',
    'corpusVersion', 'corpusDigest', 'postgresql', 'node', 'os', 'cpu', 'chromium', 'playwright',
    'migrationVersions', 'quality', 'plans', 'performance', 'authorization', 'http', 'browser',
    'regressions', 'resultSummary']) {
    assert.match(serialized, new RegExp(escapeRegExp(required), 'u'), required);
  }
  assert.match(serialized, /"minItems":8,"maxItems":8/u);
  assert.doesNotMatch(serialized, /backend-unit|backend-integration|frontend-unit/u);
  assert.match(serialized, /additionalProperties":false/u);
});

test('P2B-26 closeout enables Search only through the production flag and records verified status', () => {
  const flags = readFileSync(resolve(repositoryRoot, 'Known-Frontend/web/src/api/featureFlags.ts'), 'utf8');
  const status = readFileSync(resolve(backendRoot, 'docs/09-phase-execution-status.md'), 'utf8');
  assert.match(flags, /search:\s*true/u);
  assert.doesNotMatch(flags, /VITE_SEARCH_ACCEPTANCE/u);
  assert.match(status, /Phase 2B：增量产品能力\s*\|\s*\*\*Verified\*\*/u);
  assert.match(status, /phase2b-acceptance-2026-07-26\.md/u);
});

test('CI owns the unique Phase 2B acceptance runner and cannot reduce it to mock or focused unit evidence', () => {
  const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/known-backend-ci.yml'), 'utf8');
  assert.match(workflow, /phase2b-acceptance:/u);
  assert.match(workflow, /npm run evidence:phase2b-acceptance/u);
  assert.match(workflow, /PLAYWRIGHT|playwright|Chromium/u);
  assert.doesNotMatch(workflow, /phase2b-acceptance[\s\S]{0,800}npm run test:unit/u);
  assert.doesNotMatch(workflow, /VITE_SEARCH_ACCEPTANCE/u);
});

test('search-authorization postgres rides default shards; phase2b-acceptance remains extra-evidence owner', () => {
  const searchAuthFile = 'search-authorization-postgres.integration.test.ts';
  const searchAuthPath = PHASE2B_SEARCH_AUTHORIZATION_SPEC;
  assert.equal(searchAuthPath,
    'tests/integration/search/search-authorization-postgres.integration.test.ts');
  assert.ok(
    PHASE2B_OWNED_INTEGRATION_SPECS.includes(searchAuthPath),
    'phase2b-acceptance remains the extra-evidence owner of search-authorization postgres',
  );

  const shard = readFileSync(resolve(backendRoot, 'scripts/integration-shard.mjs'), 'utf8');
  const excludedStart = shard.indexOf('excludedFiles = new Set');
  assert.ok(excludedStart >= 0, 'integration-shard.mjs must declare excludedFiles');
  const excludedEnd = shard.indexOf(']);', excludedStart);
  assert.ok(excludedEnd > excludedStart, 'excludedFiles must be a closed Set literal');
  assert.equal(
    shard.slice(excludedStart, excludedEnd).includes(`'${searchAuthFile}'`),
    false,
    'search-authorization postgres must appear on default postgres-integration shards',
  );

  const flattened = [1, 2, 3, 4].flatMap((index) => execFileSync(process.execPath, [
    resolve(backendRoot, 'scripts/integration-shard.mjs'),
    `--shard=${index}/4`,
    '--list',
  ], { cwd: backendRoot, encoding: 'utf8' }).trim().split(/\r?\n/u).filter(Boolean));
  assert.equal(
    flattened.filter((path) => path.endsWith(`/${searchAuthFile}`)).length,
    1,
    'search-authorization postgres must appear in exactly one integration shard --list',
  );
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
