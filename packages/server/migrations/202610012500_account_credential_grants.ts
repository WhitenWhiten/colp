import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE account_credential_grants (
      id text PRIMARY KEY,
      credential_id text NOT NULL REFERENCES account_credentials(id),
      owner_account_id text NOT NULL REFERENCES accounts(id),
      resource_kind text NOT NULL CHECK (resource_kind IN ('collection', 'report')),
      resource_id text NOT NULL CHECK (char_length(resource_id) BETWEEN 1 AND 128),
      actions_json jsonb NOT NULL,
      state text NOT NULL CHECK (state IN ('active', 'revoked')),
      revision bigint NOT NULL CHECK (revision >= 1),
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      revoked_at timestamptz,
      revoke_reason text CHECK (revoke_reason IS NULL OR char_length(revoke_reason) BETWEEN 1 AND 500),
      CHECK ((state = 'revoked' AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
          OR (state = 'active' AND revoked_at IS NULL AND revoke_reason IS NULL))
    )
  `.execute(db);
  await sql`CREATE INDEX account_credential_grants_owner_created_idx
    ON account_credential_grants (owner_account_id, created_at, id)`.execute(db);
  await sql`CREATE INDEX account_credential_grants_credential_idx
    ON account_credential_grants (credential_id, created_at, id)`.execute(db);
  await sql`
    CREATE TABLE account_credential_plan_authorizations (
      plan_kind text NOT NULL CHECK (plan_kind IN ('collection', 'report')),
      plan_id text NOT NULL,
      grant_id text NOT NULL REFERENCES account_credential_grants(id),
      grant_revision bigint NOT NULL CHECK (grant_revision >= 1),
      credential_id text NOT NULL REFERENCES account_credentials(id),
      plan_digest text NOT NULL CHECK (char_length(plan_digest) = 51),
      authorized_at timestamptz NOT NULL,
      PRIMARY KEY (plan_kind, plan_id)
    )
  `.execute(db);
  await sql`
    CREATE TABLE mcp_report_plans (
      plan_id text PRIMARY KEY,
      principal_id text NOT NULL,
      client_id text NOT NULL,
      operations_digest text NOT NULL,
      status text NOT NULL,
      approval_status text NOT NULL,
      expires_at timestamptz NOT NULL,
      plan_json jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      updated_at timestamptz NOT NULL DEFAULT current_timestamp
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE mcp_report_plans`.execute(db);
  await sql`DROP TABLE account_credential_plan_authorizations`.execute(db);
  await sql`DROP TABLE account_credential_grants`.execute(db);
}
