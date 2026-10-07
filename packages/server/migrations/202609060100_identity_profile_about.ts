import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Expand-only Profile self-introduction (`about`).
 *
 * Existing rows receive the empty-string default. N-1 binaries ignore the
 * new column; readers and writers that understand it land after this
 * migration. The CHECK matches the application `ABOUT_MAX = 2000` bound.
 *
 * Application rollback leaves the column installed. The `down` path drops
 * stored about text and is developer-only, not a data-preserving rollback.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE profiles
      ADD COLUMN about text NOT NULL DEFAULT '',
      ADD CONSTRAINT profiles_about_length CHECK (length(about) <= 2000)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE profiles
      DROP CONSTRAINT IF EXISTS profiles_about_length,
      DROP COLUMN IF EXISTS about
  `.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
