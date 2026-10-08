import { sql, type Kysely, type Migration } from 'kysely';

/**
 * FO-03: durable batch-job item ledger and force-online restore records.
 *
 * `favicon_job_items` holds the per-node work of a batch favicon job
 * (fill_missing / refresh_online / apply_force_online / restore_sources).
 * The parent `favicon_jobs` row keeps the aggregate counters, the lease and
 * the retry envelope; each item carries the async identity the contract
 * requires (node, collection, resolved URL, source revision, node resource
 * revision) and its own attempt/backoff state so a restart resumes at the
 * exact item. The target object id is persisted in `object_id` BEFORE the
 * external PUT (same idempotency rule as refresh_one), and `(job_id,
 * node_id)` is unique so the same job never re-enqueues a node.
 *
 * `favicon_source_restores` preserves each covered node's pre-force source
 * state so disabling forceAllOnline can restore the exact binding/mode. Rows
 * are written by apply_force_online and deleted by restore_sources; the GC
 * reference recheck treats a live restore row as a hard reference
 * (current / non-expired history / force-restore references are never
 * collected), which protects the original object across the whole force
 * window.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE favicon_job_items (
      job_id                 uuid NOT NULL REFERENCES favicon_jobs(id) ON DELETE CASCADE,
      node_id                text NOT NULL,
      collection_id          text NOT NULL,
      source_url             text NOT NULL,
      source_revision        bigint NOT NULL
                             CONSTRAINT favicon_job_items_source_revision CHECK (source_revision >= 1),
      node_resource_revision text NOT NULL,
      status                 text NOT NULL DEFAULT 'pending'
                             CONSTRAINT favicon_job_items_status CHECK (
                               status IN ('pending', 'running', 'succeeded', 'failed', 'skipped')
                             ),
      error_reason           text
                             CONSTRAINT favicon_job_items_error_reason CHECK (
                               error_reason IS NULL OR error_reason IN (
                                 'fetch_failed', 'invalid_image', 'unsafe_source', 'stale_policy',
                                 'source_changed', 'permission_changed', 'storage_unavailable'
                               )
                             ),
      attempts               integer NOT NULL DEFAULT 0
                             CONSTRAINT favicon_job_items_attempts CHECK (attempts >= 0),
      next_attempt_at        timestamptz,
      object_id              uuid,
      object_content_type    text
                             CONSTRAINT favicon_job_items_object_content_type CHECK (
                               object_content_type IS NULL OR object_content_type IN (
                                 'image/png', 'image/jpeg', 'image/webp', 'image/x-icon'
                               )
                             ),
      object_byte_size       integer
                             CONSTRAINT favicon_job_items_object_byte_size CHECK (
                               object_byte_size IS NULL OR object_byte_size BETWEEN 1 AND 65536
                             ),
      object_digest_sha256   bytea
                             CONSTRAINT favicon_job_items_object_digest CHECK (
                               object_digest_sha256 IS NULL OR octet_length(object_digest_sha256) = 32
                             ),
      created_at             timestamptz NOT NULL,
      updated_at             timestamptz NOT NULL,
      PRIMARY KEY (job_id, node_id)
    )
  `.execute(db);
  await sql`
    CREATE INDEX favicon_job_items_job_status_node_idx
      ON favicon_job_items (job_id, status, node_id)
  `.execute(db);
  await sql`
    CREATE INDEX favicon_job_items_object_idx
      ON favicon_job_items (object_id)
      WHERE object_id IS NOT NULL
  `.execute(db);
  await sql`
    CREATE TABLE favicon_source_restores (
      node_id                text PRIMARY KEY,
      collection_id          text NOT NULL,
      account_id             text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      original_source_mode   text NOT NULL
                             CONSTRAINT favicon_source_restores_mode CHECK (
                               original_source_mode IN ('inherit', 'online', 'uploaded', 'none')
                             ),
      original_object_id     uuid,
      original_content_type  text
                             CONSTRAINT favicon_source_restores_content_type CHECK (
                               original_content_type IS NULL OR original_content_type IN (
                                 'image/png', 'image/jpeg', 'image/webp', 'image/x-icon'
                               )
                             ),
      original_byte_size     integer
                             CONSTRAINT favicon_source_restores_byte_size CHECK (
                               original_byte_size IS NULL OR original_byte_size BETWEEN 1 AND 65536
                             ),
      original_digest_sha256 bytea
                             CONSTRAINT favicon_source_restores_digest CHECK (
                               original_digest_sha256 IS NULL OR octet_length(original_digest_sha256) = 32
                             ),
      source_revision        bigint NOT NULL
                             CONSTRAINT favicon_source_restores_source_revision CHECK (source_revision >= 1),
      created_at             timestamptz NOT NULL,
      updated_at             timestamptz NOT NULL
    )
  `.execute(db);
  await sql`
    CREATE INDEX favicon_source_restores_account_idx
      ON favicon_source_restores (account_id, created_at)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS favicon_source_restores`.execute(db);
  await sql`DROP TABLE IF EXISTS favicon_job_items`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;