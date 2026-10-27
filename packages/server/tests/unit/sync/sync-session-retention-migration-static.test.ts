import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const source = readFileSync(new URL(
  '../../../migrations/202611030300_sync_session_retention.ts', import.meta.url), 'utf8');

test('Session retention only permits terminated Sessions and restores immutable guards on down', () => {
  expect(source).toContain('sync_sessions_terminal_cleanup_idx');
  expect(source).toContain("IF OLD.status = 'terminated' THEN RETURN OLD; END IF;");
  expect(source).toContain('sync_session_binding_mutation');
  expect(source).toContain('sync_session_receipt_mutation');
  expect(source).toContain('Sync Sessions cannot be deleted');
});
