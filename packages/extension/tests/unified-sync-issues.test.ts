import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { readOpenSyncIssues } from '../src/sync-issues.js';
import { handleSyncAttentionRequest } from '../src/sw/sync-attention.js';
import { sendReplicaHealthReport } from '../src/sw/replica-health-report.js';
import { installKns05IndexedDb, scope, setup } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';
installKns05IndexedDb();

test('durably parked native work is one shared issue for protection, health and Status; reopening closes it', async () => {
  const f = await setup();
  try {
    const event = await f.store.stageBookmarkEvent(scope, { eventId: 'parked-event', dedupeKey: 'parked-event',
      kind: 'change', nativeId: 'native-node', occurredAt: '2026-10-17T00:00:00Z', details: {} });
    const marker = { eventId: event.event.eventId, state: 'parked' as const, code: 'operation_schema_invalid', attempts: 5,
      at: '2026-10-17T00:00:00Z' };
    await f.store.putIngressDiagnostic(scope, { code: 'park:parked-event', park: marker });
    const open = await readOpenSyncIssues(f.store, scope);
    assert.equal(open.total, 1); assert.ok(open.roots.has('node-1')); assert.ok(open.nativeRoots.has('native-node'));
    const attention = await handleSyncAttentionRequest({ scope: async () => scope, store: f.store });
    assert.equal(attention.ok, true); if (!attention.ok) return;
    assert.equal(attention.attention.issueCount, open.total); assert.equal(attention.attention.recoveryFrozen, false);
    assert.equal(attention.attention.rebuildAvailable, true);
    let report: any;
    await sendReplicaHealthReport({ scope, store: f.store, storage: new MemoryStorageArea(), now: () => 1000,
      mode: async () => 'enabled', origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
      credential: async () => ({ accessToken: 'token', subject: scope.accountId, serverOrigin: scope.serverOrigin }),
      fetch: async (_url, init) => { report = JSON.parse(String(init?.body)); return Response.json({}); } });
    assert.equal(report.issues.total, open.total); assert.equal(report.state, 'degraded');
    assert.deepEqual(report.issues.items.map((issue: any) => issue.code), ['operation_schema_invalid']);
    assert.deepEqual(report.actions, ['rebuild']);
    await f.applier.stage(f.page([pullFixtures.mutationEvent({ kind: 'delete', sequence: 91,
      collectionId: scope.collectionId, targetId: 'node-1', parentId: 'root-colp' })], 'cursor-1'));
    await f.applier.resume(); assert.ok(f.api.getNode('native-node'));
    assert.ok(await f.store.getLocalSyncExclusion(scope, 'native-node'));
    await f.store.putIngressDiagnostic(scope, { code: 'park:parked-event', park: { ...marker, state: 'open' } });
    assert.equal((await readOpenSyncIssues(f.store, scope)).total, 0, 'historical diagnostics do not keep a closed issue open');
  } finally { f.store.close(); }
});

test('a processed source event closes a parked diagnostic without deleting its audit evidence', async () => {
  const f = await setup();
  try {
    await f.store.stageBookmarkEvent(scope, { eventId: 'processed-event', dedupeKey: 'processed-event', kind: 'change',
      nativeId: 'native-node', occurredAt: '2026-10-17T00:00:00Z', details: {} });
    await f.store.putIngressDiagnostic(scope, { code: 'park:processed-event', park: { eventId: 'processed-event',
      state: 'parked', code: 'content_unavailable', attempts: 5, at: '2026-10-17T00:00:00Z' } });
    assert.equal((await readOpenSyncIssues(f.store, scope)).total, 1);
    await f.store.commitBookmarkEvent(scope, 'processed-event', { operation: { type: 'update_node_content', targetId: 'node-1',
      baseRevision: 'revision-old', dependencies: [], payload: { base: { title: 'node-1' }, value: { title: 'Edited' } } },
      baseRevision: 'revision-old', operationRevision: 'local-processed', allocateOperationId: () => 'op-processed',
      validateOperation: () => true, digestOperation: () => 'sha256:processed' });
    assert.equal((await readOpenSyncIssues(f.store, scope)).total, 0);
    assert.ok((await f.store.listIngressDiagnostics(scope)).some(row => row.park?.eventId === 'processed-event'));
  } finally { f.store.close(); }
});
