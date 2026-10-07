import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

test('community comments migration owns only the comment tree schema and stays expand-only', async () => {
  const source = await readFile(
    new URL('../../../migrations/202610030000_community_comments.ts', import.meta.url),
    'utf8',
  );

  for (const contract of [
    'community_comments',
    'comment_id text PRIMARY KEY REFERENCES resource_id_ledger(resource_id) ON DELETE RESTRICT',
    'target_kind',
    'target_id',
    'target_collection_id',
    'target_series_id',
    'target_generation',
    'root_id',
    'reply_to_id',
    'author_account_id',
    'depth smallint NOT NULL CHECK (depth BETWEEN 0 AND 2)',
    // Thread shape: a root is self-rooted, replies carry parent + root.
    'depth = 0 AND reply_to_id IS NULL AND root_id = comment_id',
    'depth IN (1,2) AND reply_to_id IS NOT NULL AND root_id <> comment_id',
    // Per-kind parent binding: bookmark needs a collection, edition a series.
    "target_kind = 'bookmark' AND target_collection_id IS NOT NULL AND target_series_id IS NULL",
    "target_kind = 'digest_edition' AND target_series_id IS NOT NULL AND target_collection_id IS NULL",
    // Tombstone rule: deleted rows can never carry a body again.
    "state = 'deleted' AND body IS NULL",
    'char_length(body) BETWEEN 1 AND 4000',
    // Keyset indexes matching the two contract orderings.
    'community_comments_root_list_idx',
    'created_at DESC, comment_id ASC',
    'community_comments_thread_idx',
    'root_id, created_at ASC, comment_id ASC',
    'CREATE TABLE IF NOT EXISTS',
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
    'ALTER TABLE community_votes',
    'ALTER TABLE community_rank',
    'community_follows',
    'outbox_events',
  ]) {
    assert.equal(source.includes(forbidden), false, `must not mention ${forbidden}`);
  }
});
