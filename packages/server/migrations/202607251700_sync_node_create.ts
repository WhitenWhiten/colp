import { sql, type Kysely, type Migration } from 'kysely';

/** P3-12 expand: make the canonical Node writer's Separator authority explicit. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_kind_check`.execute(db);
  await sql`ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_title_check`.execute(db);
  await sql`ALTER TABLE nodes ALTER COLUMN title DROP NOT NULL`.execute(db);
  await sql`ALTER TABLE nodes
    ADD CONSTRAINT nodes_kind_check CHECK (kind IN ('folder','bookmark','separator')),
    ADD CONSTRAINT nodes_title_check CHECK (
      (kind = 'separator' AND title IS NULL AND url IS NULL) OR
      (kind IN ('folder','bookmark') AND title IS NOT NULL AND length(title) BETWEEN 1 AND 512)
    )`.execute(db);
}

/** Developer-only destructive rollback: separator rows cannot survive the narrower schema. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM nodes WHERE kind = 'separator'`.execute(db);
  await sql`ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_kind_check`.execute(db);
  await sql`ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_title_check`.execute(db);
  await sql`ALTER TABLE nodes ALTER COLUMN title SET NOT NULL`.execute(db);
  await sql`ALTER TABLE nodes
    ADD CONSTRAINT nodes_kind_check CHECK (kind IN ('folder','bookmark')),
    ADD CONSTRAINT nodes_title_check CHECK (length(title) BETWEEN 1 AND 512)`.execute(db);
}

export const migration: Migration = { up, down };
