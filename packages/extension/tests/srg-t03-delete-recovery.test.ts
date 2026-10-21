import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import {
  classifyBookmarkApiFailure, CHROME_BOOKMARK_NOT_FOUND, lookupBookmark,
} from '../src/bookmark-api-error.js';
import { createChromePullBookmarkApi } from '../src/pull-bookmark-api.js';
import { createOutboundPushWorker, type PushSessionController } from '../src/outbound-push-worker.js';
import { keepLocalFromDecision } from '../src/remote-delete-apply.js';
import { recoverPendingNativeSideEffects } from '../src/native-repair.js';
import { endpoints } from './kns-04-push-harness.js';
import { json } from './outbound-push-worker-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import {
  mapping, reopenT03, seedMappedNode, setupT03, t03Scope, type HonestChrome,
} from './srg-t03-delete-harness.js';
import type { BookmarkEventApi } from '../src/bookmark-event-queue.js';
import type { JsonObject } from '../src/sync-state-store.js';

function bookmarkApi(api: HonestChrome): BookmarkEventApi {
  return {
    get: async (id) => (await api.get(id)).map((node) => ({ ...node, title: node.title ?? '' })),
    getChildren: async (id) => (await api.getChildren(id)).map((node) => ({ ...node, title: node.title ?? '' })),
  };
}

type T03Fixture = Awaited<ReturnType<typeof setupT03>>;

/**
 * The KNS-04 push options, bound to the T-03 scope: `pushOptions` in the KNS-04
 * harness pins its own scope, so the session it mints would fail the worker's
 * scope assertion here.
 */
function pushOptions(store: T03Fixture['store'], clock: { now: number }) {
  const sessions: PushSessionController = { async get() { return {
    credential: { accessToken: 'access-token-t03-push' },
    session: { sessionId: 'session-t03-push', expiresAt: '2099-01-01T00:00:00Z', scope: 'collection',
      snapshotRequired: false, credentialAuthorityDigest: 'a'.repeat(64),
      collection: { collectionId: t03Scope.collectionId, serverCursor: 'cursor-old', serverRevision: 'revision-old' },
      replicaLease: { leaseId: 'lease-t03', generation: '1', state: 'active',
        expiresAt: '2099-01-01T00:00:00Z' } } }; } };
  return { scope: t03Scope, store, endpoints: async () => endpoints, sessions, now: () => clock.now,
    random: () => 0, ownerId: () => 'owner-t03-push', schedule: () => undefined };
}

/** A fully stamped create operation, because the wire rejects an unstamped payload as out of scope. */
async function enqueueCreate(fixture: T03Fixture, opId: string, sequence: number, parentId: string) {
  const operation: JsonObject = { opId, replicaId: t03Scope.replicaId, sequence,
    collectionId: t03Scope.collectionId, type: 'create_node', baseRevision: null,
    occurredAt: '2026-07-27T00:00:00.000Z', dependencies: [],
    payload: { parentId, node: { kind: 'bookmark', title: 'Already queued', url: 'https://example.test/queued' } } };
  return fixture.store.allocateSequenceAndEnqueue(t03Scope, { opId, batchId: `batch-${opId}`,
    idempotencyKey: `key-${opId}`, digest: `sha256:${opId}`, endpointIdentity: 'syncPush',
    mediaType: 'application/json', baseRevision: null, operationRevision: `local-${opId}`,
    status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload: operation }, { allowUnstamped: true });
}

function diagnosticRecords(fixture: T03Fixture) {
  return fixture.store.exportDiagnostics().then((exported) =>
    exported.records as readonly Record<string, unknown>[]);
}

const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');

describe('T-03 delete recovery and retained copies (SRG-04/07 / C-02/C-05)', () => {
  test('adapter classifies Chromium not_found vs permission vs managed vs other', async () => {
    const bookmarks = {
      async get(id: string) {
        if (id === 'missing') throw new Error(CHROME_BOOKMARK_NOT_FOUND);
        if (id === 'denied') throw new Error('User denied permission to modify bookmarks.');
        if (id === 'managed') throw new Error("Can't modify a managed bookmark.");
        if (id === 'other') throw new Error('bookmark backend unavailable');
        return [{ id }];
      },
      async getChildren() { return []; },
      async create() { return { id: 'n' }; },
      async update() { return {}; },
      async move() { return {}; },
      async remove() { },
      async removeTree() { },
    };
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { bookmarks } });
    try {
      const api = createChromePullBookmarkApi();
      await assert.rejects(() => api.get('missing'), (error: unknown) =>
        classifyBookmarkApiFailure(error) === 'not_found');
      await assert.rejects(() => api.get('denied'), (error: unknown) =>
        classifyBookmarkApiFailure(error) === 'permission_denied');
      await assert.rejects(() => api.get('managed'), (error: unknown) =>
        classifyBookmarkApiFailure(error) === 'managed_not_writable');
      await assert.rejects(() => api.get('other'), (error: unknown) =>
        classifyBookmarkApiFailure(error) === 'other_failure');
      assert.deepEqual(await api.get('present'), [{ id: 'present' }]);
      const empty = await lookupBookmark(async () => [], 'ghost');
      assert.equal(empty.class, 'other_failure');
      assert.notEqual(empty.class, 'not_found');
    } finally {
      if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome);
      else delete (globalThis as { chrome?: unknown }).chrome;
    }
  });

  test('D-01 AUD-01: interrupt between Chrome delete and mapping persist, reopen completes mapping/cursor/Ack', async () => {
    const fixture = await setupT03('after_browser_call');
    await seedMappedNode(fixture, {
      nativeId: 'native-node', colpId: 'node-1', parentNativeId: 'native-root',
      parentColpId: 'root-colp', nodeKind: 'bookmark', url: 'https://example.test/',
    });
    await fixture.applier.stage(fixture.page([fixture.mutationEvent('delete')]));
    await assert.rejects(() => fixture.applier.resume(), /worker_crash/);
    await assert.rejects(() => fixture.api.get('native-node'), (error: unknown) =>
      error instanceof Error && error.message === CHROME_BOOKMARK_NOT_FOUND);
    assert.ok(await fixture.store.getMappingByNativeId(t03Scope, 'native-node'));
    const interrupted = (await fixture.store.listPullEvents(t03Scope))
      .map((event) => event.state);
    assert.ok(interrupted.includes('native_event_observed') || interrupted.includes('browser_call_started'));
    fixture.disableCrash();
    const resumed = await reopenT03(fixture);
    await resumed.applier.resume();
    assert.equal(await resumed.store.getMappingByNativeId(t03Scope, 'native-node'), null);
    const facts = await resumed.store.exportScope(t03Scope);
    assert.equal(facts.cursor?.cursor, 'cursor-next');
    assert.equal(facts.pullPages[0]?.state, 'page_complete');
    const states = (await resumed.store.listPullEvents(t03Scope)).map((event) => event.state);
    assert.ok(states.every((state) => state === 'page_complete' || state === 'authority_committed'));
  });

  test('D-02: recursive 3-level subtree interrupts after each member and never invents descendant deletes', async () => {
    const fixture = await setupT03('after_delete_member');
    await seedMappedNode(fixture, {
      nativeId: 'native-l1', colpId: 'node-1', parentNativeId: 'native-root',
      parentColpId: 'root-colp', nodeKind: 'folder',
    });
    await seedMappedNode(fixture, {
      nativeId: 'native-l2', colpId: 'node-2', parentNativeId: 'native-l1',
      parentColpId: 'node-1', nodeKind: 'folder',
    });
    await seedMappedNode(fixture, {
      nativeId: 'native-l3', colpId: 'node-3', parentNativeId: 'native-l2',
      parentColpId: 'node-2', nodeKind: 'bookmark', url: 'https://example.test/l3',
    });
    await fixture.applier.stage(fixture.page([
      fixture.subtreeEvent(['node-1', 'node-2', 'node-3']),
    ]));
    await assert.rejects(() => fixture.applier.resume(), /worker_crash/);
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'delete').length, 1);
    assert.ok(fixture.api.getNode('native-l1'));
    assert.ok(fixture.api.getNode('native-l2'));
    assert.equal(fixture.api.getNode('native-l3'), undefined);
    assert.ok(await fixture.store.getMappingByNativeId(t03Scope, 'native-l1'));
    assert.ok(await fixture.store.getMappingByNativeId(t03Scope, 'native-l2'));
    fixture.setCrash('after_delete_member');
    const second = await reopenT03(fixture);
    await assert.rejects(() => second.applier.resume(), /worker_crash/);
    assert.ok(second.api.getNode('native-l1'));
    assert.equal(second.api.getNode('native-l2'), undefined);
    assert.ok(await second.store.getMappingByNativeId(t03Scope, 'native-l1'));
    second.disableCrash();
    const third = await reopenT03(second);
    await third.applier.resume();
    assert.equal(third.api.getNode('native-l1'), undefined);
    assert.equal(third.api.getNode('native-l2'), undefined);
    assert.equal(third.api.getNode('native-l3'), undefined);
    assert.equal(await third.store.getMappingByNativeId(t03Scope, 'native-l1'), null);
    assert.equal(await third.store.getMappingByNativeId(t03Scope, 'native-l2'), null);
    assert.equal(await third.store.getMappingByNativeId(t03Scope, 'native-l3'), null);
    assert.equal((await third.store.exportScope(t03Scope)).cursor?.cursor, 'cursor-next');
  });

  test('D-03: keep extra then create rebases an in-flight row off the tombstoned parent; queue rows stay (A-06)', async () => {
    const fixture = await setupT03();
    await seedMappedNode(fixture, {
      nativeId: 'native-node', colpId: 'node-1', parentNativeId: 'native-root',
      parentColpId: 'root-colp', nodeKind: 'folder',
    });
    await seedMappedNode(fixture, {
      nativeId: 'native-child', colpId: 'node-child', parentNativeId: 'native-node',
      parentColpId: 'node-1', nodeKind: 'bookmark', url: 'https://example.test/',
    });
    fixture.api.seed({
      id: 'native-extra', parentId: 'native-node', index: 1, title: 'extra',
      url: 'https://example.test/extra',
    });
    // A fully stamped row: an unstamped payload is refused as out of scope before
    // it could ever reach the placement rebase this case exercises.
    await enqueueCreate(fixture, 'queued-tombstone-parent', 1, 'node-1');
    await fixture.applier.stage(fixture.page([
      fixture.subtreeEvent(['node-1', 'node-child']),
    ]));
    await fixture.applier.resume();
    assert.ok(fixture.api.getNode('native-extra'));
    assert.ok(fixture.api.getNode('native-node'));
    assert.equal(fixture.api.getNode('native-child'), undefined);
    assert.equal(await fixture.store.getMappingByNativeId(t03Scope, 'native-node'), null);
    const exclusion = await fixture.store.getLocalSyncExclusion(t03Scope, 'native-node');
    assert.ok(exclusion);
    assert.equal(exclusion.priorColpId, 'node-1');
    const virtual = await fixture.store.getMappingByColpId(t03Scope, 'node-1');
    assert.ok(virtual?.nativeId.startsWith('unmounted:'));
    const tombstone = await fixture.store.getRemoteObservation(t03Scope, 'node-1');
    assert.equal(tombstone?.kind, 'tombstone');
    const queuedBefore = await fixture.store.listQueue(t03Scope);
    assert.equal(queuedBefore.some((row) => row.opId === 'queued-tombstone-parent'), true);
    await recoverPendingNativeSideEffects(fixture.store, t03Scope, fixture.api);
    // The repair pass is fence-free: it names the stranded row and leaves its
    // bytes to the fenced drain instead of writing into another worker's claim.
    const afterRepair = (await fixture.store.listQueue(t03Scope))
      .find((row) => row.opId === 'queued-tombstone-parent');
    assert.ok(afterRepair, 'the queue row is never deleted (sequence-hole contract)');
    assert.equal((afterRepair!.payload.payload as { parentId?: string }).parentId, 'node-1');
    const repairDiagnostic = (await diagnosticRecords(fixture)).find((row) =>
      row.kind === 'tombstoned_parent_rebase' && row.code === 'tombstoned_parent_deferred');
    assert.ok(repairDiagnostic, 'the repair pass must leave a durable diagnostic, not an empty scan');
    assert.deepEqual(repairDiagnostic.details, { count: 1,
      rows: [{ opId: 'queued-tombstone-parent', sequence: 1, parentId: 'node-1' }] });
    fixture.api.seed({
      id: 'new-local', parentId: 'native-node', index: 2, title: 'New after remote delete',
      url: 'https://example.test/new',
    });
    const queue = createBookmarkEventQueue({
      scope: t03Scope, store: fixture.store, api: bookmarkApi(fixture.api), autoFlush: false,
    });
    const capture = await queue.created('new-local', {
      id: 'new-local', parentId: 'native-node', index: 2, title: 'New after remote delete',
      url: 'https://example.test/new',
    });
    assert.equal(capture.outcome, 'filtered');
    await queue.flush();
    const created = (await fixture.store.listQueue(t03Scope))
      .filter((row) => row.payload.type === 'create_node' && row.opId !== 'queued-tombstone-parent');
    assert.equal(created.some((row) => {
      const payload = row.payload.payload;
      return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        && payload.parentId === 'node-1';
    }), false);
    // A-06: the row that was already in flight when the parent was deleted must
    // not upload the tombstoned colpId; it is re-anchored on the mount node and
    // stays in the queue (settled) instead of being deleted.
    const clock = { now: 10_000 };
    const bodies: string[] = [];
    const worker = createOutboundPushWorker({ ...pushOptions(fixture.store, clock),
      fetch: async (_url, init) => {
        bodies.push(String(init?.body));
        return json(200, { batchId: JSON.parse(String(init?.body)).batchId,
          results: [{ opId: 'queued-tombstone-parent', sequence: 1, status: 'applied',
            targetId: 'server-queued', revision: 'server-queued-r1', cursor: 'cursor-push-1', warnings: [] }],
          serverCursor: 'cursor-push-1' });
      } });
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.equal(bodies.length, 1);
    assert.doesNotMatch(bodies[0]!, /"parentId":"node-1"/);
    const sent = JSON.parse(bodies[0]!) as { operations: Array<{ opId: string; sequence: number;
      payload: { parentId: string } }> };
    assert.equal(sent.operations[0]!.opId, 'queued-tombstone-parent');
    assert.equal(sent.operations[0]!.payload.parentId, 'root-colp');
    const queuedAfter = (await fixture.store.listQueue(t03Scope))
      .find((row) => row.opId === 'queued-tombstone-parent');
    assert.ok(queuedAfter, 'the rebased row is settled in place, never deleted');
    assert.equal(queuedAfter!.status, 'terminal');
    assert.equal((queuedAfter!.payload.payload as { parentId?: string }).parentId, 'root-colp');
    assert.equal(queuedAfter!.idempotencyKey, 'queued-tombstone-parent.rebase.0');
  });

  test('D-03b: a tombstoned create parent with no legal anchor settles rejected with a diagnostic (A-06)', async () => {
    const fixture = await setupT03();
    await seedMappedNode(fixture, {
      nativeId: 'native-node', colpId: 'node-1', parentNativeId: 'native-root',
      parentColpId: 'root-colp', nodeKind: 'folder',
    });
    // The durable tombstone fact on its own: no keep-local pass has run, so the
    // mapping is not `unmounted:` yet and the observation is the only evidence.
    await fixture.store.putRemoteObservation(t03Scope, { colpId: 'node-1', remoteRevision: 'revision-deleted',
      cursor: 'cursor-deleted', kind: 'tombstone', payload: { deleted: true },
      sourceDigest: 'sha256:tombstone-node-1', observedAt: 20 });
    await fixture.store.detachMount(t03Scope, 'mount-bar');
    await enqueueCreate(fixture, 'queued-no-anchor', 1, 'node-1');
    const clock = { now: 10_000 };
    let calls = 0;
    const worker = createOutboundPushWorker({ ...pushOptions(fixture.store, clock), fetch: async () => {
      calls += 1;
      return json(200, { batchId: 'unexpected', results: [], serverCursor: 'cursor-push-1' });
    } });
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.equal(calls, 0, 'an unanchorable row settles before any request is bound');
    const row = (await fixture.store.listQueue(t03Scope)).find((item) => item.opId === 'queued-no-anchor');
    assert.ok(row, 'the rejected settlement keeps the row (sequence-hole contract)');
    assert.equal(row!.status, 'rejected');
    assert.equal(row!.recovery?.code, 'tombstoned_parent_no_anchor');
    assert.equal((row!.payload.payload as { parentId?: string }).parentId, 'node-1');
    const noAnchor = (await diagnosticRecords(fixture)).find((item) =>
      item.kind === 'tombstoned_parent_rebase' && item.code === 'tombstoned_parent_no_anchor');
    assert.ok(noAnchor, 'settling the row must leave a durable diagnostic');
    assert.deepEqual(noAnchor.details, { opId: 'queued-no-anchor', parentId: 'node-1' });
    // The settlement pins this row only — it writes no scope-level escalation.
    // Whether the engine then skips its freeze cycle is A-04's joint check.
    assert.equal((await fixture.store.getScope(t03Scope))?.lifecycle, 'active');
  });

  test('D-03c: a recovery-placeholder parent is not a tombstone and the create row is not rewritten (A-06)', async () => {
    const fixture = await setupT03();
    // `recovery:` is a node awaiting materialization and `isNonChromeNativeId`
    // calls it virtual, but the remote node is *not* gone: re-anchoring (or
    // rejecting) this create would break `kns-04-push-bootstrap`'s mount-bound
    // child. Only `unmounted:` may count as the tombstone fact.
    await fixture.store.putMapping(t03Scope, { nativeId: 'recovery:mount-bar', colpId: 'mount-colp',
      rootNativeId: 'recovery:root', nodeKind: 'folder',
      projection: { revision: 'snapshot-r1', digest: 'sha256:snapshot',
        content: { title: 'Bar', folderRole: 'bookmarks-bar' } } });
    const queued = await enqueueCreate(fixture, 'queued-live-parent', 1, 'mount-colp');
    const clock = { now: 10_000 };
    const bodies: string[] = [];
    const worker = createOutboundPushWorker({ ...pushOptions(fixture.store, clock),
      fetch: async (_url, init) => {
        bodies.push(String(init?.body));
        return json(200, { batchId: JSON.parse(String(init?.body)).batchId,
          results: [{ opId: 'queued-live-parent', sequence: 1, status: 'applied',
            targetId: 'server-child-1', revision: 'server-child-r1', cursor: 'cursor-1', warnings: [] }],
          serverCursor: 'cursor-1' });
      } });
    assert.equal((await worker.drain()).outcome, 'terminal');
    const sent = JSON.parse(bodies[0]!) as { operations: Array<{ payload: { parentId: string } }> };
    assert.equal(sent.operations[0]!.payload.parentId, 'mount-colp');
    const row = (await fixture.store.listQueue(t03Scope))[0]!;
    assert.equal(row.status, 'terminal');
    assert.equal(row.payload.payload && (row.payload.payload as { parentId?: string }).parentId, 'mount-colp');
    // Zero rewrite: a non-tombstoned parent keeps the authored digest, identity
    // and revision, so receipts stay bound to the bytes the ingress produced.
    assert.equal(row.digest, queued.digest);
    assert.equal(row.idempotencyKey, 'key-queued-live-parent');
    assert.equal(row.operationRevision, 'local-queued-live-parent');
    assert.equal(row.baseRevision, null);
    assert.equal((await diagnosticRecords(fixture)).some((item) => item.kind === 'tombstoned_parent_rebase'), false);
  });

  test('D-04: empty-folder, subtree, confirm/keep_local, self-echo use legal effects and unmap keep-local', async () => {
    const empty = await setupT03();
    await seedMappedNode(empty, {
      nativeId: 'native-empty', colpId: 'empty-colp', parentNativeId: 'native-root',
      parentColpId: 'root-colp', nodeKind: 'folder',
    });
    await empty.applier.stage(empty.page([
      pullFixtures.mutationEvent({
        kind: 'delete', sequence: 1, collectionId: t03Scope.collectionId,
        targetId: 'empty-colp', parentId: 'root-colp', targetKind: 'folder',
      }),
    ]));
    await empty.applier.resume();
    assert.equal(empty.api.getNode('native-empty'), undefined);
    assert.equal(await empty.store.getMappingByNativeId(t03Scope, 'native-empty'), null);
    assert.equal((await empty.store.exportScope(t03Scope)).cursor?.cursor, 'cursor-next');

    const tree = await setupT03();
    await seedMappedNode(tree, {
      nativeId: 'native-node', colpId: 'node-1', parentNativeId: 'native-root',
      parentColpId: 'root-colp', nodeKind: 'folder',
    });
    await seedMappedNode(tree, {
      nativeId: 'native-child', colpId: 'node-child', parentNativeId: 'native-node',
      parentColpId: 'node-1', nodeKind: 'bookmark', url: 'https://example.test/',
    });
    await tree.applier.stage(tree.page([tree.subtreeEvent(['node-1', 'node-child'])]));
    await tree.applier.resume();
    assert.equal(tree.api.getNode('native-node'), undefined);
    assert.equal(tree.api.getNode('native-child'), undefined);
    assert.equal((await tree.store.exportScope(t03Scope)).cursor?.cursor, 'cursor-next');

    const keep = await setupT03();
    await seedMappedNode(keep, {
      nativeId: 'native-node', colpId: 'node-1', parentNativeId: 'native-root',
      parentColpId: 'root-colp', nodeKind: 'folder',
    });
    await seedMappedNode(keep, {
      nativeId: 'native-child', colpId: 'node-child', parentNativeId: 'native-node',
      parentColpId: 'node-1', nodeKind: 'bookmark', url: 'https://example.test/',
    });
    await keep.store.setRemoteDeletePolicy(t03Scope, { policy: 'keep_local', expectedCasVersion: 0, now: 10 });
    await keep.applier.stage(keep.page([keep.subtreeEvent(['node-1', 'node-child'])]));
    await keep.applier.resume();
    const pending = (await keep.store.listRemoteDeleteDecisions(t03Scope, ['keep_local', 'pending']))[0];
    if (pending?.state === 'pending') {
      const raw = await keep.store.getPullEvent(t03Scope, pending.eventId);
      await keepLocalFromDecision(keep.store, t03Scope, raw!.payload as never, pending, () => 20);
      await keep.applier.resume();
    }
    assert.equal(keep.api.calls.filter((call) => call.kind === 'delete').length, 0);
    assert.ok(keep.api.getNode('native-node'));
    assert.equal(await keep.store.getMappingByNativeId(t03Scope, 'native-node'), null);
    assert.ok(await keep.store.getLocalSyncExclusion(t03Scope, 'native-node'));
    assert.equal((await keep.store.exportScope(t03Scope)).cursor?.cursor, 'cursor-next');

    const echo = await setupT03();
    await seedMappedNode(echo, {
      nativeId: 'native-node', colpId: 'node-1', parentNativeId: 'native-root',
      parentColpId: 'root-colp', nodeKind: 'folder',
    });
    await echo.store.setRemoteDeletePolicy(t03Scope, { policy: 'confirm', expectedCasVersion: 0, now: 10 });
    const event = pullFixtures.mutationEvent({
      kind: 'delete', sequence: 7, collectionId: t03Scope.collectionId, targetId: 'node-1',
      parentId: 'root-colp', replicaId: t03Scope.replicaId, targetKind: 'folder',
    });
    await echo.store.allocateSequenceAndEnqueue(t03Scope, {
      opId: event.operation.opId, batchId: 'batch-self-echo', idempotencyKey: 'key-self-echo',
      digest: 'sha256:self-echo', endpointIdentity: 'syncPush', mediaType: 'application/json',
      baseRevision: null, operationRevision: 'local-self-echo', status: 'pending',
      retry: { attempt: 0, notBefore: 0 },
      payload: { type: 'delete_node', targetId: 'node-1' },
    }, { allowUnstamped: true });
    await echo.applier.stage(echo.page([event]));
    await echo.applier.resume();
    assert.equal((await echo.store.listRemoteDeleteDecisions(t03Scope)).length, 0);
    assert.equal(echo.api.getNode('native-node'), undefined);
    assert.equal((await echo.store.exportScope(t03Scope)).cursor?.cursor, 'cursor-next');
  });

  test('D-05: permission errors never commit as absent', async () => {
    const fixture = await setupT03();
    await seedMappedNode(fixture, {
      nativeId: 'native-node', colpId: 'node-1', parentNativeId: 'native-root',
      parentColpId: 'root-colp', nodeKind: 'bookmark', url: 'https://example.test/',
    });
    fixture.api.denyPermission('native-node');
    await fixture.applier.stage(fixture.page([fixture.mutationEvent('delete')]));
    await assert.rejects(() => fixture.applier.resume(), (error: unknown) =>
      classifyBookmarkApiFailure(error) === 'permission_denied'
      || (error instanceof Error && /permission|native_call_failed|failed/iu.test(error.message)));
    assert.ok(fixture.api.getNode('native-node'));
    assert.ok(await fixture.store.getMappingByNativeId(t03Scope, 'native-node'));
    assert.notEqual((await fixture.store.exportScope(t03Scope)).cursor?.cursor, 'cursor-next');
    const events = await fixture.store.listPullEvents(t03Scope);
    assert.equal(events.some((event) => event.state === 'page_complete'), false);
  });

  test('D-06: protected special roots stay; bindings do not author tombstoned parent uploads', async () => {
    const fixture = await setupT03();
    await fixture.store.putMapping(t03Scope, {
      ...mapping('native-root', 'root-colp', { nodeKind: 'folder' }),
      mountId: 'mount-bar', rootRole: 'bookmarks-bar',
    });
    await fixture.applier.stage(fixture.page([
      pullFixtures.mutationEvent({
        kind: 'delete', sequence: 9, collectionId: t03Scope.collectionId,
        targetId: 'root-colp', parentId: 'root-colp', targetKind: 'folder',
      }),
    ]));
    await fixture.applier.resume();
    assert.ok(fixture.api.getNode('native-root'));
    assert.equal(fixture.api.calls.some((call) => call.kind === 'delete' && call.nativeId === 'native-root'), false);
    const mount = (await fixture.store.listMountBindings(t03Scope))
      .find((row) => row.nativeRootId === 'native-root');
    assert.ok(mount);
    assert.notEqual(mount.status === 'active' && mount.remoteMountNodeId === 'root-colp', true);
    fixture.api.seed({
      id: 'under-bar', parentId: 'native-root', index: 1, title: 'After mount delete',
      url: 'https://example.test/bar',
    });
    const queue = createBookmarkEventQueue({
      scope: t03Scope, store: fixture.store, api: bookmarkApi(fixture.api), autoFlush: false,
    });
    const capture = await queue.created('under-bar', {
      id: 'under-bar', parentId: 'native-root', index: 1, title: 'After mount delete',
      url: 'https://example.test/bar',
    });
    assert.notEqual(capture.outcome, 'staged');
    await queue.flush();
    const created = await fixture.store.listQueue(t03Scope);
    assert.equal(created.some((row) => {
      const payload = row.payload.payload;
      return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        && payload.parentId === 'root-colp';
    }), false);
  });
});
