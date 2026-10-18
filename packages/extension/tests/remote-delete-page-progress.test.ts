import { verifySyncResilienceCase } from '../../conformance/src/sync-resilience.mjs';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { canonicalAuthoritativeEffectDigest, canonicalOperationDigest } from '@know-n/colp/sync';
import { setup, scope, json, pullEventsPage, ack } from './durable-sync-engine-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { sendReplicaHealthReport } from '../src/sw/replica-health-report.js';
import { handleSyncAttentionRequest } from '../src/sw/sync-attention.js';
import { MemoryStorageArea } from '../src/credential-store.js';

for (const restart of [false, true]) test(`pending delete preserves two-page Pull/Ack and resumes its decision (restart=${restart})`, async () => {
  const f = await setup({ useRealPullApplier: true });
  try {
    f.chromeNodes.set('native-root', { id: 'native-root', title: 'Root' });
    f.chromeNodes.set('native-item', { id: 'native-item', parentId: 'native-root', title: 'Item', url: 'https://example.test/' });
    await f.store.putMapping(scope, { nativeId: 'native-item', colpId: 'node-1', rootNativeId: 'native-root',
      parentColpId: 'root-old', parentNativeId: 'native-root', nodeKind: 'bookmark',
      projection: { revision: 'revision-old', digest: 'sha256:item', content: { title: 'Item', url: 'https://example.test/' } } });
    await f.store.setRemoteDeletePolicy(scope, { policy: 'confirm', expectedCasVersion: 0, now: 1 });
    const deletion: any = pullFixtures.mutationEvent({ kind: 'delete', sequence: 1, collectionId: scope.collectionId,
      targetId: 'node-1', parentId: 'root-old' });
    const independent: any = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 2, collectionId: scope.collectionId, parentId: 'root-old' });
    independent.cursor = 'cursor-independent';
    const related: any = pullFixtures.restoreEvent({ sequence: 3, collectionId: scope.collectionId,
      targetId: 'node-1', parentId: 'root-old', title: 'Restored remotely' });
    related.operation.baseRevision = deletion.effect.tombstone.deleteRevision;
    related.effect.consumedTombstone = deletion.effect.tombstone;
    related.effect.operationDigest = canonicalOperationDigest(related.operation);
    related.effect.effectDigest = canonicalAuthoritativeEffectDigest(related.effect);
    f.pullResponses.push(json(200, pullEventsPage([deletion], 'cursor-1', { hasMore: true })),
      json(200, pullEventsPage([independent, related], 'cursor-2')));
    f.ackResponses.push(json(200, ack('cursor-1')), json(200, ack('cursor-2')));
    await f.engine.wake('manual');
    assert.equal(f.pullRequests.length, 2);
    assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-2');
    assert.ok(f.ackRequests.some(request => JSON.parse(request.body).cursor === 'cursor-2'));
    assert.ok(await f.store.getMappingByColpId(scope, 'node-created-2'));
    assert.equal(f.chromeNodes.get('native-item')?.title, 'Item');
    assert.equal((await f.store.listPullIssues(scope)).length, 0, 'pending dependency is not an unrepairable new issue');
    const status = await handleSyncAttentionRequest({ scope: async () => scope, store: f.store });
    assert.ok(status.ok && status.attention.issueCount === 1);
    let health: any;
    await sendReplicaHealthReport({ scope, store: f.store, mode: async () => 'enabled',
      credential: async () => ({ accessToken: 'fixture', subject: scope.accountId, serverOrigin: scope.serverOrigin }),
      storage: new MemoryStorageArea(), origin: 'chrome-extension://fixture', now: () => 2000,
      fetch: async (_url, init) => { health = JSON.parse(String(init?.body)); return Response.json({ accepted: true, commands: [] }); } });
    assert.equal(health.state, 'degraded'); assert.equal(health.issues.total, 1);
    assert.equal(health.issues.items[0].code, 'remote_delete_confirmation_required');
    const pagesBefore = await f.store.listPullPages(scope);
    const relatedBefore = (await f.store.listPullEvents(scope)).find(row => row.operationId === 'op-3');
    const decision = (await f.store.listRemoteDeleteDecisions(scope, ['pending']))[0]!;
    if (restart) f.store.close();
    await f.store.prunePullHistory(scope, 1, { maxEvents: 1, maxBytes: 1 });
    assert.ok(await f.store.getPullEvent(scope, decision.eventId), 'decision evidence survives pruning');
    await f.store.decideRemoteDelete(scope, { decisionId: decision.decisionId, action: 'apply',
      expectedCasVersion: decision.casVersion, deleteRevision: decision.deleteRevision,
      generation: scope.generation, now: 3000, permissionGranted: true });
    f.clock.now += 30_000; await f.reopen().wake('manual');
    f.clock.now += 30_000; await f.reopen().wake('manual');
    assert.equal(f.chromeNodes.has('native-item'), false);
    const restored = await f.store.getMappingByColpId(scope, 'node-1');
    assert.ok(restored); assert.equal(f.chromeNodes.get(restored.nativeId)?.title, 'Restored remotely');
    assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-2');
    assert.equal((await f.store.listRemoteDeleteDecisions(scope, ['applied'])).length, 1);
    assert.deepEqual(verifySyncResilienceCase('SYNC-0041', { pages: pagesBefore, ackCursors: f.ackRequests.map(row => JSON.parse(row.body).cursor),
      relatedBefore, independentMapping: await f.store.getMappingByColpId(scope, 'node-created-2'), health,
      decisionAfter: await f.store.getRemoteDeleteDecision(scope, decision.decisionId), restoredTitle: f.chromeNodes.get(restored.nativeId)?.title,
      cursorAfter: (await f.store.getCursor(scope))?.cursor }), []);
  } finally { f.store.close(); }
});
