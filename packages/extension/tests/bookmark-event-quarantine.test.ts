import { createPullApplier } from '../src/pull-applier.js';
import { honestChrome } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, test } from 'vitest';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { createSyncStateStore } from '../src/sync-state-store.js';
import { bookmark, fixture, folder, scope } from './bookmark-event-queue-harness.js';
import { endpoints, problem } from './outbound-push-worker-harness.js';

/**
 * F003/F113: a pending inbox event that can never be prepared (its parent
 * create was permanently refused, or its dependency fence never arrives) must
 * not stop `flush()` from working on the events behind it. It is quarantined
 * with durable, bounded evidence and returns to the inbox once its dependency
 * converges.
 */
function authority() {
  return { credential: { accessToken: 'token-t02' }, session: {
    sessionId: 'session-t02', expiresAt: '2099-01-01T00:00:00Z', scope: 'collection' as const,
    credentialAuthorityDigest: 'a'.repeat(64), snapshotRequired: false,
    collection: { collectionId: scope.collectionId, serverCursor: 'cursor-0', serverRevision: 'revision-0' },
    replicaLease: { leaseId: 'lease-t02', generation: String(scope.generation), state: 'active' as const,
      expiresAt: '2099-01-01T00:00:00Z' } } };
}

/** The exact drain path a permanently refused operation takes in production. */
function rejectingPushWorker(store: ReturnType<typeof createSyncStateStore>, response: (body: string) => Response, now = 1000) {
  return createOutboundPushWorker({ scope, store, endpoints: async () => endpoints,
    sessions: { async get() { return authority(); } }, now: () => now, random: () => 0,
    ownerId: () => 'owner-t02', schedule: () => undefined, fetch: async (_url, init) => response(String(init?.body)) });
}

async function markers(store: ReturnType<typeof createSyncStateStore>) {
  return (await store.listIngressDiagnostics(scope)).filter((row) => row.park !== undefined)
    .map((row) => row.park!);
}

describe('T-02 F003 poison inbox events', () => {
  test('flush skips a poison event and still enqueues later captures after its parent is refused', async () => {
    const f = await fixture(new IDBFactory());
    f.api.put(folder('folder-new', 'root-selected', 0, 'New folder'));
    assert.equal((await f.queue.created('folder-new', f.api.node('folder-new'))).outcome, 'staged');
    await f.queue.flush();
    const parentRow = (await f.store.listQueue(scope))[0]!;
    assert.equal(parentRow.payload.type, 'create_node');

    // A bookmark created inside the not-yet-confirmed folder is held durably,
    // and a sibling placed behind that folder anchors to the same identity.
    f.api.put(bookmark('child', 'folder-new', 0, 'Child', 'https://example.test/child'));
    assert.equal((await f.queue.created('child', f.api.node('child'))).outcome, 'staged');
    f.api.put(bookmark('root-later', 'root-selected', 1, 'Later', 'https://example.test/later'));
    assert.equal((await f.queue.created('root-later', f.api.node('root-later'))).outcome, 'staged');
    await f.queue.flush();
    assert.equal((await f.store.listQueue(scope)).length, 1, 'the unconfirmed parent identity must hold both');

    // The server permanently refuses the folder create.
    const refused = await rejectingPushWorker(f.store,
      () => problem(422, 'invalid_document', { retryable: false })).drain();
    assert.equal(refused.outcome, 'rejected');

    // The poison dependency must not wedge the inbox: an independent capture in
    // another mapped folder reaches the outbound queue in the same flush that
    // quarantines the child. The root sibling can omit the refused sorting anchor.
    f.api.put(bookmark('independent', 'folder-parent', 0, 'Independent', 'https://example.test/independent'));
    assert.equal((await f.queue.created('independent', f.api.node('independent'))).outcome, 'staged');
    await f.queue.flush();
    const rows = await f.store.listQueue(scope);
    assert.deepEqual(rows.map((row) => [row.sequence, row.status, row.payload.type]),
      [[1, 'rejected', 'create_node'], [2, 'pending', 'create_node'], [3, 'pending', 'create_node']]);
    assert.equal((rows[1]!.payload.payload as { node?: { title?: string } }).node?.title, 'Later');
    assert.equal((rows[2]!.payload.payload as { node?: { title?: string } }).node?.title, 'Independent');
    assert.equal((rows[1]!.payload.payload as { afterId?: string }).afterId, undefined);

    // The poison events are preserved, never deleted, and quarantined with
    // evidence that names the refused dependency.
    const events = await f.store.listBookmarkEvents(scope);
    const child = events.find((event) => event.nativeId === 'child')!;
    const sibling = events.find((event) => event.nativeId === 'root-later')!;
    assert.equal(child.status, 'pending');
    assert.equal(sibling.status, 'processed');
    assert.notEqual(child.details.mapping, undefined, 'the quarantined event keeps its durable data');
    assert.equal(events.find((event) => event.nativeId === 'independent')?.status, 'processed');
    const quarantined = (await markers(f.store)).find((park) => park.eventId === child.eventId)!;
    assert.equal(quarantined.state, 'parked');
    assert.equal(quarantined.code, 'dependency_rejected');
    // Two rounds failed before the dependency was visibly refused; the park
    // decision itself is deterministic once the row is rejected.
    assert.equal(quarantined.attempts, 2);
    assert.equal(quarantined.dependencyNativeId, 'folder-new');
    assert.equal(quarantined.dependencyOpId, parentRow.opId);
    assert.ok(typeof quarantined.dependencyStamp === 'string' && quarantined.dependencyStamp.length > 0);
    assert.notEqual((await markers(f.store)).find((park) => park.eventId === sibling.eventId)?.state, 'parked');
    // The engine/ops channel also carries the attention signal.
    const diagnostics = await f.store.exportDiagnostics();
    assert.ok(diagnostics.records.some((row) => (row as { kind?: string }).kind === 'bookmark_event_park'
      && (row as { code?: string }).code === 'dependency_rejected'));
  });

  test('a historical parked create dependency recovers through exact Push settlement after restart', async () => {
    const f = await fixture(new IDBFactory());
    try {
      f.api.put(folder('folder-new', 'root-selected', 0, 'New folder'));
      await f.queue.created('folder-new', f.api.node('folder-new')); await f.queue.flush();
      const parent = (await f.store.listQueue(scope))[0]!;
      f.api.put(bookmark('child', 'folder-new', 0, 'Child', 'https://example.test/child'));
      await f.queue.created('child', f.api.node('child')); await f.queue.flush();
      const child = (await f.store.listBookmarkEventsByStatus(scope, 'pending'))[0]!;
      await rejectingPushWorker(f.store, body => { const request = JSON.parse(body); return Response.json({ batchId: request.batchId,
        results: [{ opId: parent.opId, sequence: parent.sequence, status: 'deferred', code: 'pending_parent', retryAfterSeconds: 1, warnings: [] }], serverCursor: 'sync-unchanged' }); }).drain();
      await f.store.putIngressDiagnostic(scope, { code: `park:${child.eventId}`, park: { eventId: child.eventId,
        code: 'dependency_pending', state: 'parked', attempts: 5, at: '2026-07-27T00:00:00Z',
        dependencyNativeId: 'folder-new', dependencyOpId: parent.opId } });
      f.store.close();
      await rejectingPushWorker(f.store, body => { const request = JSON.parse(body); return Response.json({ batchId: request.batchId,
        results: [{ opId: parent.opId, sequence: parent.sequence, status: 'applied', targetId: 'server-folder-new',
          revision: 'parent-r1', cursor: 'c1', warnings: [] }], serverCursor: 'c1' }); }, 100000).drain();
      await f.queue.flush();
      assert.equal((await f.store.getBookmarkEvent(scope, child.eventId))?.status, 'processed');
      const created = (await f.store.listQueue(scope)).find(row => (row.payload.payload as any).node?.title === 'Child')!;
      assert.equal((created.payload.payload as any).parentId, 'server-folder-new');
    } finally { f.store.close(); }
  });

  test('a missing children fence stays automatic across flushes and resumes after a real Pull receipt', async () => {
    const f = await fixture(new IDBFactory(), { mappedNode: true });
    await f.store.putMapping(scope, { nativeId: 'folder-fresh', colpId: 'folder-fresh-colp',
      rootNativeId: 'root-selected', nodeKind: 'folder', parentNativeId: 'root-selected',
      projection: { revision: 'server-folder-r1', digest: 'sha256:folder-fresh', content: { title: 'Fresh' } } });
    f.api.put(folder('folder-fresh', 'root-selected', 0, 'Fresh'));
    f.api.put(bookmark('mapped', 'folder-fresh', 0, 'Server before', 'https://example.test/before'));
    assert.equal((await f.queue.moved('mapped', { parentId: 'folder-fresh', index: 0,
      oldParentId: 'root-selected', oldIndex: 0 })).outcome, 'staged');

    // Every round also stages an independent capture in another mapped folder;
    // the server confirms it, so the next sibling can anchor to a real id. The
    // blocked move must never hold any of them back.
    for (let round = 0; round < 5; round += 1) {
      await f.queue.flush();
      f.api.put(bookmark(`later-${round}`, 'folder-parent', round, `Later ${round}`,
        `https://example.test/later-${round}`));
      await f.queue.created(`later-${round}`, f.api.node(`later-${round}`));
      await f.queue.flush();
      const queued = (await f.store.listQueue(scope)).find((row) =>
        ((row.payload.payload as { node?: { title?: string } }).node?.title) === `Later ${round}`);
      assert.ok(queued, `later-${round} must reach the queue`);
      await rejectingPushWorker(f.store, body => { const request = JSON.parse(body); const op = request.operations[0];
        return Response.json({ batchId: request.batchId, results: [{ opId: op.opId, sequence: op.sequence,
          status: 'applied', targetId: `server-later-${round}`, revision: `server-later-r${round}`, cursor: `c-${round}`, warnings: [] }], serverCursor: `c-${round}` });
      }).drain();
    }
    const move = (await f.store.listBookmarkEvents(scope)).find((event) => event.kind === 'move')!;
    const parked = (await markers(f.store)).find((park) => park.eventId === move.eventId)!;
    assert.equal(parked.state, 'open');
    assert.equal(parked.code, 'children_fence_missing');
    assert.equal(parked.attempts, 10);
    assert.equal(parked.dependencyNativeId, 'folder-fresh');
    assert.equal((await f.store.listQueue(scope)).filter((row) => row.payload.type === 'create_node').length, 5);

    // The folder confirmation echo delivers the real children fence.
    const api = honestChrome();
    for (const id of ['0', 'root-selected', 'root-private', 'root-unselected', 'folder-parent', 'folder-fresh', 'mapped']) api.seed(f.api.node(id));
    const applier = createPullApplier({ scope, store: f.store, api, effectPageTemplate: 'https://known.example/effects/{effectId}/pages/{pageNumber}',
      effectPageAuthority: 'https://known.example', session: { acceptedProtocolVersion: '0.2',
      sessionId: 'fence-pull', collectionId: scope.collectionId, conversionPolicy: { separator: 'preserve_remote' } } });
    await applier.stage(pullFixtures.page({ events: [pullFixtures.createEvent({ kind: 'Bookmark', sequence: 99,
      collectionId: scope.collectionId, parentId: 'folder-fresh-colp' })], nextCursor: 'cursor-fence', collectionRevision: 'r-fence' }));
    await applier.resume();
    for (const node of api.all()) f.api.put(node);
    await f.queue.flush();
    assert.equal((await markers(f.store)).find((park) => park.eventId === move.eventId)!.state, 'open');
    const moved = (await f.store.listQueue(scope)).filter((row) => row.payload.type === 'move_node');
    assert.equal(moved.length, 1);
    assert.equal((moved[0]!.payload.payload as { baseTargetParentRevision?: string }).baseTargetParentRevision,
      'children-99');
  });

  test('a corrupt durable draft is quarantined as deterministic poison instead of aborting the flush', async () => {
    const f = await fixture(new IDBFactory(), { mappedNode: true });
    await f.store.stageBookmarkEvent(scope, { eventId: 'poison-event', dedupeKey: 'dedupe-poison',
      occurredAt: '2026-07-27T00:00:00Z', kind: 'change', nativeId: 'mapped',
      details: { draft: { type: 'not_a_protocol_operation' } } });
    // An unpreparable draft is one poison shape; a draft that only fails the
    // protocol schema at commit time (`operation_schema_invalid` from
    // commitBookmarkEvent) must be quarantined by the same path.
    await f.store.stageBookmarkEvent(scope, { eventId: 'commit-poison-event', dedupeKey: 'dedupe-commit-poison',
      occurredAt: '2026-07-27T00:00:00Z', kind: 'change', nativeId: 'mapped',
      details: { draft: { type: 'delete_node', targetId: 'mapped-colp', baseRevision: 'server-revision-7',
        payload: {}, notAProtocolField: true } } });
    f.api.put(bookmark('later', 'root-selected', 0, 'Later', 'https://example.test/later'));
    assert.equal((await f.queue.created('later', f.api.node('later'))).outcome, 'staged');
    await f.queue.flush();

    assert.deepEqual((await f.store.listQueue(scope)).map((row) => row.payload.type), ['create_node']);
    const poison = (await markers(f.store)).find((park) => park.eventId === 'poison-event')!;
    assert.equal(poison.state, 'parked');
    assert.equal(poison.code, 'operation_schema_invalid');
    assert.equal((await f.store.listBookmarkEvents(scope)).find((event) => event.eventId === 'poison-event')?.status,
      'pending');
    // A terminal quarantine keeps its evidence and is not replayed forever.
    await f.queue.flush();
    assert.equal((await markers(f.store)).find((park) => park.eventId === 'poison-event')!.attempts, 1);
    const commitPoison = (await markers(f.store)).find((park) => park.eventId === 'commit-poison-event')!;
    assert.equal(commitPoison.state, 'parked');
    assert.equal(commitPoison.code, 'operation_schema_invalid');
    assert.equal((await f.store.listBookmarkEvents(scope))
      .find((event) => event.eventId === 'commit-poison-event')?.status, 'pending');
    assert.equal((await f.store.listQueue(scope)).length, 1);
  });
});
