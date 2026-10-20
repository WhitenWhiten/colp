import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { bookmarkRepresentability } from '../src/bookmark-event-codec.js';
import { filterBootstrapFacts } from '../src/bootstrap/fact-boundary.js';
import { createValidatorRegistry } from '../../server/node_modules/@know-n/colp/dist/schema/index.js';
import { mapSyncNodeCreateOperation } from '../../server/src/modules/sync/sync-node-create.js';
import { syncNodeCreatePushRequest } from '../../server/tests/fixtures/phase3/sync-push-admission.js';
import { bookmark, fixture, scope } from './bookmark-event-queue-harness.js';

test('favicon-only bookmarks remain selected for first sync', () => {
  const result = filterBootstrapFacts({
    facts: [{ nativeId: 'favicon-only', parentNativeId: 'bar', kind: 'bookmark', title: '',
      url: 'https://example.test/', revision: 'local-r1' }] as any,
    parents: [], mounts: [{ nativeRootId: 'bar' }] as any,
    privateNativeIds: [], excludedNativeIds: [],
  });
  assert.equal(result.facts.length, 1);
});

test('the server preserves schema-valid empty bookmark titles', () => {
  const operation = syncNodeCreatePushRequest({ node: {
    kind: 'bookmark', title: '', url: 'https://example.test/',
  } }).operations[0]!;
  assert.equal(createValidatorRegistry().validate('operation', operation).valid, true);
  const mapped = mapSyncNodeCreateOperation(operation, { managedBookmarkWrites: false });
  assert.equal(mapped.fields.kindFields.title, '');
});

test('clearing an existing native title captures the empty value in the durable queue', async () => {
  const { queue, store, api } = await fixture(new IDBFactory(), { mappedNode: true });
  try {
    api.put(bookmark('mapped', 'root-selected', 0, '', 'https://example.test/before'));
    assert.equal((await queue.changed('mapped', { title: '' })).outcome, 'staged');
    await queue.flush();
    const queued = await store.listQueue(scope);
    assert.equal(queued.length, 1);
    const payload = queued[0]!.payload.payload as { base: { title: string }; value: { title: string } };
    assert.equal(payload.base.title, 'Server before');
    assert.equal(payload.value.title, '');
  } finally { store.close(); }
});

test('unnamed folders remain outside the supported ingress contract', () => {
  assert.equal(bookmarkRepresentability({ type: 'folder', title: '' }), 'invalid_title');
  const operation = syncNodeCreatePushRequest({ node: { kind: 'folder', title: '' } }).operations[0]!;
  assert.throws(() => mapSyncNodeCreateOperation(operation, { managedBookmarkWrites: false }));
});
