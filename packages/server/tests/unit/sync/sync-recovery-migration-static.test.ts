import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

test('P3-24 migration persists page evidence, immutable recovery receipts and fresh generation fences', async () => {
  const source = await readFile(new URL('../../../migrations/202607252500_sync_snapshot_recovery.ts', import.meta.url), 'utf8');
  const expand = source.slice(0, source.indexOf('export async function down'));
  for (const required of [
    'sync_recovery_capabilities', 'sync_bootstrap_snapshot_pages', 'sync_recovery_ack_receipts',
    'old_lease_generation', 'purge_commit_ordinal', 'snapshot_id', 'snapshot_revision',
    'page_sequence', 'page_start_offset', 'page_end_offset', 'response_digest',
    'new_lease_generation', 'new_lease_id', 'result_json', 'result_digest',
    'primary key (replica_id, idempotency_key)', 'unique (replica_id, capability_digest)',
    'check (new_lease_generation > old_lease_generation)',
  ]) assert.match(expand.toLowerCase(), new RegExp(required.replace(/[()]/gu, '\\$&').replace(/ /gu, '\\s+'), 'u'));
  assert.doesNotMatch(expand, /drop\s+table|truncate|delete\s+from/iu);
});
