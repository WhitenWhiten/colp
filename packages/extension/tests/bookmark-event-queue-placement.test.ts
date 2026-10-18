import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { createBookmarkCreatePlacementStore, type BookmarkCreatePlacementRecord } from '../src/bookmark-create-placement.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { bookmark, folder, fixture, scope } from './bookmark-event-queue-harness.js';

const intent: BookmarkCreatePlacementRecord = {
  version: 1, mode: 'top', targetParentNativeId: 'root-selected', collectionId: scope.collectionId,
  batchId: '11111111-1111-4111-8111-111111111111', batchOrder: 0, batchSize: 1,
  intentId: '22222222-2222-4222-8222-222222222222', title: 'Reserved', url: 'https://example.test/reserved',
  expectedIndex: 0, state: 'bound', nativeId: 'native-reserved', createdAt: 1,
};

test('ready reservation survives event staging and never enters the wire payload', async () => {
  const { store, api } = await fixture(new IDBFactory(), { autoFlush: false });
  const node = bookmark('native-reserved', 'root-selected', 0, intent.title, intent.url);
  api.put(node);
  const completed: string[] = [];
  const queue = createBookmarkEventQueue({ scope, store, api, autoFlush: false,
    resolveCreatePlacement: async () => ({ state: 'ready', intent }),
    completeCreatePlacement: async (intentId) => { completed.push(intentId); } });
  assert.equal((await queue.created(node.id, node)).outcome, 'staged');
  assert.deepEqual(completed, [intent.intentId]);
  const event = (await store.listBookmarkEvents(scope))[0]!;
  assert.deepEqual((event.details.context as Record<string, unknown>).placement, {
    version: 1, mode: 'top', targetParentNativeId: 'root-selected', collectionId: scope.collectionId,
    batchId: intent.batchId, batchOrder: 0, batchSize: 1, expectedIndex: 0, intentId: intent.intentId,
  });
  assert.doesNotMatch(JSON.stringify(event.details.draft), /placement/u);
  await queue.flush();
  assert.equal(typeof (await store.listQueue(scope))[0]?.opId, 'string');
  const processed = (await store.listBookmarkEvents(scope))[0]!;
  assert.equal(processed.status, 'processed');
  assert.equal(typeof processed.opId, 'string');
  assert.deepEqual((processed.details.context as Record<string, unknown>).placement,
    (event.details.context as Record<string, unknown>).placement);
});

test('an unproven reservation holds that one save and lets later saves queue', async () => {
  const { store, api } = await fixture(new IDBFactory(), { autoFlush: false });
  const node = bookmark('native-ambiguous', 'root-selected', 0, intent.title, intent.url);
  api.put(node);
  const queue = createBookmarkEventQueue({ scope, store, api, autoFlush: false,
    resolveCreatePlacement: async (nativeId) => nativeId === node.id
      ? { state: 'unproven', candidates: [intent] } : undefined });
  assert.equal((await queue.created(node.id, node)).outcome, 'staged');
  // Captured where the browser put it, without the reservation it cannot be tied to.
  const event = (await store.listBookmarkEvents(scope))[0]!;
  assert.equal((event.details.context as Record<string, unknown>).placement, undefined);
  const later = bookmark('native-later', 'root-selected', 1, 'Later', 'https://example.test/later');
  api.put(later);
  assert.equal((await queue.created(later.id, later)).outcome, 'staged');
  await queue.flush();
  const rows = await store.listQueue(scope);
  assert.deepEqual(rows.map((row) => [row.status, row.recovery?.code]),
    [['set_aside', 'recovery_identity_unproven'], ['pending', undefined]]);
  // The later save sits after the held one in the browser; it is placed by its folder instead of waiting.
  assert.equal((rows[1]!.payload.payload as Record<string, unknown>).afterId, undefined);
  assert.notEqual((await store.getEngineState(scope))?.recoveryFrozen, true);
  assert.equal((await store.getScope(scope))?.metadata?.recoveryCode, undefined);
  assert.equal((await store.listIngressDiagnostics(scope)).some((row) => row.code === 'identity_unproven'), false);
});

test('ordinary native create without a reservation keeps the existing ingress path', async () => {
  const { store, api } = await fixture(new IDBFactory(), { autoFlush: false });
  const node = bookmark('native-ordinary', 'root-selected', 0, 'Ordinary', 'https://example.test/ordinary');
  api.put(node);
  const queue = createBookmarkEventQueue({ scope, store, api, autoFlush: false });
  assert.equal((await queue.created(node.id, node)).outcome, 'staged');
  const event = (await store.listBookmarkEvents(scope))[0]!;
  assert.equal((event.details.context as Record<string, unknown>).placement, undefined);
});

test.each(['bound', 'attention'] as const)('a %s local-only reservation cannot freeze native ingress', async state => {
  const { store, api } = await fixture(new IDBFactory(), { autoFlush: false });
  const placements = createBookmarkCreatePlacementStore({ storage: new MemoryStorageArea() });
  const reservation = await placements.reserve({ mode: 'top',
    targetParentNativeId: state === 'bound' ? 'root-unselected' : 'root-selected',
    batchId: intent.batchId, batchOrder: 0, batchSize: 1,
    title: intent.title, url: intent.url, expectedIndex: 0 });
  const node = bookmark('native-local-save', 'root-selected', 0, intent.title, intent.url);
  await placements.bind(reservation.intentId, node.id);
  if (state === 'attention') await placements.markAttention(reservation.intentId);
  api.put(node);
  const queue = createBookmarkEventQueue({ scope, store, api, autoFlush: false,
    resolveCreatePlacement: async (nativeId, value) => placements.consumeForCreated({
      id: nativeId, parentId: value.parentId, index: value.index, title: value.title, url: value.url }),
    completeCreatePlacement: (intentId, nativeId) => placements.complete(intentId, nativeId) });
  try {
    const captured = state === 'bound'
      ? await queue.moved(node.id, { parentId: node.parentId, index: node.index,
        oldParentId: 'root-unselected', oldIndex: 0 })
      : await queue.created(node.id, node);
    assert.equal(captured.outcome, 'staged');
    const event = (await store.listBookmarkEvents(scope))[0]!;
    assert.equal(event.kind, 'create');
    assert.equal((event.details.context as Record<string, unknown>).placement, undefined);
    assert.notEqual((await store.getEngineState(scope))?.recoveryFrozen, true);
    assert.equal((await store.getScope(scope))?.lifecycle, 'active');
    // Capture recovery still owns the local reservation and its exact native receipt.
    assert.equal((await placements.get(reservation.intentId))?.state, state);
    await queue.flush();
    assert.equal((await store.listQueue(scope))[0]?.payload.type, 'create_node');
  } finally { store.close(); }
});

test('a reservation explicitly bound to another collection holds that save without freezing ingress', async () => {
  const { store, api } = await fixture(new IDBFactory(), { autoFlush: false });
  const node = bookmark(intent.nativeId!, 'root-selected', 0, intent.title, intent.url);
  api.put(node);
  const attention: string[] = [];
  const queue = createBookmarkEventQueue({ scope, store, api, autoFlush: false,
    resolveCreatePlacement: async () => ({ state: 'ready', intent: { ...intent, collectionId: 'other-collection' } }),
    markCreatePlacementAttention: async id => { attention.push(id); } });
  try {
    assert.equal((await queue.created(node.id, node)).outcome, 'staged');
    assert.deepEqual(attention, [intent.intentId]);
    await queue.flush();
    assert.deepEqual((await store.listQueue(scope)).map((row) => [row.status, row.recovery?.code]),
      [['set_aside', 'recovery_identity_unproven']]);
    assert.notEqual((await store.getEngineState(scope))?.recoveryFrozen, true);
  } finally { store.close(); }
});

test.each(['empty_title', 'missed_create'])('a move into an unmapped selected folder never deletes the bookmark (%s)', async (reason) => {
  const { store, api, queue } = await fixture(new IDBFactory(), { mappedNode: true });
  const prior = (await store.getMappingByNativeId(scope, 'mapped'))!;
  const { scopeKey: _key, ...mapping } = prior;
  await store.putMapping(scope, { ...mapping, nodeKind: 'bookmark', parentNativeId: 'folder-parent' });
  api.put(folder('unmapped-parent', 'root-selected', 1, reason === 'empty_title' ? '' : 'New folder'));
  if (reason === 'empty_title') assert.equal((await queue.created('unmapped-parent', api.node('unmapped-parent'))).outcome, 'filtered');
  api.put(bookmark('mapped', 'unmapped-parent', 0, 'Server before', 'https://example.test/before'));
  assert.equal((await queue.moved('mapped', { parentId: 'unmapped-parent', index: 0,
    oldParentId: 'folder-parent', oldIndex: 0 })).outcome, 'filtered');
  await queue.flush();
  assert.deepEqual(await store.listQueue(scope), []);
  assert.equal(api.node('mapped').parentId, 'unmapped-parent');
  assert.ok(await store.getMappingByNativeId(scope, 'mapped'));
  // Once the missing parent can be captured, ordinary tree recovery retains
  // and stages the original move rather than a removal.
  api.put(folder('unmapped-parent', 'root-selected', 1, 'New folder'));
  await queue.recover();
  const events = await store.listBookmarkEvents(scope);
  assert.ok(events.some(event => event.nativeId === 'mapped' && event.kind === 'move'));
  assert.ok(events.every(event => event.kind !== 'remove'));
  store.close();
});
