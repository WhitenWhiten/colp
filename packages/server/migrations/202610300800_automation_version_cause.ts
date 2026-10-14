import { sql, type Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE collection_tree_versions DROP CONSTRAINT collection_tree_versions_cause_check;
    ALTER TABLE collection_tree_versions ADD CONSTRAINT collection_tree_versions_cause_check CHECK (
      cause IN ('web','sync','agent-plan','restore','undo') OR (cause LIKE 'agent-plan:%' AND length(cause) BETWEEN 12 AND 268)
      OR cause ~ '^automation:[A-Za-z0-9._~-]{1,128}$')`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE collection_tree_versions DROP CONSTRAINT collection_tree_versions_cause_check;
    ALTER TABLE collection_tree_versions ADD CONSTRAINT collection_tree_versions_cause_check CHECK (
      cause IN ('web','sync','agent-plan','restore','undo') OR (cause LIKE 'agent-plan:%' AND length(cause) BETWEEN 12 AND 268))`.execute(db);
}
