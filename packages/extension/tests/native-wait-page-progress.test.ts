import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { reopenT02, setupT02, t02Scope as scope } from './srg-t02-native-harness.js';
import { createDurableSyncEngine } from '../src/durable-sync-engine.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { canonicalOperationDigest, canonicalAuthoritativeEffectDigest } from '@know-n/colp/sync';
import { handleSyncAttentionRequest } from '../src/sw/sync-attention.js';
import { sendReplicaHealthReport } from '../src/sw/replica-health-report.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { endpoints, json } from './outbound-push-worker-harness.js';
import { confirmNativeWait, projectNativeWaits } from '../src/native-wait.js';

for (const legacy of [false, true]) test(`unknown native result defers without blocking subsequent Pull pages (legacy=${legacy})`, async () => {
  let f = await setupT02('after_create_before_evidence');
  try {
    await f.applier.stage(f.page([f.createEvent('Folder', 1), f.createEvent('Bookmark', 2)], 'cursor-page-1'));
    await assert.rejects(f.applier.resume(), /worker_crash/);
    f.disableCrash(); f = await reopenT02(f);
    await assert.rejects(f.applier.resume(), /native_result_unknown/);
    await f.applier.resume();
    assert.equal((await projectNativeWaits(f.store, scope)).length, 1);
    if (legacy) {
      const [wait] = await projectNativeWaits(f.store, scope); const intent = (await f.store.getApplyIntent(scope, wait!.intentId))!;
      const event = (await f.store.getPullEvent(scope, intent.eventId!))!;
      const { deferredNativeIntentId: _binding, ...oldEvent } = event;
      const { suspendedCorrelationId, ...oldIntent } = intent;
      const tx = (await f.store.open()).transaction(['pull_events', 'apply_intents'], 'readwrite');
      tx.objectStore('pull_events').put(oldEvent);
      tx.objectStore('apply_intents').put({ ...oldIntent, correlationId: suspendedCorrelationId });
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
      f = await reopenT02(f);
    }

    assert.equal(f.api.calls.filter(c => c.kind === 'create').length, 2, 'same-page sibling native application completed');
    let pulls = 0; let clock = 10000; const acks: string[] = [];
    const child = pullFixtures.createEvent({ kind: 'Folder', sequence: 4, collectionId: scope.collectionId, parentId: 'node-created-1' });
    const anchored: any = f.createEvent('Bookmark', 5);
    anchored.effect.placement.afterId = 'node-created-1';
    anchored.effect.effectDigest = canonicalAuthoritativeEffectDigest(anchored.effect);
    const grandchild = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 7, collectionId: scope.collectionId, parentId: 'node-created-4' });
    const deletion = pullFixtures.mutationEvent({ kind: 'delete', sequence: 8, collectionId: scope.collectionId, targetId: 'node-created-1', parentId: 'root-colp' });
    const later: any[] = [f.createEvent('Folder', 3), child, anchored, grandchild, deletion];
    for (const event of later) { event.effect.operationDigest = canonicalOperationDigest(event.operation); event.effect.effectDigest = canonicalAuthoritativeEffectDigest(event.effect); }
    const engine = () => createDurableSyncEngine({ scope, store: f.store, endpoints: async () => endpoints,
      now: () => clock, sessions: { get: async () => ({ credential: { accessToken: 'token' }, session: {
        sessionId: 'session-t02', expiresAt: '2099-01-01T00:00:00Z', scope: 'collection', snapshotRequired: false,
        acceptedProtocolVersion: '0.2', credentialAuthorityDigest: 'a'.repeat(64), collection: { collectionId: scope.collectionId, serverCursor: 'cursor-old', serverRevision: 'revision-old' },
        replicaLease: { leaseId: 'lease-t02', generation: '1', state: 'active', expiresAt: '2099-01-01T00:00:00Z' } } }) },
      pullApplier: f.applier, pushWorker: { drain: async () => ({ outcome: 'idle' }) },
      snapshotProjector: async () => { throw new Error('unexpected_snapshot'); },
      fetch: async (url, init) => {
        if (String(url).includes('/pull')) { pulls++; return json(200, f.page(pulls === 1 ? later : [], 'cursor-page-2')); }
        acks.push(JSON.parse(String(init?.body)).cursor);
        return json(200, { replicaId: scope.replicaId, ackedCursor: JSON.parse(String(init?.body)).cursor, ackedAt: '2026-10-18T00:00:00Z' });
      } });
    for (let n = 0; n < 3; n++) { await engine().wake('manual'); clock += 30000; }
    assert.ok(pulls > 0, 'independent later-page changes must be requested');
    assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-page-2');
    assert.ok(acks.includes('cursor-page-2'));
    assert.equal(f.api.calls.filter(c => c.kind === 'create').length, 3);
    assert.equal((await f.store.listPullEvents(scope, ['awaiting_confirmation'])).length, 5);
    assert.equal((await f.store.listPullIssues(scope)).length, 0);
    const status = await handleSyncAttentionRequest({ scope: async () => scope, store: f.store });
    assert.ok(status.ok && (status.attention.issueCount ?? 0) > 0);
    let health: any;
    await sendReplicaHealthReport({ scope, store: f.store, storage: new MemoryStorageArea(), origin: 'chrome-extension://test',
      now: () => clock, mode: async () => 'enabled',
      credential: async () => ({ accessToken: 'token', subject: scope.accountId, serverOrigin: scope.serverOrigin }),
      fetch: async (_url, init) => { health = JSON.parse(String(init?.body)); return json(200, {}); } });
    assert.equal(health.state, 'degraded');
    assert.ok(health.issues.items.some((issue: any) => issue.code === 'native_result_unknown'));
    await f.store.prunePullHistory(scope, 1, { maxEvents: 1, maxBytes: 1 });
    f = await reopenT02(f);
    const [wait] = await projectNativeWaits(f.store, scope); assert.ok(wait);
    const unknown = await f.store.getApplyIntent(scope, wait.intentId);
    assert.equal(unknown?.nativeResult, 'result_unknown');
    assert.equal(unknown?.apiResultEvidence, null);
    const retained = await f.store.getPullEvent(scope, unknown!.eventId!);
    assert.ok((await f.store.listPullPages(scope)).some(page => page.pageId === retained?.pageId), 'original evidence page survives pruning');
    const nativeId = f.api.calls.find(c => c.kind === 'create')!.nativeId!;
    assert.equal((await confirmNativeWait({ scope, store: f.store, api: f.api, waitRef: wait.waitRef, intentId: wait.intentId,
      generation: scope.generation, action: 'bind', nativeId })).ok, true);
    for (let n = 0; n < 3; n++) { await engine().wake('manual'); clock += 30000; }
    assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-page-2');
    assert.equal((await projectNativeWaits(f.store, scope)).length, 0);
    assert.equal((await f.store.listPullEvents(scope, ['awaiting_confirmation'])).length, 0);
    assert.ok(await f.store.getMappingByColpId(scope, 'node-created-4'));
    assert.ok(await f.store.getMappingByColpId(scope, 'node-created-5'));
    assert.ok(await f.store.getMappingByColpId(scope, 'node-created-7'));
    assert.equal(f.api.calls.filter(c => c.kind === 'create').length, 6, 'only the three deferred creates are new');

  } finally { f.store.close(); }
});
