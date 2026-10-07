import { sql, type Kysely, type Migration } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE bookmark_preferences (
      account_id text PRIMARY KEY REFERENCES accounts(id) ON DELETE RESTRICT,
      bookmark_insert_position text NOT NULL DEFAULT 'bottom'
        CHECK (bookmark_insert_position IN ('top', 'bottom')),
      folders_first boolean NOT NULL DEFAULT true,
      revision text NOT NULL CHECK (revision ~ '^[1-9][0-9]{0,18}$' AND length(revision) BETWEEN 1 AND 19),
      updated_at timestamptz NOT NULL
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS bookmark_preferences`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
