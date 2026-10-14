import { sql, type Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE automation_budget_wakes (
    owner_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    collection_id text NOT NULL REFERENCES collections(id), available_at timestamptz NOT NULL,
    PRIMARY KEY(owner_id,collection_id,available_at)
  )`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE automation_budget_wakes`.execute(db);
}
