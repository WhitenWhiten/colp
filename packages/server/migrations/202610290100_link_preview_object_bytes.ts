import { sql, type Kysely } from 'kysely';

/**
 * Link preview images live in the instance database, like favicons: the
 * self-hosted server has no object storage. Bytes hang off the object ledger
 * row the worker writes before storing them, so forgetting a collected
 * version removes its bytes too.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE link_preview_object_bytes (
    object_id uuid PRIMARY KEY REFERENCES link_preview_objects(object_id) ON DELETE CASCADE,
    content_type text NOT NULL,
    body bytea NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 2097152)
  )`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE link_preview_object_bytes`.execute(db);
}
