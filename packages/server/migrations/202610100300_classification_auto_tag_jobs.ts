import { sql,type Kysely } from 'kysely';
export async function up(db:Kysely<unknown>):Promise<void>{
  await sql`ALTER TABLE collection_classification_settings DROP CONSTRAINT collection_classification_settings_auto_tag_mode_check,
    ADD CONSTRAINT collection_classification_settings_auto_tag_mode_check CHECK(auto_tag_mode IN ('off','suggest','auto'))`.execute(db);
  await sql`CREATE TABLE collection_classification_tag_jobs (
    id text PRIMARY KEY,collection_id text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,node_id text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    source_operation_id text NOT NULL UNIQUE REFERENCES operations(operation_id) ON DELETE CASCADE,resource_revision text NOT NULL,
    owner_subject_id text NOT NULL REFERENCES accounts(subject_id),principal_id text NOT NULL REFERENCES accounts(id),
    settings_revision text NOT NULL,profile_id text,profile_revision text,
    provider_id text NOT NULL,model text NOT NULL,model_version text NOT NULL,policy_version text NOT NULL,prompt_version text NOT NULL,candidate_version text NOT NULL,
    execution_command_id text NOT NULL UNIQUE,recompute_command_id text NOT NULL UNIQUE,apply_command_id text NOT NULL UNIQUE,
    recomputations integer NOT NULL DEFAULT 0 CHECK(recomputations BETWEEN 0 AND 1),
    outbox_id text UNIQUE REFERENCES outbox_events(outbox_id) ON DELETE SET NULL,
    status text NOT NULL CHECK(status IN ('pending','running','applied','skipped','obsolete','failed','outcome_unknown')),
    failure_code text,selected_tag_count integer NOT NULL DEFAULT 0 CHECK(selected_tag_count BETWEEN 0 AND 3),selected_tag_digest text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,completed_at timestamptz,
    UNIQUE(node_id,resource_revision),CHECK(expires_at>created_at)
  )`.execute(db);
}
export async function down(db:Kysely<unknown>):Promise<void>{
  await sql`DROP TABLE collection_classification_tag_jobs`.execute(db);
  // A downgrade refuses to erase an opted-in auto policy; operators must disable it first.
  await sql`ALTER TABLE collection_classification_settings DROP CONSTRAINT collection_classification_settings_auto_tag_mode_check,
    ADD CONSTRAINT collection_classification_settings_auto_tag_mode_check CHECK(auto_tag_mode IN ('off','suggest'))`.execute(db);
}
