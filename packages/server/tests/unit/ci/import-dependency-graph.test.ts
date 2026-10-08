import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');

function runFixture(name: string) {
  return spawnSync(process.execPath, [
    resolve(root, 'scripts/check-import-boundaries.mjs'),
    '--root', resolve(root, `tests/fixtures/phase1/imports/${name}`),
  ], { cwd: root, encoding: 'utf8' });
}

function runSource() {
  return spawnSync(process.execPath, [resolve(root, 'scripts/check-import-boundaries.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
}

test('complete dependency graph accepts direct, alias, dynamic, and public facade imports', () => {
  const result = runFixture('safe');
  assert.equal(result.status, 0, result.stderr);
});

test('complete dependency graph resolves aliases relative to tsconfig', () => {
  const result = runFixture('safe-tsconfig-alias');
  assert.equal(result.status, 0, result.stderr);
});

test('complete dependency graph permits only the migration CLI bootstrap handoff', () => {
  const result = runFixture('migration-entrypoint');
  assert.equal(result.status, 0, result.stderr);
  const unsafe = runFixture('unsafe-infrastructure-bootstrap');
  assert.notEqual(unsafe.status, 0, unsafe.stdout);
  assert.match(unsafe.stderr, /violates dependency graph/);
});

test('infrastructure require imports resolve against its explicit module facade edge', () => {
  const result = runFixture('infrastructure-module-require-safe');
  assert.equal(result.status, 0, result.stderr);
});

test('infrastructure require imports cannot bypass its explicit module facade edge', () => {
  const result = runFixture('infrastructure-module-require-unsafe');
  assert.notEqual(result.status, 0, 'an unlisted infrastructure require() module edge must be rejected');
  assert.match(result.stderr, /infrastructure:identity -> module:collections:facade/);
});

test('infrastructure surfaces reject unlisted module facades and application layers', () => {
  const result = runFixture('infrastructure-module-unlisted');
  assert.notEqual(result.status, 0, 'unlisted infrastructure module imports must be rejected');
  assert.match(result.stderr, /infrastructure:identity -> module:collections:facade/);
  assert.match(result.stderr, /infrastructure:identity -> module:collections:application/);
});

test('sync session code may consume identity evidence only through the public facade', () => {
  const allowed = runFixture('sync-identity-facade-safe');
  assert.equal(allowed.status, 0, allowed.stderr);

  const deepImport = runFixture('sync-identity-deep-unsafe');
  assert.notEqual(deepImport.status, 0, 'sync must not import a non-public identity path');
  assert.match(deepImport.stderr, /non-public module path/);
});

test('complete dependency graph accepts a repository-root src layout', () => {
  const result = runFixture('root-layout');
  assert.equal(result.status, 0, result.stderr);
});

test('root exports admit only the current explicit process entrypoints', () => {
  const result = runFixture('root-unlisted');
  assert.notEqual(result.status, 0, 'root must not import an arbitrary infrastructure surface');
  assert.match(result.stderr, /root -> infrastructure:health/);
});

test('transport admits only its current public module consumers', () => {
  const safe = runFixture('transport-allowed');
  assert.equal(safe.status, 0, safe.stderr);

  const unsafe = runFixture('transport-unlisted-public');
  assert.notEqual(unsafe.status, 0, 'transport must not import an unlisted public module facade');
  assert.match(unsafe.stderr, /violates dependency graph/);
});

test('transport has no bootstrap or internal-path fallback', () => {
  for (const fixture of ['transport-unlisted-bootstrap', 'transport-unlisted-internal']) {
    const result = runFixture(fixture);
    assert.notEqual(result.status, 0, `${fixture} must be rejected`);
    assert.match(result.stderr, /violates dependency graph/);
  }
});

test('bootstrap admits only its current module and infrastructure composition edges', () => {
  const allowed = runFixture('bootstrap-allowed');
  assert.equal(allowed.status, 0, allowed.stderr);

  const unlistedModule = runFixture('bootstrap-unlisted-module');
  assert.notEqual(unlistedModule.status, 0, 'bootstrap must not import an unlisted public module facade');
  assert.match(unlistedModule.stderr, /bootstrap -> module:commands:facade/);

  const unlistedInfrastructure = runFixture('bootstrap-unlisted-infrastructure');
  assert.notEqual(unlistedInfrastructure.status, 0, 'bootstrap must not import an unlisted infrastructure surface');
  assert.match(unlistedInfrastructure.stderr, /bootstrap -> infrastructure:health/);
});

test('worker bootstrap may import only its file-precise inspection tick helper grant', () => {
  const allowed = runFixture('bootstrap-worker-inspection-tick-allowed');
  assert.equal(allowed.status, 0, allowed.stderr);

  const unlisted = runFixture('bootstrap-worker-unlisted-helper');
  assert.notEqual(unlisted.status, 0, 'the worker grant must not permit arbitrary bootstrap helpers');
  assert.match(unlisted.stderr, /bootstrap\/worker\.ts -> bootstrap\/unlisted-helper\.ts/);
});

test('complete dependency graph accepts the current source tree', () => {
  const result = runSource();
  assert.equal(result.status, 0, result.stderr);
});

test('COLP business APIs must use an owning public subpath', () => {
  const result = runFixture('colp-root-import-unsafe');
  assert.notEqual(result.status, 0, 'the metadata-only COLP package root must be rejected');
  assert.match(result.stderr, /imports the metadata-only COLP package root/);
});

test('COLP production hosts must not import ./sync/unsafe', () => {
  const result = runFixture('colp-sync-unsafe');
  assert.notEqual(result.status, 0, 'COLP ./sync/unsafe must be rejected');
  assert.match(result.stderr, /COLP unsafe Sync coordinators/);
});

test('P3-12 production Sync Push create evaluator never imports the generic Push coordinator', async () => {
  const productionFiles = [
    'src/modules/sync/sync-push.ts',
    'src/infrastructure/sync/sync-push-postgres.ts',
    'src/infrastructure/sync/postgres/sync-push-admission-postgres.ts',
    'src/infrastructure/sync/postgres/sync-push-create-update-postgres.ts',
    'src/infrastructure/sync/postgres/sync-push-move-delete-postgres.ts',
    'src/infrastructure/sync/postgres/sync-push-repository-postgres.ts',
    'src/transport/colp-sync/sync-push-routes.ts',
    'src/bootstrap/api.ts',
    'src/bootstrap/api-postgres-ports.ts',
    'src/bootstrap/api-mcp-surface-composition.ts',
    'src/bootstrap/api-account-services.ts',
    'src/bootstrap/api-attachments-composition.ts',
    'src/bootstrap/api-email-composition.ts',
    'src/bootstrap/api-lifecycle.ts',
    'src/bootstrap/api-mcp-oauth-composition.ts',
    'src/bootstrap/api-auth-mailbox.ts',
  ];
  for (const relative of productionFiles) {
    const source = await readFile(resolve(root, relative), 'utf8');
    assert.doesNotMatch(source, /coordinate(?:SessionBound)?Push|push-transaction/u, relative);
  }
  const postgres = await readFile(resolve(root, 'src/infrastructure/sync/sync-push-postgres.ts'), 'utf8');
  assert.match(postgres, /createPostgresSyncSequencePort|\.coordinateAuthorized\(/u);
  assert.match(postgres, /canonical_node_create/u);
  assert.match(postgres, /evaluateUnsupportedSyncOperation\(\)/u);
});

test('complete dependency graph rejects direct and deep cross-module imports', () => {
  for (const fixture of ['direct', 'deep']) {
    const result = runFixture(fixture);
    assert.notEqual(result.status, 0, `${fixture} must be rejected`);
    assert.match(result.stderr, /violates dependency graph|non-public module path/);
  }
});

test('module domain code cannot import its application layer', () => {
  const result = runFixture('domain-to-application');
  assert.notEqual(result.status, 0, 'domain code must not depend on application code');
  assert.match(result.stderr, /module:collections:domain -> module:collections:application/);
});

test('sync layered structure admits application-to-domain, domain-to-ports and the sync infrastructure facade', () => {
  const result = runFixture('sync-layered');
  assert.equal(result.status, 0, result.stderr);
});

test('sync domain code cannot import its own application layer', () => {
  const result = runFixture('sync-layered-domain-rejected');
  assert.notEqual(result.status, 0, 'sync domain code must not depend on sync application code');
  assert.match(result.stderr, /module:sync:domain -> module:sync:application/);
});

test('sync transport admits only the public facade, never a deep application path', () => {
  const result = runFixture('sync-layered-transport-deep-rejected');
  assert.notEqual(result.status, 0, 'transport must not deep-import the sync application layer');
  assert.match(result.stderr, /violates dependency graph/);
  assert.match(result.stderr, /transport -> module:sync:application/);
});

test('complete dependency graph rejects barrel, alias, dynamic, and indirect bypasses', () => {
  for (const fixture of ['barrel', 'alias', 'dynamic', 'indirect']) {
    const result = runFixture(fixture);
    assert.notEqual(result.status, 0, `${fixture} must be rejected`);
    assert.match(result.stderr, /violates dependency graph|non-public module path/);
  }
});
