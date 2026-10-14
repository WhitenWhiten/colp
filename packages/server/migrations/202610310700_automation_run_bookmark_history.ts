import { sql, type Kysely } from 'kysely';
/** Per-bookmark run history (run-store.ts list): single-bookmark runs by nodeId, batch runs by any member. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX automation_run_bookmark ON automation_runs(owner_id,(explanation_json->>'nodeId'));
    CREATE INDEX automation_run_batch_members ON automation_runs USING gin((explanation_json->'memberSources') jsonb_path_ops)`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX automation_run_batch_members; DROP INDEX automation_run_bookmark`.execute(db);
}
