import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';

test('publication cursor locator migration creates an immutable UTF-8 SHA-256 locator index', () => {
  const source = readFileSync(
    new URL('../../../migrations/202607242000_publication_snapshot_cursor_locator.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /CREATE FUNCTION publication_locator_sha256_128\(source text\)/u);
  assert.match(source, /IMMUTABLE/u);
  assert.match(source, /convert_to\(source, 'UTF8'\)/u);
  assert.match(source, /nodes_live_publication_cursor_locator_idx/u);
  assert.match(source, /publication_locator_sha256_128\(id\)/u);
  assert.match(source, /WHERE deleted_at IS NULL AND NOT is_root/u);
  assert.match(source, /DROP INDEX IF EXISTS nodes_live_publication_cursor_locator_idx/u);
  assert.match(source, /DROP FUNCTION IF EXISTS publication_locator_sha256_128\(text\)/u);
});
