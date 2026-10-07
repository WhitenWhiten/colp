import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Expand nodes with Product NodeVisibility (inherit | protected | private).
 * Expand-only: existing rows default to inherit; readers without the column ignore it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE nodes
    ADD COLUMN visibility text NOT NULL DEFAULT 'inherit'`.execute(db);
  await sql`ALTER TABLE nodes
    ADD CONSTRAINT nodes_visibility_check
      CHECK (visibility IN ('inherit', 'protected', 'private'))`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE nodes
    DROP CONSTRAINT IF EXISTS nodes_visibility_check`.execute(db);
  await sql`ALTER TABLE nodes
    DROP COLUMN IF EXISTS visibility`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
