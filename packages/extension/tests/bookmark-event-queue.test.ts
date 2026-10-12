import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { createBookmarkEventQueue, type BookmarkEventApi } from '../src/bookmark-event-queue.js';
import { createSyncStateStore, type BootstrapRunRecord, type FirstRunState, type ScopeCommandPlanRecord } from '../src/sync-state-store.js';
import {
  bookmark, deterministicIds, fixture, folder, mapping, memoryApi, scope, separator, confirmQueued,
} from './bookmark-event-queue-harness.js';

describe('P3-30 bookmark event normalization', () => {
  let indexedDB: IDBFactory;
  beforeEach(() => { indexedDB = new IDBFactory(); });

  test('maps Folder, Bookmark and Separator creates into schema-valid single COLP operations', async () => {
    const { queue, store, api } = await fixture(indexedDB);
    api.put(folder('folder-new', 'root-selected', 0, 'Folder'));
    api.put(bookmark('bookmark-new', 'root-selected', 1, 'Bookmark', 'https://example.test/new'));
    api.put(separator('separator-new', 'root-selected', 2));
    await queue.created('folder-new', api.node('folder-new'));
    await queue.created('bookmark-new', api.node('bookmark-new'));
    await queue.created('separator-new', api.node('separator-new'));
    assert.deepEqual((await store.listBookmarkEvents(scope)).map((event) => event.opId), [null, null, null]);
    await queue.flush();
    let records = await store.listQueue(scope);
    await store.rebindProvisionalBookmarkIdentity(scope, 'folder-new', records[0]!.opId,
      'server-folder-new', 'server-folder-r1');
    await queue.flush(); records = await store.listQueue(scope);
    await store.rebindProvisionalBookmarkIdentity(scope, 'bookmark-new', records[1]!.opId,
      'server-bookmark-new', 'server-bookmark-r1');
    await queue.flush();

    records = await store.listQueue(scope);
    assert.deepEqual(records.map((record) => record.sequence), [1, 2, 3]);
    assert.deepEqual(records.map((record) => record.payload.type), ['create_node', 'create_node', 'create_node']);
    assert.deepEqual(records.map((record) => (record.payload.payload as any).node.kind),
      ['folder', 'bookmark', 'separator']);
    assert.deepEqual((await store.listBookmarkEvents(scope)).map((event) => event.opId),
      records.map((record) => record.opId));
    assert.equal(JSON.stringify(records).includes('root-selected'), false);
  });

  test('uses the last durable projection as update Base and never reconstructs Base from the changed native node', async () => {
    const { queue, store, api } = await fixture(indexedDB, { mappedNode: true });
    api.put(bookmark('mapped', 'root-selected', 0, 'Native after', 'https://example.test/after'));
    await queue.changed('mapped', { title: 'Native after', url: 'https://example.test/after' });
    await queue.flush();

    const operation = (await store.listQueue(scope))[0]!;
    assert.equal(operation.baseRevision, 'server-revision-7');
    assert.deepEqual((operation.payload.payload as any).base,
      { title: 'Server before', url: 'https://example.test/before' });
    assert.deepEqual((operation.payload.payload as any).value,
      { title: 'Native after', url: 'https://example.test/after' });
  });

  test('canonicalizes a complete Chromium callback into the changed field domain', async () => {
    const { queue, store } = await fixture(indexedDB, { mappedNode: true });
    await queue.changed('mapped', { title: 'Server before', url: 'https://example.test/after' });
    await queue.flush();

    const operation = (await store.listQueue(scope))[0]!;
    assert.deepEqual((operation.payload.payload as any).base,
      { url: 'https://example.test/before' });
    assert.deepEqual((operation.payload.payload as any).value,
      { url: 'https://example.test/after' });
  });

  test('uses current browser state when a stale callback is processed after a later Pull mutation', async () => {
    const { queue, store, api } = await fixture(indexedDB, { mappedNode: true });
    api.put(bookmark('mapped', 'root-selected', 0, 'Merged title', 'https://example.test/merged'));
    await queue.changed('mapped', { title: 'Stale callback title' });
    await queue.flush();

    const operation = (await store.listQueue(scope))[0]!;
    assert.deepEqual((operation.payload.payload as any).value,
      { title: 'Merged title', url: 'https://example.test/merged' });
  });

  test('uses the complete callback merge when Chrome temporarily rejects the post-change lookup', async () => {
    const { store, api } = await fixture(indexedDB, { mappedNode: true });
    const rejectingApi: BookmarkEventApi = { ...api, async get() {
      throw new DOMException('bookmark index not ready', 'UnknownError');
    } };
    const queue = createBookmarkEventQueue({ scope, store, api: rejectingApi,
      now: () => '2026-07-27T00:00:00Z', uuid: deterministicIds(), autoFlush: false });
    assert.equal((await queue.changed('mapped', { title: 'Offline title' })).outcome, 'staged');
    await queue.flush();
    const operation = (await store.listQueue(scope))[0]!;
    assert.deepEqual((operation.payload.payload as any).value,
      { title: 'Offline title' });
  });

  test('preserves immediate create/move/change/remove without inventing IDs or revisions before receipts', async () => {
    const { queue, store, api } = await fixture(indexedDB);
    api.put(bookmark('rapid', 'root-selected', 0, 'First', 'https://example.test/first'));
    await queue.created('rapid', api.node('rapid'));
    api.put(bookmark('rapid', 'folder-parent', 0, 'First', 'https://example.test/first'));
    await queue.moved('rapid', { parentId: 'folder-parent', index: 0, oldParentId: 'root-selected', oldIndex: 0 });
    api.put(bookmark('rapid', 'folder-parent', 0, 'Second', 'https://example.test/second'));
    await queue.changed('rapid', { title: 'Second', url: 'https://example.test/second' });
    await queue.removed('rapid', { parentId: 'folder-parent', index: 0, node: api.node('rapid') });
    await queue.flush();

    assert.deepEqual((await store.listQueue(scope)).map((record) => record.payload.type), ['create_node']);
    assert.deepEqual((await store.listBookmarkEvents(scope)).map((event) => event.status),
      ['processed', 'pending', 'pending', 'pending']);

    const create = (await store.listQueue(scope))[0]!;
    await confirmQueued(store, create.sequence, 'server-node-rapid', 'server-create-r1');
    await store.rebindProvisionalBookmarkIdentity(scope, 'rapid', create.opId,
      'server-node-rapid', 'server-create-r1');
    await queue.flush();
    await confirmQueued(store, 2, 'server-node-rapid', 'server-move-r2');
    await mapping(store, 'rapid', 'server-node-rapid', 'root-selected', 'server-move-r2',
      { title: 'First', url: 'https://example.test/first' }, 'folder-parent');
    await queue.flush();
    await confirmQueued(store, 3, 'server-node-rapid', 'server-change-r3');
    await mapping(store, 'rapid', 'server-node-rapid', 'root-selected', 'server-change-r3',
      { title: 'Second', url: 'https://example.test/second' }, 'folder-parent');
    await queue.flush();

    const records = await store.listQueue(scope);
    assert.deepEqual(records.map((record) => record.payload.type),
      ['create_node', 'move_node', 'update_node_content', 'delete_node']);
    assert.deepEqual(records.map((record) => record.sequence), [1, 2, 3, 4]);
    assert.equal(new Set(records.map((record) => record.opId)).size, 4);
    for (const record of records.slice(1)) {
      assert.doesNotMatch(String(record.baseRevision), /^(?:pending|local)-/);
      assert.doesNotMatch(String(record.payload.targetId), /^(?:pending|local)-/);
      assert.deepEqual(record.payload.dependencies, []);
    }
    assert.deepEqual(records.slice(1).map((record) => record.payload.dependencies), [[], [], []]);
  });

  test('removed after a create-receipt native bind enqueues delete_node', async () => {
    const { queue, store, api } = await fixture(indexedDB);
    await mapping(store, 'receipt-bound', 'server-receipt', 'root-selected', 'server-r1',
      { title: 'Bound', url: 'https://example.test/bound' }, 'root-selected');
    api.put(bookmark('receipt-bound', 'root-selected', 0, 'Bound', 'https://example.test/bound'));
    const outcome = await queue.removed('receipt-bound', { parentId: 'root-selected', index: 0,
      node: api.node('receipt-bound') });
    assert.equal(outcome.outcome, 'staged');
    await queue.flush();
    assert.deepEqual((await store.listQueue(scope)).map((row) => row.payload.type), ['delete_node']);
    assert.equal((await store.listQueue(scope))[0]?.payload.targetId, 'server-receipt');
    assert.notEqual((await store.getEngineState(scope))?.recoveryFrozen, true);
  });

  test('deduplicates identical delivery and orders distinct out-of-order callbacks by durable ingress ordinal', async () => {
    const { queue, store, api } = await fixture(indexedDB, { mappedNode: true });
    const change = { title: 'One' };
    api.put(bookmark('mapped', 'root-selected', 0, 'One', 'https://example.test/before'));
    await Promise.all([queue.changed('mapped', change), queue.changed('mapped', change)]);
    await queue.moved('mapped', { parentId: 'folder-parent', index: 0, oldParentId: 'root-selected', oldIndex: 0 });
    await queue.flush();
    assert.deepEqual((await store.listQueue(scope)).map((record) => record.payload.type), ['update_node_content']);
    await mapping(store, 'mapped', 'mapped-colp', 'root-selected', 'server-change-r8',
      { title: 'One', url: 'https://example.test/before' });
    await queue.flush();
    const records = await store.listQueue(scope);
    assert.deepEqual(records.map((record) => record.payload.type), ['update_node_content', 'move_node']);
    assert.deepEqual(records.map((record) => record.sequence), [1, 2]);
  });

  test('preserves parent children authority through a pending folder update so a following child move is staged', async () => {
    const { queue, store, api } = await fixture(indexedDB, { mappedNode: true });
    api.put(folder('folder-parent', 'root-selected', 0, 'Renamed parent'));
    assert.equal((await queue.changed('folder-parent', { title: 'Renamed parent' })).outcome, 'staged');

    api.put(bookmark('mapped', 'root-selected', 1, 'Server before', 'https://example.test/before'));
    assert.equal((await queue.moved('mapped', { parentId: 'root-selected', index: 1,
      oldParentId: 'folder-parent', oldIndex: 0 })).outcome, 'staged');

    const events = await store.listBookmarkEvents(scope);
    assert.equal((events[0]!.details.mapping as any).projection.childrenRevision,
      'children-folder-revision-2');
    assert.deepEqual(events.map((event) => (event.details.draft as any).type),
      ['update_node_content', 'move_node']);
  });

  test('emits one delete_subtree for a removed non-empty folder and no descendant records', async () => {
    const { queue, store } = await fixture(indexedDB, { mappedSubtree: true });
    const removed = folder('folder-parent', 'root-selected', 0, 'Parent', [
      bookmark('mapped', 'folder-parent', 0, 'Child', 'https://example.test/child'),
      separator('mapped-separator', 'folder-parent', 1),
    ]);
    await queue.removed('folder-parent', { parentId: 'root-selected', index: 0, node: removed });
    await queue.flush();
    const records = await store.listQueue(scope);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.payload.type, 'delete_subtree');
  });

  test('moves a mapped bookmark out of the boundary by staging a node delete', async () => {
    const { queue, store } = await fixture(indexedDB, { mappedNode: true });
    const outcome = await queue.moved('mapped', { parentId: 'root-unselected', index: 0,
      oldParentId: 'root-selected', oldIndex: 0 });
    assert.equal(outcome.outcome, 'staged');
    await queue.flush();
    const records = await store.listQueue(scope);
    assert.deepEqual(records.map((record) => record.payload.type), ['delete_node']);
    assert.equal(records[0]!.payload.targetId, 'mapped-colp');
  });

  test('uses the removal parent when real Chrome rejects lookup of the deleted node', async () => {
    const { store, api } = await fixture(indexedDB, { mappedNode: true });
    const removed = bookmark('mapped', 'root-selected', 0, 'Removed', 'https://example.test/removed');
    const rejectingApi: BookmarkEventApi = { ...api, async get(id) {
      if (id === 'mapped') throw new Error('Can not find bookmark for id.'); return api.get(id);
    } };
    const queue = createBookmarkEventQueue({ scope, store, api: rejectingApi,
      now: () => '2026-07-27T00:00:00Z', uuid: deterministicIds(), autoFlush: false });
    assert.equal((await queue.removed('mapped', { parentId: 'root-selected', index: 0, node: removed })).outcome, 'staged');
    await queue.flush(); const records = await store.listQueue(scope);
    assert.equal(records.length, 1); assert.equal(records[0]!.payload.type, 'delete_node');
  });

  test('stages an unpositioned create when native children lookup remains unavailable', async () => {
    const { store, api } = await fixture(indexedDB);
    await mapping(store, 'known-sibling', 'known-sibling-colp', 'root-selected', 'known-sibling-r1',
      { title: 'Known sibling' }, 'root-selected');
    const rejectingApi: BookmarkEventApi = { ...api, async getChildren() {
      throw new DOMException('sensitive native API detail', 'UnknownError');
    } };
    const queue = createBookmarkEventQueue({ scope, store, api: rejectingApi,
      now: () => '2026-07-27T00:00:00Z', uuid: deterministicIds(), autoFlush: false,
      childLookupRetryDelaysMs: [0] });
    assert.equal((await queue.created('new', bookmark('new', 'root-selected', 0, 'New',
      'https://example.test/new'))).outcome, 'staged');
    assert.equal((await store.listBookmarkEvents(scope)).length, 1);
  });

  test('falls back to the parent subtree when native getChildren rejects', async () => {
    const { store, api } = await fixture(indexedDB);
    const created = bookmark('new', 'root-selected', 0, 'New', 'https://example.test/new');
    const fallbackApi: BookmarkEventApi = { ...api,
      async getChildren() { throw new DOMException('native getChildren failed', 'UnknownError'); },
      async getSubTree(id) { return [{ id, title: 'Selected root', type: 'folder', children: [created] }]; } };
    const queue = createBookmarkEventQueue({ scope, store, api: fallbackApi,
      now: () => '2026-07-27T00:00:00Z', uuid: deterministicIds(), autoFlush: false });
    assert.equal((await queue.created(created.id, created)).outcome, 'staged');
    assert.equal((await store.listBookmarkEvents(scope)).length, 1);
  });

  test('retries the transient onCreated window until Chrome exposes the new siblings', async () => {
    const { store, api } = await fixture(indexedDB); let attempts = 0;
    await mapping(store, 'known-sibling', 'known-sibling-colp', 'root-selected', 'known-sibling-r1',
      { title: 'Known sibling' }, 'root-selected');
    const created = bookmark('new', 'root-selected', 0, 'New', 'https://example.test/new');
    const eventuallyConsistentApi: BookmarkEventApi = { ...api, async getChildren() {
      attempts += 1; if (attempts < 3) throw new DOMException('bookmark index not ready', 'UnknownError');
      return [created];
    } };
    const queue = createBookmarkEventQueue({ scope, store, api: eventuallyConsistentApi,
      now: () => '2026-07-27T00:00:00Z', uuid: deterministicIds(), autoFlush: false,
      childLookupRetryDelaysMs: [0, 0, 0] });
    assert.equal((await queue.created(created.id, created)).outcome, 'staged');
    assert.equal(attempts, 3);
  });

  test('does not query Chrome placement when the parent has no protocol sibling anchors', async () => {
    const { store, api } = await fixture(indexedDB); let lookups = 0;
    const created = bookmark('new-child', 'folder-parent', 0, 'New child', 'https://example.test/new-child');
    const unavailableApi: BookmarkEventApi = { ...api, async getChildren() {
      lookups += 1; throw new DOMException('bookmark index not ready', 'UnknownError');
    } };
    const queue = createBookmarkEventQueue({ scope, store, api: unavailableApi,
      now: () => '2026-07-27T00:00:00Z', uuid: deterministicIds(), autoFlush: false });
    assert.equal((await queue.created(created.id, created)).outcome, 'staged');
    assert.equal(lookups, 0);
  });

  test('orders consecutive create callbacks from their durable indexes without querying an unsettled Chrome tree', async () => {
    const { store, api } = await fixture(indexedDB); let lookups = 0;
    const first = folder('new-folder', 'folder-parent', 0, 'New folder');
    const second = bookmark('new-bookmark', 'folder-parent', 1, 'New bookmark', 'https://example.test/new-bookmark');
    const unavailableApi: BookmarkEventApi = { ...api, async getChildren() {
      lookups += 1; throw new DOMException('bookmark index not ready', 'UnknownError');
    } };
    const queue = createBookmarkEventQueue({ scope, store, api: unavailableApi,
      now: () => '2026-07-27T00:00:00Z', uuid: deterministicIds(), autoFlush: false });
    assert.equal((await queue.created(first.id, first)).outcome, 'staged');
    assert.equal((await queue.created(second.id, second)).outcome, 'staged');
    const events = await store.listBookmarkEvents(scope);
    assert.equal((events[1]!.details.context as any).afterNativeId, first.id);
    assert.equal(lookups, 0);
  });

  test('does not reuse a confirmed create index after later tree mutations can make it stale', async () => {
    const initial = await fixture(indexedDB, { autoFlush: false });
    const first = folder('confirmed-folder', 'folder-parent', 0, 'Confirmed folder');
    assert.equal((await initial.queue.created(first.id, first)).outcome, 'staged');
    await initial.queue.flush();
    const create = (await initial.store.listQueue(scope))[0]!;
    await initial.store.rebindProvisionalBookmarkIdentity(scope, first.id, create.opId,
      'confirmed-folder-colp', 'confirmed-folder-r1');
    let lookups = 0;
    const unavailableApi: BookmarkEventApi = { ...initial.api, async getChildren() {
      lookups += 1; throw new DOMException('bookmark index unavailable', 'UnknownError');
    } };
    const queue = createBookmarkEventQueue({ scope, store: initial.store, api: unavailableApi,
      now: () => '2026-07-27T00:00:00Z', uuid: deterministicIds(100), autoFlush: false,
      childLookupRetryDelaysMs: [0] });
    assert.equal((await queue.created('later', bookmark('later', 'folder-parent', 1, 'Later',
      'https://example.test/later'))).outcome, 'staged');
    assert.equal(lookups, 1);
    const latest = (await initial.store.listBookmarkEvents(scope)).at(-1)!;
    assert.equal((latest.details.context as any).afterNativeId, undefined);
    assert.equal((latest.details.context as any).beforeNativeId, undefined);
  });

  test('fails closed before constructing or persisting content for private, unselected and unknown mappings', async () => {
    const { queue, store, api } = await fixture(indexedDB);
    for (const node of [bookmark('private-secret', 'root-private', 0, 'PRIVATE-SENTINEL', 'https://secret.invalid/p'),
      bookmark('unselected-secret', 'root-unselected', 0, 'UNSELECTED-SENTINEL', 'https://secret.invalid/u'),
      bookmark('unknown-secret', 'missing-parent', 0, 'UNKNOWN-SENTINEL', 'https://secret.invalid/x')]) {
      api.put(node); await queue.created(node.id, node);
    }
    await queue.flush();
    assert.deepEqual(await store.listQueue(scope), []);
    const exported = JSON.stringify(await store.exportScope(scope));
    assert.doesNotMatch(exported, /PRIVATE-SENTINEL|UNSELECTED-SENTINEL|UNKNOWN-SENTINEL|secret\.invalid/);
  });

  test('rejects protocol-invalid and over-budget payloads before a queue record is durable', async () => {
    for (const candidate of [
      bookmark('invalid', 'root-selected', 0, 'Invalid', 'javascript:alert(1)'),
      bookmark('large', 'root-selected', 0, 'x'.repeat(70 * 1024), 'https://example.test/large'),
    ]) {
      const isolated = await fixture(new IDBFactory()); isolated.api.put(candidate);
      assert.equal((await isolated.queue.created(candidate.id, candidate)).outcome, 'filtered');
      assert.deepEqual(await isolated.store.listQueue(scope), []);
      assert.deepEqual(await isolated.store.listBookmarkEvents(scope), []);
    }
  });

  test('does not let an unbound legacy apply-intent swallow a native event', async () => {
    const { queue, store, api } = await fixture(indexedDB, { mappedNode: true });
    const correlation = await queue.correlationFor('change', 'mapped', { title: 'Remote title' });
    await store.createApplyIntent(scope, { intentId: 'intent-1', correlationId: correlation,
      operationId: 'remote-op', expected: { kind: 'change', nativeId: 'mapped' },
      expiresAt: Date.parse('2099-07-28T00:00:00Z') });
    assert.equal((await queue.changed('mapped', { title: 'Remote title' })).outcome, 'staged');
    api.put(bookmark('mapped', 'root-selected', 0, 'User title', 'https://example.test/before'));
    assert.equal((await queue.changed('mapped', { title: 'User title' })).outcome, 'staged');
    await queue.flush();
    assert.ok((await store.listQueue(scope)).length >= 1);
  });

  test('matches a Pull change intent on native fields while preserving protocol-only projection content', async () => {
    const { queue, store, api } = await fixture(indexedDB, { mappedNode: true });
    const mapping = await store.getMappingByNativeId(scope, 'mapped');
    await store.putMapping(scope, { nativeId: mapping!.nativeId, colpId: mapping!.colpId,
      rootNativeId: mapping!.rootNativeId, nodeKind: mapping!.nodeKind, parentNativeId: mapping!.parentNativeId,
      projection: { ...mapping!.projection, content: {
      ...mapping!.projection.content!, visibility: 'inherit',
      extensions: { 'https://unknown.example/extension': { marker: 'preserved' } } } } });
    const event = { eventId: 'remote-change-event', cursor: 'cursor-next', operationId: 'remote-change',
      effectId: 'remote-change-effect', effectDigest: 'sha256:remote-effect', operationDigest: 'sha256:remote-operation',
      kind: 'node_content_updated', payload: {}, initialState: 'staged' as const };
    await store.stagePullPage(scope, { pageId: 'remote-change-page', previousCursor: 'cursor-3', nextCursor: 'cursor-next',
      collectionRevision: 'revision-next', pageDigest: 'sha256:remote-page', events: [event], effectPages: [] });
    const nativePostState = { title: 'Remote title', url: 'https://example.test/before' };
    const correlationId = await queue.correlationFor('change', 'mapped', nativePostState);
    await store.preparePullIntent(scope, event.eventId, { intentId: 'intent:remote-change', correlationId,
      operationId: event.operationId, eventId: event.eventId, effectId: event.effectId, state: 'intent_prepared',
      expected: { kind: 'change', nativeId: 'mapped' }, expiresAt: Date.now() + 60_000,
      preStateDigest: mapping!.projection.digest, expectedPostState: { digest: 'sha256:native-post-state' },
      nativeTargetId: 'mapped', apiPhase: 'intent_prepared', nativeEventEvidence: null, apiResultEvidence: null });
    await store.markPullBrowserCallStarted(scope, event.eventId);
    api.put(bookmark('mapped', 'root-selected', 0, 'Remote title', 'https://example.test/before'));
    assert.equal((await queue.changed('mapped', { title: 'Remote title' })).outcome, 'apply_intent_reserved');
    assert.deepEqual(await store.listQueue(scope), []);
  });

  test('matches a delayed Pull callback when the mapping is committed before Chrome get becomes consistent', async () => {
    const { queue, store, api } = await fixture(indexedDB, { mappedNode: true });
    const mapping = await store.getMappingByNativeId(scope, 'mapped');
    const finalContent = { title: 'Merged title', url: 'https://example.test/merged' };
    const event = { eventId: 'delayed-change-event', cursor: 'cursor-next', operationId: 'delayed-change',
      effectId: 'delayed-change-effect', effectDigest: 'sha256:delayed-effect', operationDigest: 'sha256:delayed-operation',
      kind: 'node_content_updated', payload: {}, initialState: 'staged' as const };
    await store.stagePullPage(scope, { pageId: 'delayed-change-page', previousCursor: 'cursor-3', nextCursor: 'cursor-next',
      collectionRevision: 'revision-next', pageDigest: 'sha256:delayed-page', events: [event], effectPages: [] });
    const correlationId = await queue.correlationFor('change', 'mapped', finalContent);
    await store.preparePullIntent(scope, event.eventId, { intentId: 'intent:delayed-change', correlationId,
      operationId: event.operationId, eventId: event.eventId, effectId: event.effectId, state: 'intent_prepared',
      expected: { kind: 'change', nativeId: 'mapped' }, expiresAt: Date.now() + 60_000,
      preStateDigest: mapping!.projection.digest,
      expectedPostState: { digest: correlationId, nativeContent: finalContent },
      nativeTargetId: 'mapped', apiPhase: 'intent_prepared', nativeEventEvidence: null, apiResultEvidence: null });
    await store.markPullBrowserCallStarted(scope, event.eventId);
    await store.putMapping(scope, { nativeId: mapping!.nativeId, colpId: mapping!.colpId,
      rootNativeId: mapping!.rootNativeId, projection: { ...mapping!.projection, revision: 'server-revision-8',
        content: finalContent } });
    api.put(bookmark('mapped', 'root-selected', 0, 'Merged title', 'https://example.test/before'));

    assert.equal((await queue.changed('mapped', { url: finalContent.url })).outcome, 'apply_intent_reserved');
    assert.deepEqual(await store.listQueue(scope), []);
  });

  test('lets active Pull callback fields override a successful but stale Chrome lookup', async () => {
    const { queue, store, api } = await fixture(indexedDB, { mappedNode: true });
    const mapping = await store.getMappingByNativeId(scope, 'mapped');
    const finalContent = { title: 'Remote title', url: 'https://example.test/merged' };
    const event = { eventId: 'stale-lookup-event', cursor: 'cursor-next', operationId: 'stale-lookup-change',
      effectId: 'stale-lookup-effect', effectDigest: 'sha256:stale-lookup-effect',
      operationDigest: 'sha256:stale-lookup-operation', kind: 'node_content_updated', payload: {},
      initialState: 'staged' as const };
    await store.stagePullPage(scope, { pageId: 'stale-lookup-page', previousCursor: 'cursor-3', nextCursor: 'cursor-next',
      collectionRevision: 'revision-next', pageDigest: 'sha256:stale-lookup-page', events: [event], effectPages: [] });
    const correlationId = await queue.correlationFor('change', 'mapped', finalContent);
    await store.preparePullIntent(scope, event.eventId, { intentId: 'intent:stale-lookup', correlationId,
      operationId: event.operationId, eventId: event.eventId, effectId: event.effectId, state: 'intent_prepared',
      expected: { kind: 'change', nativeId: 'mapped' }, expiresAt: Date.now() + 60_000,
      preStateDigest: mapping!.projection.digest,
      expectedPostState: { digest: correlationId, nativeContent: finalContent },
      nativeTargetId: 'mapped', apiPhase: 'intent_prepared', nativeEventEvidence: null, apiResultEvidence: null });
    await store.markPullBrowserCallStarted(scope, event.eventId);
    api.put(bookmark('mapped', 'root-selected', 0, 'Remote title', 'https://example.test/before'));

    assert.equal((await queue.changed('mapped', { url: finalContent.url })).outcome, 'apply_intent_reserved');
    assert.deepEqual(await store.listQueue(scope), []);
  });

  test('matches one field from a multi-field Pull callback when Chrome lookup is wholly stale', async () => {
    const { queue, store, api } = await fixture(indexedDB, { mappedNode: true });
    const mapping = await store.getMappingByNativeId(scope, 'mapped');
    const finalContent = { title: 'Remote title', url: 'https://example.test/merged' };
    const event = { eventId: 'split-callback-event', cursor: 'cursor-next', operationId: 'split-callback-change',
      effectId: 'split-callback-effect', effectDigest: 'sha256:split-callback-effect',
      operationDigest: 'sha256:split-callback-operation', kind: 'node_content_updated', payload: {},
      initialState: 'staged' as const };
    await store.stagePullPage(scope, { pageId: 'split-callback-page', previousCursor: 'cursor-3', nextCursor: 'cursor-next',
      collectionRevision: 'revision-next', pageDigest: 'sha256:split-callback-page', events: [event], effectPages: [] });
    const correlationId = await queue.correlationFor('change', 'mapped', finalContent);
    await store.preparePullIntent(scope, event.eventId, { intentId: 'intent:split-callback', correlationId,
      operationId: event.operationId, eventId: event.eventId, effectId: event.effectId, state: 'intent_prepared',
      expected: { kind: 'change', nativeId: 'mapped' }, expiresAt: Date.now() + 60_000,
      preStateDigest: mapping!.projection.digest,
      expectedPostState: { digest: correlationId, nativeContent: finalContent },
      nativeTargetId: 'mapped', apiPhase: 'intent_prepared', nativeEventEvidence: null, apiResultEvidence: null });
    await store.markPullBrowserCallStarted(scope, event.eventId);
    api.put(bookmark('mapped', 'root-selected', 0, 'Before', 'https://example.test/before'));

    assert.equal((await queue.changed('mapped', { title: finalContent.title })).outcome, 'apply_intent_reserved');
    assert.deepEqual(await store.listQueue(scope), []);
  });

  test('never deletes the collection through the selected sync root itself', async () => {
    // The selected root is a boundary, not a syncable member: its mapping
    // carries the collection's canonical root id. Removing that folder
    // locally must never emit a delete against the collection root (which
    // would wipe the library on the server); the mapping survives so root
    // reconciliation can report root_missing and ask for a new folder.
    const { queue, store, api } = await fixture(indexedDB);
    const rootMapping = (await store.getMappingByNativeId(scope, 'root-selected'))!;
    api.put(folder('root-selected', '1', 0, 'Selected root'));
    const outcome = await queue.removed('root-selected', { parentId: '1', index: 0,
      node: api.node('root-selected') });
    await queue.flush();
    assert.equal(outcome.outcome, 'filtered');
    assert.deepEqual(await store.listQueue(scope), []);
    assert.equal((await store.getMappingByNativeId(scope, 'root-selected'))?.colpId, rootMapping.colpId);
  });

  test('deleting a folder inside the boundary never drops the selected root mapping', async () => {
    const { queue, store, api } = await fixture(indexedDB, { mappedSubtree: true });
    api.put(folder('folder-parent', 'root-selected', 0, 'Parent',
      [bookmark('mapped', 'folder-parent', 0, 'Child', 'https://example.test/child')]));
    await queue.removed('folder-parent', { parentId: 'root-selected', index: 0, node: api.node('folder-parent') });
    await queue.flush();
    const records = await store.listQueue(scope);
    assert.deepEqual(records.map((record) => record.payload.type), ['delete_subtree']);
    assert.equal((records[0]!.payload as { targetId?: string }).targetId, 'folder-colp');
    assert.ok(await store.getMappingByNativeId(scope, 'root-selected'), 'the boundary root mapping must survive');
  });

  test('holds a move into an unconfirmed folder until its children fence arrives instead of dropping it', async () => {
    // "Create a folder, drag a bookmark in" within one server round trip:
    // the folder is mapped but its childrenRevision has not echoed back.
    // The move used to be silently filtered — the bookmark then stayed in
    // its old place in the library forever.
    const { queue, store, api } = await fixture(indexedDB, { mappedNode: true });
    await store.putMapping(scope, { nativeId: 'folder-fresh', colpId: 'folder-fresh-colp',
      rootNativeId: 'root-selected', nodeKind: 'folder', parentNativeId: 'root-selected',
      projection: { revision: 'server-folder-r1', digest: 'sha256:folder-fresh', content: { title: 'Fresh' } } });
    api.put(folder('folder-fresh', 'root-selected', 0, 'Fresh'));
    api.put(bookmark('mapped', 'folder-fresh', 0, 'Server before', 'https://example.test/before'));

    const outcome = await queue.moved('mapped', { parentId: 'folder-fresh', index: 0,
      oldParentId: 'root-selected', oldIndex: 0 });
    assert.equal(outcome.outcome, 'staged');
    await queue.flush();
    // Held durably, not committed with a fabricated fence and not dropped.
    assert.deepEqual(await store.listQueue(scope), []);
    assert.deepEqual((await store.listBookmarkEvents(scope)).map((event) => event.status), ['pending']);

    // The folder confirmation echo delivers the real children fence.
    await mapping(store, 'folder-fresh', 'folder-fresh-colp', 'root-selected', 'server-folder-r2',
      { title: 'Fresh' }, 'root-selected');
    await queue.flush();
    const records = await store.listQueue(scope);
    assert.deepEqual(records.map((record) => record.payload.type), ['move_node']);
    assert.equal((records[0]!.payload.payload as { baseTargetParentRevision?: string }).baseTargetParentRevision,
      'children-server-folder-r2');
    assert.equal((records[0]!.payload.payload as { newParentId?: string }).newParentId, 'folder-fresh-colp');
  });

  test('a move into a folder still awaiting its create confirmation stages and flushes after the rebind', async () => {
    const { queue, store, api } = await fixture(indexedDB, { mappedNode: true });
    api.put(folder('folder-new', 'root-selected', 1, 'Brand new'));
    await queue.created('folder-new', api.node('folder-new'));
    api.put(bookmark('mapped', 'folder-new', 0, 'Server before', 'https://example.test/before'));

    const outcome = await queue.moved('mapped', { parentId: 'folder-new', index: 0,
      oldParentId: 'root-selected', oldIndex: 0 });
    assert.equal(outcome.outcome, 'staged');
    await queue.flush();
    const createOnly = await store.listQueue(scope);
    assert.deepEqual(createOnly.map((record) => record.payload.type), ['create_node']);

    await store.rebindProvisionalBookmarkIdentity(scope, 'folder-new', createOnly[0]!.opId,
      'server-folder-new', 'server-folder-r1');
    await mapping(store, 'folder-new', 'server-folder-new', 'root-selected', 'server-folder-r1',
      { title: 'Brand new' }, 'root-selected');
    await queue.flush();
    assert.deepEqual((await store.listQueue(scope)).map((record) => record.payload.type),
      ['create_node', 'move_node']);
  });

  test('flush while enginePhase is offline still commits a create under a bound mount root', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'collection-revision-3', cursor: 'cursor-3' }, selectedRoots: [],
      rootStatus: 'ready', firstRun: 'completed' });
    await store.putMountBinding(scope, {
      mountId: 'mount-bar', nativeRootId: '1', remoteMountNodeId: 'server-mount-bar', boundaryVersion: '1',
      materialized: false, status: 'active', rootRole: 'bookmarks-bar',
    });
    await store.transitionEngine(scope, { phase: 'offline', updatedAt: 1, recoveryFrozen: false,
      notBefore: 0, authorityRefreshRequired: false });
    const api = memoryApi();
    api.put(folder('0', '', 0, 'Root'));
    api.put(folder('1', '0', 0, 'Bar'));
    const node = bookmark('live-offline', '1', 0, 'Offline', 'https://example.test/offline');
    api.put(node);
    const queue = createBookmarkEventQueue({ scope, store, api, now: () => '2026-07-27T00:00:00Z',
      uuid: deterministicIds(), autoFlush: false });
    assert.equal((await queue.created('live-offline', node)).outcome, 'staged');
    await queue.flush();
    const records = await store.listQueue(scope);
    assert.deepEqual(records.map((record) => record.payload.type), ['create_node']);
    assert.equal((records[0]!.payload.payload as { parentId: string }).parentId, 'server-mount-bar');
    assert.doesNotMatch(JSON.stringify(records), /pending-|inbox-parent/);
    await store.transitionEngine(scope, { phase: 'sleeping', updatedAt: 2, recoveryFrozen: false,
      notBefore: 0, authorityRefreshRequired: false });
    await queue.flush();
    assert.equal((await store.listQueue(scope)).length, 1);
    assert.equal((await store.listBookmarkEvents(scope)).filter((event) => event.status === 'pending').length, 0);
  });

});
