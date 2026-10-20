import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { canonicalAuthoritativeEffectDigest, canonicalOperationDigest } from '@know-n/colp/sync';
import type { Operation } from '@know-n/colp/types';
import { test } from 'vitest';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { createPullApplier } from '../src/pull-applier.js';
import { createSyncStateStore } from '../src/sync-state-store.js';
import { indexedDB, installKns05IndexedDb, scope } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { rejoinFixture } from './rejoin-recovery-harness.js';

installKns05IndexedDb();

test('a terminal self-delete recovers a pre-event crash after its native and captured details are gone', async () => {
  const f = await rejoinFixture(); let store = f.store;
  try {
    const node = (await f.eventApi.get('native-node'))[0]!;
    await f.api.remove(node.id);
    const captured = await f.queue.removed(node.id, { parentId: 'native-root', index: 0, node });
    assert.equal(captured.outcome, 'staged');
    await f.queue.flush();
    const queued = (await store.listQueue(scope))[0]!;
    assert.equal(queued.payload.type, 'delete_node');
    assert.equal(await store.getMappingByNativeId(scope, node.id), null);
    const operation = queued.payload as unknown as Operation;
    const template = pullFixtures.mutationEvent({ kind: 'delete', sequence: queued.sequence,
      collectionId: scope.collectionId, parentId: 'root-colp', targetId: 'node-1', replicaId: scope.replicaId });
    assert.ok(template.kind === 'operation' && template.effect.kind === 'node_deleted');
    const effect = { ...template.effect, effectId: operation.opId, opId: operation.opId,
      operationDigest: canonicalOperationDigest(operation),
      deletion: { ...template.effect.deletion, operationId: operation.opId },
      tombstone: { ...template.effect.tombstone, operationId: operation.opId } };
    effect.effectDigest = canonicalAuthoritativeEffectDigest(effect);
    const event = { ...template, operation, effect };
    let pushes = 0;
    const pushUrl = `${scope.serverOrigin}/v1/push`;
    const worker = createOutboundPushWorker({ store, scope, ownerId: () => 'self-delete-crash-test',
      endpoints: async () => ({ syncPush: pushUrl, syncSessions: `${scope.serverOrigin}/v1/session`,
        syncSnapshot: `${scope.serverOrigin}/v1/snapshot`, syncPull: `${scope.serverOrigin}/v1/pull`,
        syncAck: `${scope.serverOrigin}/v1/ack`, syncConflict: `${scope.serverOrigin}/v1/conflicts/{conflictId}`,
        syncRetire: `${scope.serverOrigin}/v1/retire`,
        syncEffectPages: `${scope.serverOrigin}/v1/effects/{effectId}/pages/{pageNumber}`,
        effectPageAuthority: scope.serverOrigin }),
      sessions: { async get() { return { credential: { accessToken: 'fixture-access' }, session: {
        sessionId: 'self-delete-session', expiresAt: '2099-01-01T00:00:00Z', scope: 'collection' as const,
        snapshotRequired: false, credentialAuthorityDigest: 'a'.repeat(64),
        collection: { collectionId: scope.collectionId, serverCursor: 'cursor-old', serverRevision: 'revision-old' },
        replicaLease: { leaseId: 'lease-kns05', generation: '1', state: 'active' as const, expiresAt: '2099-01-01T00:00:00Z' },
      } }; } }, fetch: async (url, init) => {
        assert.equal(String(url), pushUrl); assert.equal(init?.method, 'POST');
        const body = JSON.parse(String(init.body));
        assert.deepEqual(body.operations, [queued.payload]); pushes += 1;
        return new Response(JSON.stringify({ batchId: body.batchId, results: [{ opId: queued.opId,
          sequence: queued.sequence, status: 'applied', targetId: 'node-1', revision: effect.tombstone.deleteRevision,
          cursor: event.cursor, warnings: [] }], serverCursor: event.cursor }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      } });
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.equal(pushes, 1);
    const receipt = (await store.exportScope(scope)).receipts;
    assert.equal(receipt.length, 1);
    assert.equal(receipt[0]?.kind, 'terminal');

    // Idle compaction legitimately forgets the old callback details. The
    // terminal Push record must still prove this later Pull deletion is ours.
    assert.equal((await store.compactScope(scope)).compactedEvents, 1);
    assert.deepEqual((await store.getBookmarkEvent(scope, captured.eventId!))?.details, { compacted: true });
    const beforeQueue = (await store.listQueue(scope))[0]!;
    const beforeCursor = await store.getCursor(scope);
    const beforeCalls = structuredClone(f.api.calls);
    let crashed = false;
    const applier = createPullApplier({ ...f.options, crash: at => {
      if (at === 'before_event' && !crashed) { crashed = true; throw new Error('worker_crash'); }
    } });
    await applier.stage(f.page([event]));
    await assert.rejects(applier.resume(), /worker_crash/);
    assert.equal(crashed, true);
    const interrupted = await store.exportScope(scope);
    assert.equal(interrupted.pullEvents.length, 1);
    assert.equal(interrupted.pullEvents[0]?.state, 'browser_call_started');
    assert.equal(interrupted.intents[0]?.state, 'browser_call_started');
    assert.equal(interrupted.pullPages[0]?.state, 'staged');
    assert.deepEqual(await store.getCursor(scope), beforeCursor);
    assert.deepEqual(f.api.calls, beforeCalls);

    store.close(); store = createSyncStateStore({ indexedDB });
    const restarted = createPullApplier({ ...f.options, store, crash: undefined });
    await restarted.resume(); await restarted.resume();
    const complete = await store.exportScope(scope);
    assert.equal(f.api.getNode(node.id), undefined);
    assert.deepEqual(f.api.calls, beforeCalls, 'neither recovery attempts a Chrome write for the already removed node');
    assert.deepEqual((await f.api.getChildren('native-root')).map(row => row.id), ['native-child']);
    assert.equal(await store.getMappingByColpId(scope, 'node-1'), null);
    assert.equal((await store.getMappingByNativeId(scope, 'native-root'))?.projection.childrenRevision,
      effect.parentRevision.childrenRevision);
    assert.equal(complete.cursor?.cursor, 'cursor-next');
    assert.equal(complete.pullPages[0]?.state, 'page_complete');
    assert.equal(complete.pullEvents[0]?.state, 'page_complete');
    assert.equal(complete.intents[0]?.state, 'page_complete');
    assert.deepEqual(complete.receipts, receipt, 'Pull never rewrites the terminal Push receipt');
    const afterQueue = (await store.listQueue(scope))[0]!;
    assert.equal(afterQueue.status, 'terminal'); assert.equal(afterQueue.echoApplied, true);
    assert.deepEqual(afterQueue, { ...beforeQueue, echoApplied: true });
    assert.deepEqual(await store.listPullIssues(scope), []);
    assert.notEqual((await store.getEngineState(scope))?.recoveryFrozen, true);
    assert.equal(pushes, 1);
  } finally { store.close(); }
});
