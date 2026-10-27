import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const source = readFileSync(new URL(
  '../../../migrations/202611030100_sync_bootstrap_snapshot_retention.ts', import.meta.url), 'utf8');

test('Snapshot retention keeps Ack receipts immutable and fences page/capability deletes by expiry', () => {
  expect(source).toContain('allow_expired_sync_bootstrap_snapshot_page_mutation');
  expect(source).toContain('snapshot.expires_at <= current_timestamp');
  expect(source).toContain('IF OLD.expires_at <= current_timestamp THEN RETURN OLD; END IF;');
  expect(source).toContain('forbid_sync_recovery_immutable_mutation()');
  expect(source).toContain('sync_bootstrap_snapshots_expiry_cleanup_idx');
  expect(source).toContain('sync_recovery_capabilities_snapshot_cleanup_idx');
  expect(source).toContain('sync_recovery_ack_receipts_snapshot_cleanup_idx');
});
