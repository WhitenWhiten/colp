import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Expand-only per-subject sidebar Library order preference. One row per
 * (subject, sidebar section) holding the ordered Collection id list the
 * /library desk renders that section with. N-1 binaries ignore this table.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE library_sidebar_orders (
    subject_id text NOT NULL,
    section text NOT NULL CHECK (section IN ('mine','shared','following')),
    collection_ids jsonb NOT NULL CHECK (jsonb_typeof(collection_ids) = 'array'),
    updated_at timestamptz NOT NULL DEFAULT current_timestamp,
    CONSTRAINT library_sidebar_orders_pkey PRIMARY KEY (subject_id,section),
    CONSTRAINT library_sidebar_orders_updated_at_finite CHECK (
      updated_at > '-infinity'::timestamptz AND updated_at < 'infinity'::timestamptz
    )
  )`.execute(db);
  await sql`COMMENT ON COLUMN library_sidebar_orders.subject_id IS
    'Stable subject identity (accounts.subject_id); intentionally not a foreign key, matching collections.owner_subject_id.'`.execute(db);
  await sql`COMMENT ON COLUMN library_sidebar_orders.section IS
    'Sidebar section of the /library desk: mine, shared, or following.'`.execute(db);
  await sql`COMMENT ON COLUMN library_sidebar_orders.collection_ids IS
    'Ordered jsonb array of Collection OpaqueIds; ids the reader cannot see anymore are skipped by clients.'`.execute(db);
}

/** Developer-only destructive rollback; the preference is safe to drop. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS library_sidebar_orders`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
