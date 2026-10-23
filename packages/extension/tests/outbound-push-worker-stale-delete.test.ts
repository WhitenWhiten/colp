import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { SUBTREE_OBSERVATION_EXTENSION, canonicalOperationDigest, subtreeDeleteSource } from '@know-n/colp/sync';
import { createOutboundPushWorker, type PushSessionController } from '../src/outbound-push-worker.js';
import { createQueueRecapture } from '../src/queue-recapture.js';
import { DELETE_SUBTREE_CHANGED, TARGET_ALREADY_DELETED } from '../src/push-delete-rebase.js';
import { isOpenQueueIssue } from '../src/sync-state/open-issue-facts.js';
import { subtreeMemberIdsDigest } from '@know-n/colp/sync/canonical';
import { createSyncStateStore, type JsonObject } from '../src/sync-state-store.js';
import { honestChrome } from './kns-05-pull-harness.js';
import { endpoints, indexedDB, installOutboundPushIndexedDb, json, problem, scope } from './outbound-push-worker-harness.js';

installOutboundPushIndexedDb();

const OBSERVED = [{ id: 'folder-1', revision: 'folder-r1' }, { id: 'child-1', revision: 'child-r1' }];
const observedSource = subtreeDeleteSource('folder-1', OBSERVED);
const observedIds = subtreeMemberIdsDigest('folder-1', ['folder-1', 'child-1']);

/**
 * One delete this browser captured and dropped its mappings for, as ingress
 * does, with the removal event that recorded the member-ID digest.
 */
async function setupDelete(type: 'delete_node' | 'delete_subtree', options: { readonly memberIdsDigest?: string } = {}) {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', rootStatus: 'ready', selectedRoots: [],
    lease: { leaseId: 'lease-server', expiresAt: Date.parse('2099-01-01T00:00:00Z') }, checkpoint: null });
  const database = await store.open(); const scopeKey = (await store.getScope(scope))!.scopeKey;
  const transaction = database.transaction('bookmark_events', 'readwrite');
  transaction.objectStore('bookmark_events').add({ scopeKey, eventId: 'event-delete-1', ordinal: 1,
    dedupeKey: 'dedupe-delete-1', occurredAt: '2026-07-27T00:00:00Z', kind: 'remove', nativeId: 'native-folder',
    details: { operation: { type }, deleteNativeIds: ['native-folder', 'native-child'],
      ...(options.memberIdsDigest ? { subtreeMemberIdsDigest: options.memberIdsDigest } : {}) },
    status: 'processed', opId: 'op-delete-1' });
  await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); });
  const operation: JsonObject = { opId: 'op-delete-1', replicaId: scope.replicaId, sequence: 1,
    collectionId: scope.collectionId, type, targetId: 'folder-1', baseRevision: 'folder-r1',
    occurredAt: '2026-07-27T00:00:00.000Z', dependencies: [],
    ...(type === 'delete_subtree' ? { source: observedSource } : {}), payload: { reason: 'browser_event' } };
  const queued = await store.allocateSequenceAndEnqueue(scope, { opId: 'op-delete-1', batchId: 'batch-delete-1',
    idempotencyKey: 'idempotency-delete-1', digest: 'sha256:operation-delete-1', endpointIdentity: 'syncPush',
    mediaType: 'application/json', baseRevision: 'folder-r1', operationRevision: 'folder-r1',
    status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload: operation }, { allowUnstamped: true });
  const clock = { now: 10_000 }; const sessions: PushSessionController = { async get() { return {
    credential: { accessToken: 'access-token-push' }, session: { sessionId: 'session-push',
      expiresAt: '2099-01-01T00:00:00Z', scope: 'collection', snapshotRequired: false,
      credentialAuthorityDigest: 'a'.repeat(64),
      collection: { collectionId: scope.collectionId, serverCursor: 'cursor-0', serverRevision: 'revision-0' },
      replicaLease: { leaseId: 'lease-server', generation: '1', state: 'active', expiresAt: '2099-01-01T00:00:00Z' } } }; } };
  return { store, queued, clock, options: { scope, store, endpoints: async () => endpoints, sessions,
    now: () => clock.now, random: () => 0, ownerId: () => 'owner-push', schedule: () => undefined } };
}

function applied(init: RequestInit | undefined) {
  const body = JSON.parse(String(init?.body)) as { batchId: string; operations: Array<{ opId: string; sequence: number }> };
  const sent = body.operations[0]!;
  return json(200, { batchId: body.batchId, results: [{ opId: sent.opId, sequence: sent.sequence, status: 'applied',
    targetId: 'folder-1', revision: 'folder-r9', cursor: 'cursor-1', warnings: [] }], serverCursor: 'cursor-1' });
}

function sentOperation(body: string) {
  return (JSON.parse(body) as { operations: Array<JsonObject> }).operations[0]!;
}

const current = { version: 1 as const, count: 2, digest: `sha-256=:${'B'.repeat(43)}=:`, memberIdsDigest: observedIds };

describe('a delete another device raced', () => {
  test('delete_node stale against an edit elsewhere is sent again on the revision the server names', async () => {
    const f = await setupDelete('delete_node');
    const bodies: string[] = [];
    const worker = createOutboundPushWorker({ ...f.options, fetch: async (_url, init) => {
      bodies.push(String(init?.body));
      return bodies.length === 1 ? problem(409, 'revision_conflict', { retryable: false, currentRevision: 'folder-r2' }) : applied(init);
    } });
    assert.equal((await worker.drain()).outcome, 'unknown');
    const held = (await f.store.listQueue(scope))[0]!;
    assert.equal(held.status, 'unknown'); assert.equal(held.recovery?.code, 'revision_conflict');
    assert.equal(held.attempt, undefined); assert.equal(held.baseRevision, 'folder-r2');
    assert.equal(held.payload.baseRevision, 'folder-r2');
    f.clock.now = Math.max(f.clock.now, held.retry.notBefore);
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.equal(bodies.length, 2);
    assert.equal(sentOperation(bodies[1]!).baseRevision, 'folder-r2');
    assert.equal(sentOperation(bodies[1]!).opId, 'op-delete-1');
    assert.equal(sentOperation(bodies[1]!).sequence, 1);
    assert.equal((await f.store.listQueue(scope))[0]?.status, 'terminal');
  });

  test('delete_node refused without a current revision stays a rejection, as before', async () => {
    const f = await setupDelete('delete_node');
    const worker = createOutboundPushWorker({ ...f.options,
      fetch: async () => problem(409, 'revision_conflict', { retryable: false }) });
    assert.equal((await worker.drain()).outcome, 'rejected');
    assert.equal((await f.store.listQueue(scope))[0]?.status, 'rejected');
  });

  test('delete_subtree whose members only changed revision is sent again with the current observation', async () => {
    const f = await setupDelete('delete_subtree', { memberIdsDigest: observedIds });
    const bodies: string[] = [];
    const worker = createOutboundPushWorker({ ...f.options, fetch: async (_url, init) => {
      bodies.push(String(init?.body));
      return bodies.length === 1
        ? problem(409, 'revision_conflict', { retryable: false, currentRevision: 'folder-r3', currentSubtree: current })
        : applied(init);
    } });
    assert.equal((await worker.drain()).outcome, 'unknown');
    const row = (await f.store.listQueue(scope))[0]!;
    assert.equal(row.status, 'unknown'); assert.equal(row.attempt, undefined);
    f.clock.now = Math.max(f.clock.now, row.retry.notBefore);
    assert.equal((await worker.drain()).outcome, 'terminal');
    const resent = sentOperation(bodies[1]!);
    assert.equal(resent.baseRevision, 'folder-r3');
    assert.deepEqual((resent.source as JsonObject).extensions, {
      [SUBTREE_OBSERVATION_EXTENSION]: { version: 1, count: 2, digest: current.digest } });
    assert.equal((await f.store.listQueue(scope))[0]?.status, 'terminal');
  });

  test('delete_subtree whose folder gained members is held as one item and the lane goes on', async () => {
    const f = await setupDelete('delete_subtree', { memberIdsDigest: observedIds });
    const later: JsonObject = { opId: 'op-later', replicaId: scope.replicaId, sequence: 2, collectionId: scope.collectionId,
      type: 'delete_node', targetId: 'other-1', baseRevision: 'other-r1', occurredAt: '2026-07-27T00:00:01.000Z',
      dependencies: [], payload: { reason: 'browser_event' } };
    await f.store.allocateSequenceAndEnqueue(scope, { opId: 'op-later', batchId: 'batch-later', idempotencyKey: 'key-later',
      digest: 'sha256:later', endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: 'other-r1',
      operationRevision: 'other-r1', status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload: later },
    { allowUnstamped: true });
    const grown = { ...current, count: 3, memberIdsDigest: subtreeMemberIdsDigest('folder-1', ['folder-1', 'child-1', 'new-1']) };
    const sent: string[] = [];
    const worker = createOutboundPushWorker({ ...f.options, fetch: async (_url, init) => {
      const operation = sentOperation(String(init?.body)); sent.push(String(operation.opId));
      return operation.opId === 'op-delete-1'
        ? problem(409, 'revision_conflict', { retryable: false, currentRevision: 'folder-r3', currentSubtree: grown })
        : applied(init);
    } });
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.deepEqual(sent, ['op-delete-1', 'op-later']);
    const rows = await f.store.listQueue(scope);
    assert.equal(rows[0]?.status, 'set_aside'); assert.equal(rows[0]?.recovery?.code, DELETE_SUBTREE_CHANGED);
    assert.equal(rows[0]?.attempt, undefined);
    // The held row already carries what "delete anyway" needs.
    assert.equal(rows[0]?.payload.baseRevision, 'folder-r3');
    assert.deepEqual((rows[0]?.payload.source as JsonObject).extensions, {
      [SUBTREE_OBSERVATION_EXTENSION]: { version: 1, count: 3, digest: grown.digest } });
    assert.equal(rows[1]?.status, 'terminal');
    assert.equal(await f.store.firstLaneQueue(scope), null);
  });

  test('delete_subtree refused by a server that reports no members is held rather than rejected', async () => {
    const f = await setupDelete('delete_subtree', { memberIdsDigest: observedIds });
    const worker = createOutboundPushWorker({ ...f.options,
      fetch: async () => problem(409, 'revision_conflict', { retryable: false, currentRevision: 'folder-r3' }) });
    assert.equal((await worker.drain()).outcome, 'terminal');
    const row = (await f.store.listQueue(scope))[0]!;
    assert.equal(row.status, 'set_aside'); assert.equal(row.recovery?.code, DELETE_SUBTREE_CHANGED);
  });

  test('a recaptured delete has no observed members, so a second change holds it again', async () => {
    const f = await setupDelete('delete_subtree');
    const worker = createOutboundPushWorker({ ...f.options,
      fetch: async () => problem(409, 'revision_conflict', { retryable: false, currentRevision: 'folder-r3', currentSubtree: current }) });
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.equal((await f.store.listQueue(scope))[0]?.recovery?.code, DELETE_SUBTREE_CHANGED);
  });

  test('Retry on the held folder re-authors the deletion with the current members at the tail', async () => {
    const f = await setupDelete('delete_subtree', { memberIdsDigest: observedIds });
    const grown = { ...current, count: 3, memberIdsDigest: subtreeMemberIdsDigest('folder-1', ['folder-1', 'child-1', 'new-1']) };
    const bodies: string[] = [];
    const worker = createOutboundPushWorker({ ...f.options, fetch: async (_url, init) => {
      bodies.push(String(init?.body));
      return bodies.length === 1
        ? problem(409, 'revision_conflict', { retryable: false, currentRevision: 'folder-r3', currentSubtree: grown })
        : applied(init);
    } });
    assert.equal((await worker.drain()).outcome, 'terminal');
    const recapture = createQueueRecapture({ store: f.store, scope, api: honestChrome(), permission: async () => true, now: () => 20_000 });
    const released = await f.store.releaseSetAsideQueue(scope, [f.queued.sequence], recapture);
    assert.equal(released.length, 1);
    const fresh = released[0]!;
    assert.notEqual(fresh.opId, 'op-delete-1'); assert.ok(fresh.sequence > f.queued.sequence);
    assert.equal(fresh.payload.type, 'delete_subtree'); assert.equal(fresh.payload.targetId, 'folder-1');
    assert.equal(fresh.payload.baseRevision, 'folder-r3');
    assert.equal(fresh.digest, canonicalOperationDigest(fresh.payload as never));
    assert.deepEqual((fresh.payload.source as JsonObject).extensions, {
      [SUBTREE_OBSERVATION_EXTENSION]: { version: 1, count: 3, digest: grown.digest } });
    assert.equal((await f.store.getQueueByOpId(scope, 'op-delete-1'))?.recovery?.code, 'recaptured');
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.equal(sentOperation(bodies[1]!).opId, fresh.opId);
    assert.equal((await f.store.getQueueByOpId(scope, fresh.opId))?.status, 'terminal');
  });

  test('a malformed currentSubtree is an unrecognized response, never a silent rebase', async () => {
    const f = await setupDelete('delete_subtree', { memberIdsDigest: observedIds });
    const worker = createOutboundPushWorker({ ...f.options, fetch: async () => problem(409, 'revision_conflict',
      { retryable: false, currentRevision: 'folder-r3', currentSubtree: { version: 2, count: 'two' } }) });
    assert.equal((await worker.drain()).outcome, 'unknown');
    const row = (await f.store.listQueue(scope))[0]!;
    assert.equal(row.status, 'unknown'); assert.equal(row.recovery?.code, 'push_response_unrecognized');
    assert.equal(row.payload.baseRevision, 'folder-r1');
  });
});

describe('both devices deleted the same node', () => {
  test('the second delete settles as history, not an open item, and the lane realigns over it', async () => {
    const f = await setupDelete('delete_node');
    const later: JsonObject = { opId: 'op-later', replicaId: scope.replicaId, sequence: 2, collectionId: scope.collectionId,
      type: 'delete_node', targetId: 'other-1', baseRevision: 'other-r1', occurredAt: '2026-07-27T00:00:01.000Z',
      dependencies: [], payload: { reason: 'browser_event' } };
    await f.store.allocateSequenceAndEnqueue(scope, { opId: 'op-later', batchId: 'batch-later', idempotencyKey: 'key-later',
      digest: 'sha256:later', endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: 'other-r1',
      operationRevision: 'other-r1', status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload: later },
    { allowUnstamped: true });
    const sent: Array<[string, number]> = []; let expected = 1;
    const worker = createOutboundPushWorker({ ...f.options, fetch: async (_url, init) => {
      const operation = sentOperation(String(init?.body)); sent.push([String(operation.opId), Number(operation.sequence)]);
      if (operation.opId === 'op-delete-1') return problem(404, 'resource_not_found', { retryable: false });
      if (operation.sequence !== expected) return problem(409, 'sequence_gap', { expectedSequence: expected });
      expected += 1; return applied(init);
    } });
    await worker.drain();
    const first = (await f.store.getQueueByOpId(scope, 'op-delete-1'))!;
    assert.equal(first.status, 'rejected'); assert.equal(first.recovery?.code, TARGET_ALREADY_DELETED);
    assert.equal(isOpenQueueIssue(first), false);
    // The refused sequence is a hole the next drain realigns the later change over.
    await worker.drain();
    assert.deepEqual(sent, [['op-delete-1', 1], ['op-later', 2], ['op-later', 1]]);
    assert.equal((await f.store.getQueueByOpId(scope, 'op-later'))?.status, 'terminal');
    assert.equal(await f.store.firstLaneQueue(scope), null);
  });
});
