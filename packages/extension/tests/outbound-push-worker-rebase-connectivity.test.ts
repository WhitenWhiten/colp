import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { createOutboundPushWorker, type PushSessionController } from '../src/outbound-push-worker.js';
import { createSyncStateStore, type JsonObject } from '../src/sync-state-store.js';
import {
  ack, json as engineJson, networkFailure, pullPage, scope as engineScope, setup as setupEngine,
} from './durable-sync-engine-harness.js';
import {
  endpoints, indexedDB, installOutboundPushIndexedDb, json, operation, problem, scope, setup, setupMove,
} from './outbound-push-worker-harness.js';

installOutboundPushIndexedDb();

describe('KNS-04 move rebase Pull before retry', () => {
  test('retried move_node Pulls before drain and leaves sleeping when connectivity is back', async () => {
    const fixture = await setupEngine();
    await fixture.store.allocateSequenceAndEnqueue(engineScope, {
      opId: 'op-move-retry-1', batchId: 'batch-move-retry-1', idempotencyKey: 'key-move-retry-1',
      digest: 'sha256:move-retry-1', endpointIdentity: 'syncPush', mediaType: 'application/json',
      baseRevision: 'node-r1', operationRevision: 'local-move-retry-1', status: 'pending',
      retry: { attempt: 1, notBefore: 0 }, payload: { opId: 'op-move-retry-1', replicaId: engineScope.replicaId,
        sequence: 1, collectionId: engineScope.collectionId, type: 'move_node', targetId: 'node-bookmark',
        baseRevision: 'node-r1', occurredAt: '2026-07-27T00:00:00Z', dependencies: [],
        payload: { newParentId: 'folder-dest' } } }, { allowUnstamped: true });
    fixture.push.outcomes.push('terminal');
    fixture.pullResponses.push(engineJson(200, pullPage('cursor-move-1')), engineJson(200, pullPage('cursor-move-2')));
    fixture.ackResponses.push(engineJson(200, ack('cursor-move-1')), engineJson(200, ack('cursor-move-2')));
    await fixture.engine.wake('manual');
    assert.ok(fixture.order.includes('pull:cursor-0'));
    assert.ok(fixture.order.includes('push'));
    assert.ok(fixture.order.indexOf('push') > fixture.order.indexOf('pull:cursor-0'));
    assert.equal((await fixture.store.getEngineState(engineScope))!.phase, 'sleeping');
  });

  test('confirmed online drains a retried move_node instead of staying offline', async () => {
    const fixture = await setupEngine();
    await fixture.store.allocateSequenceAndEnqueue(engineScope, {
      opId: 'op-move-online-1', batchId: 'batch-move-online-1', idempotencyKey: 'key-move-online-1',
      digest: 'sha256:move-online-1', endpointIdentity: 'syncPush', mediaType: 'application/json',
      baseRevision: 'node-r1', operationRevision: 'local-move-online-1', status: 'pending',
      retry: { attempt: 1, notBefore: 0 }, payload: { opId: 'op-move-online-1', replicaId: engineScope.replicaId,
        sequence: 1, collectionId: engineScope.collectionId, type: 'move_node', targetId: 'node-bookmark',
        baseRevision: 'node-r1', occurredAt: '2026-07-27T00:00:00Z', dependencies: [],
        payload: { newParentId: 'folder-dest' } } }, { allowUnstamped: true });
    await fixture.store.transitionEngine(engineScope, { phase: 'offline', updatedAt: fixture.clock.now,
      recoveryFrozen: false, authorityRefreshRequired: false, notBefore: fixture.clock.now + 60_000,
      lastError: 'pull_invalid' });
    fixture.push.outcomes.push('terminal');
    fixture.pullResponses.push(engineJson(200, pullPage('cursor-online-move')),
      engineJson(200, pullPage('cursor-online-move-2')));
    fixture.ackResponses.push(engineJson(200, ack('cursor-online-move')),
      engineJson(200, ack('cursor-online-move-2')));
    await fixture.engine.wake('online', { connectivityRestored: true });
    assert.ok(fixture.push.calls >= 1);
    assert.notEqual((await fixture.store.getEngineState(engineScope))!.phase, 'offline');
  });

  test('sleep follows the outstanding move retry instead of a 30s idle', async () => {
    const fixture = await setupEngine();
    await fixture.store.allocateSequenceAndEnqueue(engineScope, {
      opId: 'op-move-sleep-1', batchId: 'batch-move-sleep-1', idempotencyKey: 'key-move-sleep-1',
      digest: 'sha256:move-sleep-1', endpointIdentity: 'syncPush', mediaType: 'application/json',
      baseRevision: 'node-r1', operationRevision: 'local-move-sleep-1', status: 'pending',
      retry: { attempt: 1, notBefore: fixture.clock.now + 8_000 }, payload: { opId: 'op-move-sleep-1',
        replicaId: engineScope.replicaId, sequence: 1, collectionId: engineScope.collectionId, type: 'move_node',
        targetId: 'node-bookmark', baseRevision: 'node-r1', occurredAt: '2026-07-28T00:00:00Z',
        dependencies: [], payload: { newParentId: 'folder-dest' } } }, { allowUnstamped: true });
    fixture.push.outcomes.push('unknown');
    fixture.pullResponses.push(engineJson(200, pullPage('cursor-sleep-move')),
      engineJson(200, pullPage('cursor-sleep-move-2')));
    fixture.ackResponses.push(engineJson(200, ack('cursor-sleep-move')),
      engineJson(200, ack('cursor-sleep-move-2')));
    await fixture.engine.wake('manual');
    const state = (await fixture.store.getEngineState(engineScope))!;
    assert.equal(state.phase, 'sleeping');
    assert.equal(state.notBefore, fixture.clock.now + 8_000);
  });

  test('Pull-first classified offline still drains a retried position_context_stale move_node', async () => {
    const fixture = await setupEngine();
    await fixture.store.allocateSequenceAndEnqueue(engineScope, {
      opId: 'op-move-stale-1', batchId: 'batch-move-stale-1', idempotencyKey: 'key-move-stale-1',
      digest: 'sha256:move-stale-1', endpointIdentity: 'syncPush', mediaType: 'application/json',
      baseRevision: 'node-r1', operationRevision: 'local-move-stale-1', status: 'pending',
      retry: { attempt: 1, notBefore: 0 }, payload: { opId: 'op-move-stale-1', replicaId: engineScope.replicaId,
        sequence: 1, collectionId: engineScope.collectionId, type: 'move_node', targetId: 'node-bookmark',
        baseRevision: 'node-r1', occurredAt: '2026-07-28T00:00:00Z', dependencies: [],
        payload: { newParentId: 'folder-dest', baseSourceParentRevision: 'children-source-old',
          baseTargetParentRevision: 'children-dest-old' } } }, { allowUnstamped: true });
    await fixture.store.transitionEngine(engineScope, { phase: 'offline', updatedAt: fixture.clock.now,
      recoveryFrozen: false, authorityRefreshRequired: false, notBefore: fixture.clock.now + 60_000,
      lastError: 'position_context_stale' });
    fixture.push.outcomes.push('terminal');
    fixture.pullResponses.push(networkFailure('offline'), engineJson(200, pullPage('cursor-stale-move')));
    fixture.ackResponses.push(engineJson(200, ack('cursor-stale-move')));
    await fixture.engine.wake('manual');
    assert.ok(fixture.push.calls >= 1);
    assert.notEqual((await fixture.store.getEngineState(engineScope))!.phase, 'offline');
  });

  // SR-14: the engine hook is only useful if the peer calls it while it still
  // has a rebase to do — after the failed attempt, before the retry leaves.
  test('a retried move_node refreshes placement before the rebase reads the mapping facts', async () => {
    const fixture = await setupMove();
    const events: string[] = []; const bodies: string[] = []; let calls = 0;
    const worker = createOutboundPushWorker({ ...fixture.options,
      refreshPlacement: async () => {
        events.push('refresh');
        await fixture.store.putMapping(scope, { nativeId: 'native-source', colpId: 'folder-source',
          rootNativeId: 'root-native', nodeKind: 'folder', projection: { revision: 'source-r2',
            childrenRevision: 'children-source-new', digest: 'sha256:source' } });
        await fixture.store.putMapping(scope, { nativeId: 'native-dest', colpId: 'folder-dest',
          rootNativeId: 'root-native', nodeKind: 'folder', projection: { revision: 'dest-r2',
            childrenRevision: 'children-dest-new', digest: 'sha256:dest' } });
      },
      fetch: async (_url, init) => {
        calls += 1; events.push(`push:${calls}`); bodies.push(String(init?.body));
        if (calls === 1) return problem(409, 'position_context_stale', { retryable: true });
        const attempt = JSON.parse(String(init?.body)) as { batchId: string };
        return json(200, { batchId: attempt.batchId, results: [{ opId: fixture.queued.opId, sequence: 1,
          status: 'applied', revision: 'node-r3', cursor: 'cursor-1', warnings: [] }], serverCursor: 'cursor-1' });
      } });

    // The first attempt is not a retry, so no refresh is asked for yet.
    assert.equal((await worker.drain()).outcome, 'unknown');
    assert.deepEqual(events, ['push:1']);

    fixture.clock.now = (await fixture.store.listQueue(scope))[0]!.retry.notBefore;
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.deepEqual(events, ['push:1', 'refresh', 'push:2']);
    const retried = JSON.parse(bodies[1]!) as { operations: Array<{ opId: string; sequence: number; payload: {
      baseSourceParentRevision: string; baseTargetParentRevision: string } }> };
    assert.equal(retried.operations[0]!.opId, fixture.queued.opId);
    assert.equal(retried.operations[0]!.sequence, fixture.queued.sequence);
    assert.equal(retried.operations[0]!.payload.baseSourceParentRevision, 'children-source-new');
    assert.equal(retried.operations[0]!.payload.baseTargetParentRevision, 'children-dest-new');
    assert.equal((await fixture.store.listQueue(scope))[0]?.status, 'terminal');
  });

  test('a recovery result from the real placement Pull prevents the Push request', async () => {
    const fixture = await setupEngine();
    await fixture.store.allocateSequenceAndEnqueue(engineScope, {
      opId: 'op-recovery-barrier-1', batchId: 'batch-recovery-barrier-1',
      idempotencyKey: 'key-recovery-barrier-1', digest: 'sha256:recovery-barrier-1',
      endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null,
      operationRevision: 'local-recovery-barrier-1', status: 'pending', retry: { attempt: 1, notBefore: 0 },
      payload: { opId: 'op-recovery-barrier-1', replicaId: engineScope.replicaId, sequence: 1,
        collectionId: engineScope.collectionId, type: 'create_node', baseRevision: null,
        occurredAt: '2026-07-28T00:00:00Z', dependencies: [], payload: { parentId: 'root-old' } },
    }, { allowUnstamped: true });
    fixture.pullResponses.push(problem(410, 'sync_cursor_expired'));
    let pushRequests = 0;
    const worker = createOutboundPushWorker({
      scope: engineScope, store: fixture.store, endpoints: async () => endpoints,
      sessions: { async get() { return { credential: { accessToken: 'access-token-push' }, session: {
        sessionId: 'session-engine', expiresAt: '2099-01-01T00:00:00Z', scope: 'collection',
        snapshotRequired: false, credentialAuthorityDigest: 'a'.repeat(64),
        collection: { collectionId: engineScope.collectionId, serverCursor: 'cursor-0', serverRevision: 'revision-0' },
        replicaLease: { leaseId: 'lease-1', generation: '1', state: 'active',
          expiresAt: '2099-01-01T00:00:00Z' },
      } }; } },
      now: () => fixture.clock.now, random: () => 0, ownerId: () => 'owner-recovery-barrier',
      schedule: () => undefined, refreshPlacement: () => fixture.engine.refreshPlacement(),
      fetch: async () => { pushRequests += 1; throw new Error('push_must_not_run'); },
    });

    assert.equal((await worker.drain()).outcome, 'recovery');
    assert.equal(pushRequests, 0);
    assert.equal((await fixture.store.getEngineState(engineScope))?.recoveryFrozen, true);
    const row = (await fixture.store.listQueue(engineScope))[0]!;
    assert.equal(row.status, 'unknown');
    assert.equal(row.recovery?.code, 'queue_recovery_frozen');
    assert.equal(row.attempt, undefined);
  });
  test.each([undefined, 'create_placement_parent_deleted', 'create_placement_unproven'])(
    'recovery during an unknown retry preserves the exact request for replay (%s)', async (lastError) => {
    const fixture = lastError ? await setup({ createPlacement: 'top' }) : await setupMove();
    const bodies: string[] = [];
    let freezeRetry = false;
    const worker = createOutboundPushWorker({ ...fixture.options,
      boundary: async (point) => {
        if (freezeRetry && point === 'after_attempt_persist') {
          await fixture.store.transitionEngine(scope, { phase: 'recovery', recoveryFrozen: true,
            authorityRefreshRequired: false, notBefore: 0, updatedAt: fixture.clock.now,
            ...(lastError ? { lastError } : {}) });
        }
      },
      fetch: async (_url, init) => {
        bodies.push(String(init?.body));
        if (bodies.length === 1) throw new TypeError('lost response');
        const attempt = JSON.parse(String(init?.body)) as { batchId: string };
        return json(200, { batchId: attempt.batchId, results: [{ opId: fixture.queued.opId, sequence: 1,
          status: 'applied', ...(lastError ? { targetId: 'created-node' } : {}),
          revision: 'node-r2', cursor: 'cursor-1', warnings: [] }], serverCursor: 'cursor-1' });
      },
    });
    assert.equal((await worker.drain()).outcome, 'unknown');
    const unknown = (await fixture.store.listQueue(scope))[0]!;
    assert.ok(unknown.attempt);
    fixture.clock.now = unknown.retry.notBefore;
    freezeRetry = true;
    assert.equal((await worker.drain()).outcome, 'recovery');
    assert.equal(bodies.length, 1);
    assert.deepEqual((await fixture.store.listQueue(scope))[0]!.attempt, unknown.attempt);
    assert.equal((await fixture.store.listQueue(scope))[0]!.recovery?.code, lastError ?? 'queue_recovery_frozen');
    freezeRetry = false;
    await fixture.store.transitionEngine(scope, { phase: 'idle', recoveryFrozen: false,
      authorityRefreshRequired: false, notBefore: 0, updatedAt: fixture.clock.now });
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.deepEqual(bodies, [unknown.attempt.body, unknown.attempt.body]);
  });

});
