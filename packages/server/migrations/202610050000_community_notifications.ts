import { sql, type Kysely, type Migration } from 'kysely';

/**
 * CS-05 community reply notifications: extend the durable notification
 * authority (created by 202607290200_notification_authority and hardened by
 * 202608090100_notification_retention_state_contract) with the community
 * reply kind. This migration is expand-only:
 *
 *   notifications.notification_type        += 'comment_reply'
 *   notifications.subject_type             += 'community_comment'
 *   notification_preferences.channel       += 'community'
 *
 * No existing type, lifecycle guard, retention invariant, or index is
 * weakened. The comment_reply shape CHECK pins the only row form the worker
 * writes (a community_comment subject plus a known actor profile — the
 * inbox reader resolves subject_id -> community_comments.comment_id). The
 * partial recipient index keeps the community inbox page and unread-count
 * scans off the shared recipient index, preserving the legacy query plan;
 * the legacy inbox narrows to its own kinds in code, so community rows are
 * concealed from it by the same authority.
 *
 * Expand-only: widened CHECKs, one additive CHECK, one additive index.
 * Empty `down` leaves objects in place, so `up` must be re-entrant after
 * Kysely forgets the migration row.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_notification_type_check`.execute(db);
  await sql`ALTER TABLE notifications ADD CONSTRAINT notifications_notification_type_check
    CHECK (notification_type IN ('collection_change','follow_activity','comment_reply'))`.execute(db);

  await sql`ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_subject_type_check`.execute(db);
  await sql`ALTER TABLE notifications ADD CONSTRAINT notifications_subject_type_check
    CHECK (subject_type IN ('collection','profile','community_comment'))`.execute(db);

  await sql`ALTER TABLE notification_preferences DROP CONSTRAINT IF EXISTS notification_preferences_channel_check`.execute(db);
  await sql`ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_channel_check
    CHECK (channel IN ('in_app','email','community'))`.execute(db);

  // comment_reply rows always bind a community comment subject and a known
  // actor profile — the worker inserts only this shape and the reader relies
  // on subject_id -> community_comments.comment_id.
  await sql`ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_comment_reply_shape`.execute(db);
  await sql`ALTER TABLE notifications ADD CONSTRAINT notifications_comment_reply_shape
    CHECK (notification_type <> 'comment_reply'
      OR (subject_type = 'community_comment' AND actor_profile_id IS NOT NULL))`.execute(db);

  // Partial index keeps the community inbox page + unread-count scans off
  // the shared recipient index and preserves the legacy query plan.
  await sql`CREATE INDEX IF NOT EXISTS notifications_recipient_community_page_idx
    ON notifications (recipient_account_id, occurred_at DESC, notification_id DESC)
    WHERE notification_type = 'comment_reply'`.execute(db);
}

/** Expand-only contract: production rollback is flag-off; never run migration down. */
export async function down(_db: Kysely<unknown>): Promise<void> {
  // Intentionally empty. Widened CHECKs and the additive index are retained for rollback safety.
}

export const migration: Migration = { up, down };
export default migration;
