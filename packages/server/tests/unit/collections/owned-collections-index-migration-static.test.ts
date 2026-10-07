import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

test('owned Collections migration and PostgreSQL query share the exact live tuple comparator', async () => {
  const [migration, query] = await Promise.all([
    readFile(new URL('../../../migrations/202607260100_owned_collections_keyset.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../../src/infrastructure/collections/owned-collections-query.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(migration, /CREATE INDEX collections_owned_live_updated_id_idx/i);
  assert.match(migration, /owner_subject_id,\s*updated_at DESC,\s*\(id COLLATE "C"\) ASC/is);
  assert.match(migration, /WHERE deleted_at IS NULL/i);
  assert.match(query, /owner_subject_id/);
  assert.match(query, /updated_at.*</s);
  assert.match(query, /\.where\('updated_at', '<=', input\.after\.updatedAt\)/);
  assert.match(query, /id COLLATE "C"/i);
  assert.match(query, /\.orderBy\('updated_at', 'desc'\).*\.orderBy\(ownedCollectionIdKey, 'asc'\)/s);
  assert.match(query, /\.where\('deleted_at', 'is', null\)/);
  assert.doesNotMatch(`${migration}\n${query}`, /enable_(seqscan|sort|indexscan)/i);
});
