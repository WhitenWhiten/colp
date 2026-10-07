import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

const migrationUrl = new URL('../../../migrations/202607251300_sync_replica_lifecycle.ts', import.meta.url);
const rolloutUrl = new URL('../../../migrations/README.md', import.meta.url);

test('P3-06 expand migration adds a conditional lifecycle fence and terminal retirement defense', async () => {
  const source = await readFile(migrationUrl, 'utf8');
  assert.match(source, /ALTER TABLE sync_replicas ADD COLUMN lifecycle_revision bigint NOT NULL DEFAULT 0/i);
  assert.match(source, /CHECK \(lifecycle_revision >= 0\)/i);
  assert.match(source, /OLD\.retired_at IS NOT NULL/i);
  assert.match(source, /NEW\.retired_at IS DISTINCT FROM OLD\.retired_at/i);
  assert.match(source, /NEW\.status IS DISTINCT FROM OLD\.status/i);
  for (const field of [
    'lease_generation', 'lease_id', 'last_seen_at', 'lease_expires_at', 'lifecycle_revision',
    'checkpoint_cursor', 'checkpoint_commit_ordinal', 'wire_json',
  ]) {
    assert.match(source, new RegExp(`NEW\\.${field} IS DISTINCT FROM OLD\\.${field}`, 'i'));
  }
  assert.match(source, /BEFORE UPDATE ON sync_replicas/i);
});

test('P3-06 migration documents expand and downgrade boundaries without rewriting P3-05', async () => {
  const [source, rollout] = await Promise.all([
    readFile(migrationUrl, 'utf8'), readFile(rolloutUrl, 'utf8'),
  ]);
  assert.match(source, /DROP COLUMN IF EXISTS lifecycle_revision/i);
  assert.match(source, /DROP FUNCTION IF EXISTS enforce_sync_replica_terminal/i);
  assert.match(rollout, /202607251300_sync_replica_lifecycle/);
  assert.match(rollout, /expand/i);
  assert.match(rollout, /downgrade|down/i);
});
