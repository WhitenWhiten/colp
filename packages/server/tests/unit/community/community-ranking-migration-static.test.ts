import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

test('community ranking migration owns only the projection + first-vote schema and stays expand-only', async () => {
  const source = await readFile(
    new URL('../../../migrations/202610020000_community_ranking.ts', import.meta.url),
    'utf8',
  );

  for (const contract of [
    'community_vote_targets',
    'community_rank_snapshots',
    'community_rank_entries',
    'first_vote_at',
    'score_version',
    'item_count',
    'position',
    'hot double precision',
    'ON DELETE CASCADE',
    'target_kind',
    'target_generation',
    'CREATE TABLE IF NOT EXISTS',
    'GENERATED ALWAYS AS IDENTITY',
    // Backfill derives the first accepted vote from retained ±1 rows only.
    'min(created_at)',
    'ON CONFLICT (target_kind, target_id, target_generation) DO NOTHING',
  ]) {
    assert.ok(source.includes(contract), `missing migration contract: ${contract}`);
  }

  // Expand-only convention: re-entrant up, non-destructive down with no SQL.
  const down = source.match(/async function down[\s\S]*?\{([\s\S]*?)\}/u);
  assert.ok(down, 'down must exist');
  assert.equal(down[1]!.includes('.execute('), false, 'down must not run SQL');
  for (const forbidden of [
    'DROP TABLE',
    'DROP TRIGGER',
    'DROP FUNCTION',
    'ALTER TABLE community_votes',
    'community_follows',
    'collection_follows',
    'outbox_events',
    'social_feed_items',
  ]) {
    assert.equal(source.includes(forbidden), false, `must not mention ${forbidden}`);
  }
});
