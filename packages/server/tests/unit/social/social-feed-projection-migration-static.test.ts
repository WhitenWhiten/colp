import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

test('P5-10 migration owns only rebuildable privacy-safe Feed projection state', async () => {
  const source = await readFile(
    new URL('../../../migrations/202607290100_social_feed_projections.ts', import.meta.url),
    'utf8',
  );

  for (const contract of [
    'CREATE TABLE social_feed_items',
    'CREATE TABLE social_feed_watermarks',
    'social_feed_items_event_recipient_key',
    'social_feed_items_recipient_page_idx',
    'social_feed_items_recipient_kind_page_idx',
    'social_feed_items_retention_idx',
    'social_feed_items_state_shape',
    'social_feed_items_recheck_binding',
    'social_feed_items_transition_guard',
    'social_feed_watermarks_state_shape',
    'social_feed_watermarks_transition_guard',
    'last_commit_ordinal bigint NOT NULL DEFAULT 0',
    'state_revision bigint NOT NULL DEFAULT 0',
    'rebuild_replayed_commit_ordinal bigint',
    "kind text NOT NULL CHECK (kind IN ('collection_change','follow_activity'))",
  ]) assert.ok(source.includes(contract), `missing migration contract: ${contract}`);

  for (const forbidden of [
    'title text', 'summary text', 'body text', 'content text', 'payload_json',
    'CREATE TABLE notifications', 'CREATE TABLE outbox_events', 'CREATE TABLE event_bus',
  ]) assert.equal(source.includes(forbidden), false, `forbidden Feed authority/content: ${forbidden}`);
});

test('P5-10 production port cannot persist an item outside watermark CAS', async () => {
  const source = await readFile(
    new URL(
      '../../../src/modules/social/application/feed-projection-repository.ts',
      import.meta.url,
    ),
    'utf8',
  );
  assert.doesNotMatch(source, /^\s*putItem\(/mu);
  assert.match(source, /^\s*applyBatch\(/mu);
});

test('P5-10 begin/complete rebuild bind and clear captured high source identity', async () => {
  const [port, contract] = await Promise.all([
    readFile(new URL(
      '../../../src/infrastructure/social/feed-projection-postgres.ts', import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../../../src/modules/social/application/feed-projection-repository.ts',
      import.meta.url,
    ), 'utf8'),
  ]);
  assert.match(contract, /capturedHighSourceEventId: string \| null/u);
  assert.match(port, /rebuild_high_source_event_id=\$4/u);
  assert.match(port, /rebuild_high_source_event_id=null/u);
});

test('P5-10 follow_activity expand migration allows unbound Feed items only with a Follow recheck binding', async () => {
  const source = await readFile(
    new URL('../../../migrations/202608151000_social_feed_follow_activity.ts', import.meta.url),
    'utf8',
  );

  for (const contract of [
    'ALTER TABLE social_feed_items',
    'ALTER COLUMN collection_id DROP NOT NULL',
    'ALTER COLUMN publication_revision DROP NOT NULL',
    'social_feed_items_kind_shape',
    "kind = 'follow_activity'",
    "discoverability_recheck_key = 'follow:' || actor_profile_id || ':' || recipient_profile_id",
    "kind = 'collection_change' AND source_commit_ordinal > 0",
    "kind = 'follow_activity' AND source_commit_ordinal = 0",
  ]) assert.ok(source.includes(contract), `missing follow_activity migration contract: ${contract}`);

  for (const forbidden of [
    'ALTER TABLE notifications', 'ALTER TABLE outbox_events', 'DROP TABLE social_feed_items',
  ]) assert.equal(source.includes(forbidden), false, `forbidden follow_activity migration scope: ${forbidden}`);
});
