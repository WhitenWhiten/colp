import { sql, type Kysely } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

/**
 * seed_applied / seed_applied_history / seed_rows 三张版本权威表的读写。
 * 全部语句在调用方提供的事务内执行（注入/撤回整体单事务，含行锁防并发）。
 */

export interface AppliedState {
  readonly seedKey: string;
  readonly version: string;
  readonly state: 'applied' | 'withdrawn';
  readonly appliedAt: Date;
  readonly withdrawnAt: Date | null;
  readonly appliedBy: string | null;
  readonly manifest: unknown;
}

export interface RegisteredRow {
  readonly table: string;
  readonly pk: string[];
}

/** 读当前应用状态（FOR UPDATE 行锁，串行化并发注入/撤回）。无记录返回 null。 */
export async function readAppliedForUpdate(
  tr: DatabaseTransaction,
  seedKey: string,
): Promise<AppliedState | null> {
  const rows = await sql<{
    seed_key: string;
    version: string;
    state: string;
    applied_at: Date;
    withdrawn_at: Date | null;
    applied_by: string | null;
    manifest: unknown;
  }>`
    SELECT seed_key, version, state, applied_at, withdrawn_at, applied_by, manifest
    FROM seed_applied WHERE seed_key = ${seedKey} FOR UPDATE
  `.execute(tr);
  if (rows.rows.length === 0) return null;
  const row = rows.rows[0]!;
  return {
    seedKey: row.seed_key,
    version: row.version,
    state: row.state as AppliedState['state'],
    appliedAt: row.applied_at,
    withdrawnAt: row.withdrawn_at,
    appliedBy: row.applied_by,
    manifest: row.manifest,
  };
}

/** 写入/更新已应用版本（防重与换版的判定落点）。 */
export async function writeApplied(
  tr: DatabaseTransaction,
  seedKey: string,
  version: string,
  appliedBy: string,
  manifest: unknown,
): Promise<void> {
  await sql`
    INSERT INTO seed_applied (seed_key, version, state, applied_at, withdrawn_at, applied_by, manifest)
    VALUES (${seedKey}, ${version}, 'applied', now(), NULL, ${appliedBy}, ${JSON.stringify(manifest)}::jsonb)
    ON CONFLICT (seed_key) DO UPDATE SET
      version = EXCLUDED.version,
      state = 'applied',
      applied_at = now(),
      withdrawn_at = NULL,
      applied_by = EXCLUDED.applied_by,
      manifest = EXCLUDED.manifest
  `.execute(tr);
}

/** 标记已撤回（state='withdrawn' + withdrawn_at；同时清理该版本的 seed_rows 登记）。 */
export async function markWithdrawn(tr: DatabaseTransaction, seedKey: string): Promise<void> {
  await sql`
    UPDATE seed_applied SET state = 'withdrawn', withdrawn_at = now()
    WHERE seed_key = ${seedKey} AND state = 'applied'
  `.execute(tr);
}

/** 追加审计事件（只增不改）。 */
export async function recordHistory(
  tr: DatabaseTransaction,
  seedKey: string,
  version: string,
  event: 'applied' | 'withdrawn',
  appliedBy: string,
  manifest: unknown,
): Promise<void> {
  await sql`
    INSERT INTO seed_applied_history (seed_key, version, event, occurred_at, by, manifest)
    VALUES (${seedKey}, ${version}, ${event}, now(), ${appliedBy}, ${JSON.stringify(manifest)}::jsonb)
  `.execute(tr);
}

/** 批量登记注入行（pk 为按 manifest.pk_columns 顺序的主键值数组）。 */
export async function registerRows(
  tr: DatabaseTransaction,
  seedKey: string,
  version: string,
  rows: readonly RegisteredRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const values = rows.map((row) => {
    const pkJson = JSON.stringify(row.pk).replace(/'/g, "''");
    return `('${seedKey}', '${version}', '${row.table}', '${pkJson}'::jsonb)`;
  });
  const result = await sql.raw(
    `INSERT INTO seed_rows (seed_key, version, table_name, pk) VALUES ${values.join(', ')}`,
  ).execute(tr) as unknown as { numInsertedOrUpdatedRows?: number | bigint };
  return Number(result.numInsertedOrUpdatedRows ?? 0);
}

/** 删除某版本某表的全部登记行（撤回按登记精确删除的原料）。 */
export async function deleteRegisteredRows(
  tr: DatabaseTransaction,
  seedKey: string,
  version: string,
  table: string,
): Promise<void> {
  await sql`
    DELETE FROM seed_rows WHERE seed_key = ${seedKey} AND version = ${version} AND table_name = ${table}
  `.execute(tr);
}

/** 当前版本的登记行总数。 */
export async function countRegisteredRows(
  tr: DatabaseTransaction,
  seedKey: string,
  version: string,
): Promise<number> {
  const result = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM seed_rows WHERE seed_key = ${seedKey} AND version = ${version}
  `.execute(tr);
  return result.rows[0]!.n;
}

/**
 * 按 manifest 的 pkColumns 构造 jsonb 主键数组的 SQL 表达式。
 * 一律 `::text`：date/bigint 等非文本主键登记为 JSON 字符串，才能与
 * `r.pk->>n`（永远是 text）以及 `pkMatchLhsSql` 对齐。
 */
export function pkArraySql(columns: readonly string[]): string {
  return `jsonb_build_array(${columns.map((column) => `t.${column}::text`).join(', ')})`;
}

/** DELETE/UPDATE … WHERE pk IN (SELECT r.pk->>…) 的左侧：列一律 text，避免 date=text。 */
export function pkMatchLhsSql(columns: readonly string[]): string {
  const casts = columns.map((column) => `${column}::text`);
  return columns.length === 1 ? casts[0]! : `(${casts.join(', ')})`;
}
