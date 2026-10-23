import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { createBookmarkImportCoordinator } from '../src/bookmark-import-plan.js';
import { previewNetscapeBookmarkImport } from '../src/import-preview.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { SYNC_HISTORY_RETENTION_MS as TTL } from '../src/sync-state/history-retention.js';
import { transactionDone } from '../src/sync-state/idb.js';
import { STORES } from '../src/sync-state/schema.js';
import { scopeKey } from '../src/sync-state/scope-key.js';

const scope: SyncScope = { environment: 'production', serverId: 'server', serverOrigin: 'https://known.example',
  accountId: 'account', browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 };

for (const scenario of ['completed', 'paused', 'partial'] as const) {
  test(`${scenario} import retains completion after queue reclamation and a worker restart`, async () => {
    const factory = new IDBFactory();
    let store = createSyncStateStore({ indexedDB: factory });
    try {
      await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 9e12 },
        checkpoint: { cursor: 'current', serverRevision: 'rev' }, selectedRoots: [], firstRun: 'completed' });
      const conversion = previewNetscapeBookmarkImport(new TextEncoder().encode(
        '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><H3>Folder</H3><DL><p>'
        + (scenario === 'partial' ? '<DT><A HREF="https://example.test/child">Child</A>' : '') + '</DL><p></DL><p>'));
      let coordinator = createBookmarkImportCoordinator({ store, scope, now: () => 100 });
      const plan = await coordinator.commit({ conversion, choices: [{ sourceNodeId: conversion.tree[0]!.sourceNodeId,
        action: 'import', target: { nativeId: 'native-root', colpId: 'server-root', revision: 'r1' } }] });
      // Pause before the in-flight parent's receipt arrives. Children remain unqueued.
      if (scenario !== 'completed') await coordinator.pause(plan.planId);
      await settleAndApplyEcho(store, 1);
      if (scenario === 'completed') assert.equal((await coordinator.advance(plan.planId)).state, 'complete');
      assert.equal((await coordinator.status(plan.planId)).progress.terminal, 1);
      await store.compactScope(scope, { now: 1_000 });
      await store.compactScope(scope, { now: TTL + 1_000 });
      assert.equal(await store.getQueueReceipt(scope, 1), null);
      assert.equal((await store.listQueue(scope)).length, 0);
      store.close();
      store = createSyncStateStore({ indexedDB: factory });
      coordinator = createBookmarkImportCoordinator({ store, scope, now: () => TTL + 2_000 });
      const view = scenario === 'completed' ? await coordinator.status(plan.planId) : await coordinator.resume(plan.planId);
      assert.equal(view.progress.terminal, 1);
      assert.equal(view.progress.queued, scenario === 'partial' ? 1 : 0);
      if (scenario === 'partial') {
        const queued = (await store.listQueue(scope))[0]!;
        assert.equal(queued.sequence, 2);
        assert.equal((queued.payload.payload as { parentId: string }).parentId, 'created-1');
        await settleAndApplyEcho(store, 2);
        const finished = await coordinator.advance(plan.planId);
        assert.equal(finished.state, 'complete');
        assert.equal(finished.progress.terminal, 2);
        assert.equal(finished.progress.queued, 0);
      } else assert.equal(view.state, 'complete');
    } finally { store.close(); }
  });
}

async function settleAndApplyEcho(store: ReturnType<typeof createSyncStateStore>, sequence: number) {
  const row = (await store.listQueue(scope)).find(row => row.sequence === sequence)!;
  await store.completeQueueWithReceipt(scope, sequence, { opId: row.opId, operationDigest: row.digest,
    kind: 'terminal', receiptId: `receipt-${sequence}`, resultDigest: 'sha256:result', result: { results: [{
      opId: row.opId, sequence, status: 'applied', targetId: `created-${sequence}`, revision: `r${sequence}` }] } });
  const current = await store.getQueueByOpId(scope, row.opId);
  const tx = (await store.open()).transaction([STORES.queue, STORES.cursors], 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore(STORES.queue).put({ ...current, echoApplied: true });
  tx.objectStore(STORES.cursors).put({ scopeKey: scopeKey(scope), cursor: 'after-pull', checkpoint: 'r2',
    evidence: { pullPageId: 'page', pageDigest: 'sha256:page' } });
  await done;
}
