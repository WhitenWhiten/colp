import { beforeEach, expect, test, vi } from 'vitest';
import { expectNoWork, httpRequests, node, ports, scope, storage, tree } from './sw-authority-entry-fixture.js';
import { store, sw, syncState } from '../src/sw/runtime.js';
import { loadRootView } from '../src/sw/roots.js';
import { handleFirstRunRequest } from '../src/sw/first-run.js';
import { advancedPreviewCacheSize, clearAdvancedPreviewCache, handleAdvancedFirstRunConfirm } from '../src/sw/advanced-first-run.js';
import { KNS09_MUTATION_STORAGE_KEY } from '../src/kns-09-release.js';
import type { FirstRunConfirmRequest, FirstRunPreviewRequest } from '../src/types.js';

beforeEach(clearAdvancedPreviewCache);
async function request(mode: FirstRunPreviewRequest['bootstrapMode'] = 'upload') {
  const view = await loadRootView(scope);
  return { kind: 'known.firstRun.preview' as const, viewId: view.viewId,
    selectedRefs: [view.roots.find(row => row.title === 'Bar')!.ref], excludedRefs: [], bootstrapMode: mode };
}
async function preview() {
  const result = await handleFirstRunRequest(await request());
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, advanced: { mode: 'upload' } });
  if (!result.ok || !('previewId' in result) || !result.advanced) throw new Error('advanced_preview_missing');
  const confirmation: FirstRunConfirmRequest = { kind: 'known.firstRun.confirm', previewId: result.previewId,
    confirmationId: 'advanced-confirmation', libraryId: scope.collectionId, bootstrapMode: 'upload', advancedConfirmation: result.advanced };
  return { result, confirmation };
}

test.each(['permission', 'paused', 'missing-ref', 'too-many-refs', 'wrong-view', 'tree-changed', 'account-changed'] as const)
('advanced review cannot create authority after %s', async guard => {
  const message = await request();
  if (guard === 'permission') ports.permission = false;
  if (guard === 'paused') await storage.set({ [KNS09_MUTATION_STORAGE_KEY]: { ui: false, coordinator: true } });
  if (guard === 'missing-ref') message.selectedRefs = ['not-in-this-view'];
  if (guard === 'too-many-refs') message.selectedRefs = Array.from({ length: 129 }, () => message.selectedRefs[0]!);
  if (guard === 'wrong-view') message.viewId = 'older-view';
  if (guard === 'tree-changed') Object.assign(node('1'), { children: [...node('1').children!, { id: '30', parentId: '1', title: 'New folder', children: [] }] });
  if (guard === 'account-changed') await store.saveCredential({ ...(await store.loadCredential())!, subject: 'someone-else' });
  const expected = guard === 'permission' ? 'permission_required' : guard === 'paused' ? 'sync_paused'
    : guard === 'account-changed' ? 'not_connected' : 'request_invalid';
  expect(await handleFirstRunRequest(message)).toEqual({ ok: false, error: expected });
  expect(await syncState.listAdvancedPlans(scope)).toEqual([]);
  expect((await syncState.getScope(scope))?.selectedRoots).toEqual([]);
  expect(advancedPreviewCacheSize()).toBe(0); await expectNoWork();
});

test('a merge advanced review reads actual Snapshot authority without admitting work', async () => {
  const before = structuredClone(tree);
  const result = await handleFirstRunRequest(await request('merge'));
  expect(result).toMatchObject({ ok: true, report: expect.any(Object) });
  expect(result).not.toHaveProperty('advanced');
  expect(httpRequests.filter(row => row.url.pathname === '/v1/snapshot')).toHaveLength(1);
  expect(await syncState.listAdvancedPlans(scope)).toEqual([]);
  expect((await syncState.getScope(scope))?.firstRun).toBe('none');
  expect(tree).toEqual(before); await expectNoWork();
  const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 31 * 60_000);
  expect(advancedPreviewCacheSize()).toBe(0);
});

test.each(['permission', 'paused', 'wrong-library', 'missing-library', 'mode-mismatch', 'view-lost', 'tree-changed', 'mapping-changed', 'mount-changed', 'expired'] as const)
('an advanced confirmation preserves the reviewed boundary when %s', async guard => {
  let { confirmation } = await preview(); const before = structuredClone(tree);
  if (guard === 'permission') ports.permission = false;
  if (guard === 'paused') await storage.set({ [KNS09_MUTATION_STORAGE_KEY]: { ui: true, coordinator: false } });
  if (guard === 'wrong-library') confirmation = { ...confirmation, libraryId: 'another-library' };
  if (guard === 'missing-library') confirmation = { ...confirmation, libraryId: '' };
  if (guard === 'mode-mismatch') confirmation = { ...confirmation, bootstrapMode: 'download' };
  if (guard === 'view-lost') sw.rootViewTokens = undefined;
  if (guard === 'tree-changed') Object.assign(node('1'), { children: [...node('1').children!, { id: '30', parentId: '1', title: 'New folder', children: [] }] });
  if (guard === 'mapping-changed') await syncState.putMapping(scope, { nativeId: '11', colpId: 'new-remote', rootNativeId: '1', nodeKind: 'bookmark',
    projection: { revision: 'r1', digest: 'sha256:new' } });
  if (guard === 'mount-changed') await syncState.putMountBinding(scope, { mountId: 'old-mount', nativeRootId: '1',
    remoteMountNodeId: 'different-remote', rootRole: 'bookmarks-bar', boundaryVersion: '0', status: 'active', materialized: false });
  if (guard === 'expired') { const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 31 * 60_000); }
  const beforeMappings = await syncState.listMappings(scope), beforeMounts = await syncState.listMountBindings(scope);
  const response = await handleFirstRunRequest(confirmation);
  expect(response).toMatchObject({ ok: false, error: guard === 'permission' ? 'permission_required'
    : guard === 'paused' ? 'sync_paused' : guard === 'wrong-library' ? 'scope_mismatch'
      : guard === 'missing-library' ? 'library_required' : guard === 'mode-mismatch' ? 'request_invalid' : 'preview_stale' });
  expect(await syncState.listAdvancedPlans(scope)).toEqual([]);
  expect(await syncState.listMappings(scope)).toEqual(beforeMappings);
  expect(await syncState.listMountBindings(scope)).toEqual(beforeMounts);
  if (guard !== 'tree-changed') expect(tree).toEqual(before);
  expect((await syncState.getScope(scope))?.boundaryVersion).toBe('0');
  await expectNoWork();
});

test('two pages admit one advanced plan and restart preserves its exact confirmation identity', async () => {
  const { confirmation } = await preview();
  const result = await Promise.all([handleFirstRunRequest(confirmation), handleFirstRunRequest(confirmation)]);
  expect(result).toEqual([{ ok: true, phase: 'syncing', firstRun: 'running' }, { ok: true, phase: 'syncing', firstRun: 'running' }]);
  const plans = await syncState.listAdvancedPlans(scope), runs = await syncState.listBootstrapRuns(scope);
  expect(plans).toHaveLength(1); expect(runs).toHaveLength(1);
  expect(plans[0]?.metadata).toMatchObject({ confirmationId: confirmation.confirmationId, mode: 'upload' });
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.status', confirmationId: confirmation.confirmationId }))
    .toMatchObject({ ok: true, firstRun: 'running', confirmation: { state: 'committed' } });
  expect(await handleFirstRunRequest(await request())).toEqual({ ok: false, error: 'sync_busy' });
  syncState.close(); clearAdvancedPreviewCache();
  expect(await handleFirstRunRequest(confirmation)).toEqual(result[0]);
  expect(await handleFirstRunRequest({ ...confirmation, confirmationId: 'different-user-confirmation' }))
    .toEqual({ ok: false, error: 'bootstrap_confirmation_stale' });
  expect(await syncState.listAdvancedPlans(scope)).toEqual(plans);
  expect(await syncState.listBootstrapRuns(scope)).toEqual(runs);
  expect(await syncState.listQueue(scope)).toEqual([]);
  await expectNoWork();
});

test('direct legacy advanced requests without a matching mode fail closed before preview lookup', async () => {
  const { confirmation } = await preview();
  expect(await handleAdvancedFirstRunConfirm({ ...confirmation, bootstrapMode: 'merge' })).toEqual({ ok: false, error: 'request_invalid' });
  expect(await handleAdvancedFirstRunConfirm({ ...confirmation, bootstrapMode: undefined })).toEqual({ ok: false, error: 'request_invalid' });
  expect(await syncState.listAdvancedPlans(scope)).toEqual([]); await expectNoWork();
});
