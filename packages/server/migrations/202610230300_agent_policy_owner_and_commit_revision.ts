import { sql, type Kysely } from 'kysely';

/**
 * Agent policy belongs to one account. An OAuth client id (a CIMD URL) is
 * shared by every user of that client, so `client_id` alone let one owner's
 * `trusted` setting auto-approve another owner's plans. Existing rows have no
 * owner and are removed; a missing row is `manual`, the safe default.
 *
 * `mcp_plan_commit_revisions` records each collection's content revision
 * inside the plan's commit transaction. Undo compares it with the live
 * revision and refuses when anything else changed the collection afterwards.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM agent_policies`.execute(db);
  await sql`ALTER TABLE agent_policies ADD COLUMN principal_id text NOT NULL`.execute(db);
  await sql`ALTER TABLE agent_policies DROP CONSTRAINT agent_policies_pkey`.execute(db);
  await sql`ALTER TABLE agent_policies ADD PRIMARY KEY (principal_id, client_id)`.execute(db);
  await sql`
    CREATE TABLE mcp_plan_commit_revisions (
      plan_id text NOT NULL,
      collection_id text NOT NULL,
      content_revision text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      PRIMARY KEY (plan_id, collection_id)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS mcp_plan_commit_revisions`.execute(db);
  await sql`DELETE FROM agent_policies`.execute(db);
  await sql`ALTER TABLE agent_policies DROP CONSTRAINT agent_policies_pkey`.execute(db);
  await sql`ALTER TABLE agent_policies DROP COLUMN principal_id`.execute(db);
  await sql`ALTER TABLE agent_policies ADD PRIMARY KEY (client_id)`.execute(db);
}
