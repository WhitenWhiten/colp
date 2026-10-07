import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

test('community notifications migration widens only the notification authority checks and stays expand-only', async () => {
  const source = await readFile(
    new URL('../../../migrations/202610050000_community_notifications.ts', import.meta.url),
    'utf8',
  );

  for (const contract of [
    // The community reply kind joins the durable notification authority.
    "CHECK (notification_type IN ('collection_change','follow_activity','comment_reply'))",
    // The community comment subject joins the subject authority.
    "CHECK (subject_type IN ('collection','profile','community_comment'))",
    // The community channel joins the preference authority.
    "CHECK (channel IN ('in_app','email','community'))",
    // The only comment_reply shape the worker writes: community comment
    // subject plus a known actor profile.
    'notifications_comment_reply_shape',
    "notification_type <> 'comment_reply'",
    "subject_type = 'community_comment' AND actor_profile_id IS NOT NULL",
    // Partial recipient index for the community page + unread scans.
    'notifications_recipient_community_page_idx',
    'recipient_account_id, occurred_at DESC, notification_id DESC',
    "WHERE notification_type = 'comment_reply'",
    // Re-entrant up after Kysely forgets the migration row.
    'DROP CONSTRAINT IF EXISTS',
    'CREATE INDEX IF NOT EXISTS',
  ]) {
    assert.ok(source.includes(contract), `missing migration contract: ${contract}`);
  }

  // Expand-only convention: re-entrant up, non-destructive down with no SQL.
  const down = source.match(/async function down[\s\S]*?\{([\s\S]*?)\}/u);
  assert.ok(down, 'down must exist');
  assert.equal(down[1]!.includes('.execute('), false, 'down must not run SQL');
  for (const forbidden of [
    'DROP TABLE',
    'DROP INDEX',
    'DROP TRIGGER',
    'DROP FUNCTION',
    'DELETE FROM',
    'UPDATE notifications',
    'outbox_events',
    'community_votes',
    'community_rank',
  ]) {
    assert.equal(source.includes(forbidden), false, `must not mention ${forbidden}`);
  }
});
