import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { createSyncStateStore, type JsonObject, type SyncScope } from '../src/sync-state-store.js';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
  replicaId: 'replica-a', generation: 1,
});
const digestOperation = (operation: JsonObject) => `sha256:test-${String(operation.opId)}-${String(operation.sequence)}`;
const sentAttempt = { sessionId: 'session-1', batchId: 'batch', idempotencyKey: 'idempotency', endpointIdentity: 'syncPush',
  mediaType: 'application/json', body: JSON.stringify({ sessionId: 'session-1', batchId: 'batch' }), bodyDigest: 'sha256:body' };

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

describe('held (set_aside) queue rows', () => {
  test('a held row in the middle never stalls the rows behind it', async () => {
    const { store, lease } = await seed([row(1, 'terminal'), row(2, 'pending'), row(3, 'pending')]);
    const held = await store.setAsideQueue(scope, [2], 'conflict_hold');
    assert.deepEqual(held.map((item) => [item.sequence, item.status, item.recovery?.code]), [[2, 'set_aside', 'conflict_hold']]);
    // Held work is outstanding but not drainable: the lane claims the next row.
    const claimed = await store.claimNextQueue(scope, 'owner-1', lease.fence, 2_000);
    assert.equal(claimed?.opId, 'op-3');
    assert.deepEqual(await store.auditIntegrity(), { outcome: 'valid' });
    // Setting aside again is idempotent.
    assert.equal((await store.setAsideQueue(scope, [2], 'other_reason'))[0]!.recovery?.code, 'conflict_hold');
    store.close();
  });

  test('the gap realign parks held rows after the surviving work, like refused history', async () => {
    const { store, lease } = await seed([
      row(1, 'terminal'),
      row(2, 'set_aside', { recovery: { code: 'conflict_hold' } }),
      row(3, 'rejected', { recovery: { code: 'payload_too_large' } }),
      row(4, 'gap', { recovery: { code: 'sequence_gap', expectedSequence: 2 }, attempt: 1 }),
      row(5, 'pending'),
    ]);
    const result = await store.realignQueueAfterGap(scope, 'owner-1', lease.fence, 2_000, digestOperation);
    assert.deepEqual(result, { realigned: true, mode: 'renumber_down' });
    const rows = await store.listQueue(scope);
    assert.deepEqual(rows.map((item) => [item.sequence, item.opId, item.status]), [
      [1, 'op-1', 'terminal'], [2, 'op-4', 'pending'], [3, 'op-5', 'pending'],
      [4, 'op-2', 'set_aside'], [5, 'op-3', 'rejected'],
    ]);
    // The held row keeps why it is held; its bytes follow its new slot.
    assert.equal(rows[3]!.recovery?.code, 'conflict_hold');
    assert.equal((rows[3]!.payload as { sequence?: number }).sequence, 4);
    assert.deepEqual(await store.auditIntegrity(), { outcome: 'valid' });
    store.close();
  });

  test('a released row returns at the tail of the lane, after work queued meanwhile, in its original order', async () => {
    const { store } = await seed([
      row(1, 'terminal'),
      row(2, 'set_aside', { recovery: { code: 'conflict_hold' } }),
      row(3, 'set_aside', { recovery: { code: 'conflict_hold' } }),
      row(4, 'pending'),
    ]);
    const queued = await store.allocateSequenceAndEnqueue(scope, {
      opId: 'op-next', batchId: 'batch-next', idempotencyKey: 'key-next', digest: 'sha256:next',
      endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null,
      operationRevision: 'local-next', status: 'pending', retry: { attempt: 0, notBefore: 0 },
      payload: payload('op-next', 5) }, { allowUnstamped: true });
    assert.equal(queued.sequence, 5);
    // Out of order on purpose: release keeps the held rows' own order.
    const released = await store.releaseSetAsideQueue(scope, [3, 2], digestOperation);
    assert.deepEqual(released.map((item) => [item.sequence, item.opId]), [[6, 'op-2'], [7, 'op-3']]);
    const rows = await store.listQueue(scope);
    assert.deepEqual(rows.map((item) => [item.sequence, item.opId, item.status]), [
      [1, 'op-1', 'terminal'], [4, 'op-4', 'pending'], [5, 'op-next', 'pending'],
      [6, 'op-2', 'pending'], [7, 'op-3', 'pending'],
    ]);
    const returned = rows[3]!;
    assert.equal((returned.payload as { sequence?: number }).sequence, 6);
    assert.equal(returned.digest, 'sha256:test-op-2-6');
    // New bytes never replay the old idempotency identity; the opId stays for mappings.
    assert.equal(returned.idempotencyKey, 'op-2.release.6');
    assert.equal(returned.recovery, undefined);
    assert.equal(returned.attempt, undefined);
    // Allocation continues after the released rows; a second release is a no-op.
    assert.deepEqual(await store.releaseSetAsideQueue(scope, [2, 3], digestOperation), []);
    const after = await store.allocateSequenceAndEnqueue(scope, {
      opId: 'op-last', batchId: 'batch-last', idempotencyKey: 'key-last', digest: 'sha256:last',
      endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null,
      operationRevision: 'local-last', status: 'pending', retry: { attempt: 0, notBefore: 0 },
      payload: payload('op-last', 8) }, { allowUnstamped: true });
    assert.equal(after.sequence, 8);
    assert.deepEqual(await store.auditIntegrity(), { outcome: 'valid' });
    store.close();
  });

  test('only a pending row that was never sent can be held', async () => {
    const { store } = await seed([
      row(1, 'terminal'), row(2, 'claimed'), row(3, 'unknown', { sent: true }), row(4, 'pending', { sent: true }),
      row(5, 'rejected', { recovery: { code: 'payload_too_large' } }), row(6, 'pending'),
    ]);
    for (const sequence of [1, 2, 3, 4, 5]) {
      await assert.rejects(() => store.setAsideQueue(scope, [sequence], 'conflict_hold'), /set_aside_refused/u, String(sequence));
    }
    await assert.rejects(() => store.setAsideQueue(scope, [99], 'conflict_hold'), /queue_not_found/u);
    // One refusal holds nothing: the batch is atomic.
    await assert.rejects(() => store.setAsideQueue(scope, [6, 2], 'conflict_hold'), /set_aside_refused/u);
    assert.equal((await store.listQueue(scope)).find((item) => item.sequence === 6)?.status, 'pending');
    store.close();
  });
});

function payload(opId: string, sequence: number): JsonObject {
  return { opId, replicaId: scope.replicaId, sequence, collectionId: scope.collectionId,
    type: 'update_node_content', targetId: 'node-1', baseRevision: 'revision-0',
    occurredAt: '2026-08-27T00:00:00Z', dependencies: [], payload: {} };
}

function row(sequence: number, status: string,
  extra: { recovery?: JsonObject; attempt?: number; sent?: boolean } = {}) {
  return { sequence, opId: `op-${sequence}`, batchId: `batch-${sequence}`, idempotencyKey: `idempotency-${sequence}`,
    digest: `sha256:op-${sequence}`, endpointIdentity: 'syncPush', mediaType: 'application/json',
    baseRevision: 'revision-0', operationRevision: `local-${sequence}`, status,
    retry: { attempt: extra.attempt ?? 0, notBefore: 0,
      ...(status === 'claimed' ? { ownerId: 'owner-0', fence: 1, claimExpiresAt: 5_000 } : {}) },
    ...(extra.recovery ? { recovery: extra.recovery } : {}),
    ...(extra.sent ? { attempt: sentAttempt } : {}),
    payload: payload(`op-${sequence}`, sequence) };
}

async function seed(rows: ReturnType<typeof row>[]) {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'revision-0', cursor: 'cursor-0' }, selectedRoots: [] });
  const scopeKey = (await store.getScope(scope))!.scopeKey;
  const db = await store.open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['outbound_queue', 'receipts', 'durable_sequences'], 'readwrite');
    const queue = tx.objectStore('outbound_queue');
    for (const item of rows) queue.add({ ...item, scopeKey });
    const receipts = tx.objectStore('receipts');
    for (const item of rows) {
      if (item.status !== 'terminal') continue;
      receipts.add({ scopeKey, sequence: item.sequence, opId: item.opId,
        operationDigest: item.digest, kind: 'terminal', receiptId: `receipt-${item.opId}`,
        resultDigest: `sha256:result-${item.opId}` });
    }
    tx.objectStore('durable_sequences').put({ scopeKey, next: Math.max(...rows.map((item) => item.sequence), 0) + 1 });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error as Error);
    tx.onabort = () => reject(tx.error as Error);
  });
  const lease = await store.acquireLease(scope, 'owner-1', 1_000, 60_000);
  assert.equal(lease.outcome, 'acquired');
  return { store, lease: lease as { fence: number } };
}
