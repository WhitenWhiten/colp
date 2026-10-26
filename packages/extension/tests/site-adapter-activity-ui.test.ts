// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { createSiteActivity } from '../src/site-adapters/activity.js';
import { createSiteActivityView } from '../src/site-adapters/settings-activity.js';
import { createSiteConfiguration } from '../src/site-adapters/settings-configuration.js';
import { paintSourceOverview } from '../src/site-adapters/settings-overview.js';
import { paintSiteImport } from '../src/site-adapters/settings-import.js';
import { siteFeatures } from '../src/site-adapters/capabilities.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { postsDefinition, saved } from './fixtures/site-adapters/posts.js';

const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
function mount(storage = new MemoryStorageArea()) {
  window.location.href = 'https://extension.test/site-adapters.html';
  document.body.innerHTML = readFileSync('site-adapters.html', 'utf8').match(/<body[^>]*>([\s\S]*)<\/body>/u)![1]!.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, '');
  vi.stubGlobal('chrome', { storage: { local: storage }, runtime: { getURL: (path: string) => `https://extension.test/${path}` } });
  const clipboard = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } });
  return { storage, clipboard };
}
afterEach(() => { window.dispatchEvent(new Event('pagehide')); document.body.replaceChildren(); vi.unstubAllGlobals(); });

test('copying an error uses its persisted incident, and recovery keeps the original snapshot available in history', async () => {
  const f = mount(), journal = createSiteActivity(f.storage, postsDefinition, { extensionVersion: 'test' });
  const failed = await journal.record({ kind: 'problem', operation: 'save', taskId: 'task', code: 'nativeOutcomeUnknown', counts: { read: 8, saved: 2, skipped: 1 } });
  const send = vi.fn(async (request: Record<string, unknown>) => request.kind === 'known.siteAdapters.activity.list'
    ? { events: await journal.list() } : { report: await journal.report(request.id as string | undefined) });
  const view = createSiteActivityView(send, postsDefinition); view.paint(failed);
  await journal.record({ kind: 'problem', operation: 'save', taskId: 'task', code: 'nativeOutcomeUnknown', counts: { read: 8, saved: 5, skipped: 1 } });
  element('problem-copy').click();
  await vi.waitFor(() => expect(f.clipboard).toHaveBeenCalledOnce());
  const report = JSON.parse(f.clipboard.mock.calls[0]![0]);
  expect(report.incident).toMatchObject({ id: failed.id, counts: { saved: 2 }, latestCounts: { saved: 5 } });
  expect(report).not.toHaveProperty('accountId');
  await journal.resolve('task', 'save'); view.paint(null);
  expect(element('site-problem').hidden).toBe(true);
  const history = element<HTMLDetailsElement>('site-history'); history.open = true; history.dispatchEvent(new Event('toggle'));
  await vi.waitFor(() => expect(element('site-activity-list').textContent).toContain('Recovered'));
  expect(element('site-activity-list').textContent).toContain('nativeOutcomeUnknown');
});

test('configuration failures stay in the open dialog, offer manual copying, and remain closed records after cancelling changes', async () => {
  const f = mount(), journal = createSiteActivity(f.storage, postsDefinition, { extensionVersion: 'test' });
  const failed = await journal.record({ kind: 'problem', operation: 'configure', taskId: 'management:configure', code: 'bindingUnavailable' });
  const send = vi.fn(async (request: Record<string, unknown>) => {
    if (String(request.kind).endsWith('.dismiss')) { await journal.dismiss(request.id as string); return { dismissed: true }; }
    return String(request.kind).endsWith('.list') ? { events: await journal.list() } : { report: await journal.report(request.id as string | undefined) };
  });
  const view = createSiteActivityView(send, postsDefinition), settings = createSiteConfiguration(() => view.discardConfiguration());
  settings.paint(true); settings.open('connection'); view.paint(failed);
  expect(element('site-problem').closest('dialog')?.open).toBe(true);
  f.clipboard.mockRejectedValueOnce(new Error('clipboard unavailable'));
  element('problem-copy').click();
  await vi.waitFor(() => expect(element('site-copy-fallback').hidden).toBe(false));
  expect(element('site-copy-fallback').closest('dialog')?.open).toBe(true);
  expect(JSON.parse(element<HTMLTextAreaElement>('site-copy-fallback').value).incident.id).toBe(failed.id);
  element<HTMLDialogElement>('site-settings-dialog').close();
  await vi.waitFor(async () => expect((await journal.report(failed.id)).incident?.resolution).toBe('dismissed'));
  expect(element('site-problem').hidden).toBe(true);
});

test('the same components support page-based single lists and observation-only sources without inventing account or import capabilities', () => {
  mount();
  const definition = { ...postsDefinition, connectionKind: 'page' as const, negativeReadback: false, defaultCollection: saved, capabilities: ['enumerateItems'] as const };
  const config = { state: 'active', live: true, root: { nativeId: 'root' }, collectionIds: [saved.id] };
  const status = { enabled: true, connected: true, documents: 1, archive: { config, catalog: [saved], overview: { checkedAt: 1, saved: 0,
    collections: [{ id: saved.id, title: saved.title, destinationId: null, destinationTitle: saved.title, folder: 'pending' as const, saved: 0, changed: 0, keptDeleted: 0 }] } } };
  paintSourceOverview(status, definition, new Map([['root', 'Saved posts']]), () => {});
  paintSiteImport({ job: null, site: definition.label, documents: 1, enabled: true, connected: true, bookmarkAccess: true, hold: null,
    config, available: siteFeatures(definition).import, hasDifferences: false, lastEvent: null, errorCopy: () => 'problem' });
  expect(element('overview-source').textContent).toBe('Source: Posts');
  expect(element('overview-policy').textContent).toContain('One source list');
  expect(element('start-import').hidden).toBe(false);
  const observer = { ...postsDefinition, connectionKind: 'page' as const, negativeReadback: false, capabilities: ['observeFavorites'] as const };
  paintSourceOverview(status, observer, new Map([['root', 'Saved posts']]), () => {});
  paintSiteImport({ job: null, site: observer.label, documents: 1, enabled: true, connected: true, bookmarkAccess: true, hold: null,
    config, available: siteFeatures(observer).import, hasDifferences: false, lastEvent: null, errorCopy: () => 'problem' });
  expect(element('import-summary').textContent).toContain('reading all existing items is unavailable');
  for (const id of ['start-import', 'resume-import', 'freeze-import', 'approve-import']) expect(element(id).hidden).toBe(true);
  expect(element('overview-mappings').textContent).toContain('Saved posts / Saved');
  expect(element('source-overview').textContent).not.toContain('Bilibili');
  paintSourceOverview({ enabled: true, connected: true }, { ...postsDefinition, capabilities: ['resolveItem'] }, new Map(), () => {});
  expect(element('source-identification').hidden).toBe(false); expect(element('source-overview').hidden).toBe(true);
});
