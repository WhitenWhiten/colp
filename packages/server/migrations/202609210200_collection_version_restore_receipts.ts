import { sql, type Kysely, type Migration } from 'kysely';

/**
 * ADR-0021 expand-only: collection version restore receipts (HV-02). Authz is
 * application-side (account_id = session principal). N-1 binaries ignore
 * the table. No Postgres RLS. Outer Known-Command-Id replay stays on
 * product_command_receipts; this table stores the restore DTO and inner
 * command-id mapping only.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE collection_version_restore_receipts (
    command_id text NOT NULL,
    version_id text NOT NULL,
    collection_id text NOT NULL,
    account_id text NOT NULL,
    inner_commands jsonb NOT NULL,
    result_json jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    CONSTRAINT collection_version_restore_receipts_pkey PRIMARY KEY (command_id),
    CONSTRAINT collection_version_restore_receipts_identity_lengths CHECK (
      length(command_id) BETWEEN 1 AND 128
      AND length(version_id) BETWEEN 1 AND 128
      AND length(collection_id) BETWEEN 1 AND 128
      AND length(account_id) BETWEEN 1 AND 128
    ),
    CONSTRAINT collection_version_restore_receipts_time_finite CHECK (
      created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz
    )
  )`.execute(db);

  await sql`COMMENT ON TABLE collection_version_restore_receipts IS
    'Restore result DTO and inner command-id map; consumed by POST restore. No Postgres RLS.'`.execute(db);
}

/** Developer-only destructive rollback; drain collection-version restore writers first. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS collection_version_restore_receipts`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
