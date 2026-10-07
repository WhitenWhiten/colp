import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Redundant-index cleanup from the 2026-08-27 backend performance audit
 * (IDX-08 / T-09). Every dropped index is a strict prefix duplicate of a
 * surviving index or constraint on the same table with the same (or no)
 * partial predicate, so no query loses its access path:
 *
 * 1. auth_accounts_provider_account_idx ("providerId", "accountId")
 *    duplicates the implicit index of UNIQUE constraint
 *    auth_accounts_provider_account_unique (202609050900).
 * 2. "auth_oauth_client_resource_clientId_idx" ("clientId") is the prefix of
 *    "auth_oauth_client_resource_clientId_resourceId_uidx" (202609230100).
 * 3. publication_insight_daily_owner_window_idx (collection_id, day) is the
 *    prefix of the composite PK (collection_id, day, event_type, node_id)
 *    (202609070100).
 * 4. auth_verifications_identifier_idx ("identifier") is the prefix of
 *    "auth_verifications_identifier_created_idx" ("identifier",
 *    "createdAt" DESC) added by 202609260300 for the newest-row OTP read.
 * 5. collections_search_member_owner_idx (owner_subject_id)
 *    WHERE deleted_at IS NULL is the prefix of
 *    collections_owned_live_updated_id_idx (owner_subject_id,
 *    updated_at DESC, id COLLATE "C") with the identical predicate
 *    (202607260100); the R11 membership-set walk stays index-backed.
 *
 * Contract-only drops: no table, column or constraint changes, so N-1
 * binaries are unaffected. The developer-only down recreates the five
 * originals verbatim from their source migrations.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS auth_accounts_provider_account_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS "auth_oauth_client_resource_clientId_idx"`.execute(db);
  await sql`DROP INDEX IF EXISTS publication_insight_daily_owner_window_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS auth_verifications_identifier_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS collections_search_member_owner_idx`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX collections_search_member_owner_idx
    ON collections (owner_subject_id)
    WHERE deleted_at IS NULL`.execute(db);
  await sql`CREATE INDEX auth_verifications_identifier_idx
    ON "auth_verifications" ("identifier")`.execute(db);
  await sql`CREATE INDEX publication_insight_daily_owner_window_idx
    ON publication_insight_daily (collection_id, day)`.execute(db);
  await sql`CREATE INDEX "auth_oauth_client_resource_clientId_idx"
    ON "auth_oauth_client_resource" ("clientId")`.execute(db);
  await sql`CREATE INDEX auth_accounts_provider_account_idx
    ON "auth_accounts" ("providerId", "accountId")`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
