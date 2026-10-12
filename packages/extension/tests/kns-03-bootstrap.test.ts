/**
 * Owner: KNS-08 (QA). Fixture: see e2e/kns-08-ids.ts.
 * Run: see e2e/kns-08-ids.ts.
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { createBootstrapCoordinator, previewStaleFromScan } from '../src/bootstrap/coordinator.js';
import { createOutboundPushWorker, type PushSessionController } from '../src/outbound-push-worker.js';
import { createSyncStateStore } from '../src/sync-state-store.js';
import {
  active, assertOpaqueOpId, assertOpaquePlanned, assertOpaqueQueued, assertStampedColp, barMount,
  baseConfirm, bindRemoteMount, bookmark, indexedDB, installKns03IndexedDb, otherMount, root, scope,
  setup,
} from './kns-03-bootstrap-harness.js';

installKns03IndexedDb();

describe('KNS-03 empty Collection bootstrap', () => {
  test('plans mount resolve-or-create then parent-first creates; Collection root gets no bookmark children', async () => {
    const { store, coordinator } = await setup();
    const view = await coordinator.confirm(baseConfirm({
      localFacts: [bookmark('bm-1', 'https://example.com/one')],
      remoteFacts: [root], mounts: [barMount()], rootNodeId: 'folder-root',
    }));
    assert.equal(view.run.mountResolveRequest, 'bookmarks-bar');
    assert.equal(view.report?.emptyRemote, true);
    assertOpaquePlanned(view.report?.planned);
    const queued = await store.listQueue(scope);
    assert.ok(queued.every((row) => row.payload.type !== 'delete_node'));
    assert.equal(queued.length, 1);
    assertOpaqueQueued(queued);
    assertStampedColp(queued);
    const mountOp = queued[0]!.payload as { type: string; payload: { parentId: string; node: { folderRole?: string; kind: string } } };
    assert.equal(mountOp.type, 'create_node');
    assert.equal(mountOp.payload.parentId, 'folder-root');
    assert.equal(mountOp.payload.node.folderRole, 'bookmarks-bar');
    assert.equal(mountOp.payload.node.kind, 'folder');
    assert.ok(view.report?.planned.every((op) => !(op.reason === 'local-only' && op.parentId === 'folder-root'
      && op.node?.kind === 'bookmark')));
    await bindRemoteMount(store, 'mount-bar');
    const resumed = await coordinator.advance(view.run.runId, baseConfirm({
      localFacts: [bookmark('bm-1', 'https://example.com/one')],
      remoteFacts: [root], mounts: [barMount('mount-bar')], rootNodeId: 'folder-root',
    }));
    const after = await store.listQueue(scope);
    assert.equal(after.length, 2);
    assertOpaqueQueued(after);
    assertStampedColp(after);
    const child = after.find((row) => row.opId.includes('.create.'))!.payload as {
      type: string; payload: { parentId: string; node: { url?: string } } };
    assert.equal(child.payload.parentId, 'mount-bar');
    assert.equal(child.payload.node.url, 'https://example.com/one');
    assert.notEqual(resumed.run.phase, 'confirmed');
  });

  test('terminal mount-resolve receipt enqueues children without bindRemoteMount', async () => {
    const { store, coordinator } = await setup();
    const facts = [bookmark('bm-1', 'https://example.com/one')];
    const input = baseConfirm({
      localFacts: facts, remoteFacts: [root], mounts: [barMount()], rootNodeId: 'folder-root',
    });
    const view = await coordinator.confirm(input);
    const queued = await store.listQueue(scope);
    assert.equal(queued.length, 1);
    const mountOp = queued[0]!;
    assert.equal(await store.getMappingByNativeId(scope, 'bar'), null);
    await store.completeQueueWithReceipt(scope, mountOp.sequence, {
      opId: mountOp.opId, operationDigest: mountOp.digest, kind: 'terminal',
      receiptId: 'receipt-mount-bar', resultDigest: 'sha256:mount-result',
      result: { results: [{ opId: mountOp.opId, sequence: mountOp.sequence, status: 'applied',
        targetId: 'mount-bar', revision: 'rev-mount-1' }] },
    });
    const resumed = await coordinator.resume(baseConfirm({
      localFacts: facts, remoteFacts: [root], mounts: [barMount()], rootNodeId: 'folder-root',
    }));
    assert.ok(resumed);
    const after = await store.listQueue(scope);
    assert.equal(after.length, 2);
    assertOpaqueQueued(after);
    assertStampedColp(after);
    const child = after.find((row) => row.opId.includes('.create.'))!.payload as {
      type: string; payload: { parentId: string; node: { url?: string } } };
    assert.equal(child.payload.parentId, 'mount-bar');
    assert.equal(child.payload.node.url, 'https://example.com/one');
    assert.equal((await store.listMountBindings(scope))[0]?.remoteMountNodeId, 'mount-bar');
    assert.notEqual(resumed.run.phase, 'confirmed');
    const again = await coordinator.confirm(baseConfirm({
      localFacts: facts, remoteFacts: [root], mounts: [barMount()], rootNodeId: 'folder-root',
    }));
    assert.equal(again.run.runId, view.run.runId);
    assert.equal((await store.listQueue(scope)).length, 2);
    assert.deepEqual((await store.listQueue(scope)).map((row) => row.opId).sort(),
      after.map((row) => row.opId).sort());
  });

  test('Push drain of mount-resolve stays terminal then resume enqueues children', async () => {
    const { store, coordinator } = await setup();
    const facts = [bookmark('bm-1', 'https://example.com/one')];
    await coordinator.confirm(baseConfirm({
      localFacts: facts, remoteFacts: [root], mounts: [barMount()], rootNodeId: 'folder-root',
    }));
    const mountOp = (await store.listQueue(scope))[0]!;
    const sessions: PushSessionController = { async get() { return {
      credential: { accessToken: 'access-token-push' }, session: { sessionId: 'session-push',
        expiresAt: '2099-01-01T00:00:00Z', scope: 'collection', snapshotRequired: false,
        credentialAuthorityDigest: 'a'.repeat(64),
        collection: { collectionId: scope.collectionId, serverCursor: 'cursor-0', serverRevision: 'revision-0' },
        replicaLease: { leaseId: 'lease-server', generation: '1', state: 'active',
          expiresAt: '2099-01-01T00:00:00Z' } } }; } };
    const drain = await createOutboundPushWorker({
      scope, store, endpoints: async () => ({
        syncSessions: 'https://known.example/v1/session', syncSnapshot: 'https://known.example/v1/snapshot',
        syncPush: 'https://known.example/v1/push', syncPull: 'https://known.example/v1/pull',
        syncAck: 'https://known.example/v1/ack', syncConflict: 'https://known.example/v1/conflicts/{conflictId}',
        syncEffectPages: 'https://known.example/v1/effects/{effectId}/pages/{pageNumber}',
        effectPageAuthority: 'https://known.example', syncRetire: 'https://known.example/v1/retire',
      }),
      sessions, now: () => 10_000, random: () => 0, ownerId: () => 'owner-push', schedule: () => undefined,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          batchId: body.batchId, results: [{ opId: mountOp.opId, sequence: mountOp.sequence, status: 'applied',
            targetId: 'mount-bar', revision: 'rev-mount-1', cursor: 'cursor-1', warnings: [] }],
          serverCursor: 'cursor-1',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    }).drain();
    assert.equal(drain.outcome, 'terminal');
    assert.equal((await store.listQueue(scope))[0]?.status, 'terminal');
    const resumed = await coordinator.resume(baseConfirm({
      localFacts: facts, remoteFacts: [root], mounts: [barMount()], rootNodeId: 'folder-root',
    }));
    assert.ok(resumed);
    const child = (await store.listQueue(scope)).find((row) => row.opId.includes('.create.'))!.payload as {
      payload: { parentId: string; node: { url?: string } } };
    assert.equal(child.payload.parentId, 'mount-bar');
    assert.equal(child.payload.node.url, 'https://example.com/one');
    assert.equal((await store.listMountBindings(scope))[0]?.remoteMountNodeId, 'mount-bar');
    assert.equal((await store.listMountBindings(scope))[0]?.status, 'active');
    assertOpaqueQueued(await store.listQueue(scope));
    assertStampedColp(await store.listQueue(scope));
  });

  test('coordinator rematch activates a worker-bound pending mount', async () => {
    const { store, coordinator } = await setup();
    await coordinator.confirm(baseConfirm({
      localFacts: [bookmark('bm-1', 'https://example.com/one')],
      remoteFacts: [root], mounts: [barMount()], rootNodeId: 'folder-root',
    }));
    const current = (await store.listMountBindings(scope))[0]!;
    await store.putMountBinding(scope, {
      mountId: current.mountId, nativeRootId: current.nativeRootId, remoteMountNodeId: 'mount-bar',
      boundaryVersion: current.boundaryVersion, materialized: current.materialized, status: 'pending',
      ...(current.rootRole ? { rootRole: current.rootRole } : {}),
    });
    await coordinator.resume(baseConfirm({
      localFacts: [bookmark('bm-1', 'https://example.com/one')],
      remoteFacts: [root], mounts: [barMount()], rootNodeId: 'folder-root',
    }));
    assert.equal((await store.listMountBindings(scope))[0]?.remoteMountNodeId, 'mount-bar');
    assert.equal((await store.listMountBindings(scope))[0]?.status, 'active');
  });

  test('mapping of the mount native root enqueues children without bindRemoteMount', async () => {
    const { store, coordinator } = await setup();
    await store.putMapping(scope, {
      nativeId: 'bar', colpId: 'mount-bar', rootNativeId: 'bar', nodeKind: 'folder',
      rootRole: 'bookmarks-bar',
      projection: { revision: 'rev-mount-1', digest: 'sha256:mount-bar',
        content: { folderRole: 'bookmarks-bar', title: 'bookmarks-bar' } },
    });
    const view = await coordinator.confirm(baseConfirm({
      localFacts: [bookmark('bm-1', 'https://example.com/one')],
      remoteFacts: [root], mounts: [barMount()], rootNodeId: 'folder-root',
    }));
    const queued = await store.listQueue(scope);
    assert.equal(queued.filter((row) => row.payload.type === 'create_node'
      && (row.payload.payload as { node?: { folderRole?: string } }).node?.folderRole === 'bookmarks-bar').length, 0);
    const child = queued.find((row) => row.opId.includes('.create.'))!.payload as {
      payload: { parentId: string; node: { url?: string } } };
    assert.equal(child.payload.parentId, 'mount-bar');
    assert.equal(child.payload.node.url, 'https://example.com/one');
    assert.equal((await store.listMountBindings(scope))[0]?.remoteMountNodeId, 'mount-bar');
    assertOpaqueQueued(queued);
    assertStampedColp(queued);
    assert.notEqual(view.run.phase, 'confirmed');
  });

  test('same confirmationId returns the same runId', async () => {
    const { coordinator } = await setup();
    const first = await coordinator.confirm(baseConfirm({ confirmationId: 'conf-1' }));
    const second = await coordinator.confirm(baseConfirm({ confirmationId: 'conf-1' }));
    assert.equal(second.run.runId, first.run.runId);
  });

  test('preview-only matching writes zero queue rows', async () => {
    const { store, coordinator } = await setup();
    const view = await coordinator.confirm(baseConfirm({
      previewOnly: true, localFacts: [bookmark('bm-1', 'https://example.com/one')],
      remoteFacts: [root], pauseAfter: 'matching',
    }));
    assert.equal((await store.listQueue(scope)).length, 0);
    assert.equal(view.report?.planned.length, 0);
    assert.equal(view.run.previewOnly, true);
    assert.equal(view.run.phase, 'matching');
  });

  test('download overlay plan is visible and unconfirmed deletes are not enqueued', async () => {
    const { store, coordinator } = await setup();
    const view = await coordinator.confirm(baseConfirm({
      bootstrapMode: 'download', localFacts: [bookmark('bm-1', 'https://example.com/one')],
      remoteFacts: [root, { nodeId: 'mount-bar', parentId: 'folder-root', kind: 'folder', title: 'Bar',
        folderRole: 'bookmarks-bar', revision: 'rev-bar-1' }],
      mounts: [barMount('mount-bar')],
    }));
    assert.equal(view.report?.destructivePlan?.requiresConfirmation, true);
    assert.equal(view.report?.destructivePlan?.confirmed, false);
    assert.ok((view.report?.destructivePlan?.deletes.length ?? 0) > 0);
    assert.equal((await store.listQueue(scope)).filter((row) => row.payload.type === 'delete_node').length, 0);
    const mirror = await coordinator.confirm(baseConfirm({
      confirmationId: 'conf-mirror', bootstrapMode: 'mirror',
      localFacts: [bookmark('bm-1', 'https://example.com/one')],
      remoteFacts: [root, { nodeId: 'mount-bar', parentId: 'folder-root', kind: 'folder', title: 'Bar',
        folderRole: 'bookmarks-bar', revision: 'rev-bar-1' }],
      mounts: [barMount('mount-bar')],
    }));
    assert.equal(mirror.report?.destructivePlan?.requiresConfirmation, true);
    assert.equal(mirror.report?.destructivePlan?.confirmed, false);
    assert.equal((await store.listQueue(scope)).filter((row) => row.payload.type === 'delete_node').length, 0);
  });

  test('resumes after a parent batch pause without duplicating opIds', async () => {
    const { store, coordinator } = await setup();
    const input = baseConfirm({
      localFacts: [bookmark('bm-1', 'https://example.com/one'), bookmark('bm-2', 'https://example.com/two')],
      remoteFacts: [root], pauseAfter: 'enqueue:1',
    });
    const paused = await coordinator.confirm(input);
    assert.equal((await store.listQueue(scope)).length, 1);
    await bindRemoteMount(store, 'mount-bar');
    const resumed = await coordinator.advance(paused.run.runId, { ...input, pauseAfter: undefined,
      mounts: [barMount('mount-bar')] });
    const opIds = (await store.listQueue(scope)).map((row) => row.opId);
    assert.equal(new Set(opIds).size, opIds.length);
    assert.ok(opIds.length >= 2);
    assert.equal(resumed.queuedOpIds.length, opIds.length);
  });

  test('receipt-loss replay keeps a single queue row for the same opId', async () => {
    const { store, coordinator } = await setup();
    await coordinator.confirm(baseConfirm({ confirmationId: 'conf-retry' }));
    const first = await store.listQueue(scope);
    await coordinator.confirm(baseConfirm({ confirmationId: 'conf-retry' }));
    const second = await store.listQueue(scope);
    assert.equal(second.length, first.length);
    assert.deepEqual(second.map((row) => row.opId), first.map((row) => row.opId));
    assert.deepEqual(second.map((row) => row.digest), first.map((row) => row.digest));
    assertStampedColp(second);
  });

  test('restart reopens the same run cursor and does not create a second sequence', async () => {
    const { store, coordinator } = await setup();
    const view = await coordinator.confirm(baseConfirm({ pauseAfter: 'enqueue:1' }));
    const before = (await store.listQueue(scope)).map((row) => row.sequence);
    store.close();
    const reopened = createSyncStateStore({ indexedDB });
    const resumed = createBootstrapCoordinator({ store: reopened, scope, now: () => 50, randomUUID: () => 'run-x' });
    await resumed.advance(view.run.runId, baseConfirm({ pauseAfter: 'enqueue:1' }));
    const after = (await reopened.listQueue(scope)).map((row) => row.sequence);
    assert.deepEqual(after, before);
  });

  test('legacy remount failure stays confirmed with a retry reason', async () => {
    const store = createSyncStateStore({ indexedDB });
    await active(store, { legacyCanonicalRoot: 'colp-root' });
    const coordinator = createBootstrapCoordinator({
      store, scope, now: () => 10, randomUUID: () => 'run-legacy',
      retireLegacy: async () => { throw new Error('queue_not_drained'); },
    });
    const view = await coordinator.confirm(baseConfirm({}));
    assert.equal(view.run.phase, 'confirmed');
    assert.equal(view.run.retryReason, 'queue_not_drained');
    assert.equal((await store.listQueue(scope)).length, 0);
  });

  test('libraryDraft without rootNodeId requests mount resolve and does not fake remote success', async () => {
    const { store, coordinator } = await setup();
    const view = await coordinator.confirm(baseConfirm({
      libraryDraftTitle: 'New library', rootNodeId: null, remoteFacts: [],
      localFacts: [bookmark('bm-1', 'https://example.com/one')],
    }));
    assert.ok(view.run.mountResolveRequest?.includes('bookmarks-bar'));
    assert.equal((await store.listQueue(scope)).length, 0);
    assert.equal(view.report?.planned.some((op) => op.reason === 'mount-resolve' && op.parentId), false);
  });

  test('status projects durable phase; preview_stale helper carries new counts', async () => {
    const { coordinator } = await setup();
    await coordinator.confirm(baseConfirm({ pauseAfter: 'confirmed' }));
    const status = await coordinator.status();
    assert.equal(status.phase, 'confirmed');
    assert.equal(status.firstRun, 'running');
    assert.deepEqual(previewStaleFromScan({ bookmarkCount: 3, folderCount: 1, skippedCount: 0 }), {
      ok: false, error: 'preview_stale', bookmarkCount: 3, folderCount: 1, skippedCount: 0,
    });
  });

  test('coordinator and matcher never call Chrome bookmark APIs', async () => {
    const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
    for (const relative of ['src/bootstrap/coordinator.ts', 'src/bootstrap/matcher.ts',
      'src/bootstrap/local-facts.ts']) {
      const source = await readFile(join(rootDir, relative), 'utf8');
      assert.doesNotMatch(source, /chrome\.bookmarks/);
      assert.doesNotMatch(source, /fetch\(/);
    }
    const coordinator = await readFile(join(rootDir, 'src/bootstrap/coordinator.ts'), 'utf8');
    assert.match(coordinator,
      /const done = queued\.caughtUp && !pendingMount && !waitingParent && !inboxPending/u);
    assert.doesNotMatch(coordinator, /void inboxPending/u);
    const firstRun = await readFile(join(rootDir, 'src/sw/first-run.ts'), 'utf8');
    assert.match(firstRun, /known\.firstRun\.confirm/);
    assert.match(firstRun, /previewStaleFromScan/);
    assert.match(firstRun, /scan\.treeDigest !== preview\.treeDigest/);
    assert.match(firstRun, /Read-only digest rescan/);
    assert.match(firstRun, /overlayMountsFromBindings/);
    assert.match(firstRun, /row\?\.remoteMountNodeId \?\? mount\.remoteMountNodeId/);
    assert.doesNotMatch(firstRun, /bookmarks\.(create|update|move|remove)/);
    assert.doesNotMatch(firstRun, /scheduleSyncEngineWake|from '\.\/engine\.js'/);
  });

});
