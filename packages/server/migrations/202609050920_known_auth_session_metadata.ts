import { sql, type Kysely, type Migration } from 'kysely';

/**
 * B1 expand migration: Know-N supplementary security facts for Better Auth
 * browser sessions (G1 ADR §13/§15, contract sessionTtl/baGap and R1/R2/R3).
 * Better Auth 1.6.29 sessions have only a sliding `expiresAt`, no absolute
 * expiry and no token rotation; the metadata row enforces the product
 * idle/absolute contract and the predecessor compare-and-swap single-winner
 * claim. BA rows are the minimal common-denominator carrier only.
 *
 * - `session_token_hash` is the sha256 hex digest of the logical BA token.
 *   Migration 202609280700 later protects the carrier column at rest; this
 *   digest remains bound to the cookie token, never to its DB envelope.
 * - `absolute_expires_at` is never extended by refresh/touch.
 * - `security_epoch` mirrors accounts.security_epoch for epoch-mismatch
 *   rejection; `csrf_token_hash` is the digest of the product CSRF token.
 * - `predecessor_session_id` + partial unique index enforce one successor per
 *   predecessor (single-winner rotation, mirror of
 *   `sessions_rotated_from_session_id_unique` with SET NULL semantics).
 *
 * Expand-only: N-1 binaries ignore the table; no legacy table is touched.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE known_auth_session_metadata (
    auth_session_id text PRIMARY KEY,
    session_token_hash text NOT NULL,
    account_id text NOT NULL,
    idle_expires_at timestamptz NOT NULL,
    absolute_expires_at timestamptz NOT NULL,
    security_epoch bigint NOT NULL,
    csrf_token_hash text NOT NULL,
    predecessor_session_id text,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT known_auth_session_metadata_auth_session_fk
      FOREIGN KEY (auth_session_id) REFERENCES auth_sessions(id) ON DELETE CASCADE,
    CONSTRAINT known_auth_session_metadata_account_fk
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
    CONSTRAINT known_auth_session_metadata_predecessor_fk
      FOREIGN KEY (predecessor_session_id) REFERENCES auth_sessions(id) ON DELETE SET NULL,
    CONSTRAINT known_auth_session_metadata_session_token_hash_unique UNIQUE (session_token_hash),
    CONSTRAINT known_auth_session_metadata_security_epoch_non_negative CHECK (security_epoch >= 0),
    CONSTRAINT known_auth_session_metadata_idle_before_or_eq_absolute
      CHECK (idle_expires_at <= absolute_expires_at),
    CONSTRAINT known_auth_session_metadata_session_token_hash_length
      CHECK (length(session_token_hash) BETWEEN 1 AND 128),
    CONSTRAINT known_auth_session_metadata_csrf_token_hash_length
      CHECK (length(csrf_token_hash) BETWEEN 1 AND 128)
  )`.execute(db);
  await sql`CREATE UNIQUE INDEX known_auth_session_metadata_predecessor_session_id_unique
    ON known_auth_session_metadata(predecessor_session_id)
    WHERE predecessor_session_id IS NOT NULL`.execute(db);
  await sql`CREATE INDEX known_auth_session_metadata_account_id_idx
    ON known_auth_session_metadata(account_id)`.execute(db);
  await sql`COMMENT ON TABLE known_auth_session_metadata IS
    'Product idle/absolute/epoch/CSRF facts for a Better Auth session; predecessor CAS single-winner; revoked facts retained for the audit window (G1 ADR §14).'`.execute(db);
}

/**
 * Developer-only destructive rollback. Refuses while any metadata row remains
 * and reports the count; production rollback keeps the expand schema installed.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DO $guard$
    DECLARE metadata_count bigint;
    BEGIN
      SELECT count(*) INTO metadata_count FROM known_auth_session_metadata;
      IF metadata_count > 0 THEN
        RAISE EXCEPTION 'known_auth_session_metadata down refused: rows remain (known_auth_session_metadata=%); production rollback keeps the expand schema installed and down is a developer-only zero-row boundary.', metadata_count;
      END IF;
    END
  $guard$`.execute(db);
  await sql`DROP INDEX IF EXISTS known_auth_session_metadata_account_id_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS known_auth_session_metadata_predecessor_session_id_unique`.execute(db);
  await sql`DROP TABLE IF EXISTS known_auth_session_metadata`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
