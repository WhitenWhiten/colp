import { sql, type Kysely, type Migration } from 'kysely';

/**
 * ADR-0021 expand-only: collection tree versions (HV-01). Authz is
 * application-side (account_id = session principal). N-1 binaries ignore
 * the table. Restore receipts are intentionally not created in this migration.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE collection_tree_versions (
    version_id text NOT NULL,
    account_id text NOT NULL,
    collection_id text NOT NULL,
    content_revision text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('manual','pre_restore','pre_mutation')),
    label text NOT NULL,
    etag text NOT NULL,
    node_count integer NOT NULL,
    tree_json jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    CONSTRAINT collection_tree_versions_pkey PRIMARY KEY (version_id),
    CONSTRAINT collection_tree_versions_identity_lengths CHECK (
      length(version_id) BETWEEN 1 AND 128
      AND length(account_id) BETWEEN 1 AND 128
      AND length(collection_id) BETWEEN 1 AND 128
      AND length(content_revision) BETWEEN 1 AND 128
      AND length(label) BETWEEN 1 AND 80
      AND length(etag) BETWEEN 3 AND 256
    ),
    CONSTRAINT collection_tree_versions_node_count_nonnegative CHECK (node_count >= 0),
    CONSTRAINT collection_tree_versions_time_finite CHECK (
      created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz
    )
  )`.execute(db);

  await sql`COMMENT ON TABLE collection_tree_versions IS
    'Owner collection live-tree snapshots; GET/POST create consume this table. No Postgres RLS.'`.execute(db);

  await sql`CREATE UNIQUE INDEX collection_tree_versions_collection_revision_uidx
    ON collection_tree_versions (collection_id, content_revision)`.execute(db);

  await sql`CREATE INDEX collection_tree_versions_collection_created_idx
    ON collection_tree_versions (collection_id, created_at DESC, version_id DESC)`.execute(db);
}

/** Developer-only destructive rollback; drain collection-version writers first. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS collection_tree_versions`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
