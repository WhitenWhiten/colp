import { sql, type Kysely, type Migration } from 'kysely';

/**
 * ADR-0021 expand-only: per-bookmark readable-replica sidecar. Absence of a
 * row is status none. N-1 binaries ignore the table. Do not backfill live
 * bookmarks to pending — that would enqueue egress on every existing URL.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE collection_readable_replicas (
    node_id text NOT NULL,
    collection_id text NOT NULL,
    status text NOT NULL CHECK (status IN ('pending','ready','failed','unsupported')),
    source_url text NOT NULL,
    title text,
    byline text,
    word_count integer NOT NULL DEFAULT 0,
    sections jsonb NOT NULL DEFAULT '[]'::jsonb,
    failure_code text,
    etag text NOT NULL,
    extracted_at timestamptz,
    updated_at timestamptz NOT NULL,
    enqueued_at timestamptz,
    lease_owner text,
    lease_until timestamptz,
    enqueue_command_id text,
    CONSTRAINT collection_readable_replicas_pkey PRIMARY KEY (node_id),
    CONSTRAINT collection_readable_replicas_node_fk FOREIGN KEY (node_id)
      REFERENCES nodes(id) ON DELETE CASCADE,
    CONSTRAINT collection_readable_replicas_collection_fk FOREIGN KEY (collection_id)
      REFERENCES collections(id),
    CONSTRAINT collection_readable_replicas_identity_lengths CHECK (
      length(node_id) BETWEEN 1 AND 128
      AND length(collection_id) BETWEEN 1 AND 128
    ),
    CONSTRAINT collection_readable_replicas_word_count_range CHECK (
      word_count >= 0
    ),
    CONSTRAINT collection_readable_replicas_failure_code_shape CHECK (
      failure_code IS NULL OR failure_code IN (
        'not_html','empty','timeout','denied','too_large','http','dns','invalid_url'
      )
    ),
    CONSTRAINT collection_readable_replicas_time_finite CHECK (
      (extracted_at IS NULL OR (
        extracted_at > '-infinity'::timestamptz AND extracted_at < 'infinity'::timestamptz
      ))
      AND (updated_at > '-infinity'::timestamptz AND updated_at < 'infinity'::timestamptz)
      AND (enqueued_at IS NULL OR (
        enqueued_at > '-infinity'::timestamptz AND enqueued_at < 'infinity'::timestamptz
      ))
      AND (lease_until IS NULL OR (
        lease_until > '-infinity'::timestamptz AND lease_until < 'infinity'::timestamptz
      ))
    )
  )`.execute(db);

  await sql`COMMENT ON TABLE collection_readable_replicas IS
    'Per-bookmark readable-replica sidecar; no row means status none.'`.execute(db);
  await sql`CREATE INDEX collection_readable_replicas_collection_idx
    ON collection_readable_replicas (collection_id)`.execute(db);
  await sql`CREATE INDEX collection_readable_replicas_pending_lease_idx
    ON collection_readable_replicas (lease_until) WHERE status = 'pending'`.execute(db);
}

/** Developer-only destructive rollback; drain readable-replica writers before migrating down. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS collection_readable_replicas`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
