import { sql, type Kysely, type Migration } from 'kysely';

/**
 * ADR-0021 expand-only: collection organize plans (OG-01). Authz is
 * application-side (account_id = session principal). N-1 binaries ignore
 * the table. Apply columns are stored now and filled by OG-02.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE collection_organize_plans (
    plan_id text NOT NULL,
    account_id text NOT NULL,
    collection_id text NOT NULL,
    collection_revision text NOT NULL,
    planner_id text NOT NULL,
    status text NOT NULL CHECK (status IN ('open','applied','expired')),
    expires_at timestamptz NOT NULL,
    etag text NOT NULL,
    truncated boolean NOT NULL,
    actions jsonb NOT NULL,
    applied_action_ids jsonb,
    apply_receipt jsonb,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT collection_organize_plans_pkey PRIMARY KEY (plan_id),
    CONSTRAINT collection_organize_plans_identity_lengths CHECK (
      length(plan_id) BETWEEN 1 AND 128
      AND length(account_id) BETWEEN 1 AND 128
      AND length(collection_id) BETWEEN 1 AND 128
      AND length(collection_revision) BETWEEN 1 AND 128
      AND length(planner_id) BETWEEN 1 AND 128
      AND length(etag) BETWEEN 3 AND 256
    ),
    CONSTRAINT collection_organize_plans_planner_id_shape CHECK (
      planner_id ~ '^heuristic\\.v1\\.[a-z0-9_]+$'
    ),
    CONSTRAINT collection_organize_plans_time_finite CHECK (
      created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz
      AND updated_at > '-infinity'::timestamptz AND updated_at < 'infinity'::timestamptz
      AND expires_at > '-infinity'::timestamptz AND expires_at < 'infinity'::timestamptz
    )
  )`.execute(db);

  await sql`COMMENT ON TABLE collection_organize_plans IS
    'Owner organize plans; GET/POST create consume this table. No Postgres RLS.'`.execute(db);

  await sql`CREATE UNIQUE INDEX collection_organize_plans_account_collection_open_uidx
    ON collection_organize_plans (account_id, collection_id)
    WHERE status = 'open'`.execute(db);

  await sql`CREATE INDEX collection_organize_plans_expires_at_idx
    ON collection_organize_plans (expires_at)`.execute(db);
}

/** Developer-only destructive rollback; drain organize-plan writers first. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS collection_organize_plans`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
