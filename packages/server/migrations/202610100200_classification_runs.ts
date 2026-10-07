import { sql,type Kysely } from 'kysely';

export async function up(db:Kysely<unknown>):Promise<void>{
  await sql`CREATE TABLE collection_classification_runs (
    id text PRIMARY KEY,collection_id text NOT NULL REFERENCES collections(id),
    principal_id text NOT NULL REFERENCES accounts(id),owner_subject_id text NOT NULL REFERENCES accounts(subject_id),
    command_id text NOT NULL,command_scope text NOT NULL,revision bigint NOT NULL DEFAULT 1,
    status text NOT NULL CHECK(status IN ('queued','running','open','applied','failed','cancelled','expired')),
    failure_code text CHECK(failure_code IN ('stale_snapshot','configuration_changed','all_actions_failed')),
    taxonomy_revision text NOT NULL,settings_revision text NOT NULL,profile_revision text,
    provider_id text NOT NULL,model text NOT NULL,policy_version text NOT NULL,prompt_version text NOT NULL,candidate_version text NOT NULL,
    snapshot_json jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),deadline_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
    FOREIGN KEY(principal_id,command_scope,command_id) REFERENCES product_command_receipts(principal_id,command_scope,command_id) ON DELETE CASCADE,
    UNIQUE(principal_id,command_scope,command_id),CHECK(revision>0),CHECK(status NOT IN ('queued','running') OR snapshot_json IS NOT NULL),CHECK(deadline_at>created_at AND expires_at>deadline_at)
  )`.execute(db);
  await sql`CREATE INDEX classification_runs_active_deadline ON collection_classification_runs(deadline_at)
    WHERE status IN ('queued','running')`.execute(db);
  await sql`CREATE INDEX classification_runs_expiry ON collection_classification_runs(expires_at) WHERE snapshot_json IS NOT NULL`.execute(db);
  await sql`CREATE TABLE collection_classification_run_actions (
    run_id text NOT NULL REFERENCES collection_classification_runs(id) ON DELETE CASCADE,action_id text NOT NULL,
    ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 49),node_id text NOT NULL REFERENCES nodes(id),node_etag text NOT NULL,
    source_parent_id text NOT NULL REFERENCES nodes(id),execution_command_id text NOT NULL UNIQUE,
    status text NOT NULL CHECK(status IN ('pending','running','succeeded','failed')),
    decision_json jsonb,failure_code text CHECK(failure_code IN ('provider_timeout','provider_unavailable','contract_drift','outcome_unknown',
      'budget_exhausted','context_limit','deadline_exceeded','cancelled')),
    PRIMARY KEY(run_id,action_id),UNIQUE(run_id,ordinal),UNIQUE(run_id,node_id),
    CHECK((status='succeeded')=(decision_json IS NOT NULL)),CHECK((status='failed')=(failure_code IS NOT NULL))
  )`.execute(db);
  await sql`CREATE TABLE collection_classification_run_jobs (
    run_id text PRIMARY KEY REFERENCES collection_classification_runs(id) ON DELETE CASCADE,
    state text NOT NULL CHECK(state IN ('pending','running','complete')),generation bigint NOT NULL DEFAULT 0,
    lease_until timestamptz,available_at timestamptz NOT NULL DEFAULT clock_timestamp(),attempts integer NOT NULL DEFAULT 0,
    CHECK((state='running')=(lease_until IS NOT NULL)),CHECK(generation>=0 AND attempts>=0)
  )`.execute(db);
  await sql`CREATE INDEX classification_run_jobs_due ON collection_classification_run_jobs(available_at) WHERE state<>'complete'`.execute(db);
}
export async function down(db:Kysely<unknown>):Promise<void>{
  await sql`DROP TABLE collection_classification_run_jobs,collection_classification_run_actions,collection_classification_runs`.execute(db);
}
