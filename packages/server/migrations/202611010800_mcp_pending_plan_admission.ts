import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX mcp_change_plans_pending_owner_expiry
    ON mcp_change_plans (principal_id, expires_at, client_id)
    WHERE status IN ('pending', 'approved', 'committing')`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX mcp_change_plans_pending_owner_expiry`.execute(db);
}
