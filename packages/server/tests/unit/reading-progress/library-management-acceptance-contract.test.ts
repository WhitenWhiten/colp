import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';
import {
  LIBRARY_MANAGEMENT_ACCEPTANCE_FAIL_CLOSED,
  LIBRARY_MANAGEMENT_ACCEPTANCE_FAIL_CLOSED_PREFIX,
  LIBRARY_MANAGEMENT_ACCEPTANCE_FORBIDDEN_RUNNER_PATTERNS,
  LIBRARY_MANAGEMENT_ACCEPTANCE_NPM_SCRIPTS,
  LIBRARY_MANAGEMENT_ACCEPTANCE_SCHEMA_VERSION,
  LIBRARY_MANAGEMENT_BACKEND_INTEGRATION_SPECS,
  LIBRARY_MANAGEMENT_GATE_IDS,
  LIBRARY_MANAGEMENT_OWNED_COLLECTIONS_POSTGRES,
  LIBRARY_MANAGEMENT_TYPESCRIPT_GATE,
} from '../../../scripts/library-management-acceptance-bindings.mjs';

const backendRoot = resolve(import.meta.dirname, '../../..');
const repositoryRoot = resolve(backendRoot, '..');

test('LM-06 exposes one source-bound fail-closed Library Management acceptance command', () => {
  const packageJson = JSON.parse(readFileSync(resolve(backendRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts['evidence:library-management-acceptance'],
    'node scripts/with-postgres.mjs -- node scripts/library-management-acceptance.mjs',
  );

  const runner = readFileSync(resolve(backendRoot, 'scripts/library-management-acceptance.mjs'), 'utf8');
  assert.match(runner, /from '\.\/library-management-acceptance-bindings\.mjs'/u);
  assert.equal(LIBRARY_MANAGEMENT_ACCEPTANCE_SCHEMA_VERSION,
    'known.library-management.backend-acceptance.v2');
  assert.equal(LIBRARY_MANAGEMENT_ACCEPTANCE_FAIL_CLOSED_PREFIX, 'FAIL-CLOSED');
  assert.equal(LIBRARY_MANAGEMENT_TYPESCRIPT_GATE, 'library-management-typescript-gate.mjs');
  assert.deepEqual([...LIBRARY_MANAGEMENT_GATE_IDS], [
    'migration', 'openapi', 'acceptance-contract', 'backend-unit', 'backend-integration',
    'backend-typecheck', 'backend-lint', 'backend-imports', 'backend-build',
  ]);
  assert.deepEqual([...LIBRARY_MANAGEMENT_ACCEPTANCE_NPM_SCRIPTS], [
    'db:migration-smoke:inner', 'openapi:ci', 'lint', 'check:imports',
  ]);
  assert.equal(LIBRARY_MANAGEMENT_ACCEPTANCE_FAIL_CLOSED.sourceTreeChanged,
    'source tree changed while Library Management acceptance was running');
  assert.equal(LIBRARY_MANAGEMENT_ACCEPTANCE_FAIL_CLOSED.missingProbe,
    'reported a missing or skipped probe');
  assert.match(runner, /sourceRevision/u);
  assert.match(runner, /collectionList/u);
  for (const pattern of LIBRARY_MANAGEMENT_ACCEPTANCE_FORBIDDEN_RUNNER_PATTERNS) {
    assert.doesNotMatch(runner, pattern);
  }
});

test('LM-06 differential TypeScript gate fails closed on any diagnostic outside the reviewed Sync baseline', () => {
  const environment = {
    ...process.env,
    KNOWN_LIBRARY_MANAGEMENT_TYPECHECK_NEGATIVE_CONTROL: '1',
  };
  const result = spawnSync(process.execPath, [
    resolve(backendRoot, 'scripts/library-management-typescript-gate.mjs'),
  ], { cwd: backendRoot, env: environment, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /unreviewed diagnostics[\s\S]*unreviewed\.ts/u);
}, 30_000);

test('LM-06 runner rejects missing PostgreSQL before executing a gate', () => {
  const environment = { ...process.env };
  delete environment.DATABASE_URL;
  delete environment.KNOWN_TEST_DATABASE_URL;
  const result = spawnSync(process.execPath, [resolve(backendRoot, 'scripts/library-management-acceptance.mjs')], {
    cwd: backendRoot,
    env: environment,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0);
  assert.match(output, /FAIL-CLOSED.*DATABASE_URL/u);
  assert.doesNotMatch(output, /accepted|\bskip(?:ped)?\b/iu);
});

test('LM-06 artifact schema closes every source, contract, environment and gate field', () => {
  const schema = JSON.parse(readFileSync(resolve(
    backendRoot,
    'tests/fixtures/library-management/library-management-acceptance-artifact.schema.json',
  ), 'utf8')) as Record<string, unknown>;
  const serialized = JSON.stringify(schema);
  for (const required of [
    'sourceRevision', 'sourceDigest', 'sourceFileCount', 'migrationHead', 'migrationVersions', 'migrationDigest',
    'openapiVersion', 'clientContractVersion', 'openapiBundleDigest', 'backendClientDigest',
    'postgresql', 'node', 'os', 'cpu',
    'collectionList', 'gates', 'resultSummary', 'outputDigest', 'artifactDigest',
  ]) assert.match(serialized, new RegExp(escapeRegExp(required), 'u'), required);
  assert.match(serialized, /additionalProperties":false/u);
  assert.match(serialized, /"maxItems":9/u);
  for (const gate of ['migration', 'openapi', 'acceptance-contract', 'backend-unit', 'backend-integration',
    'backend-typecheck', 'backend-lint', 'backend-imports', 'backend-build']) {
    assert.match(serialized, new RegExp(`"const":"${gate}"`, 'u'), gate);
  }
});

test('LM-06 keeps the Library Management plan and historical acceptance evidence documented', () => {
  const roadmap = readFileSync(resolve(backendRoot, 'docs/06-delivery-roadmap.md'), 'utf8');
  const docsIndex = readFileSync(resolve(backendRoot, 'docs/README.md'), 'utf8');
  const evidence = readFileSync(resolve(
    backendRoot,
    'docs/evidence/library-management-acceptance-2026-07-26.md',
  ), 'utf8');
  for (const source of [roadmap, docsIndex, evidence]) {
    assert.match(source, /Library Management/u);
  }
  assert.match(evidence, /accepted[^\n]*true|实际执行结果/iu);
  assert.match(evidence, /evidence:library-management-acceptance/u);
  assert.doesNotMatch(evidence, /production deployment verified|new protocol profile/iu);
});

test('CI owns the unique Library Management acceptance runner and uploads its closed artifact', () => {
  const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/known-backend-ci.yml'), 'utf8');
  const job = /\n  library-management-acceptance:\s*([\s\S]*?)\n  ci-gate:/u.exec(workflow)?.[1];
  assert.ok(job);
  assert.match(workflow, /library-management-acceptance:/u);
  assert.match(job, /npm run evidence:library-management-acceptance/u);
  assert.match(job, /KNOWN_LIBRARY_MANAGEMENT_ACCEPTANCE_OUTPUT/u);
  assert.match(job, /known-library-management-acceptance/u);
  // The shared known-backend-setup input `playwright: 'none'` is the explicit
  // opt-out; any other Playwright/frontend mention stays banned.
  assert.doesNotMatch(job, /Known-Frontend|playwright(?!: 'none')|npm run test:unit/iu);
});

test('owned-collections postgres rides default shards; library-management-acceptance remains extra-evidence owner', () => {
  const ownedPostgresPath = LIBRARY_MANAGEMENT_OWNED_COLLECTIONS_POSTGRES;
  const ownedPostgresFile = 'owned-collections-postgres.integration.test.ts';
  assert.equal(ownedPostgresPath,
    'tests/integration/collections/owned-collections-postgres.integration.test.ts');
  assert.equal(
    LIBRARY_MANAGEMENT_BACKEND_INTEGRATION_SPECS.includes(ownedPostgresPath),
    true,
    'the existing library-management runner must keep owning the owned-collections postgres suite',
  );

  const shard = readFileSync(resolve(backendRoot, 'scripts/integration-shard.mjs'), 'utf8');
  const excludedStart = shard.indexOf('excludedFiles = new Set');
  assert.ok(excludedStart >= 0, 'integration-shard.mjs must declare excludedFiles');
  const excludedEnd = shard.indexOf(']);', excludedStart);
  assert.ok(excludedEnd > excludedStart, 'excludedFiles must be a closed Set literal');
  assert.equal(
    shard.slice(excludedStart, excludedEnd).includes(`'${ownedPostgresFile}'`),
    false,
    'owned-collections postgres must appear on default postgres-integration shards',
  );

  const flattened = [1, 2, 3, 4].flatMap((index) => execFileSync(process.execPath, [
    resolve(backendRoot, 'scripts/integration-shard.mjs'),
    `--shard=${index}/4`,
    '--list',
  ], { cwd: backendRoot, encoding: 'utf8' }).trim().split(/\r?\n/u).filter(Boolean));
  assert.equal(
    flattened.filter((path) => path.endsWith(`/${ownedPostgresFile}`)).length,
    1,
    'owned-collections postgres must appear in exactly one integration shard --list',
  );
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
