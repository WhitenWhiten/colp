import { sql, type Kysely, type Migration } from 'kysely';

/** Expand-only P5-10 rebuildable per-recipient Feed projection. N-1 ignores it. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE social_feed_items (
    feed_item_id text NOT NULL,
    source_event_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('collection_change','follow_activity')),
    recipient_profile_id text NOT NULL,
    actor_profile_id text NOT NULL,
    collection_id text NOT NULL,
    source_event_version integer NOT NULL CHECK (source_event_version >= 1),
    source_commit_ordinal bigint NOT NULL CHECK (source_commit_ordinal > 0),
    publication_revision text NOT NULL CHECK (length(publication_revision) BETWEEN 1 AND 512),
    discoverability_recheck_key text NOT NULL
      CHECK (length(discoverability_recheck_key) BETWEEN 1 AND 512),
    published_at timestamptz NOT NULL,
    retain_until timestamptz NOT NULL,
    state text NOT NULL DEFAULT 'visible',
    withdrawn_at timestamptz,
    withdrawal_reason text,
    created_at timestamptz NOT NULL DEFAULT current_timestamp,
    CONSTRAINT social_feed_items_pkey PRIMARY KEY (feed_item_id),
    CONSTRAINT social_feed_items_event_recipient_key
      UNIQUE (source_event_id,recipient_profile_id),
    CONSTRAINT social_feed_items_recipient_fk FOREIGN KEY (recipient_profile_id)
      REFERENCES profiles(account_id) ON DELETE CASCADE,
    CONSTRAINT social_feed_items_actor_fk FOREIGN KEY (actor_profile_id)
      REFERENCES profiles(account_id) ON DELETE CASCADE,
    CONSTRAINT social_feed_items_collection_fk FOREIGN KEY (collection_id)
      REFERENCES collections(id) ON DELETE CASCADE,
    CONSTRAINT social_feed_items_identity_lengths CHECK (
      length(feed_item_id) BETWEEN 1 AND 128
      AND length(source_event_id) BETWEEN 1 AND 128
    ),
    CONSTRAINT social_feed_items_recheck_binding CHECK (
      discoverability_recheck_key = 'publication.collection:' || collection_id
    ),
    CONSTRAINT social_feed_items_time_finite CHECK (
      published_at > '-infinity'::timestamptz AND published_at < 'infinity'::timestamptz
      AND retain_until > '-infinity'::timestamptz AND retain_until < 'infinity'::timestamptz
      AND created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz
      AND (withdrawn_at IS NULL OR (
        withdrawn_at > '-infinity'::timestamptz AND withdrawn_at < 'infinity'::timestamptz
      ))
    ),
    CONSTRAINT social_feed_items_retention_window CHECK (
      retain_until = published_at + interval '90 days'
    ),
    CONSTRAINT social_feed_items_state_shape CHECK (
      (state = 'visible' AND withdrawn_at IS NULL AND withdrawal_reason IS NULL)
      OR
      (state = 'withdrawn' AND withdrawn_at IS NOT NULL
        AND withdrawal_reason IS NOT NULL
        AND withdrawal_reason IN ('source_removed','discoverability_revoked','unfollowed'))
    )
  )`.execute(db);

  await sql`COMMENT ON TABLE social_feed_items IS
    'Rebuildable per-recipient projection; stores only stable locators and recheck facts, never private content.'`.execute(db);
  await sql`CREATE INDEX social_feed_items_recipient_page_idx
    ON social_feed_items(
      recipient_profile_id,published_at DESC,source_event_id DESC,feed_item_id DESC
    ) WHERE state='visible'`.execute(db);
  await sql`CREATE INDEX social_feed_items_recipient_kind_page_idx
    ON social_feed_items(
      recipient_profile_id,kind,published_at DESC,source_event_id DESC,feed_item_id DESC
    ) WHERE state='visible'`.execute(db);
  await sql`CREATE INDEX social_feed_items_retention_idx
    ON social_feed_items(retain_until,feed_item_id)`.execute(db);

  await sql`CREATE FUNCTION guard_social_feed_item_transition() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'visible' OR NEW.withdrawn_at IS NOT NULL
           OR NEW.withdrawal_reason IS NOT NULL THEN
          RAISE EXCEPTION 'Illegal initial social Feed item state'
            USING ERRCODE = '23514', CONSTRAINT = 'social_feed_items_transition_guard';
        END IF;
        RETURN NEW;
      END IF;
      IF NEW.feed_item_id IS DISTINCT FROM OLD.feed_item_id
         OR NEW.source_event_id IS DISTINCT FROM OLD.source_event_id
         OR NEW.kind IS DISTINCT FROM OLD.kind
         OR NEW.recipient_profile_id IS DISTINCT FROM OLD.recipient_profile_id
         OR NEW.actor_profile_id IS DISTINCT FROM OLD.actor_profile_id
         OR NEW.collection_id IS DISTINCT FROM OLD.collection_id
         OR NEW.source_event_version IS DISTINCT FROM OLD.source_event_version
         OR NEW.source_commit_ordinal IS DISTINCT FROM OLD.source_commit_ordinal
         OR NEW.publication_revision IS DISTINCT FROM OLD.publication_revision
         OR NEW.discoverability_recheck_key IS DISTINCT FROM OLD.discoverability_recheck_key
         OR NEW.published_at IS DISTINCT FROM OLD.published_at
         OR NEW.retain_until IS DISTINCT FROM OLD.retain_until
         OR NEW.created_at IS DISTINCT FROM OLD.created_at
         OR OLD.state = 'withdrawn'
         OR NOT (OLD.state = 'visible' AND NEW.state = 'withdrawn') THEN
        RAISE EXCEPTION 'Illegal social Feed item transition'
          USING ERRCODE = '23514', CONSTRAINT = 'social_feed_items_transition_guard';
      END IF;
      RETURN NEW;
    END
    $function$`.execute(db);
  await sql`CREATE TRIGGER social_feed_items_transition_guard
    BEFORE INSERT OR UPDATE ON social_feed_items FOR EACH ROW
    EXECUTE FUNCTION guard_social_feed_item_transition()`.execute(db);

  await sql`CREATE TABLE social_feed_watermarks (
    aggregate_scope text NOT NULL,
    projection_state text NOT NULL DEFAULT 'live',
    last_commit_ordinal bigint NOT NULL DEFAULT 0 CHECK (last_commit_ordinal >= 0),
    last_source_event_id text,
    rebuild_generation bigint NOT NULL DEFAULT 0 CHECK (rebuild_generation >= 0),
    rebuild_high_commit_ordinal bigint,
    rebuild_replayed_commit_ordinal bigint,
    state_revision bigint NOT NULL DEFAULT 0 CHECK (state_revision >= 0),
    state_updated_at timestamptz NOT NULL DEFAULT current_timestamp,
    CONSTRAINT social_feed_watermarks_pkey PRIMARY KEY (aggregate_scope),
    CONSTRAINT social_feed_watermarks_scope_length
      CHECK (length(aggregate_scope) BETWEEN 1 AND 512),
    CONSTRAINT social_feed_watermarks_state_shape CHECK (
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
    )
  )`.execute(db);

  await sql`CREATE FUNCTION guard_social_feed_watermark_transition() RETURNS trigger
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
  await sql`CREATE TRIGGER social_feed_watermarks_transition_guard
    BEFORE INSERT OR UPDATE ON social_feed_watermarks FOR EACH ROW
    EXECUTE FUNCTION guard_social_feed_watermark_transition()`.execute(db);
}

/** Developer-only destructive rollback; drain P5-10 writers before migrating down. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS social_feed_watermarks`.execute(db);
  await sql`DROP FUNCTION IF EXISTS guard_social_feed_watermark_transition()`.execute(db);
  await sql`DROP TABLE IF EXISTS social_feed_items`.execute(db);
  await sql`DROP FUNCTION IF EXISTS guard_social_feed_item_transition()`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
