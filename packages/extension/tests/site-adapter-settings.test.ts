// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ exclusionIds: async () => new Set() }));
vi.mock('../src/site-adapters/settings-recovery.js', () => ({}));
vi.mock('../src/site-adapters/community-settings.js', () => ({}));

const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const details = () => JSON.parse(element('status').textContent!);
const selected = () => document.querySelector<HTMLInputElement>('#archive-collections input')!;
async function mount(error?: string) {
  vi.resetModules();
  window.location.href = 'https://extension.test/site-adapters.html#sync';
  document.body.innerHTML = readFileSync('site-adapters.html', 'utf8').match(/<body[^>]*>([\s\S]*)<\/body>/u)![1]!
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, '');
  const state = { enabled: true, connected: true, documents: 1, grants: { site: true, bookmarks: true },
    catalog: { items: [{ id: '83459231', title: 'Favorites' }], current: true, nextCursor: null, reading: false, failed: null },
    archive: { config: null as { state: string; root: { nativeId: string }; collectionIds: string[]; live: boolean } | null, import: null } };
  const sendMessage = vi.fn(async (message: { kind: string; rootNativeId?: string; collectionIds?: string[] }) => {
    if (message.kind === 'known.siteAdapters.archive.configure') {
      if (message.rootNativeId === 'synced' && error) return { error };
      state.archive.config = { state: 'active', root: { nativeId: message.rootNativeId! }, collectionIds: message.collectionIds!, live: true };
    }
    if (message.kind === 'known.siteAdapters.cloud.configureRule') return { configured: true };
    return structuredClone(state);
  });
  const create = vi.fn();
  vi.stubGlobal('Option', function (text: string, value: string) {
    const option = document.createElement('option'); option.textContent = text; option.value = value; return option;
  });
  vi.stubGlobal('chrome', { runtime: { sendMessage }, permissions: { contains: async () => true }, bookmarks: { create,
    getTree: async () => [{ id: '0', title: '', children: [{ id: '2', title: 'Other bookmarks', children: [
      { id: 'synced', title: 'Synced source' }, { id: 'local', title: 'Local source' },
    ] }] }],
  } });
  await import('../src/site-adapters/settings.js');
  await vi.waitFor(() => expect(document.querySelector('#archive-root')).not.toBeNull());
  await vi.waitFor(() => expect(selected()).not.toBeNull());
  selected().checked = true; selected().dispatchEvent(new Event('change'));
  pick('synced');
  return { sendMessage, create };
}
function pick(id: string) {
  element('archive-root').click();
  document.querySelector<HTMLElement>(`#archive-root-picker [data-folder-id="${id}"]`)!.click();
}
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

test('a refused action survives status refresh with the chosen scope intact', async () => {
  const f = await mount('permissionRequired');
  element('configure-archive').click();
  await vi.waitFor(() => expect(details().lastActionError).toMatchObject({
    operation: 'known.siteAdapters.archive.configure', error: 'permissionRequired', at: expect.any(Number),
  }));
  expect(document.querySelector('.toast-message')?.textContent).toContain('needs access');
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
