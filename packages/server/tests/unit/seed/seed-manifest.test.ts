import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, test } from 'vitest';
import { loadManifest, SeedError } from '../../../src/infrastructure/seed/manifest.js';

/**
 * Task B3 manifest 单元测试：phase='auth' 表、authScript 声明与校验、
 * withdraw order（auth 表面先于业务表）、namespace 无旧 sess-u% 前缀。
 * 集成行为（注入/撤回/防重/换版）由 tests/integration/seed/seed-lifecycle.integration.test.ts 覆盖。
 */

/** 最小合法 manifest（business 表 + 一个 auth 表 + authScript）。 */
function minimalManifestJson(): Record<string, unknown> {
  return {
    key: 'demo',
    name: 'manifest unit',
    description: 'unit',
    namespace: ['acc-u%', 'seed-auser-%'],
    authScript: 'auth.ts',
    tables: [
      { table: 'accounts', pkColumns: ['id'], prefixSql: "id LIKE 'acc-u%'", expectedRows: 1 },
      {
        table: 'auth_users',
        pkColumns: ['id'],
        prefixSql: "id LIKE 'seed-auser-%'",
        expectedRows: 1,
        phase: 'auth',
      },
    ],
    withdrawOrder: ['auth_users', 'accounts'],
    postChecks: [],
    referenceChecks: [],
  };
}

function writeTmpManifest(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'seed-manifest-test-'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(content), 'utf8');
  return dir;
}

describe('seed manifest (B3 auth phase)', () => {
  const tmpDirs: string[] = [];

  afterAll(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  });

  test('authScript 声明但无 phase="auth" 表 → invalid_manifest（fail-closed）', () => {
    const json = minimalManifestJson();
    json.tables = [
      { table: 'accounts', pkColumns: ['id'], prefixSql: "id LIKE 'acc-u%'", expectedRows: 1 },
    ];
    json.withdrawOrder = ['accounts'];
    const dir = writeTmpManifest(json);
    tmpDirs.push(dir);
    assert.throws(
      () => loadManifest(dir),
      (error: unknown) => error instanceof SeedError && error.code === 'invalid_manifest'
        && /authScript.*phase="auth"/u.test(error.message),
    );
  });

  test('phase="auth" 表但未声明 authScript → invalid_manifest（fail-closed）', () => {
    const json = minimalManifestJson();
    delete json.authScript;
    const dir = writeTmpManifest(json);
    tmpDirs.push(dir);
    assert.throws(
      () => loadManifest(dir),
      (error: unknown) => error instanceof SeedError && error.code === 'invalid_manifest'
        && /phase="auth".*authScript/u.test(error.message),
    );
  });

  test('withdrawOrder 含未登记表 → invalid_manifest（既有校验保持）', () => {
    const json = minimalManifestJson();
    json.withdrawOrder = ['auth_users', 'accounts', 'sessions'];
    const dir = writeTmpManifest(json);
    tmpDirs.push(dir);
    assert.throws(
      () => loadManifest(dir),
      (error: unknown) => error instanceof SeedError && error.code === 'invalid_manifest'
        && /withdrawOrder/u.test(error.message),
    );
  });

});
