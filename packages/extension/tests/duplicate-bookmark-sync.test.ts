import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { createSyncStateStore, type BootstrapRunRecord } from '../src/sync-state-store.js';
import { createBootstrapCoordinator } from '../src/bootstrap/coordinator.js';
import { publicAttentionSummary, pageAttention } from '../src/bootstrap/attention-report.js';
import { handleAttentionGet, withAttention } from '../src/sw/first-run-attention.js';
import { readOpenSyncIssues } from '../src/sync-issues.js';
import { handleSyncAttentionRequest } from '../src/sw/sync-attention.js';
import { sendReplicaHealthReport } from '../src/sw/replica-health-report.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { installKns03IndexedDb, indexedDB, setup, scope, root, barMount, baseConfirm, bookmark } from './kns-03-bootstrap-harness.js';
installKns03IndexedDb();

test('identical bookmarks remain independent uploads and first sync completes without duplicate review', async () => {
  const { store, coordinator } = await setup();
  try {
    const input = baseConfirm({ localFacts: [bookmark('first', 'https://example.test/repeated', 'Repeated'),
      bookmark('second', 'https://example.test/repeated', 'Repeated')], mounts: [barMount('mount-bar')],
    remoteFacts: [root, { nodeId: 'mount-bar', parentId: root.nodeId, kind: 'folder', title: 'Bar',
      folderRole: 'bookmarks-bar', revision: 'r1' }, { nodeId: 'existing', parentId: 'mount-bar',
      kind: 'bookmark', title: 'Repeated', url: 'https://example.test/repeated', revision: 'r1' }] });
    const view = await coordinator.confirm(input);
    assert.ok(view.report!.candidates.length > 0, 'ambiguous identity matching remains conservative');
    assert.equal(view.run.attention?.items.length ?? 0, 0);
    assert.equal((await coordinator.status()).phase, 'syncing');
    assert.equal((await store.getScope(scope))?.firstRun, 'running', 'real pending uploads must still finish');
    const uploads = await store.listQueue(scope);
    assert.equal(uploads.length, 2);
    assert.notEqual(uploads[0]!.opId, uploads[1]!.opId);
    for (const row of uploads) {
      assert.equal(row.payload.type, 'create_node');
      await store.completeQueueWithReceipt(scope, row.sequence, { opId: row.opId, operationDigest: row.digest,
        kind: 'terminal', receiptId: `receipt-${row.sequence}`, resultDigest: `sha256:${row.sequence}`,
        result: { results: [{ opId: row.opId, sequence: row.sequence, status: 'applied',
          targetId: `uploaded-${row.sequence}`, revision: `r-${row.sequence}` }] } });
    }
    assert.equal((await coordinator.advance(view.run.runId, input)).run.phase, 'completed');
    assert.equal((await store.getScope(scope))?.firstRun, 'completed');
    assert.equal((await readOpenSyncIssues(store, scope)).total, 0);
    assert.equal((await store.listQueue(scope)).length, 2, 'no deduplication or extra upload on resume');
    // Older workers could stop after persisting needs_attention but before
    // committing firstRun=completed. Resume that last commit without reuploading.
    const completed = (await store.listBootstrapRuns(scope))[0]!;
    await store.putBootstrapRun(scope, { ...completed, phase: 'needs_attention' });
    await store.setFirstRun(scope, 'running');
    await coordinator.advance(completed.runId, input);
    assert.equal((await store.getScope(scope))?.firstRun, 'completed');
    assert.equal((await store.listQueue(scope)).length, 2);
  } finally { store.close(); }
});

for (const mixed of [false, true]) test(`legacy duplicate reviews disappear across restart without changing bookmark work (real difference=${mixed})`, async () => {
  const { store } = await setup();
  try {
    await store.setFirstRun(scope, 'completed');
    const items: NonNullable<BootstrapRunRecord['attention']>['items'] = [
      ...Array.from({ length: 14 }, (_, i) => ({ itemId: `duplicate-${i}`, kind: 'duplicate_candidate' as const,
        locationCount: 2, decision: 'open' as const, nodeRefs: [`native-${i}`, `cloud-${i}`] })),
      ...(mixed ? [{ itemId: 'real-difference', kind: 'local_difference' as const, locationCount: 2,
        decision: 'open' as const, nodeRefs: ['native-real', 'cloud-real'] }] : []),
    ];
    await store.putBootstrapRun(scope, { runId: 'legacy', confirmationId: 'legacy', bootstrapMode: 'merge',
      phase: 'needs_attention', updatedAt: 100, attention: { reportId: 'legacy', version: 1, candidateCount: 14,
        conflictCount: mixed ? 1 : 0, localOnlyCount: 0, remoteOnlyCount: 0, matchedCount: 14, createdAt: 100, items } });
    store.close();
    const restarted = createSyncStateStore({ indexedDB });
    try {
      const run = (await restarted.listBootstrapRuns(scope))[0]!;
      assert.equal(publicAttentionSummary(run.attention!).pendingCount, mixed ? 1 : 0);
      assert.equal(pageAttention(run.attention!).items.length, mixed ? 1 : 0);
      const status = await createBootstrapCoordinator({ store: restarted, scope }).status();
      assert.equal(status.phase, mixed ? 'needs_attention' : 'completed');
      assert.equal(withAttention(status.phase, 'completed', status).ok, true);
      const page = await handleAttentionGet(restarted, scope, 'legacy', undefined, 'completed');
      assert.equal(page.ok && 'phase' in page && page.phase, mixed ? 'needs_attention' : 'completed');
      const attention = await handleSyncAttentionRequest({ store: restarted, scope: async () => scope });
      assert.equal(attention.ok && attention.attention.issueCount, mixed ? 1 : 0);
      const bodies: any[] = [];
      await sendReplicaHealthReport({ store: restarted, scope, storage: new MemoryStorageArea(),
        mode: async () => 'enabled', origin: 'chrome-extension://test', now: () => 1000,
        credential: async () => ({ accessToken: 'test', subject: scope.accountId, serverOrigin: scope.serverOrigin }),
        commands: { replica: async () => ({ outcome: 'failed' }), serverRebuild: async () => ({ outcome: 'failed' }),
          issue: async () => ({ outcome: 'failed' }) }, fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body)); bodies.push(body);
          return Response.json({ replicaId: scope.replicaId, revision: body.revision, accepted: true, commands: [] });
        } });
      assert.equal(bodies[0].issues.total, mixed ? 1 : 0);
      assert.deepEqual(bodies[0].actions, [], 'merge review never calls for a replica reset');
      assert.equal(bodies[0].state, mixed ? 'degraded' : 'syncing');
      assert.deepEqual(await restarted.listQueue(scope), []);
      assert.deepEqual(await restarted.listMappings(scope), []);
    } finally { restarted.close(); }
  } finally { store.close(); }
});
