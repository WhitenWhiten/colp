import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

test('P2B-15 saved resources down refuses instead of deleting cross-module privacy-minimal audits', async () => {
  const source = await readFile(new URL('../../../migrations/202607250800_saved_resources.ts', import.meta.url), 'utf8');
  const downStart = source.indexOf('export async function down');
  assert.ok(downStart >= 0, 'migration exports a down function');
  const down = source.slice(downStart);
  assert.equal(source.includes('DELETE FROM audit_events'), false,
    'down must never delete audit rows that Reading Progress or future modules may own');
  assert.ok(down.includes('RAISE EXCEPTION'), 'down must refuse incompatible Operation-less audits');
  assert.ok(down.includes('operation_id IS NULL AND collection_id IS NULL'),
    'down must pre-check the Operation-less authority pair');
  assert.ok(down.includes('count(*)'), 'down must report counts when refusing');
  assert.ok(down.indexOf('RAISE EXCEPTION') < down.indexOf('DROP TABLE IF EXISTS saved_resources'),
    'the audit guard must run before any destructive statement');
});
