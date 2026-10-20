import assert from 'node:assert/strict';
import { IDBDatabase } from 'fake-indexeddb';
import { test, vi } from 'vitest';
import { canonicalOperationDigest } from '@know-n/colp/sync';
import type { Operation, SyncPullEventV02 } from '@know-n/colp/types';
import { digestJson, validateOperation } from '../src/bookmark-event-codec.js';
import { createOutboundPushWorker, type PushSessionController } from '../src/outbound-push-worker.js';
import { createPullApplier } from '../src/pull-applier.js';
import { STORES } from '../src/sync-state/schema.js';
import type { JsonObject } from '../src/sync-state-store.js';
import { scope, setup } from './own-create-replay-harness.js';
import { endpoints } from './outbound-push-worker-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

type Source = 'pending' | 'fallback' | 'canonical';
async function fixture(source: Source) {
  const f = await setup('running', source !== 'fallback');
  let page = f.page;
  if (source === 'fallback') {
    await f.store.deleteMapping(scope, f.node.id);
    const event = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 1, collectionId: scope.collectionId,
      parentId: f.parent.colpId, replicaId: scope.replicaId, opId: 'b3.read-budget.create.native-original' });
    assert.ok(event.kind === 'operation' && event.effect.kind === 'node_created');
    const queued = await f.store.allocateSequenceAndEnqueue(scope, {
      opId: event.operation.opId, batchId: event.operation.opId, idempotencyKey: event.operation.opId,
      digest: 'sha256:pending', endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null,
      operationRevision: `local-${event.operation.opId}`, status: 'pending', retry: { attempt: 0, notBefore: 0 },
      payload: event.operation as unknown as JsonObject,
    }, { validateOperation, digestOperation: digestJson });
    assert.equal(canonicalOperationDigest(queued.payload as unknown as Operation), event.effect.operationDigest);
    assert.equal(await f.store.getMappingByNativeId(scope, f.node.id), null);
    page = pullFixtures.page({ events: [event], nextCursor: 'cursor-next', collectionRevision: 'revision-next' });
  }
  const event = page.events[0] as Extract<SyncPullEventV02, { kind: 'operation' }>;
  assert.ok(event.effect.kind === 'node_created');
  return { ...f, page, event, opId: event.operation.opId, eventId: `${event.cursor}:${event.operation.opId}` };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function losePushResponse(f: Fixture) {
  const sessions: PushSessionController = { get: async () => ({ credential: { accessToken: 'read-budget-token' },
    session: { sessionId: 'read-budget-session', expiresAt: '2099-01-01T00:00:00Z', scope: 'collection',
      snapshotRequired: false, credentialAuthorityDigest: 'a'.repeat(64),
      collection: { collectionId: scope.collectionId, serverCursor: 'cursor-old', serverRevision: 'revision-old' },
      replicaLease: { leaseId: 'lease', generation: String(scope.generation), state: 'active',
        expiresAt: '2099-01-01T00:00:00Z' } } }) };
  let requests = 0;
  await createOutboundPushWorker({ scope, store: f.store, endpoints: async () => endpoints, sessions,
    now: () => 10_000, random: () => 0, ownerId: () => 'read-budget-worker', schedule: () => undefined,
    fetch: async () => { requests++; throw new TypeError('Failed to fetch'); } }).drain();
  assert.equal(requests, 1);
  const row = (await f.store.getQueueByOpId(scope, f.opId))!;
  assert.equal(row.status, 'unknown'); assert.equal(typeof row.attempt?.body, 'string');
  return row;
}

async function prepareAndStop(f: Fixture) {
  const applier = createPullApplier({ ...f.options,
    crash: point => { if (point === 'after_intent') throw new Error('worker_crash'); } });
  await applier.stage(f.page);
  await assert.rejects(applier.resume(), /worker_crash/);
  assert.equal((await f.store.getPullEvent(scope, f.eventId))?.state, 'intent_prepared');
  assert.equal(f.api.calls.filter(call => call.kind === 'create').length, 0);
}

async function mappingReadCount(work: () => Promise<void>) {
  let reads = 0;
  const transaction = IDBDatabase.prototype.transaction;
  const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase,
    ...args: Parameters<typeof transaction>) {
    const names = typeof args[0] === 'string' ? [args[0]] : Array.from(args[0]);
    if ((args[1] ?? 'readonly') === 'readonly' && names.length === 3
        && [STORES.mappings, STORES.pullEvents, STORES.pullPages].every(name => names.includes(name))) reads++;
    return transaction.apply(this, args);
  });
  try { await work(); return reads; } finally { spy.mockRestore(); }
}

const cases = [
  { source: 'pending', started: false, reads: 2 },
  { source: 'pending', started: true, reads: 2 },
  { source: 'fallback', started: false, reads: 3 },
  { source: 'canonical', started: false, reads: 2 },
] as const;
for (const entry of cases) test(`own-create parent reads stay fresh after reopen: ${entry.source}, started=${entry.started}`, async () => {
  const f = await fixture(entry.source);
  try {
    if (entry.source !== 'canonical') await losePushResponse(f);
    await prepareAndStop(f);
    if (entry.source === 'canonical') {
      const lease = await f.store.acquireLease(scope, 'read-budget-receipt', 1, 30_000);
      const row = (await f.store.claimNextQueue(scope, 'read-budget-receipt', lease.fence, 1))!;
      await f.store.settleClaimedPush(scope, row.sequence, 'read-budget-receipt', lease.fence, {
        outcome: 'terminal', receipt: { opId: row.opId, operationDigest: row.digest, kind: 'terminal',
          receiptId: 'read-budget-receipt', resultDigest: 'sha256:receipt', result: { results: [{
            opId: row.opId, sequence: row.sequence, status: 'applied', targetId: f.remote.id, revision: f.remote.revision,
          }] } }, authoritativeCreate: { nativeId: f.node.id, targetId: f.remote.id, revision: f.remote.revision },
      });
      assert.equal((await f.store.getMappingByColpId(scope, f.remote.id))?.nativeId, f.node.id);
    }
    if (entry.started) await f.store.markPullBrowserCallStarted(scope, f.eventId);
    const before = (await f.store.getQueueByOpId(scope, f.opId))!;
    f.store.close();
    const reads = await mappingReadCount(() => createPullApplier(f.options).resume());
    // Count real coherent IDB transactions only during the production resume.
    // Durable provisional hits used to spend a third read on an unused parent.
    // Fallback construction still needs its own read; canonical hits gain none.
    assert.equal(reads, entry.reads);
    assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-next');
    assert.equal((await f.store.getMappingByColpId(scope, f.remote.id))?.nativeId, f.node.id);
    assert.equal((await f.store.getMappingByColpId(scope, f.parent.colpId))?.projection.childrenRevision, 'children-1');
    assert.equal(f.api.calls.filter(call => call.kind === 'create').length, 0);
    assert.deepEqual(await f.store.getQueueByOpId(scope, f.opId), { ...before, echoApplied: true });
    f.store.close();
    assert.deepEqual(await f.store.getQueueByOpId(scope, f.opId), { ...before, echoApplied: true });
    assert.equal((await f.store.getPullEvent(scope, f.eventId))?.state, 'page_complete');
  } finally { f.store.close(); }
});

for (const source of ['pending', 'fallback'] as const) test(`a parent removed during ${source} recovery still refuses without rewriting the unknown request`, async () => {
  const f = await fixture(source);
  try {
    await losePushResponse(f); await prepareAndStop(f);
    const before = await f.store.getQueueByOpId(scope, f.opId);
    let removed = 0;
    const store = { ...f.store, getMappingByColpId: async (...args: Parameters<typeof f.store.getMappingByColpId>) => {
      const mapping = await f.store.getMappingByColpId(...args);
      if (args[1] === `pending-${f.opId}` && !removed) {
        removed++; assert.equal(await f.store.deleteMapping(scope, f.parent.nativeId), true);
      }
      return mapping;
    } };
    f.store.close();
    await assert.rejects(createPullApplier({ ...f.options, store }).resume(), /parent_mapping_missing/);
    assert.equal(removed, 1);
    assert.notEqual((await f.store.getCursor(scope))?.cursor, 'cursor-next');
    assert.equal(f.api.calls.filter(call => call.kind === 'create').length, 0);
    assert.deepEqual(await f.store.getQueueByOpId(scope, f.opId), before);
    assert.equal(await f.store.getQueueReceipt(scope, before!.sequence), null);
  } finally { f.store.close(); }
});

test('a parent updated after provisional lookup is read afresh before projection and publication', async () => {
  const f = await fixture('pending');
  try {
    const before = await losePushResponse(f); await prepareAndStop(f);
    let changed = 0;
    const store = { ...f.store, getMappingByColpId: async (...args: Parameters<typeof f.store.getMappingByColpId>) => {
      const mapping = await f.store.getMappingByColpId(...args);
      if (args[1] === `pending-${f.opId}` && !changed) {
        changed++; await f.store.putMapping(scope, { ...f.parent,
          projection: { ...f.parent.projection, content: { title: 'New parent title' } } });
      }
      return mapping;
    } };
    f.store.close();
    assert.equal(await mappingReadCount(() => createPullApplier({ ...f.options, store }).resume()), 2);
    assert.equal(changed, 1);
    const parent = await f.store.getMappingByColpId(scope, f.parent.colpId);
    assert.equal(parent?.projection.content?.title, 'New parent title');
    assert.equal(parent?.projection.childrenRevision, 'children-1');
    assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-next');
    assert.equal(f.api.calls.filter(call => call.kind === 'create').length, 0);
    assert.deepEqual(await f.store.getQueueByOpId(scope, f.opId), { ...before, echoApplied: true });
  } finally { f.store.close(); }
});
