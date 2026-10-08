import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Expand oidc_login_transactions for protected secrets (hash/encrypt rollout).
 *
 * Expand-only dual-write window:
 * - Keep plaintext state/nonce/code_verifier for N/N-1 coexistence.
 * - Add nullable hash, ciphertext, key metadata, and dual-read status columns.
 * - Do not backfill unknowable secrets; do not drop plaintext yet (contract = later).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE oidc_login_transactions
    ADD COLUMN state_hash text,
    ADD COLUMN nonce_hash text,
    ADD COLUMN pkce_verifier_ciphertext bytea,
    ADD COLUMN encryption_key_id text,
    ADD COLUMN encryption_key_version integer,
    ADD COLUMN dual_read_status text`.execute(db);

  await sql`ALTER TABLE oidc_login_transactions
    ADD CONSTRAINT oidc_login_transactions_state_hash_length
      CHECK (state_hash IS NULL OR length(state_hash) BETWEEN 1 AND 128),
    ADD CONSTRAINT oidc_login_transactions_nonce_hash_length
      CHECK (nonce_hash IS NULL OR length(nonce_hash) BETWEEN 1 AND 128),
    ADD CONSTRAINT oidc_login_transactions_encryption_key_id_length
      CHECK (encryption_key_id IS NULL OR length(encryption_key_id) BETWEEN 1 AND 256),
    ADD CONSTRAINT oidc_login_transactions_encryption_key_version_non_negative
      CHECK (encryption_key_version IS NULL OR encryption_key_version >= 0),
    ADD CONSTRAINT oidc_login_transactions_dual_read_status_valid
      CHECK (
        dual_read_status IS NULL
        OR dual_read_status IN ('plaintext', 'dual', 'protected')
      )`.execute(db);

  // Lookup path for dual-read consumers once hashes are populated (task 05).
  await sql`CREATE UNIQUE INDEX oidc_login_transactions_state_hash_unique
    ON oidc_login_transactions(state_hash)
    WHERE state_hash IS NOT NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS oidc_login_transactions_state_hash_unique`.execute(db);

  await sql`ALTER TABLE oidc_login_transactions
    DROP CONSTRAINT IF EXISTS oidc_login_transactions_dual_read_status_valid,
    DROP CONSTRAINT IF EXISTS oidc_login_transactions_encryption_key_version_non_negative,
    DROP CONSTRAINT IF EXISTS oidc_login_transactions_encryption_key_id_length,
    DROP CONSTRAINT IF EXISTS oidc_login_transactions_nonce_hash_length,
    DROP CONSTRAINT IF EXISTS oidc_login_transactions_state_hash_length`.execute(db);

  await sql`ALTER TABLE oidc_login_transactions
    DROP COLUMN IF EXISTS dual_read_status,
    DROP COLUMN IF EXISTS encryption_key_version,
    DROP COLUMN IF EXISTS encryption_key_id,
    DROP COLUMN IF EXISTS pkce_verifier_ciphertext,
    DROP COLUMN IF EXISTS nonce_hash,
    DROP COLUMN IF EXISTS state_hash`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
