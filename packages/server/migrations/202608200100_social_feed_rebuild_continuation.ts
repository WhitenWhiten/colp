import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Expand-only rebuild continuation (FIX-M-027): adds the durable rebuild start instant used by
 * operations progress/ETA, and relaxes the live->rebuilding transition so a sparse retained
 * window can start replay from (window lo - 1) instead of ordinal 0. N-1 binaries ignore the
 * new column; the watermark CHECK and transition guard are replaced in place with the same names.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE social_feed_watermarks
    ADD COLUMN rebuild_started_at timestamptz`.execute(db);
  await sql`UPDATE social_feed_watermarks
    SET rebuild_started_at = state_updated_at
    WHERE projection_state = 'rebuilding' AND rebuild_started_at IS NULL`.execute(db);

  await sql`ALTER TABLE social_feed_watermarks
    DROP CONSTRAINT IF EXISTS social_feed_watermarks_state_shape`.execute(db);
  await sql`ALTER TABLE social_feed_watermarks
    ADD CONSTRAINT social_feed_watermarks_state_shape CHECK (
      ((last_commit_ordinal = 0 AND last_source_event_id IS NULL)
        OR (last_commit_ordinal > 0 AND last_source_event_id IS NOT NULL
          AND length(last_source_event_id) BETWEEN 1 AND 128))
      AND
      ((projection_state = 'live' AND rebuild_started_at IS NULL
          AND rebuild_high_commit_ordinal IS NULL
          AND rebuild_replayed_commit_ordinal IS NULL)
        OR (projection_state = 'rebuilding' AND rebuild_started_at IS NOT NULL
          AND rebuild_started_at > '-infinity'::timestamptz
          AND rebuild_started_at < 'infinity'::timestamptz
          AND rebuild_high_commit_ordinal IS NOT NULL
          AND rebuild_replayed_commit_ordinal IS NOT NULL
          AND rebuild_replayed_commit_ordinal >= 0
          AND rebuild_replayed_commit_ordinal <= rebuild_high_commit_ordinal))
      AND state_updated_at > '-infinity'::timestamptz
      AND state_updated_at < 'infinity'::timestamptz
    )`.execute(db);

  await sql`CREATE OR REPLACE FUNCTION guard_social_feed_watermark_transition() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.projection_state <> 'live' OR NEW.last_commit_ordinal <> 0
           OR NEW.last_source_event_id IS NOT NULL OR NEW.rebuild_generation <> 0
           OR NEW.rebuild_high_commit_ordinal IS NOT NULL
           OR NEW.rebuild_replayed_commit_ordinal IS NOT NULL
           OR NEW.rebuild_started_at IS NOT NULL
           OR NEW.state_revision <> 0 THEN
          RAISE EXCEPTION 'Illegal initial social Feed watermark state'
            USING ERRCODE = '23514', CONSTRAINT = 'social_feed_watermarks_transition_guard';
        END IF;
        RETURN NEW;
      END IF;
      IF NEW.aggregate_scope IS DISTINCT FROM OLD.aggregate_scope
         OR NEW.state_revision <> OLD.state_revision + 1
         OR NEW.last_commit_ordinal < OLD.last_commit_ordinal
         OR (NEW.last_commit_ordinal = OLD.last_commit_ordinal
           AND NEW.last_source_event_id IS DISTINCT FROM OLD.last_source_event_id)
         OR NOT (
           (OLD.projection_state = 'live' AND NEW.projection_state = 'live'
             AND NEW.rebuild_generation = OLD.rebuild_generation
             AND NEW.rebuild_high_commit_ordinal IS NULL
             AND NEW.rebuild_replayed_commit_ordinal IS NULL
             AND NEW.rebuild_started_at IS NULL)
           OR
           (OLD.projection_state = 'live' AND NEW.projection_state = 'rebuilding'
             AND NEW.rebuild_generation = OLD.rebuild_generation + 1
             AND NEW.rebuild_high_commit_ordinal >= OLD.last_commit_ordinal
             AND NEW.rebuild_replayed_commit_ordinal >= 0
             AND NEW.rebuild_started_at IS NOT NULL)
           OR
           (OLD.projection_state = 'rebuilding' AND NEW.projection_state = 'rebuilding'
             AND NEW.rebuild_generation = OLD.rebuild_generation
             AND NEW.rebuild_high_commit_ordinal = OLD.rebuild_high_commit_ordinal
             AND NEW.rebuild_replayed_commit_ordinal >= OLD.rebuild_replayed_commit_ordinal
             AND NEW.rebuild_started_at = OLD.rebuild_started_at)
           OR
           (OLD.projection_state = 'rebuilding' AND NEW.projection_state = 'live'
             AND NEW.rebuild_generation = OLD.rebuild_generation
             AND NEW.rebuild_high_commit_ordinal IS NULL
             AND NEW.rebuild_replayed_commit_ordinal IS NULL
             AND NEW.rebuild_started_at IS NULL
             AND OLD.rebuild_replayed_commit_ordinal >= OLD.rebuild_high_commit_ordinal)
         ) THEN
        RAISE EXCEPTION 'Illegal social Feed watermark transition'
          USING ERRCODE = '23514', CONSTRAINT = 'social_feed_watermarks_transition_guard';
      END IF;
      RETURN NEW;
    END
    $function$`.execute(db);

  await sql`COMMENT ON COLUMN social_feed_watermarks.rebuild_started_at IS
    'Instant the current rebuild generation began; null while live.'`.execute(db);
}

/**
 * Developer-only rollback of the rebuild continuation storage.
 * Drain in-flight rebuilds before migrating down; the transition guard is restored verbatim.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION guard_social_feed_watermark_transition() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.projection_state <> 'live' OR NEW.last_commit_ordinal <> 0
           OR NEW.last_source_event_id IS NOT NULL OR NEW.rebuild_generation <> 0
           OR NEW.rebuild_high_commit_ordinal IS NOT NULL
           OR NEW.rebuild_replayed_commit_ordinal IS NOT NULL
           OR NEW.state_revision <> 0 THEN
          RAISE EXCEPTION 'Illegal initial social Feed watermark state'
            USING ERRCODE = '23514', CONSTRAINT = 'social_feed_watermarks_transition_guard';
        END IF;
        RETURN NEW;
      END IF;
      IF NEW.aggregate_scope IS DISTINCT FROM OLD.aggregate_scope
         OR NEW.state_revision <> OLD.state_revision + 1
         OR NEW.last_commit_ordinal < OLD.last_commit_ordinal
         OR (NEW.last_commit_ordinal = OLD.last_commit_ordinal
           AND NEW.last_source_event_id IS DISTINCT FROM OLD.last_source_event_id)
         OR NOT (
           (OLD.projection_state = 'live' AND NEW.projection_state = 'live'
             AND NEW.rebuild_generation = OLD.rebuild_generation
             AND NEW.rebuild_high_commit_ordinal IS NULL
             AND NEW.rebuild_replayed_commit_ordinal IS NULL)
           OR
           (OLD.projection_state = 'live' AND NEW.projection_state = 'rebuilding'
             AND NEW.rebuild_generation = OLD.rebuild_generation + 1
             AND NEW.rebuild_high_commit_ordinal >= OLD.last_commit_ordinal
             AND NEW.rebuild_replayed_commit_ordinal = 0)
           OR
           (OLD.projection_state = 'rebuilding' AND NEW.projection_state = 'rebuilding'
             AND NEW.rebuild_generation = OLD.rebuild_generation
             AND NEW.rebuild_high_commit_ordinal = OLD.rebuild_high_commit_ordinal
             AND NEW.rebuild_replayed_commit_ordinal >= OLD.rebuild_replayed_commit_ordinal)
           OR
           (OLD.projection_state = 'rebuilding' AND NEW.projection_state = 'live'
             AND NEW.rebuild_generation = OLD.rebuild_generation
             AND NEW.rebuild_high_commit_ordinal IS NULL
             AND NEW.rebuild_replayed_commit_ordinal IS NULL
             AND OLD.rebuild_replayed_commit_ordinal >= OLD.rebuild_high_commit_ordinal)
         ) THEN
        RAISE EXCEPTION 'Illegal social Feed watermark transition'
          USING ERRCODE = '23514', CONSTRAINT = 'social_feed_watermarks_transition_guard';
      END IF;
      RETURN NEW;
    END
    $function$`.execute(db);

  await sql`ALTER TABLE social_feed_watermarks
    DROP CONSTRAINT IF EXISTS social_feed_watermarks_state_shape`.execute(db);
  await sql`ALTER TABLE social_feed_watermarks
    ADD CONSTRAINT social_feed_watermarks_state_shape CHECK (
      ((last_commit_ordinal = 0 AND last_source_event_id IS NULL)
        OR (last_commit_ordinal > 0 AND last_source_event_id IS NOT NULL
          AND length(last_source_event_id) BETWEEN 1 AND 128))
      AND
      ((projection_state = 'live' AND rebuild_high_commit_ordinal IS NULL
          AND rebuild_replayed_commit_ordinal IS NULL)
        OR (projection_state = 'rebuilding'
          AND rebuild_high_commit_ordinal IS NOT NULL
          AND rebuild_replayed_commit_ordinal IS NOT NULL
          AND rebuild_replayed_commit_ordinal >= 0
          AND rebuild_replayed_commit_ordinal <= rebuild_high_commit_ordinal))
      AND state_updated_at > '-infinity'::timestamptz
      AND state_updated_at < 'infinity'::timestamptz
    )`.execute(db);

  await sql`ALTER TABLE social_feed_watermarks
    DROP COLUMN IF EXISTS rebuild_started_at`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
