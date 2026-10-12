import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { digestJson } from '../src/bookmark-event-codec.js';
import { installKns05IndexedDb, nativeOrUndefined, setup, scope } from './kns-05-pull-harness.js';
import { detachScopeMount, rejoinScopeMount } from '../src/scope-commands.js';
import { observationPauseBinding } from '../src/sync-state/remote-observation.js';

installKns05IndexedDb();

test('rejoin keeps a bookmark whose projection is only an optimistic local edit', async () => {
  const f = await setup();
  await f.store.setFirstRun(scope, 'completed');
  await f.store.putMountBinding(scope, {
    mountId: 'mount-bar', nativeRootId: 'native-root', remoteMountNodeId: 'root-colp',
    boundaryVersion: '1', materialized: false, status: 'active', rootRole: 'bookmarks-bar',
  });
  const edited = { title: 'Local title', url: 'https://example.test/' };
  await f.api.update('native-node', edited);
  const stored = (await f.store.getMappingByNativeId(scope, 'native-node'))!;
  const { scopeKey: _scopeKey, ...mapping } = stored as typeof stored & { scopeKey?: string };
  await f.store.putMapping(scope, {
    ...mapping,
    projection: { ...mapping.projection, revision: 'local-pending-edit', digest: digestJson(edited), content: edited },
  });
  const payload = {
    type: 'update_node_content', opId: 'op-local-edit', replicaId: scope.replicaId, sequence: 1,
    collectionId: scope.collectionId, baseRevision: 'revision-old', occurredAt: '2026-07-27T00:00:00.000Z',
    dependencies: [], targetId: 'node-1',
    payload: { base: { title: 'node-1' }, value: { title: 'Local title' } },
  };
  await f.store.allocateSequenceAndEnqueue(scope, {
    opId: 'op-local-edit', batchId: 'batch-local-edit', idempotencyKey: 'key-local-edit',
    digest: 'sha256:op-local-edit', endpointIdentity: 'syncPush', mediaType: 'application/json',
    baseRevision: 'revision-old', operationRevision: 'local-pending-edit', status: 'pending',
    retry: { attempt: 0, notBefore: 0 }, payload,
  }, { allowUnstamped: true });
  await detachScopeMount(f.store, scope, 'mount-bar');
  const mount = await f.store.getMountBinding(scope, 'mount-bar');
  await f.store.putRemoteObservation(scope, {
    colpId: 'node-1', remoteRevision: 'deleted-r2', cursor: 'c2', kind: 'tombstone',
    payload: { deleted: true }, sourceDigest: 'deleted', observedAt: Date.now(),
    ...observationPauseBinding(mount?.pauseBaseline),
  });
  const removed: string[] = [];
  await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(['native-root', 'native-node', 'native-child']), [], {
    getNative: async (id) => nativeOrUndefined(f.api, id),
    removeNative: async (id, tree) => {
      removed.push(`${id}:${tree}`);
      if (tree) await f.api.removeTree(id);
      else await f.api.remove(id);
    },
  });
  assert.deepEqual(removed, []);
  assert.equal(f.api.getNode('native-node')?.title, 'Local title');
});
