import { IDBObjectStore } from 'fake-indexeddb';
import { expect, test, vi } from 'vitest';
import { node, ports, scope, seedSelected, storage, tree } from './sw-authority-entry-fixture.js';
import { sw, syncState } from '../src/sw/runtime.js';
import { handleRootRequest, loadRootView } from '../src/sw/roots.js';
import { KNS09_MUTATION_STORAGE_KEY } from '../src/kns-09-release.js';
import { STORES } from '../src/sync-state/schema.js';
import type { BoundaryCommandRecord } from '../src/sync-state-store.js';
import type { RootRequest } from '../src/types.js';
import { installRejoinHttp } from './rejoin-http-fixture.js';
import type { RemoteNodeFact } from '../src/bootstrap/matcher.js';

async function reviewRequest() {
  const view = await loadRootView(scope);
  return { kind: 'known.roots.preview' as const, viewId: view.viewId, selectedRefs: [] as string[], privateRefs: [] as string[] };
}
async function review() {
  const response = await handleRootRequest(await reviewRequest());
  if (!response.ok || !('preview' in response)) throw new Error(`preview_missing:${JSON.stringify(response)}`);
  return { kind: 'known.roots.confirm' as const, previewId: response.preview.previewId,
    treeDigest: response.preview.treeDigest, confirmationId: crypto.randomUUID() };
}
async function selectTitles(titles: string[]) {
  const view = await loadRootView(scope);
  const response = await handleRootRequest({ kind: 'known.roots.preview', viewId: view.viewId,
    selectedRefs: titles.map(title => view.roots.find(row => row.title === title)!.ref), privateRefs: [] });
  if (!response.ok || !('preview' in response)) throw new Error(`preview_missing:${JSON.stringify(response)}`);
  return { kind: 'known.roots.confirm' as const, previewId: response.preview.previewId,
    treeDigest: response.preview.treeDigest, confirmationId: crypto.randomUUID() };
}
async function configured() { await seedSelected(); await syncState.setFirstRun(scope, 'completed'); }
const mutationNames = ['create', 'update', 'move', 'remove', 'removeTree'] as const;
async function unchanged(before: Awaited<ReturnType<typeof syncState.exportScope>>) {
  const after = await syncState.exportScope(scope);
  expect(after.queue).toEqual(before.queue); expect(after.receipts).toEqual(before.receipts);
  expect(after.mappings).toEqual(before.mappings); expect(after.mountBindings).toEqual(before.mountBindings);
  expect(after.scope).toMatchObject({ selectedRoots: before.scope!.selectedRoots, privateRoots: before.scope!.privateRoots,
    boundaryVersion: before.scope!.boundaryVersion, firstRun: before.scope!.firstRun });
  for (const name of mutationNames) expect(chrome.bookmarks[name]).not.toHaveBeenCalled();
}
function interruptCheckpoint(step: string) {
  const put = IDBObjectStore.prototype.put; let failed = false;
  const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const row = value as BoundaryCommandRecord;
    if (!failed && this.name === STORES.boundaryCommands && row.completedSteps?.includes(step)) {
      failed = true; throw new Error('checkpoint_write_failed');
    }
    return key === undefined ? put.call(this, value) : put.call(this, value, key);
  });
  return { restore: () => { expect(failed).toBe(true); fault.mockRestore(); } };
}

test.each(['paused', 'wrong-view', 'missing-ref', 'too-many-refs', 'foreign-view', 'tree-changed'] as const)
('range preview rejects %s without changing the existing native or durable selection', async guard => {
  await configured(); let request = await reviewRequest();
  if (guard === 'paused') await storage.set({ [KNS09_MUTATION_STORAGE_KEY]: { ui: false, coordinator: true } });
  if (guard === 'wrong-view') request = { ...request, viewId: 'another-options-view' };
  if (guard === 'missing-ref') request.selectedRefs = ['not-a-current-ref'];
  if (guard === 'too-many-refs') request.privateRefs = Array.from({ length: 129 }, () => 'not-a-current-ref');
  if (guard === 'foreign-view') sw.rootViewTokens = { ...sw.rootViewTokens!, scopeKey: 'another-account' };
  if (guard === 'tree-changed') Object.assign(node('1'), { children: [...node('1').children!, { id: '30', parentId: '1', title: 'New folder', children: [] }] });
  const before = await syncState.exportScope(scope), nativeBefore = structuredClone(tree);
  expect(await handleRootRequest(request)).toEqual({ ok: false, error: guard === 'paused' ? 'sync_paused' : 'request_invalid' });
  await unchanged(before); expect(tree).toEqual(nativeBefore); expect(await syncState.listPendingBoundaryCommands(scope)).toEqual([]);
});

test.each(['permission', 'disconnected'] as const)('range preview rechecks %s after the outer runtime route', async guard => {
  await configured(); const request = await reviewRequest(), before = await syncState.exportScope(scope);
  let read = 0;
  Object.defineProperty(ports, 'permission', { configurable: true, get() {
    read++;
    if (guard === 'disconnected') ports.scopeError = new Error('not_connected');
    return read === 1;
  } });
  try {
    expect(await handleRootRequest(request)).toEqual({ ok: false, error: guard === 'permission' ? 'permission_required' : 'not_connected' });
    await unchanged(before);
  } finally { Object.defineProperty(ports, 'permission', { configurable: true, writable: true, value: true }); }
});

test.each(['permission', 'paused', 'not-completed', 'missing-preview', 'expired', 'wrong-digest', 'unknown-trash', 'unknown-shift'] as const)
('unadmitted range confirmation fails closed after %s', async guard => {
  await configured(); let request: Extract<RootRequest, { kind: 'known.roots.confirm' }> = await review();
  if (guard === 'permission') ports.permission = false;
  if (guard === 'paused') await storage.set({ [KNS09_MUTATION_STORAGE_KEY]: { ui: true, coordinator: false } });
  if (guard === 'not-completed') {
    // A restored earlier scope must not use a later page's confirmation.
    const prior = (await syncState.getScope(scope))!;
    const db = await syncState.open(), tx = db.transaction(STORES.scopes, 'readwrite');
    tx.objectStore(STORES.scopes).put({ ...prior, firstRun: 'none' });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
  }
  if (guard === 'missing-preview') request = { ...request, previewId: 'missing-preview' };
  if (guard === 'expired') await syncState.putScopePreview(scope, { ...(await syncState.getScopePreview(scope, request.previewId))!, expiresAt: 1 });
  if (guard === 'wrong-digest') request = { ...request, treeDigest: 'sha256:another-tree' };
  if (guard === 'unknown-trash') request = { ...request, remoteDeleteRefs: ['not-a-reviewed-removal'] };
  if (guard === 'unknown-shift') request = { ...request, shiftActions: [{ ref: 'not-a-reviewed-shift', action: 'keep' }] };
  const before = await syncState.exportScope(scope), nativeBefore = structuredClone(tree);
  const expected = guard === 'permission' ? 'permission_required' : guard === 'paused' ? 'sync_paused'
    : guard === 'expired' || guard === 'wrong-digest' ? 'preview_stale' : 'request_invalid';
  expect(await handleRootRequest(request)).toEqual({ ok: false, error: expected });
  await unchanged(before); expect(tree).toEqual(nativeBefore);
  expect(await syncState.getBoundaryCommand(scope, request.confirmationId)).toBeNull();
});

test.each(['permission', 'paused'] as const)('a durable interrupted range cannot advance under %s but resumes the exact command after restoration', async guard => {
  await configured(); const request = await review(), nativeBefore = structuredClone(tree);
  const interruption = interruptCheckpoint('mounts');
  expect(await handleRootRequest(request)).toMatchObject({ ok: false, error: 'confirmation_pending' });
  interruption.restore(); syncState.close();
  const before = await syncState.exportScope(scope), command = await syncState.getBoundaryCommand(scope, request.confirmationId);
  if (guard === 'permission') ports.permission = false;
  else await storage.set({ [KNS09_MUTATION_STORAGE_KEY]: { ui: true, coordinator: false } });
  expect(await handleRootRequest(request)).toEqual({ ok: false, error: 'confirmation_pending', confirmation: {
    confirmationId: request.confirmationId, state: 'failed', error: guard === 'permission' ? 'permission_required' : 'sync_paused' } });
  await unchanged(before); expect(await syncState.getBoundaryCommand(scope, request.confirmationId)).toEqual(command);
  ports.permission = true; await storage.set({ [KNS09_MUTATION_STORAGE_KEY]: { ui: true, coordinator: true } });
  expect(await handleRootRequest(request)).toMatchObject({ ok: true, confirmation: { state: 'committed' } });
  expect((await syncState.getScope(scope))?.selectedRoots).toEqual([]);
  expect((await syncState.getMountBinding(scope, 'mount-bar'))?.status).toBe('detached');
  expect(await syncState.listQueue(scope)).toEqual([]); expect((await syncState.exportScope(scope)).receipts).toEqual([]);
  expect(tree).toEqual(nativeBefore);
});

test('a database failure during admission rolls back preview consumption and permits the same reviewed confirmation to retry', async () => {
  await configured(); const request = await review(), before = await syncState.exportScope(scope);
  const nativeBefore = structuredClone(tree), add = IDBObjectStore.prototype.add;
  let failed = false;
  const fault = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    if (this.name === STORES.boundaryCommands && !failed) {
      failed = true; throw new DOMException('The storage device could not write the command.', 'UnknownError');
    }
    return key === undefined ? add.call(this, value) : add.call(this, value, key);
  });
  try { expect(await handleRootRequest(request)).toEqual({ ok: false, error: 'root_update_failed' }); }
  finally { fault.mockRestore(); }
  expect(failed).toBe(true); syncState.close();
  expect(await syncState.getBoundaryCommand(scope, request.confirmationId)).toBeNull();
  expect(await syncState.getScopePreview(scope, request.previewId)).not.toHaveProperty('consumedBy');
  await unchanged(before); expect(tree).toEqual(nativeBefore);
  expect(await handleRootRequest(request)).toMatchObject({ ok: true, confirmation: { state: 'committed' } });
  expect((await syncState.getMountBinding(scope, 'mount-bar'))?.status).toBe('detached');
  expect((await syncState.getScope(scope))?.selectedRoots).toEqual([]);
  expect(await syncState.listQueue(scope)).toEqual([]); expect(tree).toEqual(nativeBefore);
});

test('one admitted range blocks a second page preview and confirmation until its exact journal resumes', async () => {
  await configured(); const first = await review(), second = await review();
  const request = await reviewRequest(), interruption = interruptCheckpoint('mounts');
  expect(await handleRootRequest(first)).toMatchObject({ ok: false, error: 'confirmation_pending' });
  interruption.restore(); const before = await syncState.exportScope(scope);
  expect(await handleRootRequest(request)).toEqual({ ok: false, error: 'sync_busy' });
  expect(await handleRootRequest(second)).toEqual({ ok: false, error: 'sync_busy' });
  expect(await syncState.getBoundaryCommand(scope, second.confirmationId)).toBeNull(); await unchanged(before);
  syncState.close(); expect(await handleRootRequest(first)).toMatchObject({ ok: true, confirmation: { state: 'committed' } });
  const completed = await syncState.exportScope(scope);
  expect(await handleRootRequest({ ...first, confirmationId: 'another-command' })).toEqual({ ok: false, error: 'duplicate_confirm' });
  expect(await handleRootRequest({ ...first, treeDigest: 'sha256:changed-request' })).toEqual({ ok: false, error: 'confirmation_conflict' });
  await unchanged(completed);
});

test('a reopened options page exposes its exact unfinished range while paused and resumes it after restoration', async () => {
  await configured(); const request = await review(), nativeBefore = structuredClone(tree);
  const interruption = interruptCheckpoint('mounts');
  expect(await handleRootRequest(request)).toMatchObject({ ok: false, error: 'confirmation_pending' });
  interruption.restore();
  await storage.set({ [KNS09_MUTATION_STORAGE_KEY]: { ui: true, coordinator: false } });
  syncState.close(); const before = await syncState.exportScope(scope);
  const reopened = await handleRootRequest({ kind: 'known.roots.get' });
  expect(reopened).toMatchObject({ ok: true, confirmation: { confirmationId: request.confirmationId,
    state: 'failed', error: 'checkpoint_write_failed' }, resume: { libraryId: scope.collectionId,
    request, preview: { previewId: request.previewId, treeDigest: request.treeDigest } } });
  await unchanged(before); expect(tree).toEqual(nativeBefore);
  await storage.set({ [KNS09_MUTATION_STORAGE_KEY]: { ui: true, coordinator: true } });
  syncState.close(); const restored = await handleRootRequest({ kind: 'known.roots.get' });
  expect(restored).toMatchObject({ ok: true }); expect(restored).not.toHaveProperty('confirmation');
  expect(await syncState.getBoundaryCommand(scope, request.confirmationId)).toMatchObject({ state: 'committed' });
  expect((await syncState.getScope(scope))?.selectedRoots).toEqual([]);
  expect((await syncState.getMountBinding(scope, 'mount-bar'))?.status).toBe('detached');
  expect(await syncState.listQueue(scope)).toEqual([]); expect(tree).toEqual(nativeBefore);
});

async function rejoinReview(changedCloud = false) {
  await configured();
  const remote: RemoteNodeFact[] = (await syncState.listMappings(scope)).map(row => ({ nodeId: row.colpId,
    parentId: row.parentColpId ?? 'library-root', kind: row.nodeKind === 'bookmark' ? 'bookmark' : 'folder',
    title: String(row.projection.content?.title ?? ''), revision: row.projection.revision,
    ...(row.nodeKind === 'bookmark' ? { url: String(row.projection.content?.url) }
      : { childrenRevision: row.projection.childrenRevision ?? `children-${row.colpId}` }),
    ...(row.rootRole ? { folderRole: row.rootRole } : {}) }));
  installRejoinHttp(() => scope, () => remote);
  expect(await handleRootRequest(await review())).toMatchObject({ ok: true });
  expect((await syncState.getMountBinding(scope, 'mount-bar'))?.status).toBe('detached');
  if (changedCloud) Object.assign(remote.find(row => row.nodeId === 'remote-11')!, {
    title: 'Changed in the cloud while detached', revision: 'changed-remote-11' });
  return selectTitles(['Bar']);
}

test('a lost rejoin checkpoint resumes an already active exact mount without repeating native work', async () => {
  const request = await rejoinReview(), nativeBefore = structuredClone(tree), interruption = interruptCheckpoint('rejoin:1');
  expect(await handleRootRequest(request)).toMatchObject({ ok: false, error: 'confirmation_pending' });
  interruption.restore();
  expect((await syncState.getMountBinding(scope, 'mount-bar'))?.status).toBe('active');
  expect((await syncState.getScope(scope))?.selectedRoots).toEqual([]);
  const mappings = await syncState.listMappings(scope), queue = await syncState.listQueue(scope);
  syncState.close(); expect(await handleRootRequest(request)).toMatchObject({ ok: true, confirmation: { state: 'committed' } });
  expect((await syncState.getScope(scope))?.selectedRoots).toEqual(['remote-1']);
  expect(await syncState.listMappings(scope)).toEqual(mappings); expect(await syncState.listQueue(scope)).toEqual(queue);
  expect((await syncState.exportScope(scope)).receipts).toEqual([]); expect(tree).toEqual(nativeBefore);
  for (const name of mutationNames) expect(chrome.bookmarks[name]).not.toHaveBeenCalled();
});

test('a local deletion against a changed cloud copy stays pending instead of claiming the admitted rejoin was saved', async () => {
  const request = await rejoinReview(true), interruption = interruptCheckpoint('mounts');
  expect(await handleRootRequest(request)).toMatchObject({ ok: false, error: 'confirmation_pending' });
  interruption.restore(); Object.assign(node('10'), { children: [] });
  const nativeBefore = structuredClone(tree); syncState.close();
  expect(await handleRootRequest(request)).toMatchObject({ ok: false, error: 'confirmation_pending',
    confirmation: { state: 'failed', error: 'rejoin_pending' } });
  expect((await syncState.getBoundaryCommand(scope, request.confirmationId))?.state).toBe('failed');
  expect((await syncState.getScope(scope))?.selectedRoots).toEqual([]);
  expect((await syncState.getMountBinding(scope, 'mount-bar'))?.status).toBe('detached');
  const plans = await syncState.listScopeCommandPlans(scope);
  expect(plans.some(plan => plan.commandId.startsWith('rejoin-delete:') && plan.phase === 'pending'), JSON.stringify(plans)).toBe(true);
  expect(await syncState.listQueue(scope)).toEqual([]); expect((await syncState.exportScope(scope)).receipts).toEqual([]);
  expect(tree).toEqual(nativeBefore); for (const name of mutationNames) expect(chrome.bookmarks[name]).not.toHaveBeenCalled();
});

test('a coordinator pause arriving after admission blocks the bootstrap step and exact replay finishes after resume', async () => {
  await configured(); const request = await selectTitles(['Bar', 'Other']), nativeBefore = structuredClone(tree);
  const getTree = vi.mocked(chrome.bookmarks.getTree), original = getTree.getMockImplementation()!;
  let reads = 0;
  getTree.mockImplementation(async () => {
    if (++reads === 2) await storage.set({ [KNS09_MUTATION_STORAGE_KEY]: { ui: true, coordinator: false } });
    return original();
  });
  expect(await handleRootRequest(request)).toMatchObject({ ok: false, error: 'confirmation_pending',
    confirmation: { state: 'failed', error: 'sync_paused' } });
  getTree.mockImplementation(original);
  const pending = (await syncState.getBoundaryCommand(scope, request.confirmationId))!;
  expect(pending.completedSteps).toContain('mounts'); expect(pending.completedSteps).not.toContain('bootstrap');
  expect(await syncState.listQueue(scope)).toEqual([]); expect(await syncState.listBootstrapRuns(scope)).toEqual([]);
  await storage.set({ [KNS09_MUTATION_STORAGE_KEY]: { ui: true, coordinator: true } }); syncState.close();
  expect(await handleRootRequest(request)).toMatchObject({ ok: true, confirmation: { state: 'committed' } });
  const selected = (await syncState.getScope(scope))!.selectedRoots;
  expect(await Promise.all(selected.map(async id => (await syncState.getMappingByColpId(scope, id))?.nativeId))).toEqual(['1', '2']);
  expect(await syncState.listBootstrapRuns(scope)).toHaveLength(1); expect(tree).toEqual(nativeBefore);
  expect((await syncState.exportScope(scope)).receipts).toEqual([]);
  for (const name of mutationNames) expect(chrome.bookmarks[name]).not.toHaveBeenCalled();
});
