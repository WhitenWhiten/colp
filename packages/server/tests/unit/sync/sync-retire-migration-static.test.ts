import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

const migrationUrl = new URL('../../../migrations/202607252600_sync_replica_retirement.ts', import.meta.url);

test('P3-25 migration keeps retirement claims for the Replica lifetime and makes them immutable', async () => {
  const source = await readFile(migrationUrl, 'utf8');
  assert.match(source, /CREATE TABLE sync_replica_retirement_receipts/iu);
  assert.match(source, /PRIMARY KEY \(replica_id, idempotency_key\)/iu);
  assert.match(source, /REFERENCES sync_replicas\(replica_id\) ON DELETE RESTRICT/iu);
  assert.match(source, /FOREIGN KEY \(replica_id, lease_generation\)[\s\S]*sync_replica_generations/iu);
  assert.match(source, /BEFORE UPDATE OR DELETE[\s\S]*immutable/iu);
  assert.doesNotMatch(source, /expires_at|purge|ON DELETE CASCADE/iu);
});

test('P3-25 adds no path that can clear retired_at, generation history, sequence claims or receipts', async () => {
  const source = await readFile(migrationUrl, 'utf8');
  assert.doesNotMatch(source, /UPDATE\s+sync_replicas|DELETE\s+FROM\s+sync_replica/iu);
  assert.doesNotMatch(source, /DROP\s+TABLE\s+(?:sync_replica_generations|sync_sequence)/iu);
  assert.doesNotMatch(source, /retired_at\s*=\s*null/iu);
});
