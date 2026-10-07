import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';

function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

test('invite-email leased_until index is expand-only and keeps due_idx', () => {
  const source = readFileSync(
    new URL('../../../migrations/202609130100_collection_invite_deliveries_leased_idx.ts', import.meta.url),
    'utf8',
  );
  const executable = stripBlockComments(source);
  assert.match(executable, /CREATE INDEX collection_invite_deliveries_leased_until_idx/u);
  assert.match(
    executable,
    /ON collection_invite_deliveries \(leased_until\)\s+WHERE state = 'leased'/u,
  );
  assert.match(executable, /DROP INDEX IF EXISTS collection_invite_deliveries_leased_until_idx/u);
  assert.doesNotMatch(executable, /DROP INDEX(?: IF EXISTS)? collection_invite_deliveries_due_idx/u);
  assert.doesNotMatch(executable, /DROP TABLE/u);
  assert.doesNotMatch(executable, /sql\.raw/u);
  assert.doesNotMatch(executable, /CREATE INDEX CONCURRENTLY/i);
});
