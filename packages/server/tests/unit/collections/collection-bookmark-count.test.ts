import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';
import { createPostgresCollectionBookmarkCountReadPort } from '../../../src/infrastructure/collections/index.js';
import { bookmarkCountFor } from '../../../src/modules/collections/index.js';

describe('collection bookmark count helpers', () => {
  test('missing Map ids are treated as 0', () => {
    assert.equal(bookmarkCountFor(new Map(), 'missing'), 0);
    assert.equal(bookmarkCountFor(new Map([['other', 3]]), 'missing'), 0);
    assert.equal(bookmarkCountFor(new Map([['present', 8]]), 'present'), 8);
  });

  test('empty collectionIds return an empty Map without querying', async () => {
    const port = createPostgresCollectionBookmarkCountReadPort(null as never);
    const result = await port.countBookmarks([]);
    assert.equal(result.size, 0);
  });

  test('owned and shared list SQL files do not contain count(*)', async () => {
    const [owned, shared] = await Promise.all([
      readFile(new URL('../../../src/infrastructure/collections/owned-collections-query.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../src/infrastructure/collections/shared-collections-query.ts', import.meta.url), 'utf8'),
    ]);
    assert.doesNotMatch(owned, /count\(\*\)/i);
    assert.doesNotMatch(shared, /count\(\*\)/i);
  });
});
