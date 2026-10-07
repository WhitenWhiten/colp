import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TableSpec {
  readonly table: string;
  readonly pkColumns: readonly string[];
  readonly prefixSql: string;
  readonly expectedRows: number;
  /** 软删列（如 deleted_at）：撤回走 UPDATE 软删（系统只允许 nodes/collections 软删），计数仅统计活行。 */
  readonly deletedAtColumn?: string;
  /**
   * Canonical sidecar 墓碑列（annotations/relations 的 deleted_commit_ordinal）。
   * 与 deletedAtColumn 同时出现：撤回时写入墓碑且不碰 updated_at（payload_authority 约束）；
   * 复活时两列一起清空。resource_id_ledger 不可变，不能硬删后再经 ports 重建预定 ID。
   */
  readonly deletedCommitOrdinalColumn?: string;
  /**
   * 注入阶段（B3）：'sql' 表由 data.sql 创建；'auth' 表由 auth 阶段脚本
   * （manifest.authScript）通过已验证 seed port 创建（BA user/account/credential/
   * session metadata）。两者都纳入同一 seed ledger（seed_rows）、namespace、
   * expectedRows 与 withdraw order；撤回顺序：先 auth sessions/metadata，
   * 再 mapping/auth accounts/users，最后业务 accounts。
   */
  readonly phase?: 'sql' | 'auth';
}

export interface PostCheck {
  readonly sql: string;
  readonly expected: number;
  readonly label: string;
}

/**
 * - cascade: business rows that will be deleted with the seed (needs --allow-cascade)
 * - restrict: business rows that block withdrawal unless --allow-cascade deletes them
 * - dangling: orphan rows cleaned by cleanSql with --clean-dangling
 * - auto: always cleaned by cleanSql
 * - retain: permanent facts (operations, revisions) that reference seed rows.
 *   They are counted and reported but never deleted and never block: their
 *   parents are only soft-deleted, so the foreign keys stay valid, and the
 *   database refuses DELETE on them anyway (`operations_permanent`).
 */
export interface ReferenceCheck {
  readonly kind: 'cascade' | 'restrict' | 'dangling' | 'auto' | 'retain';
  readonly table: string;
  readonly label: string;
  readonly condition: string;
  readonly cleanSql?: string;
}

export interface Manifest {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly namespace: readonly string[];
  readonly tables: readonly TableSpec[];
  readonly withdrawOrder: readonly string[];
  readonly postChecks: readonly PostCheck[];
  readonly referenceChecks: readonly ReferenceCheck[];
  /** 数据包目录（含 manifest.json 与 data.sql），加载时注入。 */
  readonly seedDir: string;
  /**
   * auth 阶段脚本文件名（B3，如 'auth.ts'）：在 data.sql 事务提交后执行，
   * 用已验证 seed port 创建 BA user/account/credential/session metadata。
   * 脚本是仓库代码（imports src 表面），从仓库 seed/<key>/ 目录解析，
   * 不从数据包拷贝目录解析。
   */
  readonly authScript?: string;
}

export class SeedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SeedError';
    this.code = code;
  }
}

function asStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new SeedError('invalid_manifest', `manifest.${field} 必须是非空字符串数组`);
  }
  return value as string[];
}

function asTableSpecs(value: unknown): TableSpec[] {
  if (!Array.isArray(value)) throw new SeedError('invalid_manifest', 'manifest.tables 必须是数组');
  return value.map((item) => {
    const row = item as Record<string, unknown>;
    if (typeof row.table !== 'string' || typeof row.prefixSql !== 'string'
      || typeof row.expectedRows !== 'number' || !Array.isArray(row.pkColumns)) {
      throw new SeedError('invalid_manifest', `manifest.tables[].${String(row.table)} 字段不完整`);
    }
    const spec: TableSpec = {
      table: row.table,
      pkColumns: asStringList(row.pkColumns, `tables[].${String(row.table)}.pkColumns`),
      prefixSql: row.prefixSql,
      expectedRows: row.expectedRows,
      deletedAtColumn: typeof row.deletedAtColumn === 'string' ? row.deletedAtColumn : undefined,
      deletedCommitOrdinalColumn: typeof row.deletedCommitOrdinalColumn === 'string'
        ? row.deletedCommitOrdinalColumn
        : undefined,
      phase: row.phase === 'auth' ? 'auth' : 'sql',
    };
    if (spec.deletedCommitOrdinalColumn && !spec.deletedAtColumn) {
      throw new SeedError(
        'invalid_manifest',
        `manifest.tables[].${spec.table} 声明 deletedCommitOrdinalColumn 时必须同时声明 deletedAtColumn`,
      );
    }
    return spec;
  });
}

/** 读取并校验 seed 数据包 manifest.json。 */
export function loadManifest(seedDir: string): Manifest {
  const manifestPath = join(seedDir, 'manifest.json');
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch {
    throw new SeedError('manifest_not_found', `找不到 seed manifest：${manifestPath}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new SeedError('invalid_manifest', `manifest.json 不是合法 JSON：${manifestPath}`);
  }
  const rawKey = typeof parsed.key === 'string' && parsed.key.length > 0 ? parsed.key : 'demo';
  const manifest: Manifest = {
    key: rawKey,
    name: typeof parsed.name === 'string' ? parsed.name : rawKey,
    description: typeof parsed.description === 'string' ? parsed.description : '',
    namespace: asStringList(parsed.namespace ?? [], 'namespace'),
    tables: asTableSpecs(parsed.tables ?? []),
    withdrawOrder: asStringList(parsed.withdrawOrder ?? [], 'withdrawOrder'),
    postChecks: Array.isArray(parsed.postChecks) ? (parsed.postChecks as Record<string, unknown>[]).map((item) => ({
      sql: String(item.sql),
      expected: Number(item.expected),
      label: String(item.label),
    })) : [],
    referenceChecks: Array.isArray(parsed.referenceChecks)
      ? (parsed.referenceChecks as Record<string, unknown>[]).map((item) => ({
          kind: item.kind as ReferenceCheck['kind'],
          table: String(item.table),
          label: String(item.label),
          condition: String(item.condition),
          cleanSql: typeof item.cleanSql === 'string' ? item.cleanSql : undefined,
        }))
      : [],
    seedDir,
    authScript: typeof parsed.authScript === 'string' && parsed.authScript.length > 0
      ? parsed.authScript
      : undefined,
  };
  const registered = new Set(manifest.tables.map((spec) => spec.table));
  for (const table of manifest.withdrawOrder) {
    if (!registered.has(table)) {
      throw new SeedError('invalid_manifest', `withdrawOrder 含未登记表：${table}`);
    }
  }
  if (manifest.authScript !== undefined && authPhaseTables(manifest).length === 0) {
    throw new SeedError('invalid_manifest', 'manifest.authScript 声明了 auth 阶段，但 tables 中没有 phase="auth" 的表');
  }
  if (manifest.authScript === undefined && authPhaseTables(manifest).length > 0) {
    throw new SeedError('invalid_manifest', 'manifest.tables 含 phase="auth" 的表，但未声明 manifest.authScript');
  }
  for (const check of manifest.referenceChecks) {
    if (!['cascade', 'restrict', 'dangling', 'auto', 'retain'].includes(check.kind)) {
      throw new SeedError('invalid_manifest', `referenceChecks 非法 kind：${check.kind}`);
    }
  }
  return manifest;
}

/** 定位 seed 数据包目录：SEED_DIR 直接指向含 manifest.json 的目录（如 /app/seed/demo）。 */
export function resolveSeedDir(seedRoot: string, seedKey: string): string {
  return join(seedRoot, seedKey);
}

/** 数据包内 data.sql 路径。 */
export function dataSqlPath(seedDir: string): string {
  return join(seedDir, 'data.sql');
}

/** data.sql 阶段登记的表（phase 缺省为 'sql'）。 */
export function sqlPhaseTables(manifest: Manifest): readonly TableSpec[] {
  return manifest.tables.filter((spec) => spec.phase !== 'auth');
}

/** auth 阶段脚本登记的表（BA user/account/mapping/session metadata）。 */
export function authPhaseTables(manifest: Manifest): readonly TableSpec[] {
  return manifest.tables.filter((spec) => spec.phase === 'auth');
}
