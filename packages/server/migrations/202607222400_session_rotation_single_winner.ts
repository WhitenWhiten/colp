import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Enforce at most one active successor per rotated predecessor (single-winner
 * session rotation). Application CAS revoke is the primary claim; this unique
 * index is the database belt-and-suspenders against concurrent mint forks.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE UNIQUE INDEX sessions_rotated_from_session_id_unique
      ON sessions (rotated_from_session_id)
      WHERE rotated_from_session_id IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS sessions_rotated_from_session_id_unique`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
