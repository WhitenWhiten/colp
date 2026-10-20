import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { keepLocalFromDecision } from '../src/remote-delete-apply.js';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { createPullApplier } from '../src/pull-applier.js';
import type { SyncScope } from '../src/sync-state-store.js';
import { installKns05IndexedDb, setup as setupPull, scope as pullScope } from './kns-05-pull-harness.js';
import { endpoints } from './outbound-push-worker-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

installKns05IndexedDb();

const sessions = (scope: SyncScope) => ({ async get() { return {
  credential: { accessToken: 'test-token' }, session: {
    sessionId: 'test-session', expiresAt: '2099-01-01T00:00:00Z', scope: 'collection' as const,
    snapshotRequired: false, credentialAuthorityDigest: 'a'.repeat(64),
    collection: { collectionId: scope.collectionId, serverCursor: 'cursor-old', serverRevision: 'revision-old' },
    replicaLease: { leaseId: 'lease', generation: '1', state: 'active' as const, expiresAt: '2099-01-01T00:00:00Z' },
  },
}; } });

for (const edit of ['content', 'move'] as const) {
for (const phase of ['inbox', 'pending', 'rejected', 'terminal_applied', 'terminal_conflict'] as const) {
  test(`remote subtree deletion preserves ${phase} ${edit} edits through an actionable decision`, async () => {
  const f = await setupPull();
  try {
    await f.store.putMapping(pullScope, { nativeId: 'native-node', colpId: 'node-1', rootNativeId: 'native-root',
      parentNativeId: 'native-root', parentColpId: 'root-colp', nodeKind: 'folder',
      projection: { revision: 'revision-old', childrenRevision: 'folder-children-old', digest: 'folder', content: { title: 'Folder' } } });
    f.api.seed({ id: 'native-node', parentId: 'native-root', index: 0, title: 'Folder' });
    await f.api.move('native-child', { parentId: 'native-node', index: 0 });
    await f.store.putMapping(pullScope, { nativeId: 'native-child', colpId: 'node-child', rootNativeId: 'native-root',
      parentNativeId: 'native-node', parentColpId: 'node-1', nodeKind: 'bookmark',
      projection: { revision: 'revision-old', digest: 'child', content: { title: 'Before', url: 'https://example.test/' } } });
    f.api.seed({ id: 'native-child', parentId: 'native-node', index: 0, title: 'Before', url: 'https://example.test/' });
    const queue = createBookmarkEventQueue({ scope: pullScope, store: f.store, autoFlush: phase !== 'inbox', api: {
      get: async id => (await f.api.get(id)).map(row => ({ ...row, title: row.title ?? '' })),
      getChildren: async id => (await f.api.getChildren(id)).map(row => ({ ...row, title: row.title ?? '' })),
    } });
    const title = edit === 'content' ? 'Unique offline edit' : 'Before';
    if (edit === 'content') {
      await f.api.update('native-child', { title });
      await queue.changed('native-child', { title }, 'callback');
    } else {
      await f.api.move('native-child', { parentId: 'native-root', index: 1 });
      assert.equal((await queue.moved('native-child', f.api.lastEvent!.details)).outcome, 'staged');
    }
    const worker = createOutboundPushWorker({ scope: pullScope, store: f.store,
      endpoints: async () => endpoints, sessions: sessions(pullScope), now: () => Date.now(),
      ownerId: () => 'audit-deleted-worker', schedule: () => undefined,
      fetch: async () => new Response(JSON.stringify({ type: 'https://know-n.com/colp/problems/resource_not_found',
        title: 'resource_not_found', code: 'resource_not_found', status: 404, retryable: false }),
      { status: 404, headers: { 'Content-Type': 'application/problem+json' } }),
    });
    if (phase === 'rejected') {
      await worker.drain();
      assert.equal((await f.store.listQueue(pullScope))[0]?.status, 'rejected');
    }
    if (phase === 'terminal_applied' || phase === 'terminal_conflict') {
      const queued = (await f.store.listQueue(pullScope))[0]!;
      await f.store.completeQueueWithReceipt(pullScope, queued.sequence, {
        opId: queued.opId, operationDigest: queued.digest, kind: 'terminal', receiptId: 'local-edit-receipt',
        resultDigest: 'sha256:edit-result', result: { results: [{ opId: queued.opId, sequence: queued.sequence,
          status: phase === 'terminal_applied' ? 'applied' : 'conflict', targetId: 'node-child', revision: 'edit-r2' }] },
      });
    }
    const authoredQueue = await f.store.listQueue(pullScope);
    const remoteDelete = pullFixtures.subtreeEvent({ sequence: 2, collectionId: pullScope.collectionId,
      targetId: 'node-1', members: ['node-1', 'node-child'], paged: false });
    await createPullApplier(f.options).stage(f.page([remoteDelete]));
    await createPullApplier(f.options).resume();
    const decisions = await f.store.listRemoteDeleteDecisions(pullScope, ['pending']);
    if (phase === 'terminal_applied') {
      assert.equal(decisions.length, 0);
      assert.equal(f.api.getNode('native-child'), undefined);
      return;
    }
    assert.equal(f.api.getNode('native-child')?.title, title);
    assert.equal(decisions.length, 1);
    const decision = decisions[0]!;
    assert.equal(decision.policy, 'confirm');
    f.store.close();
    await createPullApplier(f.options).resume();
    assert.equal(f.api.getNode('native-child')?.title, title, 'protection survives restart');
    const action = phase === 'pending' && edit === 'content' ? 'apply' : 'keep_local';
    await f.store.decideRemoteDelete(pullScope, { decisionId: decision.decisionId, action,
      expectedCasVersion: decision.casVersion, deleteRevision: decision.deleteRevision,
      generation: pullScope.generation, now: Date.now(), permissionGranted: true });
    if (action === 'keep_local') {
      const raw = await f.store.getPullEvent(pullScope, decision.eventId);
      await keepLocalFromDecision(f.store, pullScope, raw!.payload as never, decision, Date.now);
    }
    await createPullApplier(f.options).resume();
    assert.equal(f.api.getNode('native-child')?.title, action === 'keep_local' ? title : undefined);
    if (action === 'keep_local') {
      f.store.close();
      assert.equal((await f.store.getLocalSyncExclusion(pullScope, 'native-child'))?.priorColpId, 'node-child');
      assert.equal((await f.store.getRemoteDeleteDecision(pullScope, decision.decisionId))?.state, 'keep_local');
      assert.deepEqual(await f.store.listQueue(pullScope), authoredQueue, 'retention does not manufacture an upload acknowledgement');
      if (edit === 'move') assert.equal(f.api.getNode('native-child')?.parentId, 'native-root');
    }
    assert.equal((await f.store.getCursor(pullScope))?.cursor, 'cursor-next');
  } finally { f.store.close(); }
});

}
}
