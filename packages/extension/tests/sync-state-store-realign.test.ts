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

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

describe('queue realignment after a permanently rejected hole', () => {
  test('renumbers surviving work onto the server expectedSequence and parks rejected history after it', async () => {
    // Lane state: sequence 1 applied (terminal), sequence 2 permanently
    // rejected (lane still expects 2), sequence 3 got the gap evidence,
    // sequence 4 is untouched pending work.
    const { store, lease } = await seed([
      row(1, 'terminal'),
      row(2, 'rejected', { recovery: { code: 'payload_too_large' } }),
      row(3, 'gap', { recovery: { code: 'sequence_gap', expectedSequence: 2 }, attempt: 1 }),
      row(4, 'pending'),
    ]);
    assert.deepEqual(await store.auditIntegrity(), { outcome: 'valid' });
    const result = await store.realignQueueAfterGap(scope, 'owner-1', lease.fence, 2_000, digestOperation);
    assert.equal(result.realigned, true);

    const rows = await store.listQueue(scope);
    assert.deepEqual(rows.map((item) => [item.sequence, item.opId, item.status]), [
      [1, 'op-1', 'terminal'],
      [2, 'op-3', 'pending'],
      [3, 'op-4', 'pending'],
      [4, 'op-2', 'rejected'],
    ]);
    const healed = rows[1]!;
    // The operation itself must carry the realigned sequence: the wire result
    // binding checks result.sequence against the queue row.
    assert.equal((healed.payload as { sequence?: number }).sequence, 2);
    assert.equal(healed.digest, 'sha256:test-op-3-2');
    // New operation bytes must never replay the old idempotency identity.
    assert.equal(healed.idempotencyKey, 'op-3.realign.2');
    assert.equal(healed.recovery, undefined);
    assert.equal(healed.attempt, undefined);
    assert.equal(healed.retry.notBefore, 0);
    // The parked rejected row keeps its status and refusal evidence.
    assert.equal(rows[3]!.recovery?.code, 'payload_too_large');
    assert.deepEqual(await store.auditIntegrity(), { outcome: 'valid' });
    // Future allocations continue after the compacted block.
    const enqueued = await store.allocateSequenceAndEnqueue(scope, {
      opId: 'op-next', batchId: 'batch-next', idempotencyKey: 'key-next', digest: 'sha256:next',
      endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null,
      operationRevision: 'local-next', status: 'pending', retry: { attempt: 0, notBefore: 0 },
      payload: payload('op-next', 5) }, { allowUnstamped: true });
    assert.equal(enqueued.sequence, 5);
    store.close();
  });

  test('leaves the barrier untouched when the hole is not purely rejected history', async () => {
    const { store, lease } = await seed([
      row(1, 'terminal'),
      row(2, 'gap', { recovery: { code: 'sequence_gap', expectedSequence: 1 }, attempt: 1 }),
      row(3, 'pending'),
    ]);
    // expectedSequence points at a terminal row: the evidence contradicts the
    // local lane, so nothing may move.
    const result = await store.realignQueueAfterGap(scope, 'owner-1', lease.fence, 2_000, digestOperation);
    assert.equal(result.realigned, false);
    assert.deepEqual((await store.listQueue(scope)).map((item) => [item.sequence, item.status]),
      [[1, 'terminal'], [2, 'gap'], [3, 'pending']]);
    store.close();
  });

  test('a blocked head or a gap without evidence never realigns', async () => {
    for (const head of [
      row(2, 'blocked', { recovery: { code: 'conflict_pending' }, attempt: 1 }),
      row(2, 'gap', { recovery: { code: 'sequence_gap' }, attempt: 1 }),
    ]) {
      indexedDB = new IDBFactory();
      const { store, lease } = await seed([row(1, 'rejected', { recovery: { code: 'op_id_reused' } }), head]);
      const result = await store.realignQueueAfterGap(scope, 'owner-1', lease.fence, 2_000, digestOperation);
      assert.equal(result.realigned, false, `${head.status} head must stand`);
      store.close();
    }
  });

  test('requires the live push lease', async () => {
    const { store, lease } = await seed([
      row(1, 'rejected', { recovery: { code: 'op_id_reused' } }),
      row(2, 'gap', { recovery: { code: 'sequence_gap', expectedSequence: 1 }, attempt: 1 }),
    ]);
    await assert.rejects(
      () => store.realignQueueAfterGap(scope, 'owner-other', lease.fence, 2_000, digestOperation),
      /stale_fence/u);
    store.close();
  });
});

describe('queue realignment when the server lane is ahead (F009)', () => {
  test('expected === head.sequence clears the barrier and continues after the highest local row', async () => {
    const { store, lease } = await seed([
      row(1, 'terminal'),
      row(2, 'gap', { recovery: { code: 'sequence_gap', expectedSequence: 2 }, attempt: 1 }),
      row(3, 'pending'),
    ]);
    const result = await store.realignQueueAfterGap(scope, 'owner-1', lease.fence, 2_000, digestOperation);
    assert.equal(result.realigned, true);
    assert.equal(result.mode, 'resume_at_expected');
    assert.deepEqual((await store.listQueue(scope)).map((item) => [item.sequence, item.opId, item.status]),
      [[1, 'op-1', 'terminal'], [2, 'op-2', 'pending'], [3, 'op-3', 'pending']]);
    // The healed row keeps its exact evidence-free replay path, and the floor
    // moved past every surviving row so no allocation can collide with one.
    assert.equal((await store.listQueue(scope))[1]!.recovery, undefined);
    assert.equal((await store.listQueue(scope))[1]!.retry.notBefore, 0);
    // Idempotent: a second call has no gap head to heal.
    assert.deepEqual(await store.realignQueueAfterGap(scope, 'owner-1', lease.fence, 2_000, digestOperation),
      { realigned: false });
    const enqueued = await store.allocateSequenceAndEnqueue(scope, {
      opId: 'op-next', batchId: 'batch-next', idempotencyKey: 'key-next', digest: 'sha256:next',
      endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null,
      operationRevision: 'local-next', status: 'pending', retry: { attempt: 0, notBefore: 0 },
      payload: payload('op-next', 4) }, { allowUnstamped: true });
    assert.equal(enqueued.sequence, 4);
    store.close();
  });

  test('expected > head.sequence lifts surviving work onto the lane and parks rejected rows after it', async () => {
    const { store, lease } = await seed([
      row(1, 'terminal'),
      row(2, 'rejected', { recovery: { code: 'op_id_reused' } }),
      row(3, 'gap', { recovery: { code: 'sequence_gap', expectedSequence: 6 }, attempt: 1 }),
      row(4, 'pending'),
      row(7, 'rejected', { recovery: { code: 'payload_too_large' } }),
    ]);
    const result = await store.realignQueueAfterGap(scope, 'owner-1', lease.fence, 2_000, digestOperation);
    assert.equal(result.realigned, true);
    assert.equal(result.mode, 'renumber_up');
    const rows = await store.listQueue(scope);
    assert.deepEqual(rows.map((item) => [item.sequence, item.opId, item.status]), [
      [1, 'op-1', 'terminal'],
      [2, 'op-2', 'rejected'],
      [6, 'op-3', 'pending'],
      [7, 'op-4', 'pending'],
      [8, 'op-7', 'rejected'],
    ]);
    assert.equal(rows[2]!.payload.sequence, 6);
    assert.equal(rows[2]!.digest, 'sha256:test-op-3-6');
    assert.equal(rows[2]!.idempotencyKey, 'op-3.realign.6');
    assert.equal(rows[2]!.recovery, undefined);
    assert.equal(rows[2]!.attempt, undefined);
    assert.equal(rows[3]!.payload.sequence, 7);
    assert.equal(rows[4]!.recovery?.code, 'payload_too_large');
    // Nothing is republished twice: the healed scope is stable and the counter
    // sits after the compacted block.
    assert.deepEqual(await store.realignQueueAfterGap(scope, 'owner-1', lease.fence, 2_000, digestOperation),
      { realigned: false });
    const enqueued = await store.allocateSequenceAndEnqueue(scope, {
      opId: 'op-next', batchId: 'batch-next', idempotencyKey: 'key-next', digest: 'sha256:next',
      endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null,
      operationRevision: 'local-next', status: 'pending', retry: { attempt: 0, notBefore: 0 },
      payload: payload('op-next', 9) }, { allowUnstamped: true });
    assert.equal(enqueued.sequence, 9);
    store.close();
  });

  test('expected > head.sequence refuses to move while a terminal or in-flight row contradicts the lane', async () => {
    for (const blocker of [
      row(5, 'terminal'),
      row(5, 'blocked', { recovery: { code: 'conflict_pending' } }),
      row(8, 'claimed'),
    ]) {
      indexedDB = new IDBFactory();
      const { store, lease } = await seed([
        row(3, 'gap', { recovery: { code: 'sequence_gap', expectedSequence: 5 }, attempt: 1 }),
        row(4, 'pending'),
        blocker,
      ]);
      const result = await store.realignQueueAfterGap(scope, 'owner-1', lease.fence, 2_000, digestOperation);
      assert.equal(result.realigned, false, `${blocker.status}@${blocker.sequence} must refuse the move`);
      assert.deepEqual((await store.listQueue(scope)).map((item) => [item.sequence, item.status]),
        [[3, 'gap'], [4, 'pending'], [blocker.sequence, blocker.status]]);
      store.close();
    }
  });

  test('expected > head.sequence refuses to lift rows over in-flight work below the lane', async () => {
    // A claimed or blocked row between the local head and the lane still owns
    // its sequence (an HTTP attempt or a conflict receipt); lifting the rows
    // above it would rewrite that identity, so the barrier stands.
    for (const blocker of [
      row(4, 'claimed', { attempt: 1 }),
      row(4, 'blocked', { recovery: { code: 'conflict_pending' }, attempt: 1 }),
    ]) {
      indexedDB = new IDBFactory();
      const { store, lease } = await seed([
        row(3, 'gap', { recovery: { code: 'sequence_gap', expectedSequence: 5 }, attempt: 1 }),
        blocker,
        row(6, 'pending'),
      ]);
      const result = await store.realignQueueAfterGap(scope, 'owner-1', lease.fence, 2_000, digestOperation);
      assert.equal(result.realigned, false, `${blocker.status}@${blocker.sequence} below the lane must refuse the move`);
      assert.deepEqual((await store.listQueue(scope)).map((item) => [item.sequence, item.status]),
        [[3, 'gap'], [4, blocker.status], [6, 'pending']]);
      store.close();
    }
  });
});

function payload(opId: string, sequence: number): JsonObject {
  return { opId, replicaId: scope.replicaId, sequence, collectionId: scope.collectionId,
    type: 'update_node_content', targetId: 'node-1', baseRevision: 'revision-0',
    occurredAt: '2026-08-27T00:00:00Z', dependencies: [], payload: {} };
}

function row(sequence: number, status: string, extra: { recovery?: JsonObject; attempt?: number } = {}) {
  return { sequence, opId: `op-${sequence}`, batchId: `batch-${sequence}`, idempotencyKey: `idempotency-${sequence}`,
    digest: `sha256:op-${sequence}`, endpointIdentity: 'syncPush', mediaType: 'application/json',
    baseRevision: 'revision-0', operationRevision: `local-${sequence}`, status,
    retry: { attempt: extra.attempt ?? 0, notBefore: 0 },
    ...(extra.recovery ? { recovery: extra.recovery } : {}),
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
    const sequences = tx.objectStore('durable_sequences');
    for (const item of rows) queue.add({ ...item, scopeKey });
    const receipts = tx.objectStore('receipts');
    for (const item of rows) {
      if (item.status !== 'terminal') continue;
      receipts.add({ scopeKey, sequence: item.sequence, opId: item.opId,
        operationDigest: item.digest, kind: 'terminal', receiptId: `receipt-${item.opId}`,
        resultDigest: `sha256:result-${item.opId}` });
    }
    sequences.put({ scopeKey, next: Math.max(...rows.map((item) => item.sequence), 0) + 1 });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error as Error);
    tx.onabort = () => reject(tx.error as Error);
  });
  const lease = await store.acquireLease(scope, 'owner-1', 1_000, 60_000);
  assert.equal(lease.outcome, 'acquired');
  return { store, lease: lease as { fence: number } };
}
