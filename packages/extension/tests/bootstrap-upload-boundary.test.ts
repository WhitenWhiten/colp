import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { assertBootstrapUploadAllowed } from '../src/bootstrap/upload-boundary.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import type { QueueOperation } from '../src/sync-state-store.js';
import { bar, scope, setup } from './sync-recovery-hardening-fixture.js';
import { installOutboundPushIndexedDb, setup as setupWorker } from './outbound-push-worker-harness.js';

installOutboundPushIndexedDb();
const queue = { opId: 'b3.confirm.create.3' } as QueueOperation;

describe('bootstrap dispatch rechecks current native privacy', () => {
  test.each(['valid', 'different-create', 'missing-journal', 'permission'] as const)(
    'a removed native uses only its durable removal ancestry: %s', async mode => {
      const store = await setup();
      try {
        await store.putMapping(scope, bar);
        await store.putMapping(scope, { nativeId: '3', colpId: `pending-${queue.opId}`, rootNativeId: '1',
          parentNativeId: '1', nodeKind: 'bookmark', projection: { revision: `local-${queue.opId}`, digest: 'd' } });
        await store.putMountBinding(scope, { mountId: 'mount', nativeRootId: '1', remoteMountNodeId: 'bar',
          boundaryVersion: '1', materialized: false, status: 'active', rootRole: 'bookmarks-bar' });
        if (mode !== 'missing-journal') await store.putDeletionJournal(scope, {
          nativeId: '3', ordinal: 1, kind: 'bookmark', parentNativeId: '1' });
        await store.stageBookmarkEvent(scope, { eventId: 'remove', dedupeKey: 'remove', nativeId: '3', kind: 'remove',
          occurredAt: '2026-10-17T00:00:00Z', details: { deleteNativeIds: ['3'], draft: {
            type: 'delete_node', targetId: mode === 'different-create' ? 'pending-other-create' : `pending-${queue.opId}`,
            baseRevision: `local-${queue.opId}`, payload: {} } } });
        const check = assertBootstrapUploadAllowed({ store, scope, queue, parentOf: async id => {
          if (id === '3') throw new Error(mode === 'permission' ? 'permission denied' : "Can't find bookmark for id.");
          return undefined;
        } });
        if (mode === 'valid') await check;
        else await assert.rejects(check, mode === 'permission' ? /permission denied/ : /Can't find bookmark/);
      } finally { store.close(); }
    });

  test('blocks an old queued create under a private ancestor before any network request', async () => {
    const store = await setup(); await store.putMapping(scope, bar);
    await store.putMapping(scope, { nativeId: '2', colpId: 'private-folder', rootNativeId: '1', nodeKind: 'folder',
      parentNativeId: '1', parentColpId: 'bar', projection: { revision: 'r1', digest: 'private' } });
    await store.configureBrowserRoots(scope, { discovered: [{ nativeId: '1', ancestorNativeIds: [] },
      { nativeId: '2', ancestorNativeIds: ['1'] }], selectedNativeIds: ['1'], privateNativeIds: ['2'], status: 'ready' });
  assert.deepEqual((await store.getScope(scope))?.privateRoots, ['private-folder']);
    await store.putMountBinding(scope, { mountId: 'mount', nativeRootId: '1', remoteMountNodeId: 'bar',
      boundaryVersion: '1', materialized: false, status: 'active', rootRole: 'bookmarks-bar' });
    const parents: Record<string, string> = { '3': '2', '2': '1' };
    const check = () => assertBootstrapUploadAllowed({ store, scope, queue, parentOf: async id => parents[id] });
    await assert.rejects(check(), /bootstrap_upload_excluded/);
    await store.configureBrowserRoots(scope, { discovered: [{ nativeId: '1', ancestorNativeIds: [] },
      { nativeId: '2', ancestorNativeIds: ['1'] }], selectedNativeIds: ['1'], privateNativeIds: [], status: 'ready' });
    await check();
    store.close();
  });

  test('rejects excluded durable work instead of perpetually retrying it', async () => {
    const fixture = await setupWorker(); let fetches = 0;
    const worker = createOutboundPushWorker({ ...fixture.options,
      assertUploadAllowed: async () => { throw new Error('bootstrap_upload_excluded'); },
      fetch: async () => { fetches += 1; throw new Error('must not send'); } });
    await worker.drain();
    assert.equal(fetches, 0);
    assert.equal((await fixture.store.getQueueByOpId(fixture.options.scope, fixture.queued.opId))?.status, 'rejected');
    await worker.drain();
    assert.equal(fetches, 0);
    assert.equal((await fixture.store.listIngressDiagnostics(fixture.options.scope))[0]?.code, 'unselected_range');
    assert.equal((await fixture.store.listIngressDiagnostics(fixture.options.scope))[0]?.count, 1);
    fixture.store.close();
  });
});
