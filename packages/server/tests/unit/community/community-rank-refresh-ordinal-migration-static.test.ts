import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

test('community rank refresh ordinal migration adds only the dedicated sequence and stays expand-only', async () => {
  const source = await readFile(
    new URL('../../../migrations/202610060000_community_rank_refresh_ordinal.ts', import.meta.url),
    'utf8',
  );

  for (const contract of [
    // The producer draws the projection_latest_only commit ordinal from this
    // sequence inside the enqueue transaction.
    'community_rank_refresh_ordinal',
    'CREATE SEQUENCE IF NOT EXISTS',
    'START WITH 1',
  ]) {
    assert.ok(source.includes(contract), `missing migration contract: ${contract}`);
  }

  // Expand-only convention: re-entrant up, non-destructive down with no SQL.
  const down = source.match(/async function down[\s\S]*?\{([\s\S]*?)\}/u);
  assert.ok(down, 'down must exist');
  assert.equal(down[1]!.includes('.execute('), false, 'down must not run SQL');
  for (const forbidden of [
    'DROP SEQUENCE',
    'DROP TABLE',
    'DROP INDEX',
    'ALTER TABLE',
    'DELETE FROM',
    'UPDATE outbox_events',
    'outbox_events',
    'community_votes',
    'community_rank_snapshots',
    'community_rank_entries',
  ]) {
    assert.equal(source.includes(forbidden), false, `must not mention ${forbidden}`);
  }
});
