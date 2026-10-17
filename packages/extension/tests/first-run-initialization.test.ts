// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bindFirstRunOnboarding } from '../src/first-run-ui.js';
import { bindFolders } from '../src/sync-folders.js';
import { FIRST_RUN_DRAFT } from '../src/first-run-draft.js';
import type { FirstRunOrScopeResponse, PublicRootView } from '../src/types.js';

const view: PublicRootView = { viewId: 'saved', status: 'ready', roots: [{ ref: 'bar', kind: 'bookmarks_bar',
  title: 'Bookmarks bar', depth: 0, selected: false, privateLocal: false, managed: false, bookmarkCount: 1, folderCount: 0 }] };
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let response: FirstRunOrScopeResponse;
beforeEach(async () => {
  vi.useFakeTimers();
  const markup = await readFile('options.html', 'utf8');
  document.body.innerHTML = markup.match(/<body[^>]*>([\s\S]*)<\/body>/u)![1]!.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, '');
  document.body.dataset.library = 'ready'; document.body.dataset.firstRun = '';
  response = { ok: false, error: 'not_connected' };
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async (message: { kind: string }) => message.kind === 'known.firstRun.status'
    ? response : { ok: true, view }) }, storage: { local: {
      get: vi.fn(async () => ({ 'known.sync.collection.v1': 'library', [FIRST_RUN_DRAFT]: {
        selected: [{ ref: 'bar', title: 'Bookmarks bar', kind: 'bookmarks_bar', depth: 0 }], excluded: [], deferred: true, libraryId: 'library',
      } })), set: vi.fn(async () => {}) } } });
});
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren();
  delete document.body.dataset.library; delete document.body.dataset.firstRun;
});

async function mount() {
  const folders = bindFolders({ isConnected: () => true, firstRun: () => firstRun });
  const firstRun = bindFirstRunOnboarding({ rootTree: el('root-tree'), saveRoots: el('save-roots'),
    requestPermission: el('request-bookmark-permission'), folderHeading: el('folder-heading'), folderIntro: el('folder-intro'),
    showPane: () => {}, onSyncStatusChanged: () => { folders.render(view); } });
  folders.render(view);
  await vi.advanceTimersByTimeAsync(1);
  return { folders, firstRun };
}

test('a transient initialization failure never restores an onboarding draft over saved selections', async () => {
  const { folders, firstRun } = await mount();
  expect(firstRun.isRangeActive()).toBe(false);
  expect(document.querySelector<HTMLInputElement>('.root-select input')!.checked).toBe(false);
  response = { ok: true, phase: 'completed', firstRun: 'completed' };
  await vi.advanceTimersByTimeAsync(1_000); folders.render(view);
  expect(firstRun.isRangeActive()).toBe(false);
  expect(document.querySelector<HTMLInputElement>('.root-select input')!.checked).toBe(false);
  expect(vi.mocked(chrome.runtime.sendMessage).mock.calls.some(([message]) => (message as { kind: string }).kind === 'known.firstRun.preview')).toBe(false);
});

test('completed sync with an attention report keeps the saved picker and its Review changes action', async () => {
  response = { ok: true, phase: 'needs_attention', firstRun: 'completed',
    attention: { reportId: 'old', pendingCount: 1, candidateCount: 1, conflictCount: 0 } };
  const { folders, firstRun } = await mount(); folders.render(view);
  expect(firstRun.isRangeActive()).toBe(false);
  expect(document.querySelector<HTMLInputElement>('.root-select input')!.checked).toBe(false);
  expect(el<HTMLButtonElement>('save-roots').hidden).toBe(false);
});

test('retrying initialization restores a deferred draft only after the server confirms onboarding is incomplete', async () => {
  const { firstRun } = await mount();
  expect(firstRun.isRangeActive()).toBe(false);
  response = { ok: true, phase: 'draft', firstRun: 'deferred' };
  await vi.advanceTimersByTimeAsync(1_000);
  expect(firstRun.isRangeActive()).toBe(true);
  expect(document.querySelector<HTMLInputElement>('.root-select input')!.checked).toBe(true);
  expect(vi.mocked(chrome.runtime.sendMessage).mock.calls.some(([message]) => (message as { kind: string }).kind === 'known.firstRun.preview')).toBe(true);
});
