import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

test('collection_follows migration owns only the collection follow relation', async () => {
  const source = await readFile(
    new URL('../../../migrations/202609240100_collection_follows.ts', import.meta.url),
    'utf8',
  );

  for (const contract of [
    'CREATE TABLE collection_follows',
    'collection_id text NOT NULL',
    'follower_profile_id text NOT NULL',
    'REFERENCES collections(id) ON DELETE CASCADE',
    'REFERENCES profiles(account_id) ON DELETE CASCADE',
    'collection_follows_followed_at_finite',
    'collection_follows_follower_page_idx',
    'collection_follows_binding_immutable',
    'collection_follows_lifecycle_guard',
    'accounts_remove_inactive_collection_follows',
    "visibility IN ('public','unlisted')",
    'owner_subject_id',
  ]) {
    assert.ok(source.includes(contract), `missing migration contract: ${contract}`);
  }

  for (const forbidden of [
    'CREATE TRIGGER follows_binding_immutable',
    'follows_profile_lifecycle_guard',
    'accounts_remove_inactive_follows',
    'forbid_follow_binding_mutation',
    'validate_follow_profile_lifecycle',
    'remove_follows_for_inactive_account',
    'social.follow-created',
    'handle text',
    'social_feed_items',
    'notification_preferences',
    'notifications',
    'entitlements',
    'receipts',
    'outbox_events',
  ]) {
    assert.equal(source.includes(forbidden), false, `must not mention ${forbidden}`);
  }
  assert.equal(
    /(?<!collection_)follows_binding_immutable/u.test(source),
    false,
    'must not reuse the profile-follow binding trigger name',
  );
});
