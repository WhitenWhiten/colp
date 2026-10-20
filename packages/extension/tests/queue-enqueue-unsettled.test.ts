import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test } from 'vitest';
import { digestJson } from '../src/bookmark-event-codec.js';
import { createSyncStateStore, type JsonObject, type QueueOperation, type SyncScope } from '../src/sync-state-store.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { fixture, success } from './outbound-push-batch-harness.js';
import { scope as pushScope } from './outbound-push-worker-harness.js';

const scope: SyncScope = { environment: 'production', serverId: 'enqueue-test', serverOrigin: 'https://known.example',
  accountId: 'account', browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 };
function operation(opId: string, payload: JsonObject): Omit<QueueOperation, 'scopeKey' | 'sequence'> {
  return { opId, batchId: opId, idempotencyKey: opId, digest: digestJson(payload), endpointIdentity: 'syncPush',
    mediaType: 'application/json', baseRevision: 'r1', operationRevision: `local-${opId}`, status: 'pending',
    retry: { attempt: 0, notBefore: 0 }, payload };
}
const states = ['claimed-before-attempt', 'claimed-with-attempt', 'unknown', 'deferred', 'pending-after-gap', 'reclaimed'] as const;

for (const identity of ['canonical-target', 'provisional-create'] as const) test.each(states)(
  `${identity}: %s still protects its subject after reopen while an independent edit is admitted`, async state => {
    const factory = new IDBFactory(); let store = createSyncStateStore({ indexedDB: factory });
    try {
      await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'server', expiresAt: 100_000 },
        checkpoint: null, selectedRoots: [] });
      const payload: JsonObject = identity === 'canonical-target'
        ? { type: 'update_node_content', targetId: 'folder-awaiting', payload: { value: { title: 'Changed' } } }
        : { type: 'create_node', payload: { parentId: 'root', node: { kind: 'folder', title: 'New parent' } } };
      const original = await store.allocateSequenceAndEnqueue(scope, operation('original', payload), { allowUnstamped: true });
      const lease = await store.acquireLease(scope, 'worker', 100, 1_000);
      await store.claimQueue(scope, 'worker', lease.fence, 100, original.sequence);
      if (state !== 'claimed-before-attempt') await store.bindPushAttempt(scope, original.sequence, 'worker', lease.fence, {
        sessionId: 'session', batchId: 'batch', idempotencyKey: 'exact-key', endpointIdentity: 'syncPush',
        mediaType: 'application/json', body: JSON.stringify({ sessionId: 'session', batchId: 'batch', operations: [payload] }),
        bodyDigest: 'sha256:original-attempt',
      });
      if (state === 'unknown') await store.settleClaimedPush(scope, original.sequence, 'worker', lease.fence, {
        outcome: 'unknown', retry: { attempt: 1, notBefore: 1_000 }, recovery: { code: 'network_unavailable' },
      });
      if (state === 'deferred') await store.settleClaimedPush(scope, original.sequence, 'worker', lease.fence, {
        outcome: 'deferred', retry: { attempt: 1, notBefore: 1_000 }, receipt: { kind: 'deferred',
          opId: original.opId, operationDigest: original.digest, receiptId: 'deferred', resultDigest: 'sha256:deferred' },
      });
      if (state === 'pending-after-gap') {
        await store.settleClaimedPush(scope, original.sequence, 'worker', lease.fence, {
          outcome: 'gap', retry: { attempt: 1, notBefore: 100 },
          recovery: { code: 'sequence_gap', expectedSequence: original.sequence },
        });
        expect(await store.realignQueueAfterGap(scope, 'worker', lease.fence, 100, digestJson))
          .toEqual({ realigned: true, mode: 'resume_at_expected' });
        expect((await store.getQueueByOpId(scope, original.opId))?.status).toBe('pending');
      }
      if (state === 'reclaimed') {
        const replacement = await store.acquireLease(scope, 'replacement', 2_000, 1_000);
        expect((await store.claimNextQueue(scope, 'replacement', replacement.fence, 2_000))?.opId).toBe(original.opId);
      }
      const protectedRow = await store.getQueueByOpId(scope, original.opId);
      store.close(); store = createSyncStateStore({ indexedDB: factory });
      const target = identity === 'canonical-target' ? 'folder-awaiting' : 'pending-original';
      for (const [id, payload] of [
        ['same-target', { type: 'update_node_content', targetId: target }],
        ['child', { type: 'create_node', payload: { parentId: target } }],
        ['move-child', { type: 'move_node', targetId: 'unrelated-child', payload: { newParentId: target } }],
      ] as const) await expect(store.allocateSequenceAndEnqueue(scope, operation(id, payload), { allowUnstamped: true }))
        .rejects.toThrow('exact_retry_pending');
      const independent = await store.allocateSequenceAndEnqueue(scope,
        operation('independent', { type: 'delete_node', targetId: 'unrelated' }), { allowUnstamped: true });
      expect(independent.sequence).toBe(original.sequence + 1);
      expect(await store.getQueueByOpId(scope, original.opId)).toEqual(protectedRow);
      expect((await store.listQueue(scope)).map(row => row.opId)).toEqual(['original', 'independent']);
    } finally { store.close(); }
  });

test('a partially committed batch keeps every uncertain provisional parent protected after worker restart', async () => {
  const f = await fixture(4); let sent = 0; const applied = new Set<string>();
  try {
    expect((await createOutboundPushWorker({ ...f.options, fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body)); sent += request.operations.length;
      for (const row of request.operations.slice(0, 2)) applied.add(row.opId);
      // The external server applied a prefix, then lost the response. The local
      // producer must preserve every singleton retry until receipts prove it.
      throw new TypeError('lost response after partial server commit');
    } }).drain()).outcome).toBe('unknown');
    expect(sent).toBe(4);
    const before = await f.store.listQueue(pushScope, 'unknown');
    expect(before).toHaveLength(4);
    expect(before.every(row => row.attempt && JSON.parse(row.attempt.body).operations.length === 1)).toBe(true);
    f.store.close();
    const reopened = createSyncStateStore({ indexedDB: f.factory });
    try {
      for (const row of before) await expect(reopened.allocateSequenceAndEnqueue(pushScope,
        operation(`dependent-${row.sequence}`, { type: 'create_node', payload: { parentId: `pending-${row.opId}` } }),
        { allowUnstamped: true })).rejects.toThrow('exact_retry_pending');
      expect(await reopened.listQueue(pushScope, 'unknown')).toEqual(before);
      f.clock.now += 60_000;
      const requests: string[] = [];
      expect((await createOutboundPushWorker({ ...f.options, store: reopened, fetch: async (_url, init) => {
        const body = String(init?.body), request = JSON.parse(body);
        expect(request.operations).toHaveLength(1);
        requests.push(body); applied.add(request.operations[0].opId); return success(body);
      } }).drain()).outcome).toBe('terminal');
      expect(requests).toEqual(before.map(row => row.attempt!.body));
      expect(applied.size).toBe(4);
      expect(await reopened.listQueue(pushScope, 'terminal')).toHaveLength(4);
      expect(await reopened.listMappings(pushScope)).toHaveLength(4);
    } finally { reopened.close(); }
  } finally { f.store.close(); }
});
