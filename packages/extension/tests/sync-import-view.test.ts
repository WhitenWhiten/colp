// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { bindImport } from '../src/sync-import.js';
import type { ImportRequest, PublicImportPreview, PublicImportStatus } from '../src/types.js';

const preview = (over: Partial<PublicImportPreview> = {}): PublicImportPreview => ({
  digest: 'dg', sourceProfile: 'netscape-bookmarks-v1', creates: 1204, warnings: [],
  roots: [{ sourceNodeId: 'n1', kind: 'Folder', title: 'Bookmarks bar', descendants: 640 }, { sourceNodeId: 'n2', kind: 'Folder', title: 'Safari', descendants: 0 }],
  targets: [{ nativeId: '1', colpId: 'c1', revision: 'r', title: 'Reading list' }], ...over });
const status = (state: PublicImportStatus['state'], terminal: number, over: Partial<PublicImportStatus['progress']> = {}): PublicImportStatus => ({
  planId: 'plan', state, progress: { total: 1204, skipped: 4, queued: 1204 - terminal - 4, terminal, recoverable: 0, ...over } });
const byId = (id: string) => document.getElementById(id)!;
let handlers: { calls: ImportRequest[] };

async function mount(respond: (message: ImportRequest) => unknown) {
  const markup = await readFile('options.html', 'utf8');
  document.body.innerHTML = markup.match(/<body[^>]*>([\s\S]*)<\/body>/u)![1]!.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, '');
  document.body.dataset.pane = 'sync';
  handlers = { calls: [] };
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async (message: ImportRequest) => { handlers.calls.push(message); return respond(message); }) },
    alarms: { create: vi.fn() }, permissions: { request: vi.fn(async () => true) }, bookmarks: { getTree: vi.fn(async () => []) } });
  const showFolders = vi.fn();
  const view = bindImport({ isConnected: () => true, showFolders, showStatus: vi.fn() });
  view.onConnection(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { view, showFolders };
}
async function choose() {
  const file = new File(['<DL></DL>'], 'bookmarks.html', { type: 'text/html' });
  Object.defineProperty(byId('import-file'), 'files', { value: [file], configurable: true });
  byId('import-file').dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(byId('import-preview').hidden).toBe(false));
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

test('the preview maps each folder, and Import stays off until every folder has a destination or Skip', async () => {
  await mount((message) => message.kind === 'known.import.previewFile' ? { ok: true, preview: preview() } : { ok: false, error: 'no_import' });
  await choose();
  expect(byId('import-count').textContent).toBe('1,204 items will be added to your collection.');
  const labels = Array.from(document.querySelectorAll('.import-map-label')).map((label) => label.textContent);
  expect(labels).toEqual(['Bookmarks bar (641 items)', 'Safari']);
  const commit = byId('commit-import') as HTMLButtonElement;
  expect(commit.disabled).toBe(true);
  const selects = Array.from(document.querySelectorAll<HTMLSelectElement>('.import-map-row select'));
  expect(Array.from(selects[0]!.options).map((option) => option.textContent)).toEqual(['Choose destination', 'Reading list', 'Skip']);
  selects[0]!.value = '0'; selects[0]!.dispatchEvent(new Event('change'));
  expect(commit.disabled).toBe(true);
  selects[1]!.value = 'skip'; selects[1]!.dispatchEvent(new Event('change'));
  expect(commit.disabled).toBe(false);
});

test('warnings fold into one quiet disclosure; Cancel drops the preview', async () => {
  await mount((message) => message.kind === 'known.import.previewFile'
    ? { ok: true, preview: preview({ warnings: [{ code: 'a', message: 'Bookmark without HREF was omitted.' }, { code: 'b', message: 'Invalid bookmark timestamp was omitted.' }] }) }
    : { ok: false, error: 'no_import' });
  await choose();
  expect(byId('import-notes').hidden).toBe(false);
  expect(byId('import-notes-summary').textContent).toBe('2 notes about this file');
  expect(byId('import-warnings').children).toHaveLength(2);
  byId('cancel-import').click();
  expect(byId('import-preview').hidden).toBe(true);
});

test('a commit shows plain counts, one Pause and a meter; a pace later adds the time left', async () => {
  let committed = false;
  const f = await mount((message) => {
    if (message.kind === 'known.import.previewFile') return { ok: true, preview: preview() };
    if (message.kind === 'known.import.commit') { committed = true; return { ok: true, status: status('active', 100) }; }
    if (message.kind === 'known.import.status' && committed) return { ok: true, status: status('active', 100 + (Date.now() - 1_000_000) / 50) };
    return { ok: false, error: 'no_import' };
  });
  await choose();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(1_000_000);
  for (const select of Array.from(document.querySelectorAll<HTMLSelectElement>('.import-map-row select'))) { select.value = 'skip'; select.dispatchEvent(new Event('change')); }
  byId('commit-import').click();
  await vi.waitFor(() => expect(byId('import-progress').hidden).toBe(false));
  expect(byId('import-state').textContent).toBe('Importing bookmarks');
  expect(byId('import-progress-count').textContent).toBe('104 of 1,204');
  expect(byId('import-progress-meter').getAttribute('aria-valuenow')).toBe('104');
  expect((byId('import-progress-meter').firstElementChild as HTMLElement).style.width).toMatch(/^8\.6/);
  expect(byId('pause-import').hidden).toBe(false);
  expect(byId('resume-import').hidden).toBe(true);
  expect(byId('retry-import').hidden).toBe(true);
  expect(byId('import-eta').textContent).toBe('');
  await vi.advanceTimersByTimeAsync(2_500);
  await vi.advanceTimersByTimeAsync(2_500);
  await vi.waitFor(() => expect(byId('import-eta').textContent).toMatch(/left$/));
  expect(f.view.hasPlan()).toBe(true);
});

test('paused offers Resume, needing attention offers Retry and the way to look, complete offers nothing', async () => {
  const states: PublicImportStatus[] = [status('paused', 600), status('attention', 1190, { recoverable: 6, queued: 0 }), status('complete', 1200, { queued: 0 })];
  for (const state of states) {
    await mount((message) => message.kind === 'known.import.status' ? { ok: true, status: state } : { ok: false, error: 'x' });
    expect(byId('import-progress').hidden).toBe(false);
    expect(byId('resume-import').hidden).toBe(state.state !== 'paused');
    expect(byId('retry-import').hidden).toBe(state.state !== 'attention');
    expect(byId('import-attention-actions').hidden).toBe(state.state !== 'attention');
    expect(byId('pause-import').hidden).toBe(true);
    expect(byId('import-eta').textContent).toBe('');
  }
  expect(byId('import-state').textContent).toBe('Import complete');
  expect(byId('import-progress-copy').textContent).toBe('4 skipped');
  await mount((message) => message.kind === 'known.import.status' ? { ok: true, status: states[1] } : { ok: false, error: 'x' });
  expect(byId('import-progress-copy').textContent).toBe('4 skipped · 6 items need attention');
});

test('a refusal is one danger alert in plain words and never shows the code', async () => {
  const f = await mount((message) => message.kind === 'known.import.previewFile' ? { ok: false, error: 'push_problem_status_mismatch' } : { ok: false, error: 'no_import' });
  const file = new File(['x'], 'b.html');
  Object.defineProperty(byId('import-file'), 'files', { value: [file], configurable: true });
  byId('import-file').dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(byId('import-feedback').textContent).toMatch(/The import could not continue/));
  expect(byId('import-alert').dataset.tone).toBe('danger');
  expect(document.body.textContent).not.toMatch(/push_problem|undefined/u);
  expect(f.showFolders).not.toHaveBeenCalled();
});

test('an unavailable library opens the sync setup', async () => {
  const f = await mount((message) => message.kind === 'known.import.previewFile' ? { ok: false, error: 'collection_required' } : { ok: false, error: 'no_import' });
  Object.defineProperty(byId('import-file'), 'files', { value: [new File(['x'], 'b.html')], configurable: true });
  byId('import-file').dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(f.showFolders).toHaveBeenCalled());
  expect(byId('import-feedback').textContent).toBe('Your bookmark library is connecting. Try importing again in a moment.');
});

test('the heading names the collection once one is chosen', async () => {
  const f = await mount(() => ({ ok: false, error: 'no_import' }));
  f.view.setCollection('Reading list');
  expect(byId('import-heading').textContent).toBe('Import into Reading list');
  f.view.setCollection('');
  expect(byId('import-heading').textContent).toBe('Import to Know-N');
});
