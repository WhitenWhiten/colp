import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Bound the community unread-count scan.
 *
 * `communityNotificationUnreadGroupsSql` groups the recipient's unread community
 * notifications by pinned target:
 *
 *   where recipient_account_id = $1
 *     and notification_type = 'comment_reply'
 *     and state = 'unread'
 *   group by <target columns>
 *
 * `notifications_recipient_community_page_idx` is partial on
 * `notification_type = 'comment_reply'` only, with no `state` predicate, so this
 * query reads every community notification the recipient has ever received —
 * read and unread alike — before filtering `state`. The count it feeds is shown
 * verbatim in the UI (`Notifications (N)`), so it must stay EXACT: this is a scan
 * to narrow rather than a result to truncate, and no product decision is involved.
 *
 * The new index carries `state = 'unread'` in its predicate so the scan sees only
 * the rows the count actually needs, and orders by `subject_id` so the join to
 * `community_comments` can be reached without a sort.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX IF NOT EXISTS notifications_recipient_community_unread_idx
    ON notifications(recipient_account_id,subject_id)
    WHERE notification_type = 'comment_reply' AND state = 'unread'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS notifications_recipient_community_unread_idx`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
