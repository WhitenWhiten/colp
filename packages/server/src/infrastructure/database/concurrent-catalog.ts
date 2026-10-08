/**
 * Concurrent multi-schema PostgreSQL test helpers.
 *
 * Kysely Migrator introspects every schema with USAGE privilege. Parallel
 * suites that DROP SCHEMA CASCADE can race that scan; `runMigrations` retries
 * when {@link isConcurrentCatalogRaceError} matches.
 */

/** True when a concurrent DROP SCHEMA / ALTER raced Kysely catalog introspection. */
export function isConcurrentCatalogRaceError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : '';
  // 42P01 undefined_table/relation, 3F000 invalid_schema_name, 42703 undefined_column
  if (code === '42P01' || code === '3F000' || code === '42703') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /does not exist/i.test(message)
    && /(schema|relation|column|table)/i.test(message);
}
