import { sql, type Kysely, type Migration } from 'kysely';

/**
 * FO-07 review P1-1: pre-feature uploads must never be eaten by automatic jobs.
 *
 * Before this project shipped, every `bookmark_icons` binding was a manual
 * upload (or an extension capture posted through the same raw-image path) and
 * `bookmark_icon_sources` did not exist. With no source row the projection and
 * the worker read the state as `inherit`, so once the owner enables an online
 * default (or fillMissing) the refresh_online/fill candidate selection treats
 * those legacy bindings as auto-capturable online nodes and silently REPLACES
 * the user's uploaded icon — violating the fixed contract "自动任务（普通
 * capture、fill、refresh 和 URL 变化）不得覆盖 uploaded" and the invariant
 * "sourceMode=uploaded 只能通过真实上传进入".
 *
 * This migration backfills an `uploaded` source row for every live binding
 * that has none. The row uses the virtual revision 1 (the same value the
 * missing-row default exposes), so entity-tag semantics are unchanged, and
 * `source_mode = 'uploaded'` excludes the node from refresh_online / fill /
 * single-node refresh forever, while `forceAllOnline` and explicit user
 * actions still work as usual. On a fresh deployment this is a no-op; it is
 * the required data upgrade for any pre-feature deployment.
 *
 * Idempotent: the LEFT JOIN + ON CONFLICT make re-runs and concurrent runs
 * safe; rows that already exist (e.g. written after the feature shipped) are
 * never touched.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    INSERT INTO bookmark_icon_sources (node_id, collection_id, source_mode, revision, updated_at)
    SELECT bi.node_id, bi.collection_id, 'uploaded', 1, bi.updated_at
    FROM bookmark_icons bi
    JOIN nodes n ON n.id = bi.node_id AND n.deleted_at IS NULL AND n.kind = 'bookmark'
    LEFT JOIN bookmark_icon_sources s ON s.node_id = bi.node_id
    WHERE s.node_id IS NULL
    ON CONFLICT (node_id) DO NOTHING
  `.execute(db);
}

/**
 * Developer-only rollback: remove exactly the backfilled rows. Genuine uploads
 * written after the feature shipped always carry revision >= 2 (the first
 * write inserts revision 2 or advances an existing row past 1), so
 * `source_mode = 'uploaded' AND revision = 1` identifies precisely the rows
 * this migration created.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM bookmark_icon_sources
    WHERE source_mode = 'uploaded' AND revision = 1
  `.execute(db);
}

export const migration: Migration = { up, down };
export default migration;