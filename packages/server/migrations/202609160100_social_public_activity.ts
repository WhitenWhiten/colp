import { sql, type Kysely, type Migration } from 'kysely';

/**
 * ADR-0021 / 02 §4.2 expand-only: actor-scoped rebuildable public Activity
 * projection. Stores locators only, never title/slug. N-1 binaries ignore
 * the table.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE social_public_activity (
    activity_id text NOT NULL,
    source_event_id text NOT NULL,
    actor_profile_id text NOT NULL,
    collection_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('collection_change')),
    published_at timestamptz NOT NULL,
    publication_revision text NOT NULL CHECK (length(publication_revision) BETWEEN 1 AND 512),
    discoverability_recheck_key text NOT NULL
      CHECK (length(discoverability_recheck_key) BETWEEN 1 AND 512),
    state text NOT NULL DEFAULT 'visible',
    withdrawn_at timestamptz,
    withdrawal_reason text,
    created_at timestamptz NOT NULL DEFAULT current_timestamp,
    CONSTRAINT social_public_activity_pkey PRIMARY KEY (activity_id),
    CONSTRAINT social_public_activity_source_event_key UNIQUE (source_event_id),
    CONSTRAINT social_public_activity_actor_fk FOREIGN KEY (actor_profile_id)
      REFERENCES profiles(account_id) ON DELETE CASCADE,
    CONSTRAINT social_public_activity_collection_fk FOREIGN KEY (collection_id)
      REFERENCES collections(id) ON DELETE CASCADE,
    CONSTRAINT social_public_activity_identity_lengths CHECK (
      length(activity_id) BETWEEN 1 AND 128
      AND length(source_event_id) BETWEEN 1 AND 128
    ),
    CONSTRAINT social_public_activity_recheck_binding CHECK (
      discoverability_recheck_key = 'publication.collection:' || collection_id
    ),
    CONSTRAINT social_public_activity_time_finite CHECK (
      published_at > '-infinity'::timestamptz AND published_at < 'infinity'::timestamptz
      AND created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz
      AND (withdrawn_at IS NULL OR (
        withdrawn_at > '-infinity'::timestamptz AND withdrawn_at < 'infinity'::timestamptz
      ))
    ),
    CONSTRAINT social_public_activity_state_shape CHECK (
      (state = 'visible' AND withdrawn_at IS NULL AND withdrawal_reason IS NULL)
      OR
      (state = 'withdrawn' AND withdrawn_at IS NOT NULL
        AND withdrawal_reason IS NOT NULL
        AND withdrawal_reason IN ('source_removed','discoverability_revoked'))
    )
  )`.execute(db);

  await sql`COMMENT ON TABLE social_public_activity IS
    'Actor-scoped rebuildable projection; stores locators only, never title/slug.'`.execute(db);
  await sql`CREATE INDEX social_public_activity_actor_page_idx
    ON social_public_activity(
      actor_profile_id,published_at DESC,source_event_id DESC,activity_id DESC
    ) WHERE state='visible'`.execute(db);
}

/** Developer-only destructive rollback; drain PA-01 writers before migrating down. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS social_public_activity`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
