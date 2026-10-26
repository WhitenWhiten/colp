import { sql, type Kysely } from 'kysely';

/** Additive expansion. Accounts move from the old blob under their existing transaction lock. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE source_archive_managed_records (
    account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind text NOT NULL, record_hash text NOT NULL, record_key text NOT NULL,
    collection_id text, node_id text, content_hash text, identity_hash text, identity_version integer,
    payload_json jsonb NOT NULL,
    PRIMARY KEY(account_id, kind, record_hash)
  )`.execute(db);
  await sql`CREATE INDEX source_managed_collection_idx ON source_archive_managed_records(account_id, kind, collection_id, record_hash)`.execute(db);
  await sql`CREATE INDEX source_managed_native_idx ON source_archive_managed_records(account_id, kind, node_id)`.execute(db);
  await sql`CREATE INDEX source_managed_content_idx ON source_archive_managed_records(account_id, kind, content_hash)`.execute(db);
  await sql`CREATE INDEX source_managed_identity_idx ON source_archive_managed_records(account_id, kind, identity_hash, identity_version)`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  // A migrated account's receipts must not disappear on rollback.
  const migrated = await sql<{ found: boolean }>`SELECT EXISTS(SELECT 1 FROM source_archive_accounts WHERE state_json->>'version'='2') AS found`.execute(db);
  if (migrated.rows[0]?.found) throw new Error('source_managed_rollback_requires_export');
  await sql`DROP TABLE source_archive_managed_records`.execute(db);
}
