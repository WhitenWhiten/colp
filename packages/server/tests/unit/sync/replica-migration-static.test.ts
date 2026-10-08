import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';

const MIGRATION = new URL('../../../migrations/202607251200_sync_replica_facts.ts', import.meta.url);

describe('P3-05 Replica expand migration static contract', () => {
  test('adds relational lifetime and current facts without Session or route state', async () => {
    const source = await readFile(MIGRATION, 'utf8');
    for (const marker of [
      'sync_devices', 'sync_replica_id_ledger', 'sync_replica_generations',
      'sync_replicas', 'lease_generation', 'binding_mode', 'capabilities_json',
      'checkpoint_cursor', 'checkpoint_commit_ordinal', 'wire_json',
    ]) assert.match(source, new RegExp(marker));
    assert.match(source, /whole-profile/);
    assert.match(source, /mounted-folder/);
    assert.match(source, /forbid_sync_replica_lifetime_mutation/);
    assert.match(source, /export async function up/);
    assert.match(source, /export async function down/);
    assert.doesNotMatch(source, /CREATE TABLE\s+sync_sessions/i);
    assert.doesNotMatch(source, /push|pull|renewal/i);
  });
});
