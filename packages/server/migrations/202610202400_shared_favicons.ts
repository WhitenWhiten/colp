import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE favicon_shared_domains (
      hostname text PRIMARY KEY,
      object_id uuid,
      next_refresh_at timestamptz NOT NULL DEFAULT current_timestamp,
      failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
      lease_owner uuid,
      lease_until timestamptz,
      updated_at timestamptz NOT NULL DEFAULT current_timestamp
    );
    CREATE INDEX favicon_shared_domains_due ON favicon_shared_domains(next_refresh_at);
    -- Separate ownership from per-bookmark objects: deleting/moderating a bookmark
    -- must never remove or hide a globally shared icon. Each version is immutable.
    CREATE TABLE favicon_shared_objects (
      object_id uuid PRIMARY KEY,
      hostname text NOT NULL REFERENCES favicon_shared_domains(hostname),
      digest text NOT NULL,
      deletable_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT current_timestamp
    );
    CREATE INDEX favicon_shared_objects_gc ON favicon_shared_objects(deletable_at);
    CREATE TABLE favicon_provider_admission (
      provider text PRIMARY KEY,
      next_request_at timestamptz NOT NULL DEFAULT current_timestamp,
      lease_owner uuid,
      lease_until timestamptz,
      throttles integer NOT NULL DEFAULT 0
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE favicon_provider_admission; DROP TABLE favicon_shared_objects; DROP TABLE favicon_shared_domains`.execute(db);
}
