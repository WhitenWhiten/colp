import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Contract oidc_login_transactions: protected secrets only.
 *
 * After expand dual-write (task 04/05) is proven:
 * - Fail closed while any live row still depends on legacy plaintext secrets.
 * - Delete only expired rows that cannot be recovered without raw secrets.
 * - Require state_hash / nonce_hash / pkce ciphertext + key metadata.
 * - Drop plaintext state/nonce/code_verifier columns so raw secrets cannot be stored.
 * - Drop dual_read_status (everything is protected).
 * - Primary key becomes state_hash.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Deploy contract only after all in-flight legacy transactions have expired.
  // Deleting an active row here would strand a browser callback during rollout.
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM oidc_login_transactions
        WHERE expires_at > current_timestamp
          AND (
            state_hash IS NULL
            OR nonce_hash IS NULL
            OR pkce_verifier_ciphertext IS NULL
            OR encryption_key_id IS NULL
            OR encryption_key_version IS NULL
          )
      ) THEN
        RAISE EXCEPTION
          'OIDC contract blocked: unexpired legacy login transactions remain';
      END IF;
    END
    $$
  `.execute(db);

  // Expired plaintext-only rows have no callback value and cannot be protected
  // without the original browser values. Delete only those rows.
  await sql`
    DELETE FROM oidc_login_transactions
    WHERE expires_at <= current_timestamp
      AND (
        state_hash IS NULL
        OR nonce_hash IS NULL
        OR pkce_verifier_ciphertext IS NULL
        OR encryption_key_id IS NULL
        OR encryption_key_version IS NULL
      )
  `.execute(db);

  // Partial unique index is replaced by a real primary key on state_hash.
  await sql`DROP INDEX IF EXISTS oidc_login_transactions_state_hash_unique`.execute(db);

  // Drop legacy PK on plaintext state before removing the column.
  await sql`ALTER TABLE oidc_login_transactions DROP CONSTRAINT IF EXISTS oidc_login_transactions_pkey`.execute(db);

  await sql`ALTER TABLE oidc_login_transactions
    DROP CONSTRAINT IF EXISTS oidc_login_transactions_dual_read_status_valid,
    DROP CONSTRAINT IF EXISTS oidc_login_transactions_state_length,
    DROP CONSTRAINT IF EXISTS oidc_login_transactions_nonce_length,
    DROP CONSTRAINT IF EXISTS oidc_login_transactions_code_verifier_length,
    DROP CONSTRAINT IF EXISTS oidc_login_transactions_state_hash_length,
    DROP CONSTRAINT IF EXISTS oidc_login_transactions_nonce_hash_length,
    DROP CONSTRAINT IF EXISTS oidc_login_transactions_encryption_key_id_length,
    DROP CONSTRAINT IF EXISTS oidc_login_transactions_encryption_key_version_non_negative`.execute(db);

  await sql`ALTER TABLE oidc_login_transactions
    DROP COLUMN IF EXISTS dual_read_status,
    DROP COLUMN IF EXISTS state,
    DROP COLUMN IF EXISTS nonce,
    DROP COLUMN IF EXISTS code_verifier`.execute(db);

  await sql`ALTER TABLE oidc_login_transactions
    ALTER COLUMN state_hash SET NOT NULL,
    ALTER COLUMN nonce_hash SET NOT NULL,
    ALTER COLUMN pkce_verifier_ciphertext SET NOT NULL,
    ALTER COLUMN encryption_key_id SET NOT NULL,
    ALTER COLUMN encryption_key_version SET NOT NULL`.execute(db);

  await sql`ALTER TABLE oidc_login_transactions
    ADD CONSTRAINT oidc_login_transactions_pkey PRIMARY KEY (state_hash),
    ADD CONSTRAINT oidc_login_transactions_state_hash_length
      CHECK (length(state_hash) BETWEEN 1 AND 128),
    ADD CONSTRAINT oidc_login_transactions_nonce_hash_length
      CHECK (length(nonce_hash) BETWEEN 1 AND 128),
    ADD CONSTRAINT oidc_login_transactions_encryption_key_id_length
      CHECK (length(encryption_key_id) BETWEEN 1 AND 256),
    ADD CONSTRAINT oidc_login_transactions_encryption_key_version_non_negative
      CHECK (encryption_key_version >= 0)`.execute(db);
}

/**
 * Restore expand-window shape (nullable protected columns + plaintext secret columns).
 * Rows present after contract were protected-only; restore placeholders in plaintext
 * columns (state = state_hash, nonce/code_verifier non-secret placeholders).
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE oidc_login_transactions
    DROP CONSTRAINT IF EXISTS oidc_login_transactions_pkey,
    DROP CONSTRAINT IF EXISTS oidc_login_transactions_state_hash_length,
    DROP CONSTRAINT IF EXISTS oidc_login_transactions_nonce_hash_length,
    DROP CONSTRAINT IF EXISTS oidc_login_transactions_encryption_key_id_length,
    DROP CONSTRAINT IF EXISTS oidc_login_transactions_encryption_key_version_non_negative`.execute(db);

  await sql`ALTER TABLE oidc_login_transactions
    ALTER COLUMN state_hash DROP NOT NULL,
    ALTER COLUMN nonce_hash DROP NOT NULL,
    ALTER COLUMN pkce_verifier_ciphertext DROP NOT NULL,
    ALTER COLUMN encryption_key_id DROP NOT NULL,
    ALTER COLUMN encryption_key_version DROP NOT NULL`.execute(db);

  // Non-secret placeholders match task-05 protected writers (length CHECKs).
  await sql`ALTER TABLE oidc_login_transactions
    ADD COLUMN state text,
    ADD COLUMN nonce text,
    ADD COLUMN code_verifier text,
    ADD COLUMN dual_read_status text`.execute(db);

  await sql`
    UPDATE oidc_login_transactions
    SET
      state = state_hash,
      nonce = 'protected-nonce-not-stored',
      code_verifier = 'prot-pkce-placeholder-0000000000000000000000',
      dual_read_status = 'protected'
  `.execute(db);

  await sql`ALTER TABLE oidc_login_transactions
    ALTER COLUMN state SET NOT NULL,
    ALTER COLUMN nonce SET NOT NULL,
    ALTER COLUMN code_verifier SET NOT NULL`.execute(db);

  await sql`ALTER TABLE oidc_login_transactions
    ADD CONSTRAINT oidc_login_transactions_pkey PRIMARY KEY (state),
    ADD CONSTRAINT oidc_login_transactions_state_length
      CHECK (length(state) BETWEEN 16 AND 256),
    ADD CONSTRAINT oidc_login_transactions_nonce_length
      CHECK (length(nonce) BETWEEN 16 AND 256),
    ADD CONSTRAINT oidc_login_transactions_code_verifier_length
      CHECK (length(code_verifier) BETWEEN 43 AND 128),
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

  await sql`CREATE UNIQUE INDEX oidc_login_transactions_state_hash_unique
    ON oidc_login_transactions(state_hash)
    WHERE state_hash IS NOT NULL`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
