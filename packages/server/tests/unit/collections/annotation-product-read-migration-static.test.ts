import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';

test('P2B-07 installs a live subject keyset index matching updated DESC, id C ASC', () => {
  const source = readFileSync(join(process.cwd(), 'migrations/202607250200_annotation_product_read.ts'), 'utf8');
  assert.match(source, /collection_id,\s*subject_type,\s*subject_id,\s*updated_at DESC,\s*\(id COLLATE "C"\) ASC/isu);
  assert.match(source, /WHERE deleted_at IS NULL/iu);
  assert.match(source, /DROP INDEX IF EXISTS annotations_live_subject_keyset_idx/iu);
});
