import { sql, type Kysely } from 'kysely';

/** Small favicon objects use the instance database when no R2 bucket is configured. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE favicon_object_bytes (
    object_id uuid PRIMARY KEY,
    content_type text NOT NULL,
    body bytea NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 65536)
  )`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE favicon_object_bytes`.execute(db);
}
