import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { detachScopeMount, rejoinScopeMount } from '../src/scope-commands.js';
import { observationPauseBinding } from '../src/sync-state/remote-observation.js';
import { installKns05IndexedDb, nativeOrUndefined, setup, scope } from './kns-05-pull-harness.js';

installKns05IndexedDb();

for (const target of ['self', 'ancestor'] as const) {
  test.each(['refused', 'rejected', 'conflict', 'applied', 'noop'] as const)(
    `rejoin protects unresolved local intent from a ${target} deletion after a %s result`, async result => {
      const f = await setup();
      try {
        await f.store.setFirstRun(scope, 'completed');
        await f.store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: 'native-root',
          remoteMountNodeId: 'root-colp', boundaryVersion: '1', materialized: true,
          status: 'active', rootRole: 'bookmarks-bar' });
        const nativeId = target === 'self' ? 'native-node' : 'native-child';
        const colpId = target === 'self' ? 'node-1' : 'node-child';
        if (target === 'ancestor') {
          f.api.seed({ id: 'native-node', parentId: 'native-root', index: 0, title: 'Folder' });
          await f.store.putMapping(scope, { nativeId: 'native-node', colpId: 'node-1',
            rootNativeId: 'native-root', parentNativeId: 'native-root', parentColpId: 'root-colp',
            nodeKind: 'folder', projection: { revision: 'revision-old', digest: 'folder', content: { title: 'Folder' } } });
          await f.api.move(nativeId, { parentId: 'native-node', index: 0 });
          const { scopeKey: _key, ...child } = (await f.store.getMappingByNativeId(scope, nativeId))!;
          await f.store.putMapping(scope, { ...child, parentNativeId: 'native-node', parentColpId: 'node-1' });
        }
        await detachScopeMount(f.store, scope, 'mount-bar');
        await f.api.update(nativeId, { title: 'Only local copy' });
        const native = { getNative: (id: string) => nativeOrUndefined(f.api, id),
          getChildren: (id: string) => f.api.getChildren(id),
          removeNative: (id: string, tree: boolean) => tree ? f.api.removeTree(id) : f.api.remove(id) };
        await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], native);
        const row = (await f.store.listQueueByTarget(scope, colpId))[0];
        assert.ok(row);
        assert.equal((await f.store.getMappingByNativeId(scope, nativeId))?.projection.revision, 'revision-old');
        const lease = await f.store.acquireLease(scope, 'server-result', 1_000, 30_000);
        assert.equal((await f.store.claimNextQueue(scope, 'server-result', lease.fence, 1_000))?.opId, row.opId);
        // Production settlement consumes this simulated server result. It does
        // not rewrite an existing refusal or manufacture a successful echo.
        await f.store.settleClaimedPush(scope, row.sequence, 'server-result', lease.fence,
          result === 'refused' ? { outcome: 'rejected', recovery: { code: 'resource_not_found' } }
            : { outcome: 'terminal', receipt: { opId: row.opId, operationDigest: row.digest, kind: 'terminal',
              receiptId: `result-${result}`, resultDigest: `sha256:${result}`, result: { results: [
                { opId: row.opId, sequence: row.sequence, status: result, targetId: colpId,
                  ...(result === 'rejected' ? { code: 'resource_id_unavailable' } : {}) },
              ] } } });
        const beforeQueue = await f.store.listQueue(scope);
        const beforeReceipt = await f.store.getQueueReceipt(scope, row.sequence);
        assert.notEqual(beforeQueue[0]?.echoApplied, true);
        await detachScopeMount(f.store, scope, 'mount-bar');
        const mount = await f.store.getMountBinding(scope, 'mount-bar');
        await f.store.putRemoteObservation(scope, { colpId: 'node-1', remoteRevision: 'deleted-r2',
          cursor: 'c2', kind: 'tombstone', payload: { deleted: true }, sourceDigest: 'deleted',
          observedAt: Date.now(), ...observationPauseBinding(mount?.pauseBaseline) });
        const applied = result === 'applied' || result === 'noop';
        await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], native);
        assert.equal(f.api.getNode(nativeId)?.title, applied ? undefined : 'Only local copy');
        assert.equal(f.api.getNode('native-node') === undefined, applied);
        assert.deepEqual(await f.store.listQueue(scope), beforeQueue);
        assert.deepEqual(await f.store.getQueueReceipt(scope, row.sequence), beforeReceipt);
      } finally { f.store.close(); }
    });
}
