import { sql, type Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE classification_provider_executions (
    id text PRIMARY KEY, principal_id text NOT NULL, owner_subject_id text NOT NULL,
    collection_id text NOT NULL REFERENCES collections(id), command_scope text NOT NULL, command_id text NOT NULL,
    fingerprint text NOT NULL, request_id text NOT NULL, provider_id text NOT NULL, model text NOT NULL,
    policy_version text NOT NULL, prompt_version text NOT NULL, input_json jsonb,
    settings_revision text NOT NULL, content_revision text NOT NULL,
    state text NOT NULL CHECK (state IN ('pending','running','succeeded','failed','outcome_unknown')),
    generation bigint NOT NULL DEFAULT 0, lease_until timestamptz,
    deadline_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
    FOREIGN KEY(principal_id,command_scope,command_id) REFERENCES product_command_receipts(principal_id,command_scope,command_id) ON DELETE CASCADE,
    UNIQUE(principal_id,command_scope,command_id),
    CHECK (state NOT IN ('pending','running') OR input_json IS NOT NULL)
  )`.execute(db);
  await sql`CREATE INDEX classification_executions_due ON classification_provider_executions(state,deadline_at) WHERE state IN ('pending','running')`.execute(db);
  await sql`CREATE TABLE classification_call_attempts (
    execution_id text NOT NULL REFERENCES classification_provider_executions(id) ON DELETE CASCADE,
    stage text NOT NULL CHECK(stage IN ('l1','l2','tags')), chunk_index integer NOT NULL CHECK(chunk_index BETWEEN 0 AND 5),
    input_digest text NOT NULL, state text NOT NULL CHECK(state IN ('ready','dispatching','succeeded','failed','unknown')),
    attempt_number integer NOT NULL DEFAULT 0 CHECK(attempt_number BETWEEN 0 AND 1), result_json jsonb,
    reserved_microusd bigint NOT NULL DEFAULT 0, settled_microusd bigint,
    dispatched_at timestamptz, completed_at timestamptz,
    PRIMARY KEY(execution_id,stage,chunk_index)
  )`.execute(db);
  await sql`CREATE INDEX classification_calls_inflight ON classification_call_attempts(execution_id) WHERE state='dispatching'`.execute(db);
  await sql`CREATE TABLE classification_spend_budgets (
    day date NOT NULL, scope text NOT NULL, spent_microusd bigint NOT NULL CHECK(spent_microusd>=0),
    PRIMARY KEY(day,scope)
  )`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE classification_spend_budgets,classification_call_attempts,classification_provider_executions`.execute(db);
}
