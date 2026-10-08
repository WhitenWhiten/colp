import { sql, type Kysely, type Migration } from 'kysely';

/**
 * ADR-0021 expand-only: per-bookmark link-health projection. Duplicate is
 * computed at read time and is not a CHECK value. N-1 binaries ignore the table.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE collection_link_health (
    node_id text NOT NULL,
    collection_id text NOT NULL,
    status text NOT NULL CHECK (status IN ('pending','healthy','redirect','broken')),
    http_status integer,
    final_url text,
    checked_at timestamptz,
    error_class text,
    lease_owner text,
    lease_until timestamptz,
    CONSTRAINT collection_link_health_pkey PRIMARY KEY (node_id),
    CONSTRAINT collection_link_health_node_fk FOREIGN KEY (node_id)
      REFERENCES nodes(id) ON DELETE CASCADE,
    CONSTRAINT collection_link_health_collection_fk FOREIGN KEY (collection_id)
      REFERENCES collections(id),
    CONSTRAINT collection_link_health_identity_lengths CHECK (
      length(node_id) BETWEEN 1 AND 128
      AND length(collection_id) BETWEEN 1 AND 128
    ),
    CONSTRAINT collection_link_health_http_status_range CHECK (
      http_status IS NULL OR (http_status BETWEEN 100 AND 599)
    ),
    CONSTRAINT collection_link_health_error_class_shape CHECK (
      error_class IS NULL OR error_class IN ('invalid_url','timeout','denied','dns','http')
    ),
    CONSTRAINT collection_link_health_time_finite CHECK (
      (checked_at IS NULL OR (
        checked_at > '-infinity'::timestamptz AND checked_at < 'infinity'::timestamptz
      ))
      AND (lease_until IS NULL OR (
        lease_until > '-infinity'::timestamptz AND lease_until < 'infinity'::timestamptz
      ))
    )
  )`.execute(db);

  await sql`COMMENT ON TABLE collection_link_health IS
    'Per-bookmark link-health projection; duplicate is computed, never stored as CHECK.'`.execute(db);
  await sql`CREATE INDEX collection_link_health_collection_idx
    ON collection_link_health (collection_id)`.execute(db);
  await sql`CREATE INDEX collection_link_health_pending_lease_idx
    ON collection_link_health (lease_until) WHERE status = 'pending'`.execute(db);

  await sql`INSERT INTO collection_link_health (
    node_id, collection_id, status, http_status, final_url, checked_at, error_class, lease_owner, lease_until
  )
  SELECT n.id, n.collection_id, 'pending', NULL, NULL, NULL, NULL, NULL, NULL
  FROM nodes n
  WHERE n.deleted_at IS NULL AND n.kind = 'bookmark' AND n.url IS NOT NULL`.execute(db);
}

/** Developer-only destructive rollback; drain LH writers before migrating down. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS collection_link_health`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
