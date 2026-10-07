import { sql, type Kysely } from 'kysely';

/**
 * FRR-05: special-root uniqueness stays Collection-wide; `recovered` is unique
 * per live parent (owning mount or Collection-root fallback).
 *
 * Existing Recovered rows keep their ids and parents. Kysely runs PostgreSQL
 * migrations in one transaction — CREATE INDEX CONCURRENTLY is unavailable.
 * After this index exists, rolling back the old Collection-wide recovered
 * unique index is impossible once two live Recovered Folders exist.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS nodes_live_special_folder_role_uidx`.execute(db);
  await sql`
    CREATE UNIQUE INDEX nodes_live_special_folder_role_uidx
      ON nodes (collection_id, folder_role)
      WHERE deleted_at IS NULL
        AND folder_role IN ('bookmarks-bar','other-bookmarks','mobile-bookmarks')
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX nodes_live_recovered_parent_uidx
      ON nodes (collection_id, parent_id)
      WHERE deleted_at IS NULL
        AND folder_role = 'recovered'
        AND parent_id IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $guard$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM nodes
         WHERE deleted_at IS NULL AND folder_role = 'recovered'
         GROUP BY collection_id
         HAVING COUNT(*) > 1
      ) THEN
        RAISE EXCEPTION 'cannot restore collection-wide recovered uniqueness'
          USING ERRCODE = '23514';
      END IF;
    END
    $guard$;
  `.execute(db);
  await sql`DROP INDEX IF EXISTS nodes_live_recovered_parent_uidx`.execute(db);
  await sql`DROP INDEX IF EXISTS nodes_live_special_folder_role_uidx`.execute(db);
  await sql`
    CREATE UNIQUE INDEX nodes_live_special_folder_role_uidx
      ON nodes (collection_id, folder_role)
      WHERE deleted_at IS NULL
        AND folder_role IN ('bookmarks-bar','other-bookmarks','mobile-bookmarks','recovered')
  `.execute(db);
}
