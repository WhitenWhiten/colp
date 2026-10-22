import assert from 'node:assert/strict';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, test } from 'vitest';
import { DATABASE_NAME, createSyncStateStore, type QueueOperation, type SyncScope } from '../src/sync-state-store.js';

const scope: SyncScope = {
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
  replicaId: 'replica-a', generation: 1,
};

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

test.each([false, true])('Snapshot preserves move intent and refreshes only safe authority (bound attempt: %s)', async (bound) => {
  const store = createSyncStateStore({ indexedDB });
  try {
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 100 },
      checkpoint: null, selectedRoots: [] });
    const prior = { nativeId: 'native-bookmark', colpId: 'bookmark', rootNativeId: 'native-root', nodeKind: 'bookmark' as const,
      parentNativeId: 'native-dest', parentColpId: 'dest',
      projection: { revision: 'old-node', digest: 'sha256:local', content: { title: 'Local intent' } } };
    await store.putMapping(scope, prior);
    let queued = await store.allocateSequenceAndEnqueue(scope, { ...createOp(), opId: 'move',
      payload: { type: 'move_node', targetId: 'bookmark', baseRevision: 'old-node', payload: { newParentId: 'dest' } } },
    { allowUnstamped: true });
    if (bound) {
      const lease = await store.acquireLease(scope, 'owner', 1, 60_000);
      const claimed = (await store.claimNextQueue(scope, 'owner', lease.fence, 1))!;
      await store.bindPushAttempt(scope, claimed.sequence, 'owner', lease.fence, { sessionId: 'session',
        batchId: claimed.batchId, idempotencyKey: claimed.idempotencyKey, endpointIdentity: 'syncPush',
        mediaType: 'application/json', body: JSON.stringify({ sessionId: 'session', batchId: claimed.batchId,
          operations: [claimed.payload] }), bodyDigest: claimed.digest });
      await store.settleClaimedPush(scope, claimed.sequence, 'owner', lease.fence, { outcome: 'unknown',
        retry: { attempt: 220, notBefore: 0 }, recovery: { code: 'push_network_failed' } });
      queued = (await store.listQueue(scope))[0]!;
    }
    await store.stageRecoveryPage(scope, { snapshotId: 'move-snapshot', revision: 'r2', syncCursor: 'spc2.move',
      identityDigest: 'identity-move', rootNodeId: 'source', page: 0, pageDigest: 'sha256:move-page',
      previousPageDigest: null, nextCursor: null, complete: true, nodes: [
        { colpId: 'source', parentId: null, position: 'a', kind: 'Folder', payloadDigest: 'sha256:source',
          mapping: { nativeId: 'native-source', colpId: 'source', rootNativeId: 'native-root', nodeKind: 'folder',
            projection: { revision: 'source-r2', childrenRevision: 'children-r2', digest: 'sha256:source' } } },
        { colpId: 'bookmark', parentId: 'source', position: 'b', kind: 'Bookmark', payloadDigest: 'sha256:bookmark',
          mapping: { ...prior, parentColpId: 'source', parentNativeId: 'native-source',
            projection: { revision: 'fresh-node', digest: 'sha256:remote', content: { title: 'Remote' } } } },
      ] });
    await store.commitRecovery(scope, 'move-snapshot');
    const mapping = await store.getMappingByColpId(scope, 'bookmark');
    assert.equal(mapping?.projection.revision, bound ? 'old-node' : 'fresh-node');
    assert.equal(mapping?.projection.resourceRevision, bound ? 'old-node' : 'fresh-node');
    assert.equal(mapping?.parentColpId, bound ? 'dest' : 'source');
    assert.equal(mapping?.parentNativeId, 'native-dest');
    assert.deepEqual(mapping?.projection.content, prior.projection.content);
    assert.deepEqual((await store.listQueue(scope))[0], queued);
  } finally { store.close(); }
});

test('commitRecovery keeps a pending create mapping that Snapshot does not contain', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 100 },
    checkpoint: null, selectedRoots: [],
  });
  await store.putMapping(scope, {
    nativeId: 'native-root', colpId: 'old-root', rootNativeId: 'native-root', nodeKind: 'folder',
    projection: { revision: 'r1', digest: 'sha256:old-root' },
  });
  await store.configureBrowserRoots(scope, {
    discovered: [
      { nativeId: 'native-root', ancestorNativeIds: [] },
      { nativeId: 'native-private', ancestorNativeIds: [] },
    ],
    selectedNativeIds: ['native-root'], privateNativeIds: ['native-private'], status: 'ready',
  });
  await store.putMapping(scope, {
    nativeId: 'native-pending', colpId: 'pending-op-create', rootNativeId: 'native-root', nodeKind: 'bookmark',
    parentNativeId: 'native-root', parentColpId: 'old-root',
    projection: { revision: 'local-op-create', digest: 'sha256:pending', content: { title: 'Draft' } },
  });
  const queued = await store.allocateSequenceAndEnqueue(scope, createOp(), { allowUnstamped: true });
  await store.stageRecoveryPage(scope, {
    snapshotId: 's-create', revision: 'r2', syncCursor: 'spc2.s-create', identityDigest: 'identity-s',
    rootNodeId: 'node-r', page: 0, pageDigest: 'sha256:p0', previousPageDigest: null, nextCursor: null, complete: true,
    nodes: [{
      colpId: 'node-r', parentId: null, position: 'a', kind: 'Folder', payloadDigest: 'sha256:n',
      mapping: {
        nativeId: 'native-root', colpId: 'node-r', rootNativeId: 'native-root', nodeKind: 'folder',
        projection: { revision: 'r2', digest: 'sha256:new-root' },
      },
    }],
  });
  await store.commitRecovery(scope, 's-create');
  assert.equal((await store.getMappingByColpId(scope, 'pending-op-create'))?.nativeId, 'native-pending');
  assert.equal((await store.listQueue(scope)).some((item) => item.opId === queued.opId && item.status === 'pending'), true);
  assert.ok((await store.getScope(scope))?.privateRoots?.length);
});

test('commitRecovery discards pre-recovery pages, events and apply intents in the same transaction', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 100 },
    checkpoint: { serverRevision: 'r1', cursor: 'cursor-0' }, selectedRoots: [] });
  await store.putMapping(scope, {
    nativeId: 'native-root', colpId: 'old-root', rootNativeId: 'native-root', nodeKind: 'folder',
    projection: { revision: 'r1', digest: 'sha256:old-root' },
  });
  await store.stageRecoveryPage(scope, {
    snapshotId: 'snapshot-dirty', revision: 'r2', syncCursor: 'spc2.dirty', identityDigest: 'identity-dirty',
    rootNodeId: 'node-r', page: 0, pageDigest: 'sha256:p0', previousPageDigest: null, nextCursor: null,
    complete: true,
    nodes: [{ colpId: 'node-r', parentId: null, position: 'a', kind: 'Folder', payloadDigest: 'sha256:n',
      mapping: { nativeId: 'native-root', colpId: 'node-r', rootNativeId: 'native-root', nodeKind: 'folder',
        projection: { revision: 'r2', digest: 'sha256:new-root' } } }],
  });
  // An interrupted pre-recovery Pull: one page whose intent was prepared but never applied, and a
  // second page that blocked on a competing mapping owner (the F005 block path).
  const stagedEvent = { eventId: 'event-staged', cursor: 'cursor-staged', operationId: 'op-staged',
    effectId: 'fx-staged', effectDigest: 'sha256:fx-staged', operationDigest: 'sha256:op-staged',
    kind: 'node_created', payload: { cursor: 'cursor-staged', kind: 'operation' } };
  await store.stagePullPage(scope, { pageId: 'page-staged', previousCursor: 'cursor-0',
    nextCursor: 'cursor-staged', collectionRevision: 'revision-dirty', pageDigest: 'sha256:staged',
    events: [stagedEvent] });
  await store.preparePullIntent(scope, 'event-staged', { intentId: 'intent:event-staged',
    correlationId: 'correlation-shared', operationId: 'op-staged', eventId: 'event-staged', effectId: 'fx-staged',
    expected: { kind: 'create', nativeId: 'pending:fx-staged' }, expiresAt: Date.now() + 300_000,
    state: 'intent_prepared', generation: 1 });
  await store.putMapping(scope, {
    nativeId: 'native-blocker', colpId: 'node-created-77', rootNativeId: 'native-root', nodeKind: 'bookmark',
    projection: { revision: 'r1', digest: 'sha256:blocker' },
  });
  await store.stagePullPage(scope, { pageId: 'page-blocked', previousCursor: 'cursor-0',
    nextCursor: 'cursor-blocked', collectionRevision: 'revision-dirty', pageDigest: 'sha256:blocked',
    events: [{ ...stagedEvent, eventId: 'event-blocked', cursor: 'cursor-blocked', operationId: 'op-blocked' }] });
  await store.preparePullIntent(scope, 'event-blocked', { intentId: 'intent:event-blocked',
    correlationId: 'correlation-blocked', operationId: 'op-blocked', eventId: 'event-blocked', effectId: 'fx-blocked',
    expected: { kind: 'create', nativeId: 'pending:fx-blocked' }, expiresAt: Date.now() + 300_000,
    state: 'intent_prepared', generation: 1 });
  await store.commitPullEvent(scope, 'event-blocked', { mappings: [{ nativeId: 'native-race',
    colpId: 'node-created-77', rootNativeId: 'native-root', nodeKind: 'bookmark',
    projection: { revision: 'revision-dirty', digest: 'sha256:race' } }] });
  await assert.rejects(() => store.completePullPage(scope, 'page-blocked'), /recovery_required/u);
  const before = await store.exportScope(scope);
  assert.equal(before.pullPages.filter((page) => page.state === 'blocked').length, 1);
  assert.equal(before.pullEvents.length, 2);
  assert.equal(before.intents.length, 2);
  assert.equal(before.scope?.checkpoint?.cursor, 'cursor-0');
  assert.equal('cursor' in (before.cursor ?? {}), false, 'the durable cursor has not moved yet');

  const ackBody = JSON.stringify({ sessionId: 'session-1', cursor: 'spc2.dirty', warnings: [] });
  await store.commitRecovery(scope, 'snapshot-dirty', { intentId: 'bootstrap-dirty', sessionId: 'session-1',
    idempotencyKey: 'bootstrap-dirty', endpointIdentity: 'syncAck', mediaType: 'application/json',
    body: ackBody, bodyDigest: bytesToHex(sha256(new TextEncoder().encode(ackBody))) });

  const after = await store.exportScope(scope);
  assert.equal(after.scope?.lifecycle, 'active');
  assert.equal(after.cursor?.cursor, 'spc2.dirty');
  assert.equal(after.pullPages.length, 0);
  assert.equal(after.pullEvents.length, 0);
  assert.equal(after.effectPages.length, 0);
  assert.equal(after.intents.length, 0);
  assert.equal(after.recovery, null);
  assert.equal(after.recoveryNodes.length, 0);
  assert.deepEqual(after.ackIntents.map((intent) => [intent.kind, intent.state, intent.cursor]),
    [['bootstrap', 'pending', 'spc2.dirty']]);
  const diagnostic = (await store.exportDiagnostics()).records
    .find((row) => (row as { kind?: string }).kind === 'recovery_pre_apply_state_discarded') as
    { readonly pageCount?: number; readonly blockedPageCount?: number; readonly eventCount?: number;
      readonly intentCount?: number } | undefined;
  assert.deepEqual({ pages: diagnostic?.pageCount, blocked: diagnostic?.blockedPageCount,
    events: diagnostic?.eventCount, intents: diagnostic?.intentCount },
  { pages: 2, blocked: 1, events: 2, intents: 2 });

  // F007 second face: a re-delivered event may prepare again instead of tripping
  // `intent_correlation_active` on the pre-recovery intent.
  await store.stagePullPage(scope, { pageId: 'page-after', previousCursor: 'spc2.dirty',
    nextCursor: 'cursor-after', collectionRevision: 'revision-after', pageDigest: 'sha256:after',
    events: [{ ...stagedEvent, cursor: 'cursor-after' }] });
  await store.preparePullIntent(scope, 'event-staged', { intentId: 'intent:event-staged',
    correlationId: 'correlation-shared', operationId: 'op-staged', eventId: 'event-staged', effectId: 'fx-staged',
    expected: { kind: 'create', nativeId: 'pending:fx-staged' }, expiresAt: Date.now() + 300_000,
    state: 'intent_prepared', generation: 1 });
  assert.equal((await store.exportScope(scope)).intents.length, 1);
});

test('upgrades a v7 fixture without dropping queue, mapping, recovery or private roots', async () => {
  const key = JSON.stringify([
    scope.environment, scope.serverId, scope.serverOrigin, scope.accountId,
    scope.browserProfileId, scope.collectionId, scope.replicaId, scope.generation,
  ]);
  await seedV7(key);
  const store = createSyncStateStore({ indexedDB });
  const opened = await store.getScope(scope);
  assert.equal(opened?.privateRoots?.[0], 'private-root');
  assert.equal((await store.getMappingByColpId(scope, 'pending-op-legacy'))?.nativeId, 'native-pending');
  assert.equal((await store.listQueue(scope))[0]?.payload.type, 'create_node');
  assert.equal((await store.exportScope(scope)).recovery?.snapshotId, 'legacy-v7');
  const db = await store.open();
  assert.ok(db.objectStoreNames.contains('compaction_watermarks'));
  assert.ok(db.objectStoreNames.contains('compact_summaries'));
  assert.ok(db.transaction('bookmark_events').objectStore('bookmark_events')
    .indexNames.contains('by_scope_event_status_ordinal'));
});

function createOp(): Omit<QueueOperation, 'sequence' | 'scopeKey'> {
  return {
    opId: 'op-create', batchId: 'batch-create', idempotencyKey: 'idem-create', digest: 'sha256:op-create',
    endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null,
    operationRevision: 'local-op-create', status: 'pending', retry: { attempt: 0, notBefore: 0 },
    payload: { type: 'create_node', payload: { parentId: 'old-root', node: { title: 'Draft' } } },
  };
}

function seedV7(key: string): Promise<void> {
  const request = indexedDB.open(DATABASE_NAME, 7);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore('sync_scopes', { keyPath: 'scopeKey' });
    const mappings = db.createObjectStore('native_mappings', { keyPath: ['scopeKey', 'nativeId'] });
    mappings.createIndex('by_scope_native_id', ['scopeKey', 'nativeId'], { unique: true });
    mappings.createIndex('by_scope_colp_id', ['scopeKey', 'colpId'], { unique: true });
    const queue = db.createObjectStore('outbound_queue', { keyPath: ['scopeKey', 'sequence'] });
    queue.createIndex('by_scope_sequence', ['scopeKey', 'sequence'], { unique: true });
    queue.createIndex('by_scope_op_id', ['scopeKey', 'opId'], { unique: true });
    queue.createIndex('by_scope_status_sequence', ['scopeKey', 'status', 'sequence'], { unique: true });
    db.createObjectStore('durable_sequences', { keyPath: 'scopeKey' });
    db.createObjectStore('recovery_staging', { keyPath: ['scopeKey', 'snapshotId'] });
    const nodes = db.createObjectStore('recovery_nodes', { keyPath: ['scopeKey', 'snapshotId', 'colpId'] });
    nodes.createIndex('by_scope_snapshot_page', ['scopeKey', 'snapshotId', 'page', 'colpId'], { unique: true });
    db.createObjectStore('schema_metadata', { keyPath: 'key' });
    db.createObjectStore('cursors', { keyPath: 'scopeKey' });
  };
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction([
        'sync_scopes', 'native_mappings', 'outbound_queue', 'durable_sequences',
        'recovery_staging', 'recovery_nodes', 'schema_metadata',
      ], 'readwrite');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
      tx.objectStore('sync_scopes').put({
        ...scope, scopeKey: key, lifecycle: 'active',
        lease: { leaseId: 'lease-v7', expiresAt: 100 }, checkpoint: null,
        selectedRoots: ['old-root'], privateRoots: ['private-root'], rootStatus: 'ready',
      });
      tx.objectStore('native_mappings').put({
        scopeKey: key, nativeId: 'native-root', colpId: 'old-root', rootNativeId: 'native-root',
        nodeKind: 'folder', projection: { revision: 'r1', digest: 'sha256:old-root' },
      });
      tx.objectStore('native_mappings').put({
        scopeKey: key, nativeId: 'native-pending', colpId: 'pending-op-legacy', rootNativeId: 'native-root',
        nodeKind: 'bookmark', projection: { revision: 'local-op-legacy', digest: 'sha256:pending' },
      });
      tx.objectStore('native_mappings').put({
        scopeKey: key, nativeId: 'native-private', colpId: 'private-root', rootNativeId: 'native-private',
        nodeKind: 'folder', projection: { revision: 'local-root', digest: 'sha256:private' },
      });
      tx.objectStore('outbound_queue').put({
        scopeKey: key, sequence: 1, opId: 'op-legacy', batchId: 'batch-legacy', idempotencyKey: 'idem-legacy',
        digest: 'sha256:op-legacy', endpointIdentity: 'syncPush', mediaType: 'application/json',
        baseRevision: null, operationRevision: 'local-op-legacy', status: 'pending',
        retry: { attempt: 0, notBefore: 0 },
        payload: { type: 'create_node', payload: { parentId: 'old-root' } },
      });
      tx.objectStore('durable_sequences').put({ scopeKey: key, next: 2 });
      tx.objectStore('recovery_staging').put({
        scopeKey: key, snapshotId: 'legacy-v7', sessionId: null, revision: 'r2', syncCursor: 'spc2.v7',
        identityDigest: 'identity-v7', rootNodeId: 'old-root', lastPage: 0, lastPageDigest: 'sha256:p0',
        nextCursor: null, complete: false,
      });
      tx.objectStore('schema_metadata').put({ key: 'schema', version: 7, authorityDigest: 'p3-35-bookmark-import-v1' });
    };
  });
}
