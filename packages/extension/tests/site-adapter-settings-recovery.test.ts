// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';

vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ exclusionIds: async () => new Set() }));
vi.mock('../src/site-adapters/settings-recovery.js', () => ({}));
vi.mock('../src/site-adapters/community-settings.js', () => ({}));
const element = (id: string) => document.getElementById(id)!;
const adapterId = 'community.shelf';
async function mount(read?: (state: unknown) => Promise<unknown>) {
  vi.resetModules();
  window.location.href = `https://extension.test/site-adapters.html?adapterId=${adapterId}#sync`;
  document.body.innerHTML = readFileSync('site-adapters.html', 'utf8').match(/<body[^>]*>([\s\S]*)<\/body>/u)![1]!
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, '');
  const area = new MemoryStorageArea();
  const state = { enabled: false, connected: false, documents: 0, candidateAccount: null as string | null,
    candidateLabel: '', grants: { site: true, bookmarks: true, userScripts: true },
    archive: { config: null, import: null, catalog: [{ id: 'saved', title: 'Saved' }] } };
  const sendMessage = vi.fn(async (m: { kind: string; adapterId?: string; enabled?: boolean }) => {
    if (m.adapterId !== adapterId) return { enabled: true }; // An independently enabled Bilibili.
    if (m.kind === 'known.siteAdapters.status') return read ? read(state) : structuredClone(state);
    if (m.kind === 'known.siteAdapters.enable') state.enabled = !!m.enabled;
    return structuredClone(state);
  });
  const requestPermission = vi.fn(async () => true);
  vi.stubGlobal('Option', function (text: string, value: string) {
    const option = document.createElement('option'); option.textContent = text; option.value = value; return option;
  });
  vi.stubGlobal('chrome', { runtime: { sendMessage, getURL: (path: string) => `https://extension.test/${path}` },
    storage: { local: area, onChanged: { addListener() {}, removeListener() {} } },
    tabs: { create: vi.fn(), query: async () => [] }, permissions: { contains: async () => true, request: requestPermission },
    bookmarks: { getTree: async () => [{ id: '0', title: '', children: [] }] } });
  const { inspectCommunityPackage } = await import('../src/site-adapters/community-package.js');
  const fixture = 'tests/fixtures/site-adapters/shelf-package/';
  const approved = inspectCommunityPackage(JSON.stringify({ manifest: JSON.parse(readFileSync(fixture + 'manifest.json', 'utf8')),
    provenance: JSON.parse(readFileSync(fixture + 'provenance.json', 'utf8')), script: readFileSync(fixture + 'adapter.js', 'utf8') }));
  await area.set({ 'known.siteAdapters.community.v1': { version: 2,
    installations: [{ id: 'shelf-installation', generation: 1, credential: 'test', hostVersion: '0.1.0.6', approved, previous: [], error: null }] } });
  await import('../src/site-adapters/settings.js');
  await vi.advanceTimersByTimeAsync(0);
  const statusReads = () => sendMessage.mock.calls.filter(([m]) => m.adapterId === adapterId && m.kind === 'known.siteAdapters.status');
  return { state, sendMessage, requestPermission, statusReads };
}
afterEach(() => {
  window.dispatchEvent(new Event('pagehide')); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren();
});

test('a delayed first status names the installed site and offers no actions until its state is known', async () => {
  vi.useFakeTimers(); let finish!: (reply: unknown) => void;
  const f = await mount(() => new Promise(resolve => { finish = resolve; }));
  expect(element('site-title').textContent).toBe('Shelf');
  expect(element('connection-title').textContent).toBe('Checking the Shelf connection…');
  expect(element('site-alert-text').textContent).toBe('Checking the Shelf connection…');
  expect(element('view-site').textContent).not.toContain('Bilibili');
  expect(element('enable').hidden).toBe(true);
  element('enable').click(); await vi.advanceTimersByTimeAsync(0);
  expect(f.requestPermission).not.toHaveBeenCalled();
  finish(f.state); await vi.advanceTimersByTimeAsync(0);
  expect(element('connection-title').textContent).toBe('Turn on Shelf');
  element('enable').click(); await vi.advanceTimersByTimeAsync(0);
  expect(f.sendMessage).toHaveBeenCalledWith({ kind: 'known.siteAdapters.enable', enabled: true, adapterId });
  expect(f.sendMessage.mock.calls.some(([m]) => m.kind === 'known.siteAdapters.enable' && m.adapterId === 'bundled.bilibili')).toBe(false);
});

test('failed initial reads show the error and retry with backoff until the site recovers', async () => {
  vi.useFakeTimers(); let failures = 2;
  const f = await mount(async state => failures-- > 0 ? { error: 'unavailable' } : state);
  expect(element('site-alert').hidden).toBe(false);
  expect(element('site-alert-text').textContent).toContain('Couldn’t read');
  expect(element('sync-settings').hidden).toBe(true);
  await vi.advanceTimersByTimeAsync(3000); expect(f.statusReads()).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(5999); expect(f.statusReads()).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1); expect(f.statusReads()).toHaveLength(3);
  expect(element('sync-settings').hidden).toBe(false);
  expect(element('site-alert').hidden).toBe(true);
  expect(element('connection-title').textContent).toBe('Turn on Shelf');
  await vi.advanceTimersByTimeAsync(30000); expect(f.statusReads()).toHaveLength(3);
});

test('a hung status times out, retries and ignores the late reply', async () => {
  vi.useFakeTimers(); let finish!: (reply: unknown) => void, first = true;
  const f = await mount(state => {
    if (first) { first = false; return new Promise(resolve => { finish = resolve; }); }
    return Promise.resolve(state);
  });
  await vi.advanceTimersByTimeAsync(10000);
  expect(element('site-alert-text').textContent).toContain('Couldn’t read');
  await vi.advanceTimersByTimeAsync(3000);
  expect(element('connection-title').textContent).toBe('Turn on Shelf');
  finish({ ...f.state, enabled: true }); await vi.advanceTimersByTimeAsync(0);
  expect(element('connection-title').textContent).toBe('Turn on Shelf');
});

test('returning to a hidden page retries immediately and pagehide removes polling and visibility listeners', async () => {
  vi.useFakeTimers(); let failed = true;
  const f = await mount(async state => failed ? { error: 'unavailable' } : state);
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(60000); expect(f.statusReads()).toHaveLength(1);
  failed = false; visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(0); expect(f.statusReads()).toHaveLength(2);
  window.dispatchEvent(new Event('pagehide')); document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(60000); expect(f.statusReads()).toHaveLength(2);
});

test('a detected account stays visibly awaiting confirmation and specific permission errors remain actionable', async () => {
  vi.useFakeTimers(); let error: string | undefined;
  const f = await mount(async () => error ? { error } : { enabled: true, connected: false, documents: 0, candidateAccount: '42',
    candidateLabel: 'Alice', grants: { site: true, bookmarks: true, userScripts: true } });
  expect(element('connection-title').textContent).toBe('Signed in to Shelf as Alice');
  expect(element('confirm').hidden).toBe(false);
  expect(element('step-choose').dataset.step).toBe('later');
  error = 'communityToggleRequired'; element('refresh').click(); await vi.advanceTimersByTimeAsync(0);
  expect(element('site-alert-text').textContent).toContain('Allow User Scripts');
  expect(element('confirm').hidden).toBe(true);
  element('confirm').click(); await vi.advanceTimersByTimeAsync(0);
  expect(f.sendMessage.mock.calls.some(([m]) => m.kind === 'known.siteAdapters.confirm')).toBe(false);
});
