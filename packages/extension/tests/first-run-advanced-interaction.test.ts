// @vitest-environment happy-dom
// Exercise the real options controller through DOM events. Only browser message
// delivery/storage are ports here; durable admission is covered by the runtime suites.
import { readFile } from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { bindFirstRunOnboarding } from '../src/first-run-ui.js';
import { bindFolders } from '../src/sync-folders.js';
import { FIRST_RUN_DRAFT } from '../src/first-run-draft.js';
import type { FirstRunOrScopeResponse, FirstRunPreviewOk, FirstRunRequest, PublicRootView } from '../src/types.js';

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const view: PublicRootView = { viewId: 'view', status: 'ready', roots: [
  { ref: 'bar', kind: 'bookmarks_bar', title: 'Bookmarks bar', depth: 0, selected: true,
    privateLocal: false, managed: false, bookmarkCount: 2, folderCount: 1 },
  { ref: 'other', kind: 'other', title: 'Other bookmarks', depth: 0, selected: false,
    privateLocal: false, managed: false, bookmarkCount: 0, folderCount: 0 },
] };
const preview = (id: string): FirstRunPreviewOk => ({ ok: true, previewId: id, treeDigest: `tree-${id}`,
  boundaryVersion: '1', bookmarkCount: 2, folderCount: 1, skippedCount: 0, warnings: [] });
const report = { matched: 1, localOnly: 2, remoteOnly: 3, candidates: 4, conflicts: 5 };
const advanced = (id: string, mode: 'upload' | 'download', empty = false): FirstRunPreviewOk => ({ ...preview(id), report,
  advanced: { mode, treeDigest: `tree-${id}`, scopeFingerprint: `scope-${id}`, remoteSnapshotId: `snapshot-${id}`,
    remoteRevision: `revision-${id}`, remoteCursor: `cursor-${id}`, destructivePlanDigest: `plan-${id}`,
    confirmationProof: `proof-${id}`, deletes: empty ? [] : [
      { targetId: 'remote', side: 'remote', kind: 'bookmark', title: '<img src=x onerror=alert(1)>' },
      { targetId: 'local', side: 'local', kind: 'folder', title: 'Local folder' },
      { targetId: 'untitled', side: 'local', title: '   ' },
    ] } });

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren();
  for (const key of Object.keys(document.body.dataset)) delete document.body.dataset[key];
});

async function mount(handle?: (request: FirstRunRequest) => Promise<FirstRunOrScopeResponse | undefined>) {
  const html = await readFile('options.html', 'utf8');
  document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*)<\/body>/u)![1]!.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, '');
  document.body.dataset.library = 'ready';
  const values: Record<string, unknown> = { 'known.sync.collection.v1': 'library' };
  const storage = { get: vi.fn(async (key: string) => ({ [key]: values[key] })),
    set: vi.fn(async (patch: Record<string, unknown>) => { Object.assign(values, structuredClone(patch)); }) };
  const send = vi.fn(async (request: FirstRunRequest): Promise<FirstRunOrScopeResponse> => {
    const result = await handle?.(request); if (result) return result;
    if (request.kind === 'known.firstRun.status') return { ok: true, firstRun: 'none', phase: 'draft' };
    if (request.kind === 'known.firstRun.preview') return preview('merge-review');
    throw new Error(`Undeclared first-run message ${request.kind}`);
  });
  vi.stubGlobal('chrome', { runtime: { sendMessage: send }, storage: { local: storage } });
  const showPane = vi.fn(), statusChanged = vi.fn();
  const folders = bindFolders({ isConnected: () => true, firstRun: () => ui });
  const ui = bindFirstRunOnboarding({ rootTree: el('root-tree'), saveRoots: el('save-roots'),
    requestPermission: el('request-bookmark-permission'), folderHeading: el('folder-heading'),
    folderIntro: el('folder-intro'), serverLabel: () => 'Private library', showPane, onSyncStatusChanged: statusChanged });
  await vi.waitFor(() => expect(ui.isRangeActive()).toBe(true));
  folders.render(view);
  await vi.waitFor(() => expect(el<HTMLButtonElement>('first-run-start').disabled).toBe(false));
  return { ui, folders, send, values, storage, showPane, statusChanged };
}
function choose(mode: string) {
  const select = el<HTMLSelectElement>('first-run-advanced-mode');
  select.value = mode; select.dispatchEvent(new Event('change'));
}

test.each(['upload', 'download'] as const)('%s reviews escaped deletions and requires a new explicit confirmation after stale evidence', async mode => {
  let advancedReads = 0, confirms = 0;
  const f = await mount(async request => {
    if (request.kind === 'known.firstRun.preview' && request.bootstrapMode) return advanced(`review-${++advancedReads}`, mode);
    if (request.kind === 'known.firstRun.confirm') return ++confirms === 1
      ? { ok: false, error: 'preview_stale', bookmarkCount: 2, folderCount: 1, skippedCount: 0 }
      : { ok: true, firstRun: 'running', phase: 'syncing' };
    return undefined;
  });
  expect(el('folder-heading').textContent).toContain('Private library');
  choose(mode);
  expect(el<HTMLButtonElement>('first-run-start').disabled).toBe(true);
  expect(el('first-run-advanced-confirm').hidden).toBe(true);
  el('first-run-advanced-preview').click();
  await vi.waitFor(() => expect(el('first-run-advanced-confirm').hidden).toBe(false));
  expect(el('first-run-delete-list').textContent).toContain('Know-N · bookmark · <img src=x onerror=alert(1)>');
  expect(el('first-run-delete-list').textContent).toContain('Browser · folder · Local folder');
  expect(el('first-run-delete-list').textContent).toContain('Browser · item · Untitled item');
  expect(el('first-run-delete-list').querySelector('img')).toBeNull();
  expect(el('first-run-advanced-confirm').textContent).toBe('Confirm the list and run');
  el('first-run-advanced-confirm').click();
  await vi.waitFor(() => expect(advancedReads).toBe(2));
  await vi.waitFor(() => expect(el<HTMLButtonElement>('first-run-advanced-confirm').disabled).toBe(false));
  expect(el('first-run-error').textContent).toMatch(/Review .*again before confirming/u);
  expect(confirms).toBe(1);
  expect(document.body.dataset.firstRun).toBe('draft');
  el('first-run-advanced-confirm').click();
  await vi.waitFor(() => expect(document.body.dataset.firstRun).toBe('syncing'));
  const submitted = f.send.mock.calls.map(([request]) => request).filter(request => request.kind === 'known.firstRun.confirm');
  expect(submitted).toHaveLength(2);
  expect(submitted[0]).toMatchObject({ previewId: 'review-1', bootstrapMode: mode, advancedConfirmation: { confirmationProof: 'proof-review-1' } });
  expect(submitted[1]).toMatchObject({ previewId: 'review-2', bootstrapMode: mode, advancedConfirmation: { confirmationProof: 'proof-review-2' } });
  expect(submitted[1]!.confirmationId).not.toBe(submitted[0]!.confirmationId);
  expect(submitted[1]!.advancedConfirmation).not.toHaveProperty('deletes');
  expect(f.values['known.firstRun.confirmation.v1']).toBeNull();
  expect(el<HTMLButtonElement>('first-run-later').disabled).toBe(true);
  expect(el('root-tree').hasAttribute('inert')).toBe(true);
});

test('preview-only keeps the run unsubmitted until a fresh ordinary merge review and explicit Start', async () => {
  const f = await mount(async request => {
    if (request.kind === 'known.firstRun.preview' && request.bootstrapMode) return { ...preview('read-only'), report };
    if (request.kind === 'known.firstRun.confirm') return { ok: true, firstRun: 'completed', phase: 'completed' };
    return undefined;
  });
  choose('preview-only'); el('first-run-advanced-preview').click();
  await vi.waitFor(() => expect(el('first-run-switch-merge')).not.toBeNull());
  expect(el('first-run-advanced-hint').textContent).toContain('1 matched item');
  expect(el('first-run-delete-list').textContent).toContain('Switch to auto-merge to start sync');
  expect(el('first-run-advanced-confirm').hidden).toBe(true);
  expect(el<HTMLButtonElement>('first-run-start').disabled).toBe(true);
  expect(f.send.mock.calls.filter(([request]) => request.kind === 'known.firstRun.confirm')).toHaveLength(0);
  expect(f.send.mock.calls.at(-1)?.[0]).toMatchObject({ kind: 'known.firstRun.preview', bootstrapMode: 'merge' });
  el('first-run-switch-merge').click();
  await vi.waitFor(() => expect(el<HTMLButtonElement>('first-run-start').disabled).toBe(false));
  expect(f.send.mock.calls.at(-1)?.[0]).toEqual({ kind: 'known.firstRun.preview', viewId: 'view', selectedRefs: ['bar'], excludedRefs: [] });
  el('first-run-start').click();
  await vi.waitFor(() => expect(f.ui.isRangeActive()).toBe(false));
  const submitted = f.send.mock.calls.map(([request]) => request).filter(request => request.kind === 'known.firstRun.confirm');
  expect(submitted).toHaveLength(1);
  expect(submitted[0]).toMatchObject({ libraryId: 'library', previewId: 'merge-review' });
  expect(submitted[0]).not.toHaveProperty('advancedConfirmation');
  expect(submitted[0]).not.toHaveProperty('bootstrapMode');
  expect(el('first-run-confirm').hidden).toBe(true);
  expect(el('root-tree').hasAttribute('inert')).toBe(false);
  expect(f.values[FIRST_RUN_DRAFT]).toMatchObject({ deferred: false, libraryId: 'library' });
});

test('a destructive preview with no deletions still needs confirmation and changing mode discards its authority', async () => {
  const f = await mount(async request => request.kind === 'known.firstRun.preview' && request.bootstrapMode
    ? advanced('no-deletes', 'upload', true) : undefined);
  choose('upload'); el('first-run-advanced-preview').click();
  await vi.waitFor(() => expect(el('first-run-advanced-confirm').hidden).toBe(false));
  expect(el('first-run-advanced-confirm').textContent).toBe('Confirm and run');
  expect(el('first-run-delete-list').hidden).toBe(true);
  choose('download');
  expect(el('first-run-advanced-confirm').hidden).toBe(true);
  expect(el<HTMLButtonElement>('first-run-start').disabled).toBe(true);
  el('first-run-advanced-confirm').click();
  expect(f.send.mock.calls.filter(([request]) => request.kind === 'known.firstRun.confirm')).toHaveLength(0);
});

test('after the polling deadline Check status resumes observation without another confirmation', async () => {
  let state: 'none' | 'running' | 'completed' = 'none';
  const f = await mount(async request => {
    if (request.kind === 'known.firstRun.status') return { ok: true, firstRun: state,
      phase: state === 'none' ? 'draft' : state === 'running' ? 'syncing' : 'completed' };
    if (request.kind === 'known.firstRun.confirm') { state = 'running'; return { ok: true, firstRun: state, phase: 'syncing' }; }
    return undefined;
  });
  vi.useFakeTimers(); el('first-run-start').click();
  await vi.advanceTimersByTimeAsync(90_001);
  expect(el('first-run-error').textContent).toContain('Sync is still running in the background');
  const statusCount = f.send.mock.calls.filter(([request]) => request.kind === 'known.firstRun.status').length;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(f.send.mock.calls.filter(([request]) => request.kind === 'known.firstRun.status')).toHaveLength(statusCount);
  state = 'completed'; el('first-run-error').querySelector('button')!.click();
  await vi.advanceTimersByTimeAsync(1);
  expect(el('first-run-confirm').hidden).toBe(true);
  expect(f.ui.isRangeActive()).toBe(false);
  expect(f.send.mock.calls.filter(([request]) => request.kind === 'known.firstRun.confirm')).toHaveLength(1);
});

test('Later persists the current draft, and signing back in restores that draft without starting sync', async () => {
  const f = await mount(async request => request.kind === 'known.firstRun.later'
    ? { ok: true, firstRun: 'deferred', phase: 'draft' } : undefined);
  el('first-run-later').click();
  await vi.waitFor(() => expect(el('first-run-error').textContent).toBe('Sync is off'));
  expect(f.values[FIRST_RUN_DRAFT]).toMatchObject({ libraryId: 'library', deferred: true,
    selected: [{ ref: 'bar', title: 'Bookmarks bar', kind: 'bookmarks_bar', depth: 0 }] });
  f.ui.onSignedIn(false, false);
  expect(el('first-run-confirm').hidden).toBe(true);
  f.ui.onSignedIn(true, true);
  await vi.waitFor(() => expect(f.showPane).toHaveBeenCalledWith('folders'));
  f.folders.render({ ...view, viewId: 'after-sign-in' });
  await vi.waitFor(() => expect(el<HTMLButtonElement>('first-run-start').disabled).toBe(false));
  expect(document.querySelector<HTMLInputElement>('.root-select input[data-ref="bar"]')!.checked).toBe(true);
  expect(f.send.mock.calls.filter(([request]) => request.kind === 'known.firstRun.confirm')).toHaveLength(0);
});

test('managed-only folders are explained, and granting permission reads fresh counts', async () => {
  let reads = 0;
  const f = await mount(async request => request.kind === 'known.firstRun.preview' ? preview(`read-${++reads}`) : undefined);
  f.folders.render({ ...view, viewId: 'managed', roots: view.roots.map(root => ({ ...root, managed: true, selected: false })) });
  expect(el('first-run-empty').textContent).toContain('These folders cannot be edited');
  expect(document.querySelectorAll('.root-select input:disabled')).toHaveLength(2);
  f.folders.render({ ...view, viewId: 'permission-restored' });
  await vi.waitFor(() => expect(el<HTMLButtonElement>('first-run-start').disabled).toBe(false));
  const before = reads;
  f.ui.onPermissionResult(true);
  await vi.waitFor(() => expect(reads).toBe(before + 1));
  await vi.waitFor(() => expect(f.values[FIRST_RUN_DRAFT]).toMatchObject({ previewId: `read-${reads}` }));
  expect(f.send.mock.calls.filter(([request]) => request.kind === 'known.firstRun.confirm')).toHaveLength(0);
});

test.each(['payload_too_large', 'bootstrap_upload_rejected'])('a terminal status %s stops polling and unlocks the submitted picker without another attempt', async code => {
  let failed = false;
  const f = await mount(async request => {
    if (request.kind === 'known.firstRun.status' && failed) return { ok: false, error: code };
    if (request.kind === 'known.firstRun.confirm') { failed = true; return new Promise(() => {}); }
    return undefined;
  });
  vi.useFakeTimers(); el('first-run-start').click();
  await vi.advanceTimersByTimeAsync(1_001);
  expect(el('first-run-error').textContent).toContain(code === 'payload_too_large'
    ? 'transfer size exceeds supported limits' : 'A change could not be synced');
  expect(el('root-tree').hasAttribute('inert')).toBe(false);
  const before = f.send.mock.calls.length;
  await vi.advanceTimersByTimeAsync(95_000);
  expect(f.send).toHaveBeenCalledTimes(before);
  expect(f.send.mock.calls.filter(([request]) => request.kind === 'known.firstRun.confirm')).toHaveLength(1);
  expect(el('first-run-confirm').hidden).toBe(false);
});

test('attention actions carry the current report and exact local evidence, preserve errors, and refresh resolved items', async () => {
  let reviewing = false, failLocal = true, localPending = false, duplicateResolved = false;
  const summary = () => ({ reportId: 'report-1', candidateCount: duplicateResolved ? 0 : 1,
    conflictCount: 1, pendingCount: duplicateResolved ? 1 : 2 });
  const current = () => ({ ok: true as const, firstRun: 'completed' as const, phase: 'needs_attention' as const,
    attention: summary(), conflictHref: 'https://library.example/sync' });
  const f = await mount(async request => {
    if (request.kind === 'known.firstRun.status' && reviewing) return current();
    if (request.kind === 'known.firstRun.attention.get') return { ...current(), items: [
      { itemId: 'local', label: 'Local bookmark', kind: 'local_difference', locationCount: 2, decision: 'open',
        parentLabels: ['Device folder', 'Cloud folder'], evidenceDigest: 'exact-evidence', resolutionPending: localPending },
      ...(!duplicateResolved ? [{ itemId: 'duplicate', label: 'Similar bookmark', kind: 'duplicate_candidate' as const,
        locationCount: 2, decision: 'open' as const }] : []),
    ] };
    if (request.kind === 'known.firstRun.attention.decide') {
      if (request.itemId === 'local' && failLocal) return { ok: false, error: 'preview_stale' };
      if (request.itemId === 'local') localPending = true;
      if (request.itemId === 'duplicate') duplicateResolved = true;
      return current();
    }
    return undefined;
  });
  reviewing = true; f.ui.onSignedIn(true, true);
  await vi.waitFor(() => expect(el('first-run-attention').hidden).toBe(false));
  expect(el('first-run-conflict-link').querySelector('a')!.href).toBe('https://library.example/sync');
  el('first-run-view-attention').click();
  const localButton = () => Array.from(el('first-run-attention-list').querySelectorAll('button')).find(button => button.textContent?.includes('Upload this device'))!;
  await vi.waitFor(() => expect(localButton()).toBeDefined());
  expect(el('first-run-attention-list').textContent).toContain('Device folder: Device folder; cloud folder: Cloud folder.');
  localButton().click();
  await vi.waitFor(() => expect(el('first-run-error').textContent).toMatch(/Review .*again/u));
  expect(el('first-run-attention-list').textContent).toContain('Local bookmark');
  failLocal = false; localButton().click();
  await vi.waitFor(() => expect(el('first-run-attention-list').textContent).toContain('Upload submitted; waiting for convergence'));
  expect(Array.from(el('first-run-attention-list').querySelectorAll('button')).find(button => button.textContent?.includes('Upload submitted'))!.disabled).toBe(true);
  Array.from(el('first-run-attention-list').querySelectorAll('button')).find(button => button.textContent === 'Keep both')!.click();
  await vi.waitFor(() => expect(el('first-run-attention-list').textContent).not.toContain('Similar bookmark'));
  expect(f.send.mock.calls.map(([request]) => request).filter(request => request.kind === 'known.firstRun.attention.decide')).toEqual([
    { kind: 'known.firstRun.attention.decide', reportId: 'report-1', itemId: 'local', decision: 'keep_local', evidenceDigest: 'exact-evidence' },
    { kind: 'known.firstRun.attention.decide', reportId: 'report-1', itemId: 'local', decision: 'keep_local', evidenceDigest: 'exact-evidence' },
    { kind: 'known.firstRun.attention.decide', reportId: 'report-1', itemId: 'duplicate', decision: 'keep_both' },
  ]);
  expect(el('first-run-confirm').hidden).toBe(false);
  expect(el('first-run-error').textContent).toContain('1 item');
  expect(f.send.mock.calls.filter(([request]) => request.kind === 'known.firstRun.confirm')).toHaveLength(0);
});

test('attention refresh drops an older page response and clears links not supplied by the current report', async () => {
  let reviewing = false, reads = 0;
  let replyOld!: (response: FirstRunOrScopeResponse) => void;
  const status = { ok: true as const, firstRun: 'completed' as const, phase: 'needs_attention' as const,
    attention: { reportId: 'report', candidateCount: 1, conflictCount: 0, pendingCount: 1 } };
  const f = await mount(async request => {
    if (request.kind === 'known.firstRun.status' && reviewing) return { ...status, conflictHref: 'javascript:alert(1)' };
    if (request.kind === 'known.firstRun.attention.get') {
      if (++reads === 1) return new Promise(resolve => { replyOld = resolve; });
      return { ...status, items: [{ itemId: 'current', label: 'Current review', kind: 'duplicate_candidate', decision: 'open', locationCount: 2 }] };
    }
    return undefined;
  });
  reviewing = true; f.ui.onSignedIn(true, true);
  await vi.waitFor(() => expect(el('first-run-attention').hidden).toBe(false));
  expect(el('first-run-conflict-link').hidden).toBe(true);
  expect(el('first-run-conflict-link').querySelector('a')!.hasAttribute('href')).toBe(false);
  el('first-run-view-attention').click();
  await vi.waitFor(() => expect(replyOld).toBeTypeOf('function'));
  el('first-run-view-attention').click();
  await vi.waitFor(() => expect(el('first-run-attention-list').textContent).toContain('Current review'));
  replyOld({ ...status, items: [{ itemId: 'stale', label: 'Old review', kind: 'conflict', decision: 'open', locationCount: 2 }],
    conflictHref: 'https://stale.example/sync' });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(el('first-run-attention-list').textContent).not.toContain('Old review');
  expect(el('first-run-conflict-link').hidden).toBe(true);
  expect(f.send.mock.calls.filter(([request]) => request.kind === 'known.firstRun.attention.decide')).toHaveLength(0);
});

