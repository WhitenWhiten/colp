import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createAuthorityFence } from '../src/authority-fence.js';
import type { CompleteRemoteSnapshot } from '../src/bootstrap/remote-snapshot.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { captureBoundaryAttempt } from '../src/sw/boundary-attempt.js';
import { pendingRejoinAdmission, rejoinNative } from '../src/sw/rejoin-native.js';
import { syncState } from '../src/sw/runtime.js';
import type { JsonObject, SyncScope } from '../src/sync-state-store.js';

// Admission, consumed previews, the native tree adapter and authority fence are
// real. The complete remote snapshot, subscription persistence and Chrome are ports.
const remote = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../src/sw/advanced-first-run.js', () => ({ readSnapshotAuthority: remote.read }));
vi.mock('../src/sw/runtime.js', async () => {
  const { IDBFactory } = await import('fake-indexeddb');
  const { createSyncStateStore } = await import('../src/sync-state-store.js');
  return { syncState: { ...createSyncStateStore({ indexedDB: new IDBFactory() }) },
    rootScopeKey: (value: unknown) => JSON.stringify(value) };
});
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => scope }));
vi.mock('../src/bookmark-subscriptions/store.js', () => ({ subscriptionStore: {
  pendingOperations: async () => [], all: async () => [], count: async () => 0, ready: async () => {},
} }));

let scope: SyncScope, storage: MemoryStorageArea, raw: Awaited<ReturnType<typeof chrome.bookmarks.getTree>>, serial = 0;
const snapshot: CompleteRemoteSnapshot = { snapshotId: 'fresh-snapshot', revision: 'r1', syncCursor: 'cursor1',
  remoteFacts: [], pageCount: 1, identityDigest: 'sha256:snapshot' };
beforeEach(async () => {
  scope = { environment: 'development', serverId: 'server', serverOrigin: 'https://known.test',
    accountId: `native-admission-${++serial}`, browserProfileId: 'profile', collectionId: 'collection',
    replicaId: 'replica', generation: 1 };
  storage = new MemoryStorageArea();
  raw = [{ id: '0', title: '', children: [
    { id: '1', parentId: '0', title: 'Bar', folderType: 'bookmarks-bar', children: [
      { id: '10', parentId: '1', title: 'Selected descendant', children: [] },
      { id: '30', parentId: '1', title: 'Unbound descendant', children: [] },
    ] },
    { id: '2', parentId: '0', title: 'Other', folderType: 'other', children: [
      { id: '20', parentId: '2', title: 'Unselected descendant', children: [] },
    ] },
  ] }];
  vi.stubGlobal('chrome', { storage: { local: storage }, bookmarks: {
    getTree: vi.fn(async () => structuredClone(raw)),
    get: vi.fn(async (id: string) => [{ id, title: 'Native', parentId: '1' }]),
    update: vi.fn(async (id: string, changes: object) => ({ id, ...changes })),
  } });
  remote.read.mockReset().mockResolvedValue({ snapshot });
  await syncState.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: Date.now() + 60_000 },
    checkpoint: { serverRevision: 'r0', cursor: 'c0' }, selectedRoots: [], privateRoots: [],
    rootStatus: 'ready', firstRun: 'completed' });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => syncState.close());

async function admit(payload: JsonObject = {}) {
  await syncState.putScopePreview(scope, { previewId: 'preview', kind: 'range', boundaryVersion: '0',
    treeDigest: 'sha256:tree', bookmarkCount: 0, folderCount: 5, skippedCount: 0,
    expiresAt: Date.now() + 60_000, warnings: [],
    boundary: { selectedNativeIds: ['1', '2'], excludedNativeIds: [], mounts: [] } });
  return syncState.admitBoundaryCommand(scope, { commandId: 'command', previewId: 'preview', kind: 'range',
    requestDigest: 'sha256:request', boundaryVersion: '0', treeDigest: 'sha256:tree',
    payload: { libraryId: scope.collectionId, selectedNativeIds: ['1'],
      rejoinNativeIds: ['1', '10', '20', 'missing', '30', 42], ...payload } });
}
async function mount(nativeRootId: string) {
  await syncState.putMountBinding(scope, { mountId: `mount-${nativeRootId}`, nativeRootId,
    remoteMountNodeId: `remote-${nativeRootId}`, status: 'detached', materialized: true, boundaryVersion: '0',
    ...(nativeRootId === '1' ? { rootRole: 'bookmarks-bar' } : { customSourceKey: `folder:${nativeRootId}` }) });
}

test('a rejoin native port preserves admitted roots and checks the same attempt around a fresh snapshot', async () => {
  const attempt = await captureBoundaryAttempt(scope);
  const admitted = ['10'];
  const api = await rejoinNative(scope, attempt, admitted);
  expect(api.admittedNativeRootIds).toBe(admitted);
  expect(await api.readRemoteSnapshot!()).toBe(snapshot);
  expect(remote.read).toHaveBeenCalledExactlyOnceWith(scope);
  expect(await api.getNative('10')).toEqual({ id: '10', title: 'Native', parentId: '1' });
  await api.updateNative!('10', { title: '' });
  expect(chrome.bookmarks.update).toHaveBeenCalledExactlyOnceWith('10', { title: '' });
  expect((await rejoinNative(scope, attempt)).admittedNativeRootIds).toEqual([]);
});

test('authority revoked before a port call prevents both remote read and native mutation', async () => {
  const api = await rejoinNative(scope, await captureBoundaryAttempt(scope));
  await createAuthorityFence(storage).revoke();
  await expect(api.readRemoteSnapshot!()).rejects.toThrow('authority_fenced');
  await expect(api.updateNative!('10', { title: 'stale' })).rejects.toThrow('authority_fenced');
  expect(remote.read).not.toHaveBeenCalled(); expect(chrome.bookmarks.update).not.toHaveBeenCalled();
});

test('authority changed while the remote snapshot was loading rejects the completed result', async () => {
  const api = await rejoinNative(scope, await captureBoundaryAttempt(scope));
  remote.read.mockImplementationOnce(async () => {
    await createAuthorityFence(storage).revoke(); return { snapshot };
  });
  await expect(api.readRemoteSnapshot!()).rejects.toThrow('authority_fenced');
  expect(remote.read).toHaveBeenCalledTimes(1);
});

test('an unavailable remote snapshot remains a failure rather than empty rejoin authority', async () => {
  const failure = new Error('snapshot_incomplete'); remote.read.mockRejectedValueOnce(failure);
  const api = await rejoinNative(scope, await captureBoundaryAttempt(scope));
  await expect(api.readRemoteSnapshot!()).rejects.toBe(failure);
});

test('detached mounts alone grant no pending admission and do not inspect the native tree', async () => {
  await mount('10');
  expect(await pendingRejoinAdmission(scope, await captureBoundaryAttempt(scope))).toEqual([]);
  expect(chrome.bookmarks.getTree).not.toHaveBeenCalled();
});

test('a consumed live range command admits only mounted, discovered roots inside its confirmed selection', async () => {
  await admit();
  for (const id of ['1', '10', '20', 'missing']) await mount(id);
  const before = await syncState.exportScope(scope);
  expect(await pendingRejoinAdmission(scope, await captureBoundaryAttempt(scope))).toEqual(['1', '10']);
  expect(chrome.bookmarks.getTree).toHaveBeenCalledTimes(1);
  expect((await syncState.getScopePreview(scope, 'preview'))?.consumedBy).toBe('command');
  expect(await syncState.exportScope(scope)).toEqual(before);
});

test('first-run journals cannot act as range admission', async () => {
  const command = await admit();
  vi.spyOn(syncState, 'listPendingBoundaryCommands').mockResolvedValue([{ ...command, kind: 'first-run' }]);
  expect(await pendingRejoinAdmission(scope, await captureBoundaryAttempt(scope))).toEqual([]);
  expect(chrome.bookmarks.getTree).not.toHaveBeenCalled();
});

test.each(['multiple commands', 'missing scope', 'changed boundary', 'missing preview', 'different consumer',
  'different preview boundary', 'different tree digest'] as const)('pending admission fails closed on %s', async fault => {
  const command = await admit();
  const preview = (await syncState.getScopePreview(scope, 'preview'))!;
  if (fault === 'multiple commands') vi.spyOn(syncState, 'listPendingBoundaryCommands')
    .mockResolvedValue([command, { ...command, commandId: 'another' }]);
  if (fault === 'missing scope') vi.spyOn(syncState, 'getScope').mockResolvedValue(null);
  if (fault === 'changed boundary') await syncState.bumpBoundaryVersion(scope);
  if (fault === 'missing preview') vi.spyOn(syncState, 'getScopePreview').mockResolvedValue(null);
  if (fault === 'different consumer') vi.spyOn(syncState, 'getScopePreview')
    .mockResolvedValue({ ...preview, consumedBy: 'another' });
  if (fault === 'different preview boundary') vi.spyOn(syncState, 'getScopePreview')
    .mockResolvedValue({ ...preview, boundaryVersion: '1' });
  if (fault === 'different tree digest') vi.spyOn(syncState, 'getScopePreview')
    .mockResolvedValue({ ...preview, treeDigest: 'sha256:changed' });
  await expect(pendingRejoinAdmission(scope, await captureBoundaryAttempt(scope)))
    .rejects.toThrow('rejoin_boundary_changed');
  expect(chrome.bookmarks.getTree).not.toHaveBeenCalled();
  expect(remote.read).not.toHaveBeenCalled();
});

const malformedPlans: JsonObject[] = [
  { libraryId: 'another-collection' }, { selectedNativeIds: null }, { rejoinNativeIds: '10' },
];
test.each(malformedPlans)('unreadable or foreign prepared range data cannot grant admission: %j', async patch => {
  await admit(patch);
  await expect(pendingRejoinAdmission(scope, await captureBoundaryAttempt(scope)))
    .rejects.toThrow('rejoin_boundary_changed');
  expect(chrome.bookmarks.getTree).not.toHaveBeenCalled();
});

test('the boundary attempt is checked again after native tree discovery completes', async () => {
  await admit(); await mount('10');
  vi.mocked(chrome.bookmarks.getTree).mockImplementationOnce(async () => {
    await createAuthorityFence(storage).revoke(); return raw;
  });
  const before = await syncState.exportScope(scope);
  await expect(pendingRejoinAdmission(scope, await captureBoundaryAttempt(scope))).rejects.toThrow('authority_fenced');
  expect(await syncState.exportScope(scope)).toEqual(before);
});
