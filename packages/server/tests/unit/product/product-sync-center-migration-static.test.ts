import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';

test('P3-36 migration provides owner and open Conflict keyset indexes', () => {
  const source = readFileSync(new URL('../../../migrations/202607280100_product_sync_center_reads.ts', import.meta.url), 'utf8');
  assert.match(source, /sync_conflicts \(replica_id, created_at DESC, conflict_id DESC\)/u);
  assert.match(source, /WHERE status = 'open'/u);
});

test('P3-05 already supplies the account Replica status index without duplicate P3-36 DDL', () => {
  const existing = readFileSync(new URL('../../../migrations/202607251200_sync_replica_facts.ts', import.meta.url), 'utf8');
  assert.match(existing, /sync_replicas_account_device_idx[\s\S]*account_id,device_id,replica_id/u);
});
