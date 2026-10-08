import { sql, type Kysely } from 'kysely';

/**
 * E4: per-client MCP approval policy. A missing row means manual.
 * Policy receipts remember the pre-commit collection version used by Undo.
 * `collection_tree_versions.cause` is added by G5
 * (`202610230100_collection_version_cause`). The agent-plan shape of that
 * check is `202610230200_agent_plan_version_cause`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE agent_policies (
      client_id text PRIMARY KEY,
      policy text NOT NULL CHECK (policy IN ('manual', 'trusted')),
      updated_at timestamptz NOT NULL DEFAULT current_timestamp
    )
  `.execute(db);
  await sql`
    CREATE TABLE mcp_plan_policy_receipts (
      plan_id text PRIMARY KEY,
      client_id text NOT NULL,
      approved_by text NOT NULL CHECK (approved_by = 'policy'),
      version_id text NOT NULL,
      collection_id text NOT NULL,
      cause text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT current_timestamp
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS mcp_plan_policy_receipts`.execute(db);
  await sql`DROP TABLE IF EXISTS agent_policies`.execute(db);
}
