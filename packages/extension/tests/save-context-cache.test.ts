import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import { parseSaveContextCache } from '../src/save-context-cache.js';

describe('offline save context cache', () => {
  const record = { collectionId: 'col-1', parentNativeId: '42', updatedAt: 1 };

  test('returns the cached folder only for the matching collection', () => {
    assert.deepEqual(parseSaveContextCache(record), { collectionId: 'col-1', parentNativeId: '42' });
    assert.deepEqual(parseSaveContextCache(record, 'col-1'), { collectionId: 'col-1', parentNativeId: '42' });
    assert.equal(parseSaveContextCache(record, 'col-2'), undefined);
  });

  test('carries the private-local root when configured', () => {
    assert.deepEqual(parseSaveContextCache({ ...record, privateParentNativeId: '77' }),
      { collectionId: 'col-1', parentNativeId: '42', privateParentNativeId: '77' });
    assert.deepEqual(parseSaveContextCache({ ...record, privateParentNativeId: '' }),
      { collectionId: 'col-1', parentNativeId: '42' });
  });

  test('rejects malformed records', () => {
    assert.equal(parseSaveContextCache(undefined), undefined);
    assert.equal(parseSaveContextCache([]), undefined);
    assert.equal(parseSaveContextCache({ collectionId: '', parentNativeId: '42' }), undefined);
    assert.equal(parseSaveContextCache({ collectionId: 'col-1', parentNativeId: '' }), undefined);
    assert.equal(parseSaveContextCache({ collectionId: 'col-1', parentNativeId: 42 }), undefined);
    assert.equal(parseSaveContextCache({ ...record, privateParentNativeId: 42 }), undefined);
  });
});
