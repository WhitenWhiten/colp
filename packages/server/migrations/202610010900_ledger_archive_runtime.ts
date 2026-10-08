import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Makes the durable archive exporter queue a database-owned state machine.
 * The queue remains scheduling/evidence only and grants no source deletion authority.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS ledger_archive_export_jobs_guard ON ledger_archive_export_jobs`.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION guard_ledger_archive_export_job() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    DECLARE
      segment_state text;
    BEGIN
      IF TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION 'Ledger archive export jobs cannot be truncated'
          USING ERRCODE='23514', CONSTRAINT='ledger_archive_export_jobs_truncate_guard';
      END IF;
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Ledger archive export jobs cannot be deleted'
          USING ERRCODE='23514', CONSTRAINT='ledger_archive_export_jobs_delete_guard';
      END IF;

      IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'pending'
            OR NEW.attempt_count <> 0 OR NEW.lease_token <> 0
            OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
            OR NEW.last_error_class IS NOT NULL OR NEW.started_at IS NOT NULL
            OR NEW.completed_at IS NOT NULL
            OR NEW.created_at IS DISTINCT FROM current_timestamp
            OR NEW.updated_at IS DISTINCT FROM NEW.created_at
            OR NEW.available_at <= '-infinity'::timestamptz
            OR NEW.available_at >= 'infinity'::timestamptz THEN
          RAISE EXCEPTION 'Archive export jobs must start pending without lease or outcome state'
            USING ERRCODE='23514', CONSTRAINT='ledger_archive_export_jobs_transition_guard';
        END IF;
        NEW.updated_at := NEW.created_at;
        RETURN NEW;
      END IF;

      IF NEW.job_id IS DISTINCT FROM OLD.job_id
          OR NEW.segment_id IS DISTINCT FROM OLD.segment_id
          OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Archive export job identity is immutable'
          USING ERRCODE='23514', CONSTRAINT='ledger_archive_export_jobs_identity_guard';
      END IF;
      IF NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN
        RAISE EXCEPTION 'Archive export job update timestamp is database-owned'
          USING ERRCODE='23514', CONSTRAINT='ledger_archive_export_jobs_timestamp_guard';
      END IF;

      IF NEW.status = 'running' AND (
        (OLD.status IN ('pending', 'retryable') AND OLD.available_at <= current_timestamp)
        OR (OLD.status = 'running' AND OLD.lease_expires_at <= current_timestamp)
      ) THEN
        IF NEW.attempt_count <> OLD.attempt_count + 1
            OR NEW.lease_token <> OLD.lease_token + 1
            OR NEW.lease_owner IS NULL
            OR length(NEW.lease_owner) NOT BETWEEN 1 AND 128
            OR NEW.lease_owner ~ '[[:cntrl:]]'
            OR NEW.lease_expires_at IS NULL OR NEW.lease_expires_at <= current_timestamp
            OR NEW.lease_expires_at >= 'infinity'::timestamptz
            OR NEW.available_at IS DISTINCT FROM OLD.available_at
            OR NEW.last_error_class IS DISTINCT FROM OLD.last_error_class
            OR NEW.started_at IS DISTINCT FROM OLD.started_at
            OR NEW.completed_at IS NOT NULL THEN
          RAISE EXCEPTION 'Invalid archive export job claim or lease reclaim'
            USING ERRCODE='23514', CONSTRAINT='ledger_archive_export_jobs_lease_guard';
        END IF;
        NEW.started_at := COALESCE(OLD.started_at, current_timestamp);
        NEW.updated_at := current_timestamp;
        RETURN NEW;
      END IF;

      IF OLD.status = 'running' AND OLD.lease_expires_at > current_timestamp
          AND NEW.status IN ('retryable', 'failed', 'succeeded') THEN
        IF NEW.attempt_count <> OLD.attempt_count
            OR NEW.lease_token <> OLD.lease_token
            OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
            OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
          RAISE EXCEPTION 'Archive export completion must preserve the active lease fence'
            USING ERRCODE='23514', CONSTRAINT='ledger_archive_export_jobs_lease_guard';
        END IF;

        IF NEW.status = 'retryable' THEN
          IF NEW.available_at < current_timestamp
              OR NEW.available_at >= 'infinity'::timestamptz OR NEW.last_error_class IS NULL
              OR NEW.completed_at IS NOT NULL THEN
            RAISE EXCEPTION 'Invalid retryable archive export outcome'
              USING ERRCODE='23514', CONSTRAINT='ledger_archive_export_jobs_transition_guard';
          END IF;
        ELSIF NEW.status = 'failed' THEN
          IF NEW.available_at IS DISTINCT FROM OLD.available_at
              OR NEW.last_error_class IS NULL OR NEW.completed_at IS NOT NULL THEN
            RAISE EXCEPTION 'Invalid failed archive export outcome'
              USING ERRCODE='23514', CONSTRAINT='ledger_archive_export_jobs_transition_guard';
          END IF;
          NEW.completed_at := current_timestamp;
        ELSE
          IF NEW.available_at IS DISTINCT FROM OLD.available_at
              OR NEW.last_error_class IS NOT NULL OR NEW.completed_at IS NOT NULL THEN
            RAISE EXCEPTION 'Invalid successful archive export outcome'
              USING ERRCODE='23514', CONSTRAINT='ledger_archive_export_jobs_transition_guard';
          END IF;
          SELECT state INTO segment_state
          FROM ledger_archive_segments WHERE segment_id = OLD.segment_id;
          IF segment_state IS NULL OR segment_state NOT IN (
            'verified', 'reader_cutover', 'detached', 'deletable', 'deleted'
          ) THEN
            RAISE EXCEPTION 'Archive export success requires a verified segment'
              USING ERRCODE='23514', CONSTRAINT='ledger_archive_export_jobs_verified_gate';
          END IF;
          NEW.completed_at := current_timestamp;
        END IF;
        NEW.updated_at := current_timestamp;
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'Illegal archive export job lifecycle transition'
        USING ERRCODE='23514', CONSTRAINT='ledger_archive_export_jobs_transition_guard';
    END
    $function$
  `.execute(db);
  await sql`
    CREATE TRIGGER ledger_archive_export_jobs_guard
      BEFORE INSERT OR UPDATE OR DELETE ON ledger_archive_export_jobs
      FOR EACH ROW EXECUTE FUNCTION guard_ledger_archive_export_job()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS ledger_archive_export_jobs_guard ON ledger_archive_export_jobs`.execute(db);
  await sql`
    CREATE OR REPLACE FUNCTION guard_ledger_archive_export_job() RETURNS trigger
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
}

const migration: Migration = { up, down };
export default migration;
