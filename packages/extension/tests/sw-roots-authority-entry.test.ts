import { expect, test, vi } from 'vitest';
import { expectNoWork, node, ports, replaceTree, scope, seedSelected, storage, tree } from './sw-authority-entry-fixture.js';
import { sw, syncState } from '../src/sw/runtime.js';
import { handleRootRequest, loadRootView, provisionDefaultSyncRoot, resolvePrivateRootNativeId,
  resumeBookmarksAfterPermissionGrant } from '../src/sw/roots.js';
import { handleFirstRunRequest } from '../src/sw/first-run.js';
import { FIRST_RUN_DRAFT } from '../src/first-run-draft.js';
import { bookmarkListenerLifecycle, recoverBookmarkEvents } from '../src/sw/bookmarks.js';
import { scheduleSyncEngineWake } from '../src/sw/engine.js';

test('only a root read joins a reconnecting session; disconnected writes cannot create authority', async () => {
  ports.scopeError = new Error('not_connected');
  expect(await handleRootRequest({ kind: 'known.roots.permissionChanged', granted: true, userGesture: true })).toEqual({ ok: false, error: 'not_connected' });
  expect(ports.joined).toBe(0);
  expect(await handleRootRequest({ kind: 'known.roots.get' })).toMatchObject({ ok: true, view: { status: 'ready' } });
  expect(ports.joined).toBe(1);
  ports.joinError = new Error('not_connected');
  expect(await handleRootRequest({ kind: 'known.roots.get' })).toEqual({ ok: false, error: 'not_connected' });
  await expectNoWork();
});

test('revocation hides native identifiers and invalidates view tokens without losing selection or mappings', async () => {
  await seedSelected(); const view = await loadRootView(scope);
  const mappings = await syncState.listMappings(scope), selected = (await syncState.getScope(scope))!.selectedRoots;
  expect(await resolvePrivateRootNativeId(scope)).toBe('20');
  expect(await handleRootRequest({ kind: 'known.roots.boundaries' })).toEqual({ ok: true,
    boundaries: { selected: ['1'], privateLocal: ['20'] } });
  ports.permission = false;
  expect(await handleRootRequest({ kind: 'known.roots.permissionChanged', granted: true, userGesture: true })).toEqual({ ok: false, error: 'request_invalid' });
  expect(await handleRootRequest({ kind: 'known.roots.boundaries' })).toEqual({ ok: true,
    boundaries: { selected: [], privateLocal: [] } });
  expect(await handleRootRequest({ kind: 'known.roots.permissionChanged', granted: false, userGesture: true })).toMatchObject({ ok: true,
    view: { status: 'permission_required', roots: [] } });
  expect(sw.rootViewTokens).toBeUndefined();
  expect(await handleRootRequest({ kind: 'known.roots.preview', viewId: view.viewId, selectedRefs: [], privateRefs: [] }))
    .toEqual({ ok: false, error: 'permission_required' });
  expect(await syncState.listMappings(scope)).toEqual(mappings);
  expect((await syncState.getScope(scope))?.selectedRoots).toEqual(selected);
  syncState.close();
  expect(await handleRootRequest({ kind: 'known.roots.get' })).toMatchObject({ ok: true, view: { status: 'permission_required' } });
  expect(await syncState.listMappings(scope)).toEqual(mappings);
  await expectNoWork();
});

test.each([false, true])('permission restoration reconciles durable identities even after an unreadable tree: %s', async unreadable => {
  await seedSelected(); const mappings = await syncState.listMappings(scope);
  ports.permission = false; await handleRootRequest({ kind: 'known.roots.get' });
  ports.permission = true;
  if (unreadable) ports.treeError = new Error('browser tree temporarily unavailable');
  const result = await handleRootRequest({ kind: 'known.roots.permissionChanged', granted: true, userGesture: true });
  expect(result).toMatchObject({ ok: true, view: { status: unreadable ? 'tree_unavailable' : 'ready' } });
  expect(await syncState.listMappings(scope)).toEqual(mappings);
  expect(bookmarkListenerLifecycle.install).toHaveBeenCalled();
  expect(recoverBookmarkEvents).toHaveBeenCalled(); expect(scheduleSyncEngineWake).toHaveBeenCalledWith('manual');
  ports.treeError = undefined;
  const restored = await handleRootRequest({ kind: 'known.roots.get' });
  expect(restored).toMatchObject({ ok: true, view: { status: 'ready' } });
  expect(await handleRootRequest({ kind: 'known.roots.boundaries' })).toEqual({ ok: true,
    boundaries: { selected: ['1'], privateLocal: ['20'] } });
  expect((await syncState.getMountBinding(scope, 'mount-bar'))?.remoteMountNodeId).toBe('remote-1');
  if (!unreadable) expect((await syncState.getMountBinding(scope, 'mount-bar'))?.lastReconcile?.treeDigest).toMatch(/^sha256:/u);
  await expectNoWork();
});

test('a read after reauthorization resumes capture, while a grant with no account cannot reconcile another scope', async () => {
  await seedSelected(); await syncState.setBrowserRootStatus(scope, 'permission_required');
  const before = await syncState.listMappings(scope);
  expect((await loadRootView(scope)).status).toBe('ready');
  expect(recoverBookmarkEvents).toHaveBeenCalledTimes(1);
  ports.scopeError = new Error('not_connected');
  await resumeBookmarksAfterPermissionGrant();
  expect(recoverBookmarkEvents).toHaveBeenCalledTimes(1);
  expect(await syncState.listMappings(scope)).toEqual(before);
  await expectNoWork();
});

test('boundary projection filters missing canonical identities instead of exposing unrelated native folders', async () => {
  expect(await resolvePrivateRootNativeId(scope)).toBeUndefined();
  expect(await handleRootRequest({ kind: 'known.roots.boundaries' })).toEqual({ ok: true,
    boundaries: { selected: [], privateLocal: [] } });
  await seedSelected(); await syncState.deleteMapping(scope, '20');
  expect(await resolvePrivateRootNativeId(scope)).toBeUndefined();
  expect(await handleRootRequest({ kind: 'known.roots.boundaries' })).toEqual({ ok: true,
    boundaries: { selected: ['1'], privateLocal: [] } });
  await expectNoWork();
});

test('blank browser labels and account/local duplicate roots retain distinct refs and explicit deep-link intent', async () => {
  await syncState.setFirstRun(scope, 'completed');
  replaceTree([{ id: '0', title: '', children: [
    { id: '1', parentId: '0', title: '', folderType: 'bookmarks-bar', syncing: false, children: [] },
    { id: '4', parentId: '0', title: '', folderType: 'bookmarks-bar', syncing: true, children: [] },
    { id: '2', parentId: '0', title: '', folderType: 'other', children: [] },
    { id: '3', parentId: '0', title: '', folderType: 'mobile', children: [] },
    { id: '5', parentId: '0', title: '', unmodifiable: 'managed', children: [
      { id: '6', parentId: '5', title: '', children: [] },
    ] },
  ] }]);
  const response = await handleRootRequest({ kind: 'known.roots.get', preselectFolderId: '4' });
  if (!response.ok || !('view' in response)) throw new Error('root_view_missing');
  expect(response.view.roots.map(row => row.title)).toEqual([
    'Bookmarks bar (On this device)', 'Bookmarks bar (Browser account)', 'Other bookmarks', 'Mobile bookmarks', 'Folder', 'Folder',
  ]);
  expect(new Set(response.view.roots.map(row => row.ref)).size).toBe(6);
  expect(response.view.roots[1]).toMatchObject({ preselected: true, selected: false });
  expect(response.view.roots.slice(4)).toEqual([expect.objectContaining({ managed: true, selected: false }),
    expect.objectContaining({ managed: true, selected: false })]);
  const second = await loadRootView(scope, '5');
  expect(second.viewId).toBe(response.view.viewId);
  expect(second.roots.every(row => !row.preselected)).toBe(true);
  await expectNoWork();
});

test.each(['valid', 'expired', 'missing', 'storage-error', 'completed'] as const)
('reopened first-run selection uses only a live preview and yields to committed authority: %s', async state => {
  const view = await loadRootView(scope);
  const response = await handleFirstRunRequest({ kind: 'known.firstRun.preview', viewId: view.viewId,
    selectedRefs: [view.roots.find(row => row.title === 'Selected folder')!.ref], excludedRefs: [] });
  if (!response.ok || !('previewId' in response)) throw new Error('preview_missing');
  const preview = (await syncState.getScopePreview(scope, response.previewId))!;
  await storage.set({ [FIRST_RUN_DRAFT]: { deferred: false, selected: [], previewId: state === 'missing' ? 'lost-preview' : preview.previewId } });
  if (state === 'expired') await syncState.putScopePreview(scope, { ...preview, expiresAt: 1 });
  if (state === 'completed') { await seedSelected(); await syncState.setFirstRun(scope, 'completed'); }
  if (state === 'storage-error') {
    const read = storage.get.bind(storage);
    vi.spyOn(storage, 'get').mockImplementation(keys => keys === FIRST_RUN_DRAFT
      ? Promise.reject(new Error('storage unavailable')) : read(keys));
  }
  syncState.close();
  const reopened = await loadRootView(scope);
  const selected = reopened.roots.filter(row => row.selected).map(row => row.title);
  expect(selected).toEqual(state === 'valid' ? ['Selected folder'] : state === 'completed' ? ['Bar']
    : view.roots.filter(row => row.selected).map(row => row.title));
  expect((await syncState.getScopePreview(scope, preview.previewId))?.consumedAt).toBeUndefined();
  expect((await syncState.getScope(scope))?.boundaryVersion).toBe('0');
  await expectNoWork();
});

test.each(['not-completed', 'not-explicit', 'no-permission', 'already-selected', 'no-host', 'managed-host'] as const)
('default folder creation has no native or queue side effects when %s', async guard => {
  if (guard !== 'not-completed') await syncState.setFirstRun(scope, 'completed');
  if (guard === 'no-permission') ports.permission = false;
  if (guard === 'already-selected') await seedSelected();
  if (guard === 'no-host') replaceTree([{ id: '0', title: '', children: [{ id: '3', parentId: '0', title: 'Mobile', folderType: 'mobile', children: [] }] }]);
  if (guard === 'managed-host') replaceTree([{ id: '0', title: '', children: [{ id: '2', parentId: '0', title: 'Managed', unmodifiable: 'managed', children: [] }] }]);
  const before = structuredClone(tree);
  expect(await provisionDefaultSyncRoot(scope, { explicitCreateKnowNFolder: guard !== 'not-explicit' })).toBeUndefined();
  expect(tree).toEqual(before); await expectNoWork();
});

test('a fallback Other root is eligible for an explicit create, but an unknown outcome remains one durable intent', async () => {
  await syncState.setFirstRun(scope, 'completed');
  replaceTree([{ id: '0', title: '', children: [node('2')] }]);
  vi.mocked(chrome.bookmarks.create).mockImplementation(async input => {
    replaceTree([{ id: '0', title: '', children: [{ ...node('2'), children: [
      { id: 'created-unknown', parentId: input.parentId, title: input.title ?? '', children: [] },
    ] }] }]);
    throw new Error('worker_crash');
  });
  await expect(provisionDefaultSyncRoot(scope, { explicitCreateKnowNFolder: true })).rejects.toThrow('worker_crash');
  const created = structuredClone(tree);
  expect(chrome.bookmarks.create).toHaveBeenCalledTimes(1);
  expect(chrome.bookmarks.create).toHaveBeenCalledWith({ parentId: '2', title: 'Know-N' });
  const intents = await syncState.listApplyIntents(scope);
  expect(intents).toHaveLength(1); expect(intents[0]?.apiResultEvidence).toBeUndefined();
  syncState.close();
  expect(await provisionDefaultSyncRoot(scope, { explicitCreateKnowNFolder: true })).toBeUndefined();
  expect(chrome.bookmarks.create).toHaveBeenCalledTimes(1);
  const replayed = (await syncState.listApplyIntents(scope))[0]!;
  expect(replayed.intentId).toBe(intents[0]!.intentId);
  expect(replayed.nativeResult).toBe('result_unknown');
  expect(await syncState.listQueue(scope)).toEqual([]); expect(tree).toEqual(created);
  expect(node('2').children).toEqual([{ id: 'created-unknown', parentId: '2', title: 'Know-N', children: [] }]);
});
