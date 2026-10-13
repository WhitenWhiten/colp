import { sql, type Kysely } from 'kysely';

/** BE-3, appended after the actual 202610300900 head. No Events tables. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE automation_execution_policies (
      id text PRIMARY KEY, owner_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      current_revision bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(owner_id,id)
    );
    CREATE TABLE automation_execution_policy_revisions (
      policy_id text NOT NULL REFERENCES automation_execution_policies(id) ON DELETE CASCADE,
      revision bigint NOT NULL CHECK(revision>0), configuration_json jsonb NOT NULL,
      PRIMARY KEY(policy_id,revision)
    );
    CREATE TRIGGER automation_policy_revision_immutable BEFORE UPDATE OR DELETE ON automation_execution_policy_revisions
      FOR EACH ROW EXECUTE FUNCTION automation_revision_immutable();
    ALTER TABLE automation_execution_policies ADD CONSTRAINT automation_policy_current
      FOREIGN KEY(id,current_revision) REFERENCES automation_execution_policy_revisions(policy_id,revision) DEFERRABLE INITIALLY DEFERRED;
    CREATE TABLE automation_job_attempts (
      job_id text NOT NULL REFERENCES automation_jobs(id) ON DELETE CASCADE, generation bigint NOT NULL CHECK(generation>0),
      executor_id text NOT NULL, principal_binding text NOT NULL, claim_token_hash text NOT NULL,
      lease_until timestamptz NOT NULL, outcome text NOT NULL CHECK(outcome IN ('leased','knownRetryable','permanent','unknownOutcome','submitted')),
      provider_request_ref text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(job_id,generation)
    );
    CREATE INDEX automation_attempt_lease ON automation_job_attempts(lease_until) WHERE outcome='leased';
    CREATE TABLE automation_results (
      id text PRIMARY KEY, job_id text NOT NULL REFERENCES automation_jobs(id) ON DELETE CASCADE,
      generation bigint NOT NULL, owner_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      input_digest text NOT NULL, contract_id text NOT NULL, authority_digest text NOT NULL,
      output_json jsonb NOT NULL, proposal_digest text NOT NULL, status text NOT NULL CHECK(status IN ('proposed','accepted','rejected')),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(job_id,input_digest,contract_id),
      FOREIGN KEY(job_id,generation) REFERENCES automation_job_attempts(job_id,generation)
    );
    CREATE INDEX automation_result_reuse ON automation_results(owner_id,input_digest,contract_id,authority_digest) WHERE status='accepted';
    CREATE TABLE automation_usage_reservations (
      job_id text PRIMARY KEY REFERENCES automation_jobs(id) ON DELETE CASCADE,
      owner_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, rule_id text NOT NULL REFERENCES automation_rules(id),
      run_id text NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE, target_id text NOT NULL,
      day date NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX automation_reservation_day ON automation_usage_reservations(day,rule_id,run_id);
    CREATE TABLE automation_usage_counters (
      owner_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, rule_id text NOT NULL REFERENCES automation_rules(id),
      target_id text NOT NULL, day date NOT NULL, calls integer NOT NULL DEFAULT 0 CHECK(calls>=0),
      reported_cost_micros bigint NOT NULL DEFAULT 0 CHECK(reported_cost_micros>=0), unknown_cost_calls integer NOT NULL DEFAULT 0 CHECK(unknown_cost_calls>=0),
      PRIMARY KEY(owner_id,rule_id,target_id,day)
    );
  `.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE automation_usage_counters,automation_usage_reservations,automation_results,automation_job_attempts;
    ALTER TABLE automation_execution_policies DROP CONSTRAINT automation_policy_current;
    DROP TABLE automation_execution_policy_revisions,automation_execution_policies`.execute(db);
}
