import { sql, type Kysely, type Migration } from 'kysely';

/**
 * U-5: durable keyset checkpoint for restore_sources item generation.
 *
 * The job row is inserted with this checkpoint in the policy transaction.
 * Pages of `favicon_source_restores` advance `cursor_node_id`; a short page
 * sets `scan_complete`. Gap inserts are separate and are not cursored, so a
 * restore row that appears behind the cursor is still eligible.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE favicon_restore_scans (
      job_id           uuid PRIMARY KEY REFERENCES favicon_jobs(id) ON DELETE CASCADE,
      account_id       text NOT NULL,
      cursor_node_id   text,
      scan_complete    boolean NOT NULL DEFAULT false,
      updated_at       timestamptz NOT NULL
    )
  `.execute(db);
  await sql`
    CREATE INDEX favicon_source_restores_account_node_idx
      ON favicon_source_restores (account_id, node_id)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS favicon_source_restores_account_node_idx`.execute(db);
  await sql`DROP TABLE IF EXISTS favicon_restore_scans`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
