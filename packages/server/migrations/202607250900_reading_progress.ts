import { sql, type Kysely } from 'kysely';

/** Expand-only P2B-18 private Reading Progress authority. N-1 binaries ignore these rows. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE reading_progress (
    id bigserial PRIMARY KEY,
    account_id text NOT NULL,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    status text NOT NULL,
    progress numeric(6,5) NOT NULL,
    revision integer NOT NULL,
    completed_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT reading_progress_account_fk FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
    CONSTRAINT reading_progress_target_type_check CHECK (resource_type IN ('collection','node')),
    CONSTRAINT reading_progress_target_id_check CHECK (length(resource_id) BETWEEN 1 AND 512),
    CONSTRAINT reading_progress_status_check CHECK (status IN ('not_started','in_progress','completed')),
    CONSTRAINT reading_progress_value_range_check CHECK (progress >= 0 AND progress <= 1),
    CONSTRAINT reading_progress_state_value_check CHECK (
      (status='not_started' AND progress=0) OR
      (status='in_progress' AND progress>0 AND progress<1) OR
      (status='completed' AND progress=1)
    ),
    CONSTRAINT reading_progress_revision_check CHECK (revision > 0),
    CONSTRAINT reading_progress_time_order_check CHECK (updated_at >= created_at),
    CONSTRAINT reading_progress_completed_facts_check CHECK (
      (status='completed' AND completed_at IS NOT NULL AND completed_at >= created_at AND completed_at <= updated_at) OR
      (status<>'completed' AND completed_at IS NULL)
    ),
    CONSTRAINT reading_progress_account_target_key UNIQUE (account_id,resource_type,resource_id)
  )`.execute(db);
  await sql`CREATE INDEX reading_progress_account_updated_idx
    ON reading_progress(account_id,updated_at DESC,resource_type ASC,resource_id ASC)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS reading_progress`.execute(db);
}
