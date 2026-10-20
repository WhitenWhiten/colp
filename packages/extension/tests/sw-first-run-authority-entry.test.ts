import { expect, test } from 'vitest';
import { expectNoWork, node, ports, scope, seedSelected, storage, tree } from './sw-authority-entry-fixture.js';
import { sw, syncState } from '../src/sw/runtime.js';
import { handleFirstRunRequest, handleScopeCommand, resumeRunningBootstrap } from '../src/sw/first-run.js';
import { loadRootView } from '../src/sw/roots.js';
import { KNS09_MUTATION_STORAGE_KEY } from '../src/kns-09-release.js';
import type { FirstRunConfirmRequest, FirstRunPreviewRequest, FirstRunRequest } from '../src/types.js';

async function previewRequest(): Promise<FirstRunPreviewRequest> {
  const view = await loadRootView(scope);
  return { kind: 'known.firstRun.preview', viewId: view.viewId,
    selectedRefs: [view.roots.find(row => row.title === 'Bar')!.ref], excludedRefs: [] };
}
async function preview() {
  const result = await handleFirstRunRequest(await previewRequest());
  if (!result.ok || !('previewId' in result)) throw new Error('preview_missing');
  const confirmation: FirstRunConfirmRequest = { kind: 'known.firstRun.confirm', previewId: result.previewId,
    confirmationId: 'first-run-confirmation', libraryId: scope.collectionId };
  return { result, confirmation };
}

test.each(['permission', 'wrong-view', 'missing-ref', 'too-many-refs', 'foreign-scope-view', 'tree-changed', 'not-connected'] as const)
('first-run preview is read-only and fails closed after %s', async guard => {
  let message = await previewRequest();
  if (guard === 'permission') ports.permission = false;
  if (guard === 'wrong-view') message = { ...message, viewId: 'previous-view' };
  if (guard === 'missing-ref') message = { ...message, selectedRefs: ['unknown-ref'] };
  if (guard === 'too-many-refs') message = { ...message, selectedRefs: Array.from({ length: 129 }, () => message.selectedRefs[0]!) };
  if (guard === 'foreign-scope-view') sw.rootViewTokens = { ...sw.rootViewTokens!, scopeKey: 'another-account' };
  if (guard === 'tree-changed') Object.assign(node('1'), { children: [...node('1').children!, { id: '30', parentId: '1', title: 'Later folder', children: [] }] });
  if (guard === 'not-connected') ports.scopeError = new Error('not_connected');
  expect(await handleFirstRunRequest(message)).toEqual({ ok: false, error: guard === 'permission' ? 'permission_required'
    : guard === 'not-connected' ? 'not_connected' : 'request_invalid' });
  expect((await syncState.getScope(scope))?.selectedRoots).toEqual([]);
  expect((await syncState.getScope(scope))?.firstRun).toBe('none');
  expect(await syncState.listBootstrapRuns(scope)).toEqual([]); await expectNoWork();
});

test('legacy-shaped requests cannot turn an explicitly undefined advanced mode into an ordinary confirm', async () => {
  const message = await previewRequest();
  expect(await handleFirstRunRequest({ ...message, bootstrapMode: undefined })).toEqual({ ok: false, error: 'request_invalid' });
  const { confirmation } = await preview();
  for (const extra of [{ advancedConfirmation: undefined }, { bootstrapMode: undefined }, { bootstrapMode: 'upload' as const }]) {
    expect(await handleFirstRunRequest({ ...confirmation, ...extra })).toEqual({ ok: false, error: 'request_invalid' });
  }
  // The runtime message port is untyped; malformed element types must also fail closed.
  expect(await handleFirstRunRequest({ ...message, selectedRefs: [42] } as unknown as FirstRunRequest))
    .toEqual({ ok: false, error: 'request_invalid' });
  expect(await syncState.listBootstrapRuns(scope)).toEqual([]); await expectNoWork();
});

test.each(['permission', 'paused', 'wrong-library', 'expired', 'tree-changed', 'boundary-changed', 'not-connected'] as const)
('an unadmitted first-run confirmation cannot mutate authority after %s', async guard => {
  let { confirmation } = await preview();
  const before = structuredClone(tree), prior = (await syncState.getScopePreview(scope, confirmation.previewId))!;
  if (guard === 'permission') ports.permission = false;
  if (guard === 'paused') await storage.set({ [KNS09_MUTATION_STORAGE_KEY]: { ui: true, coordinator: false } });
  if (guard === 'wrong-library') confirmation = { ...confirmation, libraryId: 'different-library' };
  if (guard === 'expired') await syncState.putScopePreview(scope, { ...prior, expiresAt: 1 });
  if (guard === 'tree-changed') Object.assign(node('11'), { title: 'Changed after preview' });
  if (guard === 'boundary-changed') await syncState.bumpBoundaryVersion(scope);
  if (guard === 'not-connected') ports.scopeError = new Error('not_connected');
  expect(await handleFirstRunRequest(confirmation)).toMatchObject({ ok: false, error: guard === 'permission' ? 'permission_required'
    : guard === 'paused' ? 'sync_paused' : guard === 'wrong-library' ? 'bootstrap_confirmation_stale'
      : guard === 'not-connected' ? 'not_connected' : 'preview_stale' });
  expect(await syncState.getBoundaryCommand(scope, confirmation.confirmationId)).toBeNull();
  expect((await syncState.getScopePreview(scope, confirmation.previewId))?.consumedAt).toBeUndefined();
  expect(await syncState.listBootstrapRuns(scope)).toEqual([]);
  expect((await syncState.getScope(scope))?.firstRun).toBe('none');
  if (guard !== 'tree-changed') expect(tree).toEqual(before);
  await expectNoWork();
});

test.each(['running', 'completed'] as const)('Later preserves an already %s first run after restart', async firstRun => {
  await syncState.setFirstRun(scope, firstRun); syncState.close();
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.later' })).toEqual({ ok: true,
    phase: firstRun === 'completed' ? 'completed' : 'syncing', firstRun });
  expect((await syncState.getScope(scope))?.firstRun).toBe(firstRun); await expectNoWork();
});

test('Later distinguishes disconnected deferral from an account storage failure', async () => {
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.later' })).toEqual({ ok: true, phase: 'draft', firstRun: 'deferred' });
  expect((await syncState.getScope(scope))?.firstRun).toBe('deferred');
  ports.scopeError = new Error('not_connected');
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.later' })).toEqual({ ok: true, phase: 'draft', firstRun: 'deferred' });
  ports.scopeError = new Error('IndexedDB read failed for private account');
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.later' })).toEqual({ ok: false, error: 'defer_failed' });
  await expectNoWork();
});

test('a recorded start without a run stays confirmed; it never fabricates completion or a command receipt', async () => {
  await syncState.setFirstRun(scope, 'running');
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.status', confirmationId: 'never-admitted' })).toEqual({ ok: true,
    firstRun: 'running', phase: 'confirmed', confirmation: { confirmationId: 'never-admitted', state: 'missing' } });
  expect(await resumeRunningBootstrap(scope)).toBe(false);
  expect(await syncState.getBoundaryCommand(scope, 'never-admitted')).toBeNull(); await expectNoWork();
});

test('a terminal recovery failure remains visible through first-run status and blocks automatic resume', async () => {
  await syncState.setFirstRun(scope, 'running');
  await syncState.transitionEngine(scope, { phase: 'error', updatedAt: Date.now(), recoveryFrozen: true,
    authorityRefreshRequired: false, notBefore: 0, lastError: 'payload_too_large' });
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.status' })).toEqual({ ok: false, error: 'payload_too_large' });
  expect(await resumeRunningBootstrap(scope)).toBe(false);
  await storage.set({ [KNS09_MUTATION_STORAGE_KEY]: { ui: true, coordinator: false } });
  expect(await resumeRunningBootstrap(scope)).toBe(false);
  expect((await syncState.getScope(scope))?.firstRun).toBe('running'); await expectNoWork();
});

test('an actual admitted command survives restart and Later without regaining authority after pause', async () => {
  const { confirmation } = await preview();
  const confirmed = await handleFirstRunRequest(confirmation);
  expect(confirmed).toMatchObject({ ok: true, firstRun: 'running' });
  const command = await syncState.getBoundaryCommand(scope, confirmation.confirmationId);
  expect(command).toMatchObject({ state: 'committed', result: confirmed });
  expect(await syncState.listBootstrapRuns(scope)).toHaveLength(1);
  const queue = await syncState.listQueue(scope), mappings = await syncState.listMappings(scope);
  await storage.set({ [KNS09_MUTATION_STORAGE_KEY]: { ui: false, coordinator: false } });
  ports.permission = false; syncState.close();
  expect(await handleFirstRunRequest(confirmation)).toEqual(confirmed);
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.later' })).toMatchObject({ ok: true, firstRun: 'running' });
  expect(await resumeRunningBootstrap(scope)).toBe(false);
  expect(await syncState.getBoundaryCommand(scope, confirmation.confirmationId)).toEqual(command);
  expect(await syncState.listMappings(scope)).toEqual(mappings);
  expect(await syncState.listQueue(scope)).toEqual(queue);
  for (const name of ['create', 'update', 'move', 'remove', 'removeTree'] as const) expect(chrome.bookmarks[name]).not.toHaveBeenCalled();
});

test('ordinary bootstrap resume cannot execute or replace an admitted advanced plan after restart', async () => {
  const advanced = await handleFirstRunRequest({ ...await previewRequest(), bootstrapMode: 'upload' });
  if (!advanced.ok || !('previewId' in advanced) || !advanced.advanced) throw new Error('advanced_preview_missing');
  const confirmation = { kind: 'known.firstRun.confirm' as const, previewId: advanced.previewId,
    confirmationId: 'advanced-owned-resume', libraryId: scope.collectionId, bootstrapMode: 'upload' as const,
    advancedConfirmation: advanced.advanced };
  expect(await handleFirstRunRequest(confirmation)).toMatchObject({ ok: true, firstRun: 'running' });
  const plans = await syncState.listAdvancedPlans(scope), runs = await syncState.listBootstrapRuns(scope);
  expect(plans).toHaveLength(1); expect(runs).toHaveLength(1);
  syncState.close(); expect(await resumeRunningBootstrap(scope)).toBe(false);
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.status', confirmationId: confirmation.confirmationId }))
    .toMatchObject({ ok: true, firstRun: 'running', confirmation: { state: 'committed' } });
  expect(await syncState.listAdvancedPlans(scope)).toEqual(plans); expect(await syncState.listBootstrapRuns(scope)).toEqual(runs);
  expect((await syncState.getScope(scope))?.selectedRoots).toEqual([]); await expectNoWork();
});

test('scope detach persists the exact mount and rejoin cannot bypass missing bookmark permission', async () => {
  await seedSelected(); const before = await syncState.listMappings(scope);
  expect(await handleScopeCommand({ kind: 'known.scope.detach', mountId: 'mount-bar' })).toEqual({ ok: true, phase: 'draft', firstRun: 'none' });
  expect((await syncState.getMountBinding(scope, 'mount-bar'))?.status).toBe('detached');
  ports.permission = false;
  expect(await handleScopeCommand({ kind: 'known.scope.rejoin', mountId: 'mount-bar' })).toEqual({ ok: false, error: 'permission_required' });
  syncState.close(); expect((await syncState.getMountBinding(scope, 'mount-bar'))?.status).toBe('detached');
  expect(await syncState.listMappings(scope)).toEqual(before); await expectNoWork();
});

test('scope commands honor pause, missing mounts and sanitized account failures without touching Chrome', async () => {
  await seedSelected();
  await storage.set({ [KNS09_MUTATION_STORAGE_KEY]: { ui: false, coordinator: true } });
  expect(await handleScopeCommand({ kind: 'known.scope.detach', mountId: 'mount-bar' })).toEqual({ ok: false, error: 'sync_paused' });
  expect((await syncState.getMountBinding(scope, 'mount-bar'))?.status).toBe('active');
  await storage.set({ [KNS09_MUTATION_STORAGE_KEY]: { ui: true, coordinator: true } });
  expect(await handleScopeCommand({ kind: 'known.scope.rejoin', mountId: 'missing-mount' })).toEqual({ ok: false, error: 'mount_not_found' });
  expect(await handleScopeCommand({ kind: 'known.scope.remoteDelete', mountId: 'mount-bar', confirmationToken: 'old-proof', affectedCount: 2 }))
    .toEqual({ ok: false, error: 'confirmation_mismatch' });
  ports.scopeError = new Error('account_switch');
  expect(await handleScopeCommand({ kind: 'known.scope.detach', mountId: 'mount-bar' })).toEqual({ ok: false, error: 'account_switch' });
  ports.scopeError = new Error('private-account: unauthorized token=secret');
  expect(await handleScopeCommand({ kind: 'known.scope.detach', mountId: 'mount-bar' })).toEqual({ ok: false, error: 'request_invalid' });
  await expectNoWork();
});

test('attention routing cannot close or resolve a report belonging to another page or account', async () => {
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.attention.get', reportId: 'absent' })).toEqual({ ok: false, error: 'request_invalid' });
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.attention.decide', reportId: 'absent', itemId: 'item', decision: 'keep_both' }))
    .toEqual({ ok: false, error: 'request_invalid' });
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.attention.decide', reportId: 'absent', itemId: 'item', decision: 'keep_local', evidenceDigest: 'sha256:old' }))
    .toEqual({ ok: false, error: 'bootstrap_confirmation_stale' });
  ports.scopeError = new Error('not_connected');
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.attention.get', reportId: 'absent' })).toEqual({ ok: false, error: 'not_connected' });
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.status' })).toEqual({ ok: false, error: 'not_connected' });
  await expectNoWork();
});
