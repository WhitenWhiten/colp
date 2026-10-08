import {sql,type Kysely} from 'kysely';
export async function up(db:Kysely<unknown>):Promise<void>{
  await sql`CREATE TABLE classification_provider_profiles (
    id text PRIMARY KEY,owner_subject_id text NOT NULL REFERENCES accounts(subject_id) ON DELETE CASCADE,
    label text NOT NULL,kind text NOT NULL CHECK(kind='cloudflare_ai_gateway'),protocol text NOT NULL CHECK(protocol='cloudflare_ai_run_v1'),
    model text NOT NULL CHECK(model='typesafe/jev'),config_json jsonb NOT NULL,secret_envelope jsonb,secret_fingerprint text,
    revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),status text NOT NULL CHECK(status IN ('active','disabled','test_failed')),
    last_tested_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(owner_subject_id,id),CHECK(status<>'active' OR secret_envelope IS NOT NULL)
  )`.execute(db);
  await sql`ALTER TABLE collection_classification_settings
    DROP CONSTRAINT collection_classification_settings_execution_mode_check,
    DROP CONSTRAINT collection_classification_settings_provider_profile_id_check,
    ADD CONSTRAINT classification_settings_mode_profile CHECK ((execution_mode='server_managed' AND provider_profile_id IS NULL) OR (execution_mode='server_byok' AND provider_profile_id IS NOT NULL)),
    ADD CONSTRAINT classification_settings_profile_fk FOREIGN KEY(owner_subject_id,provider_profile_id) REFERENCES classification_provider_profiles(owner_subject_id,id) ON DELETE RESTRICT`.execute(db);
  await sql`CREATE TABLE classification_profile_tests (
    id text PRIMARY KEY,principal_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,owner_subject_id text NOT NULL REFERENCES accounts(subject_id) ON DELETE CASCADE,
    profile_id text NOT NULL,profile_revision text NOT NULL,command_id text NOT NULL,fingerprint text NOT NULL,request_id text NOT NULL,
    state text NOT NULL CHECK(state IN ('pending','dispatching','succeeded','failed','outcome_unknown')),deadline_at timestamptz NOT NULL,
    dispatched_at timestamptz,completed_at timestamptz,reserved_microusd bigint NOT NULL DEFAULT 0,settled_microusd bigint,
    UNIQUE(principal_id,command_id)
  )`.execute(db);
  await sql`CREATE INDEX classification_profile_tests_pending ON classification_profile_tests(deadline_at) WHERE state IN ('pending','dispatching')`.execute(db);
}
export async function down(db:Kysely<unknown>):Promise<void>{
  await sql`ALTER TABLE collection_classification_settings DROP CONSTRAINT classification_settings_profile_fk,DROP CONSTRAINT classification_settings_mode_profile,
    ADD CONSTRAINT collection_classification_settings_execution_mode_check CHECK(execution_mode='server_managed'),
    ADD CONSTRAINT collection_classification_settings_provider_profile_id_check CHECK(provider_profile_id IS NULL)`.execute(db);
  await sql`DROP TABLE classification_profile_tests,classification_provider_profiles`.execute(db);
}
