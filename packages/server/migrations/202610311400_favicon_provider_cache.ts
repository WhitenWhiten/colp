import { sql, type Kysely } from 'kysely';

/** Fetch results are shared by their full provider URL, never by hostname alone. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE favicon_provider_cache (
    source_key text PRIMARY KEY CHECK (source_key ~ '^[a-f0-9]{64}$'),
    body bytea CHECK (octet_length(body) BETWEEN 1 AND 65536),
    expires_at timestamptz,
    lease_owner uuid,
    lease_until timestamptz,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )`.execute(db);
  await sql`CREATE INDEX favicon_provider_cache_expiry ON favicon_provider_cache (expires_at)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE favicon_provider_cache`.execute(db);
}
