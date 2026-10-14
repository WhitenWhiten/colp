import { sql,type Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE automation_manual_previews (
    id text PRIMARY KEY,owner_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    rule_id text NOT NULL REFERENCES automation_rules(id),digest text NOT NULL,
    snapshot_json jsonb NOT NULL,result_json jsonb NOT NULL,expires_at timestamptz NOT NULL,
    run_id text REFERENCES automation_runs(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
  );
  CREATE INDEX automation_manual_preview_expiry ON automation_manual_previews(owner_id,expires_at);
  CREATE FUNCTION automation_manual_preview_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF (to_jsonb(NEW)-'run_id') IS DISTINCT FROM (to_jsonb(OLD)-'run_id') OR OLD.run_id IS NOT NULL THEN
      RAISE EXCEPTION 'Manual preview is immutable'; END IF; RETURN NEW;
  END $$;
  CREATE TRIGGER automation_manual_preview_immutable BEFORE UPDATE ON automation_manual_previews
    FOR EACH ROW EXECUTE FUNCTION automation_manual_preview_immutable();
  CREATE INDEX automation_manual_children ON automation_runs((explanation_json->>'parentRunId')) WHERE kind='manual';`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX automation_manual_children;DROP TABLE automation_manual_previews;DROP FUNCTION automation_manual_preview_immutable()`.execute(db);
}
