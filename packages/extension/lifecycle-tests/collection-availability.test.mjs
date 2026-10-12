import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectionAvailability } from '../src/collection-availability.js';
const target = { id: 'one', kind: 'bookmarks', visibility: 'private' };
const parse = value => value && typeof value.id === 'string' && typeof value.kind === 'string' ? value : null;
test('complete valid absence proves an unavailable target, not an empty local tree', () => {
  assert.equal(collectionAvailability({ items: [] }, 'one', parse), 'unavailable');
  assert.equal(collectionAvailability({ items: [], nextCursor: null, total: 0 }, 'one', parse), 'unavailable');
});
test('partial, malformed, ambiguous and future listings never prove deletion', () => {
  for (const body of [null, {}, { items: [{}] }, { items: [], nextCursor: 'more' }, { items: [], hasMore: true },
    { items: [], total: 10 }, { items: [], future: true }, { items: [target, target] }]) {
    assert.equal(collectionAvailability(body, 'one', parse), 'unknown');
  }
});
test('a validated target can be found on a partial page; inaccessible target kind is not accepted', () => {
  assert.equal(collectionAvailability({ items: [target], nextCursor: 'more' }, 'one', parse), 'available');
  assert.equal(collectionAvailability({ items: [{ ...target, visibility: 'public' }] }, 'one', parse), 'unavailable');
  assert.equal(collectionAvailability({ items: [{ ...target, kind: 'feed' }] }, 'one', parse), 'unavailable');
  assert.equal(collectionAvailability({ items: [target] }, 'one', () => { throw new Error(); }), 'unknown');
});
