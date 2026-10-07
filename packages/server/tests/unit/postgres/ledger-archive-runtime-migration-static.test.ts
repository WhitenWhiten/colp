import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

test('010900 installs the strict archive job transition and verification gates', async () => {
  const source = await readFile(new URL(
    '../../../migrations/202610010900_ledger_archive_runtime.ts', import.meta.url,
  ), 'utf8');
  for (const contract of [
    'ledger_archive_export_jobs_transition_guard',
    'ledger_archive_export_jobs_lease_guard',
    'ledger_archive_export_jobs_verified_gate',
    'ledger_archive_export_jobs_delete_guard',
    'ledger_archive_export_jobs_truncate_guard',
  ]) assert.match(source, new RegExp(contract, 'u'));
  assert.match(source, /OLD\.status IN \('pending', 'retryable'\)/u);
  assert.match(source, /OLD\.status = 'running' AND OLD\.lease_expires_at <= current_timestamp/u);
  assert.match(source, /NEW\.status IN \('retryable', 'failed', 'succeeded'\)/u);
});
