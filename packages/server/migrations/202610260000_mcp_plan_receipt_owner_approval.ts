import { sql, type Kysely } from 'kysely';

/**
 * Every committed agent plan now keeps its pre-commit collection version,
 * not only plans a trusted policy auto-approved. A plan the owner approved
 * records `approved_by = 'owner'` so its Undo works the same way.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE mcp_plan_policy_receipts
      DROP CONSTRAINT mcp_plan_policy_receipts_approved_by_check
  `.execute(db);
  await sql`
    ALTER TABLE mcp_plan_policy_receipts
      ADD CONSTRAINT mcp_plan_policy_receipts_approved_by_check
      CHECK (approved_by IN ('policy', 'owner'))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM mcp_plan_policy_receipts WHERE approved_by <> 'policy'`.execute(db);
  await sql`
    ALTER TABLE mcp_plan_policy_receipts
      DROP CONSTRAINT mcp_plan_policy_receipts_approved_by_check
  `.execute(db);
  await sql`
    ALTER TABLE mcp_plan_policy_receipts
      ADD CONSTRAINT mcp_plan_policy_receipts_approved_by_check
      CHECK (approved_by = 'policy')
  `.execute(db);
}
