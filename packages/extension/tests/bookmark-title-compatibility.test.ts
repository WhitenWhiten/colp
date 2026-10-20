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
    facts: [{ nativeId: 'favicon-only', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'bookmark', title: '',
      url: 'https://example.test/' }],
    parents: [], mounts: [{ nativeRootId: 'bar', remoteMountNodeId: null }],
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

for (const [label, title, supported] of [
  ['512 ASCII code units', 'a'.repeat(512), true],
  ['513 ASCII code units', 'a'.repeat(513), false],
  ['1024 UTF-8 bytes', '界'.repeat(341) + 'x', true],
  ['1025 UTF-8 bytes', '界'.repeat(341) + 'xy', false],
  ['400 CJK code units', '界'.repeat(400), false],
  ['512 code units and 1024 bytes of emoji', '😀'.repeat(256), true],
  ['over-budget emoji', '😀'.repeat(257), false],
  ['whitespace', '   ', false],
] as const) {
  test(`bootstrap and server agree on ${label} without truncating`, () => {
    const node = { kind: 'bookmark' as const, title, url: 'https://example.test/' };
    assert.equal(bookmarkRepresentability({ type: 'bookmark', title, url: node.url }),
      supported ? 'supported' : 'invalid_title');
    const operation = syncNodeCreatePushRequest({ node }).operations[0]!;
    if (supported) {
      assert.equal(mapSyncNodeCreateOperation(operation, { managedBookmarkWrites: false }).fields.kindFields.title, title);
    } else assert.throws(() => mapSyncNodeCreateOperation(operation, { managedBookmarkWrites: false }));
  });
}

test('an unsupported native title is retained locally and diagnosed without reserving a sequence', async () => {
  const { queue, store, api } = await fixture(new IDBFactory(), { mappedNode: true });
  try {
    const title = '界'.repeat(400);
    api.put(bookmark('mapped', 'root-selected', 0, title, 'https://example.test/before'));
    const outcome = await queue.changed('mapped', { title });
    assert.equal(outcome.outcome, 'filtered');
    assert.ok((await store.listIngressDiagnostics(scope)).some((row) => row.code === 'invalid_title'));
    await queue.flush();
    assert.deepEqual(await store.listQueue(scope), []);
    assert.equal(api.node('mapped').title, title);
  } finally { store.close(); }
});
