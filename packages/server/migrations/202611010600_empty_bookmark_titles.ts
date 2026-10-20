import { sql, type Kysely, type Migration } from 'kysely';

/** Expand bookmark content only. Folders/collections retain their name requirement. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE nodes DROP CONSTRAINT nodes_title_check`.execute(db);
  await sql`ALTER TABLE nodes ADD CONSTRAINT nodes_title_check CHECK (
    (kind='separator' AND title IS NULL AND url IS NULL)
    OR (kind='folder' AND title IS NOT NULL AND length(title) BETWEEN 1 AND 512)
    OR (kind='bookmark' AND title IS NOT NULL AND length(title) BETWEEN 0 AND 512)
  )`.execute(db);
}

/** Preserve favicon-only content rather than renaming it during a downgrade. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM nodes WHERE kind='bookmark' AND title='') THEN
      RAISE EXCEPTION 'down refused: favicon-only bookmark titles require the expanded schema';
    END IF;
  END $$`.execute(db);
  await sql`ALTER TABLE nodes DROP CONSTRAINT nodes_title_check`.execute(db);
  await sql`ALTER TABLE nodes ADD CONSTRAINT nodes_title_check CHECK (
    (kind='separator' AND title IS NULL AND url IS NULL)
    OR (kind IN ('folder','bookmark') AND title IS NOT NULL AND length(title) BETWEEN 1 AND 512)
  )`.execute(db);
}

export const migration: Migration = { up, down };
