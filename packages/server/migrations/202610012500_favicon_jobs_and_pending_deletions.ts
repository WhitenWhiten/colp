import { sql, type Kysely, type Migration } from 'kysely';

/**
 * FO-02: durable favicon refresh jobs and the GC pending-deletion ledger.
 *
 * `favicon_jobs` is owned by the real worker lifecycle
 * (src/bootstrap/worker.ts). A `refresh_one` row carries the async identity the
 * contract requires: account, node, resolved URL, source revision, policy
 * revision and node resource revision. The target object id is persisted in
 * `object_id` BEFORE the immutable PUT, so a retry can locate already-written
 * bytes without a second PUT. `attempts`/`next_attempt_at` implement the
 * FAVICON_JOB_MAX_ATTEMPTS / FAVICON_RETRY_BACKOFF_SECONDS retry envelope;
 * `lease_owner`/`lease_until` reuse the existing lease pattern so a restarted
 * worker reclaims overdue work.
 *
 * `favicon_pending_deletions` is the durable collection ledger. A row is
 * written when an object exits live reference (binding CAS switch), with
 * `deletable_at = retired_at + FAVICON_HISTORY_RETENTION_SECONDS`, so the
 * promised immutable cache window is never undercut. GC claims only
 * `deletable_at <= now` rows under a lease and rechecks references before the
 * destructive delete; a failed delete keeps the row with a backoff retry.
 *
 * Only `refresh_one` is produced by FO-02. The remaining operation/status
 * values are part of the frozen IconJob contract so FO-03 can extend without a
 * schema rename; they are not creatable in FO-02.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE favicon_jobs (
      id                     uuid PRIMARY KEY,
      account_id             text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      owner_subject_id       text NOT NULL,
      operation              text NOT NULL
                             CONSTRAINT favicon_jobs_operation CHECK (
                               operation IN ('refresh_one', 'fill_missing', 'refresh_online',
                                             'apply_force_online', 'restore_sources')
                             ),
      policy_revision        bigint NOT NULL
                             CONSTRAINT favicon_jobs_policy_revision CHECK (policy_revision >= 1),
      status                 text NOT NULL DEFAULT 'pending'
                             CONSTRAINT favicon_jobs_status CHECK (
                               status IN ('pending', 'running', 'succeeded', 'partial', 'failed', 'superseded')
                             ),
      total                  integer NOT NULL DEFAULT 1
                             CONSTRAINT favicon_jobs_total CHECK (total >= 0),
      succeeded              integer NOT NULL DEFAULT 0
                             CONSTRAINT favicon_jobs_succeeded CHECK (succeeded >= 0),
      failed                 integer NOT NULL DEFAULT 0
                             CONSTRAINT favicon_jobs_failed CHECK (failed >= 0),
      skipped                integer NOT NULL DEFAULT 0
                             CONSTRAINT favicon_jobs_skipped CHECK (skipped >= 0),
      error_node_id          text,
      error_reason           text
                             CONSTRAINT favicon_jobs_error_reason CHECK (
                               error_reason IS NULL OR error_reason IN (
                                 'fetch_failed', 'invalid_image', 'unsafe_source', 'stale_policy',
                                 'source_changed', 'permission_changed', 'storage_unavailable'
                               )
                             ),
      collection_id          text,
      node_id                text,
      source_url             text,
      source_revision        bigint
                             CONSTRAINT favicon_jobs_source_revision CHECK (
                               source_revision IS NULL OR source_revision >= 1
                             ),
      node_resource_revision text,
      object_id              uuid,
      object_content_type    text
                             CONSTRAINT favicon_jobs_object_content_type CHECK (
                               object_content_type IS NULL OR object_content_type IN (
                                 'image/png', 'image/jpeg', 'image/webp', 'image/x-icon'
                               )
                             ),
      object_byte_size       integer
                             CONSTRAINT favicon_jobs_object_byte_size CHECK (
                               object_byte_size IS NULL OR object_byte_size BETWEEN 1 AND 65536
                             ),
      object_digest_sha256   bytea
                             CONSTRAINT favicon_jobs_object_digest CHECK (
                               object_digest_sha256 IS NULL OR octet_length(object_digest_sha256) = 32
                             ),
      attempts               integer NOT NULL DEFAULT 0
                             CONSTRAINT favicon_jobs_attempts CHECK (attempts >= 0),
      next_attempt_at        timestamptz,
      lease_owner            text,
      lease_until            timestamptz,
      created_at             timestamptz NOT NULL,
      updated_at             timestamptz NOT NULL
    )
  `.execute(db);
  await sql`
    CREATE INDEX favicon_jobs_due_idx
      ON favicon_jobs (status, next_attempt_at, created_at)
      WHERE status IN ('pending', 'running')
  `.execute(db);
  await sql`
    CREATE INDEX favicon_jobs_node_created_idx
      ON favicon_jobs (node_id, created_at DESC)
  `.execute(db);
  await sql`
    CREATE INDEX favicon_jobs_account_created_idx
      ON favicon_jobs (account_id, created_at DESC)
  `.execute(db);
  await sql`
    CREATE INDEX favicon_jobs_object_idx
      ON favicon_jobs (object_id)
      WHERE object_id IS NOT NULL
  `.execute(db);
  await sql`
    CREATE TABLE favicon_pending_deletions (
      object_id      uuid PRIMARY KEY,
      node_id        text NOT NULL,
      collection_id  text NOT NULL,
      retired_at     timestamptz NOT NULL,
      deletable_at   timestamptz NOT NULL,
      attempts       integer NOT NULL DEFAULT 0
                     CONSTRAINT favicon_pending_deletions_attempts CHECK (attempts >= 0),
      last_error     text,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      lease_owner    text,
      lease_until    timestamptz,
      created_at     timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT favicon_pending_deletions_window CHECK (deletable_at >= retired_at)
    )
  `.execute(db);
  await sql`
    CREATE INDEX favicon_pending_deletions_due_idx
      ON favicon_pending_deletions (deletable_at, next_attempt_at)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS favicon_pending_deletions`.execute(db);
  await sql`DROP TABLE IF EXISTS favicon_jobs`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
