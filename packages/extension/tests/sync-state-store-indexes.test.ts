import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import {
  LARGE_QUEUE_CONTRACT_SIZE, createSyncStateStore,
  type QueueOperation, type SyncScope,
} from '../src/sync-state-store.js';
import { readSyncStateSource } from './read-sync-state-source.js';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
  replicaId: 'replica-a', generation: 1,
});
const operation = (opId = 'op-1'): Omit<QueueOperation, 'sequence' | 'scopeKey'> => ({
  opId, batchId: 'batch-1', idempotencyKey: 'idempotency-1', digest: `sha256:${opId}`,
  endpointIdentity: 'syncPush', mediaType: 'application/vnd.collection-protocol.sync+json',
  baseRevision: 'revision-0', operationRevision: 'revision-local-1', status: 'pending',
  retry: { attempt: 0, notBefore: 0 }, payload: { type: 'update_node', targetId: 'node-1' },
});

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

describe('P3-28 indexed access paths', () => {
  test('pages a 10k queue by scope/status/sequence and correlations by compound indexes', async () => {
    const store = createSyncStateStore({ indexedDB }); await active(store);
    const db = await store.open(); const scopeKey = (await store.getScope(scope))!.scopeKey;
    const tx = db.transaction(['outbound_queue', 'durable_sequences'], 'readwrite');
    const queue = tx.objectStore('outbound_queue');
    for (let sequence = 1; sequence <= 10_005; sequence += 1) queue.add({ scopeKey, sequence,
      ...operation(`op-${sequence}`), batchId: `batch-${sequence}`, idempotencyKey: `key-${sequence}` });
    tx.objectStore('durable_sequences').put({ scopeKey, next: 10_006 });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });

    const first = await store.listQueue(scope, 'pending', 0, 1_000);
    const last = await store.listQueue(scope, 'pending', 10_000, 10);
    assert.equal(first.length, 1_000);
    assert.deepEqual(first.map((row) => row.sequence), Array.from({ length: 1_000 }, (_, index) => index + 1));
    assert.deepEqual(last.map((row) => row.sequence), [10_001, 10_002, 10_003, 10_004, 10_005]);

    await store.createApplyIntent(scope, { intentId: 'intent-indexed', correlationId: 'correlation-indexed',
      operationId: 'remote-indexed', expected: { kind: 'change', nativeId: 'native-indexed' }, expiresAt: 1 });
    assert.equal((await store.findApplyIntent(scope, 'correlation-indexed'))?.intentId, 'intent-indexed');

    const source = await readSyncStateSource();
    assert.match(source, /index\(INDEXES\.queueByStatusSequence\)/);
    assert.match(source, /index\(INDEXES\.intentByCorrelation\)/);
    assert.match(source, /index\(INDEXES\.pullEventByPage\)/);
    assert.match(source, /index\(INDEXES\.queueByTargetRevision\)/);
    const complete = source.match(/async function completePullPage[\s\S]*?\n  async function commitApplyIntent/);
    assert.ok(complete);
    assert.match(complete[0]!, /INDEXES\.pullEventByPage/);
    assert.match(complete[0]!, /hasQueueRevisionForTarget/);
    assert.doesNotMatch(complete[0]!, /scopeRowsRange/);
    assert.doesNotMatch(source, /getAll\(\).*filter|objectStore\(STORES\.queue\)\.openCursor\(\)/s);
    assert.equal(10_005 > LARGE_QUEUE_CONTRACT_SIZE, true);
    // Seeding 10k fake-indexeddb rows takes ~3s alone and exceeds the default
    // 5s test timeout under full-suite parallel load; this test asserts index
    // usage, not wall-clock speed.
  }, 60_000);
});

async function active(store: ReturnType<typeof createSyncStateStore>) {
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 100 },
    checkpoint: null, selectedRoots: [] });
}
