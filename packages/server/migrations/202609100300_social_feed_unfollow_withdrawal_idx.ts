import { sql, type Kysely, type Migration } from 'kysely';

/**
 * P-03 expand-only indexes for paged Unfollow Feed withdrawal.
 * Existing recipient page indexes do not include actor_profile_id.
 * N-1 binaries ignore these indexes.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX social_feed_items_unfollow_withdrawal_idx
      ON social_feed_items (
        recipient_profile_id, actor_profile_id, kind, published_at, feed_item_id
      )
      WHERE state = 'visible'
  `.execute(db);
  await sql`
    CREATE INDEX social_feed_items_unfollow_withdrawal_reverse_idx
      ON social_feed_items (
        actor_profile_id, recipient_profile_id, kind, published_at, feed_item_id
      )
      WHERE state = 'visible'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS social_feed_items_unfollow_withdrawal_reverse_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS social_feed_items_unfollow_withdrawal_idx`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
