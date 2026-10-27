// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import type { ImportStatus } from '../src/site-adapters/settings-import.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import type { SourceOverview } from '../src/site-adapters/overview.js';

vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ exclusionIds: async () => new Set() }));
vi.mock('../src/site-adapters/settings-recovery.js', () => ({}));
vi.mock('../src/site-adapters/community-settings.js', () => ({}));

const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const details = () => JSON.parse(element('status').textContent!);
const selected = () => document.querySelector<HTMLInputElement>('#archive-collections input')!;
async function mount(error?: string, configured = false) {
  vi.resetModules();
  window.location.href = 'https://extension.test/site-adapters.html#sync';
  document.body.innerHTML = readFileSync('site-adapters.html', 'utf8').match(/<body[^>]*>([\s\S]*)<\/body>/u)![1]!
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, '');
  const state = { enabled: true, connected: true, documents: 1, grants: { site: true, bookmarks: true },
    catalog: { items: [{ id: '83459231', title: 'Favorites' }], current: true, nextCursor: null, reading: false, failed: null },
    archive: { config: (configured ? { state: 'active', root: { nativeId: 'synced' }, collectionIds: ['83459231'], live: true } : null) as
      { state: string; root: { nativeId: string }; collectionIds: string[]; live: boolean } | null, import: null as ImportStatus | null,
      overview: { checkedAt: Date.now(), saved: 0, collections: [] } as SourceOverview } };
  const sendMessage = vi.fn(async (message: { kind: string; rootNativeId?: string; collectionIds?: string[] }) => {
    if (message.kind === 'known.siteAdapters.archive.configure') {
      if (message.rootNativeId === 'synced' && error) return { error };
      state.archive.config = { state: 'active', root: { nativeId: message.rootNativeId! }, collectionIds: message.collectionIds!, live: true };
    }
    if (message.kind === 'known.siteAdapters.cloud.configureRule') return { configured: true };
    if (message.kind === 'known.siteAdapters.operations.check') return { checked: true };
    return structuredClone(state);
  });
  const create = vi.fn();
  vi.stubGlobal('Option', function (text: string, value: string) {
    const option = document.createElement('option'); option.textContent = text; option.value = value; return option;
  });
  const openTab = vi.fn();
  vi.stubGlobal('chrome', { runtime: { sendMessage, getURL: (path: string) => `https://extension.test/${path}` },
    storage: { local: new MemoryStorageArea(), onChanged: { addListener: () => {}, removeListener: () => {} } },
    tabs: { create: openTab, query: async () => [] }, permissions: { contains: async () => true }, bookmarks: { create,
    getTree: async () => [{ id: '0', title: '', children: [{ id: '2', title: 'Other bookmarks', children: [
      { id: 'synced', title: 'Synced source' }, { id: 'local', title: 'Local source' },
    ] }] }],
  } });
  await import('../src/site-adapters/settings.js');
  await vi.waitFor(() => expect(document.querySelector('#archive-root')).not.toBeNull());
  await vi.waitFor(() => expect(selected()).not.toBeNull());
  if (!configured) { selected().checked = true; selected().dispatchEvent(new Event('change')); pick('synced'); }
  return { sendMessage, create, state, openTab };
}
function pick(id: string) {
  element('archive-root').click();
  document.querySelector<HTMLElement>(`#archive-root-picker [data-folder-id="${id}"]`)!.click();
}
afterEach(() => { window.dispatchEvent(new Event('pagehide')); vi.unstubAllGlobals(); document.body.replaceChildren(); });

test('the site sidebar and page head paint the supported site favicon with a letter fallback', async () => {
  await mount();
  const nav = document.querySelector('.sites-nav-item .sites-mark');
  expect(nav?.querySelector('img')?.getAttribute('src')).toBe('https://www.bilibili.com/favicon.ico');
  expect(document.querySelector('.sites-page-head > .sites-mark')).not.toBeNull();
  expect(document.querySelector('.sites-page-head .sites-mark-letter')?.textContent).toBe('B');
});

test('a refused action survives status refresh with the chosen scope intact', async () => {
  const f = await mount('permissionRequired');
  element('configure-archive').click();
  await vi.waitFor(() => expect(details().lastActionError).toMatchObject({
    operation: 'known.siteAdapters.archive.configure', error: 'permissionRequired', at: expect.any(Number),
  }));
  expect(element('site-problem').hidden).toBe(false);
  expect(element('site-problem-what').textContent).toContain('access is missing');
  const failure = details().lastActionError;
  element('refresh').click();
  await vi.waitFor(() => expect(details().lastActionError).toEqual(failure));
  expect(details().archive.config).toBeNull();
  expect(element('site-alert').hidden).toBe(true);
  expect(element('archive-root').dataset.value).toBe('synced');
  expect(selected().checked).toBe(true);
  expect(f.sendMessage.mock.calls.some(([r]) => r.kind === 'known.siteAdapters.import.start')).toBe(false);
  expect(f.create).not.toHaveBeenCalled();
});

test('choosing a local root after refusal clears the error and starts the existing import flow', async () => {
  const f = await mount('permissionRequired');
  element('configure-archive').click();
  await vi.waitFor(() => expect(details().lastActionError?.error).toBe('permissionRequired'));
  pick('local');
  element('configure-archive').click();
  await vi.waitFor(() => expect(f.sendMessage).toHaveBeenCalledWith({ kind: 'known.siteAdapters.import.start', adapterId: 'bundled.bilibili' }));
  expect(details()).not.toHaveProperty('lastActionError');
  expect(details().archive.config).toMatchObject({ state: 'active', root: { nativeId: 'local' }, collectionIds: ['83459231'] });
});
test('a synced root follows the same configure and preview import flow without a separate cloud setup', async () => {
  const f = await mount(); element('configure-archive').click();
  await vi.waitFor(() => expect(f.sendMessage).toHaveBeenCalledWith({ kind: 'known.siteAdapters.import.start', adapterId: 'bundled.bilibili' }));
  expect(details().archive.config).toMatchObject({ state: 'active', root: { nativeId: 'synced' } });
  expect(f.sendMessage.mock.calls.some(([r]) => r.kind.startsWith('known.siteAdapters.cloud.'))).toBe(false);
});
test('keeping two copies does not implicitly enable AI; automatic semantic saving requires its own switch', async () => {
  const f = await mount(); expect(element('archive-semantic').getAttribute('aria-checked')).toBe('false');
  element('archive-semantic').click(); element('configure-archive').click();
  await vi.waitFor(() => expect(f.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'known.siteAdapters.archive.configure', copies: 'sourceAndSemantic', semantic: 'automatic' })));
});

test('a cancelled 4914-item import with no source document reports the stop and permits an explicit new check', async () => {
  const f = await mount(undefined, true);
  f.state.documents = 0;
  f.state.archive.config!.collectionIds = Array.from({ length: 22 }, (_, i) => String(i + 1));
  f.state.archive.import = { id: 'cancelled-import', phase: 'cancelled', reason: null, edgeCount: 4914, pages: 93, omissions: 442,
    coverage: 'partial', nextEdge: 0, nextPlan: 0, preview: null };
  element('refresh').click();
  await vi.waitFor(() => expect(element('import-state').textContent).toBe('The last check was stopped'));
  expect(element('import-summary').textContent).toContain('4,914 favorites were found');
  expect(element('import-summary').textContent).toContain('This import added no bookmarks');
  expect(element('import-destination').textContent).toBe('22 collections → Synced source');
  expect(element('import-note').textContent).toContain('Bilibili will open');
  expect(document.querySelector('.sites-nav-state')?.textContent).toBe('Connected');
  expect(element<HTMLDialogElement>('site-settings-dialog').open).toBe(false);
  expect(element('panel-sync').firstElementChild?.id).toBe('source-overview');
  expect(element('overview-result').textContent).toContain('0 bookmarks saved');
  expect(element('start-import').hidden).toBe(true);
  expect(element('import-open-source').hidden).toBe(false);
  element('import-open-source').click();
  await vi.waitFor(() => expect(f.openTab).toHaveBeenCalledWith({ url: 'https://www.bilibili.com' }));
  expect(element('approve-import').hidden).toBe(true);
  expect(element('import-progress').hidden).toBe(true);
  expect(f.sendMessage.mock.calls.some(([r]) => r.kind === 'known.siteAdapters.import.start')).toBe(false);
  f.state.documents = 1;
  element('refresh').click();
  await vi.waitFor(() => expect(f.sendMessage).toHaveBeenCalledWith({ kind: 'known.siteAdapters.import.start', adapterId: 'bundled.bilibili' }), { timeout: 3000 });
  expect(f.create).not.toHaveBeenCalled();
});

function pausedCheck(): ImportStatus {
  return { id: 'paused-read', phase: 'paused', reason: 'restartRequired', edgeCount: 385, pages: 12, omissions: 15,
    coverage: 'partial', nextEdge: 0, nextPlan: 0, preview: null };
}
test('continuing a paused read immediately shows progress, survives polling, and prevents duplicate submissions', async () => {
  const f = await mount(undefined, true);
  f.state.archive.import = pausedCheck(); element('refresh').click();
  await vi.waitFor(() => expect(element('resume-import').hidden).toBe(false));
  let finish!: (value: typeof f.state) => void;
  const pending = new Promise<typeof f.state>(resolve => { finish = resolve; }), send = f.sendMessage.getMockImplementation()!;
  f.sendMessage.mockImplementation(message => message.kind === 'known.siteAdapters.import.resume' ? pending : send(message));
  element('resume-import').click();
  expect(element('import-state').textContent).toBe('Checking the Bilibili connection…');
  expect(element<HTMLButtonElement>('resume-import').disabled).toBe(true);
  expect(element('resume-import').getAttribute('aria-busy')).toBe('true');
  element('refresh').click();
  await vi.waitFor(() => expect(element('step-import').getAttribute('aria-busy')).toBe('true'));
  element('resume-import').dispatchEvent(new Event('click'));
  expect(f.sendMessage.mock.calls.filter(([r]) => r.kind === 'known.siteAdapters.import.resume')).toHaveLength(1);
  f.state.archive.import.phase = 'scanning'; finish(structuredClone(f.state));
  await vi.waitFor(() => expect(element('step-import').getAttribute('aria-busy')).toBe('false'));
  expect(element('import-state').textContent).toBe('Checking source items');
  expect(element('import-summary').textContent).toContain('385');
  expect(f.openTab).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
});
test('each failed continuation gives visible feedback and explains changed authorization without asking to open an already connected site', async () => {
  const f = await mount(undefined, true);
  f.state.archive.import = pausedCheck(); element('refresh').click();
  await vi.waitFor(() => expect(element('resume-import').hidden).toBe(false));
  const send = f.sendMessage.getMockImplementation()!;
  f.sendMessage.mockImplementation(message => message.kind === 'known.siteAdapters.import.resume' ? Promise.resolve({ error: 'sourceAuthorizationChanged' }) : send(message));
  element('resume-import').click();
  await vi.waitFor(() => expect(document.querySelector('.toast-message')?.textContent).toContain('access changed'));
  await vi.waitFor(() => expect(element<HTMLButtonElement>('resume-import').disabled).toBe(false));
  expect(element('site-problem-next').textContent).toContain('verify the current connection');
  const toast = document.querySelector('.toast:not(.is-closing)');
  element('resume-import').click();
  await vi.waitFor(() => expect(document.querySelector('.toast:not(.is-closing)')).not.toBe(toast));
  expect(element('site-problem-what').textContent).not.toContain('connection is unavailable');
  expect(f.openTab).not.toHaveBeenCalled();
});
test('a website tab without an adapter connection is reused for a paused check', async () => {
  const f = await mount(undefined, true);
  f.state.archive.import = pausedCheck(); f.state.documents = 0;
  const query = vi.fn(async () => [{ id: 17, incognito: false }]); chrome.tabs.query = query;
  element('refresh').click();
  await vi.waitFor(() => expect(element('import-open-source').hidden).toBe(false));
  element('import-open-source').click();
  await vi.waitFor(() => expect(f.sendMessage).toHaveBeenCalledWith({ kind: 'known.siteAdapters.import.resume', jobId: 'paused-read', adapterId: 'bundled.bilibili' }));
  expect(query).toHaveBeenCalledWith({ url: ['https://www.bilibili.com/*'] });
  expect(f.openTab).not.toHaveBeenCalled();
});

test('mapping status follows the import through reading, approval and sync waiting without claiming it saved items', async () => {
  const f = await mount(undefined, true);
  f.state.archive.import = { id: 'import', phase: 'scanning', reason: null, edgeCount: 1, pages: 2, omissions: 0,
    coverage: 'complete', nextEdge: 0, nextPlan: 0, preview: null,
    progress: { collectionsRead: 1, collectionsTotal: 2, currentCollection: 'Favorites', prepared: 0, saved: 0, toSave: 0 } };
  element('refresh').click();
  await vi.waitFor(() => expect(element('import-state').textContent).toBe('Checking source items'));
  expect(element('import-summary').textContent).toContain('Reading “Favorites”');
  expect(element('import-count').textContent).toBe('1 / 2 collections read');
  expect(element('import-progress-bar').getAttribute('aria-valuenow')).toBe('50');
  f.state.archive.import.phase = 'preview';
  f.state.archive.import.preview = { id: 'preview', revision: 1, digest: 'digest', coverage: 'complete',
    counts: { createFolders: 1, createBookmarks: 1, reuseBookmarks: 0, review: 0 } };
  element('refresh').click();
  await vi.waitFor(() => expect(element('import-summary').textContent).toContain('then add the bookmarks'));
  expect(element('approve-import').hidden).toBe(false);
  expect(f.sendMessage.mock.calls.some(([r]) => r.kind === 'known.siteAdapters.import.approve')).toBe(false);
  f.state.archive.import.phase = 'approved';
  f.state.archive.import.reason = 'sourceSyncPending';
  f.state.documents = 0;
  element('refresh').click();
  await vi.waitFor(() => expect(element('import-state').textContent).toBe('Saving source items'));
  expect(element('import-summary').textContent).toContain('sync connection and folder');
  expect(element('import-progress-bar').dataset.state).toBe('stalled');
  expect(f.create).not.toHaveBeenCalled();
});

test('deleted videos stay in a calm disclosure and an empty preview can finish without an error or a partial-read warning', async () => {
  const f = await mount(undefined, true);
  f.state.archive.import = { id: 'empty', phase: 'preview', reason: null, edgeCount: 0, pages: 3, omissions: 442, omissionCounts: { invalid: 442 },
    coverage: 'partial', scanComplete: true, nextEdge: 0, nextPlan: 0, preview: { id: 'preview', revision: 1, digest: 'digest', coverage: 'partial',
      omissions: { samples: [], unscannedRemainder: false }, counts: { createFolders: 0, createBookmarks: 0, reuseBookmarks: 0, review: 0 } } };
  element('refresh').click();
  await vi.waitFor(() => expect(element('import-state').textContent).toBe('Nothing new to add'));
  expect(element('import-note').hidden).toBe(true);
  expect(element('import-badge').hidden).toBe(true);
  expect(element('import-omissions-title').textContent).toBe('442 items skipped');
  expect(element<HTMLDetailsElement>('import-omissions').open).toBe(false);
  expect(element('import-omission-list').textContent).toContain('unavailable or deleted items');
  expect(element('approve-import').textContent).toBe('Finish');
  expect(element('approve-import').hidden).toBe(false);
  expect(element('site-alert').hidden).toBe(true);
});

test('saving shows confirmed bookmark progress even without a website tab and keeps completion distinct from the plan count', async () => {
  const f = await mount(undefined, true);
  f.state.documents = 0;
  f.state.archive.import = { id: 'save', phase: 'approved', reason: null, edgeCount: 10, pages: 3, omissions: 0, coverage: 'complete', nextEdge: 10, nextPlan: 4,
    progress: { collectionsRead: 1, collectionsTotal: 1, currentCollection: null, prepared: 10, saved: 4, toSave: 8 },
    preview: { id: 'preview', revision: 1, digest: 'digest', coverage: 'complete', counts: { createFolders: 1, createBookmarks: 8, reuseBookmarks: 2, review: 0 } } };
  element('refresh').click();
  await vi.waitFor(() => expect(element('import-count').textContent).toBe('4 / 8'));
  expect(element('import-open-source').hidden).toBe(true);
  expect(element('import-note').hidden).toBe(true);
  expect(element('import-progress-bar').getAttribute('aria-valuenow')).toBe('50');
  f.state.archive.import.phase = 'attention'; f.state.archive.import.reason = 'sourceReviewRequired';
  f.state.archive.import.preview!.counts.review = 4;
  f.state.archive.import.preview!.reviewSamples = [{ itemId: 'video:av:1', collectionId: '83459231', itemTitle: 'A reviewed item', collectionTitle: 'Favorites', reason: 'primarySourceCollectionRequired' }];
  element('refresh').click();
  await vi.waitFor(() => expect(element('import-summary').textContent).toContain('4 bookmarks added; 4 items'));
  expect(element('import-summary').textContent).not.toContain('8 bookmarks added');
  expect(element('import-review-items').hidden).toBe(false);
  element('import-review-items').click();
  expect(element<HTMLDetailsElement>('reconcile-details').open).toBe(true);
  expect(element('import-review-list').textContent).toContain('A reviewed item');
  expect(element('import-review-list').textContent).toContain('Choose its primary collection');
  expect(element('import-review-list').textContent).not.toContain('primarySourceCollectionRequired');
  f.state.archive.import.preview!.reviewSamples = [{ itemId: 'video:av:1', collectionId: '83459231', itemTitle: 'A reviewed item', reason: 'nativeOutcomeUnresolved' }];
  element('refresh').click();
  await vi.waitFor(() => expect(element('import-review-check').hidden).toBe(false));
  element('import-review-check').click();
  await vi.waitFor(() => expect(f.sendMessage).toHaveBeenCalledWith({ kind: 'known.siteAdapters.import.freeze', jobId: 'save', adapterId: 'bundled.bilibili' }));
  expect(element('source-overview').hidden).toBe(false);
  f.state.archive.import.phase = 'completed'; f.state.archive.import.reason = null;
  f.state.archive.import.progress!.saved = 8; f.state.archive.import.nextPlan = 8;
  f.state.archive.import.preview!.counts.review = 0;
  element('refresh').click();
  await vi.waitFor(() => expect(element('import-state').textContent).toBe('This check is complete'));
  expect(element('import-summary').textContent).toContain('8 bookmarks added');
  expect(element('import-note').hidden).toBe(true);
  expect(element('import-review').hidden).toBe(true);
  expect(document.querySelectorAll('#step-import .btn-primary:not([hidden])')).toHaveLength(0);
});

test('editing a destination keeps the running task pointed at the saved folder until changes are saved', async () => {
  const f = await mount(undefined, true);
  element('site-configure').click();
  expect(element<HTMLDialogElement>('site-settings-dialog').open).toBe(true);
  pick('local');
  expect(element('archive-summary').textContent).toContain('changes to save');
  expect(element('import-destination').textContent).toBe('1 collection → Synced source');
  expect(f.sendMessage.mock.calls.some(([r]) => r.kind === 'known.siteAdapters.archive.configure')).toBe(false);
});

test('a failed status read hides stale actions and recovers through the visible retry control', async () => {
  const f = await mount(undefined, true);
  f.sendMessage.mockResolvedValueOnce({ error: 'unavailable' } as unknown as typeof f.state);
  element('refresh').click();
  await vi.waitFor(() => expect(element('site-problem').hidden).toBe(false));
  expect(element('site-problem-what').textContent).toContain('could not finish');
  expect(element('source-overview').hidden).toBe(true);
  expect(element('step-import').hidden).toBe(true);
  expect(element('retry-site-status').hidden).toBe(false);
  element('retry-site-status').click();
  await vi.waitFor(() => expect(element('site-problem').hidden).toBe(true));
  expect(element('source-overview').hidden).toBe(false);
  expect(element('step-import').hidden).toBe(false);
});

test('an enabled mapping cannot claim to be running or offer an import while its website adapter is off', async () => {
  const f = await mount(undefined, true);
  f.state.enabled = false;
  element('refresh').click();
  await vi.waitFor(() => expect(element('import-state').textContent).toBe('Website saving is off'));
  expect(element('start-import').hidden).toBe(true);
  expect(element('import-open-source').hidden).toBe(true);
  expect(element('import-edit-settings').hidden).toBe(false);
  expect(element('site-live-status').textContent).toContain('waits until');
  expect(element<HTMLDialogElement>('site-settings-dialog').open).toBe(false);
  element('import-edit-settings').click();
  expect(element<HTMLDialogElement>('site-settings-dialog').open).toBe(true);
});
