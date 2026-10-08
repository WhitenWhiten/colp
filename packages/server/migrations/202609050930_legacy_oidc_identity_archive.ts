import { sql, type Kysely, type Migration } from 'kysely';

/**
 * B1 expand migration: permanent archive of legacy OIDC identity facts
 * (G1 ADR §13/§14, plan §8 B1 step 4). Written only by the controlled legacy
 * account import (B2); never read by runtime authentication.
 *
 * Stores ONLY issuer/subject/account binding, migration source, the
 * email_verified claim fact, migrated_at and retention metadata. There is
 * deliberately no access/refresh token, id token, raw code or secret column
 * (schema-level assertion, ADR §15 validation query 5). `retention_until`
 * defaults to 'infinity' — the archive is permanent migration audit and
 * rollback evidence with no automatic cleanup (ADR §14).
 *
 * Expand-only: N-1 binaries ignore the table; no legacy table is touched.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE legacy_oidc_identity_archive (
    id bigserial PRIMARY KEY,
    issuer text NOT NULL,
    subject text NOT NULL,
    account_id text NOT NULL,
    migration_source text NOT NULL,
    email_verified_claim boolean NOT NULL,
    migrated_at timestamptz NOT NULL DEFAULT now(),
    retention_until timestamptz NOT NULL DEFAULT 'infinity',
    CONSTRAINT legacy_oidc_identity_archive_account_fk
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
    CONSTRAINT legacy_oidc_identity_archive_issuer_subject_unique UNIQUE (issuer, subject),
    CONSTRAINT legacy_oidc_identity_archive_issuer_length CHECK (length(issuer) BETWEEN 1 AND 2048),
    CONSTRAINT legacy_oidc_identity_archive_subject_length CHECK (length(subject) BETWEEN 1 AND 512),
    CONSTRAINT legacy_oidc_identity_archive_migration_source_length
      CHECK (length(migration_source) BETWEEN 1 AND 128),
    CONSTRAINT legacy_oidc_identity_archive_retention_check CHECK (retention_until > migrated_at)
  )`.execute(db);
  await sql`CREATE INDEX legacy_oidc_identity_archive_account_id_idx
    ON legacy_oidc_identity_archive(account_id, migrated_at DESC)`.execute(db);
  await sql`COMMENT ON TABLE legacy_oidc_identity_archive IS
    'Permanent legacy OIDC identity archive: issuer/subject/account evidence facts only (no access/refresh tokens, codes or secrets).'`.execute(db);
}

/**
 * Developer-only destructive rollback. Refuses while any archive row remains
 * and reports the count; production rollback keeps the expand schema installed.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DO $guard$
    DECLARE archive_count bigint;
    BEGIN
      SELECT count(*) INTO archive_count FROM legacy_oidc_identity_archive;
      IF archive_count > 0 THEN
        RAISE EXCEPTION 'legacy_oidc_identity_archive down refused: rows remain (legacy_oidc_identity_archive=%); production rollback keeps the expand schema installed and down is a developer-only zero-row boundary.', archive_count;
      END IF;
    END
  $guard$`.execute(db);
  await sql`DROP INDEX IF EXISTS legacy_oidc_identity_archive_account_id_idx`.execute(db);
  await sql`DROP TABLE IF EXISTS legacy_oidc_identity_archive`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
