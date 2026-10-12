import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import {
  createSyncStateStore,
  type QueueOperation,
  type SyncScope,
} from '../src/sync-state-store.js';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
  replicaId: 'replica-a', generation: 1,
});
const other = { ...scope, accountId: 'account-b', replicaId: 'replica-b' };
const operation = (opId = 'op-1'): Omit<QueueOperation, 'sequence' | 'scopeKey'> => ({
  opId, batchId: 'batch-1', idempotencyKey: 'idempotency-1', digest: `sha256:${opId}`,
  endpointIdentity: 'syncPush', mediaType: 'application/vnd.collection-protocol.sync+json',
  baseRevision: 'revision-0', operationRevision: 'revision-local-1', status: 'pending',
  retry: { attempt: 0, notBefore: 0 }, payload: { type: 'update_node', targetId: 'node-1' },
});

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

describe('P3-28 uniqueness, monotonicity and atomic transactions', () => {
  test('enforces mapping reverse uniqueness, sequence/opId uniqueness and never reuses sequence', async () => {
    const store = createSyncStateStore({ indexedDB }); await active(store);
    await store.putMapping(scope, { nativeId: 'native-1', colpId: 'colp-1', rootNativeId: 'root',
      projection: { revision: 'r1', digest: 'sha256:p1' } });
    await assert.rejects(() => store.putMapping(scope, { nativeId: 'native-1', colpId: 'colp-2', rootNativeId: 'root',
      projection: { revision: 'r1', digest: 'sha256:p2' } }), /constraint/);
    const first = await store.allocateSequenceAndEnqueue(scope, operation(), { allowUnstamped: true });
    assert.deepEqual(await store.allocateSequenceAndEnqueue(scope, operation(), { allowUnstamped: true }), first);
    await assert.rejects(() => store.allocateSequenceAndEnqueue(scope, { ...operation(), digest: 'sha256:changed' }, { allowUnstamped: true }),
      /op_id_reuse/);
    await store.completeQueueWithReceipt(scope, first.sequence, { opId: first.opId, operationDigest: first.digest,
      kind: 'terminal', receiptId: 'receipt', resultDigest: 'sha256:result' });
    const second = await store.allocateSequenceAndEnqueue(scope, operation('op-2'), { allowUnstamped: true });
    assert.equal(second.sequence, first.sequence + 1);
  });

  test('aborts every multi-store write point without half state or optimistic durable cache', async () => {
    for (const fault of ['after_sequence', 'after_queue'] as const) {
      indexedDB = new IDBFactory(); const store = createSyncStateStore({ indexedDB }); await active(store);
      const durableBefore = store.peekDurableCache(scope);
      await assert.rejects(() => store.allocateSequenceAndEnqueue(scope, operation(), { fault, allowUnstamped: true }), /fault_injected/);
      assert.equal((await store.listQueue(scope)).length, 0);
      assert.equal((await store.exportScope(scope)).sequence?.next, 1);
      assert.deepEqual(store.peekDurableCache(scope), durableBefore);
    }
    indexedDB = new IDBFactory(); const quotaStore = createSyncStateStore({ indexedDB }); await active(quotaStore);
    await assert.rejects(() => quotaStore.allocateSequenceAndEnqueue(scope, operation(), { fault: 'quota', allowUnstamped: true }),
      /quota_exceeded/);
    assert.equal((await quotaStore.listQueue(scope)).length, 0);
    for (const fault of ['after_receipt', 'after_cursor'] as const) {
      indexedDB = new IDBFactory(); const store = createSyncStateStore({ indexedDB }); await active(store);
      const queued = await store.allocateSequenceAndEnqueue(scope, operation(), { allowUnstamped: true });
      if (fault === 'after_receipt') {
        await assert.rejects(() => store.completeQueueWithReceipt(scope, queued.sequence, { opId: queued.opId,
          operationDigest: queued.digest, kind: 'terminal', receiptId: 'receipt', resultDigest: 'sha256:r' },
        { fault }), /fault_injected/);
        assert.equal((await store.exportScope(scope)).receipts.length, 0);
      } else {
        await store.completeQueueWithReceipt(scope, queued.sequence, { opId: queued.opId,
          operationDigest: queued.digest, kind: 'terminal', receiptId: 'receipt', resultDigest: 'sha256:r' });
        await assert.rejects(() => store.publishCursor(scope, { cursor: 'cursor', checkpoint: 'checkpoint',
          evidence: { receiptId: 'receipt', operationDigest: queued.digest } }, { fault }), /fault_injected/);
        assert.equal((await store.exportScope(scope)).cursor, null);
      }
    }
    indexedDB = new IDBFactory(); const store = createSyncStateStore({ indexedDB }); await active(store);
    const queued = await store.allocateSequenceAndEnqueue(scope, operation(), { allowUnstamped: true });
    await store.completeQueueWithReceipt(scope, queued.sequence, { opId: queued.opId, operationDigest: queued.digest,
      kind: 'terminal', receiptId: 'receipt', resultDigest: 'sha256:r' });
    await store.createApplyIntent(scope, { intentId: 'intent', correlationId: 'correlation', operationId: 'remote',
      expected: { kind: 'change', nativeId: 'native' }, expiresAt: 10 });
    await assert.rejects(() => store.commitApplyIntent(scope, 'intent', { mapping: { nativeId: 'native', colpId: 'colp',
      rootNativeId: 'root', projection: { revision: 'r', digest: 'sha256:p' } }, cursor: { cursor: 'cursor',
      checkpoint: 'checkpoint', evidence: { receiptId: 'receipt', operationDigest: queued.digest } } },
    { fault: 'after_mapping' }), /fault_injected/);
    assert.equal((await store.exportScope(scope)).mappings.length, 0);

    indexedDB = new IDBFactory(); const unknown = createSyncStateStore({ indexedDB }); await active(unknown);
    await assert.rejects(() => unknown.allocateSequenceAndEnqueue(scope, operation(), { fault: 'unknown_commit', allowUnstamped: true }),
      /commit_outcome_unknown/);
    assert.deepEqual(unknown.peekDurableCache(scope), await unknown.getScope(scope));
    const recovered = await unknown.allocateSequenceAndEnqueue(scope, operation(), { allowUnstamped: true });
    assert.equal(recovered.sequence, 1);
    assert.equal((await unknown.exportScope(scope)).sequence?.next, 2);
  });

  test('binds receipt to queue digest and cursor evidence to the same scope', async () => {
    const store = createSyncStateStore({ indexedDB }); await active(store);
    const queued = await store.allocateSequenceAndEnqueue(scope, operation(), { allowUnstamped: true });
    await assert.rejects(() => store.completeQueueWithReceipt(scope, queued.sequence, { opId: queued.opId,
      operationDigest: 'sha256:wrong', kind: 'terminal', receiptId: 'receipt', resultDigest: 'sha256:r' }), /digest_mismatch/);
    await assert.rejects(() => store.publishCursor(other, { cursor: 'cursor', checkpoint: 'checkpoint',
      evidence: { receiptId: 'receipt', operationDigest: queued.digest } }), /scope_not_found/);
    await store.createApplyIntent(scope, { intentId: 'intent', correlationId: 'correlation', operationId: 'remote',
      expected: { kind: 'change', nativeId: 'native' }, expiresAt: 10 });
    await assert.rejects(() => store.commitApplyIntent(scope, 'intent', { mapping: { nativeId: 'other-native',
      colpId: 'colp', rootNativeId: 'root', projection: { revision: 'r', digest: 'sha256:p' } }, cursor: {
      cursor: 'cursor', checkpoint: 'checkpoint', evidence: { receiptId: 'missing', operationDigest: queued.digest },
    } }), /intent_mapping_mismatch/);
  });
});

async function active(store: ReturnType<typeof createSyncStateStore>) {
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 100 },
    checkpoint: null, selectedRoots: [] });
}
