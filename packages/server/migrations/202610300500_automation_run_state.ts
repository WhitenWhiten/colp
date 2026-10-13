import { sql, type Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_runs ADD COLUMN explanation_json jsonb NOT NULL DEFAULT '{}',
    ADD COLUMN held boolean NOT NULL DEFAULT false, ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
    CREATE UNIQUE INDEX automation_active_generation ON automation_activations(rule_revision_id, collection_id)
      WHERE disabled_after_ordinal IS NULL`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX automation_active_generation;
    ALTER TABLE automation_runs DROP COLUMN explanation_json, DROP COLUMN held, DROP COLUMN revision, DROP COLUMN updated_at`.execute(db);
}
