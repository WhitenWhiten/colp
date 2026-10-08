import { sql, type Kysely, type Migration } from 'kysely';

/**
 * ADR-0021 / 02 §4.2 expand-only: durable coarse authorization-cache version
 * on collections. Membership/invite bumps it in the same FOR UPDATE
 * transaction as policy_revision. Mutation still re-checks the authoritative
 * policy revision under the collection row lock; this column is not a second
 * authority. N-1 binaries ignore the column.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Earlier migrations in the same Migrator transaction may have queued
  // DEFERRABLE INITIALLY DEFERRED constraint-trigger events on collections.
  // DISABLE TRIGGER is itself ALTER TABLE and fails with pending events.
  await sql`SET CONSTRAINTS ALL IMMEDIATE`.execute(db);
  await sql`ALTER TABLE collections DISABLE TRIGGER USER`.execute(db);
  await sql`
    ALTER TABLE collections
      ADD COLUMN authz_cache_version bigint NOT NULL DEFAULT 0
      CONSTRAINT collections_authz_cache_version_non_negative CHECK (authz_cache_version >= 0)
  `.execute(db);
  await sql`ALTER TABLE collections ENABLE TRIGGER USER`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`SET CONSTRAINTS ALL IMMEDIATE`.execute(db);
  await sql`ALTER TABLE collections DISABLE TRIGGER USER`.execute(db);
  await sql`ALTER TABLE collections DROP COLUMN IF EXISTS authz_cache_version`.execute(db);
  await sql`ALTER TABLE collections ENABLE TRIGGER USER`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
