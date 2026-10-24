import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test } from 'vitest';
import { createBookmarkEventHealer } from '../src/bookmark-event-heal.js';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { readOpenSyncIssues } from '../src/sync-issues.js';
import type { BookmarkEventParkMarker } from '../src/sync-state/types.js';
import { bookmark, fixture, folder, mapping, scope } from './bookmark-event-queue-harness.js';
import { endpoints, json, problem } from './outbound-push-worker-harness.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
function worker(f: Fixture, fetcher: typeof fetch) {
  return createOutboundPushWorker({ scope, store: f.store, endpoints: async () => endpoints,
    sessions: { get: async () => ({ credential: { accessToken: 'test' }, session: {
      sessionId: 'anchor-session', expiresAt: '2099-01-01T00:00:00Z', scope: 'collection',
      credentialAuthorityDigest: 'a'.repeat(64), snapshotRequired: false,
      collection: { collectionId: scope.collectionId, serverCursor: 'c0', serverRevision: 'r0' },
      replicaLease: { leaseId: 'lease', generation: '1', state: 'active', expiresAt: '2099-01-01T00:00:00Z' },
    } }) }, now: () => 1000, random: () => 0, ownerId: () => 'anchor-worker', fetch: fetcher });
}

for (const legacy of [false, true]) {
  for (const failure of ['rejected', 'consumed', 'set_aside'] as const) {
    test(`failed sorting anchor releases sibling saves (legacy=${legacy}, failure=${failure})`, async () => {
      const f = await fixture(new IDBFactory(), { mappedNode: true });
      try {
        await mapping(f.store, 'mapped', 'mapped-colp', 'root-selected', 'server-revision-7',
          { title: 'Server before', url: 'https://example.test/before' }, 'root-selected');
        f.api.put(bookmark('mapped', 'root-selected', 1, 'Failed edit', 'https://example.test/before'));
        await f.queue.changed('mapped', { title: 'Failed edit' }); await f.queue.flush();
        const failed = (await f.store.listQueue(scope))[0]!;
        if (failure === 'set_aside') await f.store.setAsideQueue(scope, [failed.sequence], 'recovery_identity_unproven');
        else await worker(f, async (_url, init) => {
          if (failure === 'rejected') return problem(404, 'resource_not_found', { retryable: false });
          const request = JSON.parse(String(init?.body));
          return json(200, { batchId: request.batchId, results: [{ opId: failed.opId, sequence: failed.sequence,
            status: 'rejected', code: 'resource_not_found', warnings: [] }], serverCursor: 'sync-unchanged' });
        }).drain();
        // Capture several siblings exactly as the reported dependency chain was captured.
        for (let index = 0; index < 3; index++) {
          const node = bookmark(`save-${index}`, 'root-selected', index + 2, `Save ${index}`, `https://example.test/${index}`);
          f.api.put(node); await f.queue.created(node.id, node);
        }
        const events = await f.store.listBookmarkEventsByStatus(scope, 'pending');
        expect(events.map(event => (event.details.context as any).afterNativeId)).toEqual(['mapped', 'save-0', 'save-1']);
        if (legacy) {
          const healer = createBookmarkEventHealer({ scope, store: f.store,
            listPendingEvents: () => f.store.listBookmarkEventsByStatus(scope, 'pending') });
          for (const [index, event] of events.entries()) {
            const dependency = index === 0 ? { nativeId: 'mapped', opId: failed.opId }
              : { nativeId: events[index - 1]!.nativeId, eventId: events[index - 1]!.eventId };
            const marker: BookmarkEventParkMarker = { eventId: event.eventId, state: 'parked',
              code: index === 0 ? 'dependency_rejected' : 'dependency_parked', attempts: 1,
              at: event.occurredAt, reason: 'dependency_pending', dependencyNativeId: dependency.nativeId,
              ...(dependency.opId ? { dependencyOpId: dependency.opId } : {}),
              ...(dependency.eventId ? { dependencyEventId: dependency.eventId } : {}),
              dependencyStamp: await healer.dependencyStamp(dependency, dependency.eventId ? 'parked' : undefined) };
            await f.store.putIngressDiagnostic(scope, { code: `park:${event.eventId}`, park: marker });
          }
          expect((await readOpenSyncIssues(f.store, scope)).local).toHaveLength(3);
          f.store.close();
        }
        const queue = createBookmarkEventQueue({ scope, store: f.store, api: f.api, autoFlush: false });
        const sent: any[] = [];
        const push = worker(f, async (_url, init) => {
          const request = JSON.parse(String(init?.body)); const operation = request.operations[0]; sent.push(operation);
          return json(200, { batchId: request.batchId, results: [{ opId: operation.opId, sequence: operation.sequence,
            status: 'applied', targetId: `server-${operation.opId}`, revision: `r-${operation.sequence}`,
            cursor: 'c1', warnings: [] }], serverCursor: 'sync-unchanged' });
        });
        for (let round = 0; round < 4; round++) { await queue.flush(); await push.drain(); }
        expect(sent.map(operation => operation.payload.node.title)).toEqual(['Save 0', 'Save 1', 'Save 2']);
        // Omitting an unusable anchor must clear its captured wire ID, including pending-* IDs.
        expect(sent[0].payload).not.toHaveProperty('afterId');
        expect(sent[0].payload).not.toHaveProperty('beforeId');
        expect(sent[1].payload.afterId).toBe(`server-${sent[0].opId}`);
        expect(sent[2].payload.afterId).toBe(`server-${sent[1].opId}`);
        expect(await f.store.listBookmarkEventsByStatus(scope, 'pending')).toHaveLength(0);
        const open = await readOpenSyncIssues(f.store, scope);
        expect(open.local).toHaveLength(0);
        expect(open.queue.map(row => [row.opId, row.recovery?.code])).toEqual([[failed.opId,
          failure === 'set_aside' ? 'recovery_identity_unproven' : 'resource_not_found']]);
        expect((await f.store.getScope(scope))?.lifecycle).toBe('active');
      } finally { f.store.close(); }
    });
  }
}

test('a rejected parent remains held while its root sibling saves', async () => {
  const f = await fixture(new IDBFactory());
  try {
    const parent = folder('failed-folder', 'root-selected', 0, 'Failed folder');
    f.api.put(parent); await f.queue.created(parent.id, parent); await f.queue.flush();
    await worker(f, async () => problem(404, 'resource_not_found', { retryable: false })).drain();
    const child = bookmark('child', parent.id, 0, 'Child', 'https://example.test/child');
    f.api.put(child); await f.queue.created(child.id, child);
    const sibling = bookmark('sibling', 'root-selected', 1, 'Sibling', 'https://example.test/sibling');
    f.api.put(sibling); await f.queue.created(sibling.id, sibling); await f.queue.flush();
    const pending = await f.store.listBookmarkEventsByStatus(scope, 'pending');
    expect(pending.map(event => event.nativeId)).toEqual(['child']);
    expect((await readOpenSyncIssues(f.store, scope)).local[0]).toMatchObject({ code: 'dependency_rejected', nativeId: 'child' });
    const saved = (await f.store.listQueue(scope))[1]!;
    expect(saved.status).toBe('pending');
    expect((saved.payload.payload as any).parentId).not.toContain('pending-');
    expect(saved.payload.payload).not.toHaveProperty('afterId');
  } finally { f.store.close(); }
});

for (const legacy of [false, true]) test(`same-node edits remain held while their sorting dependents save (legacy=${legacy})`, async () => {
  const f = await fixture(new IDBFactory(), { mappedNode: true });
  try {
    await mapping(f.store, 'mapped', 'mapped-colp', 'root-selected', 'server-revision-7',
      { title: 'Server before', url: 'https://example.test/before' }, 'root-selected');
    f.api.put(bookmark('mapped', 'root-selected', 1, 'Failed edit', 'https://example.test/before'));
    await f.queue.changed('mapped', { title: 'Failed edit' }); await f.queue.flush();
    const failed = (await f.store.listQueue(scope))[0]!;
    await worker(f, async () => problem(404, 'resource_not_found', { retryable: false })).drain();
    f.api.put(bookmark('mapped', 'root-selected', 1, 'Later edit', 'https://example.test/before'));
    await f.queue.changed('mapped', { title: 'Later edit' });
    const [edit] = await f.store.listBookmarkEventsByStatus(scope, 'pending');
    if (legacy) {
      const healer = createBookmarkEventHealer({ scope, store: f.store,
        listPendingEvents: () => f.store.listBookmarkEventsByStatus(scope, 'pending') });
      const marker: BookmarkEventParkMarker = { eventId: edit!.eventId, state: 'parked', code: 'dependency_rejected',
        attempts: 1, at: edit!.occurredAt, reason: 'dependency_pending',
        dependencyNativeId: 'mapped', dependencyOpId: failed.opId,
        dependencyStamp: await healer.dependencyStamp({ nativeId: 'mapped', opId: failed.opId }) };
      await f.store.putIngressDiagnostic(scope, { code: `park:${edit!.eventId}`, park: marker });
      f.store.close();
    }
    const sibling = bookmark('sibling', 'root-selected', 2, 'Sibling', 'https://example.test/sibling');
    f.api.put(sibling); await f.queue.created(sibling.id, sibling);
    await f.queue.flush(); await f.queue.flush();
    expect((await f.store.listBookmarkEventsByStatus(scope, 'pending')).map(event => event.nativeId)).toEqual(['mapped']);
    expect((await readOpenSyncIssues(f.store, scope)).local).toMatchObject([{ nativeId: 'mapped', code: 'dependency_rejected' }]);
    const saved = (await f.store.listQueue(scope))[1]!;
    expect(saved.status).toBe('pending');
    expect(saved.payload.payload).not.toHaveProperty('afterId');
    expect((await f.store.listIngressDiagnostics(scope)).find(row => row.park?.eventId === edit!.eventId)?.park?.attempts).toBe(1);
  } finally { f.store.close(); }
});

for (const failure of ['tombstone', 'orphan', 'moved'] as const) {
  test(`a ${failure} sorting neighbour cannot pin later saves in its folder`, async () => {
    const f = await fixture(new IDBFactory(), { mappedNode: true });
    try {
      await mapping(f.store, 'mapped', 'mapped-colp', 'root-selected', 'r1', { title: 'Neighbour' }, 'root-selected');
      f.api.put(bookmark('mapped', 'root-selected', 1, 'Neighbour', 'https://example.test/old'));
      for (let i = 0; i < 2; i++) {
        const node = bookmark(`saved-${i}`, 'root-selected', i + 2, `Saved ${i}`, `https://example.test/${i}`);
        f.api.put(node); await f.queue.created(node.id, node);
      }
      if (failure === 'tombstone') await f.store.putRemoteObservation(scope, { colpId: 'mapped-colp', kind: 'tombstone',
        remoteRevision: 'deleted', cursor: 'c2', observedAt: 2000, sourceDigest: 'deleted', payload: {} });
      else await mapping(f.store, 'mapped', 'mapped-colp', 'root-selected', failure === 'orphan' ? 'local-missing-event' : 'r2',
        { title: 'Neighbour' }, failure === 'moved' ? 'folder-parent' : 'root-selected');
      await f.queue.flush();
      const saved = (await f.store.listQueue(scope))[0]!;
      expect(saved.payload.payload).not.toHaveProperty('afterId');
      expect(saved.status).toBe('pending');
      expect((await f.store.listBookmarkEventsByStatus(scope, 'pending')).map(event => event.nativeId)).toEqual(['saved-1']);
      expect((await f.store.getScope(scope))?.lifecycle).toBe('active');
    } finally { f.store.close(); }
  });
}
