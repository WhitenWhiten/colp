import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { createBookmarkImportCoordinator } from '../src/bookmark-import-plan.js';
import { previewNetscapeBookmarkImport } from '../src/import-preview.js';
import { createOutboundPushWorker, type PushSessionController } from '../src/outbound-push-worker.js';
import { digestBytes, digestJson, encodeRequest } from '../src/outbound-push-encoding.js';
import { createSyncStateStore, type QueueOperation, type ReceiptInput } from '../src/sync-state-store.js';
import { bookmark, fixture, scope } from './bookmark-event-queue-harness.js';
import { endpoints, json } from './outbound-push-worker-harness.js';

type Store = ReturnType<typeof createSyncStateStore>;

/** Real ingress and import plans exercise durable writer boundaries.
 * No terminal rows, receipts, or processed ingress events are injected directly. */
test('a captured bookmark retries the exact lost request after reopen and rejects callbacks from the former lease', async () => {
  const indexedDB = new IDBFactory(), f = await fixture(indexedDB);
  let store = f.store;
  try {
    const native = bookmark('native-created', 'folder-parent', 0, 'Saved locally', 'https://queue-reopen.test/');
    f.api.put(native);
    assert.equal((await f.queue.created(native.id, native)).outcome, 'staged');
    await f.queue.flush();
    const queued = (await store.listQueue(scope))[0]!;
    assert.equal((await store.listQueue(scope)).length, 1);
    assert.equal((await store.getMappingByNativeId(scope, native.id))?.colpId, `pending-${queued.opId}`);
    const clock = { now: 1_000 };
    let firstBody = '', firstKey: string | null = null, requests = 0;
    const first = createOutboundPushWorker({ ...workerOptions(store, clock, 'former-worker'),
      fetch: async (_url, init) => {
        requests++; firstBody = String(init?.body); firstKey = new Headers(init?.headers).get('Idempotency-Key');
        throw new TypeError('Failed to fetch');
      } });
    assert.equal((await first.drain()).outcome, 'unknown');
    const uncertain = await store.getQueueByOpId(scope, queued.opId);
    assert.equal(uncertain?.status, 'unknown'); assert.ok(uncertain?.attempt);
    assert.equal(uncertain.attempt.body, firstBody);
    assert.equal(uncertain.attempt.bodyDigest, digestBytes(firstBody));
    assert.equal(await store.getQueueReceipt(scope, queued.sequence), null);

    store.close(); store = createSyncStateStore({ indexedDB });
    assert.deepEqual(await store.getQueueByOpId(scope, queued.opId), uncertain);
    clock.now = uncertain.retry.notBefore;
    const former = await store.acquireLease(scope, 'former-worker', clock.now, 1_000);
    assert.equal(former.outcome, 'acquired');
    assert.ok(await store.claimNextQueue(scope, 'former-worker', former.fence, clock.now));
    const claimed = await store.getQueueByOpId(scope, queued.opId); assert.ok(claimed?.attempt);
    assert.deepEqual(claimed.attempt, uncertain.attempt);
    const beforeAttemptChange = await facts(store);
    const changedBody = `${claimed.attempt.body} `;
    await assert.rejects(store.bindPushAttempt(scope, queued.sequence, 'former-worker', former.fence,
      { ...claimed.attempt, body: changedBody, bodyDigest: digestBytes(changedBody) }), /attempt_binding_immutable/);
    assert.deepEqual(await facts(store), beforeAttemptChange);

    clock.now = former.expiresAt! + 1;
    const replacement = await store.acquireLease(scope, 'replacement-worker', clock.now, 1_000);
    assert.equal(replacement.outcome, 'acquired'); assert.ok(replacement.fence > former.fence);
    const takeover = await store.claimNextQueue(scope, 'replacement-worker', replacement.fence, clock.now);
    assert.ok(takeover?.attempt); assert.deepEqual(takeover.attempt, uncertain.attempt);
    const afterTakeover = await facts(store);
    // These are late continuations of the terminated writer. Each real writer
    // must reject the stale lease without touching queue, receipt, mapping or cache.
    await assert.rejects(store.bindPushAttempt(scope, queued.sequence, 'former-worker', former.fence,
      uncertain.attempt), /stale_fence/);
    assert.deepEqual(await facts(store), afterTakeover);
    await assert.rejects(store.rebaseClaimedPush(scope, queued.sequence, 'former-worker', former.fence, {
      payload: queued.payload, digest: queued.digest, idempotencyKey: queued.idempotencyKey,
      baseRevision: queued.baseRevision }), /stale_fence/);
    assert.deepEqual(await facts(store), afterTakeover);
    await assert.rejects(store.settleClaimedPush(scope, queued.sequence, 'former-worker', former.fence, {
      outcome: 'terminal', receipt: receiptFor(takeover, 'server-created', 'late-old-receipt') }), /stale_fence/);
    assert.deepEqual(await facts(store), afterTakeover);

    const resumed = createOutboundPushWorker({ ...workerOptions(store, clock, 'replacement-worker'),
      fetch: async (_url, init) => {
        requests++; assert.equal(String(init?.body), firstBody);
        assert.equal(new Headers(init?.headers).get('Idempotency-Key'), firstKey);
        const body = JSON.parse(String(init?.body)) as { batchId: string; operations: Array<{ opId: string; sequence: number }> };
        assert.deepEqual(body.operations.map(op => [op.opId, op.sequence]), [[queued.opId, queued.sequence]]);
        return json(200, { batchId: body.batchId, serverCursor: 'cursor-created', results: [{
          opId: queued.opId, sequence: queued.sequence, status: 'applied', targetId: 'server-created',
          revision: 'server-created-r1', cursor: 'cursor-created', warnings: [],
        }] });
      } });
    assert.equal((await resumed.drain()).outcome, 'terminal');
    assert.equal((await resumed.drain()).outcome, 'idle');
    assert.equal(requests, 2, 'retry sends the same operation once and terminal work is not sent again');
    const terminal = await store.getQueueByOpId(scope, queued.opId);
    assert.ok(terminal); assert.equal(terminal.status, 'terminal'); assert.deepEqual(terminal.attempt, uncertain.attempt);
    const receipt = await store.getQueueReceipt(scope, queued.sequence);
    assert.equal(receipt?.opId, queued.opId); assert.equal(receipt?.operationDigest, queued.digest);
    assert.equal(receipt?.kind, 'terminal');
    const bound = await store.getMappingByNativeId(scope, native.id);
    assert.equal(bound?.colpId, 'server-created'); assert.equal(bound?.projection.revision, 'server-created-r1');
    assert.equal(await store.getMappingByColpId(scope, `pending-${queued.opId}`), null);
    store.close(); store = createSyncStateStore({ indexedDB });
    assert.deepEqual(await store.getQueueByOpId(scope, queued.opId), terminal);
    assert.deepEqual(await store.getQueueReceipt(scope, queued.sequence), receipt);
    assert.deepEqual(await store.getMappingByNativeId(scope, native.id), bound);
  } finally { store.close(); }
});

test('an interrupted folder import publishes only matching receipts and resumes its child after durable parent authority', async () => {
  const indexedDB = new IDBFactory(), f = await fixture(indexedDB);
  let store = f.store;
  const clock = { now: 1_000 };
  try {
    const conversion = previewNetscapeBookmarkImport(new TextEncoder().encode(
      '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><H3>Reading</H3><DL><p>'
      + '<DT><A HREF="https://import-receipt.test/one">One</A></DL><p></DL><p>'));
    assert.equal(conversion.preview.creates, 2);
    assert.deepEqual(await store.listQueue(scope), [], 'preview creates no outgoing work');
    const coordinator = createBookmarkImportCoordinator({ store, scope, now: () => clock.now });
    const plan = await coordinator.commit({ conversion, choices: [{ sourceNodeId: conversion.tree[0]!.sourceNodeId,
      action: 'import', target: { nativeId: 'folder-parent', colpId: 'folder-colp', revision: 'folder-revision-2' } }] });
    assert.equal(plan.progress.total, 2);
    const parent = (await store.listQueue(scope))[0]!;
    assert.equal((await store.listQueue(scope)).length, 1, 'the child cannot use an unconfirmed parent');
    assert.equal((parent.payload.payload as { parentId: string }).parentId, 'folder-colp');
    const lease = await store.acquireLease(scope, 'import-worker', clock.now, 10_000);
    assert.equal(lease.outcome, 'acquired');
    assert.equal((await store.claimNextQueue(scope, 'import-worker', lease.fence, clock.now))?.opId, parent.opId);
    await bindActualRequest(store, parent, 'import-worker', lease.fence, clock.now);
    const goodParent = receiptFor(parent, 'server-import-folder', 'parent-receipt');
    const before = await facts(store);
    for (const invalid of [{ ...goodParent, opId: 'other-operation' },
      { ...goodParent, operationDigest: 'sha256:wrong-operation' }]) {
      await assert.rejects(store.settleClaimedPush(scope, parent.sequence, 'import-worker', lease.fence,
        { outcome: 'terminal', receipt: invalid }), /digest_mismatch/);
      assert.deepEqual(await facts(store), before);
    }
    await assert.rejects(store.settleClaimedPush(scope, parent.sequence, 'import-worker', lease.fence,
      { outcome: 'terminal', receipt: goodParent }, { fault: 'after_receipt' }), /fault_injected/);
    assert.deepEqual(await facts(store), before, 'receipt, queue, import progress, mappings and cache roll back together');
    assert.equal(await store.getQueueReceipt(scope, parent.sequence), null);
    store.close(); store = createSyncStateStore({ indexedDB });
    assert.deepEqual((await facts(store)).durable, before.durable, 'interruption leaves no false parent authority after reopen');
    assert.equal((await store.listImportNodes(scope, plan.planId)).find(node => node.opId === parent.opId)?.authoritativeTarget, undefined);
    await store.settleClaimedPush(scope, parent.sequence, 'import-worker', lease.fence,
      { outcome: 'terminal', receipt: goodParent });
    assert.deepEqual((await store.listImportNodes(scope, plan.planId)).find(node => node.opId === parent.opId)?.authoritativeTarget,
      { colpId: 'server-import-folder', revision: 'server-import-folder-r1' });
    const resumed = createBookmarkImportCoordinator({ store, scope, now: () => clock.now });
    await resumed.resume(plan.planId);
    const rows = await store.listQueue(scope);
    assert.deepEqual(rows.map(row => row.sequence), [parent.sequence, parent.sequence + 1]);
    assert.equal(rows.filter(row => row.opId === parent.opId).length, 1);
    const child = rows[1]!;
    assert.equal((child.payload.payload as { parentId: string }).parentId, 'server-import-folder');
    assert.equal((await store.claimNextQueue(scope, 'import-worker', lease.fence, clock.now))?.opId, child.opId);
    await bindActualRequest(store, child, 'import-worker', lease.fence, clock.now);
    const beforeReuse = await facts(store);
    await assert.rejects(store.settleClaimedPush(scope, child.sequence, 'import-worker', lease.fence, {
      outcome: 'terminal', receipt: receiptFor(child, 'server-import-child', goodParent.receiptId),
    }), /receipt_binding_invalid/);
    assert.deepEqual(await facts(store), beforeReuse, 'a parent receipt cannot authorize the child sequence');
    assert.equal(await store.getQueueReceipt(scope, child.sequence), null);
    const goodChild = receiptFor(child, 'server-import-child', 'child-receipt');
    await store.settleClaimedPush(scope, child.sequence, 'import-worker', lease.fence,
      { outcome: 'terminal', receipt: goodChild });
    const finished = await resumed.resume(plan.planId);
    assert.equal(finished.state, 'complete');
    assert.deepEqual(finished.progress, { total: 2, skipped: 0, queued: 0, terminal: 2, recoverable: 0 });
    store.close(); store = createSyncStateStore({ indexedDB });
    const again = await createBookmarkImportCoordinator({ store, scope, now: () => clock.now }).resume(plan.planId);
    assert.equal(again.state, 'complete');
    assert.deepEqual((await store.listQueue(scope)).map(row => [row.opId, row.sequence, row.status]),
      [[parent.opId, parent.sequence, 'terminal'], [child.opId, child.sequence, 'terminal']]);
    for (const [row, receipt] of [[parent, goodParent], [child, goodChild]] as const) {
      assert.deepEqual(await store.getQueueReceipt(scope, row.sequence),
        { ...receipt, scopeKey: (await store.getScope(scope))!.scopeKey, sequence: row.sequence });
    }
  } finally { store.close(); }
});

function workerOptions(store: Store, clock: { now: number }, owner: string) {
  const sessions: PushSessionController = { async get() { return { credential: { accessToken: 'test-queue-token' },
    session: { sessionId: 'queue-session', credentialAuthorityDigest: 'a'.repeat(64), acceptedProtocolVersion: '0.2',
      expiresAt: '2099-01-01T00:00:00Z', scope: 'collection', snapshotRequired: false,
      collection: { collectionId: scope.collectionId, serverCursor: 'cursor-3', serverRevision: 'collection-revision-3' },
      replicaLease: { leaseId: 'lease', generation: String(scope.generation), state: 'active', expiresAt: '2099-01-01T00:00:00Z' } } }; } };
  return { scope, store, sessions, endpoints: async () => endpoints, now: () => clock.now,
    random: () => 0, ownerId: () => owner };
}
async function bindActualRequest(store: Store, row: QueueOperation, owner: string, fence: number, now: number) {
  const sessionId = 'queue-session', batchId = `batch-${row.opId}`;
  const body = encodeRequest(row, sessionId, batchId);
  return store.bindPushAttempt(scope, row.sequence, owner, fence, {
    sessionId, batchId, idempotencyKey: row.idempotencyKey, endpointIdentity: 'syncPush',
    mediaType: 'application/json', body, bodyDigest: digestBytes(body), startedAt: now });
}
function receiptFor(row: QueueOperation, targetId: string, receiptId: string): ReceiptInput {
  const result = { batchId: row.attempt?.batchId ?? `batch-${row.opId}`, serverCursor: `cursor-${row.sequence}`,
    results: [{ opId: row.opId, sequence: row.sequence, status: 'applied', targetId,
      revision: `${targetId}-r1`, cursor: `cursor-${row.sequence}`, warnings: [] }] };
  return { opId: row.opId, operationDigest: row.digest, kind: 'terminal', receiptId,
    resultDigest: `sha256:${digestJson(result)}`, result };
}
async function facts(store: Store) {
  return { durable: await store.exportScope(scope), cache: store.peekDurableCache(scope) };
}
