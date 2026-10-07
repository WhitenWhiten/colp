import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, test } from 'vitest';
import { betterAuth } from 'better-auth';
import Fastify from 'fastify';
import { sql } from 'kysely';
import { loadConfig } from '../../support/test-config.js';
import { buildBetterAuthConfig } from '../../../src/modules/auth/better-auth-config.js';
import { loadManifest, SeedError } from '../../../src/infrastructure/seed/manifest.js';
import { applySeed, adoptSeed } from '../../../src/infrastructure/seed/injector.js';
import { withdrawSeed } from '../../../src/infrastructure/seed/withdrawer.js';
import {
  FLAGSHIP_CANONICAL_MUTATION_COUNT,
  FLAGSHIP_COLLECTION_ID,
  SEED_CANONICAL_MUTATION_COUNT,
} from '../../../src/infrastructure/seed/canonical-phase.js';
import { seedCollectionId } from '../../../src/infrastructure/seed/seed-opaque-id.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresCanonicalMutationUnitOfWork, createPostgresCollectionsUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { createPostgresCollectionsEditorReadUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { createProductEditorCursorSigner } from '../../../src/modules/collections/index.js';
import { buildBetterAuthOptions, applyFetchResponse, fastifyRequestToFetchRequest } from '../../../src/infrastructure/auth/better-auth-runtime.js';
import {
  createBetterAuthServerApi,
  createBetterAuthSessionAuthority,
  signBetterAuthSessionCookieValue,
} from '../../../src/infrastructure/auth/better-auth-session-authority.js';
import {
  createBetterAuthSessionTokenProtector,
  type BetterAuthSessionTokenProtector,
} from '../../../src/infrastructure/auth/better-auth-session-token-protection.js';
import { createArgon2idPasswordHasher } from '../../../src/infrastructure/auth/argon2id-password-hasher.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { browserSessionTokenHash } from '../../../src/modules/auth/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import {
  appEnv,
  SEED_BA_SECRET as BA_SECRET,
  SEED_DEMO_PASSWORD as DEMO_PASSWORD,
  seedEnv,
  SEED_TRUSTED_ORIGIN as TRUSTED_ORIGIN,
} from '../../support/seed-lifecycle-env.js';

/**
 * Seed 生命周期集成测试：注入 → 防重 → 换版自动撤回重注 → 显式撤回 → 认领 →
 * 存量探测 fail-closed → 业务引用预检（cascade 中止/放行）。
 *
 * Task B3（auth fixture 生命周期）：
 * - demo seed 的 auth 表面（auth_users / auth_accounts / auth_user_account_map /
 *   auth_sessions / known_auth_session_metadata）由 seed/demo/auth.ts 通过已验证
 *   seed port（Argon2id hasher、A2 业务映射 uow、A3 session metadata store）创建，
 *   纳入同一 seed ledger（seed_rows）与 withdraw order；
 * - demo 密码只从 KNOWN_DEMO_PASSWORD 输入（dev-only secret），不写入仓库；
 * - 全部在隔离 postgres schema 内执行，真实迁移 + 真实 data.sql + 真实 BA 1.7.1
 *   handler（密码可登录）与真实 BrowserSessionAuthority（/api/v1/me 映射）。
 */

const COLLECTION_COUNT = 81;
const NODE_COUNT = 1151;

const repoSeedDir = join(__dirname, '..', '..', '..', 'seed', 'demo');
const DEMO_MANIFEST = loadManifest(repoSeedDir);
const TOTAL_ROW_COUNT = DEMO_MANIFEST.tables.reduce((sum, spec) => sum + spec.expectedRows, 0);
const WITHDRAWN_ROW_COUNT = DEMO_MANIFEST.withdrawOrder.reduce((sum, table) => {
  const spec = DEMO_MANIFEST.tables.find((item) => item.table === table);
  return sum + (spec?.expectedRows ?? 0);
}, 0);
/** auth 表面行数（15 用户 × users/accounts/map/sessions/metadata）。 */
const AUTH_ROW_COUNT = 15 * 5;
const APPLY_TIMEOUT_MS = 120_000;
const EDITOR_CURSOR_KEY = '0123456789abcdef0123456789abcdef';

describeWithPostgres('Seed lifecycle (injector/withdrawer/adopt + B3 auth fixtures)', () => {
  let isolated: IsolatedPostgresRuntime;
  let seedDir: string;
  let authBridge: ReturnType<typeof Fastify>;
  let productApp: ReturnType<typeof buildApiApp>;
  let sessionTokenProtector: BetterAuthSessionTokenProtector;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('seed_lifecycle', {
      maxConnections: 10,
      applicationName: 'known-seed-test',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    // 每次用例独立拷贝数据包，避免用例间相互污染
    seedDir = mkdtempSync(join(tmpdir(), 'seed-demo-'));
    cpSync(repoSeedDir, seedDir, { recursive: true });

    // 真实 BA 1.7.1 handler（C2 同构的 test-only full-surface mount）：
    // 用与 seed auth 阶段完全相同的 env（同一 secret / 同一 Argon2id hook）。
    const baConfig = buildBetterAuthConfig(loadConfig(seedEnv()).betterAuth);
    assert.ok(baConfig, 'seed env must produce Better Auth settings');
    sessionTokenProtector = createBetterAuthSessionTokenProtector(
      baConfig.sessionTokenProtection,
    );
    const auth = betterAuth(buildBetterAuthOptions({
      enabled: true,
      config: baConfig,
      database: { db: isolated.runtime.db, type: 'postgres', transaction: true },
    }));

    authBridge = Fastify({ logger: false });
    authBridge.route({
      method: ['GET', 'POST'],
      url: '/api/v1/auth/*',
      onRequest: async (request, reply) => {
        const response = await auth.handler(fastifyRequestToFetchRequest(request, reply));
        await applyFetchResponse(reply, response);
      },
      handler: async (_request, reply) => reply.code(500).send({ error: 'internal_error', message: 'unreachable' }),
    });
    await authBridge.ready();

    // 产品 app：/api/v1/session、/api/v1/me 走真实 BrowserSessionAuthority；
    // 编辑器读路径需要 collections + Canonical mutation UoW（路由注册契约）。
    productApp = buildApiApp({
      config: loadConfig(appEnv()),
      identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db),
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(isolated.runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db),
      collectionsEditorReadUnitOfWork: createPostgresCollectionsEditorReadUnitOfWork(isolated.runtime.db, {
        cursorSigner: createProductEditorCursorSigner({
          current: { id: 'seed-test', key: EDITOR_CURSOR_KEY },
        }),
        productOrigin: TRUSTED_ORIGIN,
      }),
      browserSessionAuthority: createBetterAuthSessionAuthority({
        db: isolated.runtime.db,
        betterAuth: createBetterAuthServerApi(auth),
        secret: baConfig.secret,
        sessionExpiresInSeconds: baConfig.sessionExpiresInSeconds,
        sessionTokenProtector,
      }),
    });
    await productApp.ready();
  }, 120_000);

  afterAll(async () => {
    await authBridge?.close().catch(() => undefined);
    await productApp?.close().catch(() => undefined);
    await isolated.close();
  });

  function manifestFor(dir: string) {
    return loadManifest(dir);
  }

  /** apply 选项：auth 阶段使用与 seed auth 阶段一致的 env。 */
  function applyOptions(version: string) {
    return {
      version,
      by: 'test',
      allowCascade: false,
      cleanDangling: false,
      env: seedEnv(),
    };
  }

  async function prefixCounts(table: string, liveOnly = false): Promise<number> {
    const result = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.raw(table)}
      ${sql.raw(liveOnly ? "WHERE id LIKE 'col-u%' AND deleted_at IS NULL" : '')}
    `.execute(isolated.runtime.db);
    return result.rows[0]!.n;
  }

  async function tableCount(table: string): Promise<number> {
    const result = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.raw(table)}
    `.execute(isolated.runtime.db);
    return result.rows[0]!.n;
  }

  /** 软删表（collections/nodes）的活行计数。 */
  async function livePrefixCounts(table: string): Promise<number> {
    const result = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE deleted_at IS NULL
    `.execute(isolated.runtime.db);
    return result.rows[0]!.n;
  }

  /** 断言 auth 表面 5 张表的前缀行数全为 15（注入校验与撤回清零共用）。 */
  async function assertAuthSurfaceRows(expected: number): Promise<void> {
    assert.equal(await tableCount('auth_users'), expected, 'auth_users 行数不符');
    assert.equal(await tableCount('auth_accounts'), expected, 'auth_accounts 行数不符');
    assert.equal(await tableCount('auth_user_account_map'), expected, 'auth_user_account_map 行数不符');
    assert.equal(await tableCount('auth_sessions'), expected, 'auth_sessions 行数不符');
    assert.equal(await tableCount('known_auth_session_metadata'), expected, 'known_auth_session_metadata 行数不符');
  }

  /** 解密 seed carrier 后重建浏览器 cookie；存储值绝不作为 bearer 使用。 */
  async function seededDemoCookie(authUserId: string): Promise<string> {
    const sessionId = `seed-sess-${authUserId.slice('seed-auser-'.length)}`;
    const result = await isolated.runtime.pool.query<{ token: string }>(
      `select s."token" from auth_sessions s where s."id" = $1`,
      [sessionId],
    );
    assert.ok(result.rows[0], `seed session ${sessionId} 必须存在`);
    const token = sessionTokenProtector.reveal(result.rows[0]!.token);
    return signBetterAuthSessionCookieValue(BA_SECRET, token);
  }

  function cookieHeader(cookie: string): string {
    return `__Host-known_session=${encodeURIComponent(cookie)}`;
  }

  test('1) 全新注入：行数（业务 + auth 表面）、登记、状态全部正确', async () => {
    const manifest = manifestFor(seedDir);
    const report = await applySeed(isolated.runtime, manifest, applyOptions('v1'));
    assert.equal(report.skipped, false);
    // accounts21+profiles21+handles21+identities21+collections81+nodes1151+members94+policies81+follows134+invites7+insights1518+link_health1029
    // + auth users15+accounts15+map15+sessions15+metadata15
    assert.equal(report.insertedRows, TOTAL_ROW_COUNT);
    assert.equal(report.tableCounts.collections, COLLECTION_COUNT);
    assert.equal(report.tableCounts.nodes, NODE_COUNT);
    assert.equal(report.tableCounts.follows, 134);
    assert.equal(report.tableCounts.accounts, 21);
    assert.equal(report.tableCounts.auth_users, 15);
    assert.equal(report.tableCounts.auth_accounts, 15);
    assert.equal(report.tableCounts.auth_user_account_map, 15);
    assert.equal(report.tableCounts.auth_sessions, 15);
    assert.equal(report.tableCounts.known_auth_session_metadata, 15);

    const applied = await sql<{ version: string; state: string }>`
      SELECT version, state FROM seed_applied WHERE seed_key = 'demo'
    `.execute(isolated.runtime.db);
    assert.equal(applied.rows.length, 1);
    assert.equal(applied.rows[0]!.version, 'v1');
    assert.equal(applied.rows[0]!.state, 'applied');
    const registered = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM seed_rows WHERE seed_key = 'demo' AND version = 'v1'
    `.execute(isolated.runtime.db);
    assert.equal(registered.rows[0]!.n, report.insertedRows);
  }, APPLY_TIMEOUT_MS);

  test('2) 同版本重复注入：跳过（防二次注入，auth 表面完整）', async () => {
    const manifest = manifestFor(seedDir);
    const report = await applySeed(isolated.runtime, manifest, applyOptions('v1'));
    assert.equal(report.skipped, true);
    assert.equal(await prefixCounts('collections'), COLLECTION_COUNT);
    assert.equal(await prefixCounts('follows'), 134);
    await assertAuthSurfaceRows(15);
  });

  test('3) 换版：自动撤回旧版并注入新版（行数不变，登记切到新版本）', async () => {
    // 拷贝一份数据包作为"新版本"（data.sql 追加无害语句使内容不同）
    const newDir = mkdtempSync(join(tmpdir(), 'seed-demo-v2-'));
    cpSync(seedDir, newDir, { recursive: true });
    appendFileSync(join(newDir, 'data.sql'), "\n-- v2 marker\nUPDATE profiles SET updated_at = updated_at WHERE account_id = 'acc-u01wWA7gVl069uG0Vg';\n");
    const manifest = manifestFor(newDir);

    const report = await applySeed(isolated.runtime, manifest, applyOptions('v2'));
    assert.equal(report.skipped, false);
    assert.ok(report.withdrawReport, '换版应包含撤回报告');
    assert.equal(report.withdrawReport!.version, 'v1');
    assert.equal(report.withdrawReport!.deletedRows, WITHDRAWN_ROW_COUNT);
    assert.equal(report.insertedRows, TOTAL_ROW_COUNT);

    // 数据完整（撤回旧版 + 注入新版）
    assert.equal(await prefixCounts('collections'), COLLECTION_COUNT);
    assert.equal(await prefixCounts('nodes'), NODE_COUNT);
    assert.equal(await prefixCounts('follows'), 134);
    await assertAuthSurfaceRows(15);
    // 登记只属于新版本
    const oldRows = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM seed_rows WHERE seed_key = 'demo' AND version = 'v1'
    `.execute(isolated.runtime.db);
    assert.equal(oldRows.rows[0]!.n, 0);
    const newRows = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM seed_rows WHERE seed_key = 'demo' AND version = 'v2'
    `.execute(isolated.runtime.db);
    assert.equal(newRows.rows[0]!.n, report.insertedRows);
    const applied = await sql<{ version: string }>`
      SELECT version FROM seed_applied WHERE seed_key = 'demo'
    `.execute(isolated.runtime.db);
    assert.equal(applied.rows[0]!.version, 'v2');
    // 审计：v1 withdrawn + v2 applied
    const history = await sql<{ event: string }[]>`
      SELECT event FROM seed_applied_history WHERE seed_key = 'demo' ORDER BY id
    `.execute(isolated.runtime.db);
    assert.deepEqual(history.rows.map((row) => row.event), ['applied', 'withdrawn', 'applied']);
  }, APPLY_TIMEOUT_MS);

  test('4) 显式撤回：业务与 auth 表面数据清零、状态 withdrawn、可再次注入', async () => {
    const manifest = manifestFor(seedDir);
    const report = await withdrawSeed(isolated.runtime, manifest, {
      by: 'test',
      allowCascade: false,
      cleanDangling: false,
    });
    assert.equal(report.version, 'v2');
    assert.equal(await livePrefixCounts('collections'), 0, 'collections 活行应清零（软删）');
    assert.equal(await livePrefixCounts('nodes'), 0, 'nodes 活行应清零（软删）');
    assert.equal(await livePrefixCounts('annotations'), 0, 'annotations 活行应清零（Canonical sidecar 墓碑）');
    assert.equal(await livePrefixCounts('relations'), 0, 'relations 活行应清零（Canonical sidecar 墓碑）');
    assert.equal(await prefixCounts('follows'), 0);
    assert.equal(await prefixCounts('accounts'), 0);
    // auth 表面全部硬删
    await assertAuthSurfaceRows(0);
    // 软删行保留登记（供下次注入复活）
    assert.equal(await prefixCounts('collections'), COLLECTION_COUNT, '软删行应保留（deleted_at 标记）');
    const applied = await sql<{ state: string }>`
      SELECT state FROM seed_applied WHERE seed_key = 'demo'
    `.execute(isolated.runtime.db);
    assert.equal(applied.rows[0]!.state, 'withdrawn');
  });

  test('5) 撤回后同版本重新注入：不跳过，业务与 auth 表面正常重建', async () => {
    const manifest = manifestFor(seedDir);
    const report = await applySeed(isolated.runtime, manifest, applyOptions('v2'));
    assert.equal(report.skipped, false);
    assert.equal(await livePrefixCounts('collections'), COLLECTION_COUNT);
    assert.equal(await livePrefixCounts('nodes'), NODE_COUNT);
    await assertAuthSurfaceRows(15);
  }, APPLY_TIMEOUT_MS);

  test('6) 业务引用预检：业务关注 seed 用户时撤回中止；--allow-cascade 放行且业务账号保留', async () => {
    // 造一个业务账号 + 业务用户对 seed 用户的关注
    await sql`
      INSERT INTO accounts (id, subject_id, status, email, security_epoch) VALUES ('biz-acc-1', 'biz-sub-1', 'active', 'biz1@example.com', 0)
    `.execute(isolated.runtime.db);
    await sql`
      INSERT INTO profiles (account_id, display_name) VALUES ('biz-acc-1', 'Biz User')
    `.execute(isolated.runtime.db);
    await sql`
      INSERT INTO follows (actor_profile_id, target_profile_id, followed_at) VALUES ('biz-acc-1', 'acc-u01wWA7gVl069uG0Vg', now())
    `.execute(isolated.runtime.db);

    const manifest = manifestFor(seedDir);
    // 无 --allow-cascade → 中止
    await assert.rejects(
      () => withdrawSeed(isolated.runtime, manifest, { by: 'test', allowCascade: false, cleanDangling: false }),
      (error: unknown) => error instanceof SeedError && error.code === 'reference_cascade',
    );
    // seed 数据原封未动
    assert.equal(await prefixCounts('collections'), COLLECTION_COUNT);

    // 带 --allow-cascade → 成功；业务关注被级联删除（明确告知过），业务账号保留
    const report = await withdrawSeed(isolated.runtime, manifest, { by: 'test', allowCascade: true, cleanDangling: false });
    assert.ok(report.cascade.length > 0);
    assert.equal(await livePrefixCounts('collections'), 0);
    await assertAuthSurfaceRows(0);
    const bizAccounts = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM accounts WHERE id = 'biz-acc-1'
    `.execute(isolated.runtime.db);
    assert.equal(bizAccounts.rows[0]!.n, 1);
    const bizFollows = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM follows WHERE actor_profile_id = 'biz-acc-1'
    `.execute(isolated.runtime.db);
    assert.equal(bizFollows.rows[0]!.n, 0);
  });

  test('6b) 未登记成员挂在 seed 收藏夹：无 cascade 中止；--allow-cascade 删除残留', async () => {
    await applySeed(isolated.runtime, manifestFor(seedDir), applyOptions('v2'));
    await sql`
      INSERT INTO accounts (id, subject_id, status, email, security_epoch)
      VALUES ('biz-acc-member', 'biz-sub-member', 'active', 'biz-member@example.com', 0)
    `.execute(isolated.runtime.db);
    await sql`
      INSERT INTO collection_members (collection_id, subject_id, role)
      VALUES (${seedCollectionId('col-u01-02')}, 'biz-sub-member', 'editor')
    `.execute(isolated.runtime.db);

    const manifest = manifestFor(seedDir);
    await assert.rejects(
      () => withdrawSeed(isolated.runtime, manifest, { by: 'test', allowCascade: false, cleanDangling: false }),
      (error: unknown) => error instanceof SeedError && error.code === 'reference_restrict',
    );
    assert.equal(await prefixCounts('collections'), COLLECTION_COUNT);

    const report = await withdrawSeed(isolated.runtime, manifest, { by: 'test', allowCascade: true, cleanDangling: false });
    assert.ok(report.cascade.some((item) => item.label.includes('业务成员')));
    const leftover = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM collection_members WHERE subject_id = 'biz-sub-member'
    `.execute(isolated.runtime.db);
    assert.equal(leftover.rows[0]!.n, 0);
    const biz = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM accounts WHERE id = 'biz-acc-member'
    `.execute(isolated.runtime.db);
    assert.equal(biz.rows[0]!.n, 1);
  }, APPLY_TIMEOUT_MS);

  test('6c) 业务 operation 挂在 seed 收藏夹：撤回不再尝试 DELETE（operations_permanent），而是保留并上报', async () => {
    await applySeed(isolated.runtime, manifestFor(seedDir), applyOptions('v2'));
    // 任何真实使用演示栈的动作（classify accept、编辑器写入……）都会在 seed 收藏夹上
    // 留下未登记的 operation。用「解除一条 seed 自身 operation 的登记」复现同一状态。
    const target = await sql<{ operation_id: string }>`
      SELECT o.operation_id FROM operations o
      WHERE o.collection_id = ${seedCollectionId('col-u01-01')} AND o.operation_id LIKE 'seed-op-%'
      ORDER BY o.commit_ordinal LIMIT 1
    `.execute(isolated.runtime.db);
    const operationId = target.rows[0]?.operation_id;
    assert.ok(operationId, 'seed canonical phase must have written an operation on the flagship collection');
    await sql`
      DELETE FROM seed_rows
      WHERE seed_key = 'demo' AND version = 'v2' AND table_name = 'operations'
        AND pk = ${JSON.stringify([operationId])}::jsonb
    `.execute(isolated.runtime.db);

    const manifest = manifestFor(seedDir);
    // 不需要 --allow-cascade：永久事实既不阻止撤回，也不会被删除。
    const report = await withdrawSeed(isolated.runtime, manifest, { by: 'test', allowCascade: false, cleanDangling: false });
    const retained = report.retained.find((item) => item.label.includes('operation'));
    assert.ok(retained, 'the unregistered operation must be reported as retained');
    assert.equal(retained!.count, 1);
    assert.equal(report.restrict.length, 0);

    const stillThere = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM operations WHERE operation_id = ${operationId}
    `.execute(isolated.runtime.db);
    assert.equal(stillThere.rows[0]!.n, 1);
    const liveSeedCollections = async () => {
      const result = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM collections
        WHERE (id LIKE 'col-u%' OR id LIKE 'col-ce%') AND deleted_at IS NULL
      `.execute(isolated.runtime.db);
      return result.rows[0]!.n;
    };
    assert.equal(await liveSeedCollections(), 0);

    // 重新注入仍然成立：保留的 operation 跟随软删后复活的收藏夹。
    await applySeed(isolated.runtime, manifestFor(seedDir), applyOptions('v3'));
    assert.equal(await liveSeedCollections(), COLLECTION_COUNT);
  }, APPLY_TIMEOUT_MS);

  test('7) 存量探测 fail-closed：无登记时存在前缀数据 → 注入被拒；adopt 认领 → withdraw → apply 全量补齐（含 auth 表面）', async () => {
    // 模拟全新库（无任何版本登记）但残留一行前缀数据
    await sql`DELETE FROM seed_applied WHERE seed_key = 'demo'`.execute(isolated.runtime.db);
    await sql`DELETE FROM seed_rows WHERE seed_key = 'demo'`.execute(isolated.runtime.db);
    await sql`
      INSERT INTO accounts (id, subject_id, status, email, security_epoch) VALUES ('acc-u99', 'sub-u99', 'active', 'leftover@example.com', 0)
    `.execute(isolated.runtime.db);

    const manifest = manifestFor(seedDir);
    await assert.rejects(
      () => applySeed(isolated.runtime, manifest, applyOptions('v3')),
      (error: unknown) => error instanceof SeedError && error.code === 'leftover_data',
    );

    // adopt 认领（登记现有存量行：acc-u99 + 撤回遗留的软删 collections/nodes）
    const adopted = await adoptSeed(isolated.runtime, manifest, { version: 'v3', by: 'test' });
    assert.ok(adopted.adoptedRows >= 1, `应登记存量行（实际 ${adopted.adoptedRows}）`);

    // 认领后先 withdraw（清掉认领的 acc-u99 与软删残留），再同版本 apply：
    // apply 不被跳过，业务数据全量重建，auth 表面由 auth 阶段补齐（adopt 只认领存量）。
    const withdrawn = await withdrawSeed(isolated.runtime, manifest, { by: 'test', allowCascade: false, cleanDangling: false });
    assert.equal(withdrawn.version, 'v3');
    const report = await applySeed(isolated.runtime, manifest, applyOptions('v3'));
    assert.equal(report.skipped, false, 'adopt 后同版本 apply 必须补齐 auth 表面（不被跳过）');
    assert.equal(report.insertedRows, TOTAL_ROW_COUNT);
    await assertAuthSurfaceRows(15);
    const applied = await sql<{ version: string }>`
      SELECT version, state FROM seed_applied WHERE seed_key = 'demo'
    `.execute(isolated.runtime.db);
    assert.equal(applied.rows[0]!.version, 'v3');
    assert.equal(applied.rows[0]!.state, 'applied');
  }, APPLY_TIMEOUT_MS);

  test('9) auth 表面内容：Argon2id credential、verified user、映射、metadata 摘要、ledger 登记', async () => {
    await assertAuthSurfaceRows(15);

    // 每个 auth 用户都映射到 data.sql 的业务账号（account id 稳定关联事实）
    const mappings = await isolated.runtime.pool.query<{ auth_user_id: string; account_id: string }>(
      `select m.auth_user_id, m.account_id from auth_user_account_map m
       join accounts a on a.id = m.account_id
       where a.id like 'acc-u%' order by m.auth_user_id`,
    );
    assert.equal(mappings.rows.length, 15);
    assert.equal(mappings.rows[0]!.auth_user_id, 'seed-auser-u01');
    assert.equal(mappings.rows[0]!.account_id, 'acc-u01wWA7gVl069uG0Vg');

    const aligned = await isolated.runtime.pool.query<{ subject_id: string; auth_user_id: string }>(
      `select a.subject_id, m.auth_user_id
         from accounts a
         join auth_user_account_map m on m.account_id = a.id
        where a.id like 'acc-u%'
        order by m.auth_user_id`,
    );
    assert.equal(aligned.rows.length, 15);
    for (const row of aligned.rows) {
      assert.equal(row.subject_id, row.auth_user_id);
    }
    assert.equal(aligned.rows[0]!.subject_id, 'seed-auser-u01');
    const flagshipOwner = await isolated.runtime.pool.query<{ owner_subject_id: string }>(
      `select owner_subject_id from collections where id = $1`,
      [FLAGSHIP_COLLECTION_ID],
    );
    assert.equal(flagshipOwner.rows[0]!.owner_subject_id, 'seed-auser-u01');
    const memberLedger = await isolated.runtime.pool.query<{ old_subject: number; mapped_subject: number }>(
      `select
         count(*) filter (where pk->>1 like 'sub-u%')::int as old_subject,
         count(*) filter (where pk->>1 like 'seed-auser-%')::int as mapped_subject
         from seed_rows
        where seed_key = 'demo' and table_name = 'collection_members'`,
    );
    assert.equal(memberLedger.rows[0]!.old_subject, 0, '对齐后 collection_members 登记不得再持有 sub-uNN 主键');
    assert.equal(memberLedger.rows[0]!.mapped_subject > 0, true, '对齐后 collection_members 登记必须含 seed-auser-uNN');
    const celebrities = await isolated.runtime.pool.query<{ subject_id: string }>(
      `select subject_id from accounts where id like 'acc-ce%'`,
    );
    assert.equal(celebrities.rows.length > 0, true);
    assert.equal(celebrities.rows.every((row) => row.subject_id.startsWith('sub-ce')), true);

    // 密码 credential：真实 Argon2id PHC 前缀 + 真实 verify 往返（不是字符串比较）
    const credential = await isolated.runtime.pool.query<{ password: string; account_id: string }>(
      `select c."password", c."accountId" from auth_accounts c
       join auth_user_account_map m on m.auth_user_id = c."userId"
       where c."providerId" = 'credential' and c."accountId" = 'seed-auser-u01'`,
    );
    assert.equal(credential.rows.length, 1);
    const storedHash = credential.rows[0]!.password;
    assert.match(storedHash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/u);
    assert.equal(storedHash.includes(DEMO_PASSWORD), false, '明文密码不得落库');
    const hasher = createArgon2idPasswordHasher();
    assert.equal(await hasher.verify({ hash: storedHash, password: DEMO_PASSWORD }), true);
    assert.equal(await hasher.verify({ hash: storedHash, password: 'wrong-demo-password' }), false); // secret-scan: allow 'wrong-demo-password'

    // auth user：verified 且 email 与业务账号一致
    const user = await isolated.runtime.pool.query<{ email: string; emailVerified: boolean }>(
      `select u."email", u."emailVerified" from auth_users u where u."id" = 'seed-auser-u01'`,
    );
    assert.equal(user.rows[0]!.email, 'lin.yichen@example.com');
    assert.equal(user.rows[0]!.emailVerified, true, 'demo auth user 应为 verified');

    // metadata 保存逻辑 bearer 的摘要；carrier 保存随机认证密文 + HMAC 查询键。
    const metadata = await isolated.runtime.pool.query<{
      session_token_hash: string;
      csrf_token_hash: string;
      account_id: string;
    }>(
      `select session_token_hash, csrf_token_hash, account_id from known_auth_session_metadata
       where auth_session_id = 'seed-sess-u01'`,
    );
    assert.equal(metadata.rows.length, 1);
    assert.equal(metadata.rows[0]!.account_id, 'acc-u01wWA7gVl069uG0Vg');
    const sessionToken = await isolated.runtime.pool.query<{ token: string; tokenLookupHash: string | null }>(
      `select "token", "tokenLookupHash" from auth_sessions where "id" = 'seed-sess-u01'`,
    );
    assert.ok(sessionToken.rows[0]);
    assert.match(sessionToken.rows[0]!.token, /^knst1\.1\./u);
    assert.match(sessionToken.rows[0]!.tokenLookupHash!, /^knsh1\.1\.[A-Za-z0-9_-]{43}$/u);
    const logicalToken = sessionTokenProtector.reveal(sessionToken.rows[0]!.token);
    assert.equal(metadata.rows[0]!.session_token_hash, browserSessionTokenHash(logicalToken));
    assert.notEqual(metadata.rows[0]!.session_token_hash, sessionToken.rows[0]!.token);
    assert.equal(metadata.rows[0]!.session_token_hash.length, 64);

    // ledger：auth 表面 5 张表的行全部登记在 seed_rows（v3 版本）
    const registeredAuth = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from seed_rows
       where seed_key = 'demo' and version = 'v3'
       and table_name in ('auth_users','auth_accounts','auth_user_account_map','auth_sessions','known_auth_session_metadata')`,
    );
    assert.equal(registeredAuth.rows[0]!.n, AUTH_ROW_COUNT);
  });

  test('10) 密码可登录：真实 Argon2 verify + 真实 BA sign-in；session cookie 真实属性', async () => {
    const signIn = await authBridge.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in/email',
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: JSON.stringify({ email: 'lin.yichen@example.com', password: DEMO_PASSWORD }),
    });
    assert.equal(signIn.statusCode, 200);
    // light-my-request：单条 set-cookie 是字符串，多条才是数组（与仓库其他测试同构处理）
    const rawSetCookie = signIn.headers['set-cookie'];
    const setCookies = (Array.isArray(rawSetCookie) ? rawSetCookie : rawSetCookie ? [rawSetCookie] : []) as string[];
    const sessionSetCookie = setCookies.find((header) => header.startsWith('__Host-known_session='));
    assert.ok(sessionSetCookie, 'sign-in 必须下发 __Host-known_session');
    // 真实属性合同（G1 §4）：Secure; HttpOnly; SameSite=Lax; Path=/; 无 Domain
    assert.match(sessionSetCookie, /;\s*Secure/i);
    assert.match(sessionSetCookie, /;\s*HttpOnly/i);
    assert.match(sessionSetCookie, /;\s*SameSite=Lax/i);
    assert.match(sessionSetCookie, /;\s*Path=\//i);
    assert.doesNotMatch(sessionSetCookie, /;\s*Domain=/i);

    const cookieValue = sessionSetCookie.split(';', 1)[0]!.split('=', 2)[1]!;
    // BA 签名段是 URL 编码的（%2F / %3D）；浏览器原样回传，不能再 encodeURIComponent（否则双重编码）
    const session = await authBridge.inject({
      method: 'GET',
      url: '/api/v1/auth/get-session?disableRefresh=true',
      headers: { cookie: `__Host-known_session=${cookieValue}` },
    });
    assert.equal(session.statusCode, 200);
    const sessionBody = JSON.parse(session.body) as { user?: { email?: string } };
    assert.equal(sessionBody.user?.email, 'lin.yichen@example.com');

    // 错误密码：401，与未知邮箱同 body（非枚举）
    const wrong = await authBridge.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in/email',
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: JSON.stringify({ email: 'lin.yichen@example.com', password: 'definitely-wrong-pw' }), // secret-scan: allow 'definitely-wrong-pw'
    });
    assert.equal(wrong.statusCode, 401);
    assert.equal((JSON.parse(wrong.body) as { code?: string }).code, 'INVALID_EMAIL_OR_PASSWORD');
  });

  test('11) seed 后 /api/v1/me 映射正确；seed session cookie 通过真实 authority', async () => {
    // 使用 seed 阶段创建的受保护 carrier；测试端只在本地解密后签 cookie。
    const cookie = await seededDemoCookie('seed-auser-u01');

    const me = await productApp.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: cookieHeader(cookie) },
    });
    assert.equal(me.statusCode, 200);
    const meBody = me.json() as { account?: { id?: string; email?: string | null }; profile?: { displayName?: string } };
    assert.equal(meBody.account?.id, 'acc-u01wWA7gVl069uG0Vg', 'auth user 必须映射到业务账号，而不是 auth user id');
    assert.equal(meBody.account?.email, 'lin.yichen@example.com');
    assert.equal(meBody.profile?.displayName, '林一晨');

    const session = await productApp.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie: cookieHeader(cookie) },
    });
    assert.equal(session.statusCode, 200);
    const sessionBody = session.json() as { authenticated?: boolean; csrfToken?: string };
    assert.equal(sessionBody.authenticated, true);
    assert.equal(typeof sessionBody.csrfToken, 'string');
    assert.ok((sessionBody.csrfToken ?? '').length > 0);
  });

  test('12) 假阳性防护：删除 Better Auth session row 后 demo cookie 必须失败', async () => {
    const cookie = await seededDemoCookie('seed-auser-u01');
    const before = await productApp.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: cookieHeader(cookie) },
    });
    assert.equal(before.statusCode, 200, '删除前 demo cookie 必须可用（前置条件）');

    // 删除 BA session 行（metadata 随 FK CASCADE 删除）
    await isolated.runtime.pool.query(
      `delete from auth_sessions where "id" = 'seed-sess-u01'`,
    );
    const metadataLeft = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from known_auth_session_metadata where auth_session_id = 'seed-sess-u01'`,
    );
    assert.equal(metadataLeft.rows[0]!.n, 0, 'metadata 必须随 BA session 级联删除');

    const after = await productApp.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: cookieHeader(cookie) },
    });
    assert.equal(after.statusCode, 401);
    assert.equal((after.json() as { error: { code: string } }).error.code, 'authentication_required');
    const session = await productApp.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie: cookieHeader(cookie) },
    });
    assert.deepEqual(session.json(), { authenticated: false });
  });

  test('14) 假阴性防护：seed 不产生 OTP/verification 行；auth 表面行数与 ledger 一致', async () => {
    const verifications = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from auth_verifications`,
    );
    assert.equal(verifications.rows[0]!.n, 0, 'seed 不得产生任何 OTP/verification 行（OTP 仅测试 sink 可见）');
    // 业务 + auth 全部登记在 seed_rows，且每张表前缀行 == 登记行
    const perTable = await isolated.runtime.pool.query<{ table_name: string; n: number }>(
      `select table_name, count(*)::int n from seed_rows
       where seed_key = 'demo' and version = 'v3'
       group by table_name order by table_name`,
    );
    const byTable = new Map(perTable.rows.map((row) => [row.table_name, row.n]));
    for (const spec of DEMO_MANIFEST.tables) {
      assert.equal(byTable.get(spec.table), spec.expectedRows, `${spec.table} seed_rows 应等于 expectedRows`);
    }
    assert.equal(byTable.get('operations'), SEED_CANONICAL_MUTATION_COUNT);
    assert.equal(byTable.has('children_revisions'), false, '不再登记 SQL 手写 children_revisions');
    assert.equal(byTable.has('policy_revisions'), false, '不再登记 SQL 手写 policy_revisions');
  });

  test('15) KNOWN_DEMO_PASSWORD 缺失/过短 → auth 阶段 fail-closed（不写 applied、auth 表面零残留、补密码后可自愈重跑）', async () => {
    // 先撤回 v3（回到 withdrawn 基线）
    const manifest = manifestFor(seedDir);
    const withdrawn = await withdrawSeed(isolated.runtime, manifest, { by: 'test', allowCascade: false, cleanDangling: false });
    assert.equal(withdrawn.version, 'v3');

    // 缺失密码：业务阶段提交后 auth 阶段拒绝；seed_applied 保持 withdrawn，auth 表面零行
    await assert.rejects(
      () => applySeed(isolated.runtime, manifest, {
        ...applyOptions('v4'),
        env: Object.fromEntries(Object.entries(seedEnv()).filter(([key]) => key !== 'KNOWN_DEMO_PASSWORD')),
      }),
      (error: unknown) => error instanceof SeedError && error.code === 'demo_password_required',
    );
    const stateAfterMissing = await sql<{ state: string; version: string }>`
      SELECT state, version FROM seed_applied WHERE seed_key = 'demo'
    `.execute(isolated.runtime.db);
    assert.equal(stateAfterMissing.rows[0]!.state, 'withdrawn', 'auth 阶段失败不得写入 applied');
    assert.equal(await tableCount('auth_users'), 0, 'auth 阶段失败不得留下任何 auth user');
    assert.equal(await tableCount('auth_accounts'), 0);
    assert.equal(await tableCount('auth_user_account_map'), 0);
    assert.equal(await tableCount('auth_sessions'), 0);
    assert.equal(await tableCount('known_auth_session_metadata'), 0);

    // 过短密码（< 8 位，低于 BA minPasswordLength）同样 fail-closed
    await assert.rejects(
      () => applySeed(isolated.runtime, manifest, {
        ...applyOptions('v4'),
        env: { ...seedEnv(), KNOWN_DEMO_PASSWORD: 'short' }, // secret-scan: allow 'short'
      }),
      (error: unknown) => error instanceof SeedError && error.code === 'demo_password_too_short',
    );

    // 自愈：补上合法密码重跑同版本 apply → 业务幂等重建 + auth 表面补齐，状态 applied
    const report = await applySeed(isolated.runtime, manifest, applyOptions('v4'));
    assert.equal(report.skipped, false);
    assert.equal(report.insertedRows, TOTAL_ROW_COUNT);
    await assertAuthSurfaceRows(15);
    const applied = await sql<{ state: string }>`
      SELECT state FROM seed_applied WHERE seed_key = 'demo'
    `.execute(isolated.runtime.db);
    assert.equal(applied.rows[0]!.state, 'applied');
  }, APPLY_TIMEOUT_MS);

  test('16) 编辑器读路径能加载旗舰收藏夹 col-u01-01；commit_ordinal 与 operations 对齐', async () => {
    const cookie = await seededDemoCookie('seed-auser-u01');
    const editor = await productApp.inject({
      method: 'GET',
      url: `/api/v1/collections/${FLAGSHIP_COLLECTION_ID}/editor`,
      headers: { cookie: cookieHeader(cookie) },
    });
    assert.equal(editor.statusCode, 200, editor.body);
    const page = editor.json() as { collection?: { id?: string }; nodes?: unknown[] };
    assert.equal(page.collection?.id, FLAGSHIP_COLLECTION_ID);
    assert.ok(Array.isArray(page.nodes) && page.nodes.length > 0, '旗舰收藏夹编辑器节点不得为空');

    const aligned = await isolated.runtime.pool.query<{
      commit_ordinal: string;
      max_ordinal: string;
      op_count: number;
    }>(
      `select c.commit_ordinal::text,
              coalesce((select max(o.commit_ordinal) from operations o where o.collection_id = c.id), 0)::text as max_ordinal,
              (select count(*)::int from operations o where o.collection_id = c.id and o.operation_id like 'seed-op-%') as op_count
         from collections c where c.id = $1`,
      [FLAGSHIP_COLLECTION_ID],
    );
    assert.equal(aligned.rows[0]?.commit_ordinal, aligned.rows[0]?.max_ordinal);
    assert.equal(aligned.rows[0]?.op_count, FLAGSHIP_CANONICAL_MUTATION_COUNT);
  });
});
