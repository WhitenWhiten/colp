import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, test } from 'vitest';
import { loadManifest, SeedError, authPhaseTables, sqlPhaseTables } from '../../../src/infrastructure/seed/manifest.js';

/**
 * Task B3 manifest 单元测试：phase='auth' 表、authScript 声明与校验、
 * withdraw order（auth 表面先于业务表）、namespace 无旧 sess-u% 前缀。
 * 集成行为（注入/撤回/防重/换版）由 tests/integration/seed/seed-lifecycle.integration.test.ts 覆盖。
 */

const repoSeedDir = join(__dirname, '..', '..', '..', 'seed', 'demo');

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

  test('仓库 demo manifest：auth 表面 5 表纳入 ledger（phase/namespace/expectedRows/withdraw order）', () => {
    const manifest = loadManifest(repoSeedDir);
    assert.equal(manifest.authScript, 'auth.ts');

    const authTables = authPhaseTables(manifest);
    assert.deepEqual(
      authTables.map((spec) => spec.table),
      ['auth_users', 'auth_accounts', 'auth_user_account_map', 'auth_sessions', 'known_auth_session_metadata'],
    );
    for (const spec of authTables) {
      assert.equal(spec.expectedRows, 15, `${spec.table} 期望 15 行`);
      assert.ok(spec.pkColumns.length === 1, `${spec.table} 主键为单列`);
    }
    assert.equal(sqlPhaseTables(manifest).length, 49, '业务表 49 张（含 Canonical 副作用 + Wave 14 showcase + News Digest + Wave 17 community/governance；sessions 已移除）');
    assert.ok(manifest.namespace.includes('seed-exp%'));
    assert.ok(manifest.namespace.includes('seed-org%'));
    assert.ok(manifest.namespace.includes('seed-ver%'));
    assert.ok(manifest.namespace.includes('seed-rst%'));
    assert.ok(manifest.namespace.includes('seed-act%'));
    assert.ok(!manifest.namespace.includes('sess-u%'), '旧 sess-u% 命名空间必须移除');
    assert.ok(manifest.namespace.includes('seed-auser-%'));
    assert.ok(manifest.namespace.includes('seed-acct-%'));
    assert.ok(manifest.namespace.includes('seed-sess-%'));
    assert.ok(manifest.namespace.includes('seed-feed%'));
    assert.ok(manifest.namespace.includes('seed-ntf%'));
    assert.ok(manifest.namespace.includes('seed-ann%'));
    assert.ok(manifest.namespace.includes('seed-rel%'));
    assert.ok(manifest.namespace.includes('col-ce%'));
    assert.ok(manifest.namespace.includes('seed-op%'));
    assert.ok(manifest.namespace.includes('seed-rpt-%'));
    assert.ok(manifest.namespace.includes('seed-cmt%'));
    assert.ok(manifest.namespace.includes('seed-mod-%'));

    // 撤回顺序：先 auth sessions/metadata → mapping/auth accounts/users → 业务 accounts
    const order = manifest.withdrawOrder;
    assert.deepEqual(
      order.slice(0, 5),
      ['known_auth_session_metadata', 'auth_sessions', 'auth_user_account_map', 'auth_accounts', 'auth_users'],
    );
    assert.equal(order.at(-1), 'accounts');

    const savedAccount = manifest.referenceChecks.find((check) => check.table === 'saved_resources' && check.kind === 'restrict');
    assert.ok(savedAccount?.condition.includes('account_id'), 'live saved_resources on seed accounts must restrict-block withdraw');
    const progress = manifest.referenceChecks.find((check) => check.table === 'reading_progress');
    assert.equal(progress?.kind, 'restrict');
    assert.ok(manifest.referenceChecks.some((check) => check.table === 'account_credentials' && check.kind === 'auto'));
    const leftoverNodes = manifest.referenceChecks.find((check) => check.table === 'nodes' && check.kind === 'auto');
    assert.ok(leftoverNodes?.cleanSql?.includes('deleted_at'), 'live nodes in seed collections must be tombstoned on withdraw');
    const contentRevisions = manifest.tables.find((spec) => spec.table === 'content_revisions');
    assert.ok(contentRevisions?.prefixSql.includes('ordinal'), 'content_revisions must ignore later live revisions on seed collections');
    const receipts = manifest.tables.find((spec) => spec.table === 'product_command_receipts');
    assert.ok(receipts?.prefixSql.includes('target_identity LIKE \'seed-%\''), 'product_command_receipts must ignore live commands on seed collections');
    const folderCheck = manifest.postChecks.find((check) => check.label.startsWith('展示用非根 folder'));
    assert.ok(folderCheck?.sql.includes("id LIKE 'nd-col-%'"), 'folder showcase counts must ignore live user collections');
    const publicCount = manifest.postChecks.find((check) => check.label.startsWith('公开收藏夹共 51'));
    assert.ok(publicCount?.sql.includes("id LIKE 'col-u%'"), 'public collection count must ignore live user collections');
    const inbox = manifest.postChecks.find((check) => check.label.includes('classify inbox'));
    assert.ok(inbox?.sql.includes("n.id LIKE 'nd-col-%'"), 'classify inbox count must ignore live bookmarks');
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

  test('旧脚本 scripts/seed-demo-data.sql 是拒绝 wrapper：无任何 INSERT、含 \\quit', () => {
    const content = readFileSync(join(__dirname, '..', '..', '..', 'scripts', 'seed-demo-data.sql'), 'utf8');
    assert.ok(content.includes('\\quit'), '必须含 \\quit 拒绝执行');
    assert.ok(!/INSERT\s+INTO/u.test(content), '不得再直接写任何表');
    assert.ok(!/sess-u/u.test(content), '不得再含旧会话 raw token');
  });

  test('demo Canonical 写路径：annotations=32、operations/sidecar=54、outbox=108，data.sql 无旁路 INSERT', () => {
    const manifest = loadManifest(repoSeedDir);
    const operations = manifest.tables.find((spec) => spec.table === 'operations');
    assert.equal(operations?.expectedRows, 54);
    const annotations = manifest.tables.find((spec) => spec.table === 'annotations');
    assert.equal(annotations?.expectedRows, 32);
    assert.equal(annotations?.deletedAtColumn, 'deleted_at');
    assert.equal(annotations?.deletedCommitOrdinalColumn, 'deleted_commit_ordinal');
    assert.equal(manifest.tables.find((spec) => spec.table === 'relations')?.expectedRows, 22);
    assert.equal(manifest.tables.find((spec) => spec.table === 'audit_events')?.expectedRows, 54);
    assert.equal(manifest.tables.find((spec) => spec.table === 'resource_revisions')?.expectedRows, 54);
    assert.equal(manifest.tables.find((spec) => spec.table === 'content_revisions')?.expectedRows, 54);
    assert.equal(manifest.tables.find((spec) => spec.table === 'outbox_events')?.expectedRows, 108);
    assert.equal(manifest.tables.find((spec) => spec.table === 'product_command_receipts')?.expectedRows, 54);
    const canonicalOperationCheck = manifest.postChecks.find((check) =>
      check.sql === "SELECT count(*) FROM operations WHERE operation_id LIKE 'seed-op-%'");
    assert.deepEqual(
      canonicalOperationCheck && [canonicalOperationCheck.expected, canonicalOperationCheck.label],
      [54, 'Canonical seed operations 共 54 行'],
    );
    const flagshipOperationCheck = manifest.postChecks.find((check) =>
      check.sql.includes("collection_id = seed_collection_id('col-u01-01')")
      && check.sql.includes("operation_id LIKE 'seed-op-%'"));
    assert.deepEqual(
      flagshipOperationCheck && [flagshipOperationCheck.expected, flagshipOperationCheck.label],
      [30, '旗舰 col-u01-01 Canonical operations 共 30 行'],
    );
    const dualAnnotationCheck = manifest.postChecks.find((check) =>
      check.label.includes('live note+tldr'));
    assert.deepEqual(
      dualAnnotationCheck && [dualAnnotationCheck.expected, dualAnnotationCheck.label],
      [7, '同时有 live note+tldr 的节点共 7 个'],
    );
    assert.ok(!manifest.withdrawOrder.includes('operations'), 'operations 不可撤回删除（账本不可变，预定 ID 无法经 ports 重建）');
    assert.ok(manifest.withdrawOrder.includes('annotations'));
    assert.ok(manifest.withdrawOrder.includes('relations'));
    assert.ok(manifest.withdrawOrder.includes('collection_link_health'));
    assert.ok(manifest.withdrawOrder.includes('collection_export_jobs'));
    assert.ok(manifest.withdrawOrder.includes('collection_classify_inbox_decision'));
    assert.ok(manifest.withdrawOrder.includes('collection_organize_plans'));
    assert.ok(manifest.withdrawOrder.includes('collection_tree_versions'));
    assert.ok(manifest.withdrawOrder.includes('collection_version_restore_receipts'));
    assert.ok(manifest.withdrawOrder.includes('collection_readable_replicas'));
    assert.ok(manifest.withdrawOrder.includes('social_public_activity'));
    assert.ok(manifest.withdrawOrder.includes('digest_runs'));
    assert.ok(manifest.withdrawOrder.includes('digest_schedules'));
    assert.ok(manifest.withdrawOrder.includes('digest_follows'));
    assert.ok(manifest.withdrawOrder.includes('digest_members'));
    assert.ok(manifest.withdrawOrder.includes('digest_editions'));
    assert.ok(manifest.withdrawOrder.includes('digest_series'));
    assert.ok(
      manifest.withdrawOrder.indexOf('digest_editions') < manifest.withdrawOrder.indexOf('digest_members'),
      'digest_editions must withdraw before digest_members so the owner row can tear down an empty series',
    );
    assert.ok(!manifest.withdrawOrder.includes('resource_id_ledger'), 'resource_id_ledger 是不可变永久账本，不得纳入撤回');
    const health = manifest.tables.find((spec) => spec.table === 'collection_link_health');
    assert.equal(health?.expectedRows, 1029);
    assert.equal(manifest.tables.find((spec) => spec.table === 'collection_export_jobs')?.expectedRows, 3);
    assert.equal(manifest.tables.find((spec) => spec.table === 'social_public_activity')?.expectedRows, 6);
    assert.equal(manifest.tables.find((spec) => spec.table === 'digest_series')?.expectedRows, 8);
    assert.equal(manifest.tables.find((spec) => spec.table === 'digest_editions')?.expectedRows, 33);
    assert.equal(manifest.tables.find((spec) => spec.table === 'digest_members')?.expectedRows, 16);
    assert.equal(manifest.tables.find((spec) => spec.table === 'digest_follows')?.expectedRows, 40);
    assert.equal(manifest.tables.find((spec) => spec.table === 'digest_schedules')?.expectedRows, 3);
    assert.equal(manifest.tables.find((spec) => spec.table === 'digest_runs')?.expectedRows, 6);
    const data = readFileSync(join(repoSeedDir, 'data.sql'), 'utf8');
    assert.ok(!/INSERT\s+INTO\s+operations\b/iu.test(data));
    assert.ok(!/INSERT\s+INTO\s+annotations\b/iu.test(data));
    assert.ok(!/INSERT\s+INTO\s+relations\b/iu.test(data));
    assert.ok(!/INSERT\s+INTO\s+digest_audit_events\b/iu.test(data));
  });

  test('demo data.sql 文件完整性：旗舰/名人 id、无事务包装、无旧会话/token', () => {
    const data = readFileSync(join(repoSeedDir, 'data.sql'), 'utf8');
    assert.ok(data.includes("'col-u01-01'"));
    assert.ok(data.includes("'col-ce01-01'"));
    const digestEditionsInsert = data.match(/INSERT INTO digest_editions[\s\S]*?ON CONFLICT \(id\) DO NOTHING;/u)?.[0] ?? '';
    assert.ok(digestEditionsInsert.includes("seed_collection_id('col-u01-01')"));
    assert.ok(
      !/['"]col-(?:u|ce)[0-9]+-[0-9]+['"]/u.test(
        digestEditionsInsert.replace(/seed_collection_id\('col-[^']+'\)/gu, 'OPAQUE'),
      ),
      'digest_editions.source_collection_id must use seed_collection_id, not a legacy col-* literal',
    );
    assert.ok(!/^BEGIN;$/m.test(data));
    assert.ok(!/^COMMIT;$/m.test(data));
    assert.ok(!data.includes('sess-u'), 'data.sql 不得再写入旧 sessions 行');
    assert.ok(!data.includes('known-mock-session'), 'data.sql 不得包含 raw token 派生种子');
    assert.ok(!data.includes('raw = '), 'data.sql 不得包含 raw token 注释');
  });

  test('seed fixtures 无 raw cookie、明文密码、OTP 字面量', () => {
    const seedFiles = ['data.sql', 'manifest.json', 'auth.ts', 'auth-fixtures.ts']
      .map((name) => join(repoSeedDir, name));
    for (const file of seedFiles) {
      const content = readFileSync(file, 'utf8');
      assert.ok(!/__Host-known_session=[A-Za-z0-9_-]/u.test(content), `${file} 不得含 raw cookie 赋值`);
      assert.ok(!/raw\s*=\s*[A-Za-z0-9_-]{20,}/u.test(content), `${file} 不得含 raw token`);
      assert.ok(!/(?:password|passwd)\s*[:=]\s*['"][^'"]{4,}['"]/iu.test(content), `${file} 不得含明文密码字面量`);
      assert.ok(!/known-mock-session/u.test(content), `${file} 不得含旧 raw token 派生种子`);
    }
    for (const file of ['auth.ts', 'auth-fixtures.ts']) {
      const content = readFileSync(join(repoSeedDir, file), 'utf8');
      assert.ok(!/\b\d{6}\b/u.test(content), `${file} 不得含 OTP 字面量`);
    }
  });
});
