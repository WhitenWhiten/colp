/**
 * Owner: KNS-08 (QA). Fixture: see e2e/kns-08-ids.ts.
 * Run: see e2e/kns-08-ids.ts.
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { recoverVerifiedOrFreeze } from '../src/recovery-guard.js';
import { createSyncStateStore, SyncStateError, type JsonObject, type MappingInput } from '../src/sync-state-store.js';
import {
  ack, json, nonemptyMountSnapshot, emptyPullPage, scope as engineScope, setup as setupDurableEngine,
  snapshot,
} from './durable-sync-engine-harness.js';
import { readServiceWorkerGraph } from './service-worker-graph.js';
import { IDBFactory } from 'fake-indexeddb';
import {
  assertWireHasNoPendingIdentity, bootstrapCreateReceiptFixture, deterministicIds, endpoints,
  bookmark, enqueueUpdate, fixture, folder, indexedDB, installKns04IndexedDb, mapping, memoryApi,
  pushOptions, scope,
} from './kns-04-push-harness.js';

const packageRoot = resolve(import.meta.dirname, '..');
installKns04IndexedDb();

describe('KNS-04 push receipts, mount bind and bootstrap snapshot', () => {
  test('terminal special-role create_node receipt writes remoteMountNodeId without a pending mapping', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-mount', expiresAt: 10_000 },
      checkpoint: null, selectedRoots: [], rootStatus: 'ready' });
    await store.putMountBinding(scope, {
      mountId: 'mount-bar', nativeRootId: 'root-selected', remoteMountNodeId: null, boundaryVersion: '1',
      materialized: false, status: 'pending', rootRole: 'bookmarks-bar',
    });
    const payload: JsonObject = { opId: 'op-mount-bar', replicaId: scope.replicaId, sequence: 1,
      collectionId: scope.collectionId, type: 'create_node', baseRevision: null,
      occurredAt: '2026-07-27T00:00:00.000Z', dependencies: [], payload: { parentId: 'folder-root',
        node: { kind: 'folder', title: 'bookmarks-bar', folderRole: 'bookmarks-bar' } } };
    const queued = await store.allocateSequenceAndEnqueue(scope, { opId: 'op-mount-bar', batchId: 'batch-mount-bar',
      idempotencyKey: 'op-mount-bar', digest: 'sha256:mount-bar', endpointIdentity: 'syncPush',
      mediaType: 'application/json', baseRevision: null, operationRevision: 'local-mount-bar',
      status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload }, { allowUnstamped: true });
    const clock = { now: 10_000 };
    const worker = createOutboundPushWorker({ ...pushOptions(store, clock), fetch: async (_url, init) => json(200, {
      batchId: JSON.parse(String(init?.body)).batchId, results: [{ opId: queued.opId, sequence: 1,
        status: 'applied', targetId: 'server-mount-bar', revision: 'server-mount-r1', cursor: 'cursor-1',
        warnings: [] }], serverCursor: 'cursor-1' }) });
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.equal((await store.listQueue(scope))[0]?.status, 'terminal');
    assert.equal((await store.listMountBindings(scope))[0]?.remoteMountNodeId, 'server-mount-bar');
    assert.equal((await store.listMountBindings(scope))[0]?.status, 'active');
    assert.equal(await store.getMappingByColpId(scope, 'pending-op-mount-bar'), null);
    assert.equal((await store.getMappingByNativeId(scope, 'root-selected'))?.colpId, 'server-mount-bar');
  });

  test.each([
    ['nativeId', { nativeId: 'root-selected', colpId: 'server-mount-bar', rootNativeId: 'root-selected' }],
    ['nativeId other colpId', { nativeId: 'root-selected', colpId: 'local-root-uuid', rootNativeId: 'root-selected' }],
    ['colpId', { nativeId: 'recovery:mount-bar', colpId: 'server-mount-bar', rootNativeId: 'recovery:root' }],
  ] as const)('mount-resolve receipt stays terminal when a %s mapping already exists', async (_kind, prior) => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-mount', expiresAt: 10_000 },
      checkpoint: null, selectedRoots: [], rootStatus: 'ready' });
    await store.putMountBinding(scope, {
      mountId: 'mount-bar', nativeRootId: 'root-selected', remoteMountNodeId: null, boundaryVersion: '1',
      materialized: false, status: 'pending', rootRole: 'bookmarks-bar',
    });
    await store.putMapping(scope, { ...prior, nodeKind: 'folder',
      projection: { revision: 'snapshot-r1', childrenRevision: 'children-snapshot-r1', digest: 'sha256:snapshot-r1',
        content: { title: 'Bar', folderRole: 'bookmarks-bar' } } });
    const payload: JsonObject = { opId: 'op-mount-bar', replicaId: scope.replicaId, sequence: 1,
      collectionId: scope.collectionId, type: 'create_node', baseRevision: null,
      occurredAt: '2026-07-27T00:00:00.000Z', dependencies: [], payload: { parentId: 'folder-root',
        node: { kind: 'folder', title: 'bookmarks-bar', folderRole: 'bookmarks-bar' } } };
    const queued = await store.allocateSequenceAndEnqueue(scope, { opId: 'op-mount-bar', batchId: 'batch-mount-bar',
      idempotencyKey: 'op-mount-bar', digest: 'sha256:mount-bar', endpointIdentity: 'syncPush',
      mediaType: 'application/json', baseRevision: null, operationRevision: 'local-mount-bar',
      status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload }, { allowUnstamped: true });
    const clock = { now: 10_000 };
    const worker = createOutboundPushWorker({ ...pushOptions(store, clock), fetch: async (_url, init) => json(200, {
      batchId: JSON.parse(String(init?.body)).batchId, results: [{ opId: queued.opId, sequence: 1,
        status: 'applied', targetId: 'server-mount-bar', revision: 'server-mount-r1', cursor: 'cursor-1',
        warnings: [] }], serverCursor: 'cursor-1' }) });
    assert.equal((await worker.drain()).outcome, 'terminal');
    const exported = await store.exportScope(scope);
    assert.equal(exported.queue[0]?.status, 'terminal');
    assert.equal(exported.queue[0]?.recovery?.code, undefined);
    assert.equal(exported.receipts.length, 1);
    assert.equal(exported.receipts[0]?.kind, 'terminal');
    assert.equal(await store.getMappingByColpId(scope, 'pending-op-mount-bar'), null);
    assert.equal((await store.getMappingByNativeId(scope, prior.nativeId))?.colpId, prior.colpId);
    assert.equal((await store.getMappingByColpId(scope, prior.colpId))?.nativeId, prior.nativeId);
    assert.equal((await store.listMountBindings(scope))[0]?.remoteMountNodeId, 'server-mount-bar');
  });

  test('bindMountMapping twice is a no-op', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
      checkpoint: null, selectedRoots: [], rootStatus: 'ready' });
    const input = { nativeId: 'root-selected', colpId: 'server-mount-bar', mountId: 'mount-bar',
      rootRole: 'bookmarks-bar' as const, revision: 'server-mount-r1' };
    assert.equal(await store.bindMountMapping(scope, input), true);
    const first = await store.getMappingByNativeId(scope, 'root-selected');
    assert.equal(await store.bindMountMapping(scope, input), false);
    assert.deepEqual(await store.getMappingByNativeId(scope, 'root-selected'), first);
    assert.equal(await store.bindMountMapping(scope, { ...input, nativeId: 'other-native' }), false);
    assert.equal((await store.getMappingByColpId(scope, 'server-mount-bar'))?.nativeId, 'root-selected');
    await store.putMapping(scope, { nativeId: 'recovery:other', colpId: 'snapshot-colp', rootNativeId: 'recovery:root',
      nodeKind: 'folder', projection: { revision: 'snapshot-r1', digest: 'sha256:snapshot-r1' } });
    assert.equal(await store.bindMountMapping(scope, { nativeId: 'chrome-bar', colpId: 'snapshot-colp',
      mountId: 'mount-bar', revision: 'server-mount-r1' }), false);
    assert.equal((await store.getMappingByColpId(scope, 'snapshot-colp'))?.nativeId, 'recovery:other');
  });

  test('child create_node after mount bind still terminals', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-child', expiresAt: 10_000 },
      checkpoint: null, selectedRoots: [], rootStatus: 'ready' });
    await store.putMountBinding(scope, {
      mountId: 'mount-bar', nativeRootId: 'root-selected', remoteMountNodeId: null, boundaryVersion: '1',
      materialized: false, status: 'pending', rootRole: 'bookmarks-bar',
    });
    await store.putMapping(scope, { nativeId: 'recovery:mount-bar', colpId: 'server-mount-bar',
      rootNativeId: 'recovery:root', nodeKind: 'folder',
      projection: { revision: 'snapshot-r1', digest: 'sha256:snapshot-r1',
        content: { title: 'Bar', folderRole: 'bookmarks-bar' } } });
    const mountPayload: JsonObject = { opId: 'op-mount-bar', replicaId: scope.replicaId, sequence: 1,
      collectionId: scope.collectionId, type: 'create_node', baseRevision: null,
      occurredAt: '2026-07-27T00:00:00.000Z', dependencies: [], payload: { parentId: 'folder-root',
        node: { kind: 'folder', title: 'bookmarks-bar', folderRole: 'bookmarks-bar' } } };
    const childPayload: JsonObject = { opId: 'op-child-1', replicaId: scope.replicaId, sequence: 2,
      collectionId: scope.collectionId, type: 'create_node', baseRevision: null,
      occurredAt: '2026-07-27T00:00:00.000Z', dependencies: [], payload: { parentId: 'server-mount-bar',
        node: { kind: 'bookmark', title: 'Child', url: 'https://example.test/child' } } };
    await store.allocateSequenceAndEnqueue(scope, { opId: 'op-mount-bar', batchId: 'batch-mount-bar',
      idempotencyKey: 'op-mount-bar', digest: 'sha256:mount-bar', endpointIdentity: 'syncPush',
      mediaType: 'application/json', baseRevision: null, operationRevision: 'local-mount-bar',
      status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload: mountPayload }, { allowUnstamped: true });
    await store.allocateSequenceAndEnqueue(scope, { opId: 'op-child-1', batchId: 'batch-child-1',
      idempotencyKey: 'op-child-1', digest: 'sha256:child-1', endpointIdentity: 'syncPush',
      mediaType: 'application/json', baseRevision: null, operationRevision: 'local-child-1',
      status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload: childPayload }, { allowUnstamped: true });
    const clock = { now: 10_000 };
    const worker = createOutboundPushWorker({ ...pushOptions(store, clock), fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { batchId: string;
        operations: Array<{ opId: string; sequence: number }> };
      const op = body.operations[0]!;
      const applied = op.opId === 'op-mount-bar'
        ? { targetId: 'server-mount-bar', revision: 'server-mount-r1' }
        : { targetId: 'server-child-1', revision: 'server-child-r1' };
      return json(200, { batchId: body.batchId, results: [{ opId: op.opId, sequence: op.sequence, status: 'applied',
        ...applied, cursor: 'cursor-1', warnings: [] }], serverCursor: 'cursor-1' });
    } });
    assert.equal((await worker.drain()).outcome, 'terminal');
    const exported = await store.exportScope(scope);
    assert.deepEqual(exported.queue.map((row) => row.status), ['terminal', 'terminal']);
    assert.equal(exported.receipts.length, 2);
    assert.equal(exported.queue.some((row) => row.recovery?.code === 'constraint'), false);
    assert.equal((await store.getMappingByColpId(scope, 'server-mount-bar'))?.nativeId, 'recovery:mount-bar');
    assert.equal((await store.listMountBindings(scope))[0]?.remoteMountNodeId, 'server-mount-bar');
    assertWireHasNoPendingIdentity(exported.queue);
  });

  test('post-first-run live create under a bound bar enqueues while enginePhase is offline', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'r', cursor: 'c' }, selectedRoots: [], rootStatus: 'ready', firstRun: 'completed' });
    await store.putMountBinding(scope, {
      mountId: 'mount-bar', nativeRootId: '1', remoteMountNodeId: 'server-mount-bar', boundaryVersion: '1',
      materialized: false, status: 'active', rootRole: 'bookmarks-bar',
    });
    assert.equal(await store.getMappingByNativeId(scope, '1'), null);
    await store.transitionEngine(scope, { phase: 'offline', updatedAt: 1, recoveryFrozen: false,
      notBefore: 0, authorityRefreshRequired: false });
    const api = memoryApi();
    api.put(folder('0', '', 0, 'Root'));
    api.put(folder('1', '0', 0, 'Bar'));
    const node = bookmark('offline-live', '1', 0, 'KNS08 offline', 'https://example.test/offline');
    api.put(node);
    const queue = createBookmarkEventQueue({ scope, store, api, now: () => '2026-07-27T00:00:00Z',
      uuid: deterministicIds(), autoFlush: false });
    assert.equal((await queue.created('offline-live', node)).outcome, 'staged');
    await queue.flush();
    const records = await store.listQueue(scope);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.payload.type, 'create_node');
    assert.equal(records[0]!.status, 'pending');
    assert.equal((records[0]!.payload.payload as { parentId: string }).parentId, 'server-mount-bar');
    assertWireHasNoPendingIdentity(records);
    assert.equal((await store.getEngineState(scope))?.phase, 'offline');
    assert.equal((await store.getEngineState(scope))?.recoveryFrozen, false);

    await store.transitionEngine(scope, { phase: 'sleeping', updatedAt: 10_000, recoveryFrozen: false,
      notBefore: 0, authorityRefreshRequired: false });
    const clock = { now: 10_000 };
    const queued = records[0]!;
    const worker = createOutboundPushWorker({ ...pushOptions(store, clock), fetch: async (_url, init) => json(200, {
      batchId: JSON.parse(String(init?.body)).batchId, results: [{ opId: queued.opId, sequence: 1,
        status: 'applied', targetId: 'server-offline-live', revision: 'server-offline-r1', cursor: 'cursor-1',
        warnings: [] }], serverCursor: 'cursor-1' }) });
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.equal((await store.listQueue(scope))[0]?.status, 'terminal');
    assert.equal((await store.getMappingByNativeId(scope, 'offline-live'))?.colpId, 'server-offline-live');
    assert.equal(await store.getMappingByColpId(scope, `pending-${queued.opId}`), null);
  });

  test('bootstrap local-only create_node receipt binds nativeId without writing pending-*', async () => {
    const { store } = await bootstrapCreateReceiptFixture();
    assert.equal((await store.getMappingByNativeId(scope, '5'))?.colpId, 'server-restore-item');
    assert.equal((await store.getMappingByNativeId(scope, '5'))?.parentNativeId, '1');
    assert.equal(await store.getMappingByColpId(scope, 'pending-b3.kns04confirm.create.5'), null);
    const mappings = JSON.stringify(await store.listMappings(scope));
    assert.doesNotMatch(mappings, /pending-/);
    assert.equal((await store.listQueue(scope))[0]?.status, 'terminal');
    assert.equal((await store.getEngineState(scope))?.recoveryFrozen, false);
  });

  test('removed after bootstrap create receipt enqueues delete_node and is not quiet with zero deletes', async () => {
    const { store, queue, api } = await bootstrapCreateReceiptFixture();
    assert.equal((await store.getMappingByNativeId(scope, '5'))?.colpId, 'server-restore-item');
    const node = bookmark('5', '1', 0, 'KNS08 restore item', 'https://example.test/restore');
    api.put(folder('1', '0', 0, 'Bar'));
    const outcome = await queue.removed('5', { parentId: '1', index: 0, node });
    assert.equal(outcome.outcome, 'staged');
    await queue.flush();
    const records = await store.listQueue(scope);
    const deletes = records.filter((row) => row.payload.type === 'delete_node' || row.payload.type === 'delete_subtree');
    assert.ok(deletes.length > 0, `expected a delete in ${records.map((row) => row.payload.type).join(',')}`);
    assert.equal((await store.getEngineState(scope))?.recoveryFrozen, false);
    assertWireHasNoPendingIdentity(records);
    assert.equal(deletes[0]!.payload.targetId, 'server-restore-item');
  });

  test('post-first-run live create receipt binds nativeId so removed enqueues delete_node', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'r', cursor: 'c' }, selectedRoots: [], rootStatus: 'ready', firstRun: 'completed' });
    await store.putMountBinding(scope, {
      mountId: 'mount-bar', nativeRootId: '1', remoteMountNodeId: 'server-mount-bar', boundaryVersion: '1',
      materialized: false, status: 'active', rootRole: 'bookmarks-bar',
    });
    await store.transitionEngine(scope, { phase: 'sleeping', updatedAt: 10_000, recoveryFrozen: false,
      notBefore: 0, authorityRefreshRequired: false });
    const api = memoryApi();
    api.put(folder('0', '', 0, 'Root'));
    api.put(folder('1', '0', 0, 'Bar'));
    const node = bookmark('live-del', '1', 0, 'Live delete', 'https://example.test/live-del');
    api.put(node);
    const queue = createBookmarkEventQueue({ scope, store, api, now: () => '2026-07-27T00:00:00Z',
      uuid: deterministicIds(), autoFlush: false });
    assert.equal((await queue.created('live-del', node)).outcome, 'staged');
    await queue.flush();
    const created = (await store.listQueue(scope))[0]!;
    const clock = { now: 10_000 };
    const worker = createOutboundPushWorker({ ...pushOptions(store, clock), fetch: async (_url, init) => json(200, {
      batchId: JSON.parse(String(init?.body)).batchId, results: [{ opId: created.opId, sequence: 1,
        status: 'applied', targetId: 'server-live-del', revision: 'server-live-del-r1', cursor: 'cursor-1',
        warnings: [] }], serverCursor: 'cursor-1' }) });
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.equal((await store.getMappingByNativeId(scope, 'live-del'))?.colpId, 'server-live-del');
    assert.equal(await store.getMappingByColpId(scope, `pending-${created.opId}`), null);
    const outcome = await queue.removed('live-del', { parentId: '1', index: 0, node });
    assert.equal(outcome.outcome, 'staged');
    await queue.flush();
    const types = (await store.listQueue(scope)).map((row) => row.payload.type);
    assert.equal(types.includes('delete_node'), true);
    assert.equal((await store.getEngineState(scope))?.recoveryFrozen, false);
    assertWireHasNoPendingIdentity(await store.listQueue(scope));
  });

  test('empty collection snapshotRequired wake completes bootstrap and lifts freeze', async () => {
    const fixture = await setupDurableEngine({
      snapshotRequired: true, emptyCollection: true, useVerifiedProjector: true,
    });
    fixture.snapshotResponses.push(json(200, snapshot(1, false, null)));
    fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
    fixture.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-recovered' });
    await fixture.engine.wake('manual');
    const exported = await fixture.store.exportScope(engineScope);
    assert.equal(exported.engine.recoveryFrozen, false);
    assert.equal(exported.engine.phase, 'sleeping');
    assert.equal(exported.ackIntents.at(-1)?.kind, 'bootstrap');
    assert.equal(exported.ackIntents.at(-1)?.state, 'complete');
    assert.equal(fixture.projectCalls, 1);
    assert.equal(exported.mappings.some((row: { colpId: string }) => row.colpId === 'root-server'), true);
    assert.equal(exported.mappings.every((row: { nativeId: string }) => row.nativeId.startsWith('recovery:')), true);
  });

  test('nonempty snapshotRequired second replica completes bootstrap and unfreezes', async () => {
    const fixture = await setupDurableEngine({
      snapshotRequired: true, emptyCollection: true, useVerifiedProjector: true,
    });
    fixture.snapshotResponses.push(json(200, nonemptyMountSnapshot(true)));
    fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
    fixture.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-recovered' });
    await fixture.engine.wake('manual');
    const exported = await fixture.store.exportScope(engineScope);
    assert.equal(exported.engine.recoveryFrozen, false);
    assert.equal(exported.engine.phase, 'sleeping');
    assert.equal(exported.ackIntents.at(-1)?.kind, 'bootstrap');
    assert.equal(exported.ackIntents.at(-1)?.state, 'complete');
    assert.equal(fixture.projectCalls, 1);
    assert.equal((await fixture.store.listMountBindings(engineScope))[0]?.remoteMountNodeId, 'mount-bar');
    const byColp = new Map(exported.mappings.map((row: { colpId: string; nativeId: string }) => [row.colpId, row]));
    assert.equal(byColp.get('root-server')?.nativeId.startsWith('recovery:'), true);
    assert.equal(byColp.get('mount-bar')?.nativeId, '1');
    assert.equal(byColp.get('child-a')?.nativeId.startsWith('recovery:'), false);
    assert.ok(byColp.get('child-a')?.nativeId);
  });

  test('pending first-run create_node queued before freeze drains after unfreeze', async () => {
    const fixture = await setupDurableEngine({
      snapshotRequired: true, emptyCollection: true, useVerifiedProjector: true,
    });
    await fixture.enqueue('op-first-run-1');
    assert.equal((await fixture.store.listQueue(engineScope))[0]?.status, 'pending');
    fixture.snapshotResponses.push(json(200, snapshot(1, false, null)));
    fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
    fixture.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-recovered' });
    await fixture.engine.wake('manual');
    assert.equal((await fixture.store.getEngineState(engineScope))?.recoveryFrozen, false);
    assert.equal(fixture.push.calls, 0);
    assert.equal((await fixture.store.listQueue(engineScope))[0]?.status, 'pending');
    fixture.clock.now = (await fixture.store.getEngineState(engineScope))!.notBefore;
    fixture.push.outcomes = ['terminal'];
    fixture.pullResponses.push(json(200, { events: [], nextCursor: 'cursor-after-bootstrap', hasMore: false,
      collectionRevision: 'revision-1', recommendedPullAfterSeconds: 30 }));
    fixture.ackResponses.push(json(200, ack('cursor-after-bootstrap')));
    await fixture.engine.wake('manual');
    assert.ok(fixture.push.calls >= 1);
    assert.equal((await fixture.store.getEngineState(engineScope))?.recoveryFrozen, false);
  });

  test('frozen queue still throws queue_recovery_frozen', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'r', cursor: 'c' }, selectedRoots: [], rootStatus: 'ready' });
    await store.transitionEngine(scope, { phase: 'recovery', updatedAt: 1, recoveryFrozen: true,
      notBefore: 0, authorityRefreshRequired: false });
    await assert.rejects(() => enqueueUpdate(store, 'op-frozen', 'node-a'), (error: unknown) => {
      assert.equal(error instanceof SyncStateError, true);
      assert.equal((error as SyncStateError).code, 'queue_recovery_frozen');
      return true;
    });
    assert.deepEqual(await store.listQueue(scope), []);

    const { queue, store: eventStore, api } = await fixture({}, new IDBFactory());
    const node = bookmark('frozen-event', 'root-selected', 0, 'Frozen', 'https://example.test/frozen');
    api.put(node);
    await queue.created('frozen-event', node);
    await eventStore.transitionEngine(scope, { phase: 'recovery', updatedAt: 1, recoveryFrozen: true,
      notBefore: 0, authorityRefreshRequired: false });
    await assert.rejects(() => queue.flush(), (error: unknown) => {
      assert.equal(error instanceof SyncStateError, true);
      assert.equal((error as SyncStateError).code, 'queue_recovery_frozen');
      return true;
    });
    assert.deepEqual(await eventStore.listQueue(scope), []);
  });

  test('empty collection root snapshot cutover does not freeze on unproven Collection root identity', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'r', cursor: 'c' }, selectedRoots: [], rootStatus: 'ready', firstRun: 'running' });
    const staged: MappingInput[] = [{
      nativeId: 'recovery:root-server', colpId: 'root-server', rootNativeId: 'recovery:root', nodeKind: 'folder',
      projection: { revision: 'r-root', childrenRevision: 'children-root', digest: 'sha256:root',
        content: { title: '' } },
    }];
    const projected = await recoverVerifiedOrFreeze({
      scope, store, staged, freezeUnprovenIdentity: true, api: {
        create: () => Promise.reject(new Error('chrome_should_not_run')),
        update: () => Promise.reject(new Error('chrome_should_not_run')),
        move: () => Promise.reject(new Error('chrome_should_not_run')),
        remove: () => Promise.reject(new Error('chrome_should_not_run')),
        removeTree: () => Promise.reject(new Error('chrome_should_not_run')),
        get: async () => [], getChildren: async () => [],
      },
    });
    assert.equal(projected.length, 1);
    assert.equal(projected[0]?.nativeId, 'recovery:root-server');
    assert.equal((await store.getEngineState(scope))?.recoveryFrozen, undefined);
  });

  test('nonempty virtual snapshot cutover does not freeze or invent Chrome folders', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'r', cursor: 'c' }, selectedRoots: [], rootStatus: 'ready', firstRun: 'running' });
    await store.putMountBinding(scope, {
      mountId: 'mount-bar', nativeRootId: '1', remoteMountNodeId: null, boundaryVersion: '1',
      materialized: false, status: 'pending', rootRole: 'bookmarks-bar',
    });
    const staged: MappingInput[] = [{
      nativeId: 'recovery:root-server', colpId: 'root-server', rootNativeId: 'recovery:root', nodeKind: 'folder',
      projection: { revision: 'r-root', childrenRevision: 'children-root', digest: 'sha256:root',
        content: { title: '', folderRole: 'root' } },
    }, {
      nativeId: 'recovery:mount-bar', colpId: 'mount-bar', rootNativeId: 'recovery:root', nodeKind: 'folder',
      parentColpId: 'root-server', rootRole: 'bookmarks-bar',
      projection: { revision: 'r-bar', childrenRevision: 'children-bar', digest: 'sha256:bar',
        content: { title: 'Bar', folderRole: 'bookmarks-bar' } },
    }, {
      nativeId: 'recovery:child-a', colpId: 'child-a', rootNativeId: 'recovery:root', nodeKind: 'bookmark',
      parentColpId: 'mount-bar', projection: { revision: 'r-child', digest: 'sha256:child',
        content: { title: 'Child', url: 'https://example.test/child' } },
    }];
    let created = 0;
    const nodes = new Map<string, { id: string; parentId?: string; title?: string; url?: string }>([
      ['1', { id: '1', title: 'Bookmarks bar' }],
    ]);
    const projected = await recoverVerifiedOrFreeze({
      scope, store, staged, freezeUnprovenIdentity: true, api: {
        create: async (input) => {
          created += 1; const id = `created-${created}`;
          nodes.set(id, { id, parentId: input.parentId, title: input.title, url: input.url });
          return { id };
        },
        update: () => Promise.reject(new Error('chrome_should_not_run')),
        move: () => Promise.reject(new Error('chrome_should_not_run')),
        remove: () => Promise.reject(new Error('chrome_should_not_run')),
        removeTree: () => Promise.reject(new Error('chrome_should_not_run')),
        get: async (id) => { const node = nodes.get(id); return node ? [node] : []; },
        getChildren: async (id) => [...nodes.values()].filter((node) => node.parentId === id),
      },
    });
    assert.equal(created, 1);
    assert.equal(projected.find((row) => row.colpId === 'mount-bar')?.nativeId, '1');
    assert.equal(projected.find((row) => row.colpId === 'child-a')?.nativeId, 'created-1');
    assert.equal(nodes.get('created-1')?.parentId, '1');
    assert.equal(nodes.get('created-1')?.title, 'Child');
    assert.equal([...nodes.values()].some((node) => node.title === 'Bar' && node.id !== '1'), false);
    assert.equal((await store.listMountBindings(scope))[0]?.remoteMountNodeId, 'mount-bar');
    assert.equal((await store.getEngineState(scope))?.recoveryFrozen, undefined);
  });

  test('nonempty snapshot under a live native bar mapping Chrome-creates children', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'r', cursor: 'c' }, selectedRoots: [], rootStatus: 'ready', firstRun: 'running',
      mountMode: 'whole-profile' });
    await store.putMountBinding(scope, {
      mountId: 'mount-bar', nativeRootId: '1', remoteMountNodeId: 'mount-bar', boundaryVersion: '1',
      materialized: false, status: 'active', rootRole: 'bookmarks-bar',
    });
    await store.putMapping(scope, {
      nativeId: '1', colpId: 'mount-bar', rootNativeId: '1', nodeKind: 'folder', mountId: 'mount-bar',
      rootRole: 'bookmarks-bar', projection: { revision: 'r-bar', childrenRevision: 'children-bar', digest: 'sha256:bar',
        content: { title: 'Bookmarks bar', folderRole: 'bookmarks-bar' } },
    });
    const staged: MappingInput[] = [{
      nativeId: 'recovery:root-server', colpId: 'root-server', rootNativeId: 'recovery:root', nodeKind: 'folder',
      projection: { revision: 'r-root', childrenRevision: 'children-root', digest: 'sha256:root',
        content: { title: '', folderRole: 'root' } },
    }, {
      nativeId: 'recovery:mount-bar', colpId: 'mount-bar', rootNativeId: 'recovery:root', nodeKind: 'folder',
      parentColpId: 'root-server', rootRole: 'bookmarks-bar',
      projection: { revision: 'r-bar', childrenRevision: 'children-bar', digest: 'sha256:bar',
        content: { title: 'Bar', folderRole: 'bookmarks-bar' } },
    }, {
      nativeId: 'recovery:conflict', colpId: 'conflict', rootNativeId: 'recovery:root', nodeKind: 'bookmark',
      parentColpId: 'mount-bar', projection: { revision: 'r-child', digest: 'sha256:conflict',
        content: { title: 'KNS08 conflict', url: 'https://example.test/conflict' } },
    }, {
      nativeId: 'recovery:folder-b', colpId: 'folder-b', rootNativeId: 'recovery:root', nodeKind: 'folder',
      parentColpId: 'mount-bar', projection: { revision: 'r-folder', childrenRevision: 'children-folder',
        digest: 'sha256:folder', content: { title: 'KNS08 move folder B' } },
    }];
    let created = 0;
    const nodes = new Map<string, { id: string; parentId?: string; title?: string; url?: string }>([
      ['1', { id: '1', title: 'Bookmarks bar' }],
    ]);
    const projected = await recoverVerifiedOrFreeze({
      scope, store, staged, freezeUnprovenIdentity: true, api: {
        create: async (input) => {
          created += 1; const id = `created-${created}`;
          nodes.set(id, { id, parentId: input.parentId, title: input.title, url: input.url });
          return { id };
        },
        update: () => Promise.reject(new Error('chrome_should_not_run')),
        move: () => Promise.reject(new Error('chrome_should_not_run')),
        remove: () => Promise.reject(new Error('chrome_should_not_run')),
        removeTree: () => Promise.reject(new Error('chrome_should_not_run')),
        get: async (id) => { const node = nodes.get(id); return node ? [node] : []; },
        getChildren: async (id) => [...nodes.values()].filter((node) => node.parentId === id),
      },
    });
    assert.equal(created, 2);
    assert.equal(projected.find((row) => row.colpId === 'mount-bar')?.nativeId, '1');
    assert.equal(nodes.get('created-1')?.parentId, '1');
    assert.equal(nodes.get('created-2')?.parentId, '1');
    assert.equal([...nodes.values()].some((node) => node.title === 'Bar' && node.id !== '1'), false);
    assert.equal([...nodes.values()].some((node) => node.title === 'Bookmarks bar' && node.id !== '1'), false);
    assert.ok(projected.find((row) => row.colpId === 'conflict')?.nativeId.startsWith('created-'));
    assert.ok(projected.find((row) => row.colpId === 'folder-b')?.nativeId.startsWith('created-'));
    assert.equal((await store.getMappingByColpId(scope, 'conflict'))?.nativeId.startsWith('created-'), true);
    assert.equal((await store.getEngineState(scope))?.recoveryFrozen, undefined);
  });

  test('empty collection root snapshot still freezes on ghost native Chrome ids', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'r', cursor: 'c' }, selectedRoots: [], rootStatus: 'ready', firstRun: 'running' });
    await store.putMapping(scope, {
      nativeId: '99', colpId: 'ghost', rootNativeId: '1', nodeKind: 'bookmark',
      projection: { revision: 'r1', digest: 'd-ghost', content: { title: 'Ghost', url: 'https://ghost.example' } },
    });
    const staged: MappingInput[] = [{
      nativeId: 'recovery:root-server', colpId: 'root-server', rootNativeId: 'recovery:root', nodeKind: 'folder',
      projection: { revision: 'r-root', childrenRevision: 'children-root', digest: 'sha256:root',
        content: { title: '' } },
    }];
    let created = 0;
    await assert.rejects(() => recoverVerifiedOrFreeze({
      scope, store, staged, freezeUnprovenIdentity: true, api: {
        create: () => { created += 1; return Promise.reject(new Error('chrome_should_not_run')); },
        update: () => Promise.reject(new Error('chrome_should_not_run')),
        move: () => Promise.reject(new Error('chrome_should_not_run')),
        remove: () => Promise.reject(new Error('chrome_should_not_run')),
        removeTree: () => Promise.reject(new Error('chrome_should_not_run')),
        get: async () => [], getChildren: async () => [],
      },
    }), /recovery_identity_unproven/);
    assert.equal(created, 0);
    assert.equal((await store.getEngineState(scope))?.recoveryFrozen, true);
    assert.equal((await store.getEngineState(scope))?.lastError, 'recovery_identity_unproven');
  });

  test('nonempty virtual snapshot still freezes on ghost native Chrome ids', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'r', cursor: 'c' }, selectedRoots: [], rootStatus: 'ready', firstRun: 'running' });
    await store.putMapping(scope, {
      nativeId: '99', colpId: 'ghost', rootNativeId: '1', nodeKind: 'bookmark',
      projection: { revision: 'r1', digest: 'd-ghost', content: { title: 'Ghost', url: 'https://ghost.example' } },
    });
    await store.putMountBinding(scope, {
      mountId: 'mount-bar', nativeRootId: '1', remoteMountNodeId: null, boundaryVersion: '1',
      materialized: false, status: 'pending', rootRole: 'bookmarks-bar',
    });
    const staged: MappingInput[] = [{
      nativeId: 'recovery:root-server', colpId: 'root-server', rootNativeId: 'recovery:root', nodeKind: 'folder',
      projection: { revision: 'r-root', childrenRevision: 'children-root', digest: 'sha256:root',
        content: { title: '', folderRole: 'root' } },
    }, {
      nativeId: 'recovery:mount-bar', colpId: 'mount-bar', rootNativeId: 'recovery:root', nodeKind: 'folder',
      parentColpId: 'root-server', projection: { revision: 'r-bar', childrenRevision: 'children-bar',
        digest: 'sha256:bar', content: { title: 'Bar', folderRole: 'bookmarks-bar' } },
    }];
    let created = 0;
    await assert.rejects(() => recoverVerifiedOrFreeze({
      scope, store, staged, freezeUnprovenIdentity: true, api: {
        create: () => { created += 1; return Promise.reject(new Error('chrome_should_not_run')); },
        update: () => Promise.reject(new Error('chrome_should_not_run')),
        move: () => Promise.reject(new Error('chrome_should_not_run')),
        remove: () => Promise.reject(new Error('chrome_should_not_run')),
        removeTree: () => Promise.reject(new Error('chrome_should_not_run')),
        get: async () => [], getChildren: async () => [],
      },
    }), /recovery_identity_unproven/);
    assert.equal(created, 0);
    assert.equal((await store.getEngineState(scope))?.recoveryFrozen, true);
    assert.equal((await store.listMountBindings(scope))[0]?.remoteMountNodeId, null);
  });

  test('wakes stay in the service worker so popup close cannot cancel durable Push', async () => {
    const worker = await readServiceWorkerGraph();
    const popup = await readFile(resolve(packageRoot, 'src/popup.ts'), 'utf8');
    const bookmarks = await readFile(resolve(packageRoot, 'src/sw/bookmarks.ts'), 'utf8');
    const engine = await readFile(resolve(packageRoot, 'src/sw/engine.ts'), 'utf8');
    for (const reason of ['startup', 'online', 'alarm', 'manual']) {
      assert.match(worker, new RegExp(
        `(?:scheduleSyncEngineWake|recoverBookmarkEventsAfterEngineSettles)\\('${reason}'`,
      ));
    }
    assert.match(bookmarks, /!await hasBookmarkPermission\(\)/);
    assert.doesNotMatch(bookmarks, /compactScope|cleanupAccount|retireScope/);
    assert.doesNotMatch(popup, /createOutboundPushWorker|settleClaimedPush|allocateSequenceAndEnqueue/);
    assert.match(worker, /workCoordinator/);
    assert.match(engine, /needsRecoveryProgress/);
    assert.match(engine, /if \(!applyAllowed && !needsRecoveryProgress\)/);
    assert.match(engine, /hasRecoveryStaging/);
    assert.doesNotMatch(engine, /createBootstrapCoordinator/);
    assert.match(engine, /if \(permissionGranted\) bookmarkListenerLifecycle\.install\(\)/);
    assert.match(engine, /if \(result && !result\.recoveryFrozen\)[\s\S]{0,200}bookmarkListenerLifecycle\.install\(\)/);
    assert.match(worker,
      /validFirstRunRequest\(message\)[\s\S]{0,560}bookmarkListenerLifecycle\.install\(\)[\s\S]{0,240}scheduleSyncEngineWake\('manual'\)/);
    assert.match(worker, /drainBookmarkEventCaptureEvidence[\s\S]{0,400}\.flush\(\)/);
  });
});
