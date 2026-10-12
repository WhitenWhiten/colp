import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import type { BookmarkCreatePlacementRecord } from '../src/bookmark-create-placement.js';
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

test('unproven reservation freezes recovery and stages no event', async () => {
  const { store, api } = await fixture(new IDBFactory(), { autoFlush: false });
  const node = bookmark('native-ambiguous', 'root-selected', 0, intent.title, intent.url);
  api.put(node);
  const queue = createBookmarkEventQueue({ scope, store, api, autoFlush: false,
    resolveCreatePlacement: async () => ({ state: 'unproven', candidates: [intent] }) });
  assert.equal((await queue.created(node.id, node)).outcome, 'identity_unproven');
  assert.equal((await store.listBookmarkEvents(scope)).length, 0);
  assert.equal((await store.getEngineState(scope))?.recoveryFrozen, true);
  assert.equal((await store.listIngressDiagnostics(scope)).some((row) => row.code === 'identity_unproven'), false);
  assert.equal((await store.getScope(scope))?.metadata?.recoveryCode, 'recovery_identity_unproven');
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
