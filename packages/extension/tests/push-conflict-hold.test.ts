import { readOpenSyncIssues } from '../src/sync-issues.js';
import { canonicalAuthoritativeEffectDigest, canonicalOperationDigest } from '@know-n/colp/sync';
import { validateOperation, digestJson } from '../src/bookmark-event-codec.js';
import { createPullApplier } from '../src/pull-applier.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { verifySyncResilienceCase } from '../../conformance/src/sync-resilience.mjs';
import { createQueueRecapture } from '../src/queue-recapture.js';
import { honestChrome } from './kns-05-pull-harness.js';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, test } from 'vitest';
import { hasConflictBarrier } from '../src/engine-public-stability.js';
import { createOutboundPushWorker, type PushSessionController } from '../src/outbound-push-worker.js';
import { replicaIssuesFromQueue } from '../src/sw/replica-health-report.js';
import { createSyncStateStore, type JsonObject } from '../src/sync-state-store.js';
import { endpoints, json, problem, scope } from './outbound-push-worker-harness.js';

const captures = new WeakMap<object, ReturnType<typeof createQueueRecapture>>();
const browsers = new WeakMap<object, ReturnType<typeof honestChrome>>();
type Sent = { readonly opId: string; readonly sequence: number };

describe('C1 a conflict holds only its own bookmark', () => {
  test('a later change to another bookmark syncs; later changes to the conflicted one wait, then follow the resolution', async () => {
    const { store, worker, sent, results } = await fixture();
    await update(store, 'op-x1', 'node-x'); await update(store, 'op-y', 'node-y'); await update(store, 'op-x2', 'node-x');

    // The server consumes sequence 1 as a conflict; the edit queued after it on
    // the same bookmark leaves the lane instead of stalling it.
    assert.equal((await worker.drain()).outcome, 'blocked');
    assert.deepEqual(await statuses(store), [['op-x1', 'blocked'], ['op-y', 'pending'], ['op-x2', 'set_aside']]);
    // A change made while the conflict is open waits from the start; others queue as usual.
    await update(store, 'op-x3', 'node-x'); await update(store, 'op-z', 'node-z');
    assert.equal((await store.getQueueByOpId(scope, 'op-x3'))?.status, 'set_aside');

    // node-y and node-z sync. The held slots are a gap on the server lane, and
    // the realign moves node-z onto it and the held changes after it.
    assert.equal((await worker.drain()).outcome, 'gap');
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.deepEqual(sent.map((item) => [item.opId, item.sequence]),
      [['op-x1', 1], ['op-y', 2], ['op-z', 5], ['op-z', 3]]);
    const waiting = await store.listQueue(scope, 'set_aside');
    assert.deepEqual(waiting.map((row) => [row.opId, row.sequence, row.recovery?.code]),
      [['op-x2', 4, 'conflict_hold'], ['op-x3', 5, 'conflict_hold']]);
    // The browser says why, and the Sync center gets one item per held change.
    assert.equal(hasConflictBarrier(await store.listQueue(scope)), true);
    assert.deepEqual(replicaIssuesFromQueue(waiting).map((issue) => [issue.code, issue.nodeId]),
      [['conflict_hold', 'node-x'], ['conflict_hold', 'node-x']]);

    // The resolution arrives through Pull; the held changes follow it in order.
    await resolve(store, 'op-x1', 'conflict-op-x1');
    assert.equal((await worker.drain()).outcome, 'gap');
    assert.equal((await worker.drain()).outcome, 'terminal');
    const fresh = (await store.listQueue(scope)).filter(row => row.opId !== 'op-x1' && row.status === 'terminal'
      && row.payload.targetId === 'node-x');
    assert.equal(fresh.length, 2);
    for (const row of fresh) {
      assert.ok(!['op-x2', 'op-x3'].includes(row.opId));
      assert.equal((row.payload.payload as any).value.title, 'Current native title');
    }
    assert.equal((await store.getQueueByOpId(scope, 'op-x2'))?.status, 'rejected');
    assert.equal((await store.getQueueByOpId(scope, 'op-x3'))?.status, 'rejected');
    const events = (await store.exportScope(scope)).bookmarkEvents;
    assert.deepEqual(verifySyncResilienceCase('SYNC-0032', { results,
      resolutionEffect: (await store.listPullEvents(scope)).find(event => (event.payload as any)?.operation?.source?.adapterProfile === 'known-conflict-resolution'),
      held: waiting.map(row => ({ opId: row.opId, targetId: row.payload.targetId, status: row.status })),
      recaptured: fresh.map(row => ({ opId: row.opId, targetId: row.payload.targetId, sequence: row.sequence,
        originalOpId: events.find(event => event.opId === row.opId)?.details?.recapturedFrom,
        title: (row.payload.payload as any).value.title })), currentNativeTitle: 'Current native title',
    }), []);
    assert.equal(hasConflictBarrier(await store.listQueue(scope)), false);
    assert.equal((await readOpenSyncIssues(store, scope)).total, 0, 'resolved and recaptured history is closed');
    assert.deepEqual(await store.auditIntegrity(), { outcome: 'valid' });
    store.close();
  });

  test('a held change keeps waiting while another conflict on its bookmark is open', async () => {
    const { store, worker } = await fixture({ conflicts: ['op-x1', 'op-y'] });
    await update(store, 'op-x1', 'node-x'); await update(store, 'op-y', 'node-y');
    await update(store, 'op-y2', 'node-y'); await update(store, 'op-x2', 'node-x');
    assert.equal((await worker.drain()).outcome, 'blocked');
    assert.equal((await worker.drain()).outcome, 'blocked');
    assert.deepEqual(await statuses(store), [['op-x1', 'blocked'], ['op-y', 'blocked'],
      ['op-y2', 'set_aside'], ['op-x2', 'set_aside']]);
    await resolve(store, 'op-x1', 'conflict-op-x1');
    const released = await store.releaseSettledHolds(scope, captures.get(store));
    assert.equal(released.length, 1); assert.equal(released[0]!.payload.targetId, 'node-x');
    assert.notEqual(released[0]!.opId, 'op-x2');
    assert.equal((await store.getQueueByOpId(scope, 'op-y2'))?.status, 'set_aside');
    store.close();
  });
});

for (const mode of ['open-first', 'resolved-after'] as const) test(`real resolution applies with conflict facts on separate pages: ${mode}`, async () => {
  const { store, worker } = await fixture();
  try {
    await update(store, 'op-x1', 'node-x'); await update(store, 'op-y', 'node-y'); await update(store, 'op-x2', 'node-x');
    await worker.drain(); await worker.drain();
    const old = (await store.getQueueByOpId(scope, 'op-x2'))!;
    await resolve(store, 'op-x1', 'conflict-op-x1', mode);
    const native = browsers.get(store)!;
    await native.update('native-x', { title: 'Changed after resolution' });
    const [fresh] = await store.releaseSettledHolds(scope, captures.get(store));
    assert.ok(fresh); assert.notEqual(fresh.opId, old.opId); assert.ok(fresh.sequence > old.sequence);
    assert.notEqual(fresh.digest, old.digest); assert.notEqual(fresh.idempotencyKey, old.idempotencyKey);
    assert.equal((fresh.payload.payload as any).value.title, 'Changed after resolution');
    assert.equal((await store.getQueueByOpId(scope, old.opId))?.recovery?.code, 'recaptured');
    assert.equal((await store.getRemoteObservation(scope, 'node-x'))?.remoteRevision, 'revision-node-x');
    assert.equal(fresh.baseRevision, 'revision-node-x');
    assert.equal((fresh.payload.payload as any).base.title, 'Remote update');
  } finally { store.close(); }
});

test('the resolution exemption does not cross a separate local issue on the same target', async () => {
  const { store, worker } = await fixture();
  try {
    await update(store, 'op-x1', 'node-x'); await update(store, 'op-x2', 'node-x'); await worker.drain();
    await store.recordLocalIssue(scope, { nativeId: 'native-x', code: 'recovery_identity_unproven', now: 20000 });
    await resolve(store, 'op-x1', 'conflict-op-x1', 'independent-issue');
    assert.equal((await store.listPullIssues(scope))[0]?.code, 'parent_set_aside');
    assert.equal((await store.releaseSettledHolds(scope, captures.get(store))).length, 0);
    assert.equal(browsers.get(store)!.getNode('native-x')?.title, 'Current native title');
  } finally { store.close(); }
});

async function fixture(input: { readonly conflicts?: readonly string[] } = {}) {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() });
  await store.registerScope({ ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease-server', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { cursor: 'cursor-0', serverRevision: 'revision-0' }, selectedRoots: ['root'], rootStatus: 'ready' });
  const api = honestChrome(); api.seed({ id: 'root-native', title: 'Root' });
  await store.putMapping(scope, { nativeId: 'root-native', colpId: 'root', rootNativeId: 'root-native',
    nodeKind: 'folder', projection: { revision: 'root-r1', childrenRevision: 'children-r1', digest: 'sha256:root' } });
  for (const node of ['x', 'y', 'z']) {
    api.seed({ id: `native-${node}`, parentId: 'root-native', title: 'Current native title', url: 'https://example.test/' });
    await store.putMapping(scope, { nativeId: `native-${node}`, colpId: `node-${node}`, rootNativeId: 'root-native',
      parentNativeId: 'root-native', parentColpId: 'root', nodeKind: 'bookmark', projection: { revision: `${node}-r1`, digest: `sha256:${node}`, content: { title: node } } });
  }
  const conflicts = new Set(input.conflicts ?? ['op-x1']); const sent: Sent[] = []; const results: any[] = []; let expected = 1;
  // A strict lane: one expected sequence; a conflict consumes its slot like any result.
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { batchId: string; operations: Array<Sent & { targetId: string }> };
    const operation = body.operations[0]!; sent.push({ opId: operation.opId, sequence: operation.sequence });
    if (operation.sequence !== expected) return problem(409, 'sequence_gap', { expectedSequence: expected });
    expected += 1;
    const cursor = `cursor-${operation.sequence}`;
    const result = conflicts.has(operation.opId) ? { status: 'conflicted', conflictId: `conflict-${operation.opId}` }
      : { status: 'applied', targetId: operation.targetId, revision: `revision-${operation.sequence}` };
    results.push({ opId: operation.opId, targetId: operation.targetId, sequence: operation.sequence, status: result.status });
    return json(200, { batchId: body.batchId, results: [{ opId: operation.opId, sequence: operation.sequence,
      ...result, cursor, warnings: [] }], serverCursor: cursor });
  };
  const sessions: PushSessionController = { async get() { return {
    credential: { accessToken: 'access-token-push' }, session: { sessionId: 'session-push',
      expiresAt: '2099-01-01T00:00:00Z', scope: 'collection', snapshotRequired: false,
      credentialAuthorityDigest: 'a'.repeat(64),
      collection: { collectionId: scope.collectionId, serverCursor: 'cursor-0', serverRevision: 'revision-0' },
      replicaLease: { leaseId: 'lease-server', generation: '1', state: 'active', expiresAt: '2099-01-01T00:00:00Z' } } }; } };
  const recaptureHeld = createQueueRecapture({ store, scope, api, permission: async () => true });
  captures.set(store, recaptureHeld); browsers.set(store, api);
  const worker = createOutboundPushWorker({ scope, store, recaptureHeld, endpoints: async () => endpoints, sessions, fetch,
    now: () => 10_000, random: () => 0, ownerId: () => 'owner-push', schedule: () => undefined });
  return { store, worker, sent, results };
}

async function update(store: ReturnType<typeof createSyncStateStore>, opId: string, targetId: string) {
  const payload: JsonObject = { opId, replicaId: scope.replicaId, sequence: 0, collectionId: scope.collectionId,
    type: 'update_node_content', targetId, baseRevision: `${targetId.slice(-1)}-r1`,
    occurredAt: '2026-10-17T00:00:00.000Z', dependencies: [],
    payload: { base: { title: 'Before' }, value: { title: `After ${opId}` } } };
  const queued = await store.allocateSequenceAndEnqueue(scope, { opId, batchId: opId, idempotencyKey: opId, digest: `sha256:${opId}`,
    endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: String(payload.baseRevision),
    operationRevision: `local-${opId}`, status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload },
  { validateOperation, digestOperation: digestJson });
  const event = await store.stageBookmarkEvent(scope, { eventId: `event-${opId}`, dedupeKey: `event-${opId}`,
    occurredAt: '2026-10-17T00:00:00Z', kind: 'change', nativeId: `native-${targetId.slice(-1)}`, details: {} });
  const tx = (await store.open()).transaction('bookmark_events', 'readwrite');
  tx.objectStore('bookmark_events').put({ ...event.event, status: 'processed', opId });
  await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
  return queued;
}

async function statuses(store: ReturnType<typeof createSyncStateStore>) {
  return (await store.listQueue(scope)).map((row) => [row.opId, row.status]);
}

async function resolve(store: ReturnType<typeof createSyncStateStore>, opId: string, conflictId: string, mode: 'ordinary' | 'open-first' | 'resolved-after' | 'independent-issue' = 'ordinary') {
  const next = `cursor-resolved-${opId}`;
  const row = (await store.getQueueByOpId(scope, opId))!;
  const event: any = pullFixtures.mutationEvent({ kind: 'update', sequence: 40 + row.sequence,
    collectionId: scope.collectionId, targetId: String(row.payload.targetId), parentId: 'root' });
  event.operation.source = { adapterProfile: 'known-conflict-resolution' };
  event.operation.dependencies = [opId];
  event.effect.operationDigest = canonicalOperationDigest(event.operation);
  event.effect.effectDigest = canonicalAuthoritativeEffectDigest(event.effect);
  const applier = createPullApplier({ scope, store, api: browsers.get(store)!,
    session: { acceptedProtocolVersion: '0.2', sessionId: 'session-push', collectionId: scope.collectionId,
      conversionPolicy: { separator: 'preserve_remote' } },
    effectPageTemplate: endpoints.syncEffectPages, effectPageAuthority: scope.serverOrigin });
  const conflict = { id: conflictId, collectionId: scope.collectionId, targetId: String(row.payload.targetId),
    type: 'update_update', incomingOpId: opId, createdAt: '2026-10-17T00:00:00Z',
    allowedResolutions: ['server', 'incoming'], revision: 'conflict-r1', status: 'open' };
  if (mode === 'open-first') {
    await applier.stage(pullFixtures.page({ events: [{ kind: 'conflict', cursor: 'cursor-open', conflict }],
      nextCursor: 'cursor-open', collectionRevision: 'before-resolution' }));
    await applier.resume();
    assert.equal((await store.getQueueByOpId(scope, opId))?.status, 'blocked');
    assert.equal((await store.releaseSettledHolds(scope, captures.get(store))).length, 0);
    store.close();
  }
  await applier.stage(pullFixtures.page({ events: [event], nextCursor: next, collectionRevision: `revision-${opId}` }));
  await applier.resume();
  if (mode === 'resolved-after') {
    await applier.stage(pullFixtures.page({ events: [{ kind: 'conflict', cursor: 'cursor-fact', conflict: { ...conflict, status: 'resolved' } }],
      nextCursor: 'cursor-fact', collectionRevision: 'after-resolution' }));
    await applier.resume();
  }
  if (mode !== 'independent-issue') assert.deepEqual(await store.listPullIssues(scope), [], 'the real resolution effect must not set itself aside');
}
