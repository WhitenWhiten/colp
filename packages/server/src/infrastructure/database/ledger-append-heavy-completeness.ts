import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { LEDGER_CAPACITY_TARGETS } from './ledger-capacity.js';

export const APPEND_HEAVY_COMMENT_TOKEN = 'known.append_heavy=true';

export type AppendHeavyCompletenessCode =
  | 'unregistered_append_heavy_table'
  | 'registered_table_missing_comment';

export interface AppendHeavyCompletenessIssue {
  readonly code: AppendHeavyCompletenessCode;
  readonly tableName: string;
}

const COMMENT_PATTERN = /COMMENT\s+ON\s+TABLE\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s+IS\s+'([^']*)'/giu;

export function parseAppendHeavyCommentedTables(source: string): readonly string[] {
  const tables = new Set<string>();
  for (const match of source.matchAll(COMMENT_PATTERN)) {
    if (match[2]!.includes(APPEND_HEAVY_COMMENT_TOKEN)) tables.add(match[1]!);
  }
  return Object.freeze([...tables].sort((left, right) => left.localeCompare(right, 'en')));
}

export function diffAppendHeavyCompleteness(
  commentedTables: readonly string[],
  registeredTables: readonly string[] = LEDGER_CAPACITY_TARGETS.map((target) => target.tableName),
): readonly AppendHeavyCompletenessIssue[] {
  const commented = new Set(commentedTables);
  const registered = new Set(registeredTables);
  const issues: AppendHeavyCompletenessIssue[] = [];
  for (const tableName of [...commented].sort((left, right) => left.localeCompare(right, 'en'))) {
    if (!registered.has(tableName)) {
      issues.push({ code: 'unregistered_append_heavy_table', tableName });
    }
  }
  for (const tableName of [...registered].sort((left, right) => left.localeCompare(right, 'en'))) {
    if (!commented.has(tableName)) {
      issues.push({ code: 'registered_table_missing_comment', tableName });
    }
  }
  return Object.freeze(issues);
}

export function collectMigrationAppendHeavyComments(migrationDirectory: string): readonly string[] {
  const tables = new Set<string>();
  for (const file of readdirSync(migrationDirectory).sort()) {
    if (!file.endsWith('.ts')) continue;
    for (const table of parseAppendHeavyCommentedTables(
      readFileSync(resolve(migrationDirectory, file), 'utf8'),
    )) {
      tables.add(table);
    }
  }
  return Object.freeze([...tables].sort((left, right) => left.localeCompare(right, 'en')));
}

export function defaultMigrationDirectory(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
}

export async function inspectAppendHeavyCompleteness(
  pool: Pool,
): Promise<readonly AppendHeavyCompletenessIssue[]> {
  const result = await pool.query<{ table_name: string }>(`
    SELECT class.relname AS table_name
      FROM pg_class class
      JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
      JOIN pg_description description
        ON description.objoid = class.oid AND description.objsubid = 0
     WHERE namespace.nspname = current_schema()
       AND class.relkind IN ('r', 'p')
       AND position($1 in description.description) > 0
     ORDER BY class.relname COLLATE "C"
  `, [APPEND_HEAVY_COMMENT_TOKEN]);
  return diffAppendHeavyCompleteness(result.rows.map((row) => row.table_name));
}
