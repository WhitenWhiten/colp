import { sql, type Kysely } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { Manifest, TableSpec } from './manifest.js';
import type { RegisteredRow } from './state.js';
import { pkArraySql } from './state.js';

/** 前缀计数：SELECT count(*) FROM t WHERE (<prefixSql>) [AND extra]（注入校验/存量探测/撤回告警共用）。
 * prefixSql 含 OR 时必须加括号，否则 `OR … AND deleted_at IS NULL` 会把软删行算进活行。 */
export async function prefixCount(
  tr: DatabaseTransaction,
  table: string,
  prefixSql: string,
  extraCondition = '',
): Promise<number> {
  const result = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM ${sql.raw(table)} t
    WHERE (${sql.raw(prefixSql)})${sql.raw(extraCondition ? ` AND ${extraCondition}` : '')}
  `.execute(tr);
  return result.rows[0]!.n;
}

/** 软删表的活行条件（deleted_at IS NULL）。 */
export function liveCondition(spec: { readonly deletedAtColumn?: string }): string {
  return spec.deletedAtColumn ? `${spec.deletedAtColumn} IS NULL` : '';
}

/** 单值计数：执行任意返回单行单列的校验/预检 SQL。 */
export async function scalarCount(tr: DatabaseTransaction, query: string): Promise<number> {
  const result = await sql.raw(query).execute(tr);
  const rows = result.rows as Array<Record<string, unknown>>;
  if (rows.length !== 1) throw new Error(`scalarCount 期望 1 行，实际 ${rows.length} 行：${query.slice(0, 120)}`);
  const first = Object.values(rows[0]!)[0];
  const n = Number(first);
  if (!Number.isInteger(n)) throw new Error(`scalarCount 非整数结果：${String(first)}`);
  return n;
}

/** 读取某表前缀下全部行的主键（pk jsonb 数组，按 manifest.pkColumns 顺序）。 */
export async function selectPks(
  tr: DatabaseTransaction,
  spec: TableSpec,
): Promise<RegisteredRow[]> {
  const result = await sql.raw(
    `SELECT ${pkArraySql(spec.pkColumns)} AS pk FROM ${spec.table} t WHERE (${spec.prefixSql})`,
  ).execute(tr);
  return (result.rows as Array<{ pk: unknown[] }>).map((row) => ({
    table: spec.table,
    pk: (row.pk as unknown[]).map(String),
  }));
}

/**
 * 注入前后主键差集 = 本次实际插入行（REPEATABLE READ 快照下精确；
 * ON CONFLICT DO NOTHING 跳过的行不会进入差集，正确）。
 */
export function diffPks(before: ReadonlySet<string>, after: ReadonlySet<string>): string[] {
  return [...after].filter((pk) => !before.has(pk));
}

/** 主键集合指纹：JSON 序列化数组。 */
export function pkFingerprint(pk: readonly string[]): string {
  return JSON.stringify(pk);
}

/** 预检排除子句：排除 seed 自身登记行（按当前版本）。表不在 tables 登记范围时返回空串。 */
export function buildExclusion(
  manifest: Manifest,
  table: string,
  version: string,
): string {
  const spec = manifest.tables.find((item) => item.table === table);
  if (!spec) return '';
  const pkExpr = pkArraySql(spec.pkColumns);
  return ` AND NOT EXISTS (SELECT 1 FROM seed_rows r WHERE r.seed_key = '${manifest.key}'`
    + ` AND r.version = '${version}' AND r.table_name = '${table}' AND r.pk = ${pkExpr})`;
}
