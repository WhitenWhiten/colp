import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { createSyncStateStore, type BootstrapRunRecord, type FirstRunState,
  type ScopeCommandPlanRecord } from '../src/sync-state-store.js';
import { bookmark, deterministicIds, folder, memoryApi, scope } from './bookmark-event-queue-harness.js';

describe('P3-30 bookmark event mount capture boundaries', () => {
  let indexedDB: IDBFactory;
  beforeEach(() => { indexedDB = new IDBFactory(); });
  test('in-flight bootstrap keeps a pending mount as a capture boundary', async () => {
    const { queue, store, node } = await pendingMountFixture({
      indexedDB, firstRun: 'completed', remoteMountNodeId: null, bootstrapPhase: 'syncing',
    });
    assert.equal((await queue.created('pending-local', node)).outcome, 'staged');
    await queue.flush();
    assert.deepEqual(await store.listQueue(scope), []);
    assert.equal((await store.listBookmarkEvents(scope)).filter((event) => event.status === 'pending').length, 1);
  });

  test('in-flight rejoin keeps a pending mount as a capture boundary', async () => {
    const { queue, store, node } = await pendingMountFixture({
      indexedDB, firstRun: 'completed', remoteMountNodeId: 'mount-colp', rejoinPhase: 'comparing',
    });
    assert.equal((await queue.created('pending-local', node)).outcome, 'staged');
    await queue.flush();
    assert.equal((await store.listBookmarkEvents(scope)).filter((event) => event.status === 'pending').length, 0);
    assert.equal((await store.listQueue(scope)).length, 1);
  });

  test('pending mount with no in-flight bootstrap or rejoin is not a capture boundary after first-run completed', async () => {
    const { queue, store, node } = await pendingMountFixture({
      indexedDB, firstRun: 'completed', remoteMountNodeId: null,
    });
    assert.equal((await queue.created('pending-local', node)).outcome, 'filtered');
    await queue.flush();
    assert.deepEqual(await store.listQueue(scope), []);
    assert.equal((await store.listBookmarkEvents(scope)).filter((event) => event.status === 'pending').length, 0);
  });

});

async function pendingMountFixture(input: {
  readonly indexedDB: IDBFactory; readonly firstRun: FirstRunState; readonly remoteMountNodeId: string | null;
  readonly bootstrapPhase?: BootstrapRunRecord['phase']; readonly rejoinPhase?: ScopeCommandPlanRecord['phase'];
}) {
  const store = createSyncStateStore({ indexedDB: input.indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'collection-revision-3', cursor: 'cursor-3' }, selectedRoots: [],
    rootStatus: 'ready', firstRun: input.firstRun });
  await store.putMountBinding(scope, {
    mountId: 'mount-bar', nativeRootId: '1', remoteMountNodeId: input.remoteMountNodeId, boundaryVersion: '1',
    materialized: false, status: 'pending', rootRole: 'bookmarks-bar',
  });
  if (input.remoteMountNodeId) {
    await store.putMapping(scope, { nativeId: '1', colpId: input.remoteMountNodeId, rootNativeId: '1',
      nodeKind: 'folder', projection: { revision: 'server-root-r1', childrenRevision: 'children-server-root-r1',
        digest: 'sha256:server-root-r1', content: { title: 'Bar' } } });
  }
  if (input.bootstrapPhase) {
    await store.putBootstrapRun(scope, {
      runId: 'range-bootstrap', phase: input.bootstrapPhase, bootstrapMode: 'merge',
      confirmationId: 'range-confirm', updatedAt: 1,
    });
  }
  if (input.rejoinPhase) {
    await store.putScopeCommandPlan(scope, {
      commandId: 'rejoin:mount-bar', kind: 'rejoin', confirmationVersion: '1', baselineDigest: null,
      phase: input.rejoinPhase, dependencies: [], mountId: 'mount-bar', updatedAt: 1,
    });
  }
  const api = memoryApi();
  api.put(folder('0', '', 0, 'Root'));
  api.put(folder('1', '0', 0, 'Bar'));
  const node = bookmark('pending-local', '1', 0, 'Waiting', 'https://example.test/waiting');
  api.put(node);
  const queue = createBookmarkEventQueue({ scope, store, api, now: () => '2026-07-27T00:00:00Z',
    uuid: deterministicIds(), autoFlush: false });
  return { store, api, queue, node };
}
