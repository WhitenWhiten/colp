import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { test } from 'vitest';
import { isStaticContract, listDomainTestFilesSync } from '../../../scripts/shard-buckets.mjs';
import { LIBRARY_MANAGEMENT_BACKEND_INTEGRATION_SPECS } from '../../../scripts/library-management-acceptance-bindings.mjs';
import { INTEGRATION_SHARD_EXCLUDE } from '../../../scripts/vitest-project-files.mjs';
import {
  BROWSER_INCLUDE,
  EVIDENCE_INCLUDE,
  REDIS_INCLUDE,
  SYSTEM_INCLUDE,
} from '../../../vitest.workspace-projects.js';

const root = process.cwd();
const script = resolve(root, 'scripts/integration-shard.mjs');
const unitScript = resolve(root, 'scripts/unit-shard.mjs');
// Still excluded from default unit shards. Owner is the dedicated
// phase5-free-social-dependencies CI job (see docs/devops/runbooks/phase5-free-social-dependencies-ci.md).
const externallyProvisionedUnitTests = [
  'phase5-free-social-dependencies.test.ts',
];
const browserBoundUnitTests = BROWSER_INCLUDE
  .filter((file) => file.startsWith('tests/unit/'))
  .map((file) => basename(file));
// Playwright/Chromium-bound integration suite; it runs in the dedicated
// phase4a-browser CI job, never in the shared postgres shards.
const browserBoundIntegrationTests = BROWSER_INCLUDE
  .filter((file) => file.startsWith('tests/integration/'))
  .map((file) => basename(file));
const evidenceBoundIntegrationTests = EVIDENCE_INCLUDE
  .filter((file) => file.startsWith('tests/integration/'))
  .map((file) => basename(file));
const evidenceBoundUnitTests = EVIDENCE_INCLUDE
  .filter((file) => file.startsWith('tests/unit/'))
  .filter((file) => !externallyProvisionedUnitTests.includes(basename(file)))
  .map((file) => basename(file));

test('unit shards use a tighter budget than integration shards', () => {
  const source = readFileSync(unitScript, 'utf8');
  assert.match(source, /UNIT_SHARD_TEST_TIMEOUT_MS = 10_000/u);
  assert.match(source, /UNIT_SHARD_HOOK_TIMEOUT_MS = 20_000/u);
  assert.match(source, /UNIT_SHARD_MAX_WORKERS = 4/u);
  assert.match(source, /--testTimeout=\$\{UNIT_SHARD_TEST_TIMEOUT_MS\}/u);
  assert.match(source, /--hookTimeout=\$\{UNIT_SHARD_HOOK_TIMEOUT_MS\}/u);
  assert.match(source, /--maxWorkers=\$\{UNIT_SHARD_MAX_WORKERS\}/u);
  assert.match(
    source,
    /if \(list\) \{[\s\S]*process\.stdout\.write[\s\S]*\} else \{[\s\S]*spawn\(process\.execPath, \[[\s\S]*`--testTimeout=\$\{UNIT_SHARD_TEST_TIMEOUT_MS\}`/u,
    '--list mode must stay list-only; timeout flags belong only on the vitest spawn',
  );
});

test('integration shards and host file runs share a 60s/120s timeout floor', () => {
  const source = readFileSync(script, 'utf8');
  assert.match(source, /INTEGRATION_SHARD_TEST_TIMEOUT_MS = 60_000/u);
  assert.match(source, /INTEGRATION_SHARD_HOOK_TIMEOUT_MS = 120_000/u);
  assert.match(source, /--testTimeout=\$\{INTEGRATION_SHARD_TEST_TIMEOUT_MS\}/u);
  assert.match(source, /--hookTimeout=\$\{INTEGRATION_SHARD_HOOK_TIMEOUT_MS\}/u);

  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  for (const name of ['test:integration:file', 'test:integration:inner'] as const) {
    const command = packageJson.scripts[name] ?? '';
    assert.match(command, /--testTimeout=60000/u, `${name} must apply the shard test-timeout floor`);
    assert.match(command, /--hookTimeout=120000/u, `${name} must apply the shard hook-timeout floor`);
  }
});

test('integration shards are deterministic, complete and pairwise disjoint', () => {
  const shards = [1, 2, 3, 4].map((index) => execFileSync(process.execPath, [
    script,
    `--shard=${index}/4`,
    '--list',
  ], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/u));
  const flattened = shards.flat();
  const expected = listDomainTestFilesSync(root, { kind: 'integration', suffix: '.integration.test.ts' })
    .filter((file) => !INTEGRATION_SHARD_EXCLUDE.includes(file.path))
    .map((file) => file.path);

  for (const browserSuite of browserBoundIntegrationTests) {
    assert.equal(
      flattened.some((path) => path.endsWith(`/${browserSuite}`)),
      false,
      `${browserSuite} must never be selected by an integration shard`,
    );
  }

  assert.ok(shards.every((files) => files.length > 0));
  assert.equal(flattened.length, expected.length);
  assert.equal(new Set(flattened).size, flattened.length);
  assert.deepEqual([...flattened].sort(), expected);
  for (const [index, files] of shards.entries()) {
    const repeated = execFileSync(process.execPath, [
      script,
      `--shard=${index + 1}/4`,
      '--list',
    ], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/u);
    assert.deepEqual(repeated, files);
  }
});

test('Redis integration suites leave default postgres shards with an explicit owner', () => {
  for (const path of REDIS_INCLUDE) {
    assert.ok(INTEGRATION_SHARD_EXCLUDE.includes(path), `${path} must have an explicit owner transfer`);
  }
  assert.ok(INTEGRATION_SHARD_EXCLUDE.includes(
    'tests/integration/phase2/phase2-publication-redis-evidence.integration.test.ts',
  ));

  const flattened = [1, 2, 3, 4].flatMap((index) => execFileSync(process.execPath, [
    script,
    `--shard=${index}/4`,
    '--list',
  ], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/u));
  for (const path of REDIS_INCLUDE) {
    assert.equal(
      flattened.includes(path),
      false,
      `${path} must ride redis-rate-limit, not a postgres shard`,
    );
  }
  assert.equal(
    flattened.some((path) => path.endsWith('/phase2-publication-redis-evidence.integration.test.ts')),
    false,
    'publication Redis evidence must stay on evidence:phase2-publication',
  );
  assert.equal(
    flattened.filter((path) => path.endsWith('/redis-runtime.integration.test.ts')).length,
    1,
    'redis-runtime has no dedicated job; it stays on default postgres shards',
  );
  assert.equal(
    flattened.filter((path) => path.endsWith('/publication-redis-cache-postgres.integration.test.ts')).length,
    1,
    'publication-redis-cache postgres has no dedicated job; it stays on default shards',
  );
});

test('tenant-isolation postgres suites appear in default shards; dedicated jobs remain extra-evidence owners', () => {
  const searchAuthFile = 'search-authorization-postgres.integration.test.ts';
  const searchAuthPath = `tests/integration/search/${searchAuthFile}`;
  const ownedPostgresFile = 'owned-collections-postgres.integration.test.ts';
  const ownedPostgresPath = 'tests/integration/collections/owned-collections-postgres.integration.test.ts';

  assert.equal(
    INTEGRATION_SHARD_EXCLUDE.includes(searchAuthPath),
    false,
    'excludedFiles must not contain search-authorization postgres; default shards must catch a deleted tenant predicate',
  );
  assert.equal(
    INTEGRATION_SHARD_EXCLUDE.includes(ownedPostgresPath),
    false,
    'excludedFiles must not contain owned-collections postgres; default shards must catch a deleted tenant predicate',
  );

  const runner = readFileSync(resolve(root, 'scripts/library-management-acceptance.mjs'), 'utf8');
  assert.match(
    runner,
    /LIBRARY_MANAGEMENT_BACKEND_INTEGRATION_SPECS/u,
    'library-management-acceptance must run the bindings-owned extra-evidence specs',
  );
  assert.equal(
    LIBRARY_MANAGEMENT_BACKEND_INTEGRATION_SPECS.includes(ownedPostgresPath),
    true,
    'library-management-acceptance remains the extra-evidence owner; do not add a third CI job',
  );

  const flattened = [1, 2, 3, 4].flatMap((index) => execFileSync(process.execPath, [
    script,
    `--shard=${index}/4`,
    '--list',
  ], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/u));
  assert.equal(
    flattened.filter((path) => path.endsWith(`/${searchAuthFile}`)).length,
    1,
    'search-authorization postgres must appear in exactly one postgres-integration shard',
  );
  assert.equal(
    flattened.filter((path) => path.endsWith(`/${ownedPostgresFile}`)).length,
    1,
    'owned-collections postgres must appear in exactly one postgres-integration shard',
  );
});

test('local act reuses installs through committed helpers; GitHub still runs npm ci', () => {
  const reuse = readFileSync(resolve(root, '../scripts/act-reuse-install.py'), 'utf8');
  assert.match(reuse, /ACT_FORCE_INSTALL/u);
  assert.match(reuse, /colp\|colp-dev\|backend\|frontend\|extension/u);
  const applyShim = readFileSync(resolve(root, '../scripts/act-apply-shim.py'), 'utf8');
  assert.match(applyShim, /act-reuse-install\.py/u);
  assert.match(
    applyShim,
    /Skip COLP artifact download \(act\)/u,
    'act shim must not leave uses: actions/download-artifact@v7 for act to clone',
  );
  assert.match(
    applyShim,
    /Skip Playwright cache \(act\)[\s\S]{0,120}run: 'true'/u,
    'act shim must not leave uses: actions/cache@v6 for act to clone',
  );
  assert.doesNotMatch(
    applyShim,
    /Skip Playwright cache \(act\)[\s\S]{0,200}\n      with:/u,
    'act Playwright skip is a composite run step and cannot carry with:',
  );
  const workflow = readFileSync(resolve(root, '../.github/workflows/known-backend-ci.yml'), 'utf8');
  assert.match(
    workflow,
    /uses: \.\/\.github\/actions\/known-backend-setup/u,
    'GitHub postgres/quality jobs must use known-backend-setup',
  );
  const setupAction = readFileSync(
    resolve(root, '../.github/actions/known-backend-setup/action.yml'),
    'utf8',
  );
  assert.match(
    setupAction,
    /name: Frozen backend install/u,
    'known-backend-setup must keep a fresh Frozen backend install',
  );
  assert.match(
    setupAction,
    /run: npm ci/u,
    'GitHub hosted runners must still run npm ci inside known-backend-setup',
  );
  const gitignore = readFileSync(resolve(root, '../.gitignore'), 'utf8');
  assert.match(gitignore, /\.act-install-stamps\//u);
});

test('product command receipt CI owner is focused-coverage, not a phantom workflow step', () => {
  const integrationFile = 'tests/integration/product/product-command-receipt.integration.test.ts';
  const unitFile = 'tests/unit/product/product-command-receipt.test.ts';
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  // The PostgreSQL receipt suite owns its own schema + migration chain, so it
  // stays out of the parallel shared shards and the local full integration gate
  // to avoid same-database contention with the canonical mutation suites.
  const shards = [1, 2, 3, 4].map((index) => execFileSync(process.execPath, [
    script,
    `--shard=${index}/4`,
    '--list',
  ], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/u));
  const flattened = shards.flat();
  assert.equal(flattened.includes(integrationFile), false);
  assert.match(
    packageJson.scripts['test:integration:inner'] ?? '',
    /--exclude tests\/integration\/product\/product-command-receipt\.integration\.test\.ts/u,
  );

  // Local npm script remains developer convenience. CI named owner is
  // focused-coverage (ci:focused-coverage); unit collect is a passenger.
  const inner = packageJson.scripts['test:phase1:command-receipt:inner'] ?? '';
  const outer = packageJson.scripts['test:phase1:command-receipt'] ?? '';
  assert.ok(
    inner.includes(unitFile) && inner.includes(integrationFile),
    'local test:phase1:command-receipt:inner must still list the receipt unit and PostgreSQL suites',
  );
  assert.match(outer, /scripts\/with-postgres\.mjs/u);
  assert.match(outer, /test:phase1:command-receipt:inner/u);

  const workflow = readFileSync(resolve(root, '../.github/workflows/known-backend-ci.yml'), 'utf8');
  assert.doesNotMatch(
    workflow,
    /test:phase1:command-receipt/u,
    'workflow must not name a test:phase1:command-receipt step; focused-coverage is the owner',
  );
  assert.match(
    workflow,
    /name: Focused coverage thresholds\n {8}run: npm run ci:focused-coverage/u,
    'focused-coverage job must remain the named CI owner of the receipt suite',
  );

  const focusedConfig = readFileSync(resolve(root, 'vitest.focused-coverage.config.ts'), 'utf8');
  assert.match(focusedConfig, /tests\/integration\/product\/product-command-receipt\.integration\.test\.ts/u);
  assert.match(focusedConfig, /hookTimeout:\s*120_000/u);
  assert.match(focusedConfig, /testTimeout:\s*60_000/u);

  const coverageConfig = readFileSync(resolve(root, 'vitest.coverage.config.ts'), 'utf8');
  const coverageFiles = readFileSync(resolve(root, 'scripts/phase13-coverage-test-files.mjs'), 'utf8');
  assert.match(
    coverageFiles,
    /PHASE13_UNIT_COVERAGE_INCLUDE = Object\.freeze\(\[\s*'tests\/unit\/\*\*\/\*\.test\.ts',\s*'tests\/integration\/product\/product-command-receipt\.integration\.test\.ts',/u,
    'phase1-3 unit coverage collect must include the receipt integration suite',
  );
  assert.match(
    coverageConfig,
    /hookTimeout:\s*120_000/u,
    'unit coverage collect must share focused-coverage hookTimeout for receipt beforeAll',
  );
  assert.match(
    coverageConfig,
    /testTimeout:\s*coverageSuite === 'integration' \? 15_000 : 60_000/u,
    'unit coverage collect must use 60s testTimeout because it carries the receipt suite',
  );
});

test('unit shards are deterministic, complete and pairwise disjoint', () => {
  const shards = [1, 2, 3, 4].map((index) => execFileSync(process.execPath, [
    unitScript,
    `--shard=${index}/4`,
    '--list',
  ], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/u));
  const flattened = shards.flat();
  const expected = listDomainTestFilesSync(root, { kind: 'unit', suffix: '.test.ts' })
    .filter((file) => !isStaticContract(file.name))
    .filter((file) => !externallyProvisionedUnitTests.includes(file.name))
    .filter((file) => !browserBoundUnitTests.includes(file.name))
    .filter((file) => !evidenceBoundUnitTests.includes(file.name))
    .filter((file) => !SYSTEM_INCLUDE.some((path) => path.endsWith(`/${file.name}`)))
    .map((file) => file.path);

  assert.ok(shards.every((files) => files.length > 0));
  assert.equal(flattened.length, expected.length);
  assert.equal(new Set(flattened).size, flattened.length);
  assert.deepEqual([...flattened].sort(), expected);
  for (const browser of browserBoundUnitTests) {
    assert.equal(flattened.some((path) => path.endsWith(`/${browser}`)), false);
  }
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const externalAcceptanceScript = packageJson.scripts['test:phase5:free-social-acceptance:contract'] ?? '';
  for (const external of externallyProvisionedUnitTests) {
    assert.equal(flattened.some((path) => path.endsWith(`/${external}`)), false);
    assert.match(externalAcceptanceScript, new RegExp(`tests/unit/[^/]+/${external.replaceAll('.', '\\.')}`, 'u'));
  }
  const evidenceUnitScript = packageJson.scripts['test:evidence:unit'] ?? '';
  const evidenceIntegrationScript = packageJson.scripts['test:evidence:integration'] ?? '';
  for (const name of evidenceBoundUnitTests) {
    assert.equal(flattened.some((path) => path.endsWith(`/${name}`)), false);
    assert.match(
      evidenceUnitScript,
      new RegExp(`tests/unit/[^/\\s]+/${name.replaceAll('.', '\\.')}`),
      `test:evidence:unit must own ${name}`,
    );
  }
  for (const name of evidenceBoundIntegrationTests) {
    assert.equal(flattened.some((path) => path.endsWith(`/${name}`)), false);
    assert.match(
      evidenceIntegrationScript,
      new RegExp(`tests/integration/[^/\\s]+/${name.replaceAll('.', '\\.')}`),
      `test:evidence:integration must own ${name}`,
    );
  }
  const workflow = readFileSync(resolve(root, '../.github/workflows/known-backend-ci.yml'), 'utf8');
  assert.match(workflow, /backend-evidence:/u);
  assert.match(workflow, /npm run test:evidence/u);

  for (const [index, files] of shards.entries()) {
    const repeated = execFileSync(process.execPath, [
      unitScript,
      `--shard=${index + 1}/4`,
      '--list',
    ], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/u);
    assert.deepEqual(repeated, files);
  }
});
