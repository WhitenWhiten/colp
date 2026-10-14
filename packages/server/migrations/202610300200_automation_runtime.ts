import { sql, type Kysely } from 'kysely';
/** M1 storage contracts only. BE-1 installs no facts producer, admission or effect executor. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE automation_event_facts (
      source_event_id text PRIMARY KEY, operation_id text NOT NULL REFERENCES operations(operation_id),
      collection_id text NOT NULL REFERENCES collections(id), node_id text NOT NULL,
      commit_ordinal bigint NOT NULL, occurred_at timestamptz NOT NULL, origin text NOT NULL,
      facts_json jsonb NOT NULL, facts_version integer NOT NULL CHECK (facts_version > 0), root_run_id text
    );
    CREATE INDEX automation_facts_collection_ordinal ON automation_event_facts(collection_id, commit_ordinal);
    CREATE TABLE automation_intake_receipts (
      id text PRIMARY KEY, owner_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      device_id text NOT NULL, replica_generation bigint NOT NULL, local_receipt_id text NOT NULL, operation_id text NOT NULL,
      state text NOT NULL CHECK (state IN ('waitingForSync','accepted','review','rejected')), receipt_json jsonb NOT NULL,
      UNIQUE (device_id, replica_generation, local_receipt_id)
    );
    CREATE INDEX automation_intake_operation ON automation_intake_receipts(operation_id, state);
    CREATE TABLE automation_source_positions (
      owner_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, collection_id text NOT NULL REFERENCES collections(id),
      last_inspected_ordinal bigint NOT NULL CHECK (last_inspected_ordinal >= 0), PRIMARY KEY (owner_id, collection_id)
    );
    CREATE TABLE automation_aggregate_state (
      rule_revision_id text NOT NULL REFERENCES automation_rule_revisions(id), epoch bigint NOT NULL,
      partition_key text NOT NULL, sequence bigint NOT NULL, remainder_json jsonb NOT NULL,
      PRIMARY KEY (rule_revision_id, epoch, partition_key)
    );
    CREATE TABLE automation_runs (
      id text PRIMARY KEY, owner_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      kind text NOT NULL CHECK (kind IN ('intake','batch','manual')), rule_revision_id text NOT NULL REFERENCES automation_rule_revisions(id),
      binding_set_id text NOT NULL, binding_revision bigint NOT NULL, policy_revision text,
      member_ids jsonb NOT NULL, state text NOT NULL CHECK (state IN ('waiting','running','completed','partial','review','blocked','cancelled','failed')),
      created_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (binding_set_id, binding_revision) REFERENCES automation_binding_revisions(binding_set_id, revision)
    );
    CREATE INDEX automation_run_owner_time ON automation_runs(owner_id, created_at, id);
    CREATE TABLE automation_admission_receipts (
      rule_revision_id text NOT NULL REFERENCES automation_rule_revisions(id), source_event_id text NOT NULL REFERENCES automation_event_facts(source_event_id),
      stage text NOT NULL, decision text NOT NULL, run_id text REFERENCES automation_runs(id),
      PRIMARY KEY (rule_revision_id, source_event_id, stage)
    );
    CREATE TABLE automation_jobs (
      id text PRIMARY KEY, run_id text NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE, task_id text NOT NULL,
      target_id text, target_partition text NOT NULL DEFAULT '__m1__', input_digest text NOT NULL, contract_id text NOT NULL,
      state text NOT NULL CHECK (state IN ('pending','ready','leased','committing','succeeded','awaitingApproval','uncertain','blocked','failed','stale','review')),
      active_generation bigint NOT NULL DEFAULT 0, result_id text,
      CHECK (target_partition = COALESCE(target_id, '__m1__')), UNIQUE (run_id, task_id, target_partition)
    );
    CREATE INDEX automation_job_ready ON automation_jobs(target_partition, state, id);
    CREATE TABLE automation_effect_receipts (
      id text PRIMARY KEY, run_id text NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
      job_id text REFERENCES automation_jobs(id), step_id text NOT NULL, target_partition text NOT NULL DEFAULT '__m1__',
      plan_id text, operation_id text NOT NULL REFERENCES operations(operation_id), before_folder jsonb,
      before_revision text, after_revision text NOT NULL, effect_digest text NOT NULL,
      UNIQUE (run_id, step_id, target_partition)
    );
    CREATE TABLE automation_device_bundles (
      owner_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, device_id text NOT NULL,
      revision bigint NOT NULL, profile text NOT NULL, digest text NOT NULL, issued_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
      paused boolean NOT NULL, settings_revision bigint NOT NULL, status text NOT NULL,
      PRIMARY KEY (owner_id, device_id, revision)
    );
    CREATE TABLE automation_tag_rejections (
      owner_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, rule_id text NOT NULL REFERENCES automation_rules(id),
      tag_key text NOT NULL, rejected_at timestamptz NOT NULL, PRIMARY KEY (rule_id, tag_key)
    );
  `.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE automation_tag_rejections, automation_device_bundles, automation_effect_receipts,
    automation_jobs, automation_admission_receipts, automation_runs, automation_aggregate_state,
    automation_source_positions, automation_intake_receipts, automation_event_facts`.execute(db);
}
