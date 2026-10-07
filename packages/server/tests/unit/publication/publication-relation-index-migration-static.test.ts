import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';

test('P2B-13 installs Relation publication tuple and locator indexes with exact C collation', () => {
  const source = readFileSync(
    join(process.cwd(), 'migrations/202607250700_publication_relation_projection.ts'), 'utf8',
  );
  assert.match(source, /relations_live_publication_keyset_idx/iu);
  assert.match(source, /collection_id,\s*\(from_node_id COLLATE "C"\),\s*\(to_node_id COLLATE "C"\),\s*\(type COLLATE "C"\),\s*\(id COLLATE "C"\)/isu);
  assert.match(source, /WHERE deleted_at IS NULL/iu);
  assert.match(source, /relations_live_publication_cursor_locator_idx/iu);
  assert.match(source, /collection_id, publication_locator_sha256_128\(id\)/iu);
  assert.match(source, /DROP INDEX IF EXISTS relations_live_publication_cursor_locator_idx/iu);
  assert.match(source, /DROP INDEX IF EXISTS relations_live_publication_keyset_idx/iu);
});
