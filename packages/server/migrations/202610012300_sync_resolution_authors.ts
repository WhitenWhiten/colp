import { sql, type Kysely } from 'kysely';

/** Server-authored resolutions never allocate from a browser's offline lane. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE sync_resolution_authors (
    operation_id text PRIMARY KEY REFERENCES resource_id_ledger(resource_id),
    author_id text NOT NULL UNIQUE REFERENCES resource_id_ledger(resource_id),
    collection_id text NOT NULL REFERENCES collections(id),
    conflict_id text NOT NULL REFERENCES sync_conflicts(conflict_id),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    sequence_number bigint NOT NULL DEFAULT 1 CHECK (sequence_number=1),
    created_at timestamptz NOT NULL DEFAULT current_timestamp
  )`.execute(db);
  await sql`CREATE FUNCTION forbid_sync_resolution_author_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'sync resolution author is immutable' USING ERRCODE='23514'; END
  $$`.execute(db);
  await sql`CREATE TRIGGER sync_resolution_authors_immutable BEFORE UPDATE OR DELETE ON sync_resolution_authors
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_resolution_author_mutation()`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE sync_resolution_authors`.execute(db);
  await sql`DROP FUNCTION forbid_sync_resolution_author_mutation()`.execute(db);
}
