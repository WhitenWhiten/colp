import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE account_credentials (
      id text PRIMARY KEY,
      kind text NOT NULL CHECK (kind IN ('parent', 'child')),
      parent_id text REFERENCES account_credentials(id),
      account_id text NOT NULL REFERENCES accounts(id),
      subject_id text NOT NULL,
      manager_account_id text NOT NULL REFERENCES accounts(id),
      label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
      prefix text NOT NULL UNIQUE CHECK (char_length(prefix) BETWEEN 1 AND 32),
      secret_hash text NOT NULL UNIQUE CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
      state text NOT NULL CHECK (state IN ('active', 'revoked')),
      revision bigint NOT NULL CHECK (revision >= 1),
      epoch bigint NOT NULL CHECK (epoch >= 1),
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      last_used_at timestamptz,
      revoked_at timestamptz,
      revoke_reason text CHECK (revoke_reason IS NULL OR char_length(revoke_reason) BETWEEN 1 AND 500),
      mcp_client_id text NOT NULL UNIQUE CHECK (mcp_client_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
      CHECK ((kind = 'parent' AND parent_id IS NULL) OR (kind = 'child' AND parent_id IS NOT NULL)),
      CHECK ((state = 'revoked' AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
          OR (state = 'active' AND revoked_at IS NULL AND revoke_reason IS NULL))
    )
  `.execute(db);
  await sql`CREATE INDEX account_credentials_manager_created_idx
    ON account_credentials (manager_account_id, created_at, id)`.execute(db);
  await sql`CREATE INDEX account_credentials_parent_created_idx
    ON account_credentials (parent_id, created_at, id) WHERE parent_id IS NOT NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE account_credentials`.execute(db);
}
