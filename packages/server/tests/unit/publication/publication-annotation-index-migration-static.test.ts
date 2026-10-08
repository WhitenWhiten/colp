import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';

test('P2B-08 installs the live Publication Annotation tuple index with exact C collation', () => {
  const source = readFileSync(
    join(process.cwd(), 'migrations/202607250300_publication_annotation_projection.ts'),
    'utf8',
  );
  assert.match(source, /annotations_live_publication_keyset_idx/iu);
  assert.match(source, /collection_id,\s*\(subject_type COLLATE "C"\),\s*\(subject_id COLLATE "C"\),\s*\(id COLLATE "C"\)/isu);
  assert.match(source, /WHERE deleted_at IS NULL/iu);
  assert.match(source, /annotations_live_publication_cursor_locator_idx/iu);
  assert.match(source, /collection_id, publication_locator_sha256_128\(id\)/iu);
  assert.match(source, /DROP INDEX IF EXISTS annotations_live_publication_cursor_locator_idx/iu);
  assert.match(source, /DROP INDEX IF EXISTS annotations_live_publication_keyset_idx/iu);
});
