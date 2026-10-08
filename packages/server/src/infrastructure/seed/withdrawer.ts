import { sql, type Kysely } from 'kysely';
import type { Manifest } from './manifest.js';
import { SeedError } from './manifest.js';
import type { AppliedState } from './state.js';
import { pkMatchLhsSql, readAppliedForUpdate } from './state.js';
import { buildExclusion, liveCondition, prefixCount, scalarCount } from './helpers.js';
import { createUnitOfWork } from '../database/unit-of-work.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { DatabaseRuntime } from '../database/runtime.js';

export interface WithdrawOptions {
  readonly allowCascade: boolean;
  readonly cleanDangling: boolean;
  readonly by: string;
  /** Optional atomic report-cache invalidation seam; invoked in this transaction. */
  readonly reportSourceInvalidation?: {
    append(transaction: DatabaseTransaction, input: { readonly domainEventId: string; readonly collectionId: string; readonly sourceEventType: string; readonly sourceEventVersion: number; readonly contentRevision: string; readonly policyRevision: string; readonly commitOrdinal: bigint }): Promise<void>;
  };
}

export interface WithdrawReport {
  version: string;
  cascade: Array<{ label: string; count: number }>;
  restrict: Array<{ label: string; count: number }>;
  dangling: Array<{ label: string; count: number; cleaned: boolean }>;
  auto: Array<{ label: string; count: number }>;
  /** Permanent facts left in place (parents are soft-deleted, FKs stay valid). */
  retained: Array<{ label: string; count: number }>;
  deletedRows: number;
  /** 撤回后各表前缀计数（业务行混入前缀时 > 0，仅告警）。 */
  tableCounts: Record<string, number>;
}

/** 按登记行软删（UPDATE deleted_at；nodes/collections 等系统只允许软删的表）。 */
function buildSoftDeleteSql(
  seedKey: string,
  version: string,
  table: string,
  pkColumns: readonly string[],
  deletedAtColumn: string,
): string {
  const picks = pkColumns.map((_, index) => `r.pk->>${index}`).join(', ');
  const lhs = pkMatchLhsSql(pkColumns);
  return `UPDATE ${table} SET ${deletedAtColumn} = now(), updated_at = now()`
    + ` WHERE ${lhs} IN (SELECT ${picks} FROM seed_rows r WHERE r.seed_key = '${seedKey}'`
    + ` AND r.version = '${version}' AND r.table_name = '${table}')`
    + ` AND ${deletedAtColumn} IS NULL`;
}

/**
 * Canonical sidecar 墓碑：必须写 deleted_commit_ordinal（CHECK），且不得改 updated_at
 * （relations.payload_json->>'updatedAt' 必须等于列值）。活关联会阻止 nodes 软删。
 */
function buildSidecarTombstoneSql(
  seedKey: string,
  version: string,
  table: string,
  pkColumns: readonly string[],
  deletedAtColumn: string,
  deletedCommitOrdinalColumn: string,
): string {
  const picks = pkColumns.map((_, index) => `r.pk->>${index}`).join(', ');
  const lhs = pkMatchLhsSql(pkColumns);
  return `UPDATE ${table} SET ${deletedAtColumn} = now(), ${deletedCommitOrdinalColumn} = GREATEST(1, (`
    + `SELECT c.commit_ordinal FROM collections c WHERE c.id = ${table}.collection_id))`
    + ` WHERE ${lhs} IN (SELECT ${picks} FROM seed_rows r WHERE r.seed_key = '${seedKey}'`
    + ` AND r.version = '${version}' AND r.table_name = '${table}')`
    + ` AND ${deletedAtColumn} IS NULL`;
}

/** 按登记行删除某张表（seed_rows 子查询取主键，pk jsonb 数组按 pkColumns 顺序展开）。 */
function buildDeleteSql(
  seedKey: string,
  version: string,
  table: string,
  pkColumns: readonly string[],
): string {
  const picks = pkColumns.map((_, index) => `r.pk->>${index}`).join(', ');
  // 单列主键用标量 IN；复合主键用行值 IN（(c1,c2) IN (SELECT ...)）。
  // 左侧 ::text 与 r.pk->>n 对齐（publication_insight_daily.day 为 date）。
  const lhs = pkMatchLhsSql(pkColumns);
  return `DELETE FROM ${table} WHERE ${lhs} IN (`
    + `SELECT ${picks} FROM seed_rows r WHERE r.seed_key = '${seedKey}'`
    + ` AND r.version = '${version}' AND r.table_name = '${table}')`;
}

function affectedRows(result: { numAffectedRows?: number | bigint }): number {
  return Number(result.numAffectedRows ?? 0);
}

/**
 * accounts 硬删会触发 credit_account_delete_guard：账本行存在时必须先释放
 * reserved charge、把 status 置 deleted，再按账户设置 known.credits_account_delete。
 * 该 GUC 一次只能对准一个账户，不能走 seed_rows 批量 DELETE。
 */
async function deleteSeedAccount(tr: DatabaseTransaction, accountId: string): Promise<number> {
  const ledger = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM credit_accounts WHERE account_id = ${accountId}
  `.execute(tr);
  if (Number(ledger.rows[0]?.n ?? 0) === 0) {
    const result = await sql`DELETE FROM accounts WHERE id = ${accountId}`.execute(tr) as unknown as {
      numAffectedRows?: number | bigint;
    };
    return affectedRows(result);
  }
  await sql`SELECT credit_lock_account(${accountId}, true)`.execute(tr);
  const reserved = await sql<{ id: string }>`
    SELECT id::text AS id FROM credit_charges
    WHERE account_id = ${accountId} AND state = 'reserved'
  `.execute(tr);
  for (const charge of reserved.rows) {
    await sql`
      SELECT credit_finish(${accountId}, ${charge.id}::uuid, false, 'classification_cancelled')
    `.execute(tr);
  }
  await sql`
    UPDATE accounts SET status = 'deleted', deleted_at = now() WHERE id = ${accountId}
  `.execute(tr);
  await sql`SELECT set_config('known.credits_account_delete', ${accountId}, true)`.execute(tr);
  const result = await sql`DELETE FROM accounts WHERE id = ${accountId}`.execute(tr) as unknown as {
    numAffectedRows?: number | bigint;
  };
  return affectedRows(result);
}

async function deleteRegisteredAccounts(
  tr: DatabaseTransaction,
  seedKey: string,
  version: string,
): Promise<number> {
  const present = await sql<{ exists: boolean }>`
    SELECT to_regclass('credit_accounts') IS NOT NULL AS exists
  `.execute(tr);
  if (present.rows[0]?.exists !== true) {
    const result = await sql.raw(
      buildDeleteSql(seedKey, version, 'accounts', ['id']),
    ).execute(tr) as unknown as { numAffectedRows?: number | bigint };
    return affectedRows(result);
  }
  const ids = await sql<{ id: string }>`
    SELECT r.pk->>0 AS id FROM seed_rows r
    WHERE r.seed_key = ${seedKey} AND r.version = ${version} AND r.table_name = 'accounts'
  `.execute(tr);
  let deleted = 0;
  for (const row of ids.rows) deleted += await deleteSeedAccount(tr, row.id);
  return deleted;
}

/**
 * 撤回核心（事务内调用，供显式撤回与换版复用）：
 * 1) 引用预检：restrict 无 --allow-cascade 时中止；有则删除未登记残留。
 *    cascade 类需 allowCascade 否则中止；dangling 类报告/清理；
 * 2) 按 seed_rows 登记精确删除（withdraw_order 顺序）；
 * 3) 清理登记、状态置 withdrawn、写审计。
 */
export async function withdrawCore(
  tr: DatabaseTransaction,
  manifest: Manifest,
  current: AppliedState,
  options: WithdrawOptions,
): Promise<WithdrawReport> {
  const seedCollections = options.reportSourceInvalidation
    ? await sql<{ id: string; content_revision: string; policy_revision: string; commit_ordinal: bigint }>`
      SELECT c.id, c.content_revision, c.policy_revision, c.commit_ordinal
      FROM collections c JOIN seed_rows r ON r.table_name = 'collections' AND r.seed_key = ${manifest.key} AND r.version = ${current.version}
      WHERE c.id = (r.pk->>0)
    `.execute(tr)
    : { rows: [] };
  const report: WithdrawReport = {
    version: current.version,
    cascade: [],
    restrict: [],
    dangling: [],
    auto: [],
    retained: [],
    deletedRows: 0,
    tableCounts: {},
  };

  // 1) 引用预检（排除 seed 自身登记行）
  for (const check of manifest.referenceChecks) {
    const exclusion = buildExclusion(manifest, check.table, current.version);
    const count = await scalarCount(
      tr,
      `SELECT count(*) FROM ${check.table} t WHERE (${check.condition}) ${exclusion}`,
    );
    if (count === 0) continue;
    if (check.kind === 'retain') {
      // operations / revisions are append-only ledgers guarded by
      // `operations_permanent`; any real use of the demo stack leaves rows here.
      // Their collections are only soft-deleted, so leaving them is consistent
      // and the only option — a DELETE would abort the whole withdrawal.
      report.retained.push({ label: check.label, count });
      continue;
    }
    if (check.kind === 'auto') {
      report.auto.push({ label: check.label, count });
      if (typeof check.cleanSql === 'string') {
        await sql.raw(check.cleanSql).execute(tr);
      }
      continue;
    }
    if (check.kind === 'restrict') {
      if (!options.allowCascade) {
        report.restrict.push({ label: check.label, count });
        throw new SeedError(
          'reference_restrict',
          `撤回被 RESTRICT 引用阻止：${check.label}（${count} 条）。请先处理这些业务数据再重试。`,
        );
      }
      // 收藏夹是软删：未登记成员/邀请/洞察不会随 seed_rows 删除，必须先清掉，
      // 否则换版后 prefix 计数会多出业务残留。known-ctrl 只有显式 --allow-cascade 才会走到这里。
      await sql.raw(
        `DELETE FROM ${check.table} t WHERE (${check.condition}) ${exclusion}`,
      ).execute(tr);
      report.cascade.push({ label: `${check.label}（未登记残留）`, count });
      continue;
    }
    if (check.kind === 'cascade') {
      report.cascade.push({ label: check.label, count });
      if (!options.allowCascade) {
        throw new SeedError(
          'reference_cascade',
          `存在将被级联删除的业务引用：${check.label}（${count} 条）。`
          + `确认可接受后加 --allow-cascade 重试。`,
        );
      }
    }
    if (check.kind === 'dangling') {
      const cleaned = options.cleanDangling && typeof check.cleanSql === 'string';
      if (cleaned) {
        await sql.raw(check.cleanSql!).execute(tr);
      }
      report.dangling.push({ label: check.label, count, cleaned });
    }
  }

  // 2) 按登记精确撤回（manifest.withdrawOrder = FK 依赖逆序）
  //    有 deletedAtColumn 的表（collections/nodes）走软删：系统设计只允许软删
  //    （nodes 有 sync tombstone 触发器吞硬删；collections 被 20+ RESTRICT 引用），
  //    软删不触碰任何外键，行保留 deleted_at 标记，注入时由 injector 复活。
  //    collections 必须先于 nodes：nodes 软删会触发 live_node_count 去 UPDATE
  //    collections；若 collection 仍存活，延迟根生命周期校验会看到已删 root。
  for (const table of manifest.withdrawOrder) {
    const spec = manifest.tables.find((item) => item.table === table)!;
    if (spec.deletedAtColumn && spec.deletedCommitOrdinalColumn) {
      const result = await sql.raw(
        buildSidecarTombstoneSql(
          manifest.key,
          current.version,
          table,
          spec.pkColumns,
          spec.deletedAtColumn,
          spec.deletedCommitOrdinalColumn,
        ),
      ).execute(tr) as unknown as { numAffectedRows?: number | bigint };
      report.deletedRows += Number(result.numAffectedRows ?? 0);
    } else if (spec.deletedAtColumn) {
      const result = await sql.raw(
        buildSoftDeleteSql(manifest.key, current.version, table, spec.pkColumns, spec.deletedAtColumn),
      ).execute(tr) as unknown as { numAffectedRows?: number | bigint };
      report.deletedRows += affectedRows(result);
    } else if (table === 'accounts') {
      report.deletedRows += await deleteRegisteredAccounts(tr, manifest.key, current.version);
    } else {
      const result = await sql.raw(
        buildDeleteSql(manifest.key, current.version, table, spec.pkColumns),
      ).execute(tr) as unknown as { numAffectedRows?: number | bigint };
      report.deletedRows += affectedRows(result);
    }
  }

  // 3) 状态 + 审计（保留 seed_rows 登记：软删行需在下次注入时按登记复活）
  await sql`
    UPDATE seed_applied SET state = 'withdrawn', withdrawn_at = now()
    WHERE seed_key = ${manifest.key} AND state = 'applied'
  `.execute(tr);
  if (options.reportSourceInvalidation) for (const row of seedCollections.rows) await options.reportSourceInvalidation.append(tr, {
    domainEventId: `seed-withdrawal:${manifest.key}:${current.version}:${row.id}`,
    collectionId: row.id,
    sourceEventType: 'seed.withdrawal', sourceEventVersion: 1,
    contentRevision: row.content_revision, policyRevision: row.policy_revision,
    commitOrdinal: BigInt(row.commit_ordinal),
  });
  await sql`
    INSERT INTO seed_applied_history (seed_key, version, event, occurred_at, by, manifest)
    VALUES (${manifest.key}, ${current.version}, 'withdrawn', now(), ${options.by}, ${JSON.stringify(manifest)}::jsonb)
  `.execute(tr);

  // 4) 前缀残留告警（软删表统计活行；业务行混入前缀时提示，不阻断）
  for (const spec of manifest.tables) {
    const count = await prefixCount(tr, spec.table, spec.prefixSql, liveCondition(spec));
    report.tableCounts[spec.table] = count;
    if (count > 0) {
      process.stderr.write(`WARN: 撤回后 ${spec.table} 前缀下仍有 ${count} 活行（业务数据或残留，未处理）\n`);
    }
  }
  return report;
}

/** 显式撤回入口（独立事务，repeatable read）。 */
export async function withdrawSeed(
  runtime: DatabaseRuntime,
  manifest: Manifest,
  options: WithdrawOptions,
): Promise<WithdrawReport> {
  return createUnitOfWork(runtime.db, { isolationLevel: 'read committed' }).execute(
    async ({ transaction }) => {
      const current = await readAppliedForUpdate(transaction, manifest.key);
      if (!current || current.state !== 'applied') {
        throw new SeedError('nothing_applied', `seed「${manifest.key}」没有已应用版本可撤回。`);
      }
      return withdrawCore(transaction, manifest, current, options);
    },
  );
}
