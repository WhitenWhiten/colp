import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { createOutboundPushWorker, type PushSessionController } from '../src/outbound-push-worker.js';
import { createSyncStateStore, type JsonObject } from '../src/sync-state-store.js';

import {
  endpoints, indexedDB, installOutboundPushIndexedDb, json, operation, problem, scope, setup, setupMove,
} from './outbound-push-worker-harness.js';

installOutboundPushIndexedDb();

describe('P3-31 outbound Push 409 refresh and rebase', () => {
  test('lost-response move retries keep identical bytes and never request new authority', async () => {
    const fixture = await setupMove(); const bodies: string[] = [];
    const worker = createOutboundPushWorker({ ...fixture.options,
      readMoveAuthority: async () => { throw new Error('must not rebase uncertain attempts'); },
      fetch: async (_url, init) => { bodies.push(String(init?.body)); throw new Error('lost response'); } });
    try {
      for (let i = 0; i < 10; i += 1) {
        assert.equal((await worker.drain()).outcome, 'unknown');
        const row = (await fixture.store.listQueue(scope))[0]!;
        assert.ok(row.attempt);
        fixture.clock.now = row.retry.notBefore;
      }
      assert.equal(bodies.length, 10);
      assert.equal(new Set(bodies).size, 1);
    } finally { fixture.store.close(); }
  });
  test('repeated move conflicts recover from a full authority read even when Pull mappings stay stale', async () => {
    const fixture = await setupMove(); let reads = 0; const bodies: any[] = [];
    const worker = createOutboundPushWorker({ ...fixture.options, refreshPlacement: async () => 'continue',
      readMoveAuthority: async () => { reads += 1; return [
        { nodeId: 'node-bookmark', parentId: 'folder-dest', revision: 'node-fresh' },
        { nodeId: 'folder-dest', parentId: 'root', revision: 'dest-fresh', childrenRevision: 'children-fresh' },
      ]; }, fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)); bodies.push(body);
        if (body.operations[0].baseRevision !== 'node-fresh') return problem(409, 'revision_conflict');
        assert.equal(body.operations[0].payload.baseSourceParentRevision, 'children-fresh');
        assert.equal(body.operations[0].payload.baseTargetParentRevision, 'children-fresh');
        return json(200, { batchId: body.batchId, results: [{ opId: fixture.queued.opId, sequence: 1,
          status: 'applied', revision: 'node-receipt', cursor: 'cursor-1', warnings: [] }], serverCursor: 'cursor-1' });
      } });
    try {
      for (let i = 0; i < 8; i += 1) {
        assert.equal((await worker.drain()).outcome, 'unknown');
        fixture.clock.now = (await fixture.store.listQueue(scope))[0]!.retry.notBefore;
      }
      assert.equal(reads, 0);
      assert.equal((await worker.drain()).outcome, 'terminal');
      assert.equal(reads, 1);
      assert.equal(bodies.at(-1).operations[0].opId, fixture.queued.opId);
      assert.equal(bodies.at(-1).operations[0].sequence, fixture.queued.sequence);
    } finally { fixture.store.close(); }
  });
  test('stale create placement refreshes a live parent and sends a new anchor and identity', async () => {
    const fixture = await setup({ createPlacement: 'top' });
    const bodies: string[] = []; const idempotency: string[] = [];
    let calls = 0; let refreshed = 0;
    const worker = createOutboundPushWorker({ ...fixture.options, refreshPlacement: async () => {
      refreshed += 1;
      await fixture.store.deleteMapping(scope, 'native-anchor-old');
      await fixture.store.putMapping(scope, { nativeId: 'native-anchor-new', colpId: 'anchor-new',
        rootNativeId: 'root-native', parentNativeId: 'native-parent', parentColpId: 'root-push', nodeKind: 'bookmark',
        projection: { revision: 'anchor-r2', digest: 'sha256:anchor-new', content: { title: 'New' } } });
      await fixture.store.putMapping(scope, { nativeId: 'native-parent', colpId: 'root-push', rootNativeId: 'root-native',
        nodeKind: 'folder', projection: { revision: 'parent-r2', childrenRevision: 'children-r2',
          digest: 'sha256:parent-new' } });
      return 'continue';
    }, readChildrenOrder: async () => ['native-create', 'native-anchor-new'], fetch: async (_url, init) => {
      bodies.push(String(init?.body));
      idempotency.push(new Headers(init?.headers).get('idempotency-key') ?? '');
      calls += 1;
      if (calls === 1) return problem(409, 'position_context_stale', { retryable: true });
      const attempt = JSON.parse(String(init?.body)) as { batchId: string };
      return json(200, { batchId: attempt.batchId, results: [{ opId: fixture.queued.opId, sequence: 1,
        status: 'applied', targetId: 'node-created', revision: 'node-r1', cursor: 'cursor-1', warnings: [] }],
      serverCursor: 'cursor-1' });
    } });
    assert.equal((await worker.drain()).outcome, 'unknown');
    const retry = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(retry.recovery?.code, 'position_context_stale');
    assert.equal(retry.retry.attempt, 1);
    assert.equal(retry.attempt, undefined);
    assert.equal(((await fixture.store.listBookmarkEvents(scope))[0]?.details.context as any)?.placement?.mode, 'top');
    fixture.clock.now = retry.retry.notBefore;
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.equal(refreshed, 1);
    const first = JSON.parse(bodies[0]!) as { operations: Array<{ payload: { beforeId?: string } }> };
    const second = JSON.parse(bodies[1]!) as { operations: Array<{ opId: string; sequence: number;
      payload: { beforeId?: string; afterId?: string } }> };
    assert.equal(first.operations[0]?.payload.beforeId, 'anchor-old');
    assert.equal(second.operations[0]?.opId, fixture.queued.opId);
    assert.equal(second.operations[0]?.sequence, 1);
    assert.equal(second.operations[0]?.payload.beforeId, 'anchor-new');
    assert.equal(second.operations[0]?.payload.afterId, undefined);
    assert.notEqual(bodies[0], bodies[1]);
    assert.notEqual(idempotency[0], idempotency[1]);
  });

  test('stale create with unproven refreshed order is set aside instead of replaying the old anchor', async () => {
    const fixture = await setup({ createPlacement: 'top' });
    let sends = 0;
    const worker = createOutboundPushWorker({ ...fixture.options, refreshPlacement: async () => {
      await fixture.store.putMapping(scope, { nativeId: 'native-parent', colpId: 'root-push',
        rootNativeId: 'root-native', nodeKind: 'folder', projection: { revision: 'parent-r2',
          childrenRevision: 'children-r2', digest: 'sha256:parent-without-order' } });
      return 'continue';
    }, fetch: async () => { sends += 1;
      return problem(409, 'position_context_stale', { retryable: true }); } });
    assert.equal((await worker.drain()).outcome, 'unknown');
    fixture.clock.now = (await fixture.store.listQueue(scope))[0]!.retry.notBefore;
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.equal(sends, 1);
    const row = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(row.status, 'set_aside');
    assert.equal(row.recovery?.code, 'create_placement_unproven');
    assert.equal(row.attempt, undefined);
    assert.equal((await fixture.store.getScope(scope))?.lifecycle, 'active');
    assert.notEqual((await fixture.store.getEngineState(scope))?.recoveryFrozen, true);
  });

  test('409 position_context_stale retryable true retries with the real recovery code', async () => {
    const fixture = await setupMove();
    const worker = createOutboundPushWorker({ ...fixture.options,
      fetch: async () => problem(409, 'position_context_stale', { retryable: true }) });
    assert.equal((await worker.drain()).outcome, 'unknown');
    const queued = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(queued.status, 'unknown');
    assert.equal(queued.recovery?.code, 'position_context_stale');
    assert.equal(queued.attempt, undefined);
    assert.notEqual(queued.recovery?.code, 'push_response_unrecognized');
  });

  test('after children-revision refresh the next drain terminals a stale move_node', async () => {
    const fixture = await setupMove();
    const bodies: string[] = [];
    let calls = 0;
    const worker = createOutboundPushWorker({ ...fixture.options, fetch: async (_url, init) => {
      bodies.push(String(init?.body)); calls += 1;
      if (calls === 1) return problem(409, 'position_context_stale', { retryable: true });
      const attempt = JSON.parse(String(init?.body)) as { batchId: string };
      return json(200, { batchId: attempt.batchId, results: [{ opId: fixture.queued.opId, sequence: 1,
        status: 'applied', revision: 'node-r2', cursor: 'cursor-1', warnings: [] }], serverCursor: 'cursor-1' });
    } });
    assert.equal((await worker.drain()).outcome, 'unknown');
    await fixture.store.putMapping(scope, { nativeId: 'native-bookmark', colpId: 'node-bookmark',
      rootNativeId: 'root-native', parentNativeId: 'native-source', parentColpId: 'folder-source', nodeKind: 'bookmark',
      projection: { revision: 'node-r2', digest: 'sha256:bookmark', content: { title: 'Moved' } } });
    await fixture.store.putMapping(scope, { nativeId: 'native-source', colpId: 'folder-source',
      rootNativeId: 'root-native', nodeKind: 'folder', projection: { revision: 'source-r2',
        childrenRevision: 'children-source-new', digest: 'sha256:source' } });
    await fixture.store.putMapping(scope, { nativeId: 'native-dest', colpId: 'folder-dest',
      rootNativeId: 'root-native', nodeKind: 'folder', projection: { revision: 'dest-r2',
        childrenRevision: 'children-dest-new', digest: 'sha256:dest' } });
    fixture.clock.now = (await fixture.store.listQueue(scope))[0]!.retry.notBefore;
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.equal(bodies.length, 2);
    assert.notEqual(bodies[0], bodies[1]);
    const retried = JSON.parse(bodies[1]!) as { operations: Array<{ opId: string; sequence: number; payload: {
      baseSourceParentRevision: string; baseTargetParentRevision: string } }> };
    assert.equal(retried.operations[0]!.opId, fixture.queued.opId);
    assert.equal(retried.operations[0]!.sequence, fixture.queued.sequence);
    assert.equal(retried.operations[0]!.payload.baseSourceParentRevision, 'children-source-new');
    assert.equal(retried.operations[0]!.payload.baseTargetParentRevision, 'children-dest-new');
    assert.equal((await fixture.store.listQueue(scope))[0]?.status, 'terminal');
  });

  test('HTTP revision_conflict on move_node does not reject an unrelated pending row', async () => {
    const fixture = await setupMove();
    await fixture.store.allocateSequenceAndEnqueue(scope, { opId: 'op-push-2', batchId: 'batch-push-2',
      idempotencyKey: 'idempotency-push-2', digest: 'sha256:operation-push-2', endpointIdentity: 'syncPush',
      mediaType: 'application/json', baseRevision: null, operationRevision: 'local-event-push-2',
      status: 'pending', retry: { attempt: 0, notBefore: 0 },
      payload: { ...operation, opId: 'op-push-2', sequence: 2 } }, { allowUnstamped: true });
    const worker = createOutboundPushWorker({ ...fixture.options,
      fetch: async () => problem(409, 'revision_conflict', { retryable: false }) });
    assert.equal((await worker.drain()).outcome, 'unknown');
    const rows = await fixture.store.listQueue(scope);
    assert.equal(rows[0]?.status, 'unknown');
    assert.equal(rows[0]?.recovery?.code, 'revision_conflict');
    assert.notEqual(rows[0]?.status, 'rejected');
    assert.equal(rows[1]?.status, 'pending');
    assert.equal(rows[1]?.recovery?.code, undefined);
    assert.ok(rows[0]!.retry.attempt >= 1);
    assert.ok(Number.isSafeInteger(rows[0]!.retry.notBefore));
  });

  test('stale mapping revision_conflict refreshes then terminals the same move_node', async () => {
    const fixture = await setupMove();
    const bodies: string[] = [];
    let calls = 0;
    let refreshed = 0;
    const worker = createOutboundPushWorker({ ...fixture.options, refreshPlacement: async () => {
      refreshed += 1;
      await fixture.store.putMapping(scope, { nativeId: 'native-bookmark', colpId: 'node-bookmark',
        rootNativeId: 'root-native', parentNativeId: 'native-source', parentColpId: 'folder-source', nodeKind: 'bookmark',
        projection: { revision: 'node-r2', digest: 'sha256:bookmark', content: { title: 'Moved' } } });
      await fixture.store.putMapping(scope, { nativeId: 'native-source', colpId: 'folder-source',
        rootNativeId: 'root-native', nodeKind: 'folder', projection: { revision: 'source-r2',
          childrenRevision: 'children-source-new', digest: 'sha256:source' } });
      await fixture.store.putMapping(scope, { nativeId: 'native-dest', colpId: 'folder-dest',
        rootNativeId: 'root-native', nodeKind: 'folder', projection: { revision: 'dest-r2',
          childrenRevision: 'children-dest-new', digest: 'sha256:dest' } });
    }, fetch: async (_url, init) => {
      bodies.push(String(init?.body)); calls += 1;
      if (calls === 1) return problem(409, 'revision_conflict', { retryable: false });
      const attempt = JSON.parse(String(init?.body)) as { batchId: string };
      return json(200, { batchId: attempt.batchId, results: [{ opId: fixture.queued.opId, sequence: 1,
        status: 'applied', revision: 'node-r3', cursor: 'cursor-1', warnings: [] }], serverCursor: 'cursor-1' });
    } });
    assert.equal((await worker.drain()).outcome, 'unknown');
    assert.equal(refreshed, 0);
    const afterUnknown = (await fixture.store.listQueue(scope))[0]!;
    assert.ok(afterUnknown.retry.attempt >= 1);
    assert.equal(afterUnknown.attempt, undefined);
    fixture.clock.now = afterUnknown.retry.notBefore;
    const second = await worker.drain();
    assert.equal(refreshed, 1);
    assert.equal(second.outcome, 'terminal');
    assert.equal(bodies.length, 2);
    assert.notEqual(bodies[0], bodies[1]);
    const retried = JSON.parse(bodies[1]!) as { operations: Array<{ opId: string; sequence: number; payload: {
      baseSourceParentRevision: string; baseTargetParentRevision: string }; baseRevision: string }> };
    assert.equal(retried.operations[0]!.opId, fixture.queued.opId);
    assert.equal(retried.operations[0]!.sequence, fixture.queued.sequence);
    assert.equal(retried.operations[0]!.payload.baseSourceParentRevision, 'children-source-new');
    assert.equal(retried.operations[0]!.payload.baseTargetParentRevision, 'children-dest-new');
    assert.equal(retried.operations[0]!.baseRevision, 'node-r2');
    const settled = await fixture.store.getMappingByColpId(scope, 'node-bookmark');
    assert.equal(settled?.projection.revision, 'node-r3');
    assert.equal(settled?.projection.resourceRevision, 'node-r3');
    assert.equal(settled?.parentNativeId, 'native-dest');
    assert.equal(settled?.parentColpId, 'folder-dest');
    assert.equal((await fixture.store.listQueue(scope))[0]?.status, 'terminal');
  });

  test('stale mapping position_context_stale refreshes then terminals the same move_node', async () => {
    const fixture = await setupMove();
    const bodies: string[] = [];
    let calls = 0;
    let refreshed = 0;
    const worker = createOutboundPushWorker({ ...fixture.options, refreshPlacement: async () => {
      refreshed += 1;
      await fixture.store.putMapping(scope, { nativeId: 'native-bookmark', colpId: 'node-bookmark',
        rootNativeId: 'root-native', parentNativeId: 'native-source', parentColpId: 'folder-source', nodeKind: 'bookmark',
        projection: { revision: 'node-r2', digest: 'sha256:bookmark', content: { title: 'Moved' } } });
      await fixture.store.putMapping(scope, { nativeId: 'native-source', colpId: 'folder-source',
        rootNativeId: 'root-native', nodeKind: 'folder', projection: { revision: 'source-r2',
          childrenRevision: 'children-source-new', digest: 'sha256:source' } });
      await fixture.store.putMapping(scope, { nativeId: 'native-dest', colpId: 'folder-dest',
        rootNativeId: 'root-native', nodeKind: 'folder', projection: { revision: 'dest-r2',
          childrenRevision: 'children-dest-new', digest: 'sha256:dest' } });
    }, fetch: async (_url, init) => {
      bodies.push(String(init?.body)); calls += 1;
      if (calls === 1) return problem(409, 'position_context_stale', { retryable: true });
      const attempt = JSON.parse(String(init?.body)) as { batchId: string };
      return json(200, { batchId: attempt.batchId, results: [{ opId: fixture.queued.opId, sequence: 1,
        status: 'applied', revision: 'node-r3', cursor: 'cursor-1', warnings: [] }], serverCursor: 'cursor-1' });
    } });
    assert.equal((await worker.drain()).outcome, 'unknown');
    assert.equal(refreshed, 0);
    const afterUnknown = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(afterUnknown.recovery?.code, 'position_context_stale');
    assert.equal(afterUnknown.attempt, undefined);
    fixture.clock.now = afterUnknown.retry.notBefore;
    const second = await worker.drain();
    assert.equal(refreshed, 1);
    assert.equal(second.outcome, 'terminal');
    assert.equal(bodies.length, 2);
    assert.notEqual(bodies[0], bodies[1]);
    const retried = JSON.parse(bodies[1]!) as { operations: Array<{ opId: string; sequence: number; payload: {
      baseSourceParentRevision: string; baseTargetParentRevision: string }; baseRevision: string }> };
    assert.equal(retried.operations[0]!.opId, fixture.queued.opId);
    assert.equal(retried.operations[0]!.sequence, fixture.queued.sequence);
    assert.equal(retried.operations[0]!.payload.baseSourceParentRevision, 'children-source-new');
    assert.equal(retried.operations[0]!.payload.baseTargetParentRevision, 'children-dest-new');
    assert.equal((await fixture.store.listQueue(scope))[0]?.status, 'terminal');
  });

  test('position_context_stale still sends a new attempt body when mapping revisions are unchanged', async () => {
    const fixture = await setupMove();
    const bodies: string[] = [];
    let calls = 0;
    const worker = createOutboundPushWorker({ ...fixture.options, refreshPlacement: async () => undefined,
      fetch: async (_url, init) => {
        bodies.push(String(init?.body)); calls += 1;
        if (calls === 1) return problem(409, 'position_context_stale', { retryable: true });
        const attempt = JSON.parse(String(init?.body)) as { batchId: string };
        return json(200, { batchId: attempt.batchId, results: [{ opId: fixture.queued.opId, sequence: 1,
          status: 'applied', revision: 'node-r2', cursor: 'cursor-1', warnings: [] }], serverCursor: 'cursor-1' });
      } });
    assert.equal((await worker.drain()).outcome, 'unknown');
    assert.equal((await fixture.store.listQueue(scope))[0]?.status, 'unknown');
    fixture.clock.now = (await fixture.store.listQueue(scope))[0]!.retry.notBefore;
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.equal(bodies.length, 2);
    assert.notEqual(bodies[0], bodies[1]);
    assert.equal((await fixture.store.listQueue(scope))[0]?.status, 'terminal');
  });

  test('after refresh a move already at the destination rebases and retries without a local noop', async () => {
    const store = createSyncStateStore({ indexedDB }); await store.registerScope({ ...scope, lifecycle: 'active',
      lease: { leaseId: 'lease-server', expiresAt: Date.parse('2099-01-01T00:00:00Z') }, checkpoint: null,
      selectedRoots: [] });
    await store.putMapping(scope, { nativeId: 'native-bookmark', colpId: 'node-bookmark', rootNativeId: 'root-native',
      parentNativeId: 'native-source', parentColpId: 'folder-source', nodeKind: 'bookmark',
      projection: { revision: 'node-r1', digest: 'sha256:bookmark', content: { title: 'Moved' } } });
    await store.putMapping(scope, { nativeId: 'native-source', colpId: 'folder-source', rootNativeId: 'root-native',
      nodeKind: 'folder', projection: { revision: 'source-r1', childrenRevision: 'children-source-old',
        digest: 'sha256:source' } });
    await store.putMapping(scope, { nativeId: 'native-dest', colpId: 'folder-dest', rootNativeId: 'root-native',
      nodeKind: 'folder', projection: { revision: 'dest-r1', childrenRevision: 'children-dest-old',
        digest: 'sha256:dest' } });
    await store.putMapping(scope, { nativeId: 'native-keep', colpId: 'node-keep', rootNativeId: 'root-native',
      parentNativeId: 'native-dest', parentColpId: 'folder-dest', nodeKind: 'bookmark',
      projection: { revision: 'keep-r1', digest: 'sha256:keep' } });
    await store.putMapping(scope, { nativeId: 'native-drop', colpId: 'node-drop', rootNativeId: 'root-native',
      parentNativeId: 'native-source', parentColpId: 'folder-source', nodeKind: 'bookmark',
      projection: { revision: 'drop-r1', digest: 'sha256:drop' } });
    const move: JsonObject = { opId: 'op-push-1', replicaId: scope.replicaId, sequence: 1,
      collectionId: scope.collectionId, type: 'move_node', targetId: 'node-bookmark', baseRevision: 'node-r1',
      occurredAt: '2026-07-27T00:00:00.000Z', dependencies: [], payload: { newParentId: 'folder-dest',
        afterId: 'node-keep', beforeId: 'node-drop',
        baseSourceParentRevision: 'children-source-old', baseTargetParentRevision: 'children-dest-old' } };
    const queued = await store.allocateSequenceAndEnqueue(scope, { opId: 'op-push-1', batchId: 'batch-push-1',
      idempotencyKey: 'idempotency-push-1', digest: 'sha256:operation-push-1', endpointIdentity: 'syncPush',
      mediaType: 'application/json', baseRevision: 'node-r1', operationRevision: 'local-event-push-1',
      status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload: move }, { allowUnstamped: true });
    const clock = { now: 10_000 };
    const fixture = { store, queued, clock, options: { scope, store, endpoints: async () => endpoints,
      sessions: { async get() { return {
        credential: { accessToken: 'access-token-push' }, session: { sessionId: 'session-push',
          expiresAt: '2099-01-01T00:00:00Z', scope: 'collection', snapshotRequired: false,
          credentialAuthorityDigest: 'a'.repeat(64),
          collection: { collectionId: scope.collectionId, serverCursor: 'cursor-0', serverRevision: 'revision-0' },
          replicaLease: { leaseId: 'lease-server', generation: '1', state: 'active',
            expiresAt: '2099-01-01T00:00:00Z' } } }; } } satisfies PushSessionController,
      now: () => clock.now, random: () => 0, ownerId: () => 'owner-push', schedule: () => undefined } };
    const bodies: string[] = [];
    let calls = 0;
    const worker = createOutboundPushWorker({ ...fixture.options, fetch: async (_url, init) => {
      bodies.push(String(init?.body)); calls += 1;
      if (calls === 1) return problem(409, 'revision_conflict', { retryable: true });
      const attempt = JSON.parse(String(init?.body)) as { batchId: string };
      return json(200, { batchId: attempt.batchId, results: [{ opId: fixture.queued.opId, sequence: 1,
        status: 'applied', revision: 'node-r2', cursor: 'cursor-1', warnings: [] }], serverCursor: 'cursor-1' });
    } });
    assert.equal((await worker.drain()).outcome, 'unknown');
    await fixture.store.putMapping(scope, { nativeId: 'native-bookmark', colpId: 'node-bookmark',
      rootNativeId: 'root-native', parentNativeId: 'native-dest', parentColpId: 'folder-dest', nodeKind: 'bookmark',
      projection: { revision: 'node-r2', childrenRevision: null, digest: 'sha256:bookmark-dest',
        content: { title: 'Moved' } } });
    fixture.clock.now = (await fixture.store.listQueue(scope))[0]!.retry.notBefore;
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.equal(bodies.length, 2);
    const retried = JSON.parse(bodies[1]!) as { operations: Array<{ payload: { afterId?: string; beforeId?: string } }> };
    assert.equal(retried.operations[0]?.payload.afterId, 'node-keep');
    assert.equal(retried.operations[0]?.payload.beforeId, undefined);
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.queue[0]?.status, 'terminal');
    const receipt = exported.receipts[0]?.result as { results?: Array<{ status?: string }> } | undefined;
    assert.notEqual(receipt?.results?.[0]?.status, 'noop');
  });

  test('optimistic dest mapping still rebases source fences from the authored parent', async () => {
    const fixture = await setupMove();
    const scopeKey = (await fixture.store.getScope(scope))!.scopeKey;
    const database = await fixture.store.open();
    const transaction = database.transaction('bookmark_events', 'readwrite');
    transaction.objectStore('bookmark_events').add({
      scopeKey, eventId: 'event-move-authored', ordinal: 1, dedupeKey: 'dedupe-move-authored',
      occurredAt: '2026-07-27T00:00:00Z', kind: 'move', nativeId: 'native-bookmark',
      details: { context: { sourceParentNativeId: 'native-source', targetParentNativeId: 'native-dest' } },
      status: 'processed', opId: fixture.queued.opId,
    });
    await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); });
    await fixture.store.putMapping(scope, { nativeId: 'native-bookmark', colpId: 'node-bookmark',
      rootNativeId: 'root-native', parentNativeId: 'native-dest', parentColpId: 'folder-dest', nodeKind: 'bookmark',
      projection: { revision: fixture.queued.operationRevision, digest: 'sha256:bookmark', content: { title: 'Moved' } } });
    const bodies: string[] = [];
    let calls = 0;
    const worker = createOutboundPushWorker({ ...fixture.options, fetch: async (_url, init) => {
      bodies.push(String(init?.body)); calls += 1;
      if (calls === 1) return problem(409, 'position_context_stale', { retryable: true });
      const attempt = JSON.parse(String(init?.body)) as { batchId: string };
      return json(200, { batchId: attempt.batchId, results: [{ opId: fixture.queued.opId, sequence: 1,
        status: 'applied', revision: 'node-r3', cursor: 'cursor-1', warnings: [] }], serverCursor: 'cursor-1' });
    } });
    assert.equal((await worker.drain()).outcome, 'unknown');
    const first = JSON.parse(bodies[0]!) as { operations: Array<{ payload: { baseSourceParentRevision: string } }> };
    assert.equal(first.operations[0]?.payload.baseSourceParentRevision, 'children-source-old');
    await fixture.store.putMapping(scope, { nativeId: 'native-bookmark', colpId: 'node-bookmark',
      rootNativeId: 'root-native', parentNativeId: 'native-dest', parentColpId: 'folder-dest', nodeKind: 'bookmark',
      projection: { revision: fixture.queued.operationRevision, digest: 'sha256:bookmark', content: { title: 'Moved' } } });
    await fixture.store.putMapping(scope, { nativeId: 'native-source', colpId: 'folder-source',
      rootNativeId: 'root-native', nodeKind: 'folder', projection: { revision: 'source-r2',
        childrenRevision: 'children-source-new', digest: 'sha256:source' } });
    await fixture.store.putMapping(scope, { nativeId: 'native-dest', colpId: 'folder-dest',
      rootNativeId: 'root-native', nodeKind: 'folder', projection: { revision: 'dest-r2',
        childrenRevision: 'children-dest-new', digest: 'sha256:dest' } });
    fixture.clock.now = (await fixture.store.listQueue(scope))[0]!.retry.notBefore;
    assert.equal((await worker.drain()).outcome, 'terminal');
    const retried = JSON.parse(bodies[1]!) as { operations: Array<{ payload: {
      baseSourceParentRevision: string; baseTargetParentRevision: string } }> };
    assert.equal(retried.operations[0]?.payload.baseSourceParentRevision, 'children-source-new');
    assert.equal(retried.operations[0]?.payload.baseTargetParentRevision, 'children-dest-new');
  });

  test('first placement rebase is due immediately so the same wake can Pull then retry', async () => {
    const fixture = await setupMove();
    const scheduled: number[] = [];
    const worker = createOutboundPushWorker({ ...fixture.options, schedule: (delay) => scheduled.push(delay),
      fetch: async () => problem(409, 'position_context_stale', { retryable: true }) });
    assert.equal((await worker.drain()).outcome, 'unknown');
    const row = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(row.status, 'unknown');
    assert.equal(row.recovery?.code, 'position_context_stale');
    assert.equal(row.attempt, undefined);
    assert.equal(row.retry.notBefore, fixture.clock.now);
    assert.equal(scheduled.includes(0), false);
  });

  test('consecutive 409 retries increase notBefore', async () => {
    const fixture = await setupMove();
    const worker = createOutboundPushWorker({ ...fixture.options,
      fetch: async () => problem(409, 'revision_conflict', { retryable: true }) });
    assert.equal((await worker.drain()).outcome, 'unknown');
    const first = (await fixture.store.listQueue(scope))[0]!;
    fixture.clock.now = first.retry.notBefore;
    assert.equal((await worker.drain()).outcome, 'unknown');
    const second = (await fixture.store.listQueue(scope))[0]!;
    assert.ok(second.retry.notBefore > first.retry.notBefore);
  });

  test('HTTP revision_conflict with conflictId blocks only that move_node', async () => {
    const fixture = await setupMove();
    await fixture.store.allocateSequenceAndEnqueue(scope, { opId: 'op-push-2', batchId: 'batch-push-2',
      idempotencyKey: 'idempotency-push-2', digest: 'sha256:operation-push-2', endpointIdentity: 'syncPush',
      mediaType: 'application/json', baseRevision: null, operationRevision: 'local-event-push-2',
      status: 'pending', retry: { attempt: 0, notBefore: 0 },
      payload: { ...operation, opId: 'op-push-2', sequence: 2 } }, { allowUnstamped: true });
    const worker = createOutboundPushWorker({ ...fixture.options,
      fetch: async () => problem(409, 'revision_conflict', { retryable: false, conflictId: 'conflict-move-1' }) });
    assert.equal((await worker.drain()).outcome, 'blocked');
    const rows = await fixture.store.listQueue(scope);
    assert.equal(rows[0]?.status, 'blocked');
    assert.equal(rows[0]?.recovery?.code, 'conflict_pending');
    assert.equal(rows[1]?.status, 'pending');
  });

  test('a move reads its authored parent by op id, not from the oldest event', async () => {
    const fixture = await setupMove();
    try {
      const scopeKey = (await fixture.store.getScope(scope))!.scopeKey;
      const database = await fixture.store.open();
      const transaction = database.transaction('bookmark_events', 'readwrite');
      const events = transaction.objectStore('bookmark_events');
      for (let ordinal = 1; ordinal <= 180; ordinal += 1) {
        events.add({
          scopeKey, eventId: `noise-${ordinal}`, ordinal, dedupeKey: `noise-${ordinal}`,
          occurredAt: '2026-07-27T00:00:00Z', kind: 'create', nativeId: `noise-native-${ordinal}`,
          details: {}, status: 'processed', opId: `noise-op-${ordinal}`,
        });
      }
      events.add({
        scopeKey, eventId: 'event-move-authored', ordinal: 181, dedupeKey: 'dedupe-move-authored',
        occurredAt: '2026-07-27T00:00:00Z', kind: 'create', nativeId: 'native-bookmark',
        details: {}, status: 'processed', opId: fixture.queued.opId,
      });
      events.add({
        scopeKey, eventId: 'event-move-later', ordinal: 182, dedupeKey: 'dedupe-move-later',
        occurredAt: '2026-07-27T00:00:00Z', kind: 'move', nativeId: 'native-bookmark',
        details: { context: { sourceParentNativeId: 'native-source', targetParentNativeId: 'native-dest' } },
        status: 'processed', opId: fixture.queued.opId,
      });
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      await fixture.store.putMapping(scope, { nativeId: 'native-bookmark', colpId: 'node-bookmark',
        rootNativeId: 'root-native', parentNativeId: 'native-dest', parentColpId: 'folder-dest', nodeKind: 'bookmark',
        projection: { revision: fixture.queued.operationRevision, digest: 'sha256:bookmark',
          content: { title: 'Moved' } } });
      await fixture.store.putMapping(scope, { nativeId: 'native-source', colpId: 'folder-source',
        rootNativeId: 'root-native', nodeKind: 'folder', projection: { revision: 'source-r2',
          childrenRevision: 'children-source-authored', digest: 'sha256:source' } });
      const logStarts: number[] = [];
      const opReads: Array<{ opId: string; after: number }> = [];
      const base = fixture.store;
      const store = {
        ...base,
        listBookmarkEvents: async (...args: Parameters<typeof base.listBookmarkEvents>) => {
          logStarts.push(args[1] ?? 0);
          return base.listBookmarkEvents(...args);
        },
        listBookmarkEventsByOperation: async (...args: Parameters<typeof base.listBookmarkEventsByOperation>) => {
          opReads.push({ opId: args[1], after: args[2] ?? 0 });
          return base.listBookmarkEventsByOperation(...args);
        },
      };
      const bodies: string[] = [];
      const worker = createOutboundPushWorker({ ...fixture.options, store,
        fetch: async (_url, init) => {
          bodies.push(String(init?.body));
          return problem(409, 'position_context_stale', { retryable: true });
        } });
      assert.equal((await worker.drain()).outcome, 'unknown');
      const sent = JSON.parse(bodies[0]!) as { operations: Array<{ payload: { baseSourceParentRevision?: string } }> };
      assert.equal(sent.operations[0]?.payload.baseSourceParentRevision, 'children-source-authored');
      assert.deepEqual(logStarts, []);
      assert.deepEqual(opReads, [{ opId: fixture.queued.opId, after: 0 }]);
    } finally { fixture.store.close(); }
  });

  test('applied local-only create_node receipt binds planned nativeId without a pending mapping', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-server',
      expiresAt: Date.parse('2099-01-01T00:00:00Z') }, checkpoint: null, selectedRoots: [] });
    const opId = 'b3.workerconfirm.create.native-5';
    const payload: JsonObject = { opId, replicaId: scope.replicaId, sequence: 1, collectionId: scope.collectionId,
      type: 'create_node', baseRevision: null, occurredAt: '2026-07-27T00:00:00.000Z', dependencies: [],
      payload: { parentId: 'root-push', node: { kind: 'bookmark', title: 'Public', url: 'https://example.test/public' } } };
    const queued = await store.allocateSequenceAndEnqueue(scope, { opId, batchId: 'batch-create-native',
      idempotencyKey: opId, digest: 'sha256:create-native', endpointIdentity: 'syncPush',
      mediaType: 'application/json', baseRevision: null, operationRevision: `local-${opId}`,
      status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload }, { allowUnstamped: true });
    const clock = { now: 10_000 };
    const sessions: PushSessionController = { async get() { return {
      credential: { accessToken: 'access-token-push' }, session: { sessionId: 'session-push',
        expiresAt: '2099-01-01T00:00:00Z', scope: 'collection', snapshotRequired: false,
        credentialAuthorityDigest: 'a'.repeat(64),
        collection: { collectionId: scope.collectionId, serverCursor: 'cursor-0', serverRevision: 'revision-0' },
        replicaLease: { leaseId: 'lease-server', generation: '1', state: 'active',
          expiresAt: '2099-01-01T00:00:00Z' } } }; } };
    const worker = createOutboundPushWorker({ scope, store, endpoints: async () => endpoints, sessions,
      now: () => clock.now, random: () => 0, ownerId: () => 'owner-push', schedule: () => undefined,
      fetch: async (_url, init) => json(200, { batchId: JSON.parse(String(init?.body)).batchId,
        results: [{ opId: queued.opId, sequence: 1, status: 'applied', targetId: 'node-server-native',
          revision: 'revision-native-1', cursor: 'cursor-1', warnings: [] }], serverCursor: 'cursor-1' }) });
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.equal((await store.getMappingByNativeId(scope, 'native-5'))?.colpId, 'node-server-native');
    assert.equal(await store.getMappingByColpId(scope, `pending-${opId}`), null);
    assert.equal((await store.listQueue(scope))[0]?.status, 'terminal');
  });
});
