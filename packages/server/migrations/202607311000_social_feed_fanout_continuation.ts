import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Expand-only R5-02 Feed fan-out continuation storage.
 * N-1 binaries ignore the new watermark columns and fan-out index.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE social_feed_watermarks
    ADD COLUMN fanout_source_event_id text,
    ADD COLUMN fanout_commit_ordinal bigint,
    ADD COLUMN fanout_after_recipient_profile_id text,
    ADD COLUMN fanout_candidate_count bigint,
    ADD COLUMN fanout_started_at timestamptz,
    ADD CONSTRAINT social_feed_watermarks_fanout_tuple CHECK (
      (
        fanout_source_event_id IS NULL
        AND fanout_commit_ordinal IS NULL
        AND fanout_after_recipient_profile_id IS NULL
        AND fanout_candidate_count IS NULL
        AND fanout_started_at IS NULL
      )
      OR
      (
        fanout_source_event_id IS NOT NULL
        AND length(fanout_source_event_id) BETWEEN 1 AND 128
        AND fanout_commit_ordinal IS NOT NULL
        AND fanout_commit_ordinal > last_commit_ordinal
        AND fanout_candidate_count IS NOT NULL
        AND fanout_candidate_count >= 0
        AND fanout_started_at IS NOT NULL
        AND fanout_started_at > '-infinity'::timestamptz
        AND fanout_started_at < 'infinity'::timestamptz
        AND (
          fanout_after_recipient_profile_id IS NULL
          OR length(fanout_after_recipient_profile_id) BETWEEN 1 AND 256
        )
      )
    )`.execute(db);

  await sql`COMMENT ON COLUMN social_feed_watermarks.fanout_source_event_id IS
    'Durable live fan-out source event id while continuation is running; null when idle.'`.execute(db);
  await sql`COMMENT ON COLUMN social_feed_watermarks.fanout_commit_ordinal IS
    'Commit ordinal of the in-progress live fan-out; must exceed last_commit_ordinal.'`.execute(db);
  await sql`COMMENT ON COLUMN social_feed_watermarks.fanout_after_recipient_profile_id IS
    'Keyset cursor after the last processed follower Profile id; null starts the first page.'`.execute(db);
  await sql`COMMENT ON COLUMN social_feed_watermarks.fanout_candidate_count IS
    'Observed candidate count for the in-progress fan-out run; null when idle.'`.execute(db);
  await sql`COMMENT ON COLUMN social_feed_watermarks.fanout_started_at IS
    'Finite PostgreSQL time when the current fan-out run began; null when idle.'`.execute(db);

  await sql`CREATE INDEX follows_target_actor_fanout_idx
    ON follows(target_profile_id, actor_profile_id ASC)
    INCLUDE (followed_at)`.execute(db);
}

/**
 * Developer-only rollback of the expand-only fan-out storage.
 * Drain R5-03+ continuation writers before migrating down; page indexes are retained.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS follows_target_actor_fanout_idx`.execute(db);
  await sql`ALTER TABLE social_feed_watermarks
    DROP CONSTRAINT IF EXISTS social_feed_watermarks_fanout_tuple,
    DROP COLUMN IF EXISTS fanout_source_event_id,
    DROP COLUMN IF EXISTS fanout_commit_ordinal,
    DROP COLUMN IF EXISTS fanout_after_recipient_profile_id,
    DROP COLUMN IF EXISTS fanout_candidate_count,
    DROP COLUMN IF EXISTS fanout_started_at`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
