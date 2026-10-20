import assert from 'node:assert/strict';
import { IDBDatabase } from 'fake-indexeddb';
import { test, vi } from 'vitest';
import { canonicalAuthoritativeEffectDigest, canonicalOperationDigest } from '@know-n/colp/sync';
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

for (const source of ['pending', 'fallback'] as const) for (const started of [false, true]) {
  test(`a missing parent during ${source} recovery follows the durable phase: started=${started}`, async () => {
    const f = await fixture(source);
    try {
      await losePushResponse(f); await prepareAndStop(f);
      if (started) await f.store.markPullBrowserCallStarted(scope, f.eventId);
      const before = await f.store.getQueueByOpId(scope, f.opId); assert.ok(before);
      let removed = 0;
      const store = { ...f.store, getMappingByColpId: async (...args: Parameters<typeof f.store.getMappingByColpId>) => {
        const mapping = await f.store.getMappingByColpId(...args);
        if (args[1] === `pending-${f.opId}` && !removed) {
          removed++; assert.equal(await f.store.deleteMapping(scope, f.parent.nativeId), true);
          assert.equal(await f.store.getCurrentPullMapping(scope, f.parent.colpId), null);
        }
        return mapping;
      } };
      f.store.close();
      const applier = createPullApplier({ ...f.options, store });
      if (started) {
        await assert.rejects(applier.resume(), /parent_mapping_missing/);
        assert.notEqual((await f.store.getCursor(scope))?.cursor, 'cursor-next');
      } else {
        // Before invocation, the item is durably accounted for without native work.
        // Page completion marks its echo; it does not settle the unknown Push.
        await applier.resume();
        assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-next');
      }
      assert.equal(removed, 1);
      assert.equal(await f.store.getCurrentPullMapping(scope, f.parent.colpId), null);
      assert.equal(f.api.calls.filter(call => call.kind === 'create').length, 0);
      assert.equal(await f.store.getMappingByColpId(scope, f.remote.id), null);
      const issues = await f.store.listPullIssues(scope);
      assert.deepEqual(issues.map(issue => [issue.code, issue.nodeId, issue.eventId, issue.count]),
        started ? [] : [['parent_mapping_missing', f.remote.id, f.eventId, 1]]);
      const expectedQueue = started ? before : { ...before, echoApplied: true };
      assert.deepEqual(await f.store.getQueueByOpId(scope, f.opId), expectedQueue);
      assert.equal(await f.store.getQueueReceipt(scope, before.sequence), null);
      f.store.close();
      assert.deepEqual(await f.store.listPullIssues(scope), issues);
      assert.equal((await f.store.getPullEvent(scope, f.eventId))?.state,
        started ? 'browser_call_started' : 'page_complete');
      assert.equal(await f.store.getCurrentPullMapping(scope, f.parent.colpId), null);
      assert.deepEqual(await f.store.getQueueByOpId(scope, f.opId), expectedQueue);
      assert.equal(await f.store.getQueueReceipt(scope, before.sequence), null);
    } finally { f.store.close(); }
  });
}

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

for (const collision of ['native', 'canonical'] as const) {
  test(`fallback replay rechecks ${collision} identity after its deferred parent read`, async () => {
    const f = await fixture('fallback');
    try {
      const queued = await losePushResponse(f); await prepareAndStop(f);
      if (collision === 'canonical') f.api.seed({ ...f.node, id: 'other-native', index: 1 });
      const nativeBefore = await f.api.get(f.node.id);
      let armed = false, raced = 0;
      let inserted: Awaited<ReturnType<typeof f.store.getMappingByNativeId>> = null;
      const store = { ...f.store,
        getMappingByColpId: async (...args: Parameters<typeof f.store.getMappingByColpId>) => {
          const mapping = await f.store.getMappingByColpId(...args);
          if (args[1] === `pending-${f.opId}`) armed = true;
          return mapping;
        },
        getCurrentPullMapping: async (...args: Parameters<typeof f.store.getCurrentPullMapping>) => {
          const parent = await f.store.getCurrentPullMapping(...args);
          if (armed && args[1] === f.parent.colpId && !raced) {
            raced++;
            const mapping = { ...f.original,
              nativeId: collision === 'native' ? f.node.id : 'other-native',
              colpId: collision === 'native' ? 'other-canonical' : f.remote.id };
            await f.store.putMapping(scope, mapping);
            inserted = await f.store.getMappingByNativeId(scope, mapping.nativeId);
          }
          return parent;
        },
      };
      f.store.close();
      // Capture the reopened facts after normal schema migration, before replay.
      const eventBefore = await f.store.getPullEvent(scope, f.eventId);
      const intentBefore = await f.store.getApplyIntent(scope, `intent:${f.eventId}`);
      assert.equal(eventBefore?.state, 'intent_prepared'); assert.equal(intentBefore?.apiResultEvidence, null);
      await assert.rejects(createPullApplier({ ...f.options, store }).resume(), /mapping_identity_collision/);
      assert.equal(raced, 1); assert.ok(inserted);
      assert.deepEqual(await f.store.getPullEvent(scope, f.eventId), eventBefore);
      assert.deepEqual(await f.store.getApplyIntent(scope, `intent:${f.eventId}`), intentBefore);
      assert.notEqual((await f.store.getCursor(scope))?.cursor, 'cursor-next');
      assert.equal(f.api.calls.filter(call => call.kind === 'create').length, 0);
      assert.deepEqual(await f.api.get(f.node.id), nativeBefore);
      assert.deepEqual(await f.store.getQueueByOpId(scope, f.opId), queued);
      assert.equal(await f.store.getQueueReceipt(scope, queued.sequence), null);
      f.store.close();
      assert.deepEqual(await f.store.getMappingByNativeId(scope,
        collision === 'native' ? f.node.id : 'other-native'), inserted);
      assert.deepEqual(await f.store.getPullEvent(scope, f.eventId), eventBefore);
      assert.deepEqual(await f.store.getApplyIntent(scope, `intent:${f.eventId}`), intentBefore);
      assert.deepEqual(await f.store.getQueueByOpId(scope, f.opId), queued);
      assert.equal(await f.store.getQueueReceipt(scope, queued.sequence), null);
    } finally { f.store.close(); }
  });
}

async function laterSelfCreateFixture() {
  const f = await fixture('canonical');
  const lease = await f.store.acquireLease(scope, 'earlier-create', 1, 1);
  const earlier = (await f.store.claimNextQueue(scope, 'earlier-create', lease.fence, 1))!;
  await f.store.settleClaimedPush(scope, earlier.sequence, 'earlier-create', lease.fence, {
    outcome: 'terminal', receipt: { opId: earlier.opId, operationDigest: earlier.digest, kind: 'terminal',
      receiptId: 'earlier-create', resultDigest: 'sha256:earlier-create', result: { results: [{
        opId: earlier.opId, sequence: earlier.sequence, status: 'applied', targetId: f.remote.id,
        revision: f.remote.revision,
      }] } }, authoritativeCreate: { nativeId: f.node.id, targetId: f.remote.id, revision: f.remote.revision },
  });
  const earlierReceipt = await f.store.getQueueReceipt(scope, earlier.sequence); assert.ok(earlierReceipt);
  const source = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 2, collectionId: scope.collectionId,
    parentId: f.parent.colpId, replicaId: scope.replicaId, opId: 'b3.read-binding.create.native-later' });
  assert.ok(source.kind === 'operation' && source.operation.type === 'create_node' && source.effect.kind === 'node_created');
  const remote = source.effect.node; assert.ok(remote.kind === 'bookmark' && typeof remote.url === 'string');
  const node = { ...f.node, id: 'native-later', index: 1, title: remote.title, url: remote.url }; f.api.seed(node);
  const original = { ...f.original, nativeId: node.id, colpId: `pending-${source.operation.opId}`,
    projection: { ...f.original.projection, content: { title: node.title, url: node.url } } };
  await f.store.stageBookmarkEvent(scope, { eventId: 'later-create-callback', nativeId: node.id, kind: 'create',
    occurredAt: source.operation.occurredAt, dedupeKey: 'later-create-callback', details: {} });
  await f.store.commitBookmarkEvent(scope, 'later-create-callback', {
    operation: source.operation as unknown as JsonObject, baseRevision: null,
    operationRevision: 'local-later-create', mapping: original,
    allocateOperationId: () => source.operation.opId, validateOperation, digestOperation: digestJson,
  });
  const later = (await f.store.getQueueByOpId(scope, source.operation.opId))!;
  assert.equal(later.sequence, 2);
  assert.equal(canonicalOperationDigest(later.payload as unknown as Operation), source.effect.operationDigest);
  const page = pullFixtures.page({ events: [source], nextCursor: 'cursor-next', collectionRevision: 'revision-next' });
  const event = page.events[0] as Extract<SyncPullEventV02, { kind: 'operation' }>;
  return { ...f, node, original, remote, page, event, opId: event.operation.opId,
    eventId: `${event.cursor}:${event.operation.opId}`, earlierReceipt, earlierSequence: earlier.sequence };
}

for (const mismatch of ['older_sequence', 'different_payload'] as const) {
  test(`lost provisional mapping refuses a ${mismatch} response bound to an unknown create`, async () => {
    const f = await laterSelfCreateFixture();
    try {
      const queued = await losePushResponse(f);
      assert.ok(f.event.operation.type === 'create_node' && f.event.effect.kind === 'node_created');
      const title = 'Different echoed title';
      const operation = mismatch === 'older_sequence' ? { ...f.event.operation, sequence: 1 }
        : { ...f.event.operation, payload: { ...f.event.operation.payload,
          node: { ...f.event.operation.payload.node, title } } };
      const effect = { ...f.event.effect, sequence: operation.sequence, operationDigest: canonicalOperationDigest(operation),
        node: mismatch === 'different_payload' ? { ...f.event.effect.node, title } : f.event.effect.node };
      const response = { ...f.event, operation, effect: { ...effect,
        effectDigest: canonicalAuthoritativeEffectDigest(effect) } };
      const page = pullFixtures.page({ events: [response], nextCursor: 'cursor-next', collectionRevision: 'revision-next' });
      const event = page.events[0] as Extract<SyncPullEventV02, { kind: 'operation' }>;
      // These responses have internally valid digests; they do not match the actual request.
      // A prepared provisional projection can survive a crash before its mapping is lost.
      if (mismatch === 'different_payload') await f.api.update(f.node.id, { title });
      assert.equal(queued.sequence, 2);
      assert.notEqual(canonicalOperationDigest(queued.payload as unknown as Operation), effect.operationDigest);
      await prepareAndStop({ ...f, page, event });
      assert.equal(await f.store.deleteMapping(scope, f.node.id), true);
      const nativeBefore = await f.api.get(f.node.id);
      f.store.close();
      const eventBefore = await f.store.getPullEvent(scope, f.eventId);
      const intentBefore = await f.store.getApplyIntent(scope, `intent:${f.eventId}`);
      assert.equal(eventBefore?.state, 'intent_prepared'); assert.equal(intentBefore?.apiResultEvidence, null);
      await assert.rejects(createPullApplier(f.options).resume(), /pull_source_binding_invalid/);
      assert.notEqual((await f.store.getCursor(scope))?.cursor, 'cursor-next');
      assert.equal(f.api.calls.filter(call => call.kind === 'create').length, 0);
      assert.deepEqual(await f.api.get(f.node.id), nativeBefore);
      assert.deepEqual(await f.store.getPullEvent(scope, f.eventId), eventBefore);
      assert.deepEqual(await f.store.getApplyIntent(scope, `intent:${f.eventId}`), intentBefore);
      assert.deepEqual(await f.store.getQueueByOpId(scope, f.opId), queued);
      assert.equal(await f.store.getQueueReceipt(scope, queued.sequence), null);
      f.store.close();
      assert.equal(await f.store.getMappingByNativeId(scope, f.node.id), null);
      assert.deepEqual(await f.store.getPullEvent(scope, f.eventId), eventBefore);
      assert.deepEqual(await f.store.getApplyIntent(scope, `intent:${f.eventId}`), intentBefore);
      assert.deepEqual(await f.store.getQueueByOpId(scope, f.opId), queued);
      assert.equal(await f.store.getQueueReceipt(scope, queued.sequence), null);
      assert.deepEqual(await f.store.getQueueReceipt(scope, f.earlierSequence), f.earlierReceipt);
    } finally { f.store.close(); }
  });
}

for (const mismatch of ['older_sequence', 'different_payload'] as const) {
  test(`retained provisional mapping refuses a ${mismatch} response before publishing identity`, async () => {
    const f = await laterSelfCreateFixture();
    try {
      const queued = await losePushResponse(f);
      assert.ok(f.event.operation.type === 'create_node' && f.event.effect.kind === 'node_created');
      const title = 'Different echoed title';
      const operation = mismatch === 'older_sequence' ? { ...f.event.operation, sequence: 1 }
        : { ...f.event.operation, payload: { ...f.event.operation.payload,
          node: { ...f.event.operation.payload.node, title } } };
      const effect = { ...f.event.effect, sequence: operation.sequence,
        operationDigest: canonicalOperationDigest(operation),
        node: mismatch === 'different_payload' ? { ...f.event.effect.node, title } : f.event.effect.node };
      const response = { ...f.event, operation, effect: { ...effect,
        effectDigest: canonicalAuthoritativeEffectDigest(effect) } };
      const page = pullFixtures.page({ events: [response], nextCursor: 'cursor-next',
        collectionRevision: 'revision-next' });
      // The response is internally valid but contradicts the actual unknown request.
      // Keep the provisional mapping: its presence must not weaken source binding.
      if (mismatch === 'different_payload') await f.api.update(f.node.id, { title });
      assert.equal(queued.sequence, 2);
      assert.notEqual(canonicalOperationDigest(queued.payload as unknown as Operation), effect.operationDigest);
      const mappingBefore = await f.store.getMappingByNativeId(scope, f.node.id);
      assert.equal(mappingBefore?.colpId, `pending-${f.opId}`);
      const cursorBefore = await f.store.getCursor(scope);
      const nativeBefore = await f.api.get(f.node.id);
      const mutationCount = f.api.calls.length;
      f.store.close();
      let refusal: unknown;
      let boundary = 'stage';
      try {
        const applier = createPullApplier({ ...f.options, crash: point => {
          if (point === 'after_intent') throw new Error('pending_binding_review_crash');
        } });
        await applier.stage(page);
        boundary = 'prepare';
        try { await applier.resume(); } catch (error) {
          if (!(error instanceof Error) || error.message !== 'pending_binding_review_crash') throw error;
        }
        f.store.close();
        boundary = 'reopen_resume';
        await createPullApplier(f.options).resume();
      } catch (error) { refusal = error; }
      f.store.close();
      const mappingAfter = await f.store.getMappingByNativeId(scope, f.node.id);
      const canonical = await f.store.getMappingByColpId(scope, f.remote.id);
      const after = await f.store.getQueueByOpId(scope, f.opId);
      const cursorAfter = await f.store.getCursor(scope);
      const eventAfter = await f.store.getPullEvent(scope, f.eventId);
      // Report the final observable state together; a missing rejection alone
      // would not demonstrate whether a wrong identity or echo was published.
      assert.deepEqual({
        refusal: refusal instanceof Error ? refusal.message : null,
        colpId: mappingAfter?.colpId ?? null,
        canonicalNativeId: canonical?.nativeId ?? null,
        echoApplied: after?.echoApplied ?? false,
        cursor: cursorAfter?.cursor ?? null,
        published: eventAfter?.state === 'page_complete',
        apiEvidence: eventAfter?.apiResultEvidence ?? null,
      }, {
        refusal: 'pull_source_binding_invalid',
        colpId: mappingBefore?.colpId ?? null,
        canonicalNativeId: null,
        echoApplied: queued.echoApplied ?? false,
        cursor: cursorBefore?.cursor ?? null,
        published: false,
        apiEvidence: null,
      }, JSON.stringify({ boundary, eventState: eventAfter?.state ?? null, queueState: after?.status ?? null }));
      assert.deepEqual(mappingAfter, mappingBefore);
      assert.deepEqual(after, queued);
      assert.deepEqual(cursorAfter, cursorBefore);
      assert.notEqual(eventAfter?.state, 'page_complete');
      assert.equal(eventAfter?.apiResultEvidence ?? null, null);
      assert.equal(f.api.calls.length, mutationCount);
      assert.deepEqual(await f.api.get(f.node.id), nativeBefore);
      assert.equal(await f.store.getQueueReceipt(scope, queued.sequence), null);
      assert.deepEqual(await f.store.getQueueReceipt(scope, f.earlierSequence), f.earlierReceipt);
    } finally { f.store.close(); }
  });
}
