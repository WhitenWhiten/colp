import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'vitest';

const backendRoot = resolve(import.meta.dirname, '../../..');
const migrationPath = resolve(
  backendRoot,
  'migrations/202607311000_social_feed_fanout_continuation.ts',
);

test('R5-02 migration expands watermark fan-out continuation storage only', async () => {
  const source = await readFile(migrationPath, 'utf8');

  for (const contract of [
    'fanout_source_event_id',
    'fanout_commit_ordinal',
    'fanout_after_recipient_profile_id',
    'fanout_candidate_count',
    'fanout_started_at',
    'social_feed_watermarks_fanout_tuple',
    'follows_target_actor_fanout_idx',
    'target_profile_id, actor_profile_id ASC',
    'INCLUDE (followed_at)',
    'fanout_commit_ordinal > last_commit_ordinal',
    'fanout_candidate_count >= 0',
    "length(fanout_source_event_id) BETWEEN 1 AND 128",
    "length(fanout_after_recipient_profile_id) BETWEEN 1 AND 256",
    "fanout_started_at > '-infinity'::timestamptz",
    "fanout_started_at < 'infinity'::timestamptz",
    'DROP INDEX IF EXISTS follows_target_actor_fanout_idx',
    'DROP CONSTRAINT IF EXISTS social_feed_watermarks_fanout_tuple',
  ]) {
    assert.ok(source.includes(contract), `missing migration contract: ${contract}`);
  }

  for (const forbidden of [
    'OutboxContinuationRequested',
    'FEED_FANOUT_PAGE_SIZE',
    'social_feed_withdrawal',
    'continue(claim)',
    'DROP TABLE IF EXISTS social_feed_watermarks',
    'DROP TABLE IF EXISTS follows',
    'DROP INDEX IF EXISTS follows_actor_page_idx',
    'DROP INDEX IF EXISTS follows_target_page_idx',
  ]) {
    assert.equal(source.includes(forbidden), false, `forbidden R5-02 expansion: ${forbidden}`);
  }
});

test('R5-02 DatabaseSchema exposes nullable fan-out continuation columns', async () => {
  const source = await readFile(
    resolve(backendRoot, 'src/infrastructure/database/runtime.ts'),
    'utf8',
  );
  const table = source.match(/export interface SocialFeedWatermarkTable \{([\s\S]*?)\n\}/u)?.[1];
  assert.ok(table, 'SocialFeedWatermarkTable missing');
  for (const field of [
    'fanout_source_event_id: string | null',
    'fanout_commit_ordinal: bigint | null',
    'fanout_after_recipient_profile_id: string | null',
    'fanout_candidate_count: bigint | null',
    'fanout_started_at: Date | null',
  ]) {
    assert.ok(table.includes(field), `missing DatabaseSchema field: ${field}`);
  }
});

test('R5-02 public fanout-migration gate wraps PostgreSQL via with-postgres', async () => {
  const packageJson = JSON.parse(
    await readFile(resolve(backendRoot, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };
  assert.equal(
    packageJson.scripts['test:phase5:fanout-migration'],
    'node scripts/with-postgres.mjs -- npm run test:phase5:fanout-migration:inner',
  );
  assert.match(
    packageJson.scripts['test:phase5:fanout-migration:inner'] ?? '',
    /social-feed-fanout-migration-static\.test\.ts/u,
  );
  assert.match(
    packageJson.scripts['test:phase5:fanout-migration:inner'] ?? '',
    /social-feed-fanout-migration-postgres\.integration\.test\.ts/u,
  );
});
