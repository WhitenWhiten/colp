import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { subtreeDeleteSource } from '@know-n/colp/sync';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { captureSubtreeDeletion } from '../src/subtree-observation.js';
import { resolveSubtreePredecessors } from '../src/bookmark-subtree-predecessors.js';
import { setup as stateStore, scope } from './sync-recovery-hardening-fixture.js';
import { mapping, seedMappedNode, setupT03, t03Scope } from './srg-t03-delete-harness.js';

test('DS-04 removal captures exact descendant revisions and does not refresh them at flush', async () => {
  const f = await setupT03();
  await seedMappedNode(f, { nativeId: 'folder', colpId: 'node-1', parentNativeId: 'native-root',
    parentColpId: 'root-colp', nodeKind: 'folder' });
  await seedMappedNode(f, { nativeId: 'child', colpId: 'node-child', parentNativeId: 'folder',
    parentColpId: 'node-1', nodeKind: 'bookmark', url: 'https://child.test/' });
  const queue = createBookmarkEventQueue({ store: f.store, scope: t03Scope, autoFlush: false,
    api: { get: async id => (await f.api.get(id)).map(row => ({ ...row, title: row.title ?? '' })),
      getChildren: async id => (await f.api.getChildren(id)).map(row => ({ ...row, title: row.title ?? '' })) } });
  await queue.removed('folder', { parentId: 'native-root', index: 0,
    node: { id: 'folder', title: 'Folder', type: 'folder' } });
  const child = mapping('child', 'node-child', { parentNativeId: 'folder', parentColpId: 'node-1' });
  await f.store.putMapping(t03Scope, { ...child, projection: { ...child.projection, revision: 'new-unobserved' } });
  await queue.flush();
  const row = (await f.store.listQueue(t03Scope))[0]!;
  assert.deepEqual(row.payload.source, subtreeDeleteSource('node-1',
    [{ id: 'node-1', revision: 'revision-old' }, { id: 'node-child', revision: 'revision-old' }]));
});

test.each([false, true])('pending subtree removal uses only exact captured create receipts (child complete=%s)', async completeChild => {
  const store = await stateStore();
  try {
    const mappings = ['folder', 'child'].map((nativeId, index) => ({ nativeId,
      colpId: `pending-b3.confirm.create.${nativeId}`, rootNativeId: 'root',
      parentNativeId: index ? 'folder' : 'root', nodeKind: index ? 'bookmark' as const : 'folder' as const,
      projection: { revision: `local-b3.confirm.create.${nativeId}`, digest: 'd' } }));
    const captured = captureSubtreeDeletion(mappings[0]!.colpId, mappings);
    assert.equal(captured.source, undefined);
    for (const [index, mapping] of mappings.entries()) {
      const opId = mapping.colpId.slice(8);
      const queued = await store.allocateSequenceAndEnqueue(scope, { opId, batchId: opId, idempotencyKey: opId,
        digest: `digest-${index}`, endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null,
        operationRevision: mapping.projection.revision, status: 'pending', retry: { attempt: 0, notBefore: 0 },
        payload: { type: 'create_node', payload: { node: { kind: mapping.nodeKind, title: mapping.nativeId } } },
      }, { allowUnstamped: true });
      if (index === 1 && !completeChild) continue;
      await store.completeQueueWithReceipt(scope, queued.sequence, { opId, operationDigest: queued.digest,
        kind: 'terminal', receiptId: `receipt-${index}`, resultDigest: `result-${index}`, result: { results: [{
          opId, sequence: queued.sequence, status: 'applied', targetId: `remote-${mapping.nativeId}`, revision: `server-${index}` }] } });
    }
    const resolved = await resolveSubtreePredecessors(store, scope, 'remote-folder', captured.observation!);
    if (!completeChild) assert.deepEqual(resolved, { blocked: { nativeId: 'child', opId: 'b3.confirm.create.child' } });
    else assert.deepEqual(resolved, { source: subtreeDeleteSource('remote-folder', [
      { id: 'remote-folder', revision: 'server-0' }, { id: 'remote-child', revision: 'server-1' }] ) });
  } finally { store.close(); }
});
