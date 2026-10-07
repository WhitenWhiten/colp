import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';

function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

test('restore-receipt FIFO index is expand-only on (collection_id, created_at)', () => {
  const source = readFileSync(
    new URL(
      '../../../migrations/202609210300_collection_version_restore_receipts_collection_created_idx.ts',
      import.meta.url,
    ),
    'utf8',
  );
  const executable = stripBlockComments(source);
  assert.match(executable, /CREATE INDEX collection_version_restore_receipts_collection_created_idx/u);
  assert.match(
    executable,
    /ON collection_version_restore_receipts \(collection_id, created_at\)/u,
  );
  assert.match(executable, /DROP INDEX IF EXISTS collection_version_restore_receipts_collection_created_idx/u);
  assert.doesNotMatch(executable, /DROP TABLE/u);
  assert.doesNotMatch(executable, /CREATE INDEX CONCURRENTLY/i);
  assert.doesNotMatch(executable, /ENABLE ROW LEVEL SECURITY/i);
  assert.doesNotMatch(executable, /sql\.raw/u);
});
