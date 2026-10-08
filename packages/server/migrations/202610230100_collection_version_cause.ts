import { sql, type Kysely, type Migration } from 'kysely';

/**
 * G5: why a collection version was written.
 * Existing rows are web. Sync, restore, undo, and agent plans set their own cause.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE "collection_tree_versions"
      ADD COLUMN "cause" text NOT NULL DEFAULT 'web'
  `.execute(db);
  await sql`
    ALTER TABLE "collection_tree_versions"
      ADD CONSTRAINT "collection_tree_versions_cause_check"
      CHECK ("cause" IN ('web', 'sync', 'agent-plan', 'restore', 'undo'))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE "collection_tree_versions" DROP CONSTRAINT IF EXISTS "collection_tree_versions_cause_check"`.execute(db);
  await sql`ALTER TABLE "collection_tree_versions" DROP COLUMN IF EXISTS "cause"`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
