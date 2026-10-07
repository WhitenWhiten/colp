import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

test('P5-02 migration owns only stable Profile Follow authority', async () => {
  const source = await readFile(
    new URL('../../../migrations/202607280200_follows.ts', import.meta.url),
    'utf8',
  );

  for (const contract of [
    'CREATE TABLE follows',
    'actor_profile_id text NOT NULL',
    'target_profile_id text NOT NULL',
    'REFERENCES profiles(account_id) ON DELETE CASCADE',
    'follows_distinct_profiles',
    'follows_followed_at_finite',
    'follows_binding_immutable',
    'follows_actor_page_idx',
    'follows_target_page_idx',
    'remove_follows_for_inactive_account',
    'validate_follow_profile_lifecycle',
  ]) {
    assert.ok(source.includes(contract), `missing migration contract: ${contract}`);
  }

  for (const forbidden of [
    'handle text',
    'social_feed_items',
    'notification_preferences',
    'notifications',
    'entitlements',
    'memberships',
    'receipts',
    'audit_events',
    'outbox_events',
  ]) {
    assert.equal(source.includes(forbidden), false, `P5-02 must not create ${forbidden}`);
  }
});
