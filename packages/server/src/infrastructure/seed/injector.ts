import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import type { Manifest } from './manifest.js';
import { SeedError, dataSqlPath, authPhaseTables, sqlPhaseTables } from './manifest.js';
import {
  countRegisteredRows,
  deleteRegisteredRows,
  pkMatchLhsSql,
  readAppliedForUpdate,
  recordHistory,
  registerRows,
  writeApplied,
  type AppliedState,
} from './state.js';
import { liveCondition, prefixCount, scalarCount, selectPks } from './helpers.js';
import { withdrawSeed, type WithdrawReport, type WithdrawOptions } from './withdrawer.js';
import { createUnitOfWork } from '../database/unit-of-work.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { DatabaseRuntime } from '../database/runtime.js';
import { runCanonicalSeedPhase } from './canonical-phase.js';
import { executableSeedDataSql, SEED_OPAQUE_INSTALL_SQL } from './seed-opaque-id.js';
import { runSubjectIdReferenceCascade } from './subject-id-reference-cascade.js';

export interface ApplyOptions extends WithdrawOptions {
  readonly version: string;
  /** 透传给 auth 阶段脚本（loadConfig 用）；缺省读 process.env。 */
  readonly env?: NodeJS.ProcessEnv;
}

export interface ApplyReport {
  readonly skipped: boolean;
  readonly version: string;
  readonly insertedRows: number;
  readonly tableCounts: Record<string, number>;
  readonly withdrawReport?: WithdrawReport;
  /** auth 阶段创建的 demo 账号（account id + email；不含任何凭据）。 */
  readonly authAccounts?: ReadonlyArray<{ readonly accountId: string; readonly email: string }>;
}

/**
 * auth 阶段脚本的输入契约（结构镜像；脚本位于仓库 seed/<key>/，imports src 表面）。
 * 只传原语与运行器依赖，避免 seed 基础设施静态依赖 auth 实现。
 */
export interface SeedAuthPhaseInput {
  readonly runtime: DatabaseRuntime;
  readonly manifest: Manifest;
  readonly version: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface SeedAuthPhaseReport {
  readonly insertedRows: number;
  readonly tableCounts: Record<string, number>;
  readonly accounts: ReadonlyArray<{ readonly accountId: string; readonly email: string }>;
}

/** 复活软删登记行（撤回留下的 deleted_at 标记 → NULL；查该 seed_key 全部登记）。 */
function buildResurrectSql(
  seedKey: string,
  spec: {
    readonly table: string;
    readonly pkColumns: readonly string[];
    readonly deletedAtColumn: string;
    readonly deletedCommitOrdinalColumn?: string;
  },
): string | null {
  const picks = spec.pkColumns.map((_, index) => `r.pk->>${index}`).join(', ');
  const lhs = pkMatchLhsSql(spec.pkColumns);
  const setClause = spec.deletedCommitOrdinalColumn
    ? `${spec.deletedAtColumn} = NULL, ${spec.deletedCommitOrdinalColumn} = NULL`
    : `${spec.deletedAtColumn} = NULL, updated_at = now()`;
  return `UPDATE ${spec.table} SET ${setClause}`
    + ` WHERE ${lhs} IN (SELECT ${picks} FROM seed_rows r WHERE r.seed_key = '${seedKey}'`
    + ` AND r.table_name = '${spec.table}')`
    + ` AND ${spec.deletedAtColumn} IS NOT NULL`;
}

/** 存量探测：无版本记录时，任何登记表前缀下存在数据 → 拒绝注入（fail-closed）。 */
async function detectLeftover(tr: Parameters<typeof prefixCount>[0], manifest: Manifest): Promise<string[]> {
  const leftovers: string[] = [];
  for (const spec of manifest.tables) {
    const count = await prefixCount(tr, spec.table, spec.prefixSql);
    if (count > 0) leftovers.push(`${spec.table}=${count}`);
  }
  return leftovers;
}

/**
 * 换版/重灌时收藏夹可能仍带着上次 3b 写入的 `seed-auser-uNN`（软删不改
 * owner）。data.sql 按 `accounts.subject_id = collections.owner_subject_id`
 * 生成 Feed/通知，且 post_checks 钉的是 `sub-uNN`。对齐之前必须先还原。
 */
async function restoreSqlNativeMappedSubjectCopies(
  transaction: DatabaseTransaction,
): Promise<void> {
  await sql`
    UPDATE collections
       SET owner_subject_id = regexp_replace(owner_subject_id, '^seed-auser-', 'sub-'),
           payload_json = CASE
             WHEN payload_json ? 'ownerSubjectId'
             THEN jsonb_set(
               payload_json,
               '{ownerSubjectId}',
               to_jsonb(regexp_replace(owner_subject_id, '^seed-auser-', 'sub-'))
             )
             ELSE payload_json
           END
     WHERE owner_subject_id LIKE 'seed-auser-%'
  `.execute(transaction);
  await sql`
    UPDATE collection_members
       SET subject_id = regexp_replace(subject_id, '^seed-auser-', 'sub-')
     WHERE subject_id LIKE 'seed-auser-%'
  `.execute(transaction);
  await sql`
    UPDATE collection_invites
       SET invited_subject_id = regexp_replace(invited_subject_id, '^seed-auser-', 'sub-')
     WHERE invited_subject_id LIKE 'seed-auser-%'
  `.execute(transaction);
  await sql`
    UPDATE collection_invites
       SET invited_by_subject_id = regexp_replace(invited_by_subject_id, '^seed-auser-', 'sub-')
     WHERE invited_by_subject_id LIKE 'seed-auser-%'
  `.execute(transaction);
  await sql`
    UPDATE collection_invites
       SET accepted_subject_id = regexp_replace(accepted_subject_id, '^seed-auser-', 'sub-')
     WHERE accepted_subject_id LIKE 'seed-auser-%'
  `.execute(transaction);
  await sql`
    UPDATE collection_export_jobs
       SET owner_subject_id = regexp_replace(owner_subject_id, '^seed-auser-', 'sub-')
     WHERE owner_subject_id LIKE 'seed-auser-%'
  `.execute(transaction);
  await sql`
    UPDATE collection_classify_inbox_decision
       SET account_subject_id = regexp_replace(account_subject_id, '^seed-auser-', 'sub-')
     WHERE account_subject_id LIKE 'seed-auser-%'
  `.execute(transaction);
  await sql`
    UPDATE blob_records
       SET owner_subject_id = regexp_replace(owner_subject_id, '^seed-auser-', 'sub-')
     WHERE owner_subject_id LIKE 'seed-auser-%'
  `.execute(transaction);
  await sql`
    UPDATE attachments
       SET owner_subject_id = regexp_replace(owner_subject_id, '^seed-auser-', 'sub-')
     WHERE owner_subject_id LIKE 'seed-auser-%'
  `.execute(transaction);
  await sql`
    UPDATE accounts
       SET subject_id = regexp_replace(subject_id, '^seed-auser-', 'sub-')
     WHERE id LIKE 'acc-u%' AND subject_id LIKE 'seed-auser-%'
  `.execute(transaction);
}

/**
 * T-03 cascade 会改写 `collection_members.subject_id`（复合主键的一列）。
 * 阶段 2c 登记的仍是 `sub-uNN`；不对齐重登记的话，撤回预检会把这些行当成
 * 未登记业务成员而 RESTRICT。
 */
async function reregisterRemappedSubjectPkRows(
  transaction: DatabaseTransaction,
  manifest: Manifest,
  version: string,
): Promise<void> {
  for (const spec of manifest.tables) {
    if (!spec.pkColumns.includes('subject_id')) continue;
    await deleteRegisteredRows(transaction, manifest.key, version, spec.table);
    const rows = await selectPks(transaction, spec);
    await registerRows(transaction, manifest.key, version, rows);
  }
}

/**
 * 注入/换版入口（B3 + PERIPH-P1-b：五阶段，各自独立事务）。
 * - 阶段 1（无锁读）：同版本已应用且 auth 表面完整 → 跳过；版本不同 → 先撤回旧版。
 * - 阶段 2（独立事务）：复活软删登记行；若有 auth 阶段则把上次对齐留下的
 *   `seed-auser-uNN` 还原成 `sub-uNN`；再执行 data.sql（非 Canonical 业务表）。
 * - 阶段 2b（独立 UoW 组）：annotations / relations 经现有 Canonical 门面写入
 *   （operations / audit / revisions / outbox 由 ports 产生，禁止 SQL 旁路）。
 * - 阶段 2b2（独立 UoW）：从已提交的 votes + 官方 hide/delist 重建 hot-v1
 *   排名快照（Explore 热榜读投影，不读 live 票）。快照不进 seed_rows。
 * - 阶段 2c（独立事务）：行登记 + 行数校验 + post_checks（含 Canonical 副作用）。
 * - 阶段 3（独立事务组）：auth 阶段脚本（phase='auth' 表）通过已验证 seed port
 *   创建 BA user/account/credential/session metadata 并登记、校验。BA 适配器
 *   事务不能加入产品事务（G0 §4.8），因此 auth 阶段必须在 data.sql 提交后执行。
 * - 阶段 3b + 4（同一事务）：把已映射 demo 账号的 `accounts.subject_id` 与
 *   收藏夹 owner/member 等副本对齐到 Better Auth `user.id`（ADR D3），再按
 *   活行重登记 PK 含 `subject_id` 的表（否则撤回会把对齐后的成员当成业务
 *   残留）。然后写 seed_applied + 审计 + 全量登记行数校验。
 *   data.sql 仍写 `sub-uNN`；MCP JWT `sub` 是 `seed-auser-uNN`。T-03 迁移
 *   只跑一次，换版/重灌会把 subject 写回旧值，所以每次成功 auth 之后都要
 *   再跑一遍幂等 cascade。
 *
 * auth 阶段失败时 seed_applied 已由阶段 4 之前保持原状（未写 applied 或保持
 * 旧版本），恢复路径：--adopt <version> 认领存量后重跑 --apply（auth 阶段幂等
 * 自愈：已存在的 auth user 跳过建户，session 表面每次重建）。
 */
export async function applySeed(
  runtime: DatabaseRuntime,
  manifest: Manifest,
  options: ApplyOptions,
): Promise<ApplyReport> {
  // 阶段 1：状态判断 + 换版撤回（独立事务）
  const current = await readAppliedPlain(runtime.db, manifest.key);
  let withdrawReport: WithdrawReport | undefined;
  const authComplete = await authSurfaceComplete(runtime, manifest);
  if (current && current.state === 'applied' && current.version === options.version
      && !options.version.includes('-dirty') && authComplete) {
    return { skipped: true, version: options.version, insertedRows: 0, tableCounts: {} };
  }
  if (current && current.state === 'applied' && current.version !== options.version) {
    withdrawReport = await withdrawSeed(runtime, manifest, {
      by: options.by,
      allowCascade: options.allowCascade,
      cleanDangling: options.cleanDangling,
      ...(options.reportSourceInvalidation === undefined ? {} : { reportSourceInvalidation: options.reportSourceInvalidation }),
    });
  }

  // 阶段 2：业务数据注入（独立事务，FOR UPDATE 双检防并发重复注入）
  const sqlInjected = await createUnitOfWork(runtime.db, { isolationLevel: 'read committed' }).execute(
    async ({ transaction }) => {
      const locked = await readAppliedForUpdate(transaction, manifest.key);
      if (locked && locked.state === 'applied' && locked.version === options.version
          && !options.version.includes('-dirty')
          && await authTablesComplete(transaction, manifest)) {
        return { skipped: true };
      }

      // 无版本记录时的存量探测（fail-closed；含 auth 表，防部分失败的 auth 残留）
      if (!locked) {
        const leftovers = await detectLeftover(transaction, manifest);
        if (leftovers.length > 0) {
          throw new SeedError(
            'leftover_data',
            `检测到未登记版本的存量 seed 数据：${leftovers.join('、')}。`
            + `请先 --adopt <version> 认领，或 --withdraw 清理后重试。`,
          );
        }
      }

      // 注入：先复活撤回留下的软删行（deleted_at → NULL），把上次 3b 留下的
      // seed-auser subject 还原成 data.sql 的 sub-uNN，再执行 data.sql。
      // Canonical 表与行登记在 2b/2c：门面 UoW 必须看见已提交的 collections/nodes。
      for (const spec of manifest.tables) {
        if (!spec.deletedAtColumn) continue;
        const resurrect = buildResurrectSql(manifest.key, {
          table: spec.table,
          pkColumns: spec.pkColumns,
          deletedAtColumn: spec.deletedAtColumn,
          ...(spec.deletedCommitOrdinalColumn
            ? { deletedCommitOrdinalColumn: spec.deletedCommitOrdinalColumn }
            : {}),
        });
        if (resurrect) await sql.raw(resurrect).execute(transaction);
      }
      if (manifest.authScript !== undefined) {
        await restoreSqlNativeMappedSubjectCopies(transaction);
      }
      const dataSql = readFileSync(dataSqlPath(manifest.seedDir), 'utf8');
      // CREATE FUNCTION must run as its own query. LANGUAGE sql validates the
      // helper body at parse time; a single data.sql batch cannot see seed_opaque
      // before seed_collection_id is created.
      for (const statement of SEED_OPAQUE_INSTALL_SQL) {
        await sql.raw(statement).execute(transaction);
      }
      await sql.raw(executableSeedDataSql(dataSql)).execute(transaction);
      return { skipped: false };
    },
  );
  if (sqlInjected.skipped) {
    return { skipped: true, version: options.version, insertedRows: 0, tableCounts: {} };
  }

  // 阶段 2b：Canonical 门面写 annotations/relations（独立 UoW，必须看见已提交的 collections/nodes）
  await runCanonicalSeedPhase(runtime);

  // 阶段 2c：登记 + 期望行数 + post_checks（含 Canonical 副作用）
  const registered = await createUnitOfWork(runtime.db, { isolationLevel: 'read committed' }).execute(
    async ({ transaction }) => {
      await sql`
        DELETE FROM seed_rows WHERE seed_key = ${manifest.key}
      `.execute(transaction);
      let insertedRows = 0;
      const sqlTables = sqlPhaseTables(manifest);
      for (const spec of sqlTables) {
        const rows = await selectPks(transaction, spec);
        await registerRows(transaction, manifest.key, options.version, rows);
        insertedRows += rows.length;
      }

      const tableCounts: Record<string, number> = {};
      for (const spec of sqlTables) {
        const count = await prefixCount(transaction, spec.table, spec.prefixSql, liveCondition(spec));
        tableCounts[spec.table] = count;
        if (count !== spec.expectedRows) {
          throw new SeedError(
            'row_count_mismatch',
            `注入后 ${spec.table} 活行计数 ${count} != 期望 ${spec.expectedRows}（版本 ${options.version}）`,
          );
        }
      }

      for (const check of manifest.postChecks) {
        const actual = await scalarCount(transaction, check.sql);
        if (actual !== check.expected) {
          throw new SeedError(
            'post_check_failed',
            `${check.label}：期望 ${check.expected}，实际 ${actual}`,
          );
        }
      }

      return { insertedRows, tableCounts };
    },
  );
  const business = { skipped: false as const, ...registered };

  // 阶段 3：auth 阶段（独立事务组；BA 适配器事务不能加入产品事务 — G0 §4.8）
  let authReport: SeedAuthPhaseReport = { insertedRows: 0, tableCounts: {}, accounts: [] };
  if (manifest.authScript !== undefined) {
    authReport = await runAuthPhase(runtime, manifest, options);
  }

  // 阶段 3b + 4：对齐必须与 PK 重登记、applied 标记同事务，避免撤回看到陈旧 seed_rows。
  const insertedRows = business.insertedRows + authReport.insertedRows;
  await createUnitOfWork(runtime.db, { isolationLevel: 'read committed' }).execute(
    async ({ transaction }) => {
      if (manifest.authScript !== undefined) {
        try {
          await runSubjectIdReferenceCascade(transaction);
        } catch (error) {
          throw new SeedError(
            'subject_id_alignment_failed',
            `mapped account subject_id alignment failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        await reregisterRemappedSubjectPkRows(transaction, manifest, options.version);
      }
      await writeApplied(transaction, manifest.key, options.version, options.by, manifest);
      await recordHistory(transaction, manifest.key, options.version, 'applied', options.by, manifest);
      const registered = await countRegisteredRows(transaction, manifest.key, options.version);
      if (registered !== insertedRows) {
        throw new SeedError('registration_mismatch', `登记行数 ${registered} != 插入行数 ${insertedRows}`);
      }
    },
  );
  return {
    skipped: false,
    version: options.version,
    insertedRows,
    tableCounts: { ...business.tableCounts, ...authReport.tableCounts },
    withdrawReport,
    ...(authReport.accounts.length > 0 ? { authAccounts: authReport.accounts } : {}),
  };
}

/**
 * auth 表面完整性（阶段 1 防重判断用，只读）：phase='auth' 表的前缀活行计数
 * 全部等于 expectedRows 才算完整。无 auth 阶段时恒为 true。
 */
async function authSurfaceComplete(runtime: DatabaseRuntime, manifest: Manifest): Promise<boolean> {
  if (authPhaseTables(manifest).length === 0) return true;
  return createUnitOfWork(runtime.db).execute(({ transaction }) =>
    authTablesComplete(transaction, manifest));
}

/** 事务内 auth 表面完整性检查（阶段 2 FOR UPDATE 双检复用）。 */
async function authTablesComplete(tr: DatabaseTransaction, manifest: Manifest): Promise<boolean> {
  for (const spec of authPhaseTables(manifest)) {
    const count = await prefixCount(tr, spec.table, spec.prefixSql, liveCondition(spec));
    if (count !== spec.expectedRows) return false;
  }
  return true;
}

/**
 * 执行 auth 阶段脚本（manifest.authScript）。脚本是仓库代码（imports src 表面），
 * 从仓库 seed/<key>/ 目录解析，不从数据包拷贝目录解析——拷贝目录（如测试 tmp
 * 副本）中的相对 src import 无法解析。
 */
async function runAuthPhase(
  runtime: DatabaseRuntime,
  manifest: Manifest,
  options: ApplyOptions,
): Promise<SeedAuthPhaseReport> {
  const scriptPath = resolveAuthScriptPath(manifest);
  let module: unknown;
  try {
    module = await import(pathToFileURL(scriptPath).href);
  } catch (error) {
    throw new SeedError(
      'auth_script_load_failed',
      `auth 阶段脚本加载失败：${scriptPath}（${error instanceof Error ? error.message : String(error)}）。`
      + `本地源码模式经 tsx/vitest 运行；镜像 dist 模式由 Dockerfile 预 bundle（dist/seed/...）。`,
    );
  }
  const seedDemoAuth = (module as { readonly seedDemoAuth?: unknown }).seedDemoAuth;
  if (typeof seedDemoAuth !== 'function') {
    throw new SeedError(
      'auth_script_contract',
      `auth 阶段脚本 ${manifest.authScript} 必须导出 seedDemoAuth(input) 函数。`,
    );
  }
  try {
    return await (seedDemoAuth as (input: SeedAuthPhaseInput) => Promise<SeedAuthPhaseReport>)({
      runtime,
      manifest,
      version: options.version,
      env: options.env,
    });
  } catch (error) {
    if (error instanceof SeedError) throw error;
    throw new SeedError(
      'auth_phase_failed',
      `auth 阶段执行失败：${error instanceof Error ? error.message : String(error)}。`
      + `可用 --adopt <version> 认领存量后重跑 --apply（auth 阶段幂等自愈）。`,
    );
  }
}

/** auth 阶段脚本的仓库路径：<repo>/seed/<manifest.key>/<authScript>。
 * dist 直跑布局（镜像）下 seed 源码不可执行，Dockerfile 将 auth 阶段 bundle
 * 为 <repo>/dist/seed/<key>/<authScript 同名>.js，存在时优先加载。 */
function resolveAuthScriptPath(manifest: Manifest): string {
  const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
  const tsPath = join(repoRoot, 'seed', manifest.key, manifest.authScript!);
  if (!existsSync(tsPath)) {
    const jsPath = tsPath.replace(/\.ts$/u, '.js');
    if (existsSync(jsPath)) return jsPath;
  }
  return tsPath;
}

/** 无锁读当前应用状态（阶段 1 判断用；阶段 2 以 FOR UPDATE 双检为准）。 */
async function readAppliedPlain(
  db: Kysely<DatabaseSchema>,
  seedKey: string,
): Promise<AppliedState | null> {
  const { readAppliedForUpdate } = await import('./state.js');
  const rows = await sql<{
    seed_key: string;
    version: string;
    state: string;
  }>`
    SELECT seed_key, version, state FROM seed_applied WHERE seed_key = ${seedKey}
  `.execute(db);
  if (rows.rows.length === 0) return null;
  const row = rows.rows[0]!;
  return {
    seedKey: row.seed_key,
    version: row.version,
    state: row.state as AppliedState['state'],
    appliedAt: new Date(0),
    withdrawnAt: null,
    appliedBy: null,
    manifest: null,
  };
}

export interface AdoptOptions {
  readonly version: string;
  readonly by: string;
}

/** 认领存量数据：把前缀下现有行登记为指定版本（无版本记录时可用）。 */
export async function adoptSeed(
  runtime: DatabaseRuntime,
  manifest: Manifest,
  options: AdoptOptions,
): Promise<{ version: string; adoptedRows: number }> {
  return createUnitOfWork(runtime.db, { isolationLevel: 'read committed' }).execute(
    async ({ transaction }) => {
      const current = await readAppliedForUpdate(transaction, manifest.key);
      if (current) {
        throw new SeedError('already_registered', `seed「${manifest.key}」已有登记（版本 ${current.version}，state=${current.state}）。`);
      }
      let adoptedRows = 0;
      for (const spec of manifest.tables) {
        const rows = await selectPks(transaction, spec);
        await registerRows(transaction, manifest.key, options.version, rows);
        adoptedRows += rows.length;
      }
      if (adoptedRows === 0) {
        throw new SeedError('nothing_to_adopt', '前缀下无存量数据可认领。');
      }
      await writeApplied(transaction, manifest.key, options.version, options.by, manifest);
      await recordHistory(transaction, manifest.key, options.version, 'applied', options.by, manifest);
      return { version: options.version, adoptedRows };
    },
  );
}
