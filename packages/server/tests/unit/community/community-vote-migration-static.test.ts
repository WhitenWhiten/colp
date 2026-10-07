import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

test('community voting migration owns only the vote + generation schema and stays expand-only', async () => {
  const source = await readFile(
    new URL('../../../migrations/202610012400_community_voting.ts', import.meta.url),
    'utf8',
  );

  for (const contract of [
    'community_votes',
    'community_bookmark_generations',
    'community_bookmark_generation_fence',
    'target_kind',
    'target_id',
    'target_generation',
    'CHECK (value IN (-1, 1))',
    'community_votes_target_idx',
    'bm-gen-',
    'CREATE TABLE IF NOT EXISTS',
    'CREATE OR REPLACE FUNCTION',
    'duplicate_object',
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
    'community_follows',
    'collection_follows',
    'outbox_events',
    'social_feed_items',
  ]) {
    assert.equal(source.includes(forbidden), false, `must not mention ${forbidden}`);
  }
});
