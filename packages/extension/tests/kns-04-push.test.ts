/**
 * Owner: KNS-08 (QA). Fixture: see e2e/kns-08-ids.ts.
 * Run: see e2e/kns-08-ids.ts.
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, test } from 'vitest';
import { translateSyncBrowserDelete } from '@know-n/colp/sync';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { revokeBookmarkSync } from '../src/scope-reconcile.js';
import { createSyncStateStore, type JsonObject } from '../src/sync-state-store.js';
import type { BookmarkEventNode } from '../src/bookmark-event-queue.js';
import {
  ack, json, networkFailure, emptyPullPage, scope as engineScope, setup as setupDurableEngine,
} from './durable-sync-engine-harness.js';
import {
  assertWireHasNoPendingIdentity, bookmark, deterministicIds, enqueueUpdate, fixture, folder,
  indexedDB, installKns04IndexedDb, mapping, memoryApi, pushOptions, scope,
} from './kns-04-push-harness.js';

installKns04IndexedDb();

describe('KNS-04 browser ingress, durable queue and Push', () => {
  test('duplicate live delivery stages one Operation', async () => {
    const { queue, store, api } = await fixture();
    const node = bookmark('dup', 'root-selected', 0, 'Dup', 'https://example.test/dup');
    api.put(node);
    const [first, second] = await Promise.all([queue.created('dup', node), queue.created('dup', node)]);
    assert.deepEqual(new Set([first.outcome, second.outcome]), new Set(['staged', 'duplicate']));
    await queue.flush();
    const records = await store.listQueue(scope);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.payload.type, 'create_node');
    assertWireHasNoPendingIdentity(records);
  });

  test('parent-first holds the child in the inbox and never puts pending-* on the wire', async () => {
    const { queue, store, api } = await fixture();
    const folderNode = folder('folder-new', 'root-selected', 0, 'Folder');
    const childNode = bookmark('child-new', 'folder-new', 0, 'Child', 'https://example.test/child');
    api.put(folderNode); api.put(childNode);
    await queue.created('folder-new', folderNode);
    await queue.created('child-new', childNode);
    await queue.flush();
    let records = await store.listQueue(scope);
    assert.deepEqual(records.map((row) => row.payload.type), ['create_node']);
    assert.equal((await store.listBookmarkEvents(scope)).filter((event) => event.status === 'pending').length, 1);
    assertWireHasNoPendingIdentity(records);
    assert.doesNotMatch(JSON.stringify(records), /inbox-parent/);
    await store.rebindProvisionalBookmarkIdentity(scope, 'folder-new', records[0]!.opId,
      'server-folder-new', 'server-folder-r1');
    await queue.flush();
    records = await store.listQueue(scope);
    assert.deepEqual(records.map((row) => row.payload.type), ['create_node', 'create_node']);
    assert.equal((records[1]!.payload.payload as { parentId: string }).parentId, 'server-folder-new');
    assertWireHasNoPendingIdentity(records);
  });

  test('unselected, managed, private-local and revoked permission produce no outbound Operation', async () => {
    const { queue, store, api } = await fixture();
    await mapping(store, 'root-unselected', 'unselected-colp', 'root-unselected', 'unselected-r1', { title: 'Other' });
    api.put(bookmark('unselected-secret', 'root-unselected', 0, 'UNSELECTED-SENTINEL', 'https://secret.invalid/u'));
    api.put({ ...bookmark('managed-secret', 'root-selected', 0, 'MANAGED-SENTINEL', 'https://secret.invalid/m'),
      unmodifiable: 'managed' });
    api.put(bookmark('private-secret', 'root-private', 0, 'PRIVATE-SENTINEL', 'https://secret.invalid/p'));
    await queue.created('unselected-secret', api.node('unselected-secret'));
    await queue.created('managed-secret', api.node('managed-secret'));
    await queue.created('private-secret', api.node('private-secret'));
    await store.setBrowserRootStatus(scope, 'permission_required');
    api.put(bookmark('revoked-secret', 'root-selected', 1, 'REVOKED-SENTINEL', 'https://secret.invalid/r'));
    await queue.created('revoked-secret', api.node('revoked-secret'));
    await queue.flush();
    assert.deepEqual(await store.listQueue(scope), []);
    const codes = (await store.listIngressDiagnostics(scope)).map((row) => row.code);
    assert.ok(codes.includes('unselected_range'));
    assert.ok(codes.includes('managed'));
    assert.ok(codes.includes('private_local'));
    const exported = JSON.stringify(await store.exportScope(scope));
    assert.doesNotMatch(exported, /UNSELECTED-SENTINEL|MANAGED-SENTINEL|PRIVATE-SENTINEL|REVOKED-SENTINEL|secret\.invalid/);
  });

  test('permission restore does not wipe the queued Operation or mapping', async () => {
    const { queue, store, api } = await fixture({ mappedNode: true });
    api.put(bookmark('mapped', 'root-selected', 0, 'Kept', 'https://example.test/before'));
    await queue.changed('mapped', { title: 'Kept' });
    await queue.flush();
    const beforeQueue = await store.listQueue(scope);
    const beforeOpIds = beforeQueue.map((row) => row.opId);
    const beforeMaps = (await store.listMappings(scope)).length;
    const beforeMapping = await store.getMappingByNativeId(scope, 'mapped');
    assert.equal(beforeQueue.length, 1);
    const revoked = await revokeBookmarkSync(store, scope);
    assert.equal(revoked.mappingCount, beforeMaps);
    assert.equal(revoked.queueLength, beforeQueue.length);
    assert.deepEqual((await store.listQueue(scope)).map((row) => row.opId), beforeOpIds);
    assert.equal((await store.getScope(scope))?.rootStatus, 'permission_required');
    await queue.changed('mapped', { title: 'Ignored while revoked' });
    assert.deepEqual((await store.listQueue(scope)).map((row) => row.opId), beforeOpIds);
    assert.equal((await store.listMappings(scope)).length, beforeMaps);
    await store.configureBrowserRoots(scope, { discovered: [
      { nativeId: 'root-selected', ancestorNativeIds: [] },
      { nativeId: 'folder-parent', ancestorNativeIds: ['root-selected'] },
      { nativeId: 'root-private', ancestorNativeIds: [] },
      { nativeId: 'root-unselected', ancestorNativeIds: [] },
    ], selectedNativeIds: ['root-selected'], privateNativeIds: ['root-private'], status: 'ready' });
    await queue.flush();
    const afterQueue = await store.listQueue(scope);
    assert.equal(afterQueue.length, 1);
    assert.equal(afterQueue[0]!.opId, beforeQueue[0]!.opId);
    assert.equal((await store.getMappingByNativeId(scope, 'mapped'))?.colpId, beforeMapping?.colpId);
    assert.equal((await store.listMappings(scope)).length, beforeMaps);
  });

  test('reorder uploads move_node and still updates the local projection', async () => {
    // A-09 (SR-08). This test used to pin the pre-fix contract, verbatim:
    //   'reorder updates local projection only and never uploads move_node or reorder_children'
    //   assert.equal((await queue.reordered('root-selected', ['mapped', 'folder-parent'])).outcome, 'filtered');
    //   assert.deepEqual(await store.listQueue(scope), []);
    //   ...draft type === 'move_node' -> false, diagnostic 'reorder_children_local_only'
    // A drag is a user edit, so it must reach the collection: the queue now
    // authors the move_node batch (anchored by colpId) and the projection half
    // of the old contract is preserved.
    const { queue, store } = await fixture({ mappedNode: true });
    const before = await store.getMappingByNativeId(scope, 'root-selected');
    assert.equal((await queue.reordered('root-selected', ['mapped', 'folder-parent'])).outcome, 'staged');
    await queue.flush();
    const queued = await store.listQueue(scope);
    assert.deepEqual(queued.map((row) => row.payload.type), ['move_node']);
    assert.equal(queued[0]!.payload.targetId, 'folder-colp');
    assert.equal((queued[0]!.payload.payload as JsonObject).newParentId, before!.colpId);
    assert.equal((queued[0]!.payload.payload as JsonObject).afterId, 'mapped-colp');
    const after = await store.getMappingByNativeId(scope, 'root-selected');
    assert.equal(after?.projection.revision, before?.projection.revision);
    assert.equal(after?.projection.childrenRevision, before?.projection.childrenRevision);
    assert.equal(after?.projection.digest, before?.projection.digest);
    assert.deepEqual(after?.projection.childrenOrder, ['mapped', 'folder-parent']);
    const events = await store.listBookmarkEvents(scope);
    assert.equal(events.some((event) => (event.details.draft as { type?: string } | undefined)?.type === 'move_node'),
      true);
    const diagnostics = await store.listIngressDiagnostics(scope);
    assert.ok(diagnostics.some((row) => row.code === 'reorder_uplink_staged'));
    assert.equal(diagnostics.some((row) => row.code === 'reorder_children_local_only'), false,
      'an uploaded reorder must not be reported as local-only');
  });

  test('empty folder and childless nested folder both delete_subtree when Chrome omits children', async () => {
    const empty = await fixture();
    await mapping(empty.store, 'folder-empty', 'empty-colp', 'root-selected', 'empty-r1', { title: 'Empty' },
      'root-selected');
    empty.api.put(folder('folder-empty', 'root-selected', 1, 'Empty'));
    await empty.queue.removed('folder-empty', { parentId: 'root-selected', index: 1,
      node: empty.api.node('folder-empty') });
    await empty.queue.flush();
    // Protocol (translateSyncBrowserDelete): a folder is always delete_subtree,
    // even when this replica holds no child mapping and Chrome emitted no child
    // event. delete_node for a folder is permanently refused by the server.
    assert.deepEqual((await empty.store.listQueue(scope)).map((row) => row.payload.type), ['delete_subtree']);
    assert.equal((await empty.store.listQueue(scope))[0]!.payload.type,
      translateSyncBrowserDelete({ nodeId: 'folder-empty', nodeKind: 'folder' }).type);

    const nested = await fixture({ mappedSubtree: true }, new IDBFactory());
    await nested.queue.removed('folder-parent', { parentId: 'root-selected', index: 0,
      node: folder('folder-parent', 'root-selected', 0, 'Parent') });
    await nested.queue.flush();
    assert.deepEqual((await nested.store.listQueue(scope)).map((row) => row.payload.type), ['delete_subtree']);
  });

  test('suppression echo does not enqueue an Operation', async () => {
    const { queue, store, api } = await fixture();
    const node = bookmark('echo', 'root-selected', 0, 'Echo', 'https://example.test/echo');
    const event = { eventId: 'remote-create-event', cursor: 'cursor-next', operationId: 'remote-create',
      effectId: 'remote-create-effect', effectDigest: 'sha256:remote-effect', operationDigest: 'sha256:remote-operation',
      kind: 'node_created', payload: {}, initialState: 'staged' as const };
    await store.stagePullPage(scope, { pageId: 'remote-create-page', previousCursor: 'cursor-3', nextCursor: 'cursor-next',
      collectionRevision: 'revision-next', pageDigest: 'sha256:remote-page', events: [event], effectPages: [] });
    const correlationId = queue.correlationFor('create', 'echo', { parentId: 'root-selected',
      node: { kind: 'bookmark', title: 'Echo', url: 'https://example.test/echo' } });
    await store.preparePullIntent(scope, event.eventId, { intentId: 'intent:remote-create', correlationId,
      operationId: event.operationId, eventId: event.eventId, effectId: event.effectId, state: 'intent_prepared',
      expected: { kind: 'create', nativeId: 'echo' }, expiresAt: Date.now() + 60_000,
      nativeTargetId: 'echo', apiPhase: 'intent_prepared', nativeEventEvidence: null, apiResultEvidence: null });
    await store.markPullBrowserCallStarted(scope, event.eventId);
    api.put(node);
    assert.equal((await queue.created('echo', node)).outcome, 'apply_intent_reserved');
    await queue.flush();
    assert.deepEqual(await store.listQueue(scope), []);
  });

  test('first-run none without selected mounts does not emit content Operations', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'r', cursor: 'c' }, selectedRoots: [], rootStatus: 'ready', firstRun: 'none' });
    const api = memoryApi();
    api.put(folder('root-selected', '0', 0, 'Bar'));
    const node = bookmark('preview', 'root-selected', 0, 'Preview', 'https://example.test/preview');
    api.put(node);
    const queue = createBookmarkEventQueue({ scope, store, api, now: () => '2026-07-27T00:00:00Z',
      uuid: deterministicIds(), autoFlush: false });
    assert.equal((await queue.created('preview', node)).outcome, 'filtered');
    await queue.flush();
    assert.deepEqual(await store.listQueue(scope), []);
  });

  test('pending mounts keep ingress open; detached mounts produce no outbound', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'r', cursor: 'c' }, selectedRoots: [], rootStatus: 'ready', firstRun: 'running' });
    await store.putMountBinding(scope, {
      mountId: 'mount-bar', nativeRootId: 'root-selected', remoteMountNodeId: null, boundaryVersion: '1',
      materialized: false, status: 'pending', rootRole: 'bookmarks-bar',
    });
    await store.putMapping(scope, { nativeId: 'root-selected', colpId: 'mount-colp', rootNativeId: 'root-selected',
      nodeKind: 'folder', projection: { revision: 'server-root-r1', childrenRevision: 'children-server-root-r1',
        digest: 'sha256:server-root-r1', content: { title: 'Bar' } } });
    assert.equal(await store.hasActiveMounts(scope), true);
    const api = memoryApi();
    api.put(folder('root-selected', '0', 0, 'Bar'));
    const node = bookmark('live', 'root-selected', 0, 'Live', 'https://example.test/live');
    api.put(node);
    const queue = createBookmarkEventQueue({ scope, store, api, now: () => '2026-07-27T00:00:00Z',
      uuid: deterministicIds(), autoFlush: false });
    assert.equal((await queue.created('live', node)).outcome, 'staged');
    await queue.flush();
    assert.equal((await store.listQueue(scope)).length, 1);
    await store.detachMount(scope, 'mount-bar');
    assert.equal(await store.hasActiveMounts(scope), false);
    api.put(bookmark('after-detach', 'root-selected', 1, 'After', 'https://example.test/after'));
    assert.equal((await queue.created('after-detach', api.node('after-detach'))).outcome, 'filtered');
  });

  test('pending mount with a COLP id and no in-flight bootstrap or rejoin is not an upload boundary after first-run completed', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'r', cursor: 'c' }, selectedRoots: ['mount-colp'], rootStatus: 'ready',
      firstRun: 'completed' });
    await store.putMountBinding(scope, {
      mountId: 'mount-bar', nativeRootId: 'root-selected', remoteMountNodeId: 'mount-colp', boundaryVersion: '1',
      materialized: false, status: 'pending', rootRole: 'bookmarks-bar',
    });
    await store.putMapping(scope, { nativeId: 'root-selected', colpId: 'mount-colp', rootNativeId: 'root-selected',
      nodeKind: 'folder', projection: { revision: 'server-root-r1', childrenRevision: 'children-server-root-r1',
        digest: 'sha256:server-root-r1', content: { title: 'Bar' } } });
    assert.equal(await store.hasActiveMounts(scope), true);
    const api = memoryApi();
    api.put(folder('root-selected', '0', 0, 'Bar'));
    const node = bookmark('rejoin-local', 'root-selected', 0, 'Rejoin', 'https://example.test/rejoin');
    api.put(node);
    const queue = createBookmarkEventQueue({ scope, store, api, now: () => '2026-07-27T00:00:00Z',
      uuid: deterministicIds(), autoFlush: false });
    assert.equal((await queue.created('rejoin-local', node)).outcome, 'filtered');
    await queue.flush();
    assert.deepEqual(await store.listQueue(scope), []);
  });

  test('lost Push success and worker restart replay the same envelope for one server Node', async () => {
    const { queue, store, api } = await fixture();
    const node = bookmark('push-me', 'root-selected', 0, 'Push me', 'https://example.test/push');
    api.put(node);
    await queue.created('push-me', node);
    await queue.flush();
    const queued = (await store.listQueue(scope))[0]!;
    await store.transitionEngine(scope, { phase: 'sleeping', updatedAt: 10_000, recoveryFrozen: false,
      notBefore: 0, authorityRefreshRequired: false });
    const requests: string[] = []; let attempt = 0;
    const clock = { now: 10_000 };
    const options = pushOptions(store, clock);
    const fetcher: typeof fetch = async (_url, init) => {
      requests.push(String(init?.body)); attempt += 1;
      if (attempt === 1) throw new DOMException('timed out', 'AbortError');
      return json(200, { batchId: JSON.parse(String(init?.body)).batchId, results: [{ opId: queued.opId, sequence: 1,
        status: 'applied', targetId: 'node-server-1', revision: 'revision-1', cursor: 'cursor-next', warnings: [] }],
      serverCursor: 'cursor-next' });
    };
    assert.equal((await createOutboundPushWorker({ ...options, fetch: fetcher }).drain()).outcome, 'unknown');
    clock.now = (await store.listQueue(scope))[0]!.retry.notBefore;
    assert.equal((await createOutboundPushWorker({ ...options, fetch: fetcher }).drain()).outcome, 'terminal');
    assert.equal(requests.length, 2);
    assert.equal(requests[0], requests[1]);
    const body = JSON.parse(requests[0]!);
    assert.equal(body.operations[0].opId, queued.opId);
    assert.equal(body.operations[0].sequence, queued.sequence);
    assert.equal((await store.listQueue(scope))[0]?.status, 'terminal');
    assert.equal((await store.getMappingByNativeId(scope, 'push-me'))?.colpId, 'node-server-1');
    // F023/F111: the Push receipt cursor is diagnostic-only — it must land in
    // lastPushServerCursor and never feed the Pull/Ack convergence field.
    assert.equal((await store.getEngineState(scope))?.lastPushServerCursor, 'cursor-next');
    assert.equal((await store.getEngineState(scope))?.lastPublishedCursor, undefined);
    assertWireHasNoPendingIdentity(await store.listQueue(scope));
  });

  test('create receipt colliding with a live colp occupant freezes instead of unmapping', async () => {
    const { queue, store, api } = await fixture();
    const node = bookmark('push-me', 'root-selected', 0, 'Push me', 'https://example.test/push');
    api.put(node);
    await queue.created('push-me', node);
    await queue.flush();
    const queued = (await store.listQueue(scope))[0]!;
    await mapping(store, 'other-live', 'node-server-1', 'root-selected', 'server-other-r1', { title: 'Other' });
    await store.transitionEngine(scope, { phase: 'sleeping', updatedAt: 10_000, recoveryFrozen: false,
      notBefore: 0, authorityRefreshRequired: false });
    const clock = { now: 10_000 };
    const drained = await createOutboundPushWorker({ ...pushOptions(store, clock), fetch: async (_url, init) => json(200, {
      batchId: JSON.parse(String(init?.body)).batchId, results: [{ opId: queued.opId, sequence: 1,
        status: 'applied', targetId: 'node-server-1', revision: 'revision-1', cursor: 'cursor-next', warnings: [] }],
      serverCursor: 'cursor-next' }) }).drain();
    assert.notEqual(drained.outcome, 'terminal');
    const row = (await store.listQueue(scope))[0]!;
    assert.notEqual(row.status, 'terminal');
    assert.equal(row.recovery?.code, 'mapping_identity_collision');
    assert.equal((await store.getMappingByNativeId(scope, 'push-me'))?.colpId, `pending-${queued.opId}`);
    assert.equal((await store.getMappingByColpId(scope, 'node-server-1'))?.nativeId, 'other-live');
    assert.equal((await store.getScope(scope))?.lifecycle, 'recovery_required');
    assert.equal((await store.getEngineState(scope))?.recoveryFrozen, true);
  });

  test('KNS-03 queued create_node drains through the same Push worker', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-server', expiresAt: 10_000 },
      checkpoint: null, selectedRoots: [] });
    const payload: JsonObject = { opId: 'op-bootstrap-1', replicaId: scope.replicaId, sequence: 1,
      collectionId: scope.collectionId, type: 'create_node', baseRevision: null,
      occurredAt: '2026-07-27T00:00:00.000Z', dependencies: [], payload: { parentId: 'mount-colp',
        node: { kind: 'bookmark', title: 'Merged', url: 'https://example.test/merged' } } };
    const queued = await store.allocateSequenceAndEnqueue(scope, { opId: 'op-bootstrap-1', batchId: 'batch-bootstrap-1',
      idempotencyKey: 'op-bootstrap-1', digest: 'sha256:bootstrap-op', endpointIdentity: 'syncPush',
      mediaType: 'application/json', baseRevision: null, operationRevision: 'local-bootstrap',
      status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload }, { allowUnstamped: true });
    const clock = { now: 10_000 };
    const worker = createOutboundPushWorker({ ...pushOptions(store, clock), fetch: async (_url, init) => json(200, {
      batchId: JSON.parse(String(init?.body)).batchId, results: [{ opId: queued.opId, sequence: 1,
        status: 'applied', targetId: 'server-merged', revision: 'server-r1', cursor: 'cursor-1', warnings: [] }],
      serverCursor: 'cursor-1' }) });
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.equal((await store.listQueue(scope))[0]?.status, 'terminal');
  });

  test('rejected and conflicted receipts leave unrelated mappings and queue rows', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
      checkpoint: null, selectedRoots: [] });
    await store.putMapping(scope, { nativeId: 'native-a', colpId: 'node-a', rootNativeId: 'root-selected',
      projection: { revision: 'r-a', digest: 'sha256:a', content: { title: 'A' } } });
    await store.putMapping(scope, { nativeId: 'native-b', colpId: 'node-b', rootNativeId: 'root-selected',
      projection: { revision: 'r-b', digest: 'sha256:b', content: { title: 'B' } } });
    const first = await enqueueUpdate(store, 'op-a', 'node-a');
    await enqueueUpdate(store, 'op-b', 'node-b');
    const lease = await store.acquireLease(scope, 'owner', 1, 10_000);
    await store.claimNextQueue(scope, 'owner', lease.fence, 1);
    await store.settleClaimedPush(scope, first.sequence, 'owner', lease.fence, { outcome: 'rejected',
      recovery: { code: 'policy_denied' } });
    const rows = await store.listQueue(scope);
    assert.equal(rows[0]?.status, 'rejected');
    assert.equal(rows[1]?.status, 'pending');
    assert.equal((await store.getMappingByNativeId(scope, 'native-a'))?.colpId, 'node-a');
    assert.equal((await store.getMappingByNativeId(scope, 'native-b'))?.colpId, 'node-b');

    const conflicted = createSyncStateStore({ indexedDB: new IDBFactory() });
    await conflicted.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
      checkpoint: null, selectedRoots: [] });
    await conflicted.putMapping(scope, { nativeId: 'native-a', colpId: 'node-a', rootNativeId: 'root-selected',
      projection: { revision: 'r-a', digest: 'sha256:a', content: { title: 'A' } } });
    await conflicted.putMapping(scope, { nativeId: 'native-b', colpId: 'node-b', rootNativeId: 'root-selected',
      projection: { revision: 'r-b', digest: 'sha256:b', content: { title: 'B' } } });
    const head = await enqueueUpdate(conflicted, 'op-a', 'node-a');
    await enqueueUpdate(conflicted, 'op-b', 'node-b');
    const conflictLease = await conflicted.acquireLease(scope, 'owner', 1, 10_000);
    await conflicted.claimNextQueue(scope, 'owner', conflictLease.fence, 1);
    await conflicted.settleClaimedPush(scope, head.sequence, 'owner', conflictLease.fence, {
      outcome: 'blocked', retry: { attempt: 0, notBefore: 1 }, recovery: { code: 'conflict_pending' },
      receipt: { opId: head.opId, operationDigest: head.digest, kind: 'terminal', receiptId: 'receipt-conflict',
        resultDigest: 'sha256:conflict', result: { batchId: head.batchId, results: [{ opId: head.opId, sequence: 1,
          status: 'conflicted', cursor: 'cursor-1', conflictId: 'conflict-1', warnings: [] }], serverCursor: 'cursor-1' } },
    });
    const conflictedRows = await conflicted.listQueue(scope);
    assert.equal(conflictedRows[0]?.status, 'blocked');
    assert.equal(conflictedRows[1]?.status, 'pending');
    assert.equal((await conflicted.getMappingByNativeId(scope, 'native-b'))?.colpId, 'node-b');
    // The conflict consumed its sequence: it holds only node-a, so node-b is next.
    assert.equal((await conflicted.claimNextQueue(scope, 'owner', conflictLease.fence, 1))?.opId, 'op-b');
  });

  test('HTTP revision_conflict on one Node leaves an unrelated queue row pending', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
      checkpoint: null, selectedRoots: [] });
    await store.putMapping(scope, { nativeId: 'native-a', colpId: 'node-a', rootNativeId: 'root-selected',
      parentNativeId: 'root-selected', parentColpId: 'root-colp', projection: { revision: 'r-a', digest: 'sha256:a',
        content: { title: 'A' } } });
    await store.putMapping(scope, { nativeId: 'native-b', colpId: 'node-b', rootNativeId: 'root-selected',
      projection: { revision: 'r-b', digest: 'sha256:b', content: { title: 'B' } } });
    await store.putMapping(scope, { nativeId: 'root-selected', colpId: 'root-colp', rootNativeId: 'root-selected',
      nodeKind: 'folder', projection: { revision: 'r-root', childrenRevision: 'children-root-old', digest: 'sha256:root' } });
    await store.putMapping(scope, { nativeId: 'folder-dest', colpId: 'folder-dest', rootNativeId: 'root-selected',
      nodeKind: 'folder', projection: { revision: 'r-dest', childrenRevision: 'children-dest-old', digest: 'sha256:dest' } });
    const move: JsonObject = { opId: 'op-a', replicaId: scope.replicaId, sequence: 1, collectionId: scope.collectionId,
      type: 'move_node', targetId: 'node-a', baseRevision: 'r-a', occurredAt: '2026-07-27T00:00:00.000Z',
      dependencies: [], payload: { newParentId: 'folder-dest', baseSourceParentRevision: 'children-root-old',
        baseTargetParentRevision: 'children-dest-old' } };
    await store.allocateSequenceAndEnqueue(scope, { opId: 'op-a', batchId: 'batch-a', idempotencyKey: 'op-a',
      digest: 'sha256:op-a', endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: 'r-a',
      operationRevision: 'local-a', status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload: move }, { allowUnstamped: true });
    await enqueueUpdate(store, 'op-b', 'node-b');
    const clock = { now: 10_000 };
    const worker = createOutboundPushWorker({ ...pushOptions(store, clock),
      fetch: async () => new Response(JSON.stringify({ type: 'https://know-n.com/colp/problems/revision-conflict',
        title: 'revision_conflict', status: 409, code: 'revision_conflict', retryable: false }), { status: 409,
        headers: { 'Content-Type': 'application/problem+json' } }) });
    assert.equal((await worker.drain()).outcome, 'unknown');
    const rows = await store.listQueue(scope);
    assert.equal(rows[0]?.status, 'unknown');
    assert.equal(rows[0]?.recovery?.code, 'revision_conflict');
    assert.notEqual(rows[0]?.status, 'rejected');
    assert.ok(rows[0]!.retry.attempt >= 1);
    assert.ok(Number.isSafeInteger(rows[0]!.retry.notBefore));
    assert.equal(rows[1]?.status, 'pending');
    assert.equal(rows[1]?.opId, 'op-b');
    assert.equal((await store.getMappingByNativeId(scope, 'native-b'))?.colpId, 'node-b');
  });

  test('HTTP position_context_stale refreshes parent children then terminals the same move_node', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
      checkpoint: null, selectedRoots: [] });
    await store.putMapping(scope, { nativeId: 'native-a', colpId: 'node-a', rootNativeId: 'root-selected',
      parentNativeId: 'root-selected', parentColpId: 'root-colp', projection: { revision: 'r-a', digest: 'sha256:a',
        content: { title: 'A' } } });
    await store.putMapping(scope, { nativeId: 'root-selected', colpId: 'root-colp', rootNativeId: 'root-selected',
      nodeKind: 'folder', projection: { revision: 'r-root', childrenRevision: 'children-root-old', digest: 'sha256:root' } });
    await store.putMapping(scope, { nativeId: 'folder-dest', colpId: 'folder-dest', rootNativeId: 'root-selected',
      nodeKind: 'folder', projection: { revision: 'r-dest', childrenRevision: 'children-dest-old', digest: 'sha256:dest' } });
    const move: JsonObject = { opId: 'op-a', replicaId: scope.replicaId, sequence: 1, collectionId: scope.collectionId,
      type: 'move_node', targetId: 'node-a', baseRevision: 'r-a', occurredAt: '2026-07-27T00:00:00.000Z',
      dependencies: [], payload: { newParentId: 'folder-dest', baseSourceParentRevision: 'children-root-old',
        baseTargetParentRevision: 'children-dest-old' } };
    await store.allocateSequenceAndEnqueue(scope, { opId: 'op-a', batchId: 'batch-a', idempotencyKey: 'op-a',
      digest: 'sha256:op-a', endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: 'r-a',
      operationRevision: 'local-a', status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload: move }, { allowUnstamped: true });
    const clock = { now: 10_000 };
    const bodies: string[] = [];
    let calls = 0;
    const worker = createOutboundPushWorker({ ...pushOptions(store, clock), refreshPlacement: async () => {
      await store.putMapping(scope, { nativeId: 'root-selected', colpId: 'root-colp', rootNativeId: 'root-selected',
        nodeKind: 'folder', projection: { revision: 'r-root-2', childrenRevision: 'children-root-new',
          digest: 'sha256:root-2' } });
      await store.putMapping(scope, { nativeId: 'folder-dest', colpId: 'folder-dest', rootNativeId: 'root-selected',
        nodeKind: 'folder', projection: { revision: 'r-dest-2', childrenRevision: 'children-dest-new',
          digest: 'sha256:dest-2' } });
    }, fetch: async (_url, init) => {
      bodies.push(String(init?.body)); calls += 1;
      if (calls === 1) return new Response(JSON.stringify({
        type: 'https://know-n.com/colp/problems/position-context-stale', title: 'position_context_stale',
        status: 409, code: 'position_context_stale', retryable: true,
      }), { status: 409, headers: { 'Content-Type': 'application/problem+json' } });
      return json(200, { batchId: JSON.parse(String(init?.body)).batchId, results: [{ opId: 'op-a', sequence: 1,
        status: 'applied', revision: 'r-a-2', cursor: 'cursor-1', warnings: [] }], serverCursor: 'cursor-1' });
    } });
    assert.equal((await worker.drain()).outcome, 'unknown');
    assert.equal((await store.listQueue(scope))[0]?.recovery?.code, 'position_context_stale');
    clock.now = (await store.listQueue(scope))[0]!.retry.notBefore;
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.equal(bodies.length, 2);
    assert.notEqual(bodies[0], bodies[1]);
    assert.equal((await store.listQueue(scope))[0]?.status, 'terminal');
  });

  test('offline empty live queue still Pulls on an explicit manual wake', async () => {
    const fixture = await setupDurableEngine();
    fixture.pullResponses.push(networkFailure('offline'), json(200, emptyPullPage('cursor-restore')));
    fixture.ackResponses.push(json(200, ack('cursor-restore')));
    await fixture.engine.wake('alarm');
    assert.equal((await fixture.store.getEngineState(engineScope))!.phase, 'offline');
    assert.equal((await fixture.store.listQueue(engineScope)).length, 0);
    await fixture.engine.wake('manual');
    assert.ok(fixture.pullRequests.length >= 2);
    assert.equal((await fixture.store.getEngineState(engineScope))!.phase, 'sleeping');
  });

});
