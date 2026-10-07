import { sql, type Kysely, type Migration } from 'kysely';

/**
 * ADR-0021 expand-only: owner library export jobs. Object keys stay off the
 * Product JSON; TTL is created_at + 7 days. N-1 binaries ignore the table.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE collection_export_jobs (
    job_id text NOT NULL,
    owner_subject_id text NOT NULL,
    status text NOT NULL CHECK (status IN ('pending','running','ready','failed','expired')),
    object_key text,
    byte_size integer,
    expires_at timestamptz NOT NULL,
    ready_at timestamptz,
    lease_owner text,
    lease_until timestamptz,
    error_class text,
    created_at timestamptz NOT NULL,
    CONSTRAINT collection_export_jobs_pkey PRIMARY KEY (job_id),
    CONSTRAINT collection_export_jobs_identity_lengths CHECK (
      length(job_id) BETWEEN 1 AND 128
      AND length(owner_subject_id) BETWEEN 1 AND 128
    ),
    CONSTRAINT collection_export_jobs_byte_size_range CHECK (
      byte_size IS NULL OR byte_size >= 0
    ),
    CONSTRAINT collection_export_jobs_error_class_shape CHECK (
      error_class IS NULL OR (
        length(error_class) BETWEEN 1 AND 64
      )
    ),
    CONSTRAINT collection_export_jobs_time_finite CHECK (
      created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz
      AND expires_at > '-infinity'::timestamptz AND expires_at < 'infinity'::timestamptz
      AND (ready_at IS NULL OR (
        ready_at > '-infinity'::timestamptz AND ready_at < 'infinity'::timestamptz
      ))
      AND (lease_until IS NULL OR (
        lease_until > '-infinity'::timestamptz AND lease_until < 'infinity'::timestamptz
      ))
    )
  )`.execute(db);

  await sql`COMMENT ON TABLE collection_export_jobs IS
    'Owner library export jobs; object keys never appear in Product JSON.'`.execute(db);
  await sql`CREATE INDEX collection_export_jobs_owner_created_idx
    ON collection_export_jobs (owner_subject_id, created_at DESC)`.execute(db);
  await sql`CREATE UNIQUE INDEX collection_export_jobs_owner_active_uidx
    ON collection_export_jobs (owner_subject_id)
    WHERE status IN ('pending','running')`.execute(db);
  await sql`CREATE INDEX collection_export_jobs_pending_lease_idx
    ON collection_export_jobs (lease_until) WHERE status IN ('pending','running')`.execute(db);
}

/** Developer-only destructive rollback; drain export writers before migrating down. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS collection_export_jobs`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
