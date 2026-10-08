import { sql, type Kysely } from 'kysely';

/**
 * LP-03: link preview worker scheduling.
 *
 * `link_preview_collection_sweeps` remembers which content revision of a
 * public or unlisted collection was last enqueued, so the worker's sweep
 * picks up newly published collections, edits, and (on its periodic re-sweep)
 * keeps still-published URLs from being pruned. It doubles as the backfill.
 *
 * Every target status becomes claimable when `next_attempt_at` is due:
 * terminal outcomes park at 'infinity' and an enqueue makes a stale row due
 * again. The status-filtered index from LP-01 therefore becomes a full one.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE link_preview_collection_sweeps (
      collection_id    text PRIMARY KEY REFERENCES collections(id) ON DELETE CASCADE,
      content_revision text,
      swept_at         timestamptz,
      lease_owner      uuid,
      lease_until      timestamptz
    )
  `.execute(db);
  await sql`DROP INDEX link_preview_targets_due`.execute(db);
  await sql`CREATE INDEX link_preview_targets_due ON link_preview_targets (next_attempt_at)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX link_preview_targets_due`.execute(db);
  await sql`
    CREATE INDEX link_preview_targets_due ON link_preview_targets (next_attempt_at)
      WHERE status IN ('pending', 'failed')
  `.execute(db);
  await sql`DROP TABLE link_preview_collection_sweeps`.execute(db);
}
