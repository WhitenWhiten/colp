import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

test('community comment management migration owns only the curation/settings schema and stays expand-only', async () => {
  const source = await readFile(
    new URL('../../../migrations/202610040000_community_comment_management.ts', import.meta.url),
    'utf8',
  );

  for (const contract of [
    // Curation overlay: one row per comment after the first curator write.
    'community_comment_curations',
    'comment_id text PRIMARY KEY REFERENCES community_comments(comment_id) ON DELETE RESTRICT',
    'hidden boolean NOT NULL',
    'revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1)',
    'updated_by_account_id text NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT',
    'updated_at timestamptz NOT NULL DEFAULT now()',
    // Comment-area settings: one row per (kind, id) target.
    'community_comment_settings',
    "target_kind text NOT NULL CHECK (target_kind IN ('collection','bookmark','digest_series','digest_edition'))",
    'target_id text NOT NULL',
    'target_collection_id text',
    'target_series_id text',
    'locked boolean NOT NULL',
    'reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1000)',
    'PRIMARY KEY (target_kind, target_id)',
    // Per-kind parent binding mirrors the comments table: bookmark needs a
    // collection, edition a series, collection/series carry neither.
    "target_kind = 'bookmark' AND target_collection_id IS NOT NULL AND target_series_id IS NULL",
    "target_kind = 'digest_edition' AND target_series_id IS NOT NULL AND target_collection_id IS NULL",
    "target_kind IN ('collection','digest_series') AND target_collection_id IS NULL AND target_series_id IS NULL",
    // Reverse operator lookup for housekeeping/inspection.
    'community_comment_curations_operator_idx',
    'updated_by_account_id, updated_at DESC',
    // Re-entrant up after Kysely forgets the migration row.
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
    'ALTER TABLE',
    'community_rank',
    'community_follows',
    'outbox_events',
  ]) {
    assert.equal(source.includes(forbidden), false, `must not mention ${forbidden}`);
  }
});
