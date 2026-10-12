import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import { parseCollectionsCache } from '../src/collections-cache.js';

describe('owned collection list cache', () => {
  const collections = [{ id: 'col-1', title: 'Reading', kind: 'library', rootNodeId: 'root-1' }];
  const record = { accountId: 'sub-1', accountLabel: 'ada@example.test', collections, fetchedAt: 1 };

  test('returns collections for the matching account and rejects another account', () => {
    assert.deepEqual(parseCollectionsCache(record, { accountId: 'sub-1' }), collections);
    assert.deepEqual(parseCollectionsCache(record, { accountLabel: 'ada@example.test' }), collections);
    assert.equal(parseCollectionsCache(record, { accountId: 'sub-2' }), undefined);
    assert.equal(parseCollectionsCache({ ...record, collections: [{ id: 'not a protocol id', title: 'x', kind: 'library' }] }),
      undefined);
    assert.deepEqual(parseCollectionsCache({
      ...record, collections: [{ id: 'col-1', title: 'Reading', kind: 'library', visibility: 'private' }],
    }), [{ id: 'col-1', title: 'Reading', kind: 'library', visibility: 'private' }]);
    assert.equal(parseCollectionsCache({
      ...record, collections: [{ id: 'col-1', title: 'Reading', kind: 'library', rootNodeId: 'not a protocol id' }],
    }), undefined);
  });
});
