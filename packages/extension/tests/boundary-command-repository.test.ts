import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test } from 'vitest';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { createBootstrapCoordinator } from '../src/bootstrap/coordinator.js';

const scope: SyncScope = { environment: 'development', serverId: 'server', serverOrigin: 'https://known.test',
  accountId: 'user', browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 };
const stores: ReturnType<typeof createSyncStateStore>[] = [];
afterEach(() => { for (const store of stores) store.close(); stores.length = 0; });

async function setup() {
  const factory = new IDBFactory(); const store = createSyncStateStore({ indexedDB: factory }); stores.push(store);
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: Date.now() + 60_000 },
    checkpoint: { serverRevision: 'r1', cursor: 'c1' }, firstRun: 'none', selectedRoots: [], boundaryVersion: '0' });
  await store.putScopePreview(scope, { previewId: 'preview', boundaryVersion: '0', treeDigest: 'sha256:tree',
    expiresAt: Date.now() + 30_000, bookmarkCount: 0, folderCount: 1, skippedCount: 0, warnings: [],
    boundary: { selectedNativeIds: ['bar'], excludedNativeIds: [], mounts: [] } });
  return { store, factory };
}
const command = (commandId = 'command', previewId = 'preview') => ({
  commandId, previewId, kind: 'first-run' as const, requestDigest: `digest:${previewId}`,
  boundaryVersion: '0', treeDigest: 'sha256:tree', payload: { libraryId: scope.collectionId },
});

test('competing confirmations atomically consume a preview only once', async () => {
  const { store } = await setup();
  const results = await Promise.allSettled([
    store.admitBoundaryCommand(scope, command('a')), store.admitBoundaryCommand(scope, command('b')),
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect((await store.getScope(scope))?.firstRun).toBe('running');
  const admitted = (await store.listPendingBoundaryCommands(scope))[0]!;
  expect((await store.getScopePreview(scope, 'preview'))?.consumedBy).toBe(admitted.commandId);
  expect((await store.getScope(scope))?.boundaryVersion).toBe('0');
});

test('admitted commands resume after restart and preview expiry, then replay a durable result without changing the boundary', async () => {
  const { store, factory } = await setup();
  await store.admitBoundaryCommand(scope, command());
  await store.advanceBoundaryCommand(scope, 'command', { error: 'tree_unavailable' });
  store.close();
  const reopened = createSyncStateStore({ indexedDB: factory }); stores.push(reopened);
  const expired = (await reopened.getScopePreview(scope, 'preview'))!;
  await reopened.putScopePreview(scope, { ...expired, expiresAt: 1 });
  expect((await reopened.admitBoundaryCommand(scope, command())).state).toBe('failed');
  expect(await reopened.listPendingBoundaryCommands(scope)).toHaveLength(1);
  const result = { ok: true, firstRun: 'running', phase: 'syncing' };
  await reopened.advanceBoundaryCommand(scope, 'command', { result });
  await reopened.bumpBoundaryVersion(scope); // A newer, independent range change.
  const repeated = await reopened.admitBoundaryCommand(scope, command());
  expect(repeated).toMatchObject({ state: 'committed', result, committedBoundaryVersion: '1' });
  expect((await reopened.getScope(scope))?.boundaryVersion).toBe('2');
});

test('a command id cannot be reused for a different preview or account generation', async () => {
  const { store } = await setup();
  await store.admitBoundaryCommand(scope, command());
  await expect(store.admitBoundaryCommand(scope, command('command', 'different'))).rejects.toThrow('confirmation_conflict');
  expect(await store.getBoundaryCommand({ ...scope, generation: 2 }, 'command')).toBeNull();
  await expect(store.admitBoundaryCommand({ ...scope, generation: 2 }, command())).rejects.toThrow('scope_not_found');
});

test('stale admission leaves the preview, first-run state and command journal untouched', async () => {
  const { store } = await setup();
  await store.bumpBoundaryVersion(scope);
  await expect(store.admitBoundaryCommand(scope, command())).rejects.toThrow('preview_stale');
  expect((await store.getScopePreview(scope, 'preview'))?.consumedAt).toBeUndefined();
  expect((await store.getScope(scope))?.firstRun).toBe('none');
  expect(await store.getBoundaryCommand(scope, 'command')).toBeNull();
});

test('bootstrap binding preserves detached lifecycle evidence and mounts outside the new run', async () => {
  const { store } = await setup();
  const pauseBaseline = { generation: 1, boundaryVersion: '0', lastAppliedCursor: 'c1', completeness: 'complete' as const };
  await store.putMountBinding(scope, { mountId: 'bar', nativeRootId: 'bar', remoteMountNodeId: 'remote-bar',
    status: 'detached', materialized: true, boundaryVersion: '0', rootRole: 'bookmarks-bar', pauseBaseline,
    pendingShift: { colpId: 'remote-bar', toParentNativeId: 'other' } });
  await store.putMountBinding(scope, { mountId: 'other', nativeRootId: 'other', remoteMountNodeId: 'remote-other',
    status: 'detached', materialized: true, boundaryVersion: '0', rootRole: 'other-bookmarks', pauseBaseline });
  await createBootstrapCoordinator({ store, scope }).confirm({ confirmationId: 'bootstrap', treeDigest: 'sha256:tree',
    confirmationVersion: '0', pauseAfter: 'confirmed', localFacts: [],
    mounts: [{ nativeRootId: 'bar', remoteMountNodeId: 'remote-bar', rootRole: 'bookmarks-bar' }] });
  expect(await store.getMountBinding(scope, 'bar')).toMatchObject({ status: 'detached', pauseBaseline,
    pendingShift: { colpId: 'remote-bar', toParentNativeId: 'other' } });
  expect(await store.getMountBinding(scope, 'other')).toMatchObject({ status: 'detached', pauseBaseline });
});

test('a late first-run authority write cannot replace newer range selection', async () => {
  const { store } = await setup();
  await store.bumpBoundaryVersion(scope);
  await expect(store.configureBrowserRoots(scope, { discovered: [{ nativeId: 'bar', ancestorNativeIds: [] }],
    selectedNativeIds: ['bar'], privateNativeIds: [], status: 'ready', expectedBoundaryVersion: '0',
  })).rejects.toThrow('preview_stale');
  expect((await store.getScope(scope))?.selectedRoots).toEqual([]);
  expect(await store.listMappings(scope)).toEqual([]);
});

test('advanced and ordinary confirmations cannot both acquire the same boundary', async () => {
  const { store } = await setup();
  const results = await Promise.allSettled([
    store.admitBoundaryCommand(scope, command()),
    store.commitAdvancedPlan(scope, { planId: 'advanced', metadata: { boundaryVersion: '0', mode: 'download' },
      steps: [], now: Date.now() }),
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect((await store.listPendingBoundaryCommands(scope)).length + (await store.listAdvancedPlans(scope)).length).toBe(1);
});
