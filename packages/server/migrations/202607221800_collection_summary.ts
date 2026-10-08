import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Expand collections with Product summary (CreateCollectionRequest / CollectionView).
 * Expand-only: existing readers ignore the nullable column.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE collections
    ADD COLUMN summary text`.execute(db);
  await sql`ALTER TABLE collections
    ADD CONSTRAINT collections_summary_length
      CHECK (summary IS NULL OR length(summary) <= 2000)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE collections
    DROP CONSTRAINT IF EXISTS collections_summary_length`.execute(db);
  await sql`ALTER TABLE collections
    DROP COLUMN IF EXISTS summary`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
