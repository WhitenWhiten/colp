import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const source = readFileSync(new URL(
  '../../../migrations/202611030200_sync_ack_receipt_retention.ts', import.meta.url), 'utf8');

test('Ack receipt retention only permits terminal Session or retired Replica deletes', () => {
  expect(source).toContain('guard_sync_ack_receipt_retention');
  expect(source).toContain("session.status = 'terminated'");
  expect(source).toContain("replica.status = 'retired'");
  expect(source).toContain('sync_ack_receipts_session_cleanup_idx');
  expect(source).toContain('forbid_sync_ack_authority_mutation()');
});
