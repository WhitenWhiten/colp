import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

test('P2B-18 migration owns one canonical private progress row with bounded numeric facts', async () => {
  const source = await readFile(new URL('../../../migrations/202607250900_reading_progress.ts', import.meta.url), 'utf8');
  for (const contract of [
    'CREATE TABLE reading_progress',
    'FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT',
    "resource_type IN ('collection','node')",
    "status IN ('not_started','in_progress','completed')",
    'progress numeric(6,5)',
    'UNIQUE (account_id,resource_type,resource_id)',
    'reading_progress_state_value_check',
    'reading_progress_completed_facts_check',
    'reading_progress_account_updated_idx',
  ]) assert.ok(source.includes(contract), `missing migration contract: ${contract}`);
  assert.equal(source.includes('operations'), false);
  assert.equal(source.includes('outbox_events'), false);
  assert.equal(source.includes('resource_id_ledger'), false);
  // P2B-18 shares the Operation-less audit authority pair with Saved Resource and
  // future modules; its down must never delete audit rows (PUB-R04 / FIX-M-007).
  assert.equal(source.includes('audit_events'), false);
});
