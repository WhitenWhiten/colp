import { sql, type Kysely, type Migration } from 'kysely';

/** Durable exporter scheduling only; it has no source-row deletion capability. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE ledger_archive_export_jobs (
      job_id uuid PRIMARY KEY,
      segment_id uuid NOT NULL UNIQUE REFERENCES ledger_archive_segments(segment_id) ON DELETE RESTRICT,
      status text NOT NULL DEFAULT 'pending',
      attempt_count integer NOT NULL DEFAULT 0,
      lease_owner text,
      lease_token bigint NOT NULL DEFAULT 0,
      lease_expires_at timestamptz,
      available_at timestamptz NOT NULL DEFAULT current_timestamp,
      last_error_class text,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      started_at timestamptz,
      completed_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT current_timestamp,
      CONSTRAINT ledger_archive_export_jobs_status_check CHECK (
        status IN ('pending', 'running', 'retryable', 'succeeded', 'failed')
      ),
      CONSTRAINT ledger_archive_export_jobs_attempt_check CHECK (attempt_count >= 0 AND lease_token >= 0),
      CONSTRAINT ledger_archive_export_jobs_lease_check CHECK (
        (status = 'running') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
      ),
      CONSTRAINT ledger_archive_export_jobs_completion_check CHECK (
        (status IN ('succeeded', 'failed')) = (completed_at IS NOT NULL)
      ),
      CONSTRAINT ledger_archive_export_jobs_error_check CHECK (
        last_error_class IS NULL OR (
          length(last_error_class) BETWEEN 1 AND 96
          AND last_error_class ~ '^[a-z][a-z0-9_]*$'
        )
      ),
      CONSTRAINT ledger_archive_export_jobs_time_check CHECK (
        available_at > '-infinity'::timestamptz
        AND created_at > '-infinity'::timestamptz
        AND updated_at >= created_at
        AND (lease_expires_at IS NULL OR lease_expires_at > '-infinity'::timestamptz)
        AND (started_at IS NULL OR started_at >= created_at)
        AND (completed_at IS NULL OR completed_at >= created_at)
      )
    )
  `.execute(db);
  await sql`
    CREATE INDEX ledger_archive_export_jobs_due_idx
      ON ledger_archive_export_jobs (available_at, created_at, job_id)
      WHERE status IN ('pending', 'retryable')
  `.execute(db);
  await sql`
    CREATE INDEX ledger_archive_export_jobs_expired_lease_idx
      ON ledger_archive_export_jobs (lease_expires_at, job_id)
      WHERE status = 'running'
  `.execute(db);
  await sql`
    CREATE FUNCTION guard_ledger_archive_export_job() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION 'Ledger archive export jobs cannot be truncated'
          USING ERRCODE='23514', CONSTRAINT='ledger_archive_export_jobs_truncate_guard';
      END IF;
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Ledger archive export jobs cannot be deleted'
          USING ERRCODE='23514', CONSTRAINT='ledger_archive_export_jobs_delete_guard';
      END IF;
      IF TG_OP = 'UPDATE' AND (NEW.job_id <> OLD.job_id OR NEW.segment_id <> OLD.segment_id
          OR NEW.created_at <> OLD.created_at OR NEW.attempt_count < OLD.attempt_count
          OR NEW.lease_token < OLD.lease_token) THEN
        RAISE EXCEPTION 'Ledger archive export job identity or fence is immutable'
          USING ERRCODE='23514', CONSTRAINT='ledger_archive_export_jobs_identity_guard';
      END IF;
      NEW.updated_at := current_timestamp;
      RETURN NEW;
    END
    $function$
  `.execute(db);
  await sql`
    CREATE TRIGGER ledger_archive_export_jobs_guard
      BEFORE INSERT OR UPDATE OR DELETE ON ledger_archive_export_jobs
      FOR EACH ROW EXECUTE FUNCTION guard_ledger_archive_export_job()
  `.execute(db);
  await sql`
    CREATE TRIGGER ledger_archive_export_jobs_truncate_guard
      BEFORE TRUNCATE ON ledger_archive_export_jobs
      FOR EACH STATEMENT EXECUTE FUNCTION guard_ledger_archive_export_job()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS ledger_archive_export_jobs_truncate_guard ON ledger_archive_export_jobs`.execute(db);
  await sql`DROP TRIGGER IF EXISTS ledger_archive_export_jobs_guard ON ledger_archive_export_jobs`.execute(db);
  await sql`DROP FUNCTION IF EXISTS guard_ledger_archive_export_job()`.execute(db);
  await sql`DROP TABLE IF EXISTS ledger_archive_export_jobs`.execute(db);
}

const migration: Migration = { up, down };
export default migration;
