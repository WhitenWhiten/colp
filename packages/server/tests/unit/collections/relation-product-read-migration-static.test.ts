import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';

test('P2B-12 migration provides comparator-compatible partial indexes for both endpoint directions', () => {
  const source = readFileSync(join(process.cwd(), 'migrations/202607250600_relation_product_read.ts'), 'utf8');
  assert.match(source, /relations_product_live_from_idx/);
  assert.match(source, /collection_id, from_node_id, updated_at DESC, id COLLATE "C" ASC/);
  assert.match(source, /relations_product_live_to_idx/);
  assert.match(source, /collection_id, to_node_id, updated_at DESC, id COLLATE "C" ASC/);
  assert.equal((source.match(/WHERE deleted_at IS NULL/g) ?? []).length, 2);
});
