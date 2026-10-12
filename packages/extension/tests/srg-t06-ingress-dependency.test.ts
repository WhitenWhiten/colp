import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { createOutboundPushWorker, type PushSessionController } from '../src/outbound-push-worker.js';
import { bookmark, fixture, mapping, scope } from './bookmark-event-queue-harness.js';
import { endpoints } from './outbound-push-worker-harness.js';

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

type Fixture = Awaited<ReturnType<typeof fixture>>;

const clock = { now: 10_000 };
const sessions: PushSessionController = { async get() { return { credential: { accessToken: 'access-token-ingress' },
  session: { sessionId: 'session-ingress', expiresAt: '2099-01-01T00:00:00Z', scope: 'collection',
    snapshotRequired: false, credentialAuthorityDigest: 'a'.repeat(64),
    collection: { collectionId: scope.collectionId, serverCursor: 'cursor-0', serverRevision: 'revision-0' },
    replicaLease: { leaseId: 'lease-ingress', generation: '1', state: 'active',
      expiresAt: '2099-01-01T00:00:00Z' } } }; } };

/**
 * F010: an unsettled attempt (a lost push response keeps the attempt so the
 * exact bytes can be replayed) must only hold work that really depends on it.
 * Unrelated targets keep ingressing, dependent edits stay durably in the inbox
 * with visible evidence, and they continue by themselves once the attempt
 * settles — always behind the operation they depend on.
 */
describe('F010 unsettled attempts only hold dependent ingress', () => {
  test('unrelated targets keep enqueueing, dependent edits wait visibly and then continue in order', async () => {
    const { queue, store, api } = await fixture(indexedDB, { mappedNode: true, autoFlush: false });
    await mapping(store, 'other-node', 'other-colp', 'root-selected', 'other-r1', { title: 'Other' });
    await mapping(store, 'third-node', 'third-colp', 'root-selected', 'third-r1', { title: 'Third' });
    api.put(bookmark('other-node', 'root-selected', 1, 'Other', 'https://example.test/other'));
    api.put(bookmark('third-node', 'root-selected', 2, 'Third', 'https://example.test/third'));

    // 1. A local edit is committed and its push response is lost: the durable
    //    row keeps the attempt and becomes replayable `unknown`.
    api.put(bookmark('mapped', 'root-selected', 0, 'Server after', 'https://example.test/after'));
    await queue.changed('mapped', { title: 'Server after' });
    await queue.flush();
    assert.equal(await losePushResponse(store), 'unknown');
    const blocked = (await store.listQueue(scope))[0]!;
    assert.equal(blocked.status, 'unknown');
    assert.notEqual(blocked.attempt, undefined);

    // 2. An unrelated target is admitted while that attempt is unsettled.
    api.put(bookmark('other-node', 'root-selected', 1, 'Other edited', 'https://example.test/other'));
    await queue.changed('other-node', { title: 'Other edited' });
    await queue.flush();
    let rows = await store.listQueue(scope);
    assert.deepEqual(rows.map((row) => [row.sequence, row.payload.targetId, row.status]),
      [[1, 'mapped-colp', 'unknown'], [2, 'other-colp', 'pending']]);
    assert.equal((await store.listBookmarkEventsByStatus(scope, 'processed')).length, 2);

    // 3. A later edit of the same canonical target is a real dependency: even
    //    after a pull echo rebinds the projection to a server revision (so the
    //    event prepares cleanly), it stays pending in the inbox, allocates no
    //    sequence, and leaves a durable ingress marker naming the blocking row.
    await store.putMapping(scope, { nativeId: 'mapped', colpId: 'mapped-colp', rootNativeId: 'root-selected',
      projection: { revision: 'server-revision-8', digest: 'sha256:server-revision-8',
        content: { title: 'Server after', url: 'https://example.test/after' } } });
    api.put(bookmark('mapped', 'root-selected', 0, 'Server after 2', 'https://example.test/after'));
    await queue.changed('mapped', { title: 'Server after 2' });
    await queue.flush();
    rows = await store.listQueue(scope);
    assert.deepEqual(rows.map((row) => row.sequence), [1, 2]);
    const held = (await store.listBookmarkEventsByStatus(scope, 'pending'))[0]!;
    assert.equal(held.opId, null);
    const marker = (await store.listIngressDiagnostics(scope)).find((row) => row.park?.eventId === held.eventId);
    assert.equal(marker?.park?.code, 'exact_retry_pending');
    assert.equal(marker?.park?.state, 'open');
    assert.equal(marker?.park?.dependencyOpId, blocked.opId);
    assert.equal(marker?.park?.dependencyNativeId, 'mapped');

    // 4. A further unrelated capture still commits while the dependency is
    //    held: the hold is per dependency, never a scope-wide ingress stop.
    api.put(bookmark('third-node', 'root-selected', 2, 'Third edited', 'https://example.test/third'));
    await queue.changed('third-node', { title: 'Third edited' });
    await queue.flush();
    assert.deepEqual((await store.listQueue(scope)).map((row) => row.sequence), [1, 2, 3]);

    // 5. Settling the exact attempt releases the held event automatically, and
    //    it lands after the operation it depended on.
    assert.equal(await settleFirstPush(store), 'unknown');
    await queue.flush();
    rows = await store.listQueue(scope);
    assert.deepEqual(rows.map((row) => [row.sequence, row.payload.targetId, row.status]),
      [[1, 'mapped-colp', 'terminal'], [2, 'other-colp', 'unknown'], [3, 'third-colp', 'pending'],
        [4, 'mapped-colp', 'pending']]);
    assert.deepEqual((await store.listBookmarkEventsByStatus(scope, 'pending')), []);
  });

  test('an edit inside the unsettled node native subtree waits while a sibling subtree does not', async () => {
    const { queue, store, api } = await fixture(indexedDB, { autoFlush: false });
    await mapping(store, 'folder-pending', 'folder-pending-colp', 'root-selected', 'folder-r1',
      { title: 'Pending folder' }, 'root-selected');
    await mapping(store, 'child-inside', 'child-inside-colp', 'root-selected', 'child-r1',
      { title: 'Child' }, 'folder-pending');
    await mapping(store, 'outside', 'outside-colp', 'root-selected', 'outside-r1',
      { title: 'Outside' }, 'root-selected');
    api.put(bookmark('child-inside', 'folder-pending', 0, 'Child', 'https://example.test/child'));
    api.put(bookmark('outside', 'root-selected', 1, 'Outside', 'https://example.test/outside'));

    api.put(bookmark('folder-pending', 'root-selected', 0, 'Pending folder renamed', 'https://example.test/folder'));
    await queue.changed('folder-pending', { title: 'Pending folder renamed' });
    await queue.flush();
    assert.equal(await losePushResponse(store), 'unknown');

    // Same native subtree: the child edit depends on the unsettled folder.
    await queue.changed('child-inside', { title: 'Child edited' });
    await queue.flush();
    assert.deepEqual((await store.listQueue(scope)).map((row) => row.payload.targetId), ['folder-pending-colp']);
    const held = (await store.listBookmarkEventsByStatus(scope, 'pending'))[0]!;
    assert.equal(held.nativeId, 'child-inside');
    assert.equal((await store.listIngressDiagnostics(scope)).find((row) => row.park?.eventId === held.eventId)
      ?.park?.code, 'exact_retry_pending');

    // Same parent, different subtree: admitted.
    await queue.changed('outside', { title: 'Outside edited' });
    await queue.flush();
    assert.deepEqual((await store.listQueue(scope)).map((row) => [row.sequence, row.payload.targetId, row.status]),
      [[1, 'folder-pending-colp', 'unknown'], [2, 'outside-colp', 'pending']]);
  });

  test('the allocation path admits unrelated operations and still serializes dependents', async () => {
    const { store } = await fixture(indexedDB, { mappedNode: true, autoFlush: false });
    await mapping(store, 'sibling-node', 'sibling-colp', 'root-selected', 'sibling-r1', { title: 'Sibling' });
    await store.allocateSequenceAndEnqueue(scope, { opId: 'op-first', batchId: 'batch-first',
      idempotencyKey: 'key-first', digest: 'sha256:first', endpointIdentity: 'syncPush',
      mediaType: 'application/json', baseRevision: 'mapped-revision', operationRevision: 'local-first',
      status: 'pending', retry: { attempt: 0, notBefore: 0 },
      payload: { opId: 'op-first', replicaId: scope.replicaId, sequence: 1, collectionId: scope.collectionId,
        type: 'update_node_content', targetId: 'mapped-colp', baseRevision: 'mapped-revision',
        occurredAt: '2026-07-27T00:00:00Z', dependencies: [], payload: {} } }, { allowUnstamped: true });
    const lease = await store.acquireLease(scope, 'owner-ingress', clock.now, 60_000);
    const claimed = await store.claimNextQueue(scope, 'owner-ingress', lease.fence, clock.now);
    await store.bindPushAttempt(scope, 1, 'owner-ingress', lease.fence, { sessionId: 'session-ingress',
      batchId: claimed!.batchId, idempotencyKey: claimed!.idempotencyKey, endpointIdentity: 'syncPush',
      mediaType: 'application/json', body: JSON.stringify({ sessionId: 'session-ingress', batchId: claimed!.batchId,
        atomic: false, operations: [claimed!.payload] }), bodyDigest: claimed!.digest });
    const operation = (targetId: string) => ({ opId: `op-${targetId}`, batchId: `batch-${targetId}`,
      idempotencyKey: `key-${targetId}`, digest: `sha256:${targetId}`, endpointIdentity: 'syncPush' as const,
      mediaType: 'application/json', baseRevision: null, operationRevision: `local-${targetId}`,
      status: 'pending' as const, retry: { attempt: 0, notBefore: 0 },
      payload: { opId: `op-${targetId}`, replicaId: scope.replicaId, sequence: 2, collectionId: scope.collectionId,
        type: 'update_node_content', targetId, baseRevision: null, occurredAt: '2026-07-27T00:00:00Z',
        dependencies: [], payload: {} } });
    await assert.rejects(() => store.allocateSequenceAndEnqueue(scope, operation('mapped-colp'), { allowUnstamped: true }),
      /exact_retry_pending/u);
    const admitted = await store.allocateSequenceAndEnqueue(scope, operation('sibling-colp'), { allowUnstamped: true });
    assert.equal(admitted.sequence, 2);
  });
});

async function losePushResponse(store: Fixture['store']): Promise<string> {
  const worker = createOutboundPushWorker({ scope, store, endpoints: async () => endpoints, sessions,
    now: () => clock.now, random: () => 0, ownerId: () => 'owner-ingress',
    fetch: async () => { throw new TypeError('Failed to fetch'); } });
  return (await worker.drain()).outcome;
}

/**
 * A lane-faithful server settles exactly the first claimed operation and then
 * loses connectivity, so the dependent-release assertions stay deterministic.
 */
async function settleFirstPush(store: Fixture['store']): Promise<string> {
  clock.now += 60_000;
  let answered = false;
  const worker = createOutboundPushWorker({ scope, store, endpoints: async () => endpoints, sessions,
    now: () => clock.now, random: () => 0, ownerId: () => 'owner-ingress', fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { batchId: string; operations: Array<{ opId: string; sequence: number }> };
      const pushed = body.operations[0]!;
      if (answered) throw new TypeError('Failed to fetch');
      answered = true;
      return new Response(JSON.stringify({ batchId: body.batchId, results: [{ opId: pushed.opId,
        sequence: pushed.sequence, status: 'applied', targetId: 'mapped-colp',
        revision: `revision-${pushed.sequence}`, cursor: 'cursor-1', warnings: [] }], serverCursor: 'cursor-1' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
    } });
  return (await worker.drain()).outcome;
}
