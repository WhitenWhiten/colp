import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';

test('directory migration supports order and fixed-size locator lookups', () => {
  const source = readFileSync(
    new URL('../../../migrations/202607242100_publication_directory_indexes.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /collections_publication_directory_order_idx/u);
  assert.match(source, /updated_at DESC/u);
  assert.match(source, /id COLLATE "C"/u);
  assert.match(source, /collections_publication_directory_locator_idx/u);
  assert.match(source, /publication_locator_sha256_128\(id\)/u);
  assert.doesNotMatch(source, /convert_to/u);
});
