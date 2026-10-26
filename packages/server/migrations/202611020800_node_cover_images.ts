import { sql, type Kysely } from 'kysely';

/** User uploads are durable assets, independent of the expiring URL-preview cache. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE image_assets (
    object_id uuid PRIMARY KEY,
    collection_id text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    created_by_subject_id text NOT NULL,
    storage_backend text NOT NULL CHECK (storage_backend IN ('database', 'filesystem', 's3')),
    storage_key text NOT NULL,
    mime text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
    width integer NOT NULL CHECK (width BETWEEN 1 AND 4096),
    height integer NOT NULL CHECK (height BETWEEN 1 AND 4096),
    byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 2097152),
    digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (object_id, collection_id),
    UNIQUE (storage_backend, storage_key)
  )`.execute(db);
  await sql`CREATE INDEX image_assets_collection ON image_assets (collection_id)`.execute(db);
  await sql`CREATE TABLE image_asset_bytes (
    object_id uuid PRIMARY KEY REFERENCES image_assets(object_id) ON DELETE CASCADE,
    content_type text NOT NULL,
    body bytea NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 2097152)
  )`.execute(db);
  await sql`CREATE TABLE node_cover_prefs (
    node_id text PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
    collection_id text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    mode text NOT NULL CHECK (mode IN ('auto', 'custom', 'none')),
    asset_id uuid,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((mode = 'custom') = (asset_id IS NOT NULL)),
    FOREIGN KEY (asset_id, collection_id) REFERENCES image_assets(object_id, collection_id)
  )`.execute(db);
  await sql`CREATE INDEX node_cover_prefs_asset ON node_cover_prefs (asset_id) WHERE asset_id IS NOT NULL`.execute(db);
  await sql`CREATE INDEX node_cover_prefs_collection ON node_cover_prefs (collection_id)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE node_cover_prefs`.execute(db);
  await sql`DROP TABLE image_asset_bytes`.execute(db);
  await sql`DROP TABLE image_assets`.execute(db);
}
