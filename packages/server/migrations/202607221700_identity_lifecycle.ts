import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Expands Phase 0 identity tables for full Account/Profile/Session lifecycle.
 * Prefer a clean final session shape (idle + absolute expiry; no obsolete expires_at).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE accounts
    ADD COLUMN email text,
    ADD COLUMN security_epoch bigint NOT NULL DEFAULT 0`.execute(db);
  await sql`ALTER TABLE accounts
    ADD CONSTRAINT accounts_security_epoch_non_negative CHECK (security_epoch >= 0)`.execute(db);
  await sql`CREATE INDEX accounts_email_idx ON accounts(email) WHERE email IS NOT NULL`.execute(db);

  await sql`ALTER TABLE profiles
    ADD CONSTRAINT profiles_display_name_length CHECK (length(display_name) <= 120)`.execute(db);

  await sql`CREATE TABLE profile_handles (
    handle text PRIMARY KEY,
    account_id text NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT profile_handles_handle_length CHECK (length(handle) BETWEEN 1 AND 64)
  )`.execute(db);

  await sql`CREATE TABLE account_identities (
    id text PRIMARY KEY,
    account_id text NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    issuer text NOT NULL,
    subject text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT account_identities_issuer_subject_unique UNIQUE (issuer, subject),
    CONSTRAINT account_identities_issuer_length CHECK (length(issuer) BETWEEN 1 AND 2048),
    CONSTRAINT account_identities_subject_length CHECK (length(subject) BETWEEN 1 AND 512)
  )`.execute(db);
  // Phase 1: one OIDC identity binding per account.
  await sql`CREATE UNIQUE INDEX account_identities_account_id_unique
    ON account_identities(account_id)`.execute(db);

  await sql`ALTER TABLE sessions
    ADD COLUMN idle_expires_at timestamptz,
    ADD COLUMN absolute_expires_at timestamptz,
    ADD COLUMN csrf_token_hash text,
    ADD COLUMN token_hash text,
    ADD COLUMN security_epoch bigint,
    ADD COLUMN rotated_from_session_id text,
    ADD COLUMN last_seen_at timestamptz`.execute(db);

  // Phase 0 sessions are spike-only; backfill from legacy expires_at then drop it.
  await sql`UPDATE sessions SET
    idle_expires_at = expires_at,
    absolute_expires_at = expires_at,
    csrf_token_hash = COALESCE(csrf_token_hash, 'legacy-csrf-' || id),
    token_hash = COALESCE(token_hash, 'legacy-token-' || id),
    security_epoch = COALESCE(security_epoch, 0),
    last_seen_at = COALESCE(last_seen_at, created_at)`.execute(db);

  await sql`ALTER TABLE sessions
    ALTER COLUMN idle_expires_at SET NOT NULL,
    ALTER COLUMN absolute_expires_at SET NOT NULL,
    ALTER COLUMN csrf_token_hash SET NOT NULL,
    ALTER COLUMN token_hash SET NOT NULL,
    ALTER COLUMN security_epoch SET NOT NULL,
    ALTER COLUMN last_seen_at SET NOT NULL,
    ALTER COLUMN last_seen_at SET DEFAULT now()`.execute(db);

  await sql`ALTER TABLE sessions
    ADD CONSTRAINT sessions_security_epoch_non_negative CHECK (security_epoch >= 0),
    ADD CONSTRAINT sessions_idle_before_or_eq_absolute CHECK (idle_expires_at <= absolute_expires_at),
    ADD CONSTRAINT sessions_csrf_token_hash_length CHECK (length(csrf_token_hash) BETWEEN 1 AND 128),
    ADD CONSTRAINT sessions_token_hash_length CHECK (length(token_hash) BETWEEN 1 AND 128)`.execute(db);

  await sql`ALTER TABLE sessions
    ADD CONSTRAINT sessions_rotated_from_session_id_fkey
      FOREIGN KEY (rotated_from_session_id) REFERENCES sessions(id) ON DELETE SET NULL`.execute(db);

  await sql`ALTER TABLE sessions DROP COLUMN expires_at`.execute(db);

  await sql`CREATE UNIQUE INDEX sessions_token_hash_unique ON sessions(token_hash)`.execute(db);
  await sql`CREATE INDEX sessions_account_id_idx ON sessions(account_id)`.execute(db);
  await sql`CREATE INDEX sessions_idle_expires_at_idx ON sessions(idle_expires_at)
    WHERE revoked_at IS NULL`.execute(db);
  await sql`CREATE INDEX sessions_absolute_expires_at_idx ON sessions(absolute_expires_at)
    WHERE revoked_at IS NULL`.execute(db);

  await sql`CREATE TABLE oidc_login_transactions (
    state text PRIMARY KEY,
    nonce text NOT NULL,
    code_verifier text NOT NULL,
    return_to text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    code_challenge_method text NOT NULL DEFAULT 'S256',
    CONSTRAINT oidc_login_transactions_state_length CHECK (length(state) BETWEEN 16 AND 256),
    CONSTRAINT oidc_login_transactions_nonce_length CHECK (length(nonce) BETWEEN 16 AND 256),
    CONSTRAINT oidc_login_transactions_code_verifier_length CHECK (length(code_verifier) BETWEEN 43 AND 128),
    CONSTRAINT oidc_login_transactions_return_to_length CHECK (length(return_to) BETWEEN 1 AND 2048),
    CONSTRAINT oidc_login_transactions_challenge_method
      CHECK (code_challenge_method = 'S256')
  )`.execute(db);
  await sql`CREATE INDEX oidc_login_transactions_expires_at_idx
    ON oidc_login_transactions(expires_at)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS oidc_login_transactions`.execute(db);

  await sql`DROP INDEX IF EXISTS sessions_absolute_expires_at_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS sessions_idle_expires_at_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS sessions_account_id_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS sessions_token_hash_unique`.execute(db);

  await sql`ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_rotated_from_session_id_fkey`.execute(db);
  await sql`ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_token_hash_length`.execute(db);
  await sql`ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_csrf_token_hash_length`.execute(db);
  await sql`ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_idle_before_or_eq_absolute`.execute(db);
  await sql`ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_security_epoch_non_negative`.execute(db);

  await sql`ALTER TABLE sessions
    ADD COLUMN expires_at timestamptz`.execute(db);
  await sql`UPDATE sessions SET expires_at = COALESCE(idle_expires_at, absolute_expires_at, created_at)`.execute(db);
  await sql`ALTER TABLE sessions ALTER COLUMN expires_at SET NOT NULL`.execute(db);

  await sql`ALTER TABLE sessions
    DROP COLUMN IF EXISTS last_seen_at,
    DROP COLUMN IF EXISTS rotated_from_session_id,
    DROP COLUMN IF EXISTS security_epoch,
    DROP COLUMN IF EXISTS token_hash,
    DROP COLUMN IF EXISTS csrf_token_hash,
    DROP COLUMN IF EXISTS absolute_expires_at,
    DROP COLUMN IF EXISTS idle_expires_at`.execute(db);

  await sql`DROP INDEX IF EXISTS account_identities_account_id_unique`.execute(db);
  await sql`DROP TABLE IF EXISTS account_identities`.execute(db);
  await sql`DROP TABLE IF EXISTS profile_handles`.execute(db);

  await sql`ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_display_name_length`.execute(db);

  await sql`DROP INDEX IF EXISTS accounts_email_idx`.execute(db);
  await sql`ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_security_epoch_non_negative`.execute(db);
  await sql`ALTER TABLE accounts
    DROP COLUMN IF EXISTS security_epoch,
    DROP COLUMN IF EXISTS email`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
