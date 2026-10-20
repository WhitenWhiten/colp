import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { digestJson, validateOperation } from '../src/bookmark-event-codec.js';
import { detachScopeMount, rejoinScopeMount } from '../src/scope-commands.js';
import { observationPauseBinding } from '../src/sync-state/remote-observation.js';
import { DEFAULT_MAX_RECORD_BYTES } from '../src/sync-state/codec.js';
import { runTransaction } from '../src/sync-state/idb.js';
import { validateQueueRecord } from '../src/sync-state/queue-validate.js';
import { STORES } from '../src/sync-state/schema.js';
import { installKns05IndexedDb, nativeOrUndefined, setup, scope } from './kns-05-pull-harness.js';

installKns05IndexedDb();

test.each([100, 1_000])('a second rejoin preserves its own unuploaded edit after %s earlier rows', async count => {
  const f = await setup();
  try {
    await f.store.setFirstRun(scope, 'completed');
    await f.store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: 'native-root',
      remoteMountNodeId: 'root-colp', boundaryVersion: '1', materialized: true,
      status: 'active', rootRole: 'bookmarks-bar' });
    const queue = createBookmarkEventQueue({ store: f.store, scope, autoFlush: false, api: {
      get: async id => (await f.api.get(id)).map(row => ({ ...row, title: row.title ?? '' })),
      getChildren: async id => (await f.api.getChildren(id)).map(row => ({ ...row, title: row.title ?? '' })),
    } });
    // The original 101st-row regression keeps every preceding real callback.
    // The pagination extension uses one captured row as a valid queue template.
    for (let index = 0; index < (count === 100 ? count : 1); index++) {
      const nativeId = `independent-${index}`;
      const content = { title: `Independent ${index}`, url: `https://example.test/${index}` };
      f.api.seed({ id: nativeId, parentId: 'native-root', index: index + 2, ...content });
      await f.store.putMapping(scope, { nativeId, colpId: `independent-colp-${index}`,
        rootNativeId: 'native-root', parentNativeId: 'native-root', parentColpId: 'root-colp',
        mountId: 'mount-bar', nodeKind: 'bookmark',
        projection: { revision: `before-${index}`, digest: `before-${index}`, content } });
      const title = `${content.title} edited`;
      await f.api.update(nativeId, { title });
      assert.equal((await queue.changed(nativeId, { title })).outcome, 'staged');
    }
    await queue.flush();
    if (count > 100) {
      const [captured] = await f.store.listQueue(scope);
      assert.ok(captured);
      const rows = Array.from({ length: count - 1 }, (_, offset) => {
        const sequence = offset + 2;
        const opId = crypto.randomUUID();
        const payload = { ...captured.payload, opId, sequence };
        // Bulk seed validated pending history derived from the real callback.
        // No successful receipt, Pull echo or terminal status is synthesized.
        const row = validateQueueRecord({ ...captured, sequence, payload, digest: digestJson(payload),
          opId, batchId: opId, idempotencyKey: opId, operationRevision: `local-${opId}` }, DEFAULT_MAX_RECORD_BYTES);
        assert.equal(validateOperation(row.payload), true);
        assert.equal(row.status, 'pending');
        return row;
      });
      await runTransaction(await f.store.open(), [STORES.queue, STORES.sequences], 'readwrite', async tx => {
        for (const row of rows) tx.objectStore(STORES.queue).add(row);
        tx.objectStore(STORES.sequences).put({ scopeKey: captured.scopeKey, next: count + 1 });
      });
    }
    assert.equal((await f.store.listQueue(scope, undefined, 0, 1_000)).length, count);
    await detachScopeMount(f.store, scope, 'mount-bar');
    await f.api.update('native-node', { title: 'Edited while paused' });
    const native = { getNative: (id: string) => nativeOrUndefined(f.api, id),
      getChildren: (id: string) => f.api.getChildren(id),
      updateNative: (id: string, value: { title?: string; url?: string }) => f.api.update(id, value),
      removeNative: (id: string, tree: boolean) => tree ? f.api.removeTree(id) : f.api.remove(id) };
    await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], native);
    const subject = (await f.store.listQueueByTarget(scope, 'node-1'))[0];
    assert.equal(subject?.sequence, count + 1);
    assert.equal(subject?.status, 'pending');
    assert.equal((await f.store.getMappingByNativeId(scope, 'native-node'))?.projection.revision, 'revision-old');
    const beforeQueue = await f.store.listQueue(scope, undefined, 0, 1_000);
    const mount = await f.store.getMountBinding(scope, 'mount-bar');
    await f.store.putRemoteObservation(scope, { colpId: 'node-1', remoteRevision: 'deleted-r2',
      cursor: 'c2', kind: 'tombstone', payload: { deleted: true }, sourceDigest: 'deleted',
      observedAt: Date.now(), ...observationPauseBinding(mount?.pauseBaseline) });
    const beforeCalls = f.api.calls.length;
    await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], native);
    assert.equal(f.api.getNode('native-node')?.title, 'Edited while paused');
    assert.equal(f.api.calls.length, beforeCalls, 'a later queue page protects the native edit before deletion');
    assert.deepEqual(await f.store.listQueue(scope, undefined, 0, 1_000), beforeQueue);
    assert.deepEqual(await f.store.getQueueByOpId(scope, subject!.opId), subject);
  } finally { f.store.close(); }
}, 15_000);
