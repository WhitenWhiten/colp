import { sql, type Kysely } from 'kysely';

/**
 * E4 cause values are `agent-plan:<planId>`. G5 already added `cause` with a
 * closed enum that includes the literal `agent-plan`. Widen the check so both
 * shapes are accepted. Do not drop the column.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE collection_tree_versions DROP CONSTRAINT IF EXISTS collection_tree_versions_cause_check`.execute(db);
  await sql`
    ALTER TABLE collection_tree_versions
      ADD CONSTRAINT collection_tree_versions_cause_check CHECK (
        cause IN ('web', 'sync', 'agent-plan', 'restore', 'undo')
        OR (
          cause LIKE 'agent-plan:%'
          AND length(cause) BETWEEN 12 AND 268
        )
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE collection_tree_versions DROP CONSTRAINT IF EXISTS collection_tree_versions_cause_check`.execute(db);
  await sql`
    ALTER TABLE collection_tree_versions
      ADD CONSTRAINT collection_tree_versions_cause_check
      CHECK (cause IN ('web', 'sync', 'agent-plan', 'restore', 'undo'))
  `.execute(db);
}
