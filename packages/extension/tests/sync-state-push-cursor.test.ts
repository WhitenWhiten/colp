import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { createSyncStateStore, type QueueOperation, type SyncScope } from '../src/sync-state-store.js';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
  replicaId: 'replica-a', generation: 1,
});
const operation = (opId: string): Omit<QueueOperation, 'sequence' | 'scopeKey'> => ({
  opId, batchId: 'batch-1', idempotencyKey: 'idempotency-1', digest: `sha256:${opId}`,
  endpointIdentity: 'syncPush', mediaType: 'application/vnd.collection-protocol.sync+json',
  baseRevision: 'revision-0', operationRevision: 'revision-local-1', status: 'pending',
  retry: { attempt: 0, notBefore: 0 }, payload: { type: 'update_node', targetId: 'node-1' },
});

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

async function active(store: ReturnType<typeof createSyncStateStore>) {
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 100 },
    checkpoint: null, selectedRoots: [] });
}

describe('F023 push receipt cursor isolation', () => {
  test('push receipts feed lastPushServerCursor and never the Pull/Ack cursor fields', async () => {
    const store = createSyncStateStore({ indexedDB }); await active(store);
    // lastAckedCursor deliberately equals the incoming push receipt cursor: a push
    // settlement must never make `lastPublishedCursor === lastAckedCursor` true.
    await store.transitionEngine(scope, { phase: 'sleeping', updatedAt: 100, recoveryFrozen: false,
      authorityRefreshRequired: false, notBefore: 0, lastAckedCursor: 'cursor-push-1' });
    const settlePush = async (opId: string, outcome: 'terminal' | 'deferred', serverCursor: string) => {
      const queued = await store.allocateSequenceAndEnqueue(scope, operation(opId), { allowUnstamped: true });
      const lease = await store.acquireLease(scope, 'owner-1', 100, 1_000);
      assert.equal(lease.outcome, 'acquired');
      await store.claimQueue(scope, 'owner-1', lease.fence, 100, queued.sequence);
      await store.settleClaimedPush(scope, queued.sequence, 'owner-1', lease.fence, { outcome,
        ...(outcome === 'deferred' ? { retry: { attempt: 1, notBefore: 100 } } : {}),
        receipt: { opId: queued.opId, operationDigest: queued.digest, kind: outcome === 'deferred' ? 'deferred' : 'terminal',
          receiptId: `receipt-${opId}`, resultDigest: `sha256:${opId}`,
          result: { batchId: 'batch-1', results: [{ opId: queued.opId, sequence: queued.sequence,
            status: outcome === 'deferred' ? 'deferred' : 'applied', targetId: 'node-1',
            revision: 'server-1', cursor: serverCursor, warnings: [] }], serverCursor } } });
    };

    await settlePush('push-terminal', 'terminal', 'cursor-push-1');
    let engine = await store.getEngineState(scope);
    assert.equal(engine?.lastPushServerCursor, 'cursor-push-1');
    assert.equal(engine?.lastPublishedCursor, undefined);
    assert.equal(engine?.lastAckedCursor, 'cursor-push-1');
    // The convergence projection reads `lastPublishedCursor === lastAckedCursor`:
    // with no Pull/Ack cursor this must stay false even though the values could collide.
    assert.equal(engine?.lastPublishedCursor === engine?.lastAckedCursor, false);

    await settlePush('push-deferred', 'deferred', 'cursor-push-2');
    engine = await store.getEngineState(scope);
    assert.equal(engine?.lastPushServerCursor, 'cursor-push-2');
    assert.equal(engine?.lastPublishedCursor, undefined);
    store.close();
  });

  test('sentinel serverCursors are outcome hints, never cursor fields', async () => {
    const store = createSyncStateStore({ indexedDB }); await active(store);
    await store.transitionEngine(scope, { phase: 'sleeping', updatedAt: 100, recoveryFrozen: false,
      authorityRefreshRequired: false, notBefore: 0, lastPublishedCursor: 'cursor-pull-1',
      lastAckedCursor: 'cursor-pull-1', lastPushServerCursor: 'cursor-push-9' });
    const settle = async (opId: string, serverCursor: string) => {
      const queued = await store.allocateSequenceAndEnqueue(scope, operation(opId), { allowUnstamped: true });
      const lease = await store.acquireLease(scope, 'owner-1', 100, 1_000);
      assert.equal(lease.outcome, 'acquired');
      await store.claimQueue(scope, 'owner-1', lease.fence, 100, queued.sequence);
      await store.settleClaimedPush(scope, queued.sequence, 'owner-1', lease.fence, { outcome: 'terminal',
        receipt: { opId: queued.opId, operationDigest: queued.digest, kind: 'terminal',
          receiptId: `receipt-${opId}`, resultDigest: `sha256:${opId}`,
          result: { batchId: 'batch-1', results: [{ opId: queued.opId, sequence: queued.sequence,
            status: 'applied', targetId: 'node-1', revision: 'server-1', cursor: serverCursor,
            warnings: [] }], serverCursor } } });
    };

    // 'repair' (sequence-reuse repair receipt) and 'sync-unchanged' (server's
    // no-stream-advance receipt) must not overwrite a real push cursor and must
    // never reach the Pull/Ack convergence pair.
    await settle('push-repair', 'repair');
    let engine = await store.getEngineState(scope);
    assert.equal(engine?.lastPushOutcomeHint, 'repair');
    assert.equal(engine?.lastPushServerCursor, 'cursor-push-9');
    assert.equal(engine?.lastPublishedCursor, 'cursor-pull-1');
    assert.equal(engine?.lastAckedCursor, 'cursor-pull-1');

    await settle('push-unchanged', 'sync-unchanged');
    engine = await store.getEngineState(scope);
    assert.equal(engine?.lastPushOutcomeHint, 'sync-unchanged');
    assert.equal(engine?.lastPushServerCursor, 'cursor-push-9');
    assert.equal(engine?.lastPublishedCursor, 'cursor-pull-1');
    store.close();
  });
});
