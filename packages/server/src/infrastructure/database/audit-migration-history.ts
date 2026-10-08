import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from './runtime.js';

const LEGACY_GUARD = '202610100900_digest_owner_membership_guard';
export const AUDIT_GUARD_REPLACEMENT = '202610101200_digest_owner_membership_guard';
const AUDIT_PREFIX_END = '202610100700_classification_credits';
// Exact names in 251b163d8 before its owner guard, not an arbitrary provider subset.
const AUDIT_PREFIX_HASH = '9c5d77b7ea12a5fec985ddac45ece62c6b2f59583e68265bb68c48e3eb822da6';

/** Caller holds Kysely's migration lock on this same physical connection. */
export async function bridgeAuditMigrationHistory(
  db: Kysely<DatabaseSchema>, providerNames: readonly string[], schema?: string,
): Promise<void> {
  if (!providerNames.includes(AUDIT_GUARD_REPLACEMENT) || providerNames.includes(LEGACY_GUARD)) return;
  if (schema && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) throw new Error('unsafe migration table schema');
  const name = schema ? `"${schema}"."kysely_migration"` : 'kysely_migration';
  const exists = await sql<{ present: boolean }>`SELECT to_regclass(${name}) IS NOT NULL AS present`.execute(db);
  if (!exists.rows[0]?.present) return;
  const table = schema ? sql.id(schema, 'kysely_migration') : sql.id('kysely_migration');
  const executed = (await sql<{ name: string }>`SELECT name FROM ${table}`.execute(db)).rows.map(row => row.name).sort();
  if (!executed.includes(LEGACY_GUARD)) return;
  const prefix = providerNames.filter(value => value <= AUDIT_PREFIX_END).sort();
  const expected = [...prefix, LEGACY_GUARD].sort();
  if (createHash('sha256').update(prefix.join('\n')).digest('hex') !== AUDIT_PREFIX_HASH
    || executed.length !== expected.length || executed.some((value, index) => value !== expected[index])) {
    throw new Error('unsupported audit migration history: refusing to rewrite an incomplete or divergent ledger');
  }
  // The old migration only installed an idempotent CREATE OR REPLACE guard and
  // had an empty down. Keep that physical protection; retire just its marker.
  // Strict migration ordering then applies ALL missing credits migrations and
  // reinstalls the same guard at the appended name, even after an interrupted upgrade.
  await sql`DELETE FROM ${table} WHERE name=${LEGACY_GUARD}`.execute(db);
}
