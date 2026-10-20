// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { syncRootRefs, excludedFolderRefs } from '../src/folder-coverage.js';
import { bindRangeAdjustment } from '../src/range-ui.js';
import { bindFolders } from '../src/sync-folders.js';
import { bindOptionsSyncProgress } from '../src/sync-progress-dom.js';
import type { PublicRangePreview, PublicRootNode, PublicRootView, RootRequest } from '../src/types.js';

const row = (ref: string, title: string, depth: number, over: Partial<PublicRootNode> = {}): PublicRootNode => ({
  ref, kind: depth === 0 ? 'bookmarks_bar' : 'folder', title, depth, selected: depth === 0,
  privateLocal: false, managed: false, bookmarkCount: 12, folderCount: 0, ...over });
const ready = (roots: PublicRootNode[], status: PublicRootView['status'] = 'ready'): PublicRootView => ({ viewId: 'v1', status, roots });
const tree = () => ready([
  row('bar', 'Bookmarks bar', 0, { bookmarkCount: 0, folderCount: 3 }), row('mkt', 'Marketing', 1, { folderCount: 1 }),
  row('seo', 'SEO', 2), row('prog', 'Programming', 1), row('other', 'Other bookmarks', 0, { kind: 'other', bookmarkCount: 0 }),
]);
const firstRun = { isRangeActive: vi.fn(() => false), onRootsRendered: vi.fn() };
const input = (ref: string) => document.querySelector<HTMLInputElement>(`.root-select input[data-ref="${ref}"]`)!;
const text = (id: string) => document.getElementById(id)!.textContent;
async function mount(response: (message: RootRequest) => unknown = () => ({ ok: true, view: tree() })) {
  const markup = await readFile('options.html', 'utf8');
  document.body.innerHTML = markup.match(/<body[^>]*>([\s\S]*)<\/body>/u)![1]!.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, '');
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async (message: RootRequest) => response(message)) } });
  const host = bindFolders({ isConnected: () => true, firstRun: () => firstRun });
  host.onConnection(true);
  await vi.waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalled());
  await new Promise(resolve => setTimeout(resolve, 20));
  return host;
}
beforeEach(() => { firstRun.onRootsRendered.mockClear(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

test('every folder syncs by default, including an empty browser root, and descendants remain editable', async () => {
  await mount();
  for (const ref of ['bar', 'mkt', 'seo', 'prog', 'other']) {
    expect(input(ref).checked).toBe(true); expect(input(ref).disabled).toBe(false);
  }
  expect(text('folder-count')).toBe('5 of 5 folders sync');
  expect(syncRootRefs(document.getElementById('root-tree')!)).toEqual(['bar', 'other']);
});
test('unticking a folder keeps its subtree on this browser; ticking restores it', async () => {
  await mount();
  input('mkt').click();
  expect(excludedFolderRefs(document.getElementById('root-tree')!)).toContain('mkt');
  expect(input('seo').checked).toBe(false); expect(input('seo').disabled).toBe(true);
  expect(input('bar').indeterminate).toBe(true); expect(input('other').checked).toBe(true);
  expect(text('folder-count')).toBe('3 of 5 folders sync');
  expect(excludedFolderRefs(document.getElementById('root-tree')!)).toEqual(['mkt']);
  expect((document.getElementById('cancel-roots') as HTMLButtonElement).disabled).toBe(false);
  input('mkt').click();
  expect(input('seo').checked).toBe(true); expect(input('seo').disabled).toBe(false);
  expect(excludedFolderRefs(document.getElementById('root-tree')!)).toEqual([]);
});
test('a mixed parent can include all its descendants again', async () => {
  await mount(); input('seo').click();
  expect(input('mkt').indeterminate).toBe(true); expect(input('bar').indeterminate).toBe(true);
  input('bar').click();
  expect(input('seo').checked).toBe(true);
  expect(input('bar').indeterminate).toBe(false);
  expect(excludedFolderRefs(document.getElementById('root-tree')!)).toEqual([]);
});

test('a child can be selected directly while its parent is unselected', async () => {
  await mount(() => ({ ok: true, view: ready(tree().roots.map(root => ({ ...root, selected: false }))) }));
  expect(input('mkt').disabled).toBe(false);
  input('mkt').click();
  expect(input('mkt').checked).toBe(true);
  expect(input('seo').checked).toBe(true);
  expect(input('bar').indeterminate).toBe(true);
  expect(input('prog').checked).toBe(false);
  expect(input('other').checked).toBe(false);
  expect(syncRootRefs(document.getElementById('root-tree')!)).toEqual(['mkt']);
  expect(text('folder-count')).toBe('2 of 5 folders sync');
});

test('clearing the selection leaves nested folders editable and previews only the selected subtree', async () => {
  const host = await mount();
  document.getElementById('tree-clear-selection')!.click();
  for (const ref of ['bar', 'mkt', 'seo', 'prog', 'other']) {
    expect(input(ref).checked).toBe(false);
    expect(input(ref).disabled).toBe(false);
  }
  input('seo').click();
  expect(input('bar').indeterminate).toBe(true);
  expect(input('mkt').indeterminate).toBe(true);
  expect(input('prog').checked).toBe(false);
  expect(syncRootRefs(document.getElementById('root-tree')!)).toEqual(['seo']);
  expect((document.getElementById('cancel-roots') as HTMLButtonElement).disabled).toBe(false);
  const range = bindRangeAdjustment({
    saveRoots: document.getElementById('save-roots') as HTMLButtonElement,
    rootTree: document.getElementById('root-tree')!, rootFeedback: document.getElementById('root-feedback')!,
    getView: host.view, setView: host.render, reloadBoundaries: () => {}, onConfirmed: () => {}, isConnected: () => true, renderFailure: () => {},
  });
  await range.save();
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
    kind: 'known.roots.preview', viewId: 'v1', selectedRefs: ['seo'], privateRefs: [],
  });
});

test('unchecking an independent parent allows selecting a deeper descendant', async () => {
  await mount();
  input('bar').click();
  input('other').click();
  expect(input('seo').disabled).toBe(false);
  input('seo').click();
  expect(syncRootRefs(document.getElementById('root-tree')!)).toEqual(['seo']);
  expect(excludedFolderRefs(document.getElementById('root-tree')!)).toEqual([]);
});
test('managed folders stay read-only and there is one visible checkbox per editable folder', async () => {
  await mount(() => ({ ok: true, view: ready([row('a', 'Reading', 0), row('m', 'Managed', 0, { managed: true, exclusionReason: 'managed' })]) }));
  expect(document.querySelectorAll('.root-private')).toHaveLength(0);
  expect(input('m').disabled).toBe(true); expect(input('m').checked).toBe(false);
  expect(document.querySelector('.root-row[data-ref="m"] .badge')!.textContent).toBe('Managed');
});
test('Sync all brings every unticked folder back into sync', async () => {
  await mount(); const rootTree = document.getElementById('root-tree')!, changed = vi.fn();
  input('mkt').click(); input('other').click();
  expect(syncRootRefs(rootTree)).toEqual(['bar']);
  expect(excludedFolderRefs(rootTree)).toEqual(['mkt']);
  rootTree.addEventListener('change', changed);
  expect(document.getElementById('tree-invert')).toBeNull();
  expect(text('tree-select-level')).toBe('Sync all');
  document.getElementById('tree-select-level')!.click();
  expect(changed).toHaveBeenCalledTimes(1);
  expect(syncRootRefs(rootTree)).toEqual(['bar', 'other']);
  expect(text('folder-count')).toBe('5 of 5 folders sync');
  expect(excludedFolderRefs(rootTree)).toEqual([]);
});
test('collapsing the tree preserves unsaved exclusions', async () => {
  await mount(); input('seo').click();
  document.querySelector<HTMLButtonElement>('.root-row[data-ref="mkt"] .tree-toggle')!.click();
  expect(document.querySelector('.root-row[data-ref="seo"]')!.classList.contains('is-collapsed-child')).toBe(true);
  expect(excludedFolderRefs(document.getElementById('root-tree')!)).toContain('seo');
});
test('missing permission and failed loads retain their existing actionable alerts', async () => {
  await mount(() => ({ ok: true, view: ready([], 'permission_required') }));
  expect(document.getElementById('root-alert')!.hidden).toBe(false);
  expect(text('root-alert-copy')).toMatch(/Bookmark permission is required/);
  expect((document.getElementById('request-bookmark-permission') as HTMLButtonElement).hidden).toBe(false);
  expect(document.getElementById('folder-card')!.dataset.roots).toBe('blocked');
  await mount(() => ({ ok: false, error: 'request_invalid' }));
  expect(document.getElementById('root-alert')!.dataset.tone).toBe('danger');
  expect((document.getElementById('root-retry') as HTMLButtonElement).hidden).toBe(false);
  expect(document.body.textContent).not.toMatch(/undefined|request_invalid/u);
});
test('a deep link highlights an excluded folder without changing its sync choice', async () => {
  await mount(() => ({ ok: true, view: ready([row('a', 'Reading', 0), row('b', 'Work', 0, { privateLocal: true, preselected: true })]) }));
  expect(document.activeElement).toBe(input('b'));
  expect(input('b').checked).toBe(false);
  expect(text('root-feedback')).toContain('Work is highlighted.');
  expect(firstRun.onRootsRendered).toHaveBeenCalled();
});

test('restoring an excluded parent retains the child’s explicit exclusion', async () => {
  await mount(() => ({ ok: true, view: ready([
    row('bar', 'Bookmarks bar', 0), row('mkt', 'Marketing', 1, { privateLocal: true }),
    row('seo', 'SEO', 2, { privateLocal: true }),
  ]) }));
  input('mkt').click();
  expect(excludedFolderRefs(document.getElementById('root-tree')!)).toEqual(['seo']);
  expect(input('mkt').disabled).toBe(false);
  expect(input('seo').disabled).toBe(false);
});


test('range preview sends whole-browser roots and explicit exclusions in their respective fields', async () => {
  const host = await mount();
  input('mkt').click();
  const range = bindRangeAdjustment({
    saveRoots: document.getElementById('save-roots') as HTMLButtonElement,
    rootTree: document.getElementById('root-tree')!, rootFeedback: document.getElementById('root-feedback')!,
    getView: host.view, setView: host.render, reloadBoundaries: () => {}, onConfirmed: () => {}, isConnected: () => true, renderFailure: () => {},
  });
  await range.save();
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
    kind: 'known.roots.preview', viewId: 'v1', selectedRefs: ['bar', 'other'], privateRefs: ['mkt'],
  });
});

test.each(['done', 'syncing', 'failed'] as const)('confirming a range immediately reports %s without waiting for the idle poll', async outcome => {
  const preview: PublicRangePreview = { previewId: 'range', treeDigest: 'tree', boundaryVersion: '2',
    bookmarkCount: 12, folderCount: 5, addedCount: 1, addedBookmarkCount: 12, additions: [], removedCount: 0, shiftCount: 0,
    skippedCount: 0, expiresAt: Date.now() + 60_000, shifts: [], removals: [], warnings: [] };
  let stage = 'done', confirmationId = '';
  let finish!: (response: unknown) => void;
  const host = await mount(message => {
    const kind = (message as { kind: string }).kind;
    if (kind === 'known.sync.progress.get') return { ok: true, progress: {
      stage, firstSync: false, liveWork: stage !== 'done',
      bookmarks: { synced: stage === 'done' ? 12 : 11, total: 12 }, folders: { synced: 5, total: 5 },
    } };
    if (kind === 'known.personalSync.status') return { ok: true, policy: { mode: 'enabled' } };
    if (kind === 'known.firstRun.status') return { ok: true, firstRun: 'completed', phase: 'completed' };
    if (kind === 'known.sync.engine.status') return { ok: true, engine: { phase: 'sleeping', hasPendingWork: stage !== 'done' } };
    if (message.kind === 'known.roots.preview') return { ok: true, preview };
    if (message.kind === 'known.roots.confirm') { confirmationId = message.confirmationId;
      return new Promise(resolve => { finish = resolve; }); }
    return { ok: true, view: tree() };
  });
  vi.useFakeTimers();
  const progress = bindOptionsSyncProgress({ connected: () => true });
  const onConfirmed = vi.fn(() => { void progress.refresh({ showDone: true }); });
  const range = bindRangeAdjustment({
    saveRoots: document.getElementById('save-roots') as HTMLButtonElement,
    rootTree: document.getElementById('root-tree')!, rootFeedback: document.getElementById('root-feedback')!,
    getView: host.view, setView: host.render, reloadBoundaries: () => {}, onConfirmed,
    isConnected: () => true, renderFailure: code => { throw new Error(code); },
  });
  try {
    await progress.refresh();
    expect(document.getElementById('sync-progress')!.hidden).toBe(true);
    await range.save();
    const confirm = document.getElementById('range-confirm') as HTMLButtonElement;
    confirm.click(); confirm.click();
    await vi.advanceTimersByTimeAsync(1);
    expect(confirm.getAttribute('aria-busy')).toBe('true');
    expect(confirm.textContent).toBe('Saving…');
    expect(text('root-feedback')).toBe('Confirming folder changes. You can reopen this page to check the result.');
    expect((document.getElementById('range-cancel') as HTMLButtonElement).disabled).toBe(true);
    expect(vi.mocked(chrome.runtime.sendMessage).mock.calls.filter(([message]) => (message as RootRequest).kind === 'known.roots.confirm')).toHaveLength(1);
    stage = outcome === 'syncing' ? 'syncing' : 'done';
    finish(outcome === 'failed' ? { ok: false, error: 'preview_stale' } : { ok: true, view: tree(),
      confirmation: { confirmationId, state: 'committed' } });
    await vi.advanceTimersByTimeAsync(1);
    expect(confirm.hasAttribute('aria-busy')).toBe(false);
    expect(confirm.textContent).toBe('Confirm folder changes');
    const card = document.getElementById('sync-progress')!;
    if (outcome === 'failed') {
      expect(onConfirmed).not.toHaveBeenCalled(); expect(card.hidden).toBe(true);
      expect(text('root-feedback')).toContain('Folder tree changed');
    } else {
      expect(onConfirmed).toHaveBeenCalledTimes(1); expect(card.hidden).toBe(false);
      expect(text('sync-progress-title')).toBe(outcome === 'done' ? 'Sync complete' : 'Syncing bookmarks');
      expect(card.dataset.state).toBe(outcome === 'done' ? 'done' : 'running');
      if (outcome === 'syncing') {
        stage = 'done'; await vi.advanceTimersByTimeAsync(2_000);
        expect(text('sync-progress-title')).toBe('Sync complete');
      }
    }
  } finally { progress.stop(); }
});
