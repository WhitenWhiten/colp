import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test } from 'vitest';
import { fixture, bookmark, mapping, scope } from './bookmark-event-queue-harness.js';
import { endpoints, json } from './outbound-push-worker-harness.js';
import { createOutboundPushWorker, type PushSessionController } from '../src/outbound-push-worker.js';
import { createQueueRecapture } from '../src/queue-recapture.js';
import { readOpenSyncIssues } from '../src/sync-issues.js';

for (const legacy of [false, true]) test(`directed dependency converges through actual Push settlement (legacy=${legacy})`, async () => {
  const f = await fixture(new IDBFactory(), { mappedNode: true });
  try {
    f.api.put(bookmark('mapped', 'root-selected', 0, 'First', 'https://example.test/before'));
    await f.queue.changed('mapped', { title: 'First' }); await f.queue.flush();
    const a = (await f.store.listQueue(scope))[0]!;
    f.api.put(bookmark('mapped', 'root-selected', 0, 'Second', 'https://example.test/before'));
    await f.queue.changed('mapped', { title: 'Second' });
    for (let i = 0; i < 8; i++) await f.queue.flush();
    const b = (await f.store.listBookmarkEventsByStatus(scope, 'pending'))[0]!;
    expect((await readOpenSyncIssues(f.store, scope)).total).toBe(0);
    if (legacy) {
      await f.store.putIngressDiagnostic(scope, { code: `park:${b.eventId}`, park: { eventId: b.eventId,
        state: 'parked', code: 'dependency_pending', attempts: 5, at: '2026-10-18T00:00:00Z',
        dependencyNativeId: 'mapped', dependencyOpId: a.opId, dependencyStamp: 'legacy' } });
      await f.store.setAsideQueue(scope, [a.sequence], 'dependency_hold');
      f.store.close(); // restart against the persisted IndexedDB
    }
    await mapping(f.store, 'independent', 'independent-colp', 'root-selected', 'r1', { title: 'Independent' });
    f.api.put(bookmark('independent', 'root-selected', 1, 'Independent', 'https://example.test/independent'));
    await f.queue.changed('independent', { title: 'Changed independently' }); await f.queue.flush();
    const sessions: PushSessionController = { get: async () => ({ credential: { accessToken: 'test' }, session: {
      sessionId: 'session', expiresAt: '2099-01-01T00:00:00Z', scope: 'collection', snapshotRequired: false,
      credentialAuthorityDigest: 'a'.repeat(64), collection: { collectionId: scope.collectionId, serverRevision: 'r1', serverCursor: 'c0' },
      replicaLease: { leaseId: 'lease', generation: '1', state: 'active', expiresAt: '2099-01-01T00:00:00Z' } } }) };
    const sent: string[] = [];
    const worker = createOutboundPushWorker({ store: f.store, scope, sessions, endpoints: async () => endpoints,
      now: () => 10000, random: () => 0, ownerId: () => 'directed',
      recaptureHeld: createQueueRecapture({ store: f.store, scope, api: f.api, permission: async () => true }),
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)); const op = body.operations[0]; sent.push(op.opId);
        return json(200, { batchId: body.batchId, results: [{ opId: op.opId, sequence: op.sequence, status: 'applied',
          targetId: op.targetId, revision: `r-${op.sequence}`, cursor: 'cursor-1', warnings: [] }], serverCursor: 'sync-unchanged' });
      } });
    await worker.drain(); await f.queue.flush(); await worker.drain(); await f.queue.flush();
    expect(sent[0]).toBe(a.opId);
    expect((await f.store.listBookmarkEventsByStatus(scope, 'pending'))).toHaveLength(0);
    expect((await f.store.listQueue(scope)).every(row => row.status === 'terminal')).toBe(true);
    expect((await readOpenSyncIssues(f.store, scope)).total).toBe(0);
    expect((await f.store.getMappingByNativeId(scope, 'mapped'))?.projection.content?.title).toBe('Second');
  } finally { f.store.close(); }
});
